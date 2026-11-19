'use strict';
// Row tracker (design 101, "Events" and the throttling/partial-results bullets under "Polling"):
// an in-memory store that turns each account's poll results into ordered rows, events, a badge and notes.
const { rowState } = require('./model');

function createTracker({ now }) {
  const rows = new Map();       // pr.url -> Row
  const applied = new Set();    // accounts that have had a successful apply
  const notes = new Map();      // account -> note, in insertion order
  let globalNote = null;       // sync's own note (no gh)
  let pollNote = null;         // the poller's note (throttled, offline, rate limit)
  const listeners = [];
  const hidden = new Set();     // urls the user hid (design 101, "Hiding a PR")
  const hiddenListeners = [];
  const emitHidden = () => hiddenListeners.forEach((fn) => fn([...hidden]));
  const emit = (changed) => { if (changed) listeners.forEach((fn) => fn()); };

  const sameRow = (a, b) => JSON.stringify([a.pr, a.state]) === JSON.stringify([b.pr, b.state])
    && a.changedAt === b.changedAt && a.highlight === b.highlight && a.error === b.error;

  function apply(account, prs) {
    const first = !applied.has(account);
    applied.add(account);
    let changed = false;
    const seen = new Set();
    for (const pr of prs) {
      seen.add(pr.url);
      const state = rowState(pr);
      const old = rows.get(pr.url);
      let next;
      if (!old) {
        next = first
          ? { pr, state, changedAt: Date.parse(pr.updatedAt), highlight: false, error: null }
          : { pr, state, changedAt: now(), highlight: state.actionable && !hidden.has(pr.url), error: null };
      } else if (old.state.key !== state.key) {
        next = { pr, state, changedAt: now(), highlight: state.actionable && !hidden.has(pr.url), error: null };
      } else {
        next = { pr, state, changedAt: old.changedAt, highlight: old.highlight, error: null };
      }
      if (!old || !sameRow(old, next)) changed = true;
      rows.set(pr.url, next);
    }
    let pruned = false;
    for (const [url, r] of rows) {
      if (r.pr.account === account && !seen.has(url)) { rows.delete(url); changed = true; pruned = hidden.delete(url) || pruned; }
    }
    emit(changed);
    if (pruned) emitHidden();
  }

  function setNote(account, note) {
    if (notes.get(account) === note) return false;
    notes.set(account, note);
    return true;
  }

  function fail(account, note) { emit(setNote(account, note)); }

  /** Drops an account's rows. A falsy note clears its note. If it comes back, its first apply is quiet again. */
  function drop(account, note) {
    let changed = false;
    applied.delete(account);
    for (const [url, r] of rows) {
      if (r.pr.account === account) { rows.delete(url); changed = true; }
    }
    emit((note ? setNote(account, note) : notes.delete(account)) || changed);
  }

  function clearNote(account) { emit(notes.delete(account)); }

  function setGlobalNote(text) {
    const next = text || null;
    if (next === globalNote) return;
    globalNote = next;
    emit(true);
  }

  function setPollNote(text) {
    const next = text || null;
    if (next === pollNote) return;
    pollNote = next;
    emit(true);
  }

  function remove(url) {
    const had = rows.delete(url);
    const pruned = hidden.delete(url);
    emit(had);
    if (pruned) emitHidden();
  }

  function setHidden(urls) { hidden.clear(); for (const u of urls || []) hidden.add(String(u)); }

  function hide(url) {
    if (hidden.has(url)) return;
    hidden.add(url);
    const r = rows.get(url);
    if (r && r.highlight) rows.set(url, { ...r, highlight: false });
    emit(true);
    emitHidden();
  }

  function unhide(url) {
    if (!hidden.delete(url)) return;
    emit(true);
    emitHidden();
  }

  function markSeen(url) {
    const r = rows.get(url);
    if (!r || !r.highlight) return;
    rows.set(url, { ...r, highlight: false });
    emit(true);
  }

  function setError(url, text) {
    const r = rows.get(url);
    const error = text || null;
    if (!r || r.error === error) return;
    rows.set(url, { ...r, error });
    emit(true);
  }

  return {
    apply, fail, drop, clearNote, setGlobalNote, setPollNote, remove, markSeen, setError, setHidden, hide, unhide,
    rows: () => [...rows.values()].map((r) => ({ ...r, hidden: hidden.has(r.pr.url) })).sort((a, b) => b.changedAt - a.changedAt || (a.pr.url < b.pr.url ? -1 : a.pr.url > b.pr.url ? 1 : 0)),
    badge: () => [...rows.values()].filter((r) => r.state.actionable && !hidden.has(r.pr.url)).length,
    notes: () => [...(pollNote ? [pollNote] : []), ...(globalNote ? [globalNote] : []), ...notes.values()],
    anyRunning: () => [...rows.values()].some((r) => r.state.rule === 6),
    hiddenUrls: () => [...hidden],
    onChange: (fn) => { listeners.push(fn); },
    onHiddenChange: (fn) => { hiddenListeners.push(fn); },
  };
}

module.exports = { createTracker };
