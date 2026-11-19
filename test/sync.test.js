'use strict';
// Sync round (design 101, "Accounts", "The query", "Polling").
const test = require('node:test'); const assert = require('node:assert');
const { createSync } = require('../src/sync');
const { createTracker } = require('../src/tracker');
const { GitHubError } = require('../src/github');
const { NoGhError } = require('../src/accounts');

const item = (n, o = {}) => ({
  id: `PR_${n}`, url: `https://github.com/acme/widgets/pull/${n}`, updatedAt: `2026-01-0${n}T00:00:00Z`, headOid: `head${n}`,
  mergeable: 'MERGEABLE', mergeState: 'CLEAN', isDraft: false, reviewDecision: null, rollup: 'SUCCESS', ...o,
});
const full = (it) => ({
  state: 'OPEN', author: 'octo-dev',
  ...it, number: Number(it.id.slice(3)), title: `Change ${it.id}`, repo: 'acme/widgets', account: '',
  checks: [{ name: 'test', state: 'success' }], reviews: [], unresolvedThreads: 0, mergeMethods: { squash: true, merge: true, rebase: true },
});
const RATE_OK = { remaining: 4000, resetAt: '2026-03-01T01:00:00Z', cost: 1 };
const T0 = Date.parse('2026-03-01T00:00:00Z');

function setup({ logins = ['octo-dev'], lists = {}, byUrl = {}, tokenFails = {}, rate = () => RATE_OK, onRound } = {}) {
  const calls = { list: [], detail: [], tokens: [], byUrl: [], accounts: 0 };
  const clock = { t: T0 };
  const state = { lists: { ...lists }, auth: {}, logins: [...logins], allowed: null };
  const accounts = {
    list: async () => {
      calls.accounts++;
      const out = state.logins.filter((l) => !state.allowed || state.allowed.includes(l));
      if (!out.length) throw new NoGhError();
      return out;
    },
    isAllowed: (l) => !state.allowed || state.allowed.includes(l),
    token: async (login, o) => {
      calls.tokens.push([login, !!(o && o.fresh)]);
      if (tokenFails[login] && (o && o.fresh ? tokenFails[login].fresh : tokenFails[login].first)) throw new Error(`${login}: gh login expired, run \`gh auth login\``);
      return `tok-${login}${o && o.fresh ? '-fresh' : ''}`;
    },
  };
  const client = {
    listPrs: async (token) => {
      const login = token.replace(/^tok-/, '').replace(/-fresh$/, '');
      calls.list.push(token);
      const s = state.lists[login];
      if (typeof s === 'function') return s(token);
      return { items: s || [], rateLimit: rate() };
    },
    detailPrs: async (token, ids) => {
      calls.detail.push(ids);
      if (state.detailError) throw state.detailError;
      const all = [...Object.values(state.lists).flatMap((s) => (Array.isArray(s) ? s : [])), ...Object.values(byUrl), item(1)];
      return { prs: ids.map((id) => full(all.find((i) => i.id === id))), rateLimit: rate() };
    },
    prByUrl: async (token, url) => { calls.byUrl.push([token, url]); if (state.byUrlError) throw state.byUrlError; return byUrl[url] ? full(byUrl[url]) : null; },
  };
  const tracker = createTracker({ now: () => clock.t });
  const sync = createSync({ accounts, client, tracker, now: () => clock.t, onRound });
  return { sync, tracker, calls, clock, state };
}
const nums = (tr) => tr.rows().map((r) => r.pr.number).sort();

test('only changed PRs get detail', async () => {
  const { sync, calls, state, tracker } = setup({ lists: { 'octo-dev': [item(1), item(2)] } });
  await sync.run();
  assert.deepStrictEqual(calls.detail, [['PR_1', 'PR_2']]);
  state.lists['octo-dev'] = [item(1), item(2, { updatedAt: '2026-02-02T00:00:00Z' })];
  await sync.run();
  assert.deepStrictEqual(calls.detail, [['PR_1', 'PR_2'], ['PR_2']]);
  assert.deepStrictEqual(nums(tracker), [1, 2]);
  assert.ok(tracker.rows().every((r) => r.pr.account === 'octo-dev'));
});

