'use strict';
// The panel page script, run in jsdom with a fake acquireVsCodeApi (design 101, "A row").
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.css'), 'utf8');

function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, posted = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => {} });
  w.eval(SCRIPT);
  const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { w, d: w.document, posted, send, key };
}
const row = (o) => Object.assign({ url: 'https://github.com/acme/widgets/pull/1', ref: 'acme/widgets#1', title: 'Add retry', account: 'octo-dev', text: 'merge', dot: 'green', actionKind: 'merge', extraText: null, highlight: false, busy: false, error: null, hidden: false, busyText: null, ready: false, origin: [] }, o);
const render = (o) => Object.assign({ type: 'render', visible: true, notes: [], multiAccount: false, rows: [] }, o);
const U = (n) => `https://github.com/acme/widgets/pull/${n}`;

test('asks for state when ready', () => { assert.deepStrictEqual(page().posted[0], { type: 'ready' }); });

test('rows in given order with texts', () => {
  const p = page();
  p.send(render({ rows: [row({ url: U(2), ref: 'acme/widgets#2', title: 'Second', text: 'conflicts', dot: 'red', actionKind: 'prompt' }), row({ title: 'First' })] }));
  const rows = [...p.d.querySelectorAll('.row')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.ref').textContent), ['acme/widgets#2', 'acme/widgets#1']);
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.title').textContent), ['Second', 'First']);
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.action').textContent), ['conflicts', 'merge']);
  assert.ok(rows[0].querySelector('.dot').classList.contains('red'));
  assert.strictEqual(rows[1].getAttribute('title'), 'First');
  assert.strictEqual(rows[0].querySelector('.account'), null);
  assert.ok(/\.title[^{]*\{[^}]*text-overflow:\s*ellipsis/.test(CSS));
});

test('titles are text', () => {
  const p = page();
  p.send(render({ rows: [row({ title: '<img src=x onerror=alert(1)> & co' })] }));
  assert.strictEqual(p.d.querySelector('.title').textContent, '<img src=x onerror=alert(1)> & co');
  assert.strictEqual(p.d.querySelector('img'), null);
});

test('account tag only when multiAccount', () => {
  const p = page();
  p.send(render({ multiAccount: true, rows: [row()] }));
  assert.strictEqual(p.d.querySelector('.account').textContent, 'octo-dev');
});

test('clicks post action, extra and open', () => {
  const p = page();
  p.send(render({ rows: [row({ extraText: '2 findings' })] }));
  p.d.querySelector('.action').click();
  p.d.querySelector('.extra').click();
  p.d.querySelector('.open').click();
  assert.strictEqual(p.d.querySelector('.extra').textContent, '2 findings');
  assert.strictEqual(p.d.querySelector('.open').textContent, '↗');
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'action', url: U(1) }, { type: 'extra', url: U(1) }, { type: 'open', url: U(1) }]);
});

test('a row without an action has no action link', () => {
  const p = page();
  p.send(render({ rows: [row({ actionKind: null, text: 'checks 3/5' })] }));
  const a = p.d.querySelector('.action');
  assert.strictEqual(a.textContent, 'checks 3/5');
  a.click();
  assert.deepStrictEqual(p.posted, [{ type: 'ready' }, { type: 'chat', url: U(1) }], 'plain status text is part of the line: it opens the chat');
});

test('clicking the line, outside its links, asks for the chat and selects the row', () => {
  const p = page();
  p.send(render({ rows: [row()] }));
  const line = p.d.querySelector('.title').closest('.row');
  p.d.querySelector('.title').click();
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'chat', url: U(1) }]);
  assert.ok(line.classList.contains('selected'));
  p.d.querySelector('.action').click();
  p.d.querySelector('.open').click();
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'chat', url: U(1) }, { type: 'action', url: U(1) }, { type: 'open', url: U(1) }], 'a link does only its own thing; ↗ is GitHub');
});

test('Enter and o act on the selected row; arrows move', () => {
  const p = page();
  p.send(render({ rows: [row({ url: U(1) }), row({ url: U(2), ref: 'acme/widgets#2' })] }));
  p.key('ArrowDown');
  p.key('Enter');
  p.key('o');
  p.key('ArrowDown');
  p.key('ArrowDown');
  p.key('ArrowUp');
  p.key('Enter');
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'action', url: U(1) }, { type: 'open', url: U(1) }, { type: 'action', url: U(1) }]);
  assert.strictEqual(p.d.querySelectorAll('.row.selected').length, 1);
});

