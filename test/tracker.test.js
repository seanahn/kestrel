'use strict';
// Row tracker (design 101, "Events" and the throttling/partial-results bullets under "Polling").
const test = require('node:test'); const assert = require('node:assert');
const { createTracker } = require('../src/tracker');

const pr = (n, o = {}) => ({
  id: `PR_${n}`, url: `https://github.com/acme/widgets/pull/${n}`, number: n, title: `Change ${n}`, repo: 'acme/widgets',
  account: 'octo-dev', isDraft: false, updatedAt: `2026-01-0${n}T00:00:00Z`, headOid: `head${n}`,
  mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: null,
  checks: [{ name: 'test', state: 'success' }], reviews: [], unresolvedThreads: 0,
  mergeMethods: { squash: true, merge: true, rebase: true },
  ...o,
});
const running = (done, o = {}) => ({
  checks: [...Array(done).fill(0).map((_, i) => ({ name: `c${i}`, state: 'success' })),
    ...Array(5 - done).fill(0).map((_, i) => ({ name: `p${i}`, state: 'pending' }))],
  ...o,
});
const conflict = { mergeable: 'CONFLICTING' };
const draft = { isDraft: true };
const T0 = Date.parse('2026-03-01T00:00:00Z');
const make = () => { const clock = { t: T0 }; return { clock, tr: createTracker({ now: () => clock.t }) }; };
const urls = (tr) => tr.rows().map((r) => r.pr.number);
const U = (n) => `https://github.com/acme/widgets/pull/${n}`;
const row = (tr, n) => tr.rows().find((r) => r.pr.number === n);

test('first apply is quiet', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1), pr(2, conflict), pr(3, draft)]);
  assert.deepStrictEqual(urls(tr), [3, 2, 1]);
  assert.strictEqual(tr.badge(), 2);
  assert.ok(tr.rows().every((r) => !r.highlight && r.error === null));
  assert.strictEqual(row(tr, 2).changedAt, Date.parse('2026-01-02T00:00:00Z'));
});

test('state change is an event', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2, running(2)), pr(3)]);
  assert.strictEqual(tr.anyRunning(), true);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1), pr(2, conflict), pr(3)]);
  assert.strictEqual(urls(tr)[0], 2);
  assert.strictEqual(row(tr, 2).highlight, true);
  assert.strictEqual(row(tr, 2).changedAt, clock.t);
  assert.strictEqual(tr.anyRunning(), false);
  assert.strictEqual(tr.badge(), 3);
});

test('progress is not an event', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2, running(3)), pr(3)]);
  const before = urls(tr);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1), pr(2, running(4)), pr(3)]);
  assert.deepStrictEqual(urls(tr), before);
  assert.strictEqual(row(tr, 2).highlight, false);
  assert.strictEqual(row(tr, 2).state.text, 'checks 4/5');
  assert.strictEqual(row(tr, 2).changedAt, Date.parse('2026-01-02T00:00:00Z'));
});

test('change to non-actionable moves without highlight', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2), pr(3)]);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1), pr(2, draft), pr(3)]);
  assert.strictEqual(urls(tr)[0], 2);
  assert.strictEqual(row(tr, 2).highlight, false);
  assert.strictEqual(tr.badge(), 2);
});

test('highlight is cleared when the new state is not actionable, kept when key is unchanged', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1)]);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1, conflict)]);
  assert.strictEqual(row(tr, 1).highlight, true);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1, { ...conflict, title: 'renamed' })]);
  assert.strictEqual(row(tr, 1).highlight, true);
  assert.strictEqual(row(tr, 1).pr.title, 'renamed');
  tr.apply('octo-dev', [pr(1, draft)]);
  assert.strictEqual(row(tr, 1).highlight, false);
});

