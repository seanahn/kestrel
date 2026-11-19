# kestrel

Your open GitHub pull requests in a tab of VS Code's bottom panel, next to
Terminal. Each row says whether to merge, wait or act, and keeps itself
current while CI and reviewers run.

kestrel has no AI in it. When a row needs action, clicking its reason puts
a prompt such as "check the blocker comments on PR acme/widgets#42" in an
agent's message box. It never sends it: you press Enter.

- **The PRs tab:** every open PR you authored, across every repo and every
  GitHub account `gh` is signed in to. The tab's badge counts the rows you
  can act on right now.
- **Rows:** a status dot, `owner/repo #number`, the title, an action link,
  and `↗` to open the PR on github.com. With more than one account, a small
  tag shows which one authored the PR.
- **Changes stand out:** when a PR's state changes, its row moves to the top
  and is highlighted for a few seconds.
- **Keyboard:** ↑/↓ move between rows, Enter runs the row's action, `o`
  opens the PR in the browser, `h` hides it.
- **Merge** from the panel, after a confirm.
- **Hiding:** the **×** on a row hides that PR (it isn't drawn, counted or
  highlighted). "Show N hidden" at the bottom brings hidden rows back,
  dimmed, each with an **unhide** link. A PR leaves the hidden list once
  it is merged or closed.

kestrel is not made by or affiliated with GitHub.

## What a row says

The first line that matches decides the row.

| Row shows | When | Clicking it |
| --- | --- | --- |
| draft | The PR is a draft | prompt: check whether it is ready for review |
| conflicts | It has merge conflicts | prompt: resolve them |
| CI failed: name | A check on the latest commit failed, timed out, was cancelled or needs action | prompt: check that check |
| N blockers | The review bot's summary for the latest commit lists blockers | prompt: check the blocker comments |
| changes requested | A reviewer requested changes | prompt: check the requested changes |
| checks done/total | Checks are still running, or GitHub is still working out mergeability | nothing |
| behind base | The branch must be up to date with its base and isn't | prompt: update it |
| blocked: reason | Blocked for another reason, such as a missing required review | opens the PR |
| **merge** | GitHub would accept the merge | merges, after a confirm |

A failed check is shown even while other checks are still running, so you
can start on it at once. Next to **merge** (and next to most other states),
a second link shows "N findings" or "N unresolved comments"; clicking it
puts a prompt about them in the agent's box.

The badge counts conflicts, failed CI, blockers, changes requested, behind
base and mergeable. Drafts, running and blocked-on-someone-else don't count.

## Merging

Clicking **merge** asks first: "Merge acme/widgets#42 'Title'?", with the
merge method on the button. The method is `kestrel.mergeMethod` if the
repo allows it, otherwise the first allowed of squash, merge, rebase.
kestrel asks GitHub to merge only the commit you saw, so a push that landed
after the row was drawn is refused, and kestrel re-checks the row after
your confirm. A merge whose outcome kestrel couldn't confirm (a network
error, say) is never retried: kestrel looks again on the next poll.

## Review bot summaries

If an automated reviewer posts its summary as a PR review, kestrel can show
its blocker and finding counts. The review body must contain a hidden HTML
comment:

```
<!-- pr-auto-review-findings: <base64 of JSON> -->
```

where the JSON is `{"blockers": [ ... ], "findings": [ ... ]}`. kestrel
only counts the entries; it doesn't show them.

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
