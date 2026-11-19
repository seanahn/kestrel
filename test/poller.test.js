'use strict';
// Poller (design 101, "Polling").
const test = require('node:test'); const assert = require('node:assert');
const { createPoller, pickInterval, UNFOCUSED_FACTOR, BACKOFF_START_MS, BACKOFF_MAX_MS } = require('../src/poller');
const { GitHubError } = require('../src/github');

/** Timers the test fires by hand: `delays` records what was asked for, `fire()` runs the pending one. */
function fakeTimers() {
  const t = { delays: [], pending: null, set(fn, ms) { t.delays.push(ms); t.pending = fn; return ms; }, clear() { t.pending = null; }, async fire() { const f = t.pending; t.pending = null; await f(); } };
  return t;
}
const settle = () => new Promise((r) => setImmediate(r));
const mk = (run, extra = {}) => { const timers = fakeTimers(); return { timers, p: createPoller({ run, interval: () => 5000, timers, ...extra }) }; };

test('constants', () => { assert.deepStrictEqual([UNFOCUSED_FACTOR, BACKOFF_START_MS, BACKOFF_MAX_MS], [4, 5000, 300000]); });

test('pickInterval table', () => {
  const cases = [
    [{ focused: true, anyRunning: false, fastUntil: 0, now: 1000 }, 60000],
    [{ focused: true, anyRunning: true, fastUntil: 0, now: 1000 }, 20000],
    [{ focused: true, anyRunning: true, fastUntil: 2000, now: 1000 }, 10000],
    [{ focused: true, anyRunning: false, fastUntil: 1000, now: 1000 }, 60000],
    [{ focused: false, anyRunning: false, fastUntil: 0, now: 1000 }, 240000],
    [{ focused: false, anyRunning: true, fastUntil: 0, now: 1000 }, 80000],
    [{ focused: false, anyRunning: false, fastUntil: 2000, now: 1000 }, 40000],
  ];
  for (const [args, want] of cases) assert.strictEqual(pickInterval(args), want, JSON.stringify(args));
});

test('runs at once, then on the interval, and stops', async () => {
  let runs = 0;
  const { timers, p } = mk(async () => { runs++; });
  p.start(); await settle();
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(timers.delays, [5000]);
  await timers.fire(); await settle();
  assert.strictEqual(runs, 2);
  p.stop();
  assert.strictEqual(timers.pending, null);
});

test('interval is asked for every round', async () => {
  const waits = [1000, 2000]; const timers = fakeTimers();
  const p = createPoller({ run: async () => {}, interval: () => waits.shift(), timers });
  p.start(); await settle();
  await timers.fire(); await settle();
  assert.deepStrictEqual(timers.delays, [1000, 2000]);
  p.stop();
});

test('no overlap', async () => {
  let runs = 0, release;
  const { timers, p } = mk(() => { runs++; return new Promise((r) => { release = r; }); });
  p.start(); await settle();
  p.kick(); p.kick(); await settle();
  assert.strictEqual(runs, 1);
  release(); await settle();
  assert.deepStrictEqual(timers.delays, [5000]);
  p.kick(); await settle();
  assert.strictEqual(runs, 2, 'kick between runs runs now');
  p.stop();
});

test('throttle waits retryAfterMs, notes, then clears', async () => {
  const notes = []; let n = 0;
  const { timers, p } = mk(async () => { if (n++ === 0) throw new GitHubError('throttle', 'slow', { retryAfterMs: 7000 }); }, { onNote: (x) => notes.push(x) });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [7000]);
  await timers.fire(); await settle();
  assert.deepStrictEqual(timers.delays, [7000, 5000]);
  assert.deepStrictEqual(notes, ['GitHub is throttling, retrying', null]);
  p.stop();
});

