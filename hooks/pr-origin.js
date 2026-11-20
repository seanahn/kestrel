#!/usr/bin/env node
'use strict';
// A Claude Code PostToolUse hook (design 101, "Where a PR was made"). After a Bash call that ran `gh pr create`,
// it adds a hidden record to the new PR's description: the machine, the Claude Code session, its folder and its
// transcript. kestrel reads it back from GitHub, so every window on every machine can say where the PR was made.
//
// Install in ~/.claude/settings.json (KESTREL_MACHINE names the machine; the hostname otherwise):
//   "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [
//     { "type": "command", "command": "KESTREL_MACHINE=desktop node /path/to/kestrel/hooks/pr-origin.js" } ] } ] }
//
// It never blocks or fails Claude: it answers at once, does the GitHub edit in a detached process, and logs
// problems to ~/.cache/kestrel/pr-origin.log. No dependencies; needs `gh` signed in to an account that can edit the PR.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*/g;
const MARK = /<!--\s*pr-origin:\s*[A-Za-z0-9+/=]+\s*-->/;
const LOG = path.join(os.homedir(), '.cache', 'kestrel', 'pr-origin.log');

function log(line) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch (_) { /* never fail the hook */ }
}

/** The PR URL a `gh pr create` printed, or null when this call wasn't one. */
function createdPrUrl(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  const command = (input.tool_input && input.tool_input.command) || '';
  if (!/\bgh\s+pr\s+create\b/.test(command)) return null;
  const r = input.tool_response || {};
  const out = typeof r === 'string' ? r : `${r.stdout || ''}\n${r.stderr || ''}`;
  const urls = out.match(PR_URL);
  return urls ? urls[urls.length - 1] : null;
}

/** The hidden record for the PR description. */
function originMarker(input, env = process.env, now = new Date()) {
  const origin = {
    host: env.KESTREL_MACHINE || os.hostname(),
    session: input.session_id || null,
    cwd: input.cwd || null,
    transcript: input.transcript_path || null,
    at: now.toISOString(),
  };
  return `<!-- pr-origin: ${Buffer.from(JSON.stringify(origin)).toString('base64')} -->`;
}

/** The description with the record added, or null when it already has one. */
function withMarker(body, marker) {
  if (MARK.test(body || '')) return null;
  return `${(body || '').replace(/\s+$/, '')}\n\n${marker}\n`;
}

function apply(url, marker) {
  try {
    const body = execFileSync('gh', ['pr', 'view', url, '--json', 'body', '-q', '.body'], { encoding: 'utf8', timeout: 30000 });
    const next = withMarker(body, marker);
    if (next === null) { log(`${url}: already has a pr-origin record`); return; }
    execFileSync('gh', ['pr', 'edit', url, '--body-file', '-'], { input: next, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'ignore', 'pipe'] });
    log(`${url}: recorded`);
  } catch (e) {
    log(`${url}: ${String((e && (e.stderr || e.message)) || e).trim().split('\n').slice(-2).join(' ')}`);
  }
}

function main() {
  if (process.argv[2] === '--apply') { apply(process.argv[3], process.argv[4]); return; }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const url = createdPrUrl(input);
      if (!url) return;
      const child = spawn(process.execPath, [__filename, '--apply', url, originMarker(input)], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) { log(`hook input: ${e.message}`); }
  });
}

if (require.main === module) main();
module.exports = { createdPrUrl, originMarker, withMarker, MARK };
