'use strict';
// The repo is public: no tracked file path, file or commit message may contain a word from the gitignored
// .private-words (design: notes/101). One case-insensitive word per line; blank lines ignored.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const wordsFile = path.join(root, '.private-words');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where any word turns up: `label:line` per hit. files: tracked paths; read(f): text or null (binary, missing). */
function scanRepo(words, { files, read, log }) {
  const res = words.map((w) => new RegExp(`\\b${esc(w)}\\b`, 'i'));
  const found = [];
  const scan = (label, text) => text.split('\n').forEach((line, i) => { if (res.some((r) => r.test(line))) found.push(`${label}:${i + 1}`); });
  for (const f of files) {
    if (res.some((r) => r.test(f))) found.push(`path:${f}`);
    const text = read(f);
    if (text !== null) scan(f, text);
  }
  scan('git log', log);
  return found;
}

test('scanRepo finds a word in file text and commit messages', () => {
  const read = (f) => ({ 'a.md': 'fine\nzebracorp here', 'b.bin': null, 'docs/zebracorp-notes.md': 'clean' })[f];
  const found = scanRepo(['ZebraCorp'], { files: ['a.md', 'b.bin', 'docs/zebracorp-notes.md'], read, log: 'feat: x\n\nfor Zebracorp' });
  assert.ok(found.includes('a.md:2'));
  assert.ok(found.includes('git log:3'));
});

test('scanRepo finds a word in a tracked file path', () => {
  const found = scanRepo(['zebracorp'], { files: ['docs/zebracorp-notes.md'], read: () => 'clean', log: '' });
  assert.deepStrictEqual(found, ['path:docs/zebracorp-notes.md']);
});

test('no private word in tracked paths, files or commit messages', (t) => {
  if (!fs.existsSync(wordsFile)) return t.skip('no .private-words');
  const words = fs.readFileSync(wordsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!words.length) return t.skip('.private-words is empty');
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const read = (f) => {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    return buf.includes(0) ? null : buf.toString('utf8');
  };
  const found = scanRepo(words, { files: git('ls-files').split('\n').filter(Boolean), read, log: git('log', '--format=%B') });
  assert.deepStrictEqual(found, []);
});