test('no detail call when nothing changed, and dropped PRs leave the cache', async () => {
  const { sync, calls, state, tracker } = setup({ lists: { 'octo-dev': [item(1), item(2)] } });
  await sync.run();
  state.lists['octo-dev'] = [item(1)];
  await sync.run();
  assert.strictEqual(calls.detail.length, 1);
  assert.deepStrictEqual(nums(tracker), [1]);
  state.lists['octo-dev'] = [item(1), item(2)];
  await sync.run();
  assert.deepStrictEqual(calls.detail[1], ['PR_2'], 'a PR that comes back is new again');
});

test('pending rollup always refreshed', async () => {
  const { sync, calls } = setup({ lists: { 'octo-dev': [item(1, { rollup: 'PENDING' }), item(2, { rollup: 'EXPECTED' }), item(3)] } });
  await sync.run();
  await sync.run();
  assert.deepStrictEqual(calls.detail, [['PR_1', 'PR_2', 'PR_3'], ['PR_1', 'PR_2']]);
});

test('401 then fresh token succeeds', async () => {
  const { sync, calls, tracker, state } = setup({ lists: { 'octo-dev': [item(1)] } });
  state.lists['octo-dev'] = (token) => {
    if (!token.endsWith('-fresh')) throw new GitHubError('auth', 'bad credentials', { status: 401 });
    return { items: [item(1)], rateLimit: RATE_OK };
  };
  await sync.run();
  assert.deepStrictEqual(calls.tokens, [['octo-dev', false], ['octo-dev', true]]);
  assert.deepStrictEqual(nums(tracker), [1]);
  assert.deepStrictEqual(tracker.notes(), []);
});

test('401 twice drops account', async () => {
  const { sync, tracker, state } = setup({ lists: { 'octo-dev': [item(1)] } });
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1]);
  state.lists['octo-dev'] = () => { throw new GitHubError('auth', 'bad credentials', { status: 401 }); };
  await sync.run();
  assert.deepStrictEqual(nums(tracker), []);
  assert.deepStrictEqual(tracker.notes(), ['octo-dev: gh login expired, run `gh auth login`']);
});

test('token failure drops account', async () => {
  const { sync, tracker } = setup({ lists: { 'octo-dev': [item(1)] }, tokenFails: { 'octo-dev': { first: true } } });
  await sync.run();
  assert.deepStrictEqual(tracker.notes(), ['octo-dev: gh login expired, run `gh auth login`']);
});

test('partial keeps rows and continues with other accounts', async () => {
  const { sync, tracker, state } = setup({
    logins: ['octo-dev', 'octo-work'],
    lists: { 'octo-dev': [item(1)], 'octo-work': [item(3)] },
  });
  await sync.run();
  state.detailError = new GitHubError('partial', 'search incomplete');
  state.lists['octo-dev'] = [item(1, { updatedAt: '2026-02-01T00:00:00Z' })];
  state.lists['octo-work'] = [item(3)];
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1, 3]);
  assert.deepStrictEqual(tracker.notes(), ['octo-dev: search incomplete']);
});

test('http error is treated like partial', async () => {
  const { sync, tracker, state } = setup({ lists: { 'octo-dev': [item(1)] } });
  state.lists['octo-dev'] = () => { throw new GitHubError('http', 'HTTP 500', { status: 500 }); };
  await sync.run();
  assert.deepStrictEqual(tracker.notes(), ['octo-dev: HTTP 500']);
});

test('a good round clears the account note', async () => {
  const { sync, tracker, state } = setup({ lists: { 'octo-dev': [item(1)] } });
  state.lists['octo-dev'] = () => { throw new GitHubError('partial', 'incomplete'); };
  await sync.run();
  assert.strictEqual(tracker.notes().length, 1);
  state.lists['octo-dev'] = [item(1)];
  await sync.run();
  assert.deepStrictEqual(tracker.notes(), []);
});

