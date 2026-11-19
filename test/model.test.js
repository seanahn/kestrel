'use strict';
// Row state (design 101, "States").
const test = require('node:test'); const assert = require('node:assert');
const { rowState, ACTIONABLE_RULES } = require('../src/model');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const summary = (blockers, findings, oid = 'head1') => ({
  body: `ok\n<!-- pr-auto-review-findings: ${b64(JSON.stringify({ blockers: Array(blockers).fill(0), findings: Array(findings).fill(0) }))} -->`,
  commitOid: oid,
  submittedAt: '2026-01-02T00:00:00Z',
});
const pr = (o = {}) => ({
  id: 'PR_1', url: 'https://github.com/acme/widgets/pull/42', number: 42, title: 'Add widget', repo: 'acme/widgets',
  account: 'octo-dev', isDraft: false, updatedAt: '2026-01-01T00:00:00Z', headOid: 'head1',
  mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: null,
  checks: [{ name: 'test', state: 'success' }], reviews: [], unresolvedThreads: 0,
  mergeMethods: { squash: true, merge: true, rebase: true },
  ...o,
});
const ref = 'acme/widgets#42';
const url = 'https://github.com/acme/widgets/pull/42';
const prompt = (p) => ({ kind: 'prompt', prompt: p });

test('state table', () => {
  const cases = [
    [1, pr({ isDraft: true }), 'draft', 'dim', prompt(`PR ${ref} is a draft; check whether it is ready to mark ready for review (${url})`)],
    [2, pr({ mergeable: 'CONFLICTING' }), 'conflicts', 'red', prompt(`resolve the merge conflicts on PR ${ref} (${url})`)],
    [3, pr({ checks: [{ name: 'test', state: 'failure' }] }), 'CI failed: test', 'red', prompt(`check the failing \`test\` check on PR ${ref} (${url})`)],
    [3, pr({ checks: [{ name: 'test', state: 'failure' }, { name: 'lint', state: 'failure' }, { name: 'a', state: 'success' }] }), 'CI failed: test and 1 more', 'red', prompt(`check the failing \`test\` check on PR ${ref} (${url})`)],
    [4, pr({ reviews: [summary(1, 0)] }), '1 blocker', 'red', prompt(`check the blocker comments on PR ${ref} (${url})`)],
    [4, pr({ reviews: [summary(2, 0)] }), '2 blockers', 'red', prompt(`check the blocker comments on PR ${ref} (${url})`)],
    [5, pr({ reviewDecision: 'CHANGES_REQUESTED' }), 'changes requested', 'red', prompt(`check the requested changes on PR ${ref} (${url})`)],
    [6, pr({ checks: [{ name: 'a', state: 'success' }, { name: 'b', state: 'pending' }, { name: 'c', state: 'pending' }] }), 'checks 1/3', 'running', null],
    [6, pr({ mergeable: 'UNKNOWN', checks: [] }), 'waiting for GitHub', 'running', null],
    [6, pr({ mergeState: 'UNKNOWN' }), 'checks 1/1', 'running', null],
    [7, pr({ mergeState: 'BEHIND' }), 'behind base', 'red', { kind: 'update', prompt: `update PR ${ref} with its base branch (${url})` }],
    [8, pr({ mergeState: 'BLOCKED' }), 'blocked', 'dim', { kind: 'open' }],
    [8, pr({ mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }), 'blocked: needs review', 'dim', { kind: 'open' }],
    [8, pr({ mergeState: 'DIRTY' }), 'blocked', 'dim', { kind: 'open' }],
    [9, pr(), 'merge', 'green', { kind: 'merge' }],
    [9, pr({ mergeState: 'UNSTABLE' }), 'merge', 'green', { kind: 'merge' }],
    [9, pr({ mergeState: 'HAS_HOOKS' }), 'merge', 'green', { kind: 'merge' }],
  ];
  for (const [rule, p, text, dot, action] of cases) {
    const s = rowState(p);
    assert.strictEqual(s.rule, rule, text);
    assert.strictEqual(s.text, text);
    assert.strictEqual(s.dot, dot, text);
    assert.deepStrictEqual(s.action, action, text);
  }
});

test('failure beats running', () => {
  assert.strictEqual(rowState(pr({ checks: [{ name: 'test', state: 'failure' }, { name: 'lint', state: 'pending' }] })).rule, 3);
});

