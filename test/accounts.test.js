'use strict';
// gh accounts and tokens (design 101, "Accounts").
const test = require('node:test'); const assert = require('node:assert');
const { parseAuthStatus, createAccounts, NoGhError } = require('../src/accounts');

const STATUS = [
  'github.com',
  '  ✓ Logged in to github.com account octo-work (/home/dev/.config/gh/hosts.yml)',
  '  - Active account: true',
  '  - Git operations protocol: ssh',
  "  - Token: gho_****",
  "  - Token scopes: 'gist', 'read:org', 'repo'",
  '',
  '  ✓ Logged in to github.com account octo-dev (keyring)',
  '  - Active account: false',
  '  - Git operations protocol: ssh',
  '  - Token: gho_****',
  "  - Token scopes: 'gist', 'read:org', 'repo'",
  '',
  '  X Failed to log in to github.com account octo-old (keyring)',
  '  - Active account: false',
  '  - The token in keyring is invalid.',
  '  - To re-authenticate, run: gh auth login -h github.com',
  '',
].join('\n');

const ok = (stdout, code = 0, stderr = '') => ({ code, stdout, stderr });

test('parseAuthStatus lists good logins in order and skips failed ones', () => {
  assert.deepStrictEqual(parseAuthStatus(STATUS), ['octo-work', 'octo-dev']);
});

test('parseAuthStatus is unique and tolerates junk', () => {
  assert.deepStrictEqual(parseAuthStatus('Logged in to github.com account a\nLogged in to github.com account a\n'), ['a']);
  assert.deepStrictEqual(parseAuthStatus(''), []);
  assert.deepStrictEqual(parseAuthStatus(null), []);
});

test('list runs auth status, reads stdout and stderr, and parses at code 1', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return ok('', 1, STATUS); };
  const a = createAccounts({ run, allowed: () => [] });
  assert.deepStrictEqual(await a.list(), ['octo-work', 'octo-dev']);
  assert.deepStrictEqual(calls[0], ['auth', 'status', '--hostname', 'github.com']);
});

test('list filters by allowed when non-empty', async () => {
  const a = createAccounts({ run: async () => ok(STATUS), allowed: () => ['octo-dev'] });
  assert.deepStrictEqual(await a.list(), ['octo-dev']);
});

test('list rejects with NoGhError for code 127 or no logins', async () => {
  const msg = 'Sign in with `gh auth login`';
  for (const r of [ok('', 127, 'spawn gh ENOENT'), ok('You are not logged into any GitHub hosts.', 1)]) {
    const a = createAccounts({ run: async () => r, allowed: () => [] });
    await assert.rejects(a.list(), (e) => e instanceof NoGhError && e.message === msg);
  }
});

test('token runs auth token for the user, trims, and caches', async () => {
  const calls = [];
  const a = createAccounts({ run: async (args) => { calls.push(args); return ok('gho_abc\n'); }, allowed: () => [] });
  assert.strictEqual(await a.token('octo-dev'), 'gho_abc');
  assert.strictEqual(await a.token('octo-dev'), 'gho_abc');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['auth', 'token', '--hostname', 'github.com', '--user', 'octo-dev']);
  await a.token('octo-dev', { fresh: true });
  assert.strictEqual(calls.length, 2);
});

test('token rejects when gh fails', async () => {
  const a = createAccounts({ run: async () => ok('', 1, 'no token'), allowed: () => [] });
  await assert.rejects(a.token('octo-dev'), (e) => e instanceof Error && e.message === 'octo-dev: gh login expired, run `gh auth login`');
});
