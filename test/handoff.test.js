'use strict';
// Hand-off to the agent (design 101, "Handing a prompt to the agent").
const test = require('node:test'); const assert = require('node:assert');
const { install } = require('./vscodeStub');
const { createHandoff } = require('../src/handoff');

test('hand-off to perch when perch.insertText accepts it', async () => {
  const { vscode, ui } = install();
  ui.extraCommands = ['perch.insertText'];
  ui.extraHandlers['perch.insertText'] = () => true;
  assert.strictEqual(await createHandoff(vscode).send('fix it'), 'perch');
  assert.deepStrictEqual(ui.executed, [['perch.insertText', 'fix it']]);
  assert.deepStrictEqual(ui.copied, []);
});

test('perch returning false falls back to the clipboard with a status message', async () => {
  const { vscode, ui } = install();
  ui.extraCommands = ['perch.insertText'];
  ui.extraHandlers['perch.insertText'] = () => false;
  assert.strictEqual(await createHandoff(vscode).send('fix it'), 'clipboard');
  assert.deepStrictEqual(ui.copied, ['fix it']);
  assert.deepStrictEqual(ui.status, [{ text: 'Prompt copied. Paste it into your agent.', ms: 4000 }]);
});

test('perch throwing falls back to the clipboard', async () => {
  const { vscode, ui } = install();
  ui.extraCommands = ['perch.insertText'];
  ui.extraHandlers['perch.insertText'] = () => { throw new Error('boom'); };
  assert.strictEqual(await createHandoff(vscode).send('x'), 'clipboard');
  assert.deepStrictEqual(ui.copied, ['x']);
});

test('no perch: clipboard', async () => {
  const { vscode, ui } = install();
  assert.strictEqual(await createHandoff(vscode).send('x'), 'clipboard');
  assert.deepStrictEqual(ui.executed, []);
  assert.strictEqual(ui.status.length, 1);
});

test('perch installed later is picked up on extensions change', async () => {
  const { vscode, ui } = install();
  const h = createHandoff(vscode);
  assert.strictEqual(await h.send('a'), 'clipboard');
  ui.extraCommands = ['perch.insertText'];
  ui.extraHandlers['perch.insertText'] = () => true;
  ui.extensionsChanged.fire();
  assert.strictEqual(await h.send('b'), 'perch');
});

test('noteMerged tells perch which PR merged, and nothing else happens', async () => {
  const { vscode, ui } = install();
  ui.extraCommands = ['perch.insertText', 'perch.notePrMerged'];
  ui.extraHandlers['perch.notePrMerged'] = () => ({ result: 'background', sessionId: 'abc' });
  const url = 'https://github.com/acme/widgets/pull/7';
  assert.deepStrictEqual(await createHandoff(vscode).noteMerged(url), { result: 'background', sessionId: 'abc' });
  assert.deepStrictEqual(ui.executed, [['perch.notePrMerged', url]]);
  assert.deepStrictEqual(ui.copied, []);
  assert.deepStrictEqual(ui.status, []);
});

test('noteMerged without perch, or with an older perch, does nothing', async () => {
  const a = install();
  assert.strictEqual(await createHandoff(a.vscode).noteMerged('https://github.com/acme/widgets/pull/7'), null);
  assert.deepStrictEqual(a.ui.executed, []);
  const b = install();
  b.ui.extraCommands = ['perch.insertText'];
  assert.strictEqual(await createHandoff(b.vscode).noteMerged('https://github.com/acme/widgets/pull/7'), null);
  assert.deepStrictEqual(b.ui.executed, []);
});

test('noteMerged never throws when perch fails', async () => {
  const { vscode, ui } = install();
  ui.extraCommands = ['perch.notePrMerged'];
  ui.extraHandlers['perch.notePrMerged'] = () => { throw new Error('boom'); };
  assert.deepStrictEqual(await createHandoff(vscode).noteMerged('https://github.com/acme/widgets/pull/7'), { result: 'failed', error: 'boom' });
});

test('findSession and openSession go to perch when it has them', async () => {
  const { vscode, ui } = install();
  ui.extraCommands = ['perch.findPrSession', 'perch.openPrSession'];
  ui.extraHandlers['perch.findPrSession'] = () => ({ session: 's1', cwd: '/w', transcript: '/t/s1.jsonl', host: 'devbox', created: true });
  ui.extraHandlers['perch.openPrSession'] = () => 'resumed';
  const h = createHandoff(vscode);
  const url = 'https://github.com/acme/widgets/pull/7';
  assert.deepStrictEqual(await h.findSession(url), { session: 's1', cwd: '/w', transcript: '/t/s1.jsonl', host: 'devbox', created: true });
  assert.strictEqual(await h.openSession({ url, session: 's1' }), 'resumed');
  assert.deepStrictEqual(ui.executed, [['perch.findPrSession', url], ['perch.openPrSession', { url, session: 's1' }]]);
});

test('without those perch commands, or when perch fails: no session, nothing opened', async () => {
  const a = install();
  a.ui.extraCommands = ['perch.insertText'];
  const h = createHandoff(a.vscode);
  assert.strictEqual(await h.findSession('https://github.com/acme/widgets/pull/7'), null);
  assert.strictEqual(await h.openSession({ url: 'https://github.com/acme/widgets/pull/7' }), 'none');
  assert.deepStrictEqual(a.ui.executed, []);
  const b = install();
  b.ui.extraCommands = ['perch.findPrSession', 'perch.openPrSession'];
  b.ui.extraHandlers['perch.findPrSession'] = () => { throw new Error('x'); };
  b.ui.extraHandlers['perch.openPrSession'] = () => { throw new Error('x'); };
  const g = createHandoff(b.vscode);
  assert.strictEqual(await g.findSession('https://github.com/acme/widgets/pull/7'), null);
  assert.strictEqual(await g.openSession({ url: 'https://github.com/acme/widgets/pull/7' }), 'none');
});

test('canOpenSessions says whether perch can open a PR\'s chat', async () => {
  const a = install(); a.ui.extraCommands = ['perch.openPrSession'];
  assert.strictEqual(await createHandoff(a.vscode).canOpenSessions(), true);
  const b = install(); b.ui.extraCommands = ['perch.insertText'];
  assert.strictEqual(await createHandoff(b.vscode).canOpenSessions(), false);
});
