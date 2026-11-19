'use strict';
// A fake vscode module, installed for require('vscode'), so host tests run without VS Code. It records what the
// extension does: registered providers, commands, panels and the messages posted to them.
const Module = require('module');
const origLoad = Module._load;

class Emitter {
  constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; }; }
  fire(x) { for (const f of [...this.fns]) f(x); }
}

function fakeWebview() {
  const recv = new Emitter();
  return {
    html: '', options: {}, cspSource: 'vscode-resource:', posted: [],
    postMessage(m) { this.posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
    onDidReceiveMessage: recv.event, _receive: (m) => recv.fire(m),
    asWebviewUri: (u) => u,
  };
}

function install() {
  const ui = { providers: {}, panels: [], commands: {}, executed: [], opened: [], focused: true, config: {}, out: [], watchers: [], infos: [], copied: [], sessions: [], status: [], extraCommands: [], extraHandlers: {}, answer: () => undefined };
  const extensionsChanged = new Emitter();
  ui.extensionsChanged = extensionsChanged;
  const configChange = new Emitter();
  // the editor's Microsoft provider: ui.session(scopes, options) answers getSession; calls are recorded
  ui.session = () => undefined;
  const windowState = new Emitter();
  const Uri = {
    file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p }),
    joinPath: (u, ...parts) => Uri.file(require('path').join(u.fsPath, ...parts)),
    parse: (s) => ({ toString: () => s, scheme: s.split(':')[0] }),
  };
  function createWebviewPanel(viewType, title, column, options) {
    const disposed = new Emitter(), viewState = new Emitter();
    const panel = {
      viewType, title, options, webview: fakeWebview(), visible: true, active: true, disposed: false, revealed: 0,
      reveal() { this.revealed++; this.visible = true; this.active = true; viewState.fire({ webviewPanel: this }); },
      dispose() { if (this.disposed) return; this.disposed = true; disposed.fire(); },
      onDidDispose: disposed.event, onDidChangeViewState: viewState.event,
      _setView(visible, active) { this.visible = visible; this.active = active; viewState.fire({ webviewPanel: this }); },
    };
    ui.panels.push(panel);
    return panel;
  }
  const vscode = {
    Uri, EventEmitter: Emitter,
    ViewColumn: { Active: -1, One: 1, Two: 2 },
    window: {
      get state() { return { focused: ui.focused }; },
      onDidChangeWindowState: windowState.event,
      registerWebviewViewProvider: (id, provider) => { ui.providers[id] = provider; return { dispose() {} }; },
      registerWebviewPanelSerializer: (id, s) => { ui.serializer = s; return { dispose() {} }; },
      createWebviewPanel,
      createOutputChannel: () => ({ appendLine: (l) => ui.out.push(l), dispose() {} }),
      setStatusBarMessage: (text, ms) => { ui.status.push({ text, ms }); return { dispose() {} }; },
      showWarningMessage: async (msg, opts, ...items) => ui.answer(msg, opts, ...items),
      showErrorMessage: (m) => { ui.out.push('error: ' + m); },
      showInformationMessage: async (m) => { ui.infos.push(m); return undefined; },
    },
    commands: {
      registerCommand: (id, fn) => { ui.commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (id, ...a) => { ui.executed.push([id, ...a]); if (ui.commands[id]) return ui.commands[id](...a); return ui.extraHandlers[id] ? ui.extraHandlers[id](...a) : undefined; },
      getCommands: async () => [...Object.keys(ui.commands), ...ui.extraCommands],
    },
    workspace: {
      getConfiguration: (section) => ({ get: (k, d) => { const v = ui.config[(section ? section + '.' : '') + k]; return v === undefined ? d : v; } }),
      onDidChangeConfiguration: configChange.event,
    },
    authentication: { getSession: async (provider, scopes, options) => { ui.sessions.push({ provider, scopes, options }); return ui.session(scopes, options); } },
    env: { openExternal: async (u) => { ui.opened.push(u.toString()); return true; }, clipboard: { writeText: async (t) => { ui.copied.push(t); } } },
    extensions: { onDidChange: extensionsChanged.event },
  };
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : origLoad.call(this, request, ...rest); };
  ui.setFocus = (f) => { ui.focused = f; windowState.fire({ focused: f }); };
  ui.setConfig = (key, value) => { ui.config[key] = value; configChange.fire({ affectsConfiguration: (sec) => key === sec || key.startsWith(sec + '.') }); };
  /** Shows a view: resolves the registered view provider (default kestrel.prs) with a fake view. */
  ui.resolveView = (id = 'kestrel.prs') => {
    const visibility = new Emitter();
    const view = { webview: fakeWebview(), badge: undefined, visible: true, show() {}, onDidChangeVisibility: visibility.event, onDidDispose: () => ({ dispose() {} }),
      /** Tests: hide or show the view and fire onDidChangeVisibility. */
      _setVisible(v) { this.visible = v; visibility.fire(); } };
    ui.providers[id].resolveWebviewView(view, {}, {});
    ui.view = view;
    return view;
  };
  return { vscode, ui };
}

/** The editor's secret storage, shared by "windows" that use the same object. */
function secrets() {
  const m = new Map(); const ch = new Emitter();
  return { m, get: async (k) => m.get(k), store: async (k, v) => { m.set(k, v); ch.fire({ key: k }); }, delete: async (k) => { m.delete(k); ch.fire({ key: k }); }, onDidChange: ch.event };
}

// like VS Code's, update(key, undefined) deletes the key
function memento() { const m = new Map(); return { get: (k) => m.get(k), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); } }; }

module.exports = { install, memento, secrets, Emitter };
