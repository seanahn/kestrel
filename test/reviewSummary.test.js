'use strict';
// The review bot summary (design 101, "The review bot summary").
const test = require('node:test'); const assert = require('node:assert');
const { parseSummary, summaryForHead } = require('../src/reviewSummary');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const marker = (json) => `Looks fine.\n<!-- pr-auto-review-findings: ${b64(json)} -->`;

test('parses blocker and finding counts', () => {
  assert.deepStrictEqual(parseSummary(marker('{"blockers":[{"a":1}],"findings":[1,2]}')), { blockers: 1, findings: 2 });
});

test('no marker gives null', () => {
  assert.strictEqual(parseSummary('just a review'), null);
  assert.strictEqual(parseSummary(''), null);
  assert.strictEqual(parseSummary(null), null);
});

test('bad base64 or bad JSON gives null', () => {
  assert.strictEqual(parseSummary('<!-- pr-auto-review-findings: !!! -->'), null);
  assert.strictEqual(parseSummary(marker('not json')), null);
  assert.strictEqual(parseSummary(marker('null')), null);
});

test('missing arrays count as 0', () => {
  assert.deepStrictEqual(parseSummary(marker('{"blockers":[]}')), { blockers: 0, findings: 0 });
  assert.deepStrictEqual(parseSummary(marker('{}')), { blockers: 0, findings: 0 });
});

const rev = (n, oid, at) => ({ body: marker(`{"blockers":${JSON.stringify(Array(n).fill(0))}}`), commitOid: oid, submittedAt: at });

test('summaryForHead uses the newest marked review when it is on head', () => {
  const reviews = [rev(3, 'old', '2026-01-01T00:00:00Z'), rev(1, 'head', '2026-01-02T00:00:00Z'), { body: 'plain', commitOid: 'head', submittedAt: '2026-01-03T00:00:00Z' }];
  assert.deepStrictEqual(summaryForHead(reviews, 'head'), { blockers: 1, findings: 0 });
});

test('summaryForHead is null when the newest marked review is not on head, even if an older one is', () => {
  const reviews = [rev(2, 'head', '2026-01-01T00:00:00Z'), rev(0, 'old', '2026-01-02T00:00:00Z')];
  assert.strictEqual(summaryForHead(reviews, 'head'), null);
});

test('summaryForHead is null without marked reviews', () => {
  assert.strictEqual(summaryForHead([], 'head'), null);
  assert.strictEqual(summaryForHead([{ body: 'x', commitOid: 'head', submittedAt: '2026-01-01T00:00:00Z' }], 'head'), null);
});
