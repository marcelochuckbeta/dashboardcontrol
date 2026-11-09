// Histórico: projetos concluídos, cada um com todas as entregas e anotações.
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE = 10;
  const DONE = 'Concluído';
  const state = {termo: '', desde: '', items: [], total: 0, details: new Map(), loading: false, seq: 0, open: new Set()};

  // Avisos
  let toastTimer = null;
  let toastUndo = null;
  const toast = (text, undo, bad) => {
    $('toast-text').textContent = text;
    toastUndo = undo || null;
    $('toast-action').hidden = !undo;
    $('toast').classList.toggle('bad', !!bad);
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; toastUndo = null; }, undo ? 7000 : 4000);
  };
  $('toast-action').addEventListener('click', () => {
    const run = toastUndo;
    $('toast').hidden = true;
    toastUndo = null;
    if (run) run();
  });

  // Datas
  const fmtDay = (d) => d.toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit', year: 'numeric'});
  const fmtIso = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Busca sem diferenciar maiúsculas e acentos; destaca as palavras encontradas.
  const fold = (ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = () => state.termo.split(/\s+/).map((w) => [...w].map(fold).join('')).filter(Boolean);
  const highlight = (el, text) => {
    el.textContent = '';
    const list = words();
    const chars = [...(text || '')];
    const folded = chars.map((c) => {
      const f = fold(c);
      return f.length === 1 ? f : '\0';
    }).join('');
    const marks = new Array(chars.length).fill(false);
    list.forEach((w) => {
      let i = folded.indexOf(w);
      while (i !== -1) {
        for (let k = i; k < i + [...w].length; k += 1) marks[k] = true;
        i = folded.indexOf(w, i + 1);
      }
    });
    let buf = '';
    let on = false;
    const out = () => {
      if (!buf) return;
      if (on) { const m = document.createElement('mark'); m.textContent = buf; el.append(m); } else el.append(buf);
      buf = '';
    };
    chars.forEach((c, i) => {
      if (marks[i] !== on) { out(); on = marks[i]; }
      buf += c;
    });
    out();
    return el;
  };
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) highlight(el, text);
    return el;
  };

  let client = null;
  const sinceIso = () => (state.desde ? new Date(Date.now() - Number(state.desde) * 864e5).toISOString() : null);

  const notReady = (error) => error && (error.code === 'PGRST202' || error.code === '42883' || error.code === '42703');
  const showEmpty = (text) => {
    $('empty').textContent = text;
    $('empty').hidden = !text;
  };

  // Carrega a lista. `reset` começa do zero; senão, acrescenta a próxima página.
  const load = async (reset, keep) => {
    const seq = ++state.seq;
    state.loading = true;
    $('more').disabled = true;
    if (reset) $('count').textContent = 'Buscando';
    const skip = reset ? 0 : state.items.length;
    const size = keep ? Math.min(50, Math.max(PAGE, state.items.length)) : PAGE;
    const {data, error} = await client.rpc('buscar_historico', {termo: state.termo, desde: sinceIso(), limite: size, pular: skip});
    if (seq !== state.seq) return;
    state.loading = false;
    $('more').disabled = false;
    if (error) {
      $('count').textContent = '';
      if (reset) { state.items = []; $('list').textContent = ''; $('more').hidden = true; }
      showEmpty(notReady(error)
        ? 'O histórico ainda não foi ativado. Rode o arquivo supabase/3-historico.sql no SQL Editor do Supabase.'
        : 'Não foi possível carregar o histórico. Verifique a conexão e tente de novo.');
      return;
    }
    const names = data.map((r) => r.projeto);
    const details = await loadDetails(names);
    if (seq !== state.seq) return;
    if (!details) {
      showEmpty('Não foi possível carregar os detalhes dos projetos. Verifique a conexão e tente de novo.');
      return;
    }
    details.forEach((v, k) => state.details.set(k, v));
    state.items = reset ? data : state.items.concat(data);
    state.total = data.length ? Number(data[0].total) : (reset ? 0 : state.total);
    render();
  };

  const loadDetails = async (names) => {
    const map = new Map(names.map((n) => [n, {entregas: [], notas: []}]));
    if (!names.length) return map;
    const [e, o] = await Promise.all([
      client.from('entregas').select('*').in('projeto', names).not('arquivado_em', 'is', null),
      client.from('observacoes').select('*').in('projeto', names).not('arquivado_em', 'is', null),
    ]);
    if (e.error || o.error) return null;
    e.data.forEach((r) => map.get(r.projeto) && map.get(r.projeto).entregas.push(r));
    o.data.forEach((r) => map.get(r.projeto) && map.get(r.projeto).notas.push(r));
    map.forEach((v) => {
      v.entregas.sort((a, b) => String(a.prazo).localeCompare(String(b.prazo)) || String(a.entrega).localeCompare(String(b.entrega)));
      v.notas.sort((a, b) => Number(a.criada_em) - Number(b.criada_em));
    });
    return map;
  };

  const render = () => {
    const searching = !!words().length || !!state.desde;
    $('count').textContent = searching
      ? (state.total ? `${plural(state.total, 'projeto encontrado', 'projetos encontrados')}` : '')
      : (state.total ? `${plural(state.total, 'projeto concluído', 'projetos concluídos')}` : '');
    if (!state.items.length) {
      showEmpty(searching
        ? 'Nenhum projeto encontrado. Tente outra palavra ou outro período.'
        : 'Nenhum projeto concluído ainda. Quando todas as entregas de um projeto ficarem "Concluído", ele aparece aqui.');
    } else showEmpty('');
    $('more').hidden = state.items.length >= state.total;
    const list = $('list');
    list.textContent = '';
    state.items.forEach((item) => list.append(card(item)));
  };

  const card = (item) => {
    const info = state.details.get(item.projeto) || {entregas: [], notas: []};
    const box = document.createElement('details');
    box.className = 'card hist';
    box.open = state.open.has(item.projeto) || !!words().length;
    box.addEventListener('toggle', () => { if (box.open) state.open.add(item.projeto); else state.open.delete(item.projeto); });

    const sum = document.createElement('summary');
    sum.append(make('span', 'hist-name', item.projeto || 'Sem nome'));
    const meta = make('span', 'hist-meta');
    meta.textContent = `Concluído em ${fmtDay(new Date(item.concluido_em))} · ${plural(Number(item.entregas), 'entrega', 'entregas')} · ${plural(Number(item.anotacoes), 'anotação', 'anotações')}`;
    sum.append(meta);
    box.append(sum);

    const body = make('div', 'hist-body');
    const left = make('section', 'hist-section');
    const h1 = make('h3', 'card-title');
    h1.textContent = 'Entregas';
    left.append(h1);
    const wrap = make('div', 'hist-table');
    const table = document.createElement('table');
    const head = document.createElement('tr');
    ['Campanha', 'Fase', 'Entrega', 'Prazo', 'Status'].forEach((t) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = t; head.append(th); });
    const thead = document.createElement('thead');
    thead.append(head);
    const tbody = document.createElement('tbody');
    info.entregas.forEach((r) => {
      const tr = document.createElement('tr');
      tr.append(make('td', '', r.campanha || '—'), make('td', '', r.fase || '—'), make('td', '', r.entrega || '—'));
      const prazo = make('td', 'num');
      prazo.textContent = fmtIso(r.prazo);
      const st = make('td', 'hist-status');
      st.textContent = r.status || DONE;
      tr.append(prazo, st);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    left.append(wrap);

    const right = make('section', 'hist-section');
    const h2 = make('h3', 'card-title');
    h2.textContent = 'Anotações';
    right.append(h2);
    if (info.notas.length) {
      const ul = make('ul', 'hist-notes');
      info.notas.forEach((n) => {
        const li = make('li', n.feito ? 'done' : '');
        const mark = make('span', 'hist-check');
        mark.setAttribute('aria-label', n.feito ? 'Feita' : 'Não feita');
        mark.textContent = n.feito ? '✓' : '';
        const txt = make('p', 'hist-text', n.texto || '');
        const when = make('time', 'hist-when');
        const d = new Date(Number(n.criada_em));
        when.textContent = Number.isFinite(d.getTime()) ? fmtDay(d) : '';
        li.append(mark, txt, when);
        ul.append(li);
      });
      right.append(ul);
    } else {
      right.append(make('p', 'hist-none', 'Sem anotações.'));
    }

    body.append(left, right);
    const actions = make('div', 'hist-actions');
    const reopen = make('button', 'btn');
    reopen.type = 'button';
    reopen.textContent = 'Reabrir projeto';
    reopen.addEventListener('click', () => {
      if (reopen.dataset.confirm !== '1') {
        reopen.dataset.confirm = '1';
        reopen.textContent = 'Confirmar: voltar ao painel';
        setTimeout(() => { if (reopen.isConnected) { reopen.dataset.confirm = ''; reopen.textContent = 'Reabrir projeto'; } }, 5000);
        return;
      }
      reopenProject(item.projeto, info.entregas, reopen);
    });
    actions.append(reopen);
    body.append(actions);
    box.append(body);
    return box;
  };

  // Reabrir: a entrega com o prazo mais distante volta para "Em andamento", e o projeto volta ao painel.
  const setStatus = (id, status) => client.from('entregas').update({status}).eq('id', id);
  const reopenProject = async (name, entregas, button) => {
    const last = entregas.slice().sort((a, b) => String(b.prazo).localeCompare(String(a.prazo)))[0];
    if (!last) return;
    button.disabled = true;
    const {error} = await setStatus(last.id, 'Em andamento');
    if (error) {
      button.disabled = false;
      toast(error.code === '42501' ? 'Você tem acesso somente para ver o histórico.' : 'Não foi possível reabrir. Verifique a conexão e tente de novo.', null, true);
      return;
    }
    toast(`${name} voltou para o painel.`, async () => {
      const again = await setStatus(last.id, last.status || DONE);
      if (again.error) toast('Não foi possível desfazer. Verifique a conexão.', null, true);
      else load(true, true);
    });
    load(true, true);
  };

  // Filtros
  let typing = null;
  $('q').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.termo = $('q').value.trim(); load(true); }, 250);
  });
  $('filters').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(typing);
    state.termo = $('q').value.trim();
    load(true);
  });
  $('period').addEventListener('change', () => { state.desde = $('period').value; load(true); });
  $('more').addEventListener('click', () => { if (!state.loading) load(false); });

  // Início, depois do login. Mudanças de outros aparelhos atualizam a lista.
  if (!window.appSession) return;
  window.appSession.then(() => {
    client = window.appSupabase;
    load(true);
    let timer = null;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => load(true, true), 400); };
    ['entregas', 'observacoes'].forEach((table) => {
      client.channel(`historico-${table}`)
        .on('postgres_changes', {event: '*', schema: 'public', table}, refresh)
        .subscribe();
    });
  });
})();
