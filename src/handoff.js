'use strict';
// Hand-off to the agent (design 101, "Handing a prompt to the agent"): put the prompt into the perch agent tab's
// input via the optional perch.insertText command, else on the clipboard. It never sends the prompt.
function createHandoff(vscode) {
  let hasPerch = null;
  const refresh = async () => {
    try { hasPerch = (await vscode.commands.getCommands(true)).includes('perch.insertText'); } catch { hasPerch = false; }
  };
  vscode.extensions.onDidChange(() => { hasPerch = null; });

  async function send(prompt) {
    if (hasPerch === null) await refresh();
    if (hasPerch) {
      try {
        if ((await vscode.commands.executeCommand('perch.insertText', prompt)) === true) return 'perch';
      } catch { /* fall back to the clipboard */ }
    }
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.setStatusBarMessage('Prompt copied. Paste it into your agent.', 4000);
    return 'clipboard';
  }
  return { send };
}

module.exports = { createHandoff };
