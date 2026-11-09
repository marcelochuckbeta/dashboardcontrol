// Conecta o painel ao Supabase: login, leitura, gravação e atualização ao vivo.
// O painel fala com as funções `claude.use('db')` e `claude.use('user')`; este arquivo as implementa.
(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const configured = /^https:\/\//.test(cfg.SUPABASE_URL || '') && !/SEU[-_]PROJETO/.test(cfg.SUPABASE_URL)
    && (cfg.SUPABASE_ANON_KEY || '').length > 20;

  const showAuth = (title, showFields) => {
    $('auth').hidden = false;
    $('auth-title').textContent = title;
    $('auth-fields').hidden = !showFields;
  };

  if (!configured || !window.supabase) {
    showAuth(configured
      ? 'Não foi possível carregar o app. Verifique a conexão e abra de novo.'
      : 'Falta configurar o Supabase no arquivo config.js.', false);
    window.claude = {use: () => new Promise(() => {})};
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // Tabelas: nome no painel -> nome da coluna no banco, quando diferente.
  const TABLES = {
    entregas: {table: 'entregas', fields: {}},
    observacoes: {table: 'observacoes', fields: {criadaEm: 'criada_em'}},
  };
  const toRow = (spec, data) => {
    const row = {};
    Object.entries(data).forEach(([k, v]) => { row[spec.fields[k] || k] = v; });
    return row;
  };
  const fromRow = (spec, row) => {
    const reverse = Object.fromEntries(Object.entries(spec.fields).map(([a, b]) => [b, a]));
    const data = {};
    Object.entries(row).forEach(([k, v]) => {
      if (k !== 'id' && k !== 'atualizado_em' && k !== 'arquivado_em') data[reverse[k] || k] = v;
    });
    return data;
  };
  const snapshotDoc = (id, data) => ({id, exists: !!data, data: () => data || undefined, metadata: {fromCache: false, hasPendingWrites: false}});
  // Recusa de permissão vira o código que o painel trata como "somente leitura".
  const failure = (error) => {
    const denied = error && (error.code === '42501' || error.status === 401 || error.status === 403);
    const wrapped = new Error((error && error.message) || 'Falha ao salvar');
    wrapped.code = denied ? 'invalid_argument' : 'unavailable';
    return wrapped;
  };
  const check = ({error}) => { if (error) throw failure(error); };

  // Cada tabela guarda uma cópia local, recarregada quando o banco avisa de uma mudança.
  const stores = new Map();
  const storeFor = (name) => {
    if (stores.has(name)) return stores.get(name);
    const spec = TABLES[name];
    const store = {rows: new Map(), listeners: new Set(), channel: null, timer: null};
    store.emit = () => {
      const docs = [...store.rows].map(([id, data]) => snapshotDoc(id, data));
      const snap = {docs, size: docs.length, empty: !docs.length, metadata: {fromCache: false, hasPendingWrites: false}, docChanges: () => []};
      store.listeners.forEach((fn) => fn(snap));
    };
    store.reload = async () => {
      // Projetos concluídos ficam no histórico, fora do painel.
      let {data, error} = await client.from(spec.table).select('*').is('arquivado_em', null);
      // Banco ainda sem o 3-historico.sql: mostra tudo, como antes.
      if (error && error.code === '42703') ({data, error} = await client.from(spec.table).select('*'));
      if (error) throw failure(error);
      store.rows = new Map(data.map((row) => [String(row.id), fromRow(spec, row)]));
      store.emit();
    };
    store.scheduleReload = () => {
      clearTimeout(store.timer);
      store.timer = setTimeout(() => store.reload().catch(() => {}), 150);
    };
    store.start = () => {
      if (store.channel) return;
      store.channel = client.channel(`tabela-${spec.table}`)
        .on('postgres_changes', {event: '*', schema: 'public', table: spec.table}, store.scheduleReload)
        .subscribe((status) => { if (status === 'SUBSCRIBED') store.scheduleReload(); });
    };
    stores.set(name, store);
    return store;
  };

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  const collection = (name) => {
    const spec = TABLES[name];
    if (!spec) throw new TypeError(`Coleção desconhecida: ${name}`);
    const store = storeFor(name);
    return {
      doc: (givenId) => {
        const id = givenId || newId();
        return {
          id,
          set: async (data) => {
            store.rows.set(id, {...data});
            store.emit();
            try {
              check(await client.from(spec.table).upsert({id, ...toRow(spec, data)}));
            } catch (e) { store.scheduleReload(); throw e; }
          },
          update: async (data) => {
            // Uma linha que está no histórico só volta ao painel quando o banco a devolve.
            const known = store.rows.has(id);
            if (known) {
              store.rows.set(id, {...store.rows.get(id), ...data});
              store.emit();
            }
            try {
              check(await client.from(spec.table).update(toRow(spec, data)).eq('id', id));
              if (!known) store.scheduleReload();
            } catch (e) { store.scheduleReload(); throw e; }
          },
          delete: async () => {
            store.rows.delete(id);
            store.emit();
            try {
              check(await client.from(spec.table).delete().eq('id', id));
            } catch (e) { store.scheduleReload(); throw e; }
          },
        };
      },
      onSnapshot: (next, onError) => {
        store.listeners.add(next);
        store.start();
        store.reload().catch((e) => { if (onError) onError(e); });
        return () => store.listeners.delete(next);
      },
    };
  };

  // Documentos avulsos: configuração geral e layout de cada pessoa.
  const configDoc = () => {
    const listeners = new Set();
    let channel = null;
    const read = async () => {
      const {data, error} = await client.from('configuracao').select('limite').eq('id', 'geral').maybeSingle();
      if (error) throw failure(error);
      return snapshotDoc('geral', data || undefined);
    };
    const push = async () => {
      const snap = await read();
      listeners.forEach((fn) => fn(snap));
    };
    return {
      id: 'geral',
      get: read,
      set: async (data) => check(await client.from('configuracao').upsert({id: 'geral', limite: data.limite})),
      onSnapshot: (next, onError) => {
        listeners.add(next);
        push().catch((e) => { if (onError) onError(e); });
        channel = channel || client.channel('tabela-configuracao')
          .on('postgres_changes', {event: '*', schema: 'public', table: 'configuracao'}, () => push().catch(() => {}))
          .subscribe();
        return () => listeners.delete(next);
      },
    };
  };
  const layoutDoc = (userId) => ({
    id: 'layout',
    get: async () => {
      const {data, error} = await client.from('layouts').select('panels').eq('user_id', userId).maybeSingle();
      if (error) throw failure(error);
      return snapshotDoc('layout', data || undefined);
    },
    set: async (data) => check(await client.from('layouts').upsert({user_id: userId, panels: data.panels})),
  });

  // Login
  let resolveSession;
  const sessionReady = new Promise((resolve) => { resolveSession = resolve; });
  // Usados pela página de histórico.
  window.appSupabase = client;
  window.appSession = sessionReady;
  const enter = (session) => {
    $('auth').hidden = true;
    addSignOut();
    resolveSession(session);
  };
  const addSignOut = () => {
    if ($('sign-out')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sign-out';
    btn.className = 'btn';
    btn.textContent = 'Sair';
    btn.addEventListener('click', async () => {
      await client.auth.signOut();
      window.location.reload();
    });
    document.querySelector('.tools').append(btn);
  };
  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (!email || !password) { $('auth-msg').textContent = 'Preencha o e-mail e a senha.'; return; }
    $('auth-submit').disabled = true;
    $('auth-msg').textContent = '';
    const {data, error} = await client.auth.signInWithPassword({email, password});
    $('auth-submit').disabled = false;
    if (error) {
      $('auth-msg').textContent = error.status === 400 ? 'E-mail ou senha incorretos.' : 'Não foi possível entrar. Verifique a conexão e tente de novo.';
      return;
    }
    enter(data.session);
  });
  client.auth.getSession().then(({data}) => {
    if (data.session) enter(data.session);
    else showAuth('Entre para ver os projetos', true);
  }).catch(() => showAuth('Entre para ver os projetos', true));

  // Interface usada pelo painel
  const makeDb = (userId) => ({
    collection,
    doc: (path) => {
      if (path === 'config/geral') return configDoc();
      if (path === `data/users/${userId}/layout`) return layoutDoc(userId);
      throw new TypeError(`Documento desconhecido: ${path}`);
    },
  });
  window.claude = {
    use: async (name) => {
      const session = await sessionReady;
      const userId = session.user.id;
      if (name === 'db') return makeDb(userId);
      if (name === 'user') return {id: async () => userId, can: async () => true};
      return null;
    },
  };
})();