test('selection survives a re-render by url', () => {
  const p = page();
  const rows = [row({ url: U(1) }), row({ url: U(2) })];
  p.send(render({ rows })); p.key('ArrowDown'); p.key('ArrowDown');
  p.send(render({ rows: rows.slice().reverse() }));
  p.key('Enter');
  assert.deepStrictEqual(p.posted[1], { type: 'action', url: U(2) });
});

test('fresh and visible posts seen after 4 s', () => {
  const p = page();
  p.w.setTimeout = (fn, ms) => { p.timers.push({ fn, ms }); return p.timers.length; };
  p.timers = [];
  p.send(render({ visible: true, rows: [row({ highlight: true }), row({ url: U(2) })] }));
  assert.ok(p.d.querySelector('.row').classList.contains('fresh'));
  const t = p.timers.filter((x) => x.ms === 4000);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(p.posted.filter((m) => m.type === 'seen').length, 0);
  t[0].fn();
  assert.deepStrictEqual(p.posted.filter((m) => m.type === 'seen'), [{ type: 'seen', url: U(1) }]);
});

test('fresh and hidden posts seen on mouseenter', () => {
  const p = page();
  p.send(render({ visible: false, rows: [row({ highlight: true })] }));
  assert.strictEqual(p.posted.filter((m) => m.type === 'seen').length, 0);
  p.d.querySelector('.row').dispatchEvent(new p.w.MouseEvent('mouseenter'));
  assert.deepStrictEqual(p.posted.filter((m) => m.type === 'seen'), [{ type: 'seen', url: U(1) }]);
});

test('a re-render that drops the highlight cancels the pending seen', () => {
  const p = page();
  p.timers = []; p.w.setTimeout = (fn, ms) => { p.timers.push({ fn, ms, id: p.timers.length + 1 }); return p.timers.length; };
  p.w.clearTimeout = (id) => { p.timers = p.timers.filter((t) => t.id !== id); };
  p.send(render({ rows: [row({ highlight: true })] }));
  p.send(render({ rows: [row({ highlight: false })] }));
  assert.strictEqual(p.timers.filter((x) => x.ms === 4000).length, 0);
});

test('busy shows merging…', () => {
  const p = page();
  p.send(render({ rows: [row({ busy: true })] }));
  assert.strictEqual(p.d.querySelector('.action').textContent, 'merging…');
});

test('busy shows the host busy text', () => {
  const p = page();
  p.send(render({ rows: [row({ busy: true, busyText: 'updating…', actionKind: 'update', text: 'behind base' })] }));
  assert.strictEqual(p.d.querySelector('.action').textContent, 'updating…');
});

test('errors show under the row text', () => {
  const p = page();
  p.send(render({ rows: [row({ error: 'Merge failed: nope' })] }));
  assert.strictEqual(p.d.querySelector('.error').textContent, 'Merge failed: nope');
  assert.ok(/\.error[^{]*\{[^}]*var\(--vscode-errorForeground\)/.test(CSS));
});

test('notes render above the list; empty state', () => {
  const p = page();
  p.send(render({ notes: ['Sign in with gh'], rows: [] }));
  assert.deepStrictEqual([...p.d.querySelectorAll('.note')].map((n) => n.textContent), ['Sign in with gh']);
  assert.strictEqual(p.d.querySelector('.empty').textContent, 'No open pull requests.');
  p.send(render({ rows: [row()] }));
  assert.strictEqual(p.d.querySelector('.empty'), null);
  assert.strictEqual(p.d.querySelectorAll('.note').length, 0);
});

test('CSS uses theme variables only', () => {
  assert.ok(!/#[0-9a-fA-F]{3,6}\b|rgb\(/.test(CSS), 'no literal colors');
  assert.ok(/\.row\.fresh/.test(CSS));
});

test('x posts hide', () => {
  const p = page();
  p.send(render({ rows: [row()] }));
  const x = p.d.querySelector('.hide');
  assert.strictEqual(x.getAttribute('title'), 'Hide this PR');
  x.click();
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'hide', url: U(1) }]);
  assert.ok(/\.row:hover[^{]*\.hide|\.row\.selected[^{]*\.hide/.test(CSS));
});

test('hidden rows not drawn by default', () => {
  const p = page();
  p.send(render({ rows: [row({ hidden: true }), row({ url: U(2), ref: 'acme/widgets#2' })] }));
  assert.deepStrictEqual([...p.d.querySelectorAll('.row')].map((r) => r.dataset.url), [U(2)]);
  assert.strictEqual(p.d.querySelector('.toggle-hidden').textContent, 'Show 1 hidden');
});

test('Show N hidden toggles and shows unhide', () => {
  const p = page();
  p.send(render({ rows: [row({ hidden: true }), row({ url: U(2), ref: 'acme/widgets#2' })] }));
  p.d.querySelector('.toggle-hidden').click();
  const rows = [...p.d.querySelectorAll('.row')];
  assert.strictEqual(rows.length, 2);
  const h = rows.find((r) => r.dataset.url === U(1));
  assert.ok(h.classList.contains('hidden'));
  assert.strictEqual(h.querySelector('.hide'), null);
  assert.strictEqual(h.querySelector('.unhide').textContent, 'unhide');
  assert.strictEqual(p.d.querySelector('.toggle-hidden').textContent, 'Hide 1 hidden');
  h.querySelector('.unhide').click();
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'unhide', url: U(1) }]);
  // the toggle survives a re-render
  p.send(render({ rows: [row({ hidden: true })] }));
  assert.strictEqual(p.d.querySelectorAll('.row').length, 1);
  p.d.querySelector('.toggle-hidden').click();
  assert.strictEqual(p.d.querySelectorAll('.row').length, 0);
  assert.strictEqual(p.d.querySelector('.toggle-hidden').textContent, 'Show 1 hidden');
});

