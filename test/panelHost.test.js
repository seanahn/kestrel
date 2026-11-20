'use strict';
// The panel host (design 101, "The panel tab"): rows to the page, clicks to hand-off and merger.
const test = require('node:test'); const assert = require('node:assert');
const { install } = require('./vscodeStub');
const { createTracker } = require('../src/tracker');

const pr = (n, o = {}) => ({
  id: `PR_${n}`, url: `https://github.com/acme/widgets/pull/${n}`, number: n, title: `Change ${n}`, repo: 'acme/widgets',
  account: 'octo-dev', isDraft: false, updatedAt: `2026-01-0${n}T00:00:00Z`, headOid: `head${n}`,
  mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: null,
  checks: [{ name: 'test', state: 'success' }], reviews: [], unresolvedThreads: 0,
  mergeMethods: { squash: true, merge: true, rebase: true }, ...o,
});
const blocked = { mergeState: 'BLOCKED' };

function setup(prs) {
  const { vscode, ui } = install();
  delete require.cache[require.resolve('../src/panel')];
  const { PanelProvider } = require('../src/panel');
  const tracker = createTracker({ now: () => Date.parse('2026-03-01T00:00:00Z') });
  tracker.apply('octo-dev', prs);
  const sent = [], merged = [], updated = []; const busySet = new Set(), failedSet = new Set(); const kinds = new Map();
  const handoff = { send: async (p) => { sent.push(p); } };
  const merger = {
    merge: async (u) => { merged.push(u); }, update: async (u) => { updated.push(u); },
    busy: (u) => busySet.has(u), busyKind: (u) => (busySet.has(u) ? kinds.get(u) || 'merge' : null),
    updateFailed: (u) => failedSet.has(u),
  };
  const panel = new PanelProvider({ vscode, extensionUri: vscode.Uri.file('/ext'), tracker, handoff, merger });
  ui.providers['kestrel.prs'] = panel;
  const view = ui.resolveView();
  view.webview._receive({ type: 'ready' });
  const last = () => view.webview.posted[view.webview.posted.length - 1];
  return { ui, tracker, view, sent, merged, updated, busySet, failedSet, kinds, panel, last };
}
const U = (n) => `https://github.com/acme/widgets/pull/${n}`;

test('page html has a nonce script and a CSP', () => {
  const { view } = setup([pr(1)]);
  const h = view.webview.html;
  assert.match(h, /Content-Security-Policy[^>]*script-src 'nonce-[^']+'/);
  assert.match(h, /style-src vscode-resource:/);
  assert.match(h, /media\/panel\.js/);
});

test('ready posts render with rows, in tracker order, and no prompt text', () => {
  const { last, tracker } = setup([pr(1, { mergeable: 'CONFLICTING' }), pr(2)]);
  const m = last();
  assert.strictEqual(m.type, 'render');
  assert.strictEqual(m.visible, true);
  assert.strictEqual(m.multiAccount, false);
  assert.deepStrictEqual(m.notes, []);
  assert.strictEqual(m.rows.length, 2);
  const r = m.rows.find((x) => x.url === U(1));
  assert.deepStrictEqual(Object.keys(r).sort(), ['account', 'actionKind', 'busy', 'busyText', 'dot', 'error', 'extraText', 'hidden', 'highlight', 'origin', 'ready', 'ref', 'text', 'title', 'url'].sort());
  assert.strictEqual(r.ref, 'acme/widgets#1');
  assert.strictEqual(r.actionKind, 'prompt');
  assert.strictEqual(r.text, 'conflicts');
  assert.ok(!JSON.stringify(m).includes('resolve the merge conflicts'));
  assert.strictEqual(m.rows.find((x) => x.url === U(2)).actionKind, 'merge');
  assert.strictEqual(tracker.rows().length, 2);
});

test('multiAccount when rows span accounts', () => {
  const { tracker, last } = setup([pr(1)]);
  tracker.apply('octo-work', [pr(2, { account: 'octo-work' })]);
  assert.strictEqual(last().multiAccount, true);
});

test('badge value and tooltip, cleared at zero', () => {
  const { view, tracker } = setup([pr(1, { mergeable: 'CONFLICTING' }), pr(2)]);
  assert.deepStrictEqual(view.badge, { value: 2, tooltip: '2 PRs need you' });
  tracker.apply('octo-dev', [pr(1, { mergeable: 'CONFLICTING' })]);
  assert.deepStrictEqual(view.badge, { value: 1, tooltip: '1 PR needs you' });
  tracker.apply('octo-dev', [pr(3, { isDraft: true })]);
  assert.strictEqual(view.badge, undefined);
});

