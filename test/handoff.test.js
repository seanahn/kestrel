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
