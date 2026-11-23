# kestrel

Your open GitHub pull requests in a tab of VS Code's bottom panel, next to
Terminal. Each row says whether to merge, wait or act, and keeps itself
current while CI and reviewers run.

kestrel has no AI in it. When a row needs action, clicking its reason puts
a prompt such as "check only the blocking review comments on PR acme/widgets#42" in an
agent's message box. It never sends it: you press Enter.

- **The PRs tab:** every open PR you authored, across every repo and every
  GitHub account `gh` is signed in to. The tab's badge counts the rows you
  can act on right now.
- **Rows:** a status dot, `owner/repo #number`, the title, an action link,
  and `↗` to open the PR on github.com. Clicking anywhere else on the line
  opens the Claude chat that made the PR, if perch can find it (see "Where a
  PR was made"); otherwise it opens the PR on github.com too. A row that can
  be merged now is tinted green. With more than one account, a small
  tag shows which one authored the PR.
- **Changes stand out:** when a PR's state changes, its row moves to the top
  and is highlighted for a few seconds.
- **Keyboard:** ↑/↓ move between rows, Enter runs the row's action, `o`
  opens the PR in the browser, `h` hides it.
- **Merge** from the panel, after a confirm.
- **Hiding:** the **eye** at the start of a row hides that PR (it isn't
  drawn, counted or highlighted). "Show N hidden" at the bottom brings
  hidden rows back, dimmed, each starting with an **eye with a slash** that
  shows it again. A PR leaves the hidden list once it is merged or closed.

kestrel is not made by or affiliated with GitHub.

## What a row says

The first line that matches decides the row.

| Row shows | When | Clicking it |
| --- | --- | --- |
| draft | The PR is a draft | prompt: check whether it is ready for review |
| conflicts | It has merge conflicts | prompt: resolve them |
| CI failed: name | A check on the latest commit failed, timed out, was cancelled or needs action | prompt: check that check |
| changes requested | A reviewer requested changes. If that review is on an older commit and checks are still running on the new one, the row shows the checks instead, until the new review lands | prompt: check only the blocking comments and fix those |
| checks done/total | Checks are still running, or GitHub is still working out mergeability | nothing |
| update branch | The branch is behind its base, and that blocks the merge (or may). Shown even while checks run, since updating restarts them | updates the branch in place: merges the base in, like GitHub's **Update branch** button |
| needs human review | The review bot reviewed it but may not approve it (its reasons are in the tooltip), or a person's review is required | opens the PR on GitHub |
| blocked | Blocked for another reason | opens the PR |
| **merge** | GitHub would accept the merge | merges, after a confirm |

A failed check is shown even while other checks are still running, so you
can start on it at once. Next to **merge** (and next to most other states),
a second link shows "N findings" or "N unresolved comments"; clicking it
puts a prompt about them in the agent's box.

The badge counts conflicts, failed CI, changes requested, update branch
and mergeable. Drafts, running and blocked-on-someone-else don't count.

## Updating a branch

Clicking **update branch** merges the base branch into the PR branch on
GitHub, the same as its **Update branch** button. There's no confirm. The
link reads "updating…" meanwhile. GitHub refuses if a push landed after the
row was drawn. The update is a push, so CI and reviewers run again. If
GitHub refuses (a conflict, say), its message shows on the row, and the
link becomes **update branch: ask agent**, which hands the agent a prompt to
update the branch locally. Your local checkout is now behind the PR
branch, so pull before you push again.

## Where a PR was made

Hovering a row shows where the PR was made: the machine, the Claude Code
session, its folder and its transcript. Clicking the row opens that chat in
[perch](https://github.com/seanahn/perch): it switches to the tab if the
chat is open, or resumes it in a new tab in its own folder. Nothing is sent.

kestrel looks in two places, in this order:

1. **A record on the PR itself.** The `hooks/pr-origin.js` Claude Code hook
   adds a hidden `<!-- pr-origin: … -->` comment to a PR's description right
   after Claude runs `gh pr create`. Because it's on GitHub, every window on
   every machine sees it. Install it on each machine you open PRs from:

   ```json
   "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [
     { "type": "command",
       "command": "KESTREL_MACHINE=desktop node ~/.claude/hooks/pr-origin.js" } ] } ] }
   ```

   in `~/.claude/settings.json`, with the file copied to
   `~/.claude/hooks/pr-origin.js`. `KESTREL_MACHINE` names the machine; the
   hostname is used without it. The hook never blocks Claude, and logs to
   `~/.cache/kestrel/pr-origin.log`.
2. **This machine's transcripts.** For a PR with no record, perch searches
   the last 30 days of Claude Code transcripts here, in the background as the
   PR first appears, for the session that printed the PR's URL from
   `gh pr create`.

A chat on another machine can't be opened from this one: the tooltip says
where it is, and a click opens the PR on GitHub.

## Merging

Clicking **merge** asks first: "Merge acme/widgets#42 'Title'?", with the
merge method on the button. The method is `kestrel.mergeMethod` if the
repo allows it, otherwise the first allowed of squash, merge, rebase.
kestrel asks GitHub to merge only the commit you saw, so a push that landed
after the row was drawn is refused, and kestrel re-checks the row after
your confirm. A merge whose outcome kestrel couldn't confirm (a network
error, say) is never retried: kestrel looks again on the next poll.

A PR merged elsewhere (on GitHub, by you or a reviewer) leaves the list on
the next poll. kestrel checks whether it was merged rather than closed, and
if so tells perch (`perch.notePrMerged`), the same as a merge from the panel.

## Review bot summaries

If an automated reviewer posts its summary as a PR review, kestrel can show
its findings and why it may not approve. The review body must contain a hidden HTML
comment:

```
<!-- pr-auto-review-findings: <base64 of JSON> -->
```

where the JSON is `{"blockers": [ ... ], "findings": [ ... ]}`.
`blockers` are reasons the bot may not approve (strings, such as "touches
control paths"): a row with any reads **needs human review**, with the
reasons in its tooltip. `findings` are counted ("N findings" next to
**merge**); their contents aren't shown.

- kestrel reads the newest review that has the marker.
- The summary counts only if the review is on the PR's **head commit**. A
  summary for an older commit is ignored.
- A marker that doesn't decode is ignored.
- With no marker on the head commit, unresolved review threads count as
  findings ("N unresolved comments").
- **Run the reviewer as a check** (a workflow job). After a push the row
  then reads "checks" until the reviewer finishes. A reviewer that posts
  with no check gives kestrel no way to know a review is coming, so it may
  show **merge** a moment before the review lands. A branch rule that
  requires an approval, which the bot gives and a push dismisses, also
  closes the gap: GitHub reports the PR blocked until then.

## Agents

A reason link's prompt goes to the Claude chat that made the PR (see "Where
a PR was made"): perch switches to it, or resumes it, and puts the prompt at
the end of its box. When that chat isn't on this machine, the prompt goes to
the tab you were last in, with a note in front saying where the chat is.

- **`perch.insertText`:** if the [perch](https://github.com/seanahn/perch)
  extension provides this command, a clicked reason puts its prompt at the
  end of the active perch tab's box, unsent, and focuses that tab.
- **Clipboard fallback:** without that command, or when there is no perch
  tab, kestrel copies the prompt and shows "Prompt copied. Paste it into
  your agent." in the status bar for a few seconds.
- **`kestrel.watch`:** other tools can run this command with a PR URL
  (`https://github.com/owner/repo/pull/N`) right after opening a PR.
  GitHub's search can take a minute to list a new PR; kestrel fetches the
  watched one directly and polls every 10 s for five minutes. Only open PRs
  authored by one of your signed-in accounts are watched. It isn't in the
  command palette.

kestrel works without perch or any agent.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `kestrel.accounts` | `[]` | `gh` logins whose PRs to list. Empty means every account `gh` is signed in to. |
| `kestrel.mergeMethod` | `squash` | `squash`, `merge` or `rebase`: how **merge** merges, if the repo allows it. |

Commands: **kestrel: Refresh** (also in the panel's title bar).

## Signing in

kestrel reuses the [GitHub CLI](https://cli.github.com/)'s logins and never
asks for a token. Sign in with `gh auth login`; run it again for a second
account. A newly added login appears on the next Refresh. If an account's
login expires, its rows are dropped and a note says
"`login`: gh login expired, run `gh auth login`". The other accounts keep
working. Only github.com is supported, not GitHub Enterprise Server.

Tokens are read from `gh` and held in memory only.

## Polling and rate limits

kestrel polls every 20 s while a PR is running and the window is focused,
every 60 s otherwise, and four times slower when the window isn't focused.
A cheap list query runs each poll (about 1 point per account, of GitHub's
5,000 an hour); the detailed query runs only for PRs that changed or are
still running. When throttled, rate limited or offline, rows stay as last
seen with a note at the top. Each VS Code window polls on its own.

## Install

From the Marketplace: search for **kestrel PRs** by seanahn, or run
`code --install-extension seanahn.kestrel-prs`. The Marketplace name is
`kestrel-prs` ("kestrel PRs") because `kestrel` was taken.

### From source

```
make install     # links this checkout into VS Code / code-server; reload the window
make test        # offline tests: no network, no real gh
make package     # a .vsix
```

## Design

What kestrel is for and the decisions behind it:
[docs/notes/101-design.md](docs/notes/101-design.md), and how it was built
in [docs/notes/201-build.md](docs/notes/201-build.md).

## License

MIT
