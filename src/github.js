'use strict';
// GitHub GraphQL client (design 101, "The query" and "Polling"): the list query, the detail query, merge, branch update, and
// error mapping (a primary rate limit is kind 'rate', which the poller waits out). Every HTTP call goes through one
// injectable request(token, body).
const https = require('node:https');
const { parseOrigin } = require('./origin');

const ENDPOINT = 'https://api.github.com/graphql';
const SEARCH = 'is:pr is:open author:@me archived:false';
const PAGE = 50;
const MAX_PAGES = 4;
const BATCH = 20;
const TIMEOUT_MS = 20000;
const RATE = 'rateLimit { remaining resetAt cost }';
const MIN_RATE_WAIT_MS = 5000;
const UNKNOWN_RATE_WAIT_MS = 60000;
// Stands in for checks past the first 50: kestrel can't see them, so the PR counts as still running.
const MORE_CHECKS = { name: 'more checks', state: 'pending' };

const LIST_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      id url updatedAt headRefOid mergeable mergeStateStatus isDraft reviewDecision viewerCanUpdateBranch
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
  ${RATE}
}`;

const DETAIL_FIELDS = `
  id number title body url isDraft updatedAt state author { login } viewerCanUpdateBranch
  repository { nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed }
  mergeable mergeStateStatus reviewDecision headRefOid
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { pageInfo { hasNextPage } nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }
  reviews(last: 20) { nodes { author { login } body state commit { oid } submittedAt } }
  reviewThreads(first: 50) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }`;

const DETAIL_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest {${DETAIL_FIELDS} } }
  ${RATE}
}`;

const URL_QUERY = `query($url: URI!) {
  resource(url: $url) { ... on PullRequest {${DETAIL_FIELDS} } }
  ${RATE}
}`;

const MERGE_QUERY = `mutation($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { pullRequest { id } }
}`;

const UPDATE_QUERY = `mutation($input: UpdatePullRequestBranchInput!) {
  updatePullRequestBranch(input: $input) { pullRequest { id } }
}`;

class GitHubError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    if (extra && extra.status !== undefined) this.status = extra.status;
    if (extra && extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/** POSTs a GraphQL body. Rejects only on network errors and timeouts; HTTP statuses resolve. */
function defaultRequest(token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'User-Agent': 'kestrel',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(payload);
  });
}

/** A CheckRun or StatusContext node -> { name, state }. */
function normalizeChecks(contexts) {
  const FAILED_RUN = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
  return (contexts || []).filter(Boolean).map((c) => {
    if (c.__typename === 'StatusContext' || c.context !== undefined) {
      const state = c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending'
        : c.state === 'FAILURE' || c.state === 'ERROR' ? 'failure' : 'success';
      return { name: c.context, state };
    }
    const state = c.status !== 'COMPLETED' ? 'pending' : FAILED_RUN.includes(c.conclusion) ? 'failure' : 'success';
    return { name: c.name, state };
  });
}

const nodesOf = (conn) => (conn && conn.nodes) || [];