test('action on a prompt row hands off that row\'s prompt', () => {
  const { view, sent, merged } = setup([pr(1, { mergeable: 'CONFLICTING' })]);
  view.webview._receive({ type: 'action', url: U(1) });
  assert.deepStrictEqual(sent, [`resolve the merge conflicts on PR acme/widgets#1 (${U(1)})`]);
  assert.deepStrictEqual(merged, []);
});

test('action on a merge row calls the merger', () => {
  const { view, sent, merged } = setup([pr(1)]);
  view.webview._receive({ type: 'action', url: U(1) });
  assert.deepStrictEqual(merged, [U(1)]);
  assert.deepStrictEqual(sent, []);
});

test('action on an open row opens the PR', () => {
  const { view, ui } = setup([pr(1, blocked)]);
  view.webview._receive({ type: 'action', url: U(1) });
  assert.deepStrictEqual(ui.opened, [U(1)]);
});

test('extra hands off the extra prompt; open opens; seen marks seen', () => {
  const { view, sent, ui, tracker, last } = setup([pr(1, { unresolvedThreads: 2 })]);
  const row = tracker.rows()[0];
  assert.strictEqual(last().rows[0].extraText, '2 unresolved comments');
  view.webview._receive({ type: 'extra', url: U(1) });
  assert.deepStrictEqual(sent, [row.state.extra.prompt]);
  assert.strictEqual(sent[0], `check the unresolved review comments on PR acme/widgets#1 (${U(1)})`);
  view.webview._receive({ type: 'open', url: U(1) });
  assert.deepStrictEqual(ui.opened, [U(1)]);
  tracker.apply('octo-dev', [pr(1)]);
  tracker.apply('octo-dev', [pr(1, { mergeable: 'CONFLICTING' })]);
  assert.strictEqual(tracker.rows()[0].highlight, true);
  view.webview._receive({ type: 'seen', url: U(1) });
  assert.strictEqual(tracker.rows()[0].highlight, false);
});

test('unknown urls and messages are ignored', () => {
  const { view, sent, merged, ui } = setup([pr(1)]);
  for (const t of ['action', 'extra', 'open', 'seen']) view.webview._receive({ type: t, url: 'https://x/y' });
  view.webview._receive(null); view.webview._receive({ type: 'bogus' });
  assert.deepStrictEqual([sent, merged, ui.opened], [[], [], []]);
});

test('re-renders on tracker change', () => {
  const { view, tracker } = setup([pr(1)]);
  const n = view.webview.posted.length;
  tracker.apply('octo-dev', [pr(1), pr(2)]);
  assert.ok(view.webview.posted.length > n);
  assert.strictEqual(view.webview.posted[view.webview.posted.length - 1].rows.length, 2);
});

test('re-renders on visibility change, with visible', () => {
  const { view, last } = setup([pr(1)]);
  view._setVisible(false);
  assert.strictEqual(last().visible, false);
  view._setVisible(true);
  assert.strictEqual(last().visible, true);
});

test('render() reflects merger busy', () => {
  const { busySet, panel, last } = setup([pr(1)]);
  assert.strictEqual(last().rows[0].busy, false);
  busySet.add(U(1));
  panel.render();
  assert.strictEqual(last().rows[0].busy, true);
});

test('render() before a view exists does nothing', () => {
  const { vscode } = install();
  delete require.cache[require.resolve('../src/panel')];
  const { PanelProvider } = require('../src/panel');
  const tracker = createTracker({ now: () => 0 });
  new PanelProvider({ vscode, extensionUri: vscode.Uri.file('/ext'), tracker, handoff: {}, merger: {} }).render();
});

test('hide and unhide messages call the tracker; rows carry hidden', () => {
  const { view, tracker, last } = setup([pr(1), pr(2)]);
  view.webview._receive({ type: 'hide', url: U(1) });
  assert.deepStrictEqual(tracker.hiddenUrls(), [U(1)]);
  assert.strictEqual(last().rows.find((x) => x.url === U(1)).hidden, true);
  assert.strictEqual(last().rows.find((x) => x.url === U(2)).hidden, false);
  assert.strictEqual(view.badge.value, 1);
  view.webview._receive({ type: 'unhide', url: U(1) });
  assert.deepStrictEqual(tracker.hiddenUrls(), []);
  assert.strictEqual(last().rows.find((x) => x.url === U(1)).hidden, false);
});