test('throttle and offline are rethrown', async () => {
  for (const kind of ['throttle', 'offline']) {
    const { sync, state } = setup({ lists: { 'octo-dev': [item(1)] } });
    state.lists['octo-dev'] = () => { throw new GitHubError(kind, 'x', { retryAfterMs: 1234 }); };
    await assert.rejects(sync.run(), (e) => e.kind === kind && e.retryAfterMs === 1234);
  }
});

test('rate floor throws rate wait', async () => {
  const resetAt = new Date(T0 + 90000).toISOString();
  const { sync } = setup({ lists: { 'octo-dev': [item(1)] }, rate: () => ({ remaining: 150, resetAt, cost: 1 }) });
  const d = new Date(T0 + 90000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  await assert.rejects(sync.run(), (e) => e instanceof Error && e.kind === 'rate' && e.retryAfterMs === 90000
    && e.message === `GitHub rate limit, resuming at ${hhmm}`);
});

test('rate data without a reset time is ignored', async () => {
  const { sync } = setup({ lists: { 'octo-dev': [item(1)] }, rate: () => ({ remaining: 0, resetAt: '', cost: 0 }) });
  await sync.run();
});

test('watched url included until listed', async () => {
  const other = item(9, { url: 'https://github.com/acme/api/pull/9' });
  const url = other.url;
  const { sync, tracker, calls, state } = setup({ lists: { 'octo-dev': [item(1)] }, byUrl: { [url]: other } });
  await sync.run();
  sync.watch(url);
  await sync.run();
  assert.deepStrictEqual(calls.byUrl, [['tok-octo-dev', url]]);
  assert.deepStrictEqual(nums(tracker), [1, 9]);
  await sync.run();
  assert.strictEqual(calls.byUrl.length, 2, 'still watched while not listed');
  assert.deepStrictEqual(nums(tracker), [1, 9]);
  state.lists['octo-dev'] = [item(1), other];
  await sync.run();
  await sync.run();
  assert.strictEqual(calls.byUrl.length, 2, 'unwatched once listed');
  assert.deepStrictEqual(nums(tracker), [1, 9]);
});

test('watched row stays when a later account is throttled', async () => {
  const other = item(9, { url: 'https://github.com/acme/api/pull/9' });
  const { sync, tracker, state } = setup({ logins: ['octo-dev', 'octo-work'], lists: { 'octo-dev': [item(1)], 'octo-work': [item(3)] }, byUrl: { [other.url]: other } });
  sync.watch(other.url);
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1, 3, 9]);
  state.lists['octo-work'] = () => { throw new GitHubError('throttle', 'slow', { retryAfterMs: 1000 }); };
  await assert.rejects(sync.run(), (e) => e.kind === 'throttle');
  assert.deepStrictEqual(nums(tracker), [1, 3, 9]);
});

test('watched row stays when prByUrl fails', async () => {
  const other = item(9, { url: 'https://github.com/acme/api/pull/9' });
  const byUrl = { [other.url]: other };
  const { sync, tracker, state } = setup({ lists: { 'octo-dev': [item(1)] }, byUrl });
  sync.watch(other.url);
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1, 9]);
  for (const kind of ['partial', 'http', 'throttle']) {
    state.byUrlError = new GitHubError(kind, 'x', { retryAfterMs: 1000 });
    if (kind === 'throttle') await assert.rejects(sync.run(), (e) => e.kind === 'throttle'); else await sync.run();
    assert.deepStrictEqual(nums(tracker), [1, 9], kind);
  }
});

test('rate wait is floored at 5 s', async () => {
  const resetAt = new Date(T0 - 60000).toISOString();
  const { sync } = setup({ lists: { 'octo-dev': [item(1)] }, rate: () => ({ remaining: 5, resetAt, cost: 1 }) });
  await assert.rejects(sync.run(), (e) => e.kind === 'rate' && e.retryAfterMs === 5000);
});

