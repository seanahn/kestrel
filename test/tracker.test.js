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

const H = 3600000;

test('a hidden PR missing from one successful round is still hidden after it returns', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.hide(U(1));
  clock.t += 1000;
  tr.apply('octo-dev', [pr(2)]);
  assert.strictEqual(row(tr, 1), undefined, 'its row is dropped while missing');
  tr.apply('octo-dev', [pr(1), pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
  assert.strictEqual(row(tr, 1).hidden, true);
});

test('a hidden PR stays in hiddenUrls while missing under 24 hours', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.hide(U(1));
  tr.apply('octo-dev', [pr(2)]);
  clock.t += 24 * H - 1;
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
});

test('a hidden PR missing for 24 hours is pruned', () => {
  const { tr, clock } = make();
  const seen = [];
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.hide(U(1));
  tr.onHiddenChange((u) => seen.push(u));
  tr.apply('octo-dev', [pr(2)]);
  clock.t += 24 * H;
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), []);
  assert.deepStrictEqual(seen.at(-1), []);
});

test('seeing a missing hidden PR again resets the 24 hour clock', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.hide(U(1));
  tr.apply('octo-dev', [pr(2)]);
  clock.t += 20 * H;
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.apply('octo-dev', [pr(2)]);
  clock.t += 20 * H;
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
  clock.t += 4 * H;
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), []);
});

test('missing is judged per account: another account\'s round does not count', () => {
  const { tr, clock } = make();
  tr.apply('octo-dev', [pr(1)]);
  tr.hide(U(1));
  tr.apply('octo-dev', []);
  clock.t += 25 * H;
  tr.apply('octo-work', []);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)]);
});

test('the old stored format (array of strings) loads as present; entries round-trip', () => {
  const { tr, clock } = make();
  tr.setHidden([U(1), { url: U(2), missingSince: T0 - 5, account: 'octo-dev' }]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1), U(2)]);
  assert.deepStrictEqual(tr.hiddenEntries(), [
    { url: U(1), missingSince: null, account: null },
    { url: U(2), missingSince: T0 - 5, account: 'octo-dev' },
  ]);
  tr.apply('octo-dev', [pr(1)]);
  assert.strictEqual(row(tr, 1).hidden, true);
  assert.deepStrictEqual(tr.hiddenEntries()[0], { url: U(1), missingSince: null, account: 'octo-dev' });
  assert.deepStrictEqual(tr.hiddenMissing(), [{ url: U(2), account: 'octo-dev' }]);
});

test('missingSince changes are reported to onHiddenChange so they persist', () => {
  const { tr } = make();
  const seen = [];
  tr.apply('octo-dev', [pr(1)]);
  tr.hide(U(1));
  tr.onHiddenChange((u, e) => seen.push(e));
  tr.apply('octo-dev', []);
  assert.strictEqual(seen.at(-1)[0].missingSince, T0);
  tr.apply('octo-dev', [pr(1)]);
  assert.strictEqual(seen.at(-1)[0].missingSince, null);
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
  assert.deepStrictEqual(seen[3], [U(2)], 'missing from a list keeps the hide (and persists missingSince)');
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

test('a migrated hide (no account) never starts or advances the clock from a list that lacks it', () => {
  const { tr, clock } = make();
  tr.setHidden([U(1)]);
  tr.apply('octo-dev', [pr(2)]);
  assert.strictEqual(tr.hiddenEntries()[0].missingSince, null);
  clock.t += 48 * H;
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)], 'never pruned by time');
  assert.deepStrictEqual(tr.hiddenMissing(), [{ url: U(1), account: null }], 'still due for a by-URL check');
});

test('a migrated hide is adopted by the account whose list returns it, whatever the round order', () => {
  const { tr, clock } = make();
  tr.setHidden([U(1)]);
  tr.apply('octo-dev', [pr(2)]);                      // the other account's list comes first
  tr.apply('octo-work', [pr(1, { account: 'octo-work' })]);
  assert.deepStrictEqual(tr.hiddenEntries(), [{ url: U(1), missingSince: null, account: 'octo-work' }]);
  clock.t += 30 * H;
  tr.apply('octo-dev', [pr(2)]);
  assert.deepStrictEqual(tr.hiddenUrls(), [U(1)], 'octo-dev lists never judge it');
  tr.apply('octo-work', []);
  clock.t += 24 * H;
  tr.apply('octo-work', []);
  assert.deepStrictEqual(tr.hiddenUrls(), [], 'once adopted, its own account judges it');
});

test('onLeft reports rows a complete result no longer has, with their account; not for drop, fail or remove', () => {
  const tr = createTracker({ now: () => 1000 });
  const left = [];
  tr.onLeft((rows) => left.push(...rows.map((r) => [r.pr.url, r.pr.account])));
  tr.apply('octo-dev', [pr(1), pr(2)]);
  tr.apply('octo-dev', [pr(1)]);
  assert.deepStrictEqual(left, [[pr(2).url, 'octo-dev']]);
  tr.fail('octo-dev', 'x');
  tr.remove(pr(1).url);
  tr.apply('octo-work', [pr(3, { account: 'octo-work' })]);
  tr.drop('octo-work', 'expired');
  assert.deepStrictEqual(left, [[pr(2).url, 'octo-dev']]);
});