function toListItem(n) {
  const commit = nodesOf(n.commits)[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  return {
    id: n.id, url: n.url, updatedAt: n.updatedAt, headOid: n.headRefOid, mergeable: n.mergeable, canUpdateBranch: n.viewerCanUpdateBranch === true,
    mergeState: n.mergeStateStatus, isDraft: n.isDraft, reviewDecision: n.reviewDecision || null,
    rollup: (rollup && rollup.state) || null,
  };
}

function toPr(n) {
  const commit = nodesOf(n.commits)[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  const repo = n.repository || {};
  return {
    id: n.id, url: n.url, number: n.number, title: n.title, repo: repo.nameWithOwner, account: '',
    state: n.state, author: (n.author && n.author.login) || null, origin: parseOrigin(n.body), canUpdateBranch: n.viewerCanUpdateBranch === true,
    isDraft: n.isDraft, updatedAt: n.updatedAt, headOid: n.headRefOid, mergeable: n.mergeable,
    mergeState: n.mergeStateStatus, reviewDecision: n.reviewDecision || null,
    checks: [
      ...normalizeChecks(nodesOf(rollup && rollup.contexts)),
      ...(rollup && rollup.contexts && rollup.contexts.pageInfo && rollup.contexts.pageInfo.hasNextPage ? [MORE_CHECKS] : []),
    ],
    reviews: nodesOf(n.reviews).filter(Boolean).map((r) => ({
      body: r.body || '', state: r.state || null, commitOid: (r.commit && r.commit.oid) || null, submittedAt: r.submittedAt,
    })),
    unresolvedThreads: nodesOf(n.reviewThreads).filter((t) => t && t.isResolved === false).length,
    mergeMethods: { squash: !!repo.squashMergeAllowed, merge: !!repo.mergeCommitAllowed, rebase: !!repo.rebaseMergeAllowed },
  };
}

const header = (headers, name) => {
  for (const k of Object.keys(headers || {})) if (k.toLowerCase() === name) return headers[k];
  return undefined;
};

function retryAfterMs(headers) {
  const v = Number(header(headers, 'retry-after'));
  return Number.isFinite(v) && v >= 0 && header(headers, 'retry-after') !== undefined ? v * 1000 : undefined;
}

const pad = (n) => String(n).padStart(2, '0');

/** A primary rate limit hit: wait until x-ratelimit-reset (epoch seconds), at least 5 s; 60 s when it's missing. */
function rateLimited(headers, now, status) {
  const reset = Number(header(headers, 'x-ratelimit-reset'));
  if (!Number.isFinite(reset) || header(headers, 'x-ratelimit-reset') === undefined) {
    return new GitHubError('rate', 'GitHub rate limit, retrying', { status, retryAfterMs: UNKNOWN_RATE_WAIT_MS });
  }
  const d = new Date(reset * 1000);
  return new GitHubError('rate', `GitHub rate limit, resuming at ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    { status, retryAfterMs: Math.max(MIN_RATE_WAIT_MS, reset * 1000 - now()) });
}

function createClient({ request = defaultRequest, now = Date.now } = {}) {
  /** Sends one body and returns its `data`, or throws a GitHubError. errorKind is the kind for a 200 with errors. */
  async function send(token, body, errorKind) {
    let res;
    try {
      res = await request(token, body);
    } catch (e) {
      throw new GitHubError('offline', (e && e.message) || 'network error');
    }
    const { status, headers, json } = res;
    const msg = (json && json.message) || `HTTP ${status}`;
    if (status === 401) throw new GitHubError('auth', msg, { status });
    if (status === 403 && String(header(headers, 'x-ratelimit-remaining')) === '0') throw rateLimited(headers, now, status);
    const after = retryAfterMs(headers);
    if (status === 429 || (status === 403 && (after !== undefined || /secondary rate limit/i.test(msg)))) {
      throw new GitHubError('throttle', msg, { status, retryAfterMs: after });
    }
    if (status < 200 || status >= 300) throw new GitHubError('http', msg, { status });
    if (json && Array.isArray(json.errors) && json.errors.some((e) => e && e.type === 'RATE_LIMITED')) {
      throw rateLimited(headers, now, status);
    }
    if (json && Array.isArray(json.errors) && json.errors.length) {
      throw new GitHubError(errorKind, String(json.errors[0].message || 'GitHub returned an error'), { status });
    }
    if (!json || typeof json.data !== 'object' || json.data === null) {
      throw new GitHubError('http', 'GitHub returned an unreadable response', { status });
    }
    return json.data;
  }

  /** Folds per-request rateLimit blocks: last remaining/resetAt, summed cost. */
  const addRate = (acc, rl) => (rl ? { remaining: rl.remaining, resetAt: rl.resetAt, cost: acc.cost + (rl.cost || 0) } : acc);
  const noRate = () => ({ remaining: 0, resetAt: '', cost: 0 });

  return {
    async listPrs(token) {
      const items = [];
      let rateLimit = noRate();
      let after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const variables = after ? { q: SEARCH, after } : { q: SEARCH };
        const data = await send(token, { query: LIST_QUERY, variables }, 'partial');
        const search = data.search || {};
        for (const n of nodesOf(search)) if (n && n.id) items.push(toListItem(n));
        rateLimit = addRate(rateLimit, data.rateLimit);
        const info = search.pageInfo || {};
        if (!info.hasNextPage || !info.endCursor) break;
        after = info.endCursor;
      }
      return { items, rateLimit };
    },

    async detailPrs(token, ids) {
      const prs = [];
      let rateLimit = noRate();
      for (let i = 0; i < ids.length; i += BATCH) {
        const data = await send(token, { query: DETAIL_QUERY, variables: { ids: ids.slice(i, i + BATCH) } }, 'partial');
        for (const n of data.nodes || []) if (n && n.id) prs.push(toPr(n));
        rateLimit = addRate(rateLimit, data.rateLimit);
      }
      return { prs, rateLimit };
    },

    async prByUrl(token, url) {
      const data = await send(token, { query: URL_QUERY, variables: { url } }, 'partial');
      const n = data.resource;
      return n && n.id && n.number !== undefined ? toPr(n) : null;
    },

    async merge(token, { id, method, expectedHeadOid }) {
      const input = { pullRequestId: id, mergeMethod: method, expectedHeadOid };
      await send(token, { query: MERGE_QUERY, variables: { input } }, 'refused');
    },

    /** GitHub's "Update branch": merge the base into the PR branch, refused if the head moved past expectedHeadOid. */
    async updateBranch(token, { id, expectedHeadOid }) {
      const input = { pullRequestId: id, expectedHeadOid, updateMethod: 'MERGE' };
      await send(token, { query: UPDATE_QUERY, variables: { input } }, 'refused');
    },
  };
}

module.exports = { createClient, GitHubError, normalizeChecks, defaultRequest };
