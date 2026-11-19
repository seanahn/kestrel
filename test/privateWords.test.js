'use strict';
// The repo is public: no tracked file or commit message may contain a word from the gitignored .private-words
// (design: notes/101). One case-insensitive word per line; blank lines ignored.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const wordsFile = path.join(root, '.private-words');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('no private word in tracked files or commit messages', (t) => {
  if (!fs.existsSync(wordsFile)) return t.skip('no .private-words');
  const words = fs.readFileSync(wordsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const res = words.map((w) => new RegExp(`\\b${esc(w)}\\b`, 'i'));
  const found = [];
  const scan = (label, text) => text.split('\n').forEach((line, i) => { if (res.some((r) => r.test(line))) found.push(`${label}:${i + 1}`); });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  for (const f of git('ls-files').split('\n').filter(Boolean)) {
    if (!fs.existsSync(path.join(root, f))) continue;
    const buf = fs.readFileSync(path.join(root, f));
    if (buf.includes(0)) continue;
    scan(f, buf.toString('utf8'));
  }
  scan('git log', git('log', '--format=%B'));
  assert.deepStrictEqual(found, []);
});