test('unparseable rate reset is ignored', async () => {
  const { sync } = setup({ lists: { 'octo-dev': [item(1)] }, rate: () => ({ remaining: 5, resetAt: 'not a date', cost: 1 }) });
  await sync.run();
});

test('watch and fast open a five minute window', () => {
  const { sync, clock } = setup();
  assert.ok(sync.fastUntil() <= 0);
  sync.fast();
  assert.strictEqual(sync.fastUntil(), T0 + 300000);
  clock.t += 1000;
  sync.watch('https://github.com/acme/api/pull/9');
  assert.strictEqual(sync.fastUntil(), T0 + 301000);
});

test('tokenFor returns the account token', async () => {
  const { sync } = setup();
  assert.strictEqual(await sync.tokenFor('octo-dev'), 'tok-octo-dev');
});

test('no gh sets note and retries in 30 s', async () => {
  const { sync, tracker } = setup({ logins: [] });
  await assert.rejects(sync.run(), (e) => e.kind === 'rate' && e.retryAfterMs === 30000 && e.local === true && e.message === 'Sign in with `gh auth login`');
  assert.deepStrictEqual(tracker.notes(), ['Sign in with `gh auth login`']);
});

test('a good account list clears the global note', async () => {
  const { sync, tracker } = setup({ lists: { 'octo-dev': [item(1)] } });
  tracker.setGlobalNote('old');
  await sync.run();
  assert.deepStrictEqual(tracker.notes(), []);
});

test('onRound reports each successful account with its PR count and summed cost', async () => {
  const rounds = [];
  const { sync } = setup({ logins: ['octo-dev', 'octo-work'], lists: { 'octo-dev': [item(1), item(2)], 'octo-work': [] }, onRound: (r) => rounds.push(r) });
  await sync.run();
  assert.deepStrictEqual(rounds, [{ login: 'octo-dev', count: 2, cost: 2 }, { login: 'octo-work', count: 0, cost: 1 }]);
});

test('accounts are listed on start and on relist, not every poll', async () => {
  const { sync, calls } = setup({ lists: { 'octo-dev': [item(1)] } });
  await sync.run(); await sync.run(); await sync.run();
  assert.strictEqual(calls.accounts, 1);
  sync.relist();
  await sync.run(); await sync.run();
  assert.strictEqual(calls.accounts, 2);
});

test('after a round that dropped an account, or had no gh, accounts are listed again', async () => {
  const { sync, calls, state } = setup({ logins: ['octo-dev', 'octo-work'], lists: { 'octo-dev': [item(1)], 'octo-work': [item(3)] } });
  await sync.run();
  state.lists['octo-work'] = () => { throw new GitHubError('auth', 'bad credentials', { status: 401 }); };
  await sync.run();
  assert.strictEqual(calls.accounts, 1);
  state.lists['octo-work'] = [item(3)];
  await sync.run();
  assert.strictEqual(calls.accounts, 2, 'relisted after the drop');
  await sync.run();
  assert.strictEqual(calls.accounts, 2);
  const saved = state.logins; state.logins = [];
  sync.relist();
  await assert.rejects(sync.run(), (e) => e.local);
  assert.strictEqual(calls.accounts, 3);
  state.logins = saved;
  await sync.run();
  assert.strictEqual(calls.accounts, 4, 'relisted after no gh');
});

test('a login gh no longer reports is dropped with the expired note; one excluded by settings without a note', async () => {
  const { sync, tracker, state } = setup({ logins: ['octo-dev', 'octo-work'], lists: { 'octo-dev': [item(1)], 'octo-work': [item(3, { url: 'https://github.com/acme/api/pull/3' })] } });
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1, 3]);
  state.logins = ['octo-dev'];
  sync.relist();
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1]);
  assert.deepStrictEqual(tracker.notes(), ['octo-work: gh login expired, run `gh auth login`']);

  const b = setup({ logins: ['octo-dev', 'octo-work'], lists: { 'octo-dev': [item(1)], 'octo-work': [item(3, { url: 'https://github.com/acme/api/pull/3' })] } });
  await b.sync.run();
  b.state.allowed = ['octo-dev'];
  b.sync.relist();
  await b.sync.run();
  assert.deepStrictEqual(nums(b.tracker), [1]);
  assert.deepStrictEqual(b.tracker.notes(), []);
});

