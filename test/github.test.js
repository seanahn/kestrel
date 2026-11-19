'use strict';
// GitHub GraphQL client (design 101, "The query" and "Polling"); a fake request, never the network.
const test = require('node:test'); const assert = require('node:assert');
const { createClient, GitHubError, normalizeChecks } = require('../src/github');
const page1 = require('./fixtures/list-page1.json');
const page2 = require('./fixtures/list-page2.json');
const detail = require('./fixtures/detail-pr.json');

/** A fake request that records calls and answers from a queue (or a function). */
function fake(...answers) {
  const calls = [];
  const request = async (token, body) => {
    calls.push({ token, body });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    const r = typeof a === 'function' ? a(body) : a;
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, request };
}
const ok = (json, headers = {}) => ({ status: 200, headers, json });
const fail = (status, json = null, headers = {}) => ({ status, headers, json });
const kindOf = (kind, extra = {}) => (e) => e instanceof GitHubError && e.kind === kind
  && Object.entries(extra).every(([k, v]) => e[k] === v);

test('listPrs maps fixture fields to ListItem and sends the search query', async () => {
  const f = fake(ok({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [page1.data.search.nodes[1]] }, rateLimit: page1.data.rateLimit } }));
  const r = await createClient({ request: f.request }).listPrs('tok');
  assert.deepStrictEqual(r.items, [{
    id: 'PR_2', url: 'https://github.com/acme/api/pull/2', updatedAt: '2026-01-02T00:00:00Z', headOid: 'oid2',
    mergeable: 'UNKNOWN', mergeState: 'UNKNOWN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', rollup: null,
  }]);
  assert.deepStrictEqual(r.rateLimit, { remaining: 4990, resetAt: '2026-01-01T01:00:00Z', cost: 1 });
  assert.strictEqual(f.calls[0].token, 'tok');
  assert.strictEqual(f.calls[0].body.variables.q, 'is:pr is:open author:@me archived:false');
  assert.match(f.calls[0].body.query, /first: 50/);
  assert.match(f.calls[0].body.query, /rateLimit \{ remaining resetAt cost \}/);
});

test('paginates search', async () => {
  const f = fake(ok(page1), ok(page2));
  const r = await createClient({ request: f.request }).listPrs('tok');
  assert.deepStrictEqual(r.items.map((i) => i.id), ['PR_1', 'PR_2', 'PR_3']);
  assert.strictEqual(r.items[0].rollup, 'SUCCESS');
  assert.strictEqual(r.items[2].rollup, null);
  assert.strictEqual(f.calls.length, 2);
  assert.ok(!f.calls[0].body.variables.after);
  assert.strictEqual(f.calls[1].body.variables.after, 'CUR1');
  assert.strictEqual(r.rateLimit.remaining, 4989);
  assert.strictEqual(r.rateLimit.cost, 2);
});

test('listPrs stops after 4 pages', async () => {
  const f = fake(ok(page1));
  const r = await createClient({ request: f.request }).listPrs('tok');
  assert.strictEqual(f.calls.length, 4);
  assert.strictEqual(r.items.length, 8);
});

test('detailPrs batches 20 and maps one PR to the exact Pr', async () => {
  const f = fake((body) => ok({ data: { nodes: body.variables.ids.length === 20 ? [detail.data.nodes[0]] : [null, null, null, null, null], rateLimit: detail.data.rateLimit || { remaining: 4900, resetAt: 'r', cost: 1 } } }));
  const ids = Array.from({ length: 25 }, (_, i) => `PR_${i}`);
  const r = await createClient({ request: f.request }).detailPrs('tok', ids);
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(f.calls[0].body.variables.ids.length, 20);
  assert.strictEqual(f.calls[1].body.variables.ids.length, 5);
  assert.deepStrictEqual(r.prs, [{
    id: 'PR_7', url: 'https://github.com/acme/widgets/pull/7', number: 7, title: 'Add widget', repo: 'acme/widgets', account: '',
    isDraft: false, updatedAt: '2026-01-05T00:00:00Z', headOid: 'head7', mergeable: 'MERGEABLE', mergeState: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    checks: [{ name: 'test', state: 'success' }, { name: 'ci/legacy', state: 'pending' }],
    reviews: [
      { body: 'looks fine', commitOid: 'head7', submittedAt: '2026-01-05T00:01:00Z' },
      { body: '', commitOid: null, submittedAt: '2026-01-05T00:02:00Z' },
    ],
    unresolvedThreads: 2,
    mergeMethods: { squash: true, merge: false, rebase: true },
  }]);
  assert.strictEqual(r.rateLimit.cost, 2);
  assert.deepStrictEqual((await createClient({ request: fake(ok(page1)).request }).detailPrs('tok', [])).prs, []);
});

