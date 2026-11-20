'use strict';
// Updating a PR branch from its base in place (design 101, "Updating a branch").
const test = require('node:test'); const assert = require('node:assert');
const { install } = require('./vscodeStub');
const { createMerger } = require('../src/merge');
const { createTracker } = require('../src/tracker');
const { GitHubError } = require('../src/github');

const URL = 'https://github.com/acme/widgets/pull/7';
const pr = (o = {}) => ({
  id: 'PR_7', url: URL, number: 7, title: 'Add widget', repo: 'acme/widgets', account: 'octo-work', isDraft: false,
  updatedAt: '2026-01-01T00:00:00Z', headOid: 'abc123', mergeable: 'MERGEABLE', mergeState: 'BEHIND', reviewDecision: null,
  checks: [], reviews: [], unresolvedThreads: 0, mergeMethods: { squash: true, merge: true, rebase: false }, ...o,
});

function setup({ impl, tokenFor } = {}) {
  const { vscode, ui } = install();
  const tracker = createTracker({ now: () => 1000 });
  tracker.apply('octo-work', [pr()]);
  const calls = { update: [], poll: 0, busy: 0, updated: [] };
  const client = { updateBranch: async (token, spec) => { calls.update.push([token, spec]); return impl ? impl() : undefined; } };
  const merger = createMerger({
    vscode, client, tracker, pollNow: () => { calls.poll++; }, preferred: () => 'squash',
    tokenFor: tokenFor || (async (login) => `tok-${login}`), onBusyChange: () => { calls.busy++; },
    onUpdated: (u) => calls.updated.push(u),
  });
  return { ui, tracker, calls, merger };
}

test('update asks no confirm and updates with the row account token and head commit', async () => {
  const { ui, calls, merger, tracker } = setup();
  let asked = 0; ui.answer = () => { asked++; };
  assert.strictEqual(await merger.update(URL), 'updated');
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(calls.update, [['tok-octo-work', { id: 'PR_7', expectedHeadOid: 'abc123' }]]);
  assert.deepStrictEqual(calls.updated, [URL]);
  assert.strictEqual(calls.poll, 1);
  assert.strictEqual(tracker.rows()[0].error, null);
  assert.strictEqual(merger.updateFailed(URL), false);
});

test('busy while updating, with its own kind', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { calls, merger } = setup({ impl: () => gate });
  const p = merger.update(URL);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(merger.busy(URL), true);
  assert.strictEqual(merger.busyKind(URL), 'update');
  assert.strictEqual(await merger.update(URL), 'busy');
  assert.strictEqual(await merger.merge(URL), 'busy');
  release(); assert.strictEqual(await p, 'updated');
  assert.strictEqual(merger.busy(URL), true, 'accepted, but no poll has shown the new head yet');
  assert.strictEqual(merger.busyKind(URL), 'update');
  assert.strictEqual(calls.busy, 2);
  assert.strictEqual(calls.update.length, 1);
});

test('a refusal shows GitHub message and switches the row to the agent prompt until the head moves', async () => {
  const { calls, merger, tracker } = setup({ impl: () => { throw new GitHubError('refused', 'merge conflict between base and head'); } });
  assert.strictEqual(await merger.update(URL), 'refused');
  assert.strictEqual(tracker.rows()[0].error, 'merge conflict between base and head');
  assert.strictEqual(merger.updateFailed(URL), true);
  assert.strictEqual(calls.poll, 0);
  tracker.apply('octo-work', [pr({ headOid: 'def456' })]);
  assert.strictEqual(merger.updateFailed(URL), false, 'a new head commit gets a fresh try');
});

test('an unconfirmed update is never retried, and polls', async () => {
  const { calls, merger, tracker } = setup({ impl: () => { throw new GitHubError('offline', 'socket hang up'); } });
  assert.strictEqual(await merger.update(URL), 'unconfirmed');
  assert.strictEqual(tracker.rows()[0].error, 'Update not confirmed: socket hang up');
  assert.strictEqual(calls.update.length, 1);
  assert.strictEqual(calls.poll, 1);
  assert.strictEqual(merger.updateFailed(URL), false);
});

test('update only from a behind-base row, and never without a head commit', async () => {
  const a = setup();
  a.tracker.apply('octo-work', [pr({ mergeState: 'CLEAN' })]);
  assert.strictEqual(await a.merger.update(URL), 'changed');
  assert.strictEqual(a.calls.update.length, 0);
  const b = setup();
  b.tracker.apply('octo-work', [pr({ headOid: '' })]);
  assert.strictEqual(await b.merger.update(URL), 'refused');
  assert.strictEqual(b.calls.update.length, 0);
  const c = setup();
  assert.strictEqual(await c.merger.update('https://github.com/acme/widgets/pull/999'), 'gone');
});

test('after a successful update the row stays busy until a poll shows the new head, at most 2 minutes', async () => {
  const { vscode } = install();
  let t = 1000;
  const tracker = createTracker({ now: () => t });
  tracker.apply('octo-work', [pr()]);
  let changes = 0; const timers = [];
  const merger = createMerger({
    vscode, client: { updateBranch: async () => {} }, tracker, pollNow: () => {}, preferred: () => 'squash',
    tokenFor: async () => 'tok', onBusyChange: () => { changes++; }, now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  assert.strictEqual(await merger.update(URL), 'updated');
  assert.strictEqual(merger.busy(URL), true, 'still updating until GitHub shows the new commit');
  assert.strictEqual(merger.busyKind(URL), 'update');
  assert.strictEqual(await merger.update(URL), 'busy', 'no second update meanwhile');
  tracker.apply('octo-work', [pr()]);
  assert.strictEqual(merger.busy(URL), true, 'a poll with the same head: still updating');
  tracker.apply('octo-work', [pr({ headOid: 'merged-base-in', mergeState: 'BLOCKED' })]);
  assert.strictEqual(merger.busy(URL), false, 'the new head arrived');
  assert.strictEqual(merger.busyKind(URL), null);

  // the cap: GitHub never shows a new head
  tracker.apply('octo-work', [pr({ headOid: 'h2', mergeState: 'BEHIND' })]);
  assert.strictEqual(await merger.update(URL), 'updated');
  assert.strictEqual(merger.busy(URL), true);
  const cap = timers[timers.length - 1];
  assert.strictEqual(cap.ms, 120000);
  t += 120000;
  const before = changes;
  cap.fn();
  assert.strictEqual(merger.busy(URL), false);
  assert.strictEqual(changes, before + 1, 'the panel redraws when the cap ends it');
});
