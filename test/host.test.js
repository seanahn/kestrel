'use strict';
// The extension host against a fake vscode, a fake gh and a fake GitHub client. No network, no real gh.
const test = require('node:test'); const assert = require('node:assert');
const { install, memento } = require('./vscodeStub');
const { ui } = install();
const ext = require('../src/extension');

const RATE = { remaining: 4000, resetAt: '2099-01-01T00:00:00Z', cost: 1 };
const pr = (n, repo) => ({
  id: `PR_${repo}_${n}`, url: `https://github.com/${repo}/pull/${n}`, number: n, title: `Change ${n}`, repo, account: '',
  updatedAt: `2026-01-0${n}T00:00:00Z`, headOid: `head${n}`, mergeable: 'MERGEABLE', mergeState: 'CLEAN', isDraft: false,
  reviewDecision: null, rollup: 'SUCCESS', checks: [{ name: 'test', state: 'success' }], reviews: [], unresolvedThreads: 0,
  mergeMethods: { squash: true, merge: true, rebase: true },
});
const lists = { 'tok-octo-dev': [pr(1, 'acme/widgets')], 'tok-octo-work': [pr(2, 'acme/api')] };
const STATUS = 'github.com\\n  ✓ Logged in to github.com account octo-dev (keyring)\\n  ✓ Logged in to github.com account octo-work (keyring)\\n'.replace(/\\n/g, '\n');

function world() {
  const w = { listed: [], byUrl: [], ghCalls: [], scheduled: [], now: Date.parse('2026-03-01T00:00:00Z') };
  w.run = async (args) => {
    w.ghCalls.push(args);
    if (args[1] === 'status') return { code: 0, stdout: STATUS, stderr: '' };
    return { code: 0, stdout: `tok-${args[args.indexOf('--user') + 1]}\n`, stderr: '' };
  };
  w.client = {
    listPrs: async (token) => { w.listed.push(token); return { items: lists[token] || [], rateLimit: RATE }; },
    detailPrs: async (token, ids) => ({ prs: (lists[token] || []).filter((p) => ids.includes(p.id)), rateLimit: RATE }),
    prByUrl: async (token, url) => { w.byUrl.push([token, url]); return pr(9, 'acme/api'); },
    merge: async () => {},
  };
  w.timers = { set: (fn, ms) => { w.scheduled.push({ fn, ms }); return w.scheduled.length; }, clear: () => {} };
  return w;
}
const settle = () => new Promise((r) => setImmediate(r));
const context = () => ({ subscriptions: [], extensionUri: { fsPath: '/x', path: '/x', scheme: 'file' }, globalState: memento() });

async function boot() {
  ui.out.length = 0; ui.commands = {}; ui.config = {};
  const w = world();
  const ctx = context();
  const api = ext.activate(ctx, { run: w.run, client: w.client, timers: w.timers, now: () => w.now });
  await settle(); await settle();
  return { w, ctx, api };
}

test('activate wires the panel: rows from both accounts arrive', async () => {
  const { api, ctx } = await boot();
  const view = ui.resolveView();
  assert.deepStrictEqual(api.tracker.rows().map((r) => r.pr.account).sort(), ['octo-dev', 'octo-work']);
  const last = view.webview.posted[view.webview.posted.length - 1];
  assert.strictEqual(last.rows.length, 2);
  assert.ok(ui.commands['kestrel.refresh'] && ui.commands['kestrel.watch']);
  assert.ok(ctx.subscriptions.length > 0);
  ext.deactivate();
});

test('the output channel logs each account round with its cost', async () => {
  await boot();
  assert.ok(ui.out.some((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z octo-dev: 1 PRs, cost 2$/.test(l)), ui.out.join('\n'));
  assert.ok(ui.out.some((l) => / octo-work: 1 PRs, cost 2$/.test(l)));
  ext.deactivate();
});

test('kestrel.watch fetches an unknown url via prByUrl', async () => {
  const { w, api } = await boot();
  await ui.commands['kestrel.watch']('https://github.com/acme/api/pull/9');
  await settle(); await settle();
  assert.deepStrictEqual(w.byUrl.map((c) => c[1]), ['https://github.com/acme/api/pull/9']);
  assert.ok(api.tracker.rows().some((r) => r.pr.number === 9));
  ext.deactivate();
});

test('kestrel.refresh runs another round', async () => {
  const { w } = await boot();
  const before = w.listed.length;
  await ui.commands['kestrel.refresh']();
  await settle(); await settle();
  assert.ok(w.listed.length > before);
  ext.deactivate();
});

test('a settings change to kestrel.accounts and a window focus both kick a round', async () => {
  const { w } = await boot();
  let n = w.listed.length;
  ui.setConfig('kestrel.accounts', ['octo-dev']);
  await settle(); await settle();
  assert.ok(w.listed.length > n);
  n = w.listed.length;
  ui.setFocus(false); ui.setFocus(true);
  await settle(); await settle();
  assert.ok(w.listed.length > n);
  ext.deactivate();
});

test('a throwing poller error is logged to the output channel, not swallowed', async () => {
  const w = world();
  w.client.listPrs = async () => { throw new Error('boom'); };
  ui.out.length = 0;
  ext.activate(context(), { run: w.run, client: w.client, timers: w.timers, now: () => w.now });
  await settle(); await settle();
  assert.ok(ui.out.some((l) => l.includes('boom')), ui.out.join('\n'));
  ext.deactivate();
});

test('deactivate stops the poller: no more timers fire a round', async () => {
  const { w, api } = await boot();
  ext.deactivate();
  const n = w.listed.length;
  await api.poller.kick();
  await settle();
  assert.strictEqual(w.listed.length, n);
});

test('hidden urls load from globalState and are written back on change', async () => {
  ui.out.length = 0; ui.commands = {};
  const w = world();
  const ctx = context();
  const u1 = 'https://github.com/acme/widgets/pull/1';
  await ctx.globalState.update('kestrel.hidden', [u1]);
  const api = ext.activate(ctx, { run: w.run, client: w.client, timers: w.timers, now: () => w.now });
  await settle(); await settle();
  assert.strictEqual(api.tracker.rows().find((r) => r.pr.url === u1).hidden, true);
  assert.strictEqual(api.tracker.badge(), 1);
  api.tracker.hide('https://github.com/acme/api/pull/2');
  assert.deepStrictEqual(ctx.globalState.get('kestrel.hidden'), [u1, 'https://github.com/acme/api/pull/2']);
  api.tracker.unhide(u1);
  assert.deepStrictEqual(ctx.globalState.get('kestrel.hidden'), ['https://github.com/acme/api/pull/2']);
  ext.deactivate();
});
