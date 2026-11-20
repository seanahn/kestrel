'use strict';
// The review bot summary (design 101, "The review bot summary"): a hidden marker in a review body carrying base64 JSON.
const MARKER = /<!--\s*pr-auto-review-findings:\s*([A-Za-z0-9+/=]+)\s*-->/;

/** { blockers, findings } counts and the blockers' text (`reasons`) from a review body, or null without a marker. */
function parseSummary(body) {
  const m = MARKER.exec(typeof body === 'string' ? body : '');
  if (!m) return null;
  let data;
  try { data = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const reasons = Array.isArray(data.blockers) ? data.blockers.filter((b) => typeof b === 'string').map((b) => b.slice(0, 300)) : [];
  return { blockers: count(data.blockers), findings: count(data.findings), reasons };
}

/** The summary of the newest marked review, only if that review was made on headOid. */
function summaryForHead(reviews, headOid) {
  let best = null;
  for (const r of reviews || []) {
    const s = parseSummary(r.body);
    if (s && (!best || Date.parse(r.submittedAt) > Date.parse(best.r.submittedAt))) best = { r, s };
  }
  return best && best.r.commitOid === headOid ? best.s : null;
}

module.exports = { parseSummary, summaryForHead };
