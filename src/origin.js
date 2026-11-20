'use strict';
// Where a PR was made (design 101, "Where a PR was made"): the hidden record the pr-origin hook adds to a PR's
// description, read back. Only well-formed string fields are kept; anything else in the record is ignored.
const MARK = /<!--\s*pr-origin:\s*([A-Za-z0-9+/=]+)\s*-->/g;
const FIELDS = ['host', 'session', 'cwd', 'transcript', 'at'];

/** { host, session, cwd, transcript, at } from the last pr-origin record in a PR description, or null. */
function parseOrigin(body) {
  if (typeof body !== 'string') return null;
  const all = [...body.matchAll(MARK)];
  if (!all.length) return null;
  let data;
  try { data = JSON.parse(Buffer.from(all[all.length - 1][1], 'base64').toString('utf8')); } catch (_) { return null; }
  if (!data || typeof data !== 'object' || typeof data.session !== 'string' || !data.session) return null;
  const out = {};
  for (const k of FIELDS) out[k] = typeof data[k] === 'string' && data[k] ? data[k].slice(0, 500) : null;
  return out;
}

/** The tooltip lines for a PR's origin: from its own record, else from this machine's transcripts, else none. */
function originLines(record, local) {
  const o = record || local;
  if (!o) return ['No Claude chat found for this PR (no record on the PR, none on this machine).'];
  const where = record ? `Made on ${o.host || 'an unnamed machine'}` : `Found on this machine (${o.host || 'here'})`;
  const lines = [`${where} · Claude session ${String(o.session).slice(0, 8)}${o.cwd ? ` · ${o.cwd}` : ''}`];
  if (o.transcript) lines.push(`Transcript: ${o.transcript}`);
  if (record && record.at) lines.push(`Recorded ${record.at.replace('T', ' ').slice(0, 16)} UTC`);
  return lines;
}

module.exports = { parseOrigin, originLines };
