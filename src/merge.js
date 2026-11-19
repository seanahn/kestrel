'use strict';
// Merging (design 101, "Merging"): a modal confirm, then one guarded merge call. Never retried, never unguarded.
const METHOD_LABEL = { SQUASH: 'Squash and merge', MERGE: 'Create a merge commit', REBASE: 'Rebase and merge' };

function pickMethod(allowed, preferred) {
  const a = allowed || {};
  if (a[preferred]) return preferred.toUpperCase();
  const first = ['squash', 'merge', 'rebase'].find((m) => a[m]);
  return first ? first.toUpperCase() : null;
}

function createMerger({ vscode, client, tokenFor, tracker, pollNow, preferred, onBusyChange = () => {}, onMerged = () => {} }) {
  const inFlight = new Set();

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

    inFlight.add(url);
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

  return { merge, busy: (url) => inFlight.has(url) };
}

module.exports = { createMerger, pickMethod, METHOD_LABEL };
