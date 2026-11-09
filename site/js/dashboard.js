(() => {
  const DAY = 86400000;
  const DONE = 'Concluído';
  const STATUSES = ['A fazer', 'Em andamento', 'Em revisão', DONE];
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs, parent) => {
    const n = document.createElementNS(SVG, name);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    if (parent) parent.append(n);
    return n;
  };
  const el = (name, cls, text) => {
    const n = document.createElement(name);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const state = {db: null, loaded: false, canWrite: true, rows: [], limite: 3, selected: null, drag: null};
  const floaters = {radar: [], time: [], polygon: null};
  const pending = new Map();
  const timers = new Map();
  const writing = new Set();
  let limitTimer = null;
  let saving = 0;

  // Datas
  const pad = (n) => String(n).padStart(2, '0');
  const todayUtc = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };
  const isoToUtc = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const utcToIso = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const brDate = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');
  const shortDate = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`; };
  const validIso = (iso) => /^20\d{2}-\d{2}-\d{2}$/.test(iso || '');
  const daysLeft = (iso) => (validIso(String(iso).slice(0, 10)) ? Math.round((isoToUtc(iso) - todayUtc()) / DAY) : null);
  const dayWord = (n) => (Math.abs(n) === 1 ? 'dia' : 'dias');

  // Dados vistos na tela: o que veio do banco + alterações ainda não salvas + arraste em andamento.
  const view = () => state.rows.map((row) => {
    const out = {...row, ...(pending.get(row.id) || {})};
    if (state.drag && state.drag.id === row.id) out.prazo = state.drag.prazo;
    out.dias = daysLeft(out.prazo);
    return out;
  }).sort((a, b) => (a.dias ?? 1e9) - (b.dias ?? 1e9) || String(a.projeto).localeCompare(String(b.projeto)));
  const openRows = () => view().filter((r) => r.status !== DONE && r.dias !== null);
  const label = (r) => r.projeto || 'Sem nome';

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

  const setSync = (s, text) => { $('sync').dataset.state = s; $('sync').textContent = text; };
  const liveLabel = () => {
    if (!state.db) return setSync('error', 'Sem acesso aos dados');
    if (!state.canWrite) return setSync('live', 'Ao vivo · somente leitura');
    if (saving > 0 || pending.size > 0) return setSync('saving', 'Salvando');
    return setSync(state.loaded ? 'live' : 'idle', state.loaded ? 'Ao vivo · tudo salvo' : 'Conectando');
  };

  const setReadOnly = () => {
    state.canWrite = false;
    pending.clear();
    render();
  };

  const writeFailed = (e) => {
    if (e && e.code === 'invalid_argument') {
      setReadOnly();
      toast('Você tem acesso somente para ver este painel.', null, true);
      return;
    }
    if (e && e.code === 'quota_exceeded') toast('O painel atingiu o limite de dados. Exclua entregas antigas para continuar.', null, true);
    else toast('Não foi possível salvar. Verifique a conexão e edite o campo de novo.', null, true);
    setSync('error', 'Alteração não salva');
  };

  // Uma gravação por vez em cada entrega, agrupando alterações em sequência.
  const flush = async (id) => {
    if (writing.has(id) || !pending.has(id)) return;
    writing.add(id);
    saving += 1;
    const fields = pending.get(id);
    pending.delete(id);
    // Mantém o valor na tela até o banco devolver a alteração.
    state.rows = state.rows.map((r) => (r.id === id ? {...r, ...fields} : r));
    liveLabel();
    try {
      await state.db.collection('entregas').doc(id).update(fields);
    } catch (e) {
      writeFailed(e);
    }
    writing.delete(id);
    saving -= 1;
    if (pending.has(id)) flush(id);
    else liveLabel();
  };
  const patch = (id, fields, wait) => {
    if (!state.canWrite || !state.db) return;
    pending.set(id, {...(pending.get(id) || {}), ...fields});
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => flush(id), wait));
    render();
  };

  // Desenho
  const render = () => {
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focusKey : null;
    renderHeader();
    renderBars();
    renderChecks();
    renderNotes();
    renderRadar();
    renderTimeline();
    renderTable();
    if (!$('cal').hidden) renderCalendar();
    if (focusKey) {
      const again = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (again && again !== document.activeElement) again.focus({preventScroll: true});
    }
    $('page').classList.toggle('readonly', !state.canWrite);
    ['add', 'lim-down', 'lim-up'].forEach((id) => { $(id).disabled = !state.canWrite || !state.db; });
    $('add').hidden = !state.canWrite || !state.db;
    liveLabel();
  };

  const renderHeader = () => {
    $('today').textContent = brDate(utcToIso(todayUtc()));
    const open = openRows();
    const first = open[0];
    const all = view();
    $('days').textContent = first ? first.dias : '—';
    $('days-unit').textContent = first ? (Math.abs(first.dias) === 1 ? 'dia restante' : 'dias restantes') : '';
    $('next-date').textContent = first ? brDate(first.prazo) : 'Sem prazos em aberto';
    $('open').textContent = open.length;
    $('total').textContent = all.length;
    $('limit-label').textContent = `${state.limite} ${dayWord(state.limite)}`;

    const box = $('donut');
    box.replaceChildren();
    const svg = svgEl('svg', {viewBox: '0 0 72 72', role: 'img', 'aria-label': `${open.length} de ${all.length} entregas em aberto`}, box);
    const r = 29;
    const length = 2 * Math.PI * r;
    svgEl('circle', {cx: 36, cy: 36, r, fill: 'none', stroke: 'var(--line-soft)', 'stroke-width': 8}, svg);
    if (all.length && open.length) {
      svgEl('circle', {cx: 36, cy: 36, r, fill: 'none', stroke: 'var(--cyan)', 'stroke-width': 8, 'stroke-dasharray': `${length * (open.length / all.length)} ${length}`, transform: 'rotate(-90 36 36)', style: 'filter: drop-shadow(0 0 4px var(--cyan))'}, svg);
    }
  };

  const toggleSelect = (id) => { state.selected = state.selected === id ? null : id; render(); };

  const renderBars = () => {
    const open = openRows();
    const scale = Math.max(7, ...open.map((r) => r.dias));
    const ul = $('bars');
    if (!open.length) { ul.replaceChildren(el('li', 'calm', 'Nenhuma entrega em aberto.')); return; }
    ul.replaceChildren(...open.map((row) => {
      const crit = row.dias <= state.limite;
      const li = el('li');
      const btn = el('button', `bar-btn${state.selected === row.id ? ' is-selected' : ''}`);
      btn.type = 'button';
      btn.dataset.focusKey = `bar:${row.id}`;
      btn.setAttribute('aria-pressed', state.selected === row.id);
      btn.addEventListener('click', () => toggleSelect(row.id));
      btn.append(el('span', 'bar-name', label(row)));
      const line = el('span', 'bar-row');
      const track = el('span', 'track');
      track.style.display = 'block';
      const fill = el('span', `fill${crit ? ' crit' : ''}`);
      fill.style.display = 'block';
      fill.style.width = `${Math.max(2, Math.min(100, (row.dias / scale) * 100))}%`;
      track.append(fill);
      line.append(track, el('span', `bar-val${crit ? ' crit' : ''}`, String(row.dias)));
      btn.append(line);
      li.append(btn);
      return li;
    }));
  };

  const renderChecks = () => {
    const rows = view();
    const ul = $('checks');
    if (!rows.length) { ul.replaceChildren(el('li', 'calm', 'As entregas aparecem aqui.')); return; }
    ul.replaceChildren(...rows.map((row) => {
      const li = el('li');
      const lab = el('label', `check${row.status === DONE ? ' done' : ''}`);
      const box = el('input');
      box.type = 'checkbox';
      box.checked = row.status === DONE;
      box.disabled = !state.canWrite;
      box.dataset.focusKey = `check:${row.id}`;
      box.addEventListener('change', () => patch(row.id, {status: box.checked ? DONE : 'A fazer'}, 0));
      const text = el('span');
      text.append(el('span', '', row.entrega || 'Sem título'));
      text.append(el('small', '', `${label(row)}${row.prazo ? ` · ${brDate(row.prazo)}` : ''}`));
      lab.append(box, text);
      li.append(lab);
      return li;
    }));
  };

  // Arraste compartilhado entre radar e linha do tempo
  const startDrag = (event, row, extra, toDays) => {
    event.preventDefault();
    const startX = event.clientX, startY = event.clientY;
    let moved = false;
    if (!state.canWrite) {
      const up = () => { window.removeEventListener('pointerup', up); toggleSelect(row.id); };
      window.addEventListener('pointerup', up);
      return;
    }
    state.drag = {id: row.id, prazo: row.prazo, ...extra};
    const move = (e) => {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;
      if (!moved) return;
      const iso = utcToIso(todayUtc() + toDays(e) * DAY);
      if (iso !== state.drag.prazo) { state.drag.prazo = iso; render(); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const final = state.drag.prazo;
      const changed = moved && final !== row.prazo;
      state.drag = null;
      if (changed) {
        patch(row.id, {prazo: final}, 0);
        toast(`${label(row)}: prazo movido para ${brDate(final)}.`);
      } else if (!moved) {
        toggleSelect(row.id);
      } else {
        render();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const handleKeys = (node, row) => {
    node.addEventListener('keydown', (e) => {
      const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[e.key];
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(row.id); return; }
      if (!step || !state.canWrite) return;
      e.preventDefault();
      patch(row.id, {prazo: utcToIso(isoToUtc(row.prazo) + step * DAY)}, 500);
    });
  };

  const renderRadar = () => {
    const box = $('radar');
    const w = box.clientWidth;
    if (!w) return;
    const rows = openRows();
    const fit = window.matchMedia('(min-width: 900px)').matches;
    const size = fit ? Math.max(120, Math.min(w, box.clientHeight)) : Math.min(w, 640);
    const cx = size / 2, cy = size / 2;
    const R = size / 2 - (fit ? Math.max(34, size * 0.1) : Math.max(46, size * 0.1));
    const domain = state.drag && state.drag.radar ? state.drag.radar : Math.max(7, state.limite + 2, ...rows.map((r) => r.dias));
    const rOf = (d) => (Math.max(0, Math.min(domain, d)) / domain) * R;
    box.replaceChildren();
    box.style.minHeight = fit ? '' : `${size}px`;
    const svg = svgEl('svg', {width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'group', 'aria-label': 'Radar de prazos'}, box);
    const defs = svgEl('defs', {}, svg);
    const disc = svgEl('radialGradient', {id: 'disc'}, defs);
    svgEl('stop', {offset: '0%', 'stop-color': 'var(--cyan)', 'stop-opacity': 0.34}, disc);
    svgEl('stop', {offset: '70%', 'stop-color': 'var(--cyan)', 'stop-opacity': 0.16}, disc);
    svgEl('stop', {offset: '100%', 'stop-color': 'var(--cyan)', 'stop-opacity': 0.05}, disc);
    const hot = svgEl('radialGradient', {id: 'hot'}, defs);
    svgEl('stop', {offset: '0%', 'stop-color': 'var(--red)', 'stop-opacity': 0.08}, hot);
    svgEl('stop', {offset: '100%', 'stop-color': 'var(--red)', 'stop-opacity': 0.4}, hot);
    const glow = svgEl('filter', {id: 'glow', x: '-100%', y: '-100%', width: '300%', height: '300%'}, defs);
    svgEl('feGaussianBlur', {stdDeviation: 5}, glow);

    svgEl('circle', {cx, cy, r: R, fill: 'url(#disc)'}, svg);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const out = R + (i % 2 === 0 ? 18 : 8);
      svgEl('line', {x1: cx, y1: cy, x2: cx + Math.cos(a) * out, y2: cy + Math.sin(a) * out, stroke: 'var(--line)'}, svg);
    }
    const lim = Math.min(state.limite, domain);
    const middle = Math.round((lim + domain) / 2);
    [middle, domain].filter((d, i, list) => d !== lim && list.indexOf(d) === i).forEach((d) => {
      svgEl('circle', {cx, cy, r: rOf(d), fill: 'none', stroke: d === domain ? 'var(--cyan)' : 'var(--line)'}, svg);
    });
    svgEl('circle', {cx, cy, r: R + 14, fill: 'none', stroke: 'var(--line)'}, svg);
    if (lim > 0) svgEl('circle', {cx, cy, r: rOf(lim), fill: 'url(#hot)', stroke: 'var(--red)', 'stroke-width': 1.5, 'stroke-dasharray': '4 4'}, svg);

    const rings = [...new Set([lim, middle, domain])].filter((d) => d > 0);
    rings.forEach((d) => {
      const t = svgEl('text', {x: cx + 6, y: cy + rOf(d) - 5, fill: d === lim ? 'var(--red-soft)' : 'var(--muted)', 'font-size': 11}, svg);
      t.textContent = `${d} ${dayWord(d)}`;
    });

    const n = rows.length;
    const points = rows.map((row, i) => {
      const deg = n === 2 ? (i === 0 ? -135 : -45) : -90 + (i * 360) / Math.max(1, n);
      const a = (deg * Math.PI) / 180;
      const r = rOf(row.dias);
      return {row, a, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, crit: row.dias <= state.limite};
    });
    floaters.polygon = null;
    if (n >= 2) {
      const pts = (n === 2 ? [{x: cx, y: cy}, ...points] : points).map((p) => `${p.x},${p.y}`).join(' ');
      const hotPoly = points.some((p) => p.crit);
      floaters.polygon = {node: null, center: n === 2 ? {x: cx, y: cy} : null};
      floaters.polygon.node = svgEl('polygon', {points: pts, fill: hotPoly ? 'var(--red)' : 'var(--cyan)', 'fill-opacity': 0.26, stroke: hotPoly ? 'var(--red)' : 'var(--cyan)', 'stroke-width': 1.5, 'stroke-linejoin': 'round'}, svg);
    }

    points.forEach((p, i) => { p.g = svgEl('g', {}, svg); p.seed = i * 2.4 + 0.7; });
    floaters.radar = points;

    const tip = el('div', 'tip');
    tip.hidden = true;
    box.append(tip);
    const off = (w - size) / 2;

    if (n <= 8 && size >= 220) {
      points.forEach((p) => {
        // O nome fica junto ao ponto, deslocado para fora do centro.
        const cos = Math.cos(p.a), sin = Math.sin(p.a);
        const name = label(p.row);
        const words = name.split(' ');
        const half = Math.ceil(words.length / 2);
        const lines = words.length > 2 ? [words.slice(0, half).join(' '), words.slice(half).join(' ')] : [name];
        const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
        const tx = p.x + cos * 14;
        const lineGap = 14;
        const baseY = sin > 0.25 ? p.y + sin * 12 + 10 : p.y + sin * 12 - (lines.length - 1) * lineGap + (sin < -0.25 ? -2 : 4);
        const t = svgEl('text', {x: tx, y: baseY, fill: 'var(--project-label)', 'font-size': 12, 'text-anchor': anchor, 'font-weight': state.selected === p.row.id ? 500 : 400, stroke: 'var(--bg)', 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke', 'pointer-events': 'none'}, p.g);
        const spans = lines.map((line, i) => {
          const s = svgEl('tspan', {x: tx, dy: i === 0 ? 0 : lineGap}, t);
          s.textContent = line;
          return s;
        });
        const bbox = t.getBBox();
        const shift = bbox.x < 2 ? 2 - bbox.x : bbox.x + bbox.width > size - 2 ? size - 2 - bbox.x - bbox.width : 0;
        if (shift) spans.forEach((s) => s.setAttribute('x', tx + shift));
      });
    }

    points.forEach((p) => {
      const color = p.crit ? 'var(--red)' : 'var(--green)';
      if (state.selected === p.row.id) svgEl('circle', {cx: p.x, cy: p.y, r: 11, fill: 'none', stroke: 'var(--fg)', 'stroke-width': 1.5}, p.g);
      svgEl('circle', {cx: p.x, cy: p.y, r: 9, fill: color, opacity: 0.7, filter: 'url(#glow)'}, p.g);
      svgEl('circle', {cx: p.x, cy: p.y, r: 5, fill: color, stroke: 'var(--fg)', 'stroke-width': 1}, p.g);
      const hit = svgEl('circle', {cx: p.x, cy: p.y, r: 18, fill: 'transparent', class: 'handle', tabindex: 0, role: 'slider', 'aria-label': `Prazo de ${label(p.row)}`, 'aria-valuenow': p.row.dias, 'aria-valuetext': `${p.row.dias} ${dayWord(p.row.dias)}, ${brDate(p.row.prazo)}`, 'data-focus-key': `radar:${p.row.id}`}, p.g);
      const show = () => {
        tip.replaceChildren(el('div', '', label(p.row)), el('div', 'tip-muted', `${p.row.entrega || 'Sem título'} · ${brDate(p.row.prazo)}`), el('div', '', `${p.row.dias} ${dayWord(p.row.dias)} restantes`));
        tip.hidden = false;
        tip.style.left = `${Math.max(0, Math.min(w - tip.offsetWidth, off + p.x + 14))}px`;
        tip.style.top = `${Math.max(0, p.y - tip.offsetHeight - 14)}px`;
      };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', () => { tip.hidden = true; });
      hit.addEventListener('pointerdown', (e) => {
        const rect = svg.getBoundingClientRect();
        startDrag(e, p.row, {radar: domain}, (m) => {
          const dist = Math.hypot(m.clientX - rect.left - cx, m.clientY - rect.top - cy);
          return Math.round(Math.max(0, Math.min(1, dist / R)) * domain);
        });
      });
      handleKeys(hit, p.row);
      if (state.drag && state.drag.id === p.row.id) show();
    });

    svgEl('circle', {cx, cy, r: 3, fill: 'var(--cyan)'}, svg);
    const center = svgEl('text', {x: cx, y: cy + 18, fill: 'var(--fg)', 'font-size': 11, 'text-anchor': 'middle'}, svg);
    center.textContent = 'Hoje';
  };

  const renderTimeline = () => {
    const box = $('timeline');
    const W = box.clientWidth;
    if (!W) return;
    floaters.time = [];
    const rows = openRows();
    box.replaceChildren();
    if (!rows.length) { box.append(el('p', 'empty', 'Nenhum prazo em aberto para mostrar.')); box.style.minHeight = ''; return; }
    const fit = window.matchMedia('(min-width: 900px)').matches;
    const axisH = fit ? 22 : 28;
    const laneH = fit ? Math.max(32, Math.min(64, (box.clientHeight - axisH - 8) / rows.length)) : 44;
    const H = rows.length * laneH + axisH + 8;
    const range = state.drag && state.drag.time ? state.drag.time : {
      before: Math.min(-1, ...rows.map((r) => r.dias - 1)),
      after: Math.max(14, ...rows.map((r) => r.dias + 2)),
    };
    const {before, after} = range;
    const padX = 22;
    const x = (d) => padX + ((d - before) / (after - before)) * (W - padX * 2);
    const svg = svgEl('svg', {width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Linha do tempo de prazos'}, box);
    const defs = svgEl('defs', {}, svg);
    const glow = svgEl('filter', {id: 'line-glow', x: '-100%', y: '-100%', width: '300%', height: '300%'}, defs);
    svgEl('feGaussianBlur', {stdDeviation: 4}, glow);
    const axisY = H - axisH;
    svgEl('line', {x1: padX, x2: W - padX, y1: axisY, y2: axisY, stroke: 'var(--line)'}, svg);
    const base = todayUtc();
    const step = Math.max(1, Math.ceil((after - before) / Math.max(1, Math.floor(W / 56))));
    for (let d = before; d <= after; d += step) {
      const t = svgEl('text', {x: x(d), y: axisY + 18, fill: 'var(--muted)', 'font-size': 11, 'text-anchor': 'middle'}, svg);
      t.textContent = shortDate(base + d * DAY);
    }
    svgEl('line', {x1: x(0), x2: x(0), y1: 0, y2: axisY, stroke: 'var(--cyan)', 'stroke-dasharray': '3 4', 'stroke-opacity': 0.75}, svg);

    rows.forEach((row, i) => {
      const y = i * laneH + (fit ? 24 : 32);
      const crit = row.dias <= state.limite;
      const color = crit ? 'var(--red)' : 'var(--cyan)';
      const end = Math.max(before, Math.min(after, row.dias));
      svgEl('line', {x1: padX, x2: W - padX, y1: y, y2: y, stroke: 'var(--line)', 'stroke-dasharray': '2 5'}, svg);
      const from = Math.min(0, end), to = Math.max(0, end);
      svgEl('line', {x1: x(from), x2: x(to), y1: y, y2: y, stroke: color, 'stroke-width': 2}, svg);
      for (let d = from; d < to; d++) svgEl('circle', {cx: x(d), cy: y, r: 2.5, fill: color}, svg);
      const g = svgEl('g', {}, svg);
      floaters.time.push({g, row, seed: i * 2.4 + 1.3});
      if (state.selected === row.id) svgEl('circle', {cx: x(end), cy: y, r: 9, fill: 'none', stroke: 'var(--fg)', 'stroke-width': 1.5}, g);
      svgEl('circle', {cx: x(end), cy: y, r: 8, fill: color, opacity: 0.7, filter: 'url(#line-glow)'}, g);
      svgEl('circle', {cx: x(end), cy: y, r: 4, fill: color, stroke: 'var(--fg)', 'stroke-width': 1}, g);
      const name = svgEl('text', {x: padX, y: y - 9, fill: 'var(--project-label)', 'font-size': 12, 'font-weight': state.selected === row.id ? 500 : 400}, g);
      name.textContent = label(row);
      const when = svgEl('text', {x: 0, y: y - 9, fill: crit ? 'var(--red-soft)' : 'var(--muted)', 'font-size': 11}, g);
      when.textContent = `${brDate(row.prazo)} · ${row.dias} ${dayWord(row.dias)}`;
      // Nome e prazo ficam juntos, logo depois do ponto; perto da borda, passam para antes dele.
      const nameW = name.getComputedTextLength();
      const whenW = when.getComputedTextLength();
      const total = nameW + 10 + whenW;
      const beside = x(end) + 12;
      const startX = beside + total <= W - padX ? beside : Math.max(padX, x(end) - 12 - total);
      name.setAttribute('x', startX);
      when.setAttribute('x', startX + nameW + 10);
      const hit = svgEl('circle', {cx: x(end), cy: y, r: 18, fill: 'transparent', class: 'handle handle-h', tabindex: 0, role: 'slider', 'aria-label': `Prazo de ${label(row)}`, 'aria-valuenow': row.dias, 'aria-valuetext': `${row.dias} ${dayWord(row.dias)}, ${brDate(row.prazo)}`, 'data-focus-key': `time:${row.id}`}, g);
      hit.addEventListener('pointerdown', (e) => {
        const rect = svg.getBoundingClientRect();
        startDrag(e, row, {time: range}, (m) => {
          const d = before + ((m.clientX - rect.left - padX) / (W - padX * 2)) * (after - before);
          return Math.round(Math.max(before, Math.min(after, d)));
        });
      });
      handleKeys(hit, row);
    });
    box.style.minHeight = fit ? '' : `${H}px`;
  };

  // Tabela: cada linha é mantida entre desenhos para não perder o foco durante a edição.
  const rowNodes = new Map();
  const textField = (cls, field, placeholder) => {
    const input = el('input', `cell ${cls}`);
    input.type = 'text';
    input.placeholder = placeholder;
    input.maxLength = 120;
    input.dataset.field = field;
    return input;
  };
  const buildRow = (id) => {
    const tr = el('tr');
    const cells = {
      projeto: textField('c-proj', 'projeto', 'Nome do projeto'),
      campanha: textField('c-camp', 'campanha', '—'),
      fase: textField('c-fase', 'fase', '—'),
      entrega: textField('c-ent', 'entrega', 'O que será entregue'),
    };
    const status = el('select', 'cell c-stat');
    status.dataset.field = 'status';
    STATUSES.forEach((s) => status.append(new Option(s, s)));
    const date = el('input', 'cell c-date');
    date.type = 'date';
    date.min = '2000-01-01';
    date.max = '2099-12-31';
    date.dataset.field = 'prazo';
    const days = el('td', 'num');
    const del = el('button', 'icon del');
    del.type = 'button';
    del.setAttribute('aria-label', 'Excluir entrega');
    del.textContent = '×';
    [cells.projeto, cells.campanha, cells.fase, cells.entrega, status, date].forEach((input) => {
      input.setAttribute('aria-label', input.dataset.field);
      input.dataset.focusKey = `${input.dataset.field}:${id}`;
      const td = el('td');
      td.append(input);
      tr.append(td);
    });
    tr.append(days);
    const delTd = el('td');
    delTd.append(del);
    tr.append(delTd);
    Object.values(cells).forEach((input) => {
      input.addEventListener('input', () => patch(id, {[input.dataset.field]: input.value}, 500));
    });
    // Ao renomear um projeto, as tags das observações acompanham o novo nome.
    let projectBefore = '';
    cells.projeto.addEventListener('focus', () => { projectBefore = cells.projeto.value; });
    cells.projeto.addEventListener('change', () => {
      const next = cells.projeto.value;
      const stillUsed = state.rows.some((r) => r.id !== id && r.projeto === projectBefore);
      if (projectBefore && next && next !== projectBefore && !stillUsed) {
        state.notes.filter((n) => n.projeto === projectBefore).forEach((n) => updateNote(n.id, {projeto: next}, 0));
      }
      projectBefore = next;
    });
    status.addEventListener('change', () => patch(id, {status: status.value}, 0));
    date.addEventListener('change', () => { if (validIso(date.value) && date.validity.valid) patch(id, {prazo: date.value}, 0); });
    date.addEventListener('blur', () => render());
    tr.addEventListener('focusin', () => { if (state.selected !== id) { state.selected = id; renderSelection(); } });
    del.addEventListener('click', () => removeRow(id));
    return {tr, inputs: [cells.projeto, cells.campanha, cells.fase, cells.entrega, status, date], days, del, status};
  };
  const renderSelection = () => {
    rowNodes.forEach((node, id) => node.tr.classList.toggle('is-selected', state.selected === id));
    renderBars(); renderRadar(); renderTimeline();
    if (!$('cal').hidden) renderCalendar();
  };
  const renderTable = () => {
    const tbody = $('rows');
    const rows = view();
    const editing = tbody.contains(document.activeElement);
    const seen = new Set();
    rows.forEach((row) => {
      seen.add(row.id);
      let node = rowNodes.get(row.id);
      if (!node) { node = buildRow(row.id); rowNodes.set(row.id, node); tbody.append(node.tr); }
      node.inputs.forEach((input) => {
        const f = input.dataset.field;
        if (input !== document.activeElement) {
          if (f === 'status' && row.status && ![...input.options].some((o) => o.value === row.status)) input.append(new Option(row.status, row.status));
          const value = row[f] === null || row[f] === undefined ? '' : String(row[f]);
          if (input.value !== value) input.value = value;
        }
        input.disabled = !state.canWrite;
      });
      node.del.hidden = !state.canWrite;
      node.days.textContent = row.dias === null ? '—' : String(row.dias);
      node.days.classList.toggle('crit', row.status !== DONE && row.dias !== null && row.dias <= state.limite);
      node.tr.classList.toggle('is-selected', state.selected === row.id);
    });
    rowNodes.forEach((node, id) => {
      if (!seen.has(id)) { node.tr.remove(); rowNodes.delete(id); }
    });
    // Não reordena enquanto alguém digita; a ordem é refeita ao sair do campo.
    if (!editing) rows.forEach((row) => tbody.append(rowNodes.get(row.id).tr));
    const empty = $('empty');
    empty.hidden = rows.length > 0;
    empty.textContent = !state.db ? 'Abra o painel com sua conta para ver as entregas.'
      : !state.loaded ? 'Carregando entregas…'
      : state.canWrite ? 'Nenhuma entrega ainda. Clique em Nova entrega para adicionar a primeira.'
      : 'Nenhuma entrega ainda.';
  };
  $('rows').addEventListener('focusout', () => { setTimeout(() => { if (!$('rows').contains(document.activeElement)) renderTable(); }, 0); });

  // Observações: anotações compartilhadas com caixa para concluir.
  state.notes = [];
  const noteNodes = new Map();
  const noteTimers = new Map();
  const notesRef = () => state.db.collection('observacoes');
  const fitNote = (area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
  const updateNote = (id, fields, wait) => {
    if (!state.canWrite || !state.db) return;
    state.notes = state.notes.map((n) => (n.id === id ? {...n, ...fields} : n));
    const key = Object.keys(fields).join();
    const timerKey = `${id}:${key}`;
    clearTimeout(noteTimers.get(timerKey));
    noteTimers.set(timerKey, setTimeout(async () => {
      saving += 1;
      liveLabel();
      try { await notesRef().doc(id).update(fields); } catch (e) { writeFailed(e); }
      saving -= 1;
      liveLabel();
    }, wait));
    renderNotes();
  };
  const buildNote = (id) => {
    const li = el('li', 'note');
    const box = el('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', 'Concluir anotação');
    box.addEventListener('change', () => updateNote(id, {feito: box.checked}, 0));
    const area = el('textarea', 'note-text');
    area.rows = 1;
    area.maxLength = 500;
    area.setAttribute('aria-label', 'Texto da anotação');
    area.addEventListener('input', () => { fitNote(area); updateNote(id, {texto: area.value}, 500); });
    area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); area.blur(); } });
    area.addEventListener('blur', () => renderNotes());
    const del = el('button', 'icon del note-del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', 'Excluir anotação');
    del.addEventListener('click', () => removeNote(id));
    const tag = el('select', 'note-tag');
    tag.setAttribute('aria-label', 'Projeto da anotação');
    tag.addEventListener('change', () => updateNote(id, {projeto: tag.value}, 0));
    const body = el('div', 'note-body');
    body.append(tag, area);
    li.append(box, body, del);
    return {li, box, area, del, tag};
  };
  // Lista de projetos vinda das entregas, com uma cor fixa para cada nome.
  const TAG_COLORS = 8;
  const projectNames = () => [...new Set(state.rows.map((r) => (pending.get(r.id)?.projeto ?? r.projeto) || '').filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const tagSlots = (names) => {
    const taken = new Set();
    const slots = new Map();
    names.forEach((name) => {
      let h = 0;
      for (const ch of name) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
      let slot = Math.abs(h) % TAG_COLORS;
      for (let i = 0; i < TAG_COLORS && taken.has(slot); i++) slot = (slot + 1) % TAG_COLORS;
      taken.add(slot);
      slots.set(name, slot + 1);
    });
    return slots;
  };
  const fillProjects = (select, names, value) => {
    const wanted = ['', ...names, ...(value && !names.includes(value) ? [value] : [])];
    const current = [...select.options].map((o) => o.value);
    if (select !== document.activeElement && (wanted.length !== current.length || wanted.some((v, i) => v !== current[i]))) {
      select.replaceChildren(...wanted.map((v) => new Option(v || 'Sem projeto', v)));
    }
    if (select !== document.activeElement) select.value = value || '';
  };
  const renderNotes = () => {
    const list = $('notes');
    const notes = [...state.notes].sort((a, b) => Number(!!a.feito) - Number(!!b.feito) || (a.criadaEm || 0) - (b.criadaEm || 0));
    const seen = new Set();
    const editing = list.contains(document.activeElement);
    const names = projectNames();
    const slots = tagSlots([...new Set([...names, ...notes.map((n) => n.projeto).filter(Boolean)])].sort((a, b) => a.localeCompare(b)));
    fillProjects($('note-project'), names, $('note-project').value);
    notes.forEach((note) => {
      seen.add(note.id);
      let node = noteNodes.get(note.id);
      if (!node) { node = buildNote(note.id); noteNodes.set(note.id, node); list.append(node.li); }
      node.box.checked = !!note.feito;
      node.box.disabled = !state.canWrite;
      node.area.disabled = !state.canWrite;
      node.del.hidden = !state.canWrite;
      node.li.classList.toggle('done', !!note.feito);
      fillProjects(node.tag, names, note.projeto || '');
      node.tag.disabled = !state.canWrite;
      node.tag.classList.toggle('no-project', !note.projeto);
      node.tag.style.setProperty('--tag', note.projeto ? `var(--tag-${slots.get(note.projeto)})` : 'transparent');
      node.tag.style.setProperty('--tag-ink', note.projeto ? `var(--tag-${slots.get(note.projeto)}-ink)` : 'var(--muted)');
      if (node.area !== document.activeElement && node.area.value !== (note.texto || '')) node.area.value = note.texto || '';
      fitNote(node.area);
    });
    noteNodes.forEach((node, id) => { if (!seen.has(id)) { node.li.remove(); noteNodes.delete(id); } });
    if (!editing) notes.forEach((note) => list.append(noteNodes.get(note.id).li));
    const done = notes.filter((n) => n.feito).length;
    $('notes-count').textContent = notes.length ? `${done} de ${notes.length} concluídas` : '';
    $('notes-empty').hidden = notes.length > 0;
    $('note-project').disabled = !state.canWrite || !state.db;
    $('note-new').disabled = !state.canWrite || !state.db;
    $('note-add').disabled = !state.canWrite || !state.db;
  };
  const addNote = async () => {
    const input = $('note-new');
    const texto = input.value.trim();
    if (!texto || !state.canWrite || !state.db) return;
    const ref = notesRef().doc();
    const body = {texto, projeto: $('note-project').value, feito: false, criadaEm: Date.now()};
    state.notes = [...state.notes, {id: ref.id, ...body}];
    input.value = '';
    renderNotes();
    input.focus();
    try { await ref.set(body); } catch (e) { writeFailed(e); }
  };
  const removeNote = async (id) => {
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;
    const {id: _id, ...body} = note;
    state.notes = state.notes.filter((n) => n.id !== id);
    renderNotes();
    try {
      await notesRef().doc(id).delete();
      toast('Anotação excluída.', async () => {
        state.notes = [...state.notes, note];
        renderNotes();
        try { await notesRef().doc(id).set(body); } catch (e) { writeFailed(e); }
      });
    } catch (e) { writeFailed(e); }
  };
  $('note-add').addEventListener('click', addNote);
  $('note-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } });

  // Indica quando ainda há entregas abaixo da área visível da tabela.
  const tableWrap = document.querySelector('.table-wrap');
  const updateTableFade = () => {
    const more = tableWrap.scrollHeight - tableWrap.clientHeight - tableWrap.scrollTop > 2;
    tableWrap.closest('.table-card').classList.toggle('more-below', more);
  };
  tableWrap.addEventListener('scroll', updateTableFade, {passive: true});
  new ResizeObserver(updateTableFade).observe(tableWrap);
  new ResizeObserver(updateTableFade).observe($('rows'));

  const removeRow = async (id) => {
    const row = view().find((r) => r.id === id);
    if (!row) return;
    clearTimeout(timers.get(id));
    pending.delete(id);
    const {id: _id, dias: _dias, ...body} = row;
    state.rows = state.rows.filter((r) => r.id !== id);
    if (state.selected === id) state.selected = null;
    render();
    try {
      await state.db.collection('entregas').doc(id).delete();
      toast(`${label(row)} foi excluída.`, async () => {
        state.rows = [...state.rows, {id, ...body}];
        render();
        try { await state.db.collection('entregas').doc(id).set(body); } catch (e) { writeFailed(e); }
      });
    } catch (e) { writeFailed(e); }
  };

  $('add').addEventListener('click', async () => {
    const ref = state.db.collection('entregas').doc();
    const body = {projeto: '', campanha: '', fase: '', entrega: '', status: 'A fazer', prazo: utcToIso(todayUtc() + 7 * DAY)};
    state.rows = [...state.rows, {id: ref.id, ...body}];
    state.selected = ref.id;
    render();
    const node = rowNodes.get(ref.id);
    if (node) node.inputs[0].focus();
    try { await ref.set(body); } catch (e) { writeFailed(e); }
  });

  const setLimit = (value) => {
    if (!state.canWrite || !state.db) return;
    state.limite = Math.max(0, Math.min(30, value));
    render();
    clearTimeout(limitTimer);
    limitTimer = setTimeout(async () => {
      saving += 1;
      liveLabel();
      try { await state.db.doc('config/geral').set({limite: state.limite}); } catch (e) { writeFailed(e); }
      saving -= 1;
      limitTimer = null;
      liveLabel();
    }, 400);
  };
  $('lim-down').addEventListener('click', () => setLimit(state.limite - 1));
  $('lim-up').addEventListener('click', () => setLimit(state.limite + 1));

  // Calendário: abre no mês de hoje; com uma entrega selecionada, um clique move o prazo.
  const calView = {y: 0, m: 0};
  const calToday = () => { const n = new Date(); calView.y = n.getFullYear(); calView.m = n.getMonth(); };
  const renderCalendar = () => {
    const name = new Intl.DateTimeFormat('pt-BR', {month: 'long', year: 'numeric'}).format(new Date(calView.y, calView.m, 1));
    $('cal-month').textContent = name;
    const rows = openRows();
    const chosen = state.canWrite ? view().find((r) => r.id === state.selected) : null;
    $('cal-hint').hidden = !chosen;
    if (chosen) $('cal-hint').textContent = `Clique em um dia para mover o prazo de ${label(chosen)}.`;
    const todayIso = utcToIso(todayUtc());
    const offset = new Date(calView.y, calView.m, 1).getDay();
    const total = new Date(calView.y, calView.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(el('span'));
    for (let d = 1; d <= total; d++) {
      const iso = `${calView.y}-${pad(calView.m + 1)}-${pad(d)}`;
      const cell = el(chosen ? 'button' : 'span', 'day', String(d));
      if (chosen) {
        cell.type = 'button';
        cell.addEventListener('click', () => {
          patch(chosen.id, {prazo: iso}, 0);
          toast(`${label(chosen)}: prazo movido para ${brDate(iso)}.`);
        });
      }
      if (iso === todayIso) { cell.classList.add('today'); cell.setAttribute('aria-current', 'date'); }
      const onDay = rows.filter((r) => r.prazo.slice(0, 10) === iso);
      if (onDay.length) { cell.classList.add('due'); cell.title = onDay.map(label).join(', '); }
      cells.push(cell);
    }
    $('cal-grid').replaceChildren(...cells);
    const prefix = `${calView.y}-${pad(calView.m + 1)}-`;
    $('cal-list').replaceChildren(...rows.filter((r) => r.prazo.startsWith(prefix)).map((r) => el('li', '', `${brDate(r.prazo)}: ${label(r)}`)));
  };
  const calClose = () => {
    $('cal').hidden = true;
    document.querySelectorAll('.cal-open').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };
  document.querySelectorAll('.cal-open').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const was = btn.getAttribute('aria-expanded') === 'true';
      calClose();
      if (was) return;
      calToday();
      btn.setAttribute('aria-expanded', 'true');
      const box = $('cal');
      box.hidden = false;
      renderCalendar();
      const page = $('page').getBoundingClientRect();
      const a = btn.getBoundingClientRect();
      box.style.left = `${Math.max(16, Math.min(a.left - page.left, page.width - box.offsetWidth - 16))}px`;
      let top = a.bottom - page.top + 6;
      if (top + box.offsetHeight > page.height) top = Math.max(0, a.top - page.top - box.offsetHeight - 6);
      box.style.top = `${top}px`;
    });
  });
  const calMove = (delta) => {
    const next = new Date(calView.y, calView.m + delta, 1);
    calView.y = next.getFullYear();
    calView.m = next.getMonth();
    renderCalendar();
  };
  $('cal-prev').addEventListener('click', () => calMove(-1));
  $('cal-next').addEventListener('click', () => calMove(1));
  $('cal-go').addEventListener('click', () => { calToday(); renderCalendar(); });
  document.addEventListener('pointerdown', (e) => {
    if (!$('cal').hidden && !e.target.closest('.cal') && !e.target.closest('.cal-open') && !e.target.closest('[data-focus-key]')) calClose();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') calClose(); });

  // Texto em onda ao lado do nome: lento em repouso e rápido conforme o mouse.
  const startBrandMotion = () => {
    const tint = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim();
    const setup = (canvas) => {
      const ctx = canvas.getContext('2d');
      const size = {w: 0, h: 0, ctx};
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.w = canvas.clientWidth;
      size.h = canvas.clientHeight;
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      return size;
    };

    const wave = setup($('wave'));
    const PHRASES = ['criativas', 'grandes ideias'];
    const HOLD = 6, FADE = 0.5; // segundos em cada texto e na troca
    let phraseIndex = 0, phraseClock = FADE;
    const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let scrambled = [[], []], scrambleClock = 1;
    const scramble = () => {
      const letters = [...PHRASES[phraseIndex]];
      scrambled = [0.14, 0.3].map((chance) => letters.map((letter) => (letter !== ' ' && Math.random() < chance
        ? RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)]
        : letter)));
    };
    scramble();
    const font = getComputedStyle(document.body).getPropertyValue('--display').trim();
    let phase = 0.6;
    const drawWave = () => {
      const {ctx, w, h} = wave;
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = tint;
      // Duas fitas opostas: em cada coluna, uma letra fica à frente, grande, e a outra atrás, pequena.
      const letters = [...PHRASES[phraseIndex]];
      const fade = Math.min(1, phraseClock / FADE, (HOLD - phraseClock) / FADE);
      const marks = [];
      [0, Math.PI].forEach((offset, strand) => {
        letters.forEach((_, i) => {
          const letter = scrambled[strand][i] ?? letters[i];
          const angle = phase + i * 0.55 + offset;
          const depth = (Math.cos(angle) + 1) / 2;
          marks.push({letter, depth, x: 6 + (i * (w - 12)) / (letters.length - 1), y: h / 2 + Math.sin(angle) * h * 0.27});
        });
      });
      marks.sort((a, b) => a.depth - b.depth).forEach((m) => {
        ctx.globalAlpha = (0.14 + m.depth * m.depth * 0.86) * Math.max(0, fade);
        ctx.font = `500 ${4.5 + m.depth * 8.5}px ${font}`;
        ctx.fillText(m.letter, m.x, m.y);
      });
      ctx.globalAlpha = 1;
    };

    drawWave();

    // Figura em caracteres: cores invertidas, com fundo transparente sobre o painel.
    const walkerCanvas = $('walker');
    const walkerCtx = walkerCanvas.getContext('2d');
    const WALK_W = 291, WALK_H = 510, WALK_COLS = 4, WALK_FRAMES = 12;
    const walkSprite = new Image();
    let walkReady = false, walkAt = 0, walkShown = -1, walkW = 0, walkH = 0;
    // Gráfico decorativo no fundo, com 5% de opacidade, que corre junto com os passos da figura.
    const chartTint = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim();
    const chartValue = (i) => 0.3 + 0.55 * Math.abs(Math.sin(i * 0.53) * 0.7 + Math.sin(i * 1.37 + 1) * 0.3);
    const drawWalkerChart = () => {
      const c = walkerCtx;
      const top = walkH * 0.12, bottom = walkH - 34, height = bottom - top;
      const STEP = 12, BAR = 8;
      const scroll = walkAt * 2.5;
      const shift = scroll % STEP;
      const firstIndex = Math.floor(scroll / STEP);
      c.save();
      c.globalAlpha = 0.05;
      c.fillStyle = chartTint;
      c.strokeStyle = chartTint;
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i <= 4; i++) {
        const y = Math.round(top + (height * i) / 4) + 0.5;
        c.moveTo(0, y);
        c.lineTo(walkW, y);
      }
      c.stroke();
      const count = Math.ceil(walkW / STEP) + 2;
      for (let i = 0; i < count; i++) {
        const h = chartValue(firstIndex + i) * height;
        c.fillRect(i * STEP - shift, bottom - h, BAR, h);
      }
      c.beginPath();
      for (let i = 0; i < count; i++) {
        const x = i * STEP - shift + BAR / 2;
        const y = bottom - chartValue(firstIndex + i) * height - 6;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.lineWidth = 1.5;
      c.stroke();
      c.restore();
    };
    const drawWalker = () => {
      if (!walkReady || !walkW || !walkH) return;
      const frame = Math.floor(walkAt) % WALK_FRAMES;
      walkShown = frame;
      const scale = 0.65 * Math.min((walkW - 16) / WALK_W, (walkH - 16) / WALK_H);
      const dw = WALK_W * scale, dh = WALK_H * scale;
      walkerCtx.clearRect(0, 0, walkW, walkH);
      drawWalkerChart();
      walkerCtx.drawImage(walkSprite, (frame % WALK_COLS) * WALK_W, Math.floor(frame / WALK_COLS) * WALK_H, WALK_W, WALK_H, (walkW - dw) / 2, (walkH - dh) / 2, dw, dh);
    };
    const resizeWalker = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      walkW = walkerCanvas.clientWidth;
      walkH = walkerCanvas.clientHeight;
      if (walkW < 20 || walkH < 20) { walkW = 0; walkH = 0; return; }
      walkerCanvas.width = Math.round(walkW * dpr);
      walkerCanvas.height = Math.round(walkH * dpr);
      walkerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      walkerCtx.imageSmoothingQuality = 'high';
      drawWalker();
    };
    new ResizeObserver(resizeWalker).observe(walkerCanvas);
    resizeWalker();
    walkSprite.addEventListener('load', () => { walkReady = true; drawWalker(); });
    walkSprite.src = 'assets/ascii-walker.png';

    // Pomodoro: 15 minutos em contagem regressiva; depois do terceiro, o contador volta a zero.
    const POMODORO = 15 * 60 * 1000;
    const SHOW_THIRD = 5000; // o 3 fica visível por alguns segundos antes de zerar
    const POMO_KEY = 'status-projetos-pomodoro';
    let pomoStart = Date.now();
    try {
      const saved = Number(localStorage.getItem(POMO_KEY));
      if (saved > 0 && saved <= Date.now()) pomoStart = saved;
      else localStorage.setItem(POMO_KEY, String(pomoStart));
    } catch (e) { /* segue sem guardar o início */ }
    const updatePomodoro = () => {
      const elapsed = Date.now() - pomoStart;
      const done = Math.floor(elapsed / POMODORO);
      const into = elapsed % POMODORO;
      const left = Math.ceil((POMODORO - into) / 1000);
      $('pomo-time').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      $('pomo-count').textContent = done > 0 && done % 3 === 0 && into < SHOW_THIRD ? '3' : String(done % 3);
    };
    updatePomodoro();
    setInterval(updatePomodoro, 250);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawWave);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const FULL_SPEED = 2600; // pixels por segundo considerados movimento máximo
    let travelled = 0, lastX = null, lastY = null, energy = 0, last = performance.now();
    window.addEventListener('pointermove', (e) => {
      if (lastX !== null) travelled += Math.hypot(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    }, {passive: true});
    // No celular não há mouse: tocar e rolar a tela também acelera as animações.
    let lastScroll = window.scrollY;
    window.addEventListener('pointerup', () => { lastX = null; lastY = null; }, {passive: true});
    window.addEventListener('scroll', () => {
      travelled += Math.abs(window.scrollY - lastScroll);
      lastScroll = window.scrollY;
    }, {passive: true});
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const speed = dt > 0 ? travelled / dt : 0;
      travelled = 0;
      const target = Math.pow(Math.min(1, speed / FULL_SPEED), 1.4);
      // Acelera depressa e desacelera aos poucos até a câmera lenta.
      energy += (target - energy) * (1 - Math.exp(-dt / (target > energy ? 0.12 : 0.9)));
      phase += (0.5 + 9.5 * energy) * dt;    // radianos por segundo das letras
      walkAt += (2.5 + 27.5 * energy) * dt;  // quadros por segundo da figura
      drawWalker();
      phraseClock += dt;
      if (phraseClock >= HOLD) { phraseClock = 0; phraseIndex = (phraseIndex + 1) % PHRASES.length; scrambleClock = 1; }
      // As letras trocam por caracteres aleatórios por instantes, mais depressa com o mouse rápido.
      scrambleClock += dt * (1 + energy * 5);
      if (scrambleClock >= 0.16) { scrambleClock = 0; scramble(); }
      $('wave').__phrase = PHRASES[phraseIndex];
      $('wave').__energy = energy;
      drawWave();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  // Com a fonte carregada, redesenha o que mede o tamanho dos textos.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (typeof render === 'function') render(); });
  startBrandMotion();

  // Pontos e nomes dos projetos flutuam devagar no próprio lugar; param enquanto são arrastados.
  const startFloating = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const offset = (time, seed, size) => [Math.sin(time * 0.42 + seed) * size, Math.cos(time * 0.31 + seed * 1.7) * size];
    const frame = (now) => {
      const time = now / 1000;
      const dragged = state.drag ? state.drag.id : null;
      const placed = floaters.radar.map((p) => {
        const [dx, dy] = p.row.id === dragged ? [0, 0] : offset(time, p.seed, 3);
        if (p.g) p.g.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
        return {x: p.x + dx, y: p.y + dy};
      });
      if (floaters.polygon && floaters.polygon.node) {
        const corners = floaters.polygon.center ? [floaters.polygon.center, ...placed] : placed;
        floaters.polygon.node.setAttribute('points', corners.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' '));
      }
      floaters.time.forEach((f) => {
        const [dx, dy] = f.row.id === dragged ? [0, 0] : offset(time, f.seed, 2);
        f.g.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  startFloating();

  const watchSize = (id, draw) => {
    let last = '';
    new ResizeObserver(() => {
      const b = $(id);
      const fit = window.matchMedia('(min-width: 900px)').matches;
      const key = `${b.clientWidth}x${fit ? b.clientHeight : 0}`;
      if (key !== last) { last = key; draw(); }
    }).observe($(id));
  };
  // O título acompanha o centro do radar, sem encostar na marca nem nos botões.
  const alignHead = () => {
    const head = document.querySelector('.head');
    const brand = document.querySelector('.brand');
    const name = document.querySelector('.brand-name');
    const wave = $('wave');
    head.style.transform = '';
    brand.style.transform = '';
    wave.style.transform = '';
    if (!window.matchMedia('(min-width: 900px)').matches) return;
    const box = head.getBoundingClientRect();
    const radar = $('radar').getBoundingClientRect();
    if (!radar.width) return;
    const nameBox = name.getBoundingClientRect();
    const minLeft = nameBox.right + wave.offsetWidth + 32;
    const maxRight = document.querySelector('.tools').firstElementChild.getBoundingClientRect().left - 16;
    let shift = radar.left + radar.width / 2 - (box.left + box.width / 2);
    shift = Math.max(minLeft - box.left, Math.min(maxRight - box.right, shift));
    head.style.transform = `translateX(${Math.round(shift)}px)`;
    // A animação fica no meio do espaço entre o nome e o título, na mesma linha dos dois.
    const waveBox = wave.getBoundingClientRect();
    const middle = (nameBox.right + box.left + shift) / 2;
    wave.style.transform = `translateX(${Math.round(middle - (waveBox.left + waveBox.width / 2))}px)`;
    const title = head.querySelector('h1').getBoundingClientRect();
    const rise = title.top + title.height / 2 - (nameBox.top + nameBox.height / 2);
    brand.style.transform = `translateY(${Math.round(rise)}px)`;
  };
  watchSize('radar', () => { renderRadar(); alignHead(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignHead);
  watchSize('timeline', renderTimeline);

  // Layout: 24 colunas por 24 linhas. Cada pessoa guarda o próprio arranjo.
  const CELLS = 24;
  const DEFAULT_LAYOUT = {
    prazo: {x: 0, y: 0, w: 5, h: 6},
    dias: {x: 0, y: 6, w: 5, h: 7},
    abertas: {x: 0, y: 13, w: 5, h: 5},
    radar: {x: 5, y: 0, w: 11, h: 13},
    ascii: {x: 16, y: 0, w: 3, h: 13},
    time: {x: 5, y: 13, w: 14, h: 5},
    alerta: {x: 19, y: 0, w: 5, h: 10},
    concluir: {x: 19, y: 10, w: 5, h: 8},
    table: {x: 0, y: 18, w: 24, h: 6},
  };
  const MIN_SIZE = {ascii: {w: 2, h: 4}, prazo: {w: 3, h: 4}, dias: {w: 3, h: 4}, abertas: {w: 3, h: 3}, radar: {w: 5, h: 6}, time: {w: 6, h: 4}, alerta: {w: 3, h: 4}, concluir: {w: 3, h: 4}, table: {w: 8, h: 4}};
  const LAYOUT_KEY = 'status-projetos-layout';
  const cloneLayout = (l) => JSON.parse(JSON.stringify(l));
  let layout = cloneLayout(DEFAULT_LAYOUT);
  let layoutRef = null;
  let layoutTimer = null;
  const panels = [...document.querySelectorAll('.panel')];
  const panelOf = (id) => panels.find((p) => p.dataset.panel === id);
  const validLayout = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const id of Object.keys(DEFAULT_LAYOUT)) {
      const r = raw[id];
      if (!r && id === 'ascii') continue;
      if (!r || ![r.x, r.y, r.w, r.h].every(Number.isInteger)) return null;
      if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > CELLS || r.y + r.h > CELLS) return null;
      out[id] = {x: r.x, y: r.y, w: r.w, h: r.h};
    }
    // Layouts salvos com a antiga área da animação: a área vizinha ocupa o espaço liberado.
    const gone = raw.arvore;
    if (gone) {
      const neighbor = Object.values(out).find((o) => o.y === gone.y && o.h === gone.h && o.x + o.w === gone.x)
        || Object.values(out).find((o) => o.y === gone.y && o.h === gone.h && gone.x + gone.w === o.x);
      if (neighbor) {
        if (neighbor.x > gone.x) neighbor.x = gone.x;
        neighbor.w += gone.w;
      }
    }
    if (!out.ascii) out.ascii = placeNewPanel(out);
    return out;
  };
  // Layouts salvos antes desta área: usa um espaço livre ou divide o radar ou a maior área.
  const placeNewPanel = (rects) => {
    const free = (x, y, w, h) => Object.values(rects).every((o) => x >= o.x + o.w || x + w <= o.x || y >= o.y + o.h || y + h <= o.y);
    for (const [w, h] of [[3, 10], [3, 8], [3, 6], [2, 6], [3, 4]]) {
      for (let y = 0; y + h <= CELLS; y++) {
        for (let x = 0; x + w <= CELLS; x++) {
          if (free(x, y, w, h)) return {x, y, w, h};
        }
      }
    }
    const id = rects.radar.w - 3 >= MIN_SIZE.radar.w ? 'radar' : Object.keys(rects).sort((a, b) => rects[b].w * rects[b].h - rects[a].w * rects[a].h)[0];
    const r = rects[id];
    if (r.w - 3 >= MIN_SIZE[id].w) {
      r.w -= 3;
      return {x: r.x + r.w, y: r.y, w: 3, h: r.h};
    }
    const cut = Math.min(5, r.h - MIN_SIZE[id].h);
    r.h -= cut;
    return {x: r.x, y: r.y + r.h, w: r.w, h: cut};
  };
  const place = (node, r) => {
    node.style.gridColumn = `${r.x + 1} / span ${r.w}`;
    node.style.gridRow = `${r.y + 1} / span ${r.h}`;
  };
  const applyLayout = () => {
    panels.forEach((p) => place(p, layout[p.dataset.panel]));
    [...panels].sort((a, b) => {
      const ra = layout[a.dataset.panel], rb = layout[b.dataset.panel];
      return ra.y - rb.y || ra.x - rb.x;
    }).forEach((p, i) => { p.style.order = i; });
    alignHead();
  };
  const saveLayout = () => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) { /* segue sem cópia local */ }
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(async () => {
      if (!layoutRef) return;
      try { await layoutRef.set({panels: layout}); } catch (e) { layoutRef = null; }
    }, 500);
  };
  try {
    const stored = validLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'));
    if (stored) layout = stored;
  } catch (e) { /* usa o padrão */ }
  applyLayout();

  const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const mostOverlapped = (id, rect) => {
    let best = null, area = 0;
    Object.keys(layout).forEach((other) => {
      if (other === id) return;
      const a = overlapArea(rect, layout[other]);
      if (a > area) { area = a; best = other; }
    });
    return best;
  };
  // Soltar sobre outro painel troca os dois de lugar; soltar em área livre apenas move.
  const commitMove = (id, rect, chosen) => {
    const target = chosen || mostOverlapped(id, rect);
    if (target) {
      const from = layout[id];
      layout[id] = layout[target];
      layout[target] = from;
    } else {
      layout[id] = rect;
    }
    applyLayout();
    saveLayout();
  };
  const crosses = (a, b, pos, size) => a[pos] < b[pos] + b[size] && b[pos] < a[pos] + a[size];
  // Aumentar um painel empurra a borda dos vizinhos até o tamanho mínimo deles.
  const resizeSide = (base, id, side, delta) => {
    const out = cloneLayout(base);
    const r = out[id];
    const horizontal = side === 'e' || side === 'w';
    const pos = horizontal ? 'x' : 'y', size = horizontal ? 'w' : 'h';
    const cPos = horizontal ? 'y' : 'x', cSize = horizontal ? 'h' : 'w';
    const others = Object.keys(out).filter((k) => k !== id && crosses(r, out[k], cPos, cSize));
    if (side === 'e' || side === 's') {
      const edge = r[pos] + r[size];
      let next = Math.max(r[pos] + MIN_SIZE[id][size], Math.min(CELLS, edge + delta));
      const beyond = others.filter((k) => out[k][pos] >= edge);
      if (next > edge) beyond.forEach((k) => { next = Math.max(edge, Math.min(next, out[k][pos] + out[k][size] - MIN_SIZE[k][size])); });
      r[size] = next - r[pos];
      beyond.forEach((k) => {
        const o = out[k];
        if (o[pos] < next) { o[size] = o[pos] + o[size] - next; o[pos] = next; }
      });
    } else {
      const edge = r[pos];
      const end = r[pos] + r[size];
      let next = Math.min(end - MIN_SIZE[id][size], Math.max(0, edge + delta));
      const beyond = others.filter((k) => out[k][pos] + out[k][size] <= edge);
      if (next < edge) beyond.forEach((k) => { next = Math.min(edge, Math.max(next, out[k][pos] + MIN_SIZE[k][size])); });
      r[pos] = next;
      r[size] = end - next;
      beyond.forEach((k) => {
        const o = out[k];
        if (o[pos] + o[size] > next) o[size] = next - o[pos];
      });
    }
    return out;
  };
  const boardCell = () => {
    const box = $('board').getBoundingClientRect();
    const gap = 8;
    return {w: (box.width + gap) / CELLS, h: (box.height + gap) / CELLS};
  };
  const ghost = el('div', 'ghost');
  ghost.hidden = true;
  $('board').append(ghost);

  panels.forEach((panel) => {
    const id = panel.dataset.panel;
    const grip = el('button', 'grip');
    grip.type = 'button';
    grip.setAttribute('aria-label', `Mover ${panel.dataset.title}. Use as setas para mover e Shift com as setas para redimensionar.`);
    grip.append(el('span', 'grip-tag', panel.dataset.title));
    panel.append(grip);

    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.focus({preventScroll: true});
      const start = {...layout[id]};
      const cell = boardCell();
      const sx = e.clientX, sy = e.clientY;
      let rect = start;
      let chosen = null;
      let moved = false;
      const clearMarks = () => panels.forEach((p) => p.classList.remove('swap-target'));
      const move = (m) => {
        const dx = m.clientX - sx, dy = m.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        panel.classList.add('dragging');
        panel.style.transform = `translate(${dx}px, ${dy}px)`;
        rect = {
          x: Math.max(0, Math.min(CELLS - start.w, start.x + Math.round(dx / cell.w))),
          y: Math.max(0, Math.min(CELLS - start.h, start.y + Math.round(dy / cell.h))),
          w: start.w, h: start.h,
        };
        const boardBox = $('board').getBoundingClientRect();
        const cx = (m.clientX - boardBox.left) / cell.w;
        const cy = (m.clientY - boardBox.top) / cell.h;
        const under = Object.keys(layout).find((k) => {
          const o = layout[k];
          return k !== id && cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h;
        });
        const target = under || mostOverlapped(id, rect);
        chosen = target;
        clearMarks();
        if (target) panelOf(target).classList.add('swap-target');
        place(ghost, target ? layout[target] : rect);
        ghost.hidden = false;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        panel.classList.remove('dragging');
        panel.style.transform = '';
        ghost.hidden = true;
        clearMarks();
        if (moved && (chosen || rect.x !== start.x || rect.y !== start.y)) commitMove(id, rect, chosen);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });

    grip.addEventListener('keydown', (e) => {
      const step = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key];
      if (!step) return;
      e.preventDefault();
      if (e.shiftKey) {
        layout = step[0] ? resizeSide(layout, id, 'e', step[0]) : resizeSide(layout, id, 's', step[1]);
        applyLayout();
        saveLayout();
        return;
      }
      const r = layout[id];
      const nx = Math.max(0, Math.min(CELLS - r.w, r.x + step[0]));
      const ny = Math.max(0, Math.min(CELLS - r.h, r.y + step[1]));
      if (nx !== r.x || ny !== r.y) commitMove(id, {...r, x: nx, y: ny});
    });

    ['n', 'e', 's', 'w', 'se'].forEach((side) => {
      const rz = el('div', `rz rz-${side}`);
      panel.append(rz);
      rz.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const base = cloneLayout(layout);
        const cell = boardCell();
        const sx = e.clientX, sy = e.clientY;
        const move = (m) => {
          const dx = Math.round((m.clientX - sx) / cell.w);
          const dy = Math.round((m.clientY - sy) / cell.h);
          let next = base;
          if (side.includes('e')) next = resizeSide(next, id, 'e', dx);
          if (side.includes('w')) next = resizeSide(next, id, 'w', dx);
          if (side.includes('s')) next = resizeSide(next, id, 's', dy);
          if (side.includes('n')) next = resizeSide(next, id, 'n', dy);
          layout = next;
          applyLayout();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          saveLayout();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
    });
  });

  const setEditing = (on) => {
    $('board').classList.toggle('editing', on);
    $('layout-edit').textContent = on ? 'Concluir' : 'Editar layout';
    $('layout-edit').setAttribute('aria-pressed', on);
    $('layout-reset').hidden = !on;
    if (on) {
      calClose();
      toast('Arraste uma área para mover ou trocar de lugar. Use as bordas para redimensionar.');
    }
  };
  $('layout-edit').addEventListener('click', () => setEditing(!$('board').classList.contains('editing')));
  $('layout-reset').addEventListener('click', () => {
    layout = cloneLayout(DEFAULT_LAYOUT);
    applyLayout();
    saveLayout();
    toast('Layout padrão restaurado.');
  });

  render();

  // Conexão com os dados compartilhados
  (async () => {
    const claude = window.claude;
    const [db, user] = claude ? await Promise.all([claude.use('db'), claude.use('user')]) : [null, null];
    state.db = db;
    if (!db) { render(); return; }
    const uid = user ? await user.id() : null;
    if (uid) {
      layoutRef = db.doc(`data/users/${uid}/layout`);
      try {
        const snap = await layoutRef.get();
        const saved = snap.exists ? validLayout(snap.data().panels) : null;
        if (saved) { layout = saved; applyLayout(); }
      } catch (e) { /* mantém o layout atual */ }
    }
    if (user) {
      const can = await user.can('data.write');
      if (can === false) state.canWrite = false;
    }
    db.collection('observacoes').onSnapshot((snap) => {
      state.notes = snap.docs.map((d) => ({...d.data(), id: d.id}));
      renderNotes();
    }, () => { setSync('error', 'Conexão interrompida'); });
    db.collection('entregas').onSnapshot((snap) => {
      state.rows = snap.docs.map((d) => ({...d.data(), id: d.id}));
      state.loaded = true;
      render();
    }, () => { setSync('error', 'Conexão interrompida'); });
    db.doc('config/geral').onSnapshot((snap) => {
      const data = snap.exists ? snap.data() : null;
      if (data && Number.isFinite(data.limite) && !limitTimer) state.limite = data.limite;
      render();
    }, () => {});
    render();
  })();
})();
