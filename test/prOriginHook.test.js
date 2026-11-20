'use strict';
// The pr-origin hook (design 101, "Where a PR was made").
const test = require('node:test'); const assert = require('node:assert');
const { createdPrUrl, originMarker, withMarker } = require('../hooks/pr-origin');
const { parseOrigin } = require('../src/origin');

const call = (command, stdout) => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' },
  session_id: '3f2a9c1e-0000-4000-8000-000000000001', cwd: '/home/dev/widgets', transcript_path: '/home/dev/.claude/projects/-home-dev-widgets/3f2a9c1e-0000-4000-8000-000000000001.jsonl' });

test('only a gh pr create that printed a PR URL counts', () => {
  assert.strictEqual(createdPrUrl(call('gh pr create --fill', 'https://github.com/acme/widgets/pull/42\n')), 'https://github.com/acme/widgets/pull/42');
  assert.strictEqual(createdPrUrl(call('cd x && gh pr create --title t --body b', 'Creating...\nhttps://github.com/acme/widgets/pull/7\n')), 'https://github.com/acme/widgets/pull/7');
  assert.strictEqual(createdPrUrl(call('gh pr view 42', 'https://github.com/acme/widgets/pull/42')), null);
  assert.strictEqual(createdPrUrl(call('gh pr create', 'error: no commits')), null);
  assert.strictEqual(createdPrUrl({ tool_name: 'Read', tool_input: { command: 'gh pr create' } }), null);
});

test('the record round-trips through kestrel, and is added once', () => {
  const m = originMarker(call('gh pr create', ''), { KESTREL_MACHINE: 'desktop' }, new Date('2026-11-20T01:02:03Z'));
  assert.deepStrictEqual(parseOrigin(`Body text\n\n${m}\n`), {
    host: 'desktop', session: '3f2a9c1e-0000-4000-8000-000000000001', cwd: '/home/dev/widgets',
    transcript: '/home/dev/.claude/projects/-home-dev-widgets/3f2a9c1e-0000-4000-8000-000000000001.jsonl', at: '2026-11-20T01:02:03.000Z',
  });
  const once = withMarker('Body text\n', m);
  assert.strictEqual(once, `Body text\n\n${m}\n`);
  assert.strictEqual(withMarker(once, m), null);
  assert.strictEqual(withMarker('', m), `\n\n${m}\n`);
});
