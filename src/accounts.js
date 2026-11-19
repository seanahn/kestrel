'use strict';
// gh accounts and tokens (design 101, "Accounts"): the logins the gh CLI holds for github.com, and each one's token.
const { execFile } = require('node:child_process');

const HOST = 'github.com';
const LOGGED_IN = /Logged in to github\.com account (\S+)/;

class NoGhError extends Error {
  constructor() { super('Sign in with `gh auth login`'); this.name = 'NoGhError'; }
}

/** Logins from `gh auth status` text, in order, unique. Failed ("Failed to log in") lines don't match. */
function parseAuthStatus(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = LOGGED_IN.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Runs gh. Resolves, never rejects; a missing gh is code 127. */
function defaultRun(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (err.code === 'ENOENT') return resolve({ code: 127, stdout: '', stderr: String(err.message) });
      resolve({ code: typeof err.code === 'number' ? err.code : 1, stdout: stdout || '', stderr: stderr || String(err.message) });
    });
  });
}

function createAccounts({ run, allowed }) {
  const tokens = new Map();
  return {
    async list() {
      const r = await run(['auth', 'status', '--hostname', HOST]);
      if (r.code === 127) throw new NoGhError();
      let logins = parseAuthStatus(`${r.stdout}\n${r.stderr}`);
      const only = (allowed && allowed()) || [];
      if (only.length) logins = logins.filter((l) => only.includes(l));
      if (!logins.length) throw new NoGhError();
      return logins;
    },
    async token(login, opts) {
      if (!(opts && opts.fresh) && tokens.has(login)) return tokens.get(login);
      const r = await run(['auth', 'token', '--hostname', HOST, '--user', login]);
      const t = String(r.stdout || '').trim();
      if (r.code !== 0 || !t) throw new Error(`${login}: gh login expired, run \`gh auth login\``);
      tokens.set(login, t);
      return t;
    },
  };
}

module.exports = { parseAuthStatus, createAccounts, NoGhError, defaultRun };
