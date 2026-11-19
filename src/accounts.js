'use strict';
// gh accounts and tokens (design 101, "Accounts"): the logins the gh CLI holds for github.com, and each one's token.
const { execFile } = require('node:child_process');

const HOST = 'github.com';
// "Failed to log in" lines are known accounts too: gh checks tokens online, so offline every login may fail here.
// GitHub's answer (a 401, or a network error) decides between an expired login and being offline.
const KNOWN = /(?:Logged in to|Failed to log in to) github\.com account (\S+)/;

class NoGhError extends Error {
  constructor() { super('Sign in with `gh auth login`'); this.name = 'NoGhError'; }
}

/** Logins from `gh auth status` text, in order, unique, including failed ("Failed to log in") ones. */
function parseAuthStatus(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = KNOWN.exec(line);
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
  const only = () => (allowed && allowed()) || [];
  return {
    /** False when kestrel.accounts is set and leaves this login out. */
    isAllowed: (login) => !only().length || only().includes(login),
    async list() {
      const r = await run(['auth', 'status', '--hostname', HOST]);
      if (r.code === 127) throw new NoGhError();
      let logins = parseAuthStatus(`${r.stdout}\n${r.stderr}`);
      if (only().length) logins = logins.filter((l) => only().includes(l));
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