test('prByUrl uses resource(url:) and returns a Pr or null', async () => {
  const f = fake(ok({ data: { resource: detail.data.nodes[0], rateLimit: { remaining: 1, resetAt: 'r', cost: 1 } } }));
  const c = createClient({ request: f.request });
  const pr = await c.prByUrl('tok', 'https://github.com/acme/widgets/pull/7');
  assert.strictEqual(pr.number, 7);
  assert.strictEqual(pr.account, '');
  assert.strictEqual(f.calls[0].body.variables.url, 'https://github.com/acme/widgets/pull/7');
  assert.match(f.calls[0].body.query, /resource\(url:/);
  for (const resource of [null, { __typename: 'Issue' }, {}]) {
    const g = fake(ok({ data: { resource, rateLimit: { remaining: 1, resetAt: 'r', cost: 1 } } }));
    assert.strictEqual(await createClient({ request: g.request }).prByUrl('tok', 'https://github.com/acme/widgets/issues/1'), null);
  }
});

test('normalizes status contexts', () => {
  assert.deepStrictEqual(normalizeChecks([
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'ci/other', state: 'PENDING' },
    { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' },
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
  ]).map((c) => c.state), ['failure', 'pending', 'pending', 'failure']);
  assert.deepStrictEqual(normalizeChecks([
    { __typename: 'StatusContext', context: 'a', state: 'EXPECTED' },
    { __typename: 'StatusContext', context: 'b', state: 'FAILURE' },
    { __typename: 'StatusContext', context: 'c', state: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'd', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { __typename: 'CheckRun', name: 'e', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', name: 'f', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { __typename: 'CheckRun', name: 'g', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
    { __typename: 'CheckRun', name: 'h', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
    { __typename: 'CheckRun', name: 'i', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'j', status: 'QUEUED' },
  ]), [
    { name: 'a', state: 'pending' }, { name: 'b', state: 'failure' }, { name: 'c', state: 'success' },
    { name: 'd', state: 'success' }, { name: 'e', state: 'success' }, { name: 'f', state: 'failure' },
    { name: 'g', state: 'failure' }, { name: 'h', state: 'failure' }, { name: 'i', state: 'failure' }, { name: 'j', state: 'pending' },
  ]);
  assert.deepStrictEqual(normalizeChecks(null), []);
});

test('errors map to kinds', async () => {
  const call = (r) => createClient({ request: fake(r).request }).listPrs('tok');
  await assert.rejects(call(fail(401, { message: 'Bad credentials' })), kindOf('auth', { status: 401 }));
  await assert.rejects(call(fail(429)), kindOf('throttle', { status: 429 }));
  await assert.rejects(call(fail(403, null, { 'retry-after': '30' })), kindOf('throttle', { retryAfterMs: 30000 }));
  await assert.rejects(call(fail(429, null, { 'retry-after': '30' })), kindOf('throttle', { retryAfterMs: 30000 }));
  await assert.rejects(call(fail(403, { message: 'You have exceeded a secondary rate limit.' })), kindOf('throttle'));
  await assert.rejects(call(fail(403, { message: 'Resource not accessible' })), kindOf('http', { status: 403 }));
  await assert.rejects(call(fail(502)), kindOf('http', { status: 502 }));
  await assert.rejects(call(ok({ data: null, errors: [{ message: 'SAML enforcement' }, { message: 'second' }] })), (e) => kindOf('partial')(e) && e.message === 'SAML enforcement');
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']) {
    await assert.rejects(call(Object.assign(new Error(code), { code })), kindOf('offline'));
  }
});

test('merge sends mergePullRequest and maps errors to refused', async () => {
  const f = fake(ok({ data: { mergePullRequest: { pullRequest: { id: 'PR_7' } } } }));
  const c = createClient({ request: f.request });
  assert.strictEqual(await c.merge('tok', { id: 'PR_7', method: 'SQUASH', expectedHeadOid: 'head7' }), undefined);
  assert.match(f.calls[0].body.query, /mergePullRequest/);
  assert.deepStrictEqual(f.calls[0].body.variables.input, { pullRequestId: 'PR_7', mergeMethod: 'SQUASH', expectedHeadOid: 'head7' });
  const g = fake(ok({ data: null, errors: [{ message: 'Head branch was modified' }] }));
  await assert.rejects(createClient({ request: g.request }).merge('tok', { id: 'PR_7', method: 'MERGE', expectedHeadOid: 'x' }),
    (e) => kindOf('refused')(e) && e.message === 'Head branch was modified');
  const h = fake(fail(401));
  await assert.rejects(createClient({ request: h.request }).merge('tok', { id: 'PR_7', method: 'MERGE', expectedHeadOid: 'x' }), kindOf('auth'));
});
