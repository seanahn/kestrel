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
const row = (o) => Object.assign({ url: 'https://github.com/acme/widgets/pull/1', ref: 'acme/widgets#1', title: 'Add retry', account: 'octo-dev', text: 'merge', dot: 'green', actionKind: 'merge', extraText: null, highlight: false, busy: false, error: null }, o);
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
  assert.strictEqual(rows[1].querySelector('.title').getAttribute('title'), 'First');
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
  assert.deepStrictEqual(p.posted, [{ type: 'ready' }]);
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
