'use strict';
// Merging (design 101, "Merging"): a modal confirm, a re-check of the row, then one guarded merge call. Never retried,
// never unguarded. Also the in-place branch update for a "behind base" row (design 101, "Updating a branch").
const METHOD_LABEL = { SQUASH: 'Squash and merge', MERGE: 'Create a merge commit', REBASE: 'Rebase and merge' };

function pickMethod(allowed, preferred) {
  const a = allowed || {};
  if (a[preferred]) return preferred.toUpperCase();
  const first = ['squash', 'merge', 'rebase'].find((m) => a[m]);
  return first ? first.toUpperCase() : null;
}

function createMerger({ vscode, client, tokenFor, tracker, pollNow, preferred, onBusyChange = () => {}, onMerged = () => {}, onUpdated = () => {} }) {
  const inFlight = new Map(); // url -> 'merge' | 'update'
  const refusedAt = new Map(); // url -> the head commit GitHub refused to update
  const rowOf = (url) => tracker.rows().find((r) => r.pr.url === url);

  async function merge(url) {
    if (inFlight.has(url)) return 'busy';
    const row = tracker.rows().find((r) => r.pr.url === url);
    if (!row) return 'gone';
    const pr = row.pr;
    const method = pickMethod(pr.mergeMethods, preferred());
    if (!method) { tracker.setError(url, 'This repo allows no merge method kestrel can use'); return 'refused'; }
    if (!pr.headOid) { tracker.setError(url, 'Merge not confirmed: missing head commit'); return 'refused'; }

    const label = METHOD_LABEL[method];
    const answer = await vscode.window.showWarningMessage(`Merge ${pr.repo}#${pr.number} "${pr.title}"?`, { modal: true }, label);
    if (answer !== label) return 'cancelled';
    if (inFlight.has(url)) return 'busy';
    // A poll may have landed while the modal was open: merge only what Sean confirmed.
    const now = tracker.rows().find((r) => r.pr.url === url);
    if (!now || now.state.rule !== 9 || now.pr.headOid !== pr.headOid) {
      tracker.setError(url, 'The PR changed; check it again');
      return 'changed';
    }

    inFlight.set(url, 'merge');
    onBusyChange();
    try {
      const token = await tokenFor(pr.account);
      await client.merge(token, { id: pr.id, method, expectedHeadOid: pr.headOid });
      tracker.remove(url);
      onMerged(url);
      return 'merged';
    } catch (e) {
      if (e && e.kind === 'refused') { tracker.setError(url, e.message); return 'refused'; }
      tracker.setError(url, 'Merge not confirmed: ' + (e && e.message));
      pollNow();
      return 'unconfirmed';
    } finally {
      inFlight.delete(url);
      onBusyChange();
    }
  }

  /** Merge the base into a behind-base PR's branch. No confirm: it changes the branch, it merges nothing. */
  async function update(url) {
    if (inFlight.has(url)) return 'busy';
    const row = rowOf(url);
    if (!row) return 'gone';
    if (row.state.rule !== 7) return 'changed';
    const pr = row.pr;
    if (!pr.headOid) { tracker.setError(url, 'Update not confirmed: missing head commit'); return 'refused'; }
    inFlight.set(url, 'update');
    onBusyChange();
    try {
      const token = await tokenFor(pr.account);
      await client.updateBranch(token, { id: pr.id, expectedHeadOid: pr.headOid });
      refusedAt.delete(url);
      onUpdated(url);
      pollNow();
      return 'updated';
    } catch (e) {
      if (e && e.kind === 'refused') { refusedAt.set(url, pr.headOid); tracker.setError(url, e.message); return 'refused'; }
      tracker.setError(url, 'Update not confirmed: ' + (e && e.message));
      pollNow();
      return 'unconfirmed';
    } finally {
      inFlight.delete(url);
      onBusyChange();
    }
  }

  /** GitHub refused to update this PR at its current head commit: the agent is the way forward until the head moves. */
  function updateFailed(url) {
    const at = refusedAt.get(url);
    if (at === undefined) return false;
    const row = rowOf(url);
    if (row && row.pr.headOid === at) return true;
    refusedAt.delete(url);
    return false;
  }

  return { merge, update, updateFailed, busy: (url) => inFlight.has(url), busyKind: (url) => inFlight.get(url) || null };
}

module.exports = { createMerger, pickMethod, METHOD_LABEL };
