'use strict';
// Background lookups of this machine's chat for each PR (design 101, "Where a PR was made").
const test = require('node:test'); const assert = require('node:assert');
const { createLocalOrigins, RETRY_MISS_MS } = require('../src/origins');
const { parseOrigin, originLines } = require('../src/origin');

const A = 'https://github.com/acme/widgets/pull/1', B = 'https://github.com/acme/widgets/pull/2';
const hit = { session: '3f2a9c1e-aaaa', cwd: '/home/dev/widgets', transcript: '/t/3f2a.jsonl', host: 'devbox' };

test('asks one at a time, once per PR, and reports what changed', async () => {
  let t = 0, inFlight = 0, most = 0; const asked = [], changed = [];
  const o = createLocalOrigins({
    now: () => t, onChange: (u) => changed.push(u),
    find: async (u) => { asked.push(u); inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setImmediate(r)); inFlight--; return u === A ? hit : null; },
  });
  await o.want([A, B, A]);
  assert.deepStrictEqual(asked, [A, B]);
  assert.strictEqual(most, 1);
  assert.deepStrictEqual(o.get(A), hit);
  assert.strictEqual(o.get(B), null);
  assert.deepStrictEqual(changed, [A, B]);
  await o.want([A, B]);
  assert.deepStrictEqual(asked, [A, B], 'a hit is kept; a fresh miss is not asked again');
  t += RETRY_MISS_MS;
  await o.want([A, B]);
  assert.deepStrictEqual(asked, [A, B, B], 'a miss is asked again after 10 minutes');
});

test('a failing lookup is a miss, never a throw', async () => {
  const o = createLocalOrigins({ find: async () => { throw new Error('perch broke'); } });
  await o.want([A]);
  assert.strictEqual(o.get(A), null);
});

test('tooltip lines: the PR record first, else this machine, else none', () => {
  const record = { host: 'desktop', session: '3f2a9c1e-0000', cwd: '/home/dev/widgets', transcript: '/t/x.jsonl', at: '2026-11-20T01:02:03.000Z' };
  assert.deepStrictEqual(originLines(record, hit), ['Made on desktop · Claude session 3f2a9c1e · /home/dev/widgets', 'Transcript: /t/x.jsonl', 'Recorded 2026-11-20 01:02 UTC']);
  assert.deepStrictEqual(originLines(null, hit), ['Found on this machine (devbox) · Claude session 3f2a9c1e · /home/dev/widgets', 'Transcript: /t/3f2a.jsonl']);
  assert.deepStrictEqual(originLines(null, null), ['No Claude chat found for this PR (no record on the PR, none on this machine).']);
});

test('parseOrigin ignores bad records and keeps the last good one', () => {
  const enc = (o) => `<!-- pr-origin: ${Buffer.from(JSON.stringify(o)).toString('base64')} -->`;
  assert.strictEqual(parseOrigin('no record'), null);
  assert.strictEqual(parseOrigin('<!-- pr-origin: !!!! -->'), null);
  assert.strictEqual(parseOrigin(enc({ host: 'x' })), null, 'a record needs a session');
  assert.strictEqual(parseOrigin(`${enc({ session: 's1', host: 'a' })}\n${enc({ session: 's2', host: 'b', extra: 1 })}`).session, 's2');
  assert.deepStrictEqual(parseOrigin(enc({ session: 's', host: 42 })), { host: null, session: 's', cwd: null, transcript: null, at: null });
});