test('h key hides selected, and unhides a shown hidden row', () => {
  const p = page();
  p.send(render({ rows: [row(), row({ url: U(2), ref: 'acme/widgets#2', hidden: true })] }));
  p.key('h');
  assert.deepStrictEqual(p.posted.slice(1), []);
  p.key('ArrowDown'); p.key('h');
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'hide', url: U(1) }]);
  p.d.querySelector('.toggle-hidden').click();
  p.key('ArrowDown'); p.key('h');
  assert.deepStrictEqual(p.posted.slice(2), [{ type: 'unhide', url: U(2) }]);
});

test('empty state with all hidden', () => {
  const p = page();
  p.send(render({ rows: [row({ hidden: true })] }));
  assert.strictEqual(p.d.querySelector('.empty').textContent, 'No open pull requests.');
  assert.strictEqual(p.d.querySelector('.toggle-hidden').textContent, 'Show 1 hidden');
  p.d.querySelector('.toggle-hidden').click();
  assert.strictEqual(p.d.querySelector('.empty'), null);
});

test('Enter on a focused link button is left to the button, not the selected row', () => {
  const p = page();
  p.send(render({ rows: [row({ url: U(1), extraText: '2 findings' })] }));
  p.key('ArrowDown');
  for (const cls of ['.open', '.extra', '.hide']) {
    const b = p.d.querySelector(cls);
    b.focus();
    const e = new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    b.dispatchEvent(e);
    assert.strictEqual(e.defaultPrevented, false, `${cls}: the button's own click still happens`);
  }
  assert.deepStrictEqual(p.posted.slice(1), [], 'no row action from Enter on a button');
  p.key('Enter');
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'action', url: U(1) }], 'Enter elsewhere still acts');
});

test('running rows get a spinner dot, a static ring with reduced motion', () => {
  const p = page();
  p.send(render({ rows: [row({ dot: 'running', actionKind: null, text: 'checks 3/5' })] }));
  assert.ok(p.d.querySelector('.dot').classList.contains('running'));
  const rule = /\.dot\.running\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(rule, 'a .dot.running rule');
  assert.match(rule[1], /animation:\s*[\w-]+\s[^;]*infinite/);
  assert.match(rule[1], /border[^;]*var\(--vscode-/);
  const name = /animation:\s*([\w-]+)/.exec(rule[1])[1];
  assert.match(CSS, new RegExp(`@keyframes ${name}\\s*\\{[^}]*rotate`));
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(CSS);
  assert.ok(reduced && /\.dot\.running\s*\{[^}]*animation:\s*none/.test(reduced[1] + '}'), 'reduced motion stops the spin');
});

test('the row tooltip is the title and where the PR was made', () => {
  const p = page();
  p.send(render({ rows: [row({ origin: ['Made on desktop · Claude session 3f2a9c1e · /home/dev/widgets', 'Transcript: /t/3f2a.jsonl'] })] }));
  const line = p.d.querySelector('.row');
  assert.strictEqual(line.getAttribute('title'), 'Add retry\nMade on desktop · Claude session 3f2a9c1e · /home/dev/widgets\nTranscript: /t/3f2a.jsonl');
  assert.strictEqual(p.d.querySelector('.title').getAttribute('title'), null, 'one tooltip for the line');
});

test('a mergeable row is marked ready', () => {
  const p = page();
  p.send(render({ rows: [row({ ready: true }), row({ url: U(2), ref: 'acme/widgets#2', ready: false })] }));
  const [a, b] = p.d.querySelectorAll('.row');
  assert.ok(a.classList.contains('ready'));
  assert.ok(!b.classList.contains('ready'));
});