test('a PR first seen in a later apply is an event if actionable, and ties sort by url', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1)]);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1), pr(2, conflict), pr(3, draft)]);
  assert.deepStrictEqual(urls(tr), [2, 3, 1]);
  assert.strictEqual(row(tr, 2).highlight, true);
  assert.strictEqual(row(tr, 3).highlight, false);
  assert.strictEqual(row(tr, 3).changedAt, clock.t);
});

test('missing PR is removed', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1), pr(2, conflict)]);
  tr.apply('octo-dev', [pr(1)]);
  assert.deepStrictEqual(urls(tr), [1]);
  assert.strictEqual(tr.badge(), 1);
});

test('fail keeps rows', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1, conflict)]);
  tr.fail('octo-dev', 'octo-dev: rate limited');
  assert.deepStrictEqual(urls(tr), [1]);
  assert.strictEqual(tr.badge(), 1);
  assert.deepStrictEqual(tr.notes(), ['octo-dev: rate limited']);
  tr.clearNote('octo-dev');
  assert.deepStrictEqual(tr.notes(), []);
});

test('drop removes only that account', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.apply('octo-work', [pr(2, { account: 'octo-work', url: 'https://github.com/acme/api/pull/2' })]);
  tr.drop('octo-dev', 'octo-dev: gh login expired, run `gh auth login`');
  assert.deepStrictEqual(urls(tr), [2]);
  assert.deepStrictEqual(tr.notes(), ['octo-dev: gh login expired, run `gh auth login`']);
});

test('apply for one account never touches another', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.apply('octo-work', [pr(2, { account: 'octo-work' })]);
  tr.apply('octo-work', []);
  assert.deepStrictEqual(urls(tr), [1]);
});

test('notes: global first, then accounts in insertion order', () => {
  const { tr } = make();
  tr.fail('octo-work', 'w');
  tr.fail('octo-dev', 'd');
  tr.fail('octo-work', 'w2');
  tr.setGlobalNote('g');
  assert.deepStrictEqual(tr.notes(), ['g', 'w2', 'd']);
  tr.setGlobalNote(null);
  assert.deepStrictEqual(tr.notes(), ['w2', 'd']);
});

test('markSeen clears highlight', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1)]);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1, conflict)]);
  tr.markSeen(row(tr, 1).pr.url);
  assert.strictEqual(row(tr, 1).highlight, false);
  assert.strictEqual(row(tr, 1).changedAt, clock.t);
});

test('remove and setError; error clears on the next apply', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.setError(pr(1).url, 'merge refused');
  assert.strictEqual(row(tr, 1).error, 'merge refused');
  tr.apply('octo-dev', [pr(1), pr(2)]);
  assert.strictEqual(row(tr, 1).error, null);
  tr.remove(pr(2).url);
  assert.deepStrictEqual(urls(tr), [1]);
});

test('onChange fires once per mutation that changed something', () => {
  const { tr, clock } = make();
  let n = 0;
  tr.onChange(() => { n++; });
  tr.apply('octo-dev', [pr(1), pr(2)]);
  assert.strictEqual(n, 1);
  tr.apply('octo-dev', [pr(1), pr(2)]);
  assert.strictEqual(n, 1);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1, conflict), pr(2)]);
  assert.strictEqual(n, 2);
  tr.markSeen(pr(2).url);
  assert.strictEqual(n, 2);
  tr.markSeen(pr(1).url);
  assert.strictEqual(n, 3);
  tr.fail('octo-dev', 'x'); assert.strictEqual(n, 4);
  tr.fail('octo-dev', 'x'); assert.strictEqual(n, 4);
  tr.clearNote('octo-dev'); assert.strictEqual(n, 5);
  tr.clearNote('octo-dev'); assert.strictEqual(n, 5);
  tr.setGlobalNote('g'); assert.strictEqual(n, 6);
  tr.setGlobalNote('g'); assert.strictEqual(n, 6);
  tr.setError(pr(1).url, 'e'); assert.strictEqual(n, 7);
  tr.setError(pr(1).url, 'e'); assert.strictEqual(n, 7);
  tr.remove(pr(1).url); assert.strictEqual(n, 8);
  tr.remove(pr(1).url); assert.strictEqual(n, 8);
  tr.drop('octo-dev', 'gone'); assert.strictEqual(n, 9);
});

