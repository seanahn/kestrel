'use strict';
// The PRs panel (design 101, "The panel tab"): a webview view that draws the tracker's rows and routes the page's
// clicks to the hand-off, the merger and the browser. The page never sends prompt text; prompts are looked up here by url.
const crypto = require('crypto');

class PanelProvider {
  constructor({ vscode, extensionUri, tracker, handoff, merger }) {
    this.vscode = vscode;
    this.extensionUri = extensionUri;
    this.tracker = tracker;
    this.handoff = handoff;
    this.merger = merger;
    this.view = null;
    tracker.onChange(() => this.render());
  }

  resolveWebviewView(view) {
    const { vscode } = this;
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const csp = view.webview.cspSource;
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => this.render());
    if (view.onDidDispose) view.onDidDispose(() => { if (this.view === view) this.view = null; });
    this.render();
  }

  onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ready') { this.render(); return; }
    const row = this.tracker.rows().find((r) => r.pr.url === m.url);
    if (!row) return;
    const { state } = row;
    if (m.type === 'action') {
      const a = state.action;
      if (!a) return;
      if (a.kind === 'prompt') this.handoff.send(a.prompt);
      else if (a.kind === 'merge') this.merger.merge(row.pr.url);
      else if (a.kind === 'open') this.open(row.pr.url);
    } else if (m.type === 'extra') {
      if (state.extra) this.handoff.send(state.extra.prompt);
    } else if (m.type === 'open') {
      this.open(row.pr.url);
    } else if (m.type === 'seen') {
      this.tracker.markSeen(row.pr.url);
    }
  }

  open(url) { this.vscode.env.openExternal(this.vscode.Uri.parse(url)); }

  render() {
    const view = this.view;
    if (!view) return;
    const rows = this.tracker.rows();
    const accounts = new Set(rows.map((r) => r.pr.account));
    const n = this.tracker.badge();
    // undefined, not 0: a hidden badge is cleared by unsetting it
    view.badge = n > 0 ? { value: n, tooltip: n === 1 ? '1 PR needs you' : `${n} PRs need you` } : undefined;
    view.webview.postMessage({
      type: 'render',
      visible: !!view.visible,
      notes: this.tracker.notes(),
      multiAccount: accounts.size > 1,
      rows: rows.map((r) => ({
        url: r.pr.url,
        ref: `${r.pr.repo}#${r.pr.number}`,
        title: r.pr.title,
        account: r.pr.account,
        text: r.state.text,
        dot: r.state.dot,
        actionKind: r.state.action ? r.state.action.kind : null,
        extraText: r.state.extra ? r.state.extra.text : null,
        highlight: !!r.highlight,
        busy: !!this.merger.busy(r.pr.url),
        error: r.error || null,
      })),
    });
  }
}

module.exports = { PanelProvider };
