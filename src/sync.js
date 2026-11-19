'use strict';
// One sync round (design 101, "Accounts", "The query", "Polling"): for each gh account list the open PRs cheaply,
// fetch details only for PRs that changed, and hand the rows to the tracker.
const { NoGhError } = require('./accounts');

const FAST_WINDOW_MS = 300000;
const RATE_FLOOR = 200;
const NO_GH_RETRY_MS = 30000;
const MIN_RATE_WAIT_MS = 5000;
const PROBABLY_RUNNING = new Set(['PENDING', 'EXPECTED']);
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

const expired = (login) => `${login}: gh login expired, run \`gh auth login\``;
const fingerprint = (i) => [i.updatedAt, i.headOid, i.mergeable, i.mergeState, i.isDraft, i.reviewDecision, i.rollup].join('|');
const pad = (n) => String(n).padStart(2, '0');

function rateError(message, retryAfterMs, local = false) {
  return Object.assign(new Error(message), { kind: 'rate', retryAfterMs, local });
}

function createSync({ accounts, client, tracker, now, onRound = () => {} }) {
  const caches = new Map();   // login -> Map(pr id -> { key, pr })
  const watched = new Set();  // urls to keep fetching until a list returns them, the PR closes, or it is merged here
  const lastSeen = new Map(); // watched url -> last Pr fetched, kept in the rows when a fetch is skipped or fails
  let fastUntil = 0;
  let logins = [];            // the account list, reused until a relist
  let relist = true;          // list accounts before the next round: start, Refresh, settings, after a drop or no gh

  const cacheFor = (login) => { if (!caches.has(login)) caches.set(login, new Map()); return caches.get(login); };

  /** List + detail for one account with one token. Returns { items, prs, rates }; the cache is updated only on success. */
  async function fetchAccount(login, token) {
    const cache = cacheFor(login);
    const rates = [];
    const listed = await client.listPrs(token);
    rates.push(listed.rateLimit);
    const need = listed.items.filter((i) => {
      const c = cache.get(i.id);
      return !c || c.key !== fingerprint(i) || PROBABLY_RUNNING.has(i.rollup);
    });
    const fetched = new Map();
    if (need.length) {
      const d = await client.detailPrs(token, need.map((i) => i.id));
      rates.push(d.rateLimit);
      for (const pr of d.prs) fetched.set(pr.id, pr);
    }
    const prs = [];
    const keep = new Set();
    for (const i of listed.items) {
      keep.add(i.id);
      const pr = fetched.get(i.id);
      if (pr) cache.set(i.id, { key: fingerprint(i), pr: { ...pr, account: login } });
      const c = cache.get(i.id);
      if (c) prs.push(c.pr);
    }
    for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
    return { items: listed.items, prs, rates };
  }

  const dropExpired = (login) => { tracker.drop(login, expired(login)); relist = true; };

  /** One account's round; null when it failed (the tracker has been told), throws on throttle/offline. */
  async function syncAccount(login) {
    let token;
    try { token = await accounts.token(login); } catch (_) { dropExpired(login); return null; }
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchAccount(login, token);
      } catch (e) {
        const kind = e && e.kind;
        if (kind === 'auth') {
          if (attempt > 0) { dropExpired(login); return null; }
          try { token = await accounts.token(login, { fresh: true }); } catch (_) { dropExpired(login); return null; }
          continue;
        }
        if (kind === 'partial' || kind === 'http' || kind === 'refused') { tracker.fail(login, `${login}: ${e.message}`); return null; }
        throw e;
      }
    }
  }

  /** Lists accounts again. A login that was listed and now isn't is dropped: quietly if kestrel.accounts left it out,
   * else with the expired note (gh no longer has it). */
  async function listAccounts() {
    let next;
    try { next = await accounts.list(); } catch (e) {
      if (e instanceof NoGhError) { tracker.setGlobalNote(e.message); throw rateError(e.message, NO_GH_RETRY_MS, true); }
      throw e;
    }
    tracker.setGlobalNote(null);
    for (const l of logins) {
      if (next.includes(l)) continue;
      if (!accounts.isAllowed || accounts.isAllowed(l)) tracker.drop(l, expired(l)); else tracker.drop(l, '');
    }
    logins = next;
    relist = false;
  }

  async function run() {
    if (relist) await listAccounts();

    const results = [];   // { login, prs, items }
    const rates = [];
    let failure = null;
    const fresh = new Set();   // watched urls fetched this round
    try {
      for (const login of logins) {
        const r = await syncAccount(login);
        if (!r) continue;
        results.push({ login, prs: r.prs });
        rates.push(...r.rates);
        onRound({ login, count: r.prs.length, cost: r.rates.reduce((sum, x) => sum + ((x && x.cost) || 0), 0) });
        for (const i of r.items) { watched.delete(i.url); lastSeen.delete(i.url); }
      }
      if (watched.size && results.length) {
        const first = results[0];
        const token = await accounts.token(first.login).catch(() => null);
        if (token) {
          for (const url of [...watched]) {
            let pr = null;
            try { pr = await client.prByUrl(token, url); } catch (e) {
              if (e && (e.kind === 'throttle' || e.kind === 'offline' || e.kind === 'rate')) throw e;
              continue;
            }
            // Only an open PR that one of the signed-in accounts authored; it belongs to that account.
            const owner = pr && pr.state === 'OPEN' ? logins.find((l) => l === pr.author) : undefined;
            if (!owner) { watched.delete(url); lastSeen.delete(url); continue; }
            pr = { ...pr, account: owner };
            lastSeen.set(url, pr); fresh.add(url);
            const r = results.find((x) => x.login === owner);
            if (r) r.prs = [...r.prs, pr];
          }
        }
      }
    } catch (e) { failure = e; }

    // A watched row goes only when its PR is gone or listed; a skipped or failed fetch keeps the last copy.
    for (const url of watched) {
      const seen = !fresh.has(url) && lastSeen.get(url);
      const r = seen && results.find((x) => x.login === seen.account);
      if (r) r.prs = [...r.prs, seen];
    }
    for (const r of results) { tracker.apply(r.login, r.prs); tracker.clearNote(r.login); }
    if (failure) throw failure;

    const known = rates.filter((r) => r && r.resetAt && Number.isFinite(Date.parse(r.resetAt)));
    if (known.length) {
      const low = known.reduce((a, b) => (b.remaining < a.remaining ? b : a));
      if (low.remaining < RATE_FLOOR) {
        const reset = Date.parse(low.resetAt);
        const d = new Date(reset);
        throw rateError(`GitHub rate limit, resuming at ${pad(d.getHours())}:${pad(d.getMinutes())}`, Math.max(MIN_RATE_WAIT_MS, reset - now()));
      }
    }
  }

  return {
    run,
    relist() { relist = true; },
    /** Watches a github.com PR url; false (and nothing changes) for anything else. */
    watch(url) {
      if (typeof url !== 'string' || !PR_URL.test(url)) return false;
      watched.add(url); fastUntil = now() + FAST_WINDOW_MS;
      return true;
    },
    unwatch(url) { watched.delete(url); lastSeen.delete(url); },
    fast() { fastUntil = now() + FAST_WINDOW_MS; },
    fastUntil: () => fastUntil,
    tokenFor: (login) => accounts.token(login),
  };
}

module.exports = { createSync, FAST_WINDOW_MS, RATE_FLOOR };