test('hide removes from badge', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1, conflict), pr(2)]);
  assert.strictEqual(tr.badge(), 2);
  tr.hide(U(1));
  assert.strictEqual(tr.badge(), 1);
  assert.strictEqual(row(tr, 1).hidden, true);
  assert.strictEqual(row(tr, 2).hidden, false);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
  tr.unhide(U(1));
  assert.strictEqual(tr.badge(), 2);
  assert.strictEqual(row(tr, 1).hidden, false);
});

test('hidden row never highlights on state change', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.hide(U(1));
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1, conflict), pr(2, conflict)]);
  assert.strictEqual(row(tr, 1).highlight, false);
  assert.strictEqual(row(tr, 2).highlight, true);
  assert.strictEqual(row(tr, 1).changedAt, clock.t);
});

test('hiding a highlighted row clears its highlight', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.apply('octo-dev', [pr(1, conflict)]);
  assert.strictEqual(row(tr, 1).highlight, true);
  tr.hide(U(1));
  assert.strictEqual(row(tr, 1).highlight, false);
});

test('apply prunes hidden url when PR gone', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.hide(U(1));
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), []);
});

test('drop keeps hidden url', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.hide(U(1));
  tr.drop('octo-dev', 'login expired');
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
  tr.fail('octo-dev', 'x');
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
});

test('remove prunes', () => {
  const { tr } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.hide(U(1));
  tr.remove(U(1));
  assert.deepStrictEqual(tr.hiddenUrls(), []);
});

test('setHidden fires no onChange', () => {
  const { tr } = make();
  let n = 0, h = 0;
  tr.onChange(() => n++); tr.onHiddenChange(() => h++);
  tr.setHidden([U(1)]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
  assert.deepStrictEqual([n, h], [0, 0]);
  tr.apply('octo-dev', [pr(1)]);
  assert.strictEqual(row(tr, 1).hidden, true);
});

test('onHiddenChange reports urls; hide/unhide fire onChange once, no-ops never', () => {
  const { tr } = make();
  const seen = []; let n = 0;
  tr.onChange(() => n++); tr.onHiddenChange((u) => seen.push(u));
  tr.apply('octo-dev', [pr(1), pr(2)]);
  n = 0;
  tr.hide(U(1)); tr.hide(U(1)); tr.hide(U(2)); tr.unhide(U(1)); tr.unhide(U(1));
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(seen, [[U(1)], [U(1), U(2)], [U(2)]]);
  tr.apply('octo-dev', [pr(1)]);
  assert.deepStrictEqual(seen[3], []);
});

test('the poll note has its own slot, before the global note and account notes', () => {
  const { tr } = make();
  tr.fail('octo-dev', 'd');
  tr.setGlobalNote('g');
  tr.setPollNote('GitHub is throttling, retrying');
  assert.deepStrictEqual(tr.notes(), ['GitHub is throttling, retrying', 'g', 'd']);
  tr.setGlobalNote(null);
  assert.deepStrictEqual(tr.notes(), ['GitHub is throttling, retrying', 'd'], 'clearing the global note keeps the poll note');
  tr.setPollNote(null);
  assert.deepStrictEqual(tr.notes(), ['d']);
});

test('drop with no note clears the account note; a dropped account coming back is a quiet first apply', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.fail('octo-dev', 'x');
  tr.drop('octo-dev', '');
  assert.deepStrictEqual(tr.notes(), []);
  clock.t += 1000;
  tr.apply('octo-dev', [pr(1, conflict), pr(2, conflict)]);
  assert.ok(tr.rows().every((r) => !r.highlight), 'no burst of events on recovery');
  assert.strictEqual(row(tr, 1).changedAt, Date.parse(pr(1).updatedAt));
});
