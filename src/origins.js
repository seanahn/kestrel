'use strict';
// This machine's answer to "which Claude chat made this PR?" (design 101, "Where a PR was made"), asked of perch
// in the background as PRs appear, one at a time, for PRs whose description has no pr-origin record. A miss is
// asked again after 10 minutes; a hit is kept for the window's life.
const RETRY_MISS_MS = 10 * 60 * 1000;

function createLocalOrigins({ find, onChange = () => {}, now = Date.now }) {
  const found = new Map(); // url -> { origin|null, at }
  const queue = [];
  let busy = false;

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const url = queue.shift();
        let origin = null;
        try { origin = (await find(url)) || null; } catch (_) { origin = null; }
        const before = found.get(url);
        found.set(url, { origin, at: now() });
        if (!before || JSON.stringify(before.origin) !== JSON.stringify(origin)) onChange(url);
      }
    } finally { busy = false; }
  }

  /** Ask for these PRs unless already known (a miss counts as known for 10 minutes) or queued. */
  function want(urls) {
    for (const url of urls) {
      const f = found.get(url);
      if (queue.includes(url) || (f && (f.origin || now() - f.at < RETRY_MISS_MS))) continue;
      queue.push(url);
    }
    return drain();
  }

  return { want, get: (url) => (found.get(url) || {}).origin || null };
}

module.exports = { createLocalOrigins, RETRY_MISS_MS };
