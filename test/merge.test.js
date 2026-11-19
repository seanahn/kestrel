'use strict';
// Merging (design 101, "Merging").
const test = require('node:test'); const assert = require('node:assert');
const { install } = require('./vscodeStub');
const { createMerger, pickMethod, METHOD_LABEL } = require('../src/merge');
const { createTracker } = require('../src/tracker');
const { GitHubError } = require('../src/github');

const URL = 'https://github.com/acme/widgets/pull/7';
const pr = (o = {}) => ({
  id: 'PR_7', url: URL, number: 7, title: 'Add widget', repo: 'acme/widgets', account: 'octo-work', isDraft: false,
  updatedAt: '2026-01-01T00:00:00Z', headOid: 'abc123', mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: null,
  checks: [], reviews: [], unresolvedThreads: 0, mergeMethods: { squash: true, merge: true, rebase: false }, ...o,
});

function setup({ prOver = {}, mergeImpl, tokenFor, preferred = 'squash' } = {}) {
  const { vscode, ui } = install();
  const tracker = createTracker({ now: () => 1000 });
  tracker.apply('octo-work', [pr(prOver)]);
  const calls = { merge: [], poll: 0, busy: 0 };
  const client = { merge: async (token, spec) => { calls.merge.push([token, spec]); return mergeImpl ? mergeImpl() : undefined; } };
  const merger = createMerger({
    vscode, client, tracker, pollNow: () => { calls.poll++; }, preferred: () => preferred,
    tokenFor: tokenFor || (async (login) => `tok-${login}`), onBusyChange: () => { calls.busy++; },
  });
  return { ui, tracker, calls, merger };
}
const errOf = (t) => t.rows()[0].error;

test('pickMethod table', () => {
  const all = { squash: true, merge: true, rebase: true };
  assert.strictEqual(pickMethod(all, 'squash'), 'SQUASH');
  assert.strictEqual(pickMethod(all, 'rebase'), 'REBASE');
  assert.strictEqual(pickMethod({ squash: false, merge: true, rebase: true }, 'squash'), 'MERGE');
  assert.strictEqual(pickMethod({ squash: false, merge: false, rebase: true }, 'merge'), 'REBASE');
  assert.strictEqual(pickMethod({ squash: false, merge: false, rebase: false }, 'squash'), null);
  assert.strictEqual(METHOD_LABEL.SQUASH, 'Squash and merge');
  assert.strictEqual(METHOD_LABEL.MERGE, 'Create a merge commit');
  assert.strictEqual(METHOD_LABEL.REBASE, 'Rebase and merge');
});

test('cancel does nothing', async () => {
  const { ui, calls, merger, tracker } = setup();
  ui.answer = () => undefined;
  assert.strictEqual(await merger.merge(URL), 'cancelled');
  assert.strictEqual(calls.merge.length, 0);
  assert.strictEqual(tracker.rows().length, 1);
  assert.strictEqual(merger.busy(URL), false);
});

test('confirm merges with expectedHeadOid and the row\'s account token', async () => {
  const { ui, calls, merger, tracker } = setup();
  let asked;
  ui.answer = (msg, opts, ...items) => { asked = [msg, opts, items]; return items[0]; };
  assert.strictEqual(await merger.merge(URL), 'merged');
  assert.deepStrictEqual(asked, ['Merge acme/widgets#7 "Add widget"?', { modal: true }, ['Squash and merge']]);
  assert.deepStrictEqual(calls.merge, [['tok-octo-work', { id: 'PR_7', method: 'SQUASH', expectedHeadOid: 'abc123' }]]);
  assert.strictEqual(tracker.rows().length, 0);
  assert.strictEqual(merger.busy(URL), false);
});

test('second click while busy', async () => {
  let release;
  const { ui, calls, merger } = setup({ mergeImpl: () => new Promise((r) => { release = r; }) });
  ui.answer = (m, o, ...items) => items[0];
  const first = merger.merge(URL);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(merger.busy(URL), true);
  assert.strictEqual(await merger.merge(URL), 'busy');
  release();
  assert.strictEqual(await first, 'merged');
  assert.strictEqual(calls.merge.length, 1);
  assert.strictEqual(calls.busy, 2);
});

test('gone when the row is missing', async () => {
  const { merger } = setup();
  assert.strictEqual(await merger.merge('https://github.com/acme/widgets/pull/99'), 'gone');
});

test('refused shows message', async () => {
  const { ui, merger, tracker, calls } = setup({ mergeImpl: async () => { throw new GitHubError('refused', 'Head branch was modified'); } });
  ui.answer = (m, o, ...items) => items[0];
  assert.strictEqual(await merger.merge(URL), 'refused');
  assert.strictEqual(errOf(tracker), 'Head branch was modified');
  assert.strictEqual(calls.poll, 0);
});

test('network error is unconfirmed and polls', async () => {
  const { ui, merger, tracker, calls } = setup({ mergeImpl: async () => { throw new Error('socket hang up'); } });
  ui.answer = (m, o, ...items) => items[0];
  assert.strictEqual(await merger.merge(URL), 'unconfirmed');
  assert.strictEqual(errOf(tracker), 'Merge not confirmed: socket hang up');
  assert.strictEqual(calls.poll, 1);
  assert.strictEqual(calls.merge.length, 1);
  assert.strictEqual(merger.busy(URL), false);
});

test('token failure is unconfirmed', async () => {
  const { ui, merger, tracker, calls } = setup({ tokenFor: async () => { throw new Error('gh login expired'); } });
  ui.answer = (m, o, ...items) => items[0];
  assert.strictEqual(await merger.merge(URL), 'unconfirmed');
  assert.strictEqual(errOf(tracker), 'Merge not confirmed: gh login expired');
  assert.strictEqual(calls.poll, 1);
  assert.strictEqual(calls.merge.length, 0);
});

test('missing head commit is refused before GitHub is called', async () => {
  const { ui, merger, tracker, calls } = setup({ prOver: { headOid: '' } });
  ui.answer = (m, o, ...items) => items[0];
  assert.strictEqual(await merger.merge(URL), 'refused');
  assert.strictEqual(errOf(tracker), 'Merge not confirmed: missing head commit');
  assert.strictEqual(calls.merge.length, 0);
});

test('no usable merge method is refused', async () => {
  const { merger, tracker, calls } = setup({ prOver: { mergeMethods: { squash: false, merge: false, rebase: false } } });
  assert.strictEqual(await merger.merge(URL), 'refused');
  assert.strictEqual(errOf(tracker), 'This repo allows no merge method kestrel can use');
  assert.strictEqual(calls.merge.length, 0);
});
