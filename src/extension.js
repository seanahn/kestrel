'use strict';
// Entry point (design 101, "Polling", "Settings"): builds the pieces, wires the commands, settings and window focus
// to the poller, and registers the PRs view. deps ({ run, request, client, timers, now }) is for tests only.
const vscode = require('vscode');
const { createAccounts, defaultRun } = require('./accounts');
const { createClient } = require('./github');
const { createTracker } = require('./tracker');
const { createSync } = require('./sync');
const { createPoller, pickInterval } = require('./poller');
const { createHandoff } = require('./handoff');
const { createMerger } = require('./merge');
const { createLocalOrigins } = require('./origins');
const { createMergeWatch } = require('./mergedElsewhere');
const { PanelProvider } = require('./panel');

let current = null;

function activate(context, deps = {}) {
  const now = deps.now || Date.now;
  const out = vscode.window.createOutputChannel('kestrel');
  const cfg = () => vscode.workspace.getConfiguration('kestrel');
  const log = (line) => { try { out.appendLine(line); } catch (_) { /* the channel is gone */ } };
  const describe = (e) => `${(e && e.message) || e}${e && e.stack ? ` (${String(e.stack).split('\n')[1] || ''})`.replace(' ()', '') : ''}`;

  const accounts = createAccounts({ run: deps.run || defaultRun, allowed: () => cfg().get('accounts', []) });
  const client = deps.client || createClient(deps.request ? { request: deps.request } : {});
  const tracker = createTracker({ now });
  const stored = context.globalState ? context.globalState.get('kestrel.hidden', []) : [];
  tracker.setHidden(Array.isArray(stored) ? stored : []);
  tracker.onHiddenChange((urls, entries) => { if (context.globalState) context.globalState.update('kestrel.hidden', entries); });
  const sync = createSync({
    accounts, client, tracker, now,
    onRound: ({ login, count, cost }) => log(`${new Date(now()).toISOString()} ${login}: ${count} PRs, cost ${cost}`),
  });

  const poller = createPoller({
    run: sync.run,
    interval: () => pickInterval({ focused: vscode.window.state.focused, anyRunning: tracker.anyRunning(), fastUntil: sync.fastUntil(), now: now() }),
    timers: deps.timers,
    now,
    onNote: (text) => { try { tracker.setPollNote(text); } catch (e) { log(`note failed: ${describe(e)}`); } },
    onError: (e) => { try { log(`${new Date(now()).toISOString()} error: ${describe(e)}`); } catch (_) { /* never stall the poller */ } },
  });

  const handoff = createHandoff(vscode);
  let panel = null;
  const merger = createMerger({
    vscode, client, tokenFor: sync.tokenFor, tracker, pollNow: () => poller.kick(),
    preferred: () => cfg().get('mergeMethod', 'squash'),
    onBusyChange: () => panel.render(),
    onMerged: (url) => {
      sync.unwatch(url);
      handoff.noteMerged(url).then((r) => { if (r) log(`${new Date(now()).toISOString()} noted merge of ${url} in perch: ${r.result}${r.error ? ' ' + r.error : ''}`); });
    },
    onUpdated: () => sync.fast(),
  });
  const mergeWatch = createMergeWatch({
    prByUrl: (token, url) => client.prByUrl(token, url), tokenFor: sync.tokenFor, noteMerged: handoff.noteMerged,
    log: (line) => log(`${new Date(now()).toISOString()} ${line}`),
  });
  tracker.onLeft((rows) => { mergeWatch.handle(rows); });
  const origins = createLocalOrigins({ find: handoff.findSession, onChange: () => panel.render() });
  panel = new PanelProvider({ vscode, extensionUri: context.extensionUri, tracker, handoff, merger, origins });

  context.subscriptions.push(
    out,
    vscode.window.registerWebviewViewProvider('kestrel.prs', panel),
    vscode.commands.registerCommand('kestrel.refresh', () => { sync.relist(); sync.fast(); poller.kick(); }),
    vscode.commands.registerCommand('kestrel.watch', (url) => { if (sync.watch(url)) poller.kick(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('kestrel.accounts')) { sync.relist(); poller.kick(); } }),
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) poller.kick(); }),
    { dispose: () => poller.stop() },
  );

  poller.start();
  current = { tracker, sync, poller, panel, merger };
  return current;
}

function deactivate() {
  if (current) { current.poller.stop(); current = null; }
}

module.exports = { activate, deactivate };
