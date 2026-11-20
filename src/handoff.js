'use strict';
// Hand-off to the agent (design 101, "Handing a prompt to the agent"): put the prompt into the perch agent tab's
// input via the optional perch.insertText command, else on the clipboard. It never sends the prompt.
// After a merge, perch.notePrMerged (if present) records the merge in the session that created the PR
// (design 101, "Telling the session a PR merged"). perch.findPrSession and perch.openPrSession find and open the
// chat that made a PR (design 101, "Where a PR was made").
function createHandoff(vscode) {
  let commands = null;
  const has = async (id) => {
    if (commands === null) {
      try { commands = new Set(await vscode.commands.getCommands(true)); } catch { commands = new Set(); }
    }
    return commands.has(id);
  };
  vscode.extensions.onDidChange(() => { commands = null; });

  async function send(prompt) {
    if (await has('perch.insertText')) {
      try {
        if ((await vscode.commands.executeCommand('perch.insertText', prompt)) === true) return 'perch';
      } catch { /* fall back to the clipboard */ }
    }
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.setStatusBarMessage('Prompt copied. Paste it into your agent.', 4000);
    return 'clipboard';
  }

  /** perch's answer ({ result, sessionId }), null when perch can't take it, never a throw. */
  async function noteMerged(url) {
    if (!(await has('perch.notePrMerged'))) return null;
    try {
      return (await vscode.commands.executeCommand('perch.notePrMerged', url)) || null;
    } catch (e) {
      return { result: 'failed', error: (e && e.message) || String(e) };
    }
  }

  /** perch's local answer to "which chat made this PR?" ({ session, cwd, transcript, host, created }), or null. */
  async function findSession(url) {
    if (!(await has('perch.findPrSession'))) return null;
    try { return (await vscode.commands.executeCommand('perch.findPrSession', url)) || null; } catch { return null; }
  }

  /** Open the chat that made the PR: 'tab' (switched to it), 'resumed' (a new tab), or 'none' (no chat here). */
  async function openSession(spec) {
    if (!(await has('perch.openPrSession'))) return 'none';
    try { return (await vscode.commands.executeCommand('perch.openPrSession', spec)) || 'none'; } catch { return 'none'; }
  }

  /** Whether perch can open a PR's chat (and fill its box), so a reason link can go there. */
  const canOpenSessions = () => has('perch.openPrSession');

  return { send, noteMerged, findSession, openSession, canOpenSessions };
}

module.exports = { createHandoff };