test('throttle without retryAfterMs backs off exponentially to the cap', async () => {
  const { timers, p } = mk(async () => { throw new GitHubError('throttle', 'busy'); });
  p.start(); await settle();
  for (let i = 0; i < 8; i++) { await timers.fire(); await settle(); }
  assert.deepStrictEqual(timers.delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  p.stop();
});

test('offline backs off with its own note', async () => {
  const notes = [];
  const { timers, p } = mk(async () => { throw new GitHubError('offline', 'no network'); }, { onNote: (x) => notes.push(x) });
  p.start(); await settle();
  await timers.fire(); await settle();
  assert.deepStrictEqual(timers.delays, [5000, 10000]);
  assert.deepStrictEqual(notes, ['Offline, retrying']);
  p.stop();
});

test('success resets the backoff', async () => {
  let n = 0;
  const { timers, p } = mk(async () => { if (n++ !== 1) throw new GitHubError('offline', 'x'); });
  p.start(); await settle();
  await timers.fire(); await settle();
  await timers.fire(); await settle();
  assert.deepStrictEqual(timers.delays, [5000, 5000, 5000]);
  p.stop();
});

test('rate error waits retryAfterMs and notes its message', async () => {
  const notes = []; let n = 0;
  const err = Object.assign(new Error('GitHub rate limit, resuming at 09:05'), { kind: 'rate', retryAfterMs: 90000 });
  const { timers, p } = mk(async () => { if (n++ === 0) throw err; }, { onNote: (x) => notes.push(x) });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [90000]);
  await timers.fire(); await settle();
  assert.deepStrictEqual(notes, ['GitHub rate limit, resuming at 09:05', null]);
  p.stop();
});

test('other errors keep the normal interval', async () => {
  const errs = [];
  const { timers, p } = mk(async () => { throw new Error('boom'); }, { onError: (e) => errs.push(e.message) });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [5000]);
  assert.deepStrictEqual(errs, ['boom']);
  p.stop();
});

test('stopped poller does not reschedule after its run ends', async () => {
  let release;
  const { timers, p } = mk(() => new Promise((r) => { release = r; }));
  p.start(); await settle();
  p.stop(); release(); await settle();
  assert.deepStrictEqual(timers.delays, []);
});

test('kick is a no-op while a backoff, Retry-After or rate wait holds; runs again after it', async () => {
  for (const err of [
    new GitHubError('throttle', 'slow', { retryAfterMs: 7000 }),
    new GitHubError('offline', 'no network'),
    Object.assign(new Error('GitHub rate limit, resuming at 09:05'), { kind: 'rate', retryAfterMs: 90000 }),
  ]) {
    const clock = { t: 1000 }; let runs = 0;
    const timers = fakeTimers();
    const p = createPoller({ run: async () => { runs++; if (runs === 1) throw err; }, interval: () => 5000, timers, now: () => clock.t });
    p.start(); await settle();
    assert.strictEqual(runs, 1);
    const wait = timers.delays[0];
    p.kick(); await settle();
    assert.strictEqual(runs, 1, `${err.kind}: kick during the hold does nothing`);
    assert.notStrictEqual(timers.pending, null, `${err.kind}: the scheduled retry is kept`);
    clock.t += wait;
    p.kick(); await settle();
    assert.strictEqual(runs, 2, `${err.kind}: kick after the hold runs`);
    p.stop();
  }
});

test('a local wait (no gh) does not hold kick, and shows no poll note', async () => {
  const clock = { t: 1000 }; let runs = 0; const notes = [];
  const timers = fakeTimers();
  const err = Object.assign(new Error('Sign in with `gh auth login`'), { kind: 'rate', retryAfterMs: 30000, local: true });
  const p = createPoller({ run: async () => { runs++; throw err; }, interval: () => 5000, timers, now: () => clock.t, onNote: (x) => notes.push(x) });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [30000]);
  p.kick(); await settle();
  assert.strictEqual(runs, 2);
  assert.deepStrictEqual(notes, []);
  p.stop();
});
