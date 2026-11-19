'use strict';
// Row tracker (design 101, "Events" and the throttling/partial-results bullets under "Polling"):
// an in-memory store that turns each account's poll results into ordered rows, events, a badge and notes.
const { rowState } = require('./model');

function createTracker({ now }) {
  const rows = new Map();       // pr.url -> Row
  const applied = new Set();    // accounts that have had a successful apply
  const notes = new Map();      // account -> note, in insertion order
  let globalNote = null;
  const listeners = [];
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
          : { pr, state, changedAt: now(), highlight: state.actionable, error: null };
      } else if (old.state.key !== state.key) {
        next = { pr, state, changedAt: now(), highlight: state.actionable, error: null };
      } else {
        next = { pr, state, changedAt: old.changedAt, highlight: old.highlight, error: null };
      }
      if (!old || !sameRow(old, next)) changed = true;
      rows.set(pr.url, next);
    }
    for (const [url, r] of rows) {
      if (r.pr.account === account && !seen.has(url)) { rows.delete(url); changed = true; }
    }
    emit(changed);
  }

  function setNote(account, note) {
    if (notes.get(account) === note) return false;
    notes.set(account, note);
    return true;
  }

  function fail(account, note) { emit(setNote(account, note)); }

  function drop(account, note) {
    let changed = false;
    for (const [url, r] of rows) {
      if (r.pr.account === account) { rows.delete(url); changed = true; }
    }
    emit(setNote(account, note) || changed);
  }

  function clearNote(account) { emit(notes.delete(account)); }

  function setGlobalNote(text) {
    const next = text || null;
    if (next === globalNote) return;
    globalNote = next;
    emit(true);
  }

  function remove(url) { emit(rows.delete(url)); }

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
    apply, fail, drop, clearNote, setGlobalNote, remove, markSeen, setError,
    rows: () => [...rows.values()].sort((a, b) => b.changedAt - a.changedAt || (a.pr.url < b.pr.url ? -1 : a.pr.url > b.pr.url ? 1 : 0)),
    badge: () => [...rows.values()].filter((r) => r.state.actionable).length,
    notes: () => [...(globalNote ? [globalNote] : []), ...notes.values()],
    anyRunning: () => [...rows.values()].some((r) => r.state.rule === 6),
    onChange: (fn) => { listeners.push(fn); },
  };
}

module.exports = { createTracker };
