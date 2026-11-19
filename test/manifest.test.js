'use strict';
// What ships: package.json for the Marketplace (design: notes/101), and nothing private in the package.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Files vsce would package: tracked files minus the .vscodeignore patterns (the simple forms chirp uses). */
function shipped() {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const hit = (f, p) => (p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : p.startsWith('*.') ? f.endsWith(p.slice(1)) : f === p);
  return out.filter((f) => !ignore.some((p) => hit(f, p)));
}

test('identity and engine', () => {
  assert.strictEqual(pkg.name, 'kestrel-prs');
  assert.strictEqual(pkg.version, '0.1.0');
  assert.strictEqual(pkg.publisher, 'seanahn');
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.main, './src/extension.js');
  assert.strictEqual(Object.keys(pkg.dependencies || {}).length, 0);
  assert.deepStrictEqual(pkg.activationEvents, ['onStartupFinished']);
});

test('panel view, commands and settings', () => {
  const c = pkg.contributes;
  assert.deepStrictEqual(c.viewsContainers.panel, [{ id: 'kestrel', title: 'PRs', icon: 'media/pr.svg' }]);
  assert.deepStrictEqual(c.views.kestrel, [{ type: 'webview', id: 'kestrel.prs', name: 'PRs' }]);
  const refresh = c.commands.find((x) => x.command === 'kestrel.refresh');
  assert.strictEqual(refresh.title, 'kestrel: Refresh');
  assert.strictEqual(refresh.icon, '$(refresh)');
  assert.ok(c.menus['view/title'].some((m) => m.command === 'kestrel.refresh' && m.when === 'view == kestrel.prs' && m.group === 'navigation@1'));
  assert.ok(c.commands.some((x) => x.command === 'kestrel.watch'));
  assert.ok(c.menus.commandPalette.some((m) => m.command === 'kestrel.watch' && m.when === 'false'));
  const props = c.configuration.properties;
  assert.strictEqual(props['kestrel.accounts'].type, 'array');
  assert.strictEqual(props['kestrel.accounts'].items.type, 'string');
  assert.deepStrictEqual(props['kestrel.accounts'].default, []);
  assert.deepStrictEqual(props['kestrel.mergeMethod'].enum, ['squash', 'merge', 'rebase']);
  assert.strictEqual(props['kestrel.mergeMethod'].default, 'squash');
});

test('the listing icon is a 128x128 PNG', () => {
  const png = fs.readFileSync(path.join(root, pkg.icon));
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [128, 128]);
});

test('development files do not ship', () => {
  const files = shipped();
  assert.ok(files.includes('src/extension.js'), 'the scan sees the shipped files');
  for (const f of files) {
    assert.ok(!f.startsWith('test/') && !f.startsWith('docs/') && !f.startsWith('.superpowers/'), f);
    assert.ok(f !== 'Makefile' && f !== '.private-words', f);
  }
});
