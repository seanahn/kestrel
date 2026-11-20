'use strict';
// PRs merged outside kestrel (design 101, "Merged elsewhere").
const test = require('node:test'); const assert = require('node:assert');
const { createMergeWatch } = require('../src/mergedElsewhere');

const row = (n, account = 'octo-dev') => ({ pr: { url: `https://github.com/acme/widgets/pull/${n}`, account } });

test('only a merged PR is noted, with its own account token, one at a time', async () => {
  const states = { 1: 'MERGED', 2: 'CLOSED', 3: 'MERGED' };
  const seen = [], noted = [], logs = [];
  let inFlight = 0, most = 0;
  const w = createMergeWatch({
    tokenFor: async (login) => `tok-${login}`,
    prByUrl: async (token, url) => {
      inFlight++; most = Math.max(most, inFlight); seen.push([token, url]);
      await new Promise((r) => setImmediate(r)); inFlight--;
      return { state: states[url.split('/').pop()] };
    },
    noteMerged: async (url) => { noted.push(url); return { result: 'tab' }; },
    log: (l) => logs.push(l),
  });
  await w.handle([row(1), row(2), row(3, 'octo-work')]);
  assert.deepStrictEqual(noted, [row(1).pr.url, row(3).pr.url]);
  assert.deepStrictEqual(seen.map((s) => s[0]), ['tok-octo-dev', 'tok-octo-dev', 'tok-octo-work']);
  assert.strictEqual(most, 1);
  assert.match(logs[0], /pull\/1 was merged outside kestrel; perch: tab/);
});

test('a failed lookup is logged and dropped; no perch means nothing noted', async () => {
  const logs = [];
  const w = createMergeWatch({
    tokenFor: async () => 't',
    prByUrl: async () => { throw new Error('offline'); },
    noteMerged: async () => { throw new Error('must not be called'); },
    log: (l) => logs.push(l),
  });
  await w.handle([row(1)]);
  assert.match(logs[0], /could not check whether it was merged: offline/);
  const w2 = createMergeWatch({ tokenFor: async () => 't', prByUrl: async () => ({ state: 'MERGED' }), noteMerged: async () => null, log: (l) => logs.push(l) });
  await w2.handle([row(2)]);
  assert.match(logs[1], /perch: not installed/);
});
