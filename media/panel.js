// The PRs panel page (design 101, "A row"): notes, then one line per PR. Everything is built with textContent.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const d = document;
  const SEEN_MS = 4000;
  let state = { visible: true, notes: [], multiAccount: false, rows: [] };
  let selectedUrl = null;
  const timers = new Map(); // url -> pending "seen" timer

  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const post = (type, url) => vscode.postMessage({ type, url });
  const link = (cls, text, onClick) => {
    const b = el('button', 'link ' + cls, text); b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  const root = el('div', 'root'); root.setAttribute('role', 'listbox');
  d.body.append(root);

  function syncSeen() {
    const want = new Set(state.visible ? state.rows.filter((r) => r.highlight).map((r) => r.url) : []);
    for (const [url, id] of [...timers]) if (!want.has(url)) { clearTimeout(id); timers.delete(url); }
    for (const url of want) {
      if (timers.has(url)) continue;
      timers.set(url, setTimeout(() => { timers.delete(url); post('seen', url); }, SEEN_MS));
    }
  }

  function render() {
    const nodes = [];
    for (const n of state.notes) nodes.push(el('div', 'note', n));
    if (!state.rows.length) nodes.push(el('div', 'empty', 'No open pull requests.'));
    for (const r of state.rows) {
      const line = el('div', 'row' + (r.highlight ? ' fresh' : '') + (r.url === selectedUrl ? ' selected' : ''));
      line.setAttribute('role', 'option'); line.dataset.url = r.url;
      const main = el('div', 'line');
      main.append(el('span', 'dot ' + r.dot), el('span', 'ref', r.ref), el('span', 'title', r.title));
      main.lastChild.setAttribute('title', r.title);
      if (state.multiAccount) main.append(el('span', 'account', r.account));
      const label = r.busy ? 'merging…' : r.text;
      main.append(r.actionKind && !r.busy ? link('action', label, () => post('action', r.url)) : el('span', 'action', label));
      if (r.extraText) main.append(link('extra', r.extraText, () => post('extra', r.url)));
      main.append(link('open', '↗', () => post('open', r.url)));
      line.append(main);
      if (r.error) line.append(el('div', 'error', r.error));
      line.addEventListener('mouseenter', () => { if (!state.visible && r.highlight) post('seen', r.url); });
      line.addEventListener('click', () => { selectedUrl = r.url; mark(); });
      nodes.push(line);
    }
    root.replaceChildren(...nodes);
    syncSeen();
  }

  function mark() {
    for (const n of root.querySelectorAll('.row')) n.classList.toggle('selected', n.dataset.url === selectedUrl);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'render') return;
    state = { visible: !!m.visible, notes: m.notes || [], multiAccount: !!m.multiAccount, rows: m.rows || [] };
    if (selectedUrl && !state.rows.some((r) => r.url === selectedUrl)) selectedUrl = null;
    render();
  });

  d.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = state.rows.findIndex((r) => r.url === selectedUrl);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!state.rows.length) return;
      const next = e.key === 'ArrowDown' ? Math.min(i + 1, state.rows.length - 1) : Math.max(i - 1, 0);
      selectedUrl = state.rows[next].url; mark();
      const n = root.querySelector('.row.selected'); if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    } else if (i >= 0 && e.key === 'Enter') {
      const r = state.rows[i];
      if (r.actionKind && !r.busy) post('action', r.url);
      e.preventDefault();
    } else if (i >= 0 && e.key === 'o') {
      post('open', state.rows[i].url);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