test('conflict beats failure', () => {
  assert.strictEqual(rowState(pr({ mergeable: 'CONFLICTING', checks: [{ name: 'test', state: 'failure' }] })).rule, 2);
});

test('draft beats everything', () => {
  assert.strictEqual(rowState(pr({ isDraft: true, mergeable: 'CONFLICTING' })).rule, 1);
});

test('stale summary ignored', () => {
  const s = rowState(pr({ reviews: [summary(2, 3, 'old')] }));
  assert.strictEqual(s.rule, 9);
  assert.strictEqual(s.extra, null);
});

test('no checks at all is mergeable', () => {
  assert.strictEqual(rowState(pr({ checks: [] })).rule, 9);
});

test('progress is not part of the key', () => {
  const mk = (done) => pr({ checks: [...Array(done).fill({ name: 'a', state: 'success' }), ...Array(5 - done).fill({ name: 'b', state: 'pending' })] });
  const a = rowState(mk(3)); const b = rowState(mk(4));
  assert.strictEqual(a.text, 'checks 3/5');
  assert.strictEqual(b.text, 'checks 4/5');
  assert.strictEqual(a.key, b.key);
});

test('key differs with rule or reason', () => {
  const f = (name) => rowState(pr({ checks: [{ name, state: 'failure' }] })).key;
  assert.notStrictEqual(f('test'), f('lint'));
  assert.notStrictEqual(rowState(pr({ reviews: [summary(1, 0)] })).key, rowState(pr({ reviews: [summary(2, 0)] })).key);
  assert.notStrictEqual(rowState(pr()).key, rowState(pr({ mergeState: 'BEHIND' })).key);
  assert.strictEqual(typeof rowState(pr()).key, 'string');
});

test('findings ride on merge', () => {
  const s = rowState(pr({ reviews: [summary(0, 3)] }));
  assert.strictEqual(s.rule, 9);
  assert.deepStrictEqual(s.extra, { text: '3 findings', prompt: `check the findings on PR ${ref} (${url})` });
  assert.strictEqual(rowState(pr({ reviews: [summary(0, 1)] })).extra.text, '1 finding');
});

test('unresolved fallback', () => {
  const s = rowState(pr({ unresolvedThreads: 1 }));
  assert.deepStrictEqual(s.extra, { text: '1 unresolved comment', prompt: `check the unresolved review comments on PR ${ref} (${url})` });
  assert.strictEqual(rowState(pr({ unresolvedThreads: 2 })).extra.text, '2 unresolved comments');
});

test('unresolved ignored when a summary is on head', () => {
  assert.strictEqual(rowState(pr({ reviews: [summary(0, 0)], unresolvedThreads: 4 })).extra, null);
});

test('extra is null for draft, blockers and running', () => {
  assert.strictEqual(rowState(pr({ isDraft: true, unresolvedThreads: 2 })).extra, null);
  assert.strictEqual(rowState(pr({ reviews: [summary(1, 2)], unresolvedThreads: 2 })).extra, null);
  assert.strictEqual(rowState(pr({ mergeState: 'UNKNOWN', unresolvedThreads: 2 })).extra, null);
});

test('extra on other rules', () => {
  assert.strictEqual(rowState(pr({ mergeState: 'BEHIND', unresolvedThreads: 2 })).extra.text, '2 unresolved comments');
});

test('actionable is true exactly for ACTIONABLE_RULES', () => {
  assert.deepStrictEqual(ACTIONABLE_RULES, [2, 3, 4, 5, 7, 9]);
  const prs = [pr({ isDraft: true }), pr({ mergeable: 'CONFLICTING' }), pr({ checks: [{ name: 't', state: 'failure' }] }),
    pr({ reviews: [summary(1, 0)] }), pr({ reviewDecision: 'CHANGES_REQUESTED' }), pr({ checks: [{ name: 't', state: 'pending' }] }),
    pr({ mergeState: 'BEHIND' }), pr({ mergeState: 'BLOCKED' }), pr()];
  prs.forEach((p, i) => {
    const s = rowState(p);
    assert.strictEqual(s.rule, i + 1);
    assert.strictEqual(s.actionable, ACTIONABLE_RULES.includes(s.rule));
  });
});