test('a watched PR that is not open is unwatched and never shown', async () => {
  for (const st of ['MERGED', 'CLOSED']) {
    const other = item(9, { url: 'https://github.com/acme/api/pull/9', state: st });
    const { sync, tracker, calls } = setup({ lists: { 'octo-dev': [item(1)] }, byUrl: { [other.url]: other } });
    assert.strictEqual(sync.watch(other.url), true);
    await sync.run();
    assert.deepStrictEqual(nums(tracker), [1], st);
    await sync.run();
    assert.strictEqual(calls.byUrl.length, 1, `${st}: unwatched`);
  }
});

test('a watched PR goes to the account that authored it; one no account authored is ignored', async () => {
  const mine = item(9, { url: 'https://github.com/acme/api/pull/9', author: 'octo-work' });
  const theirs = item(8, { url: 'https://github.com/acme/api/pull/8', author: 'someone-else' });
  const { sync, tracker, calls } = setup({
    logins: ['octo-dev', 'octo-work'], lists: { 'octo-dev': [item(1)], 'octo-work': [] },
    byUrl: { [mine.url]: mine, [theirs.url]: theirs },
  });
  sync.watch(mine.url); sync.watch(theirs.url);
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1, 9]);
  assert.strictEqual(tracker.rows().find((r) => r.pr.number === 9).pr.account, 'octo-work');
  await sync.run();
  assert.deepStrictEqual(calls.byUrl.map((c) => c[1]), [mine.url, theirs.url, mine.url], 'the stranger\'s PR is unwatched');
  assert.deepStrictEqual(nums(tracker), [1, 9], 'and the watched row survives octo-work\'s apply');
});

test('unwatch stops fetching and the row does not come back', async () => {
  const other = item(9, { url: 'https://github.com/acme/api/pull/9' });
  const { sync, tracker, calls } = setup({ lists: { 'octo-dev': [item(1)] }, byUrl: { [other.url]: other } });
  sync.watch(other.url);
  await sync.run();
  assert.deepStrictEqual(nums(tracker), [1, 9]);
  tracker.remove(other.url);
  sync.unwatch(other.url);
  await sync.run();
  assert.strictEqual(calls.byUrl.length, 1);
  assert.deepStrictEqual(nums(tracker), [1]);
});

test('watch accepts only github.com PR urls', async () => {
  const { sync, calls } = setup({ lists: { 'octo-dev': [item(1)] } });
  for (const bad of [undefined, null, '', 'undefined', 'https://github.com/acme/api/issues/9', 'https://example.com/acme/api/pull/9',
    'http://github.com/acme/api/pull/9', 'https://github.com/acme/api/pull/9/files', 'https://github.com/acme/pull/9']) {
    assert.strictEqual(sync.watch(bad), false, String(bad));
  }
  assert.strictEqual(sync.fastUntil(), 0, 'a rejected watch does not speed up polling');
  await sync.run();
  assert.deepStrictEqual(calls.byUrl, []);
});

test('a rate error from GitHub is rethrown to the poller, rows kept', async () => {
  const { sync, tracker, state } = setup({ lists: { 'octo-dev': [item(1)] } });
  await sync.run();
  state.lists['octo-dev'] = () => { throw new GitHubError('rate', 'GitHub rate limit, resuming at 09:05', { retryAfterMs: 9000 }); };
  await assert.rejects(sync.run(), (e) => e.kind === 'rate' && e.retryAfterMs === 9000 && !e.local);
  assert.deepStrictEqual(nums(tracker), [1]);
});
