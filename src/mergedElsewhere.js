'use strict';
// A PR merged outside kestrel (on GitHub, by someone else) leaves the list like any closed PR. When one leaves, ask
// GitHub whether it was merged, and if so tell perch, as the panel's merge does (design 101, "Merged elsewhere").
// One at a time; a failed lookup is logged and dropped, never retried.
function createMergeWatch({ prByUrl, tokenFor, noteMerged, log = () => {} }) {
  let chain = Promise.resolve();

  async function check(row) {
    const { url, account } = row.pr;
    try {
      const pr = await prByUrl(await tokenFor(account), url);
      if (!pr || pr.state !== 'MERGED') return;
      const r = await noteMerged(url);
      log(`${url} was merged outside kestrel; perch: ${r ? r.result : 'not installed'}`);
    } catch (e) {
      log(`${url} left the list; could not check whether it was merged: ${(e && e.message) || e}`);
    }
  }

  /** Rows that left the list (tracker.onLeft). Returns when all have been checked. */
  function handle(rows) {
    for (const row of rows) chain = chain.then(() => check(row));
    return chain;
  }

  return { handle };
}

module.exports = { createMergeWatch };
