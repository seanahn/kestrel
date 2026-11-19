'use strict';
// Runs a sync again and again (design 101, "Polling"): never two at once, the wait picked per round, and backing off
// when GitHub throttles or the network is down: retryAfterMs when given, else 5 s doubling to 5 min.
const UNFOCUSED_FACTOR = 4;
const FAST_MS = 10000;
const RUNNING_MS = 20000;
const IDLE_MS = 60000;
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 300000;
const THROTTLE_NOTE = 'GitHub is throttling, retrying';
const OFFLINE_NOTE = 'Offline, retrying';

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

/** Wait between rounds: 10 s while fast, 20 s while a check is running, else 60 s; x4 when the window is not focused. */
function pickInterval({ focused, anyRunning, fastUntil, now }) {
  const base = now < fastUntil ? FAST_MS : anyRunning ? RUNNING_MS : IDLE_MS;
  return base * (focused ? 1 : UNFOCUSED_FACTOR);
}

function createPoller({ run, interval, timers = realTimers, onNote = () => {}, onError = () => {} }) {
  let timer = null, running = false, stopped = true, backoff = 0, note = null;

  const setNote = (text) => { if (text !== note) { note = text; onNote(text); } };
  function schedule(ms) { if (!stopped) timer = timers.set(tick, ms); }
  const nextBackoff = () => { backoff = backoff ? Math.min(backoff * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS; return backoff; };

  async function tick() {
    timer = null;
    if (running || stopped) return;
    running = true;
    let wait;
    try {
      await run();
      backoff = 0;
      setNote(null);
      wait = interval();
    } catch (e) {
      const kind = e && e.kind;
      if (kind === 'throttle') {
        const next = nextBackoff();
        wait = e.retryAfterMs != null ? e.retryAfterMs : next;
        setNote(THROTTLE_NOTE);
      } else if (kind === 'offline') {
        wait = nextBackoff();
        setNote(OFFLINE_NOTE);
      } else if (kind === 'rate') {
        wait = e.retryAfterMs;
        setNote(e.message);
      } else {
        onError(e);
        wait = interval();
      }
    } finally { running = false; }
    schedule(wait);
  }

  return {
    start() { if (!stopped) return; stopped = false; tick(); },
    stop() { stopped = true; if (timer !== null) { timers.clear(timer); timer = null; } },
    /** Run now, unless a run is in flight. */
    kick() { if (stopped || running) return; if (timer !== null) { timers.clear(timer); timer = null; } tick(); },
  };
}

module.exports = {
  createPoller, pickInterval, UNFOCUSED_FACTOR, FAST_MS, RUNNING_MS, IDLE_MS, BACKOFF_START_MS, BACKOFF_MAX_MS,
  THROTTLE_NOTE, OFFLINE_NOTE,
};
