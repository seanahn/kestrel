'use strict';
// Row state (design 101, "States"): the first matching rule of the state table decides the row.
const { summaryForHead } = require('./reviewSummary');

const ACTIONABLE_RULES = [2, 3, 4, 5, 7, 9];
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The "+ N findings" / "+ N unresolved comments" chip beside the main state, or null. */
function extraFor(pr, summary, ref) {
  if (summary && summary.findings > 0) {
    return { text: plural(summary.findings, 'finding'), prompt: `check the findings on PR ${ref} (${pr.url})` };
  }
  if (!summary && pr.unresolvedThreads > 0) {
    return { text: plural(pr.unresolvedThreads, 'unresolved comment'), prompt: `check the unresolved review comments on PR ${ref} (${pr.url})` };
  }
  return null;
}

/** RowState for a normalized PR. */
function rowState(pr) {
  const ref = `${pr.repo}#${pr.number}`;
  const checks = pr.checks || [];
  const failed = checks.filter((c) => c.state === 'failure');
  const summary = summaryForHead(pr.reviews, pr.headOid);
  const out = (rule, key, text, dot, action, withExtra = true) => ({
    rule, key, text, dot, actionable: ACTIONABLE_RULES.includes(rule), action,
    extra: withExtra ? extraFor(pr, summary, ref) : null,
  });
  const ask = (p) => ({ kind: 'prompt', prompt: p });

  if (pr.isDraft) {
    return out(1, '1', 'draft', 'dim', ask(`PR ${ref} is a draft; check whether it is ready to mark ready for review (${pr.url})`), false);
  }
  if (pr.mergeable === 'CONFLICTING') {
    return out(2, '2', 'conflicts', 'red', ask(`resolve the merge conflicts on PR ${ref} (${pr.url})`));
  }
  if (failed.length) {
    const more = failed.length - 1;
    return out(3, `3:${failed[0].name}`, `CI failed: ${failed[0].name}${more > 0 ? ` and ${more} more` : ''}`, 'red',
      ask(`check the failing \`${failed[0].name}\` check on PR ${ref} (${pr.url})`));
  }
  if (summary && summary.blockers > 0) {
    return out(4, `4:${summary.blockers}`, plural(summary.blockers, 'blocker'), 'red',
      ask(`check the blocker comments on PR ${ref} (${pr.url})`), false);
  }
  const running = checks.some((c) => c.state === 'pending');
  // A request for changes on an older commit is about to be replaced when checks (the reviewer among them) are still
  // running on the head: show them running until the new review lands (design 101, "States", rule 5).
  const requests = (pr.reviews || []).filter((r) => r.state === 'CHANGES_REQUESTED');
  const staleRequest = running && requests.length > 0 && !requests.some((r) => r.commitOid === pr.headOid);
  if (pr.reviewDecision === 'CHANGES_REQUESTED' && !staleRequest) {
    return out(5, '5', 'changes requested', 'red', ask(`check the requested changes on PR ${ref} (${pr.url})`));
  }
  if (running || pr.mergeable === 'UNKNOWN' || pr.mergeState === 'UNKNOWN') {
    const done = checks.filter((c) => c.state !== 'pending').length;
    return out(6, '6', checks.length ? `checks ${done}/${checks.length}` : 'waiting for GitHub', 'running', null, false);
  }
  if (pr.mergeState === 'BEHIND') {
    return out(7, '7', 'behind base', 'red', { kind: 'update', prompt: `update PR ${ref} with its base branch (${pr.url})` });
  }
  if (!['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeState)) {
    return out(8, '8', pr.reviewDecision === 'REVIEW_REQUIRED' ? 'blocked: needs review' : 'blocked', 'dim', { kind: 'open' });
  }
  return out(9, '9', 'merge', 'green', { kind: 'merge' });
}

module.exports = { rowState, ACTIONABLE_RULES };