test('behind base updates in place; after a refusal it hands the agent the prompt', () => {
  const { view, updated, sent, failedSet, panel, last } = setup([pr(1, { mergeState: 'BEHIND' })]);
  const r = last().rows[0];
  assert.strictEqual(r.actionKind, 'update');
  assert.strictEqual(r.text, 'behind base');
  view.webview._receive({ type: 'action', url: U(1) });
  assert.deepStrictEqual(updated, [U(1)]);
  assert.deepStrictEqual(sent, []);
  failedSet.add(U(1));
  panel.render();
  const f = last().rows[0];
  assert.strictEqual(f.actionKind, 'prompt');
  assert.strictEqual(f.text, 'behind base: ask agent');
  view.webview._receive({ type: 'action', url: U(1) });
  assert.deepStrictEqual(updated, [U(1)]);
  assert.deepStrictEqual(sent, ['update PR acme/widgets#1 with its base branch (https://github.com/acme/widgets/pull/1)']);
});

test('busy text names what is in flight', () => {
  const { busySet, kinds, panel, last } = setup([pr(1, { mergeState: 'BEHIND' }), pr(2)]);
  assert.strictEqual(last().rows[0].busyText, null);
  busySet.add(U(1)); kinds.set(U(1), 'update'); busySet.add(U(2));
  panel.render();
  const by = (n) => last().rows.find((x) => x.url === U(n));
  assert.strictEqual(by(1).busyText, 'updating…');
  assert.strictEqual(by(2).busyText, 'merging…');
});

test('rows carry ready and where the PR was made; a click opens the chat, else GitHub', async () => {
  const { vscode, ui } = install();
  delete require.cache[require.resolve('../src/panel')];
  const { PanelProvider } = require('../src/panel');
  const tracker = createTracker({ now: () => Date.parse('2026-03-01T00:00:00Z') });
  const record = { host: 'desktop', session: 'sess-rec-1', cwd: '/home/dev/widgets', transcript: '/t/rec.jsonl', at: '2026-03-01T00:00:00.000Z' };
  tracker.apply('octo-dev', [pr(1, { origin: record }), pr(2, blocked), pr(3)]);
  const local = new Map([[U(3), { session: 'sess-loc-3', cwd: '/w3', transcript: '/t/loc.jsonl', host: 'devbox' }]]);
  const wanted = [], opened = [];
  const origins = { want: (urls) => { wanted.push(...urls); return Promise.resolve(); }, get: (u) => local.get(u) || null };
  let answer = 'resumed';
  const handoff = { send: async () => {}, openSession: async (spec) => { opened.push(spec); return answer; } };
  const merger = { merge: async () => {}, update: async () => {}, busy: () => false, busyKind: () => null, updateFailed: () => false };
  const panel = new PanelProvider({ vscode, extensionUri: vscode.Uri.file('/ext'), tracker, handoff, merger, origins });
  ui.providers['kestrel.prs'] = panel;
  const view = ui.resolveView();
  view.webview._receive({ type: 'ready' });
  const m = view.webview.posted[view.webview.posted.length - 1];
  const by = (n) => m.rows.find((x) => x.url === U(n));
  assert.strictEqual(by(1).ready, true);
  assert.strictEqual(by(2).ready, false);
  assert.deepStrictEqual(by(1).origin, ['Made on desktop · Claude session sess-rec · /home/dev/widgets', 'Transcript: /t/rec.jsonl', 'Recorded 2026-03-01 00:00 UTC']);
  assert.deepStrictEqual(by(3).origin, ['Found on this machine (devbox) · Claude session sess-loc · /w3', 'Transcript: /t/loc.jsonl']);
  assert.deepStrictEqual(by(2).origin, ['No Claude chat found for this PR (no record on the PR, none on this machine).']);
  assert.deepStrictEqual([...new Set(wanted)].sort(), [U(2), U(3)].sort(), 'only PRs with no record are looked up locally');

  view.webview._receive({ type: 'chat', url: U(1) });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(opened[0], { url: U(1), session: 'sess-rec-1', cwd: '/home/dev/widgets', transcript: '/t/rec.jsonl' });
  assert.deepStrictEqual(ui.opened, [], 'the chat opened: no browser');
  answer = 'none';
  view.webview._receive({ type: 'chat', url: U(2) });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(opened[1], { url: U(2) });
  assert.strictEqual(ui.opened.length, 1, 'no chat: GitHub instead');
});
