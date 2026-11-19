# 101 — Design

What kestrel is for, what it does, and how it is built. Written 2026-11-19,
before any code. It is the reference for the first version and is kept up
to date as the plan and build go. Calls marked *(builder's call)* were made
while writing this note, not by Sean; everything else is his.

This repo is public. Nothing in it (code, tests, docs, fixtures, commit
messages) names Sean's employer, its GitHub org, its repos or his work
account. Fixtures use made-up names such as `acme/widgets` and `octo-dev`.

## Purpose

kestrel shows Sean's open GitHub pull requests in a tab in VS Code's
bottom panel, next to Terminal, and keeps each one's status current.

The moment it exists for: Sean asks an agent (a perch tab, Claude Code)
to open a PR. CI and an automated reviewer then run on it, and the review
may fail several minutes later. Today he goes back to GitHub now and then
to check. With kestrel, the PR's row in the panel changes when GitHub
finishes. It shows either **merge** or a short reason like "1 blocker".
Clicking the reason puts a prompt such as "check the blocker comments on
PR acme/widgets#42" in the agent's message box, unsent, for him to send.

kestrel is a standalone extension. It works without perch. perch gets one
small command, in a separate change in the perch repo, so kestrel can
place text in its input box (see "Handing a prompt to the agent").

### Goals

- One panel tab listing every open PR Sean authored, across every repo
  and every GitHub account signed in to `gh` on the machine.
- Each row tells him at a glance whether to merge, wait, or act. When
  he needs to act, one click hands the agent a prompt.
- A PR whose status changes moves to the top and is highlighted, so a
  finished check reads like a new event.
- Merge from the panel.
- No new sign-in: kestrel reuses `gh`'s logins.

### Non-goals (first version)

- PRs Sean didn't author (review requests, team PRs).
- Reading diffs or comments in the panel. The agent does that.
- Push delivery (webhooks). kestrel polls.
- GitHub Enterprise Server hosts. Only github.com.
- Desktop notifications or sounds *(builder's call; the badge and highlight are enough for now)*.
- Merged and closed PRs. They leave the list as soon as kestrel sees them gone.

### Anti-goals

- Merging anything Sean did not confirm.
- Sending a prompt to an agent. kestrel only fills the box. Sean presses Enter.
- Saying a PR is mergeable when GitHub would refuse it, or "all green"
  while checks are still running.
- Hammering GitHub's API or exhausting either account's rate limit.
- Any mention of Sean's employer in the public repo.
- Depending on perch. Without it, everything works except that the
  prompt goes to the clipboard.

## What Sean sees

### The panel tab

A "PRs" tab in the bottom panel (a webview view in its own panel
container, `contributes.viewsContainers.panel`), beside Terminal, Output,
and the rest. VS Code lets him drag it elsewhere. Its badge counts only
rows Sean can act on right now: states 2, 3, 4, 5, 7 and 9 in the table
below (conflicts, failed CI, blockers, changes requested, behind base,
mergeable). Drafts (1), running (6) and blocked waiting on someone else
(8) don't count (Sean's call, 2026-11-19).

A webview rather than a tree, because a row needs two links, a highlight
fade, and colored status *(builder's call, same reasoning as chirp's
sidebar)*. It follows the VS Code theme's CSS variables and works from the
keyboard: ↑/↓ move between rows, Enter activates the row's action, `o`
opens the PR in the browser *(builder's call)*. When one of a row's links
has keyboard focus, Enter clicks that link instead *(ruling during build,
2026-11-19)*.

Toolbar: Refresh. That's all for now.

### A row

One line per PR:

```
 ● acme/widgets #42  Add retry to uploader          2 blockers      ↗
 ✓ octo-dev/tools #7 docs: setup note               merge           ↗
 ◌ acme/api #311     Bump parser                    checks 3/5      ↗
```

- A status dot: red (needs action), green (mergeable), gray spinner
  (running), dim (draft).
- `owner/repo #number` and the title. The title is cut to fit, with the
  full title on hover.
- The **action**: a link whose text and click depend on the state (table
  below).
- `↗` opens the PR on github.com.
- Account: when more than one `gh` account is in use, a small tag shows
  which account authored the PR *(builder's call)*.

### States

Evaluated in this order. The first match decides the row. "Head" means
the PR's latest commit.

| # | What GitHub says | Row shows | Clicking it |
|---|---|---|---|
| 1 | Draft | "draft" (dim) | puts "PR {ref} is a draft; check whether it is ready to mark ready for review" in the agent box |
| 2 | Merge conflict (`mergeable: CONFLICTING`) | "conflicts" | prompt: "resolve the merge conflicts on PR {ref} ({url})" |
| 3 | Any check on head finished as failure, timed-out, cancelled, or action-required | "CI failed: {first failed check name}" (+ "and N more") | prompt: "check the failing `{name}` check on PR {ref} ({url})" |
| 4 | Review bot summary on head has blockers | "{n} blocker(s)" | prompt: "check the blocker comments on PR {ref} ({url})" |
| 5 | A human reviewer requested changes (`reviewDecision: CHANGES_REQUESTED`) | "changes requested" | prompt: "check the requested changes on PR {ref} ({url})" |
| 6 | Checks still pending or queued on head, or GitHub hasn't computed mergeability yet (`UNKNOWN`) | "checks {done}/{total}" spinner | nothing |
| 7 | Branch behind base and the repo requires it up to date (`mergeStateStatus: BEHIND`) | "behind base" | prompt: "update PR {ref} with its base branch ({url})" |
| 8 | Blocked for another reason (`BLOCKED`, e.g. required review missing) | "blocked: needs review" or the reason GitHub gives | opens the PR in the browser |
| 9 | Mergeable (`CLEAN`, or `UNSTABLE`/`HAS_HOOKS` with no failures by rule 3) | **merge**, plus "{n} findings" when the review bot found non-blocking findings | merge (see "Merging"); the findings text is a second link with prompt "check the findings on PR {ref} ({url})" |

`{ref}` is `owner/repo#number`. Prompt wording is the builder's call within
this shape. Each prompt includes the repo, the number and the URL, so an
agent in any project can find the PR.

Rule 3 deliberately comes before rule 6. A PR with one failed check and two
still running shows the failure, so Sean can start on it right away.

### Events

kestrel keeps each PR's last state: the rule number from the table plus
its reason (the failed check's name, the blocker count). Progress inside a
state, such as "checks 3/5" becoming "checks 4/5", updates the text in
place and is **not** an event *(builder's call)*. When a poll changes the
state,
the row:

- moves to the top (rows are sorted by when their state last changed,
  newest first; on first load, by PR updated time);
- is highlighted with an accent background that fades over about 4 s
  *(builder's call)*. A change that happened while the panel was hidden
  fades the same way, 4 s after the panel is shown: the page doesn't exist
  while hidden, so it can't wait for a hover. The badge still counts it
  *(ruling during build, 2026-11-19; was "stays marked until hovered")*;
- and if the new state is one Sean can act on, the badge count goes up.
  A change into draft, running, or waiting-on-others still moves the row,
  but without the highlight *(builder's call)*.

A PR that disappears from the search results (merged or closed) is removed
on that poll.

### Hiding a PR (added 2026-11-19, Sean's request)

Sean has old PRs he doesn't care about right now. He chose hiding per
PR:

- Each row has an **×** (shown on hover and on the selected row; key `h`)
  that hides that PR.
- A hidden PR isn't drawn, doesn't count in the badge, and never
  highlights.
- The hidden list survives reloads. It is kept in the extension's global
  state as a list of PR URLs.
- When anything is hidden, a line at the bottom reads "Show N hidden".
  Clicking it shows the hidden rows dimmed, each with an **unhide** link in
  place of the ×, and the line becomes "Hide N hidden".
- A URL leaves the hidden list once the PR is gone: merged or closed,
  meaning a complete search no longer returns it, or merged from the
  panel. A PR whose account is dropped (login expired) stays hidden.
  *(builder's call)*

## Where the data comes from

### Accounts

kestrel uses the `gh` CLI's stored logins. It does not ask for a token or
start a sign-in.

- On start, and on Refresh, it lists github.com accounts with
  `gh auth status --hostname github.com` (parsing the "Logged in to
  github.com account X" lines; gh 2.45 has no JSON output for this)
  *(builder's call)*. It also lists them again when `kestrel.accounts`
  changes and after a round in which an account was dropped or `gh` was
  missing; every other poll reuses the last list. A newly added `gh` login
  therefore appears on the next Refresh *(ruling during build,
  2026-11-19)*.
- "Failed to log in to github.com account X" lines are kept as known
  accounts. `gh auth status` checks tokens online, so offline every login
  may "fail"; GitHub's answer decides instead: a 401 goes through the
  fresh-token retry below and drops the account, a network error is
  "Offline, retrying" *(ruling during build, 2026-11-19)*.
- A login that was listed before and is missing from a new list is
  dropped: with no note when `kestrel.accounts` now leaves it out,
  otherwise with the expired note below. A dropped account that comes back
  loads quietly, like a first load, not as a burst of events *(ruling
  during build, 2026-11-19)*.
- For each account, `gh auth token --hostname github.com --user <login>`
  gives its token. Tokens are held in memory only.
- The setting `kestrel.accounts` (array of logins, default empty = all)
  limits which accounts are used.
- If `gh` is missing or has no accounts, the panel shows "Sign in with
  `gh auth login`" and retries every 30 s and on Refresh.
- On a 401 for an account, kestrel re-reads that account's token from `gh`
  once. If it still fails, that account's rows are dropped and a one-line
  note says "{login}: gh login expired, run `gh auth login`". Other
  accounts keep working.

### The query

Two levels of query per account per poll, to keep within GitHub's
5,000 points an hour, which `gh` and every agent on the same login also
use *(builder's call)*:

- **The list query** runs every poll. It is cheap: search plus `number,
  url, updatedAt, headRefOid, mergeable, mergeStateStatus, isDraft,
  reviewDecision`, and the head commit's `statusCheckRollup { state }`
  (the rollup only, no individual checks).
- **The detail query** runs only for PRs whose list fields changed since
  the last poll, or whose rollup is still `PENDING`/`EXPECTED`. It fetches
  them by node id (`nodes(ids:)`) and asks for the fields below.

So a quiet list of 30 PRs costs about one point a poll. The builder
should measure the real cost with `rateLimit { cost }` and record it in
the build note.

Both go to `https://api.github.com/graphql` with that account's token, called directly from Node (`https` module, no
dependency) rather than shelling out to `gh` each time *(builder's call)*:

`search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50)`

and for each PR (detail query):

- `number, title, url, isDraft, updatedAt, state, author { login }, repository { nameWithOwner }`
  (`state` and `author` serve `kestrel.watch`; ruling during build, 2026-11-19)
- `mergeable, mergeStateStatus, reviewDecision`
- `headRefOid`
- `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }`
- `reviews(last: 20) { nodes { author { login } body commit { oid } submittedAt } }`
- `reviewThreads(first: 50) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }`

A head commit with more than 50 checks: kestrel sees only the first 50,
so it adds one "more checks" pending check and the row stays running
rather than showing **merge** *(ruling during build, 2026-11-19)*.

The same PR can come back from two accounts (e.g. a repo both can see but
only one authored). Rows are keyed by PR URL, so duplicates collapse.

### Polling

| Situation | Interval |
|---|---|
| Window focused, any PR in "running" | 20 s |
| Window focused, nothing running | 60 s |
| Window not focused | 4× the above |
| A new PR was announced with `kestrel.watch` (see below), or Refresh was pressed | 10 s for the next 5 minutes |

- Never two polls at once. Backoff on 403/429 secondary-rate-limit and
  network errors works like chirp's poller (Retry-After when given, else
  5 s doubling to 5 min), with "GitHub is throttling, retrying" or
  "Offline, retrying" shown at the top.
- `rateLimit { remaining resetAt cost }` is requested with each query.
  Below 200 remaining, kestrel waits until `resetAt` and shows "GitHub rate
  limit, resuming at HH:MM" *(builder's call)*. A response that is already
  rate-limited (a GraphQL error of type `RATE_LIMITED`, or a 403 with
  `x-ratelimit-remaining: 0`) gets the same wait, until
  `x-ratelimit-reset`, at least 5 s *(ruling during build, 2026-11-19)*.
- While throttled, rate-limited or offline, rows stay as last seen, with
  the note at the top. Rows are removed only when a successful, complete
  search no longer returns them.
- **Partial results:** a 200 response with an `errors` array (for example a
  token that hasn't been authorized for an org's SSO) is treated as a
  failure for that account. Its rows are kept as last seen and a note shows
  the first error message. It is never treated as "those PRs were merged".
- If `gh auth token` fails for an account that worked before (logged out,
  `gh` removed), that account is treated like a 401 that failed twice.
- **Several windows:** each VS Code window runs its own kestrel and polls
  on its own. With the two-level query this costs little. Sharing one
  poller between windows is out of scope for the first version
  *(builder's call)*.
- Refresh polls now, except while a throttle backoff, Retry-After or rate
  limit wait holds: then Refresh, window focus, `kestrel.watch` and the
  poll after a failed merge all wait for it, and the note at the top says
  why. The "no `gh`" wait is local, so Refresh still retries at once
  *(ruling during build, 2026-11-19)*.
- The throttling / offline / rate-limit note is shown for every round the
  condition lasts, separate from the "no `gh`" note *(ruling during build,
  2026-11-19)*.

**Spotting a new PR quickly** *(builder's call)*: GitHub's search index can
take a minute to include a new PR, and an extension can't see what an
agent ran. So kestrel offers a command `kestrel.watch(url)` that other
tools can call. Calling it also switches to the 10 s interval for 5
minutes. Any PR it's given is fetched by
URL (`resource(url:)`) on every poll until search returns it. perch may
call it later. It is not part of perch's change for this first version.
Rules for watched PRs *(ruling during build, 2026-11-19)*: the argument
must be a URL of the form `https://github.com/{owner}/{repo}/pull/{n}`
(anything else, including no argument, is ignored); the PR must be open
(a merged or closed one is dropped from the watch list); it must be
authored by one of the signed-in accounts, and its row belongs to that
account (a PR nobody here authored is ignored and unwatched, so kestrel
never offers **merge** on someone else's PR); and merging it from the
panel unwatches it.

### The review bot summary

Sean's automated reviewer posts a review whose body contains a hidden
HTML comment:

```
<!-- pr-auto-review-findings: <base64 of JSON> -->
```

where the JSON is `{"blockers": [ ... ], "findings": [ ... ]}`. kestrel
treats this as a general, documented format (README: "Review bot
summaries"), not as anything specific to one reviewer.

- kestrel reads the newest review on the PR that carries the marker.
- It counts only if that review's `commit.oid` equals the head commit.
  A summary for an older commit is ignored.
- The reviewer runs as a check on the PR (a workflow job), so after a push
  the row sits in state 6 until that check finishes, and the summary is
  already posted by then. If a repo's reviewer posts with no check at all,
  kestrel can't know a review is coming and may show **merge** before it
  arrives. That is accepted, and the README says reviewers should run as a
  check *(builder's call)*.
- A branch rule closes that gap too, if it requires at least one approval,
  the bot's approval counts toward it, and stale approvals are dismissed
  on push. Until the bot approves the new head, GitHub reports the PR
  `BLOCKED`, so the row shows state 8, not **merge**. Sean's repos are set
  up this way, and their reviewer also runs as a check (2026-11-19).
- `blockers.length` and `findings.length` give the counts. The entries'
  contents are not shown.
- A marker that fails to decode is ignored, as if absent.

**Fallback** when no review on head carries the marker: unresolved review
threads count as findings ("{n} unresolved comments" next to **merge**, or
alongside the state when not mergeable), with the prompt "check the
unresolved review comments on PR {ref} ({url})". kestrel does not guess
severity from comment wording.

## Handing a prompt to the agent

When Sean clicks a reason, kestrel:

1. Checks whether the command `perch.insertText` exists
   (`vscode.commands.getCommands(true)`, cached for the session and
   refreshed when extensions change).
2. If it exists, calls it with the prompt text. perch puts the text in
   the **active** perch tab's input box, replacing nothing already typed
   (perch's change adds a separating space when the box already has text;
   `deliver` itself doesn't), focuses
   that tab, and does not send. If there is no perch tab, perch returns
   `false`.
3. Otherwise, or if perch returned `false`, kestrel copies the prompt to
   the clipboard and shows a status-bar message for 4 s: "Prompt copied.
   Paste it into your agent."

### The perch change (separate PR in the perch repo)

- New command `perch.insertText(text: string): boolean`, not shown in the
  command palette.
- It finds the active session (`perch.active()`). That is the focused
  perch editor tab if there is one, otherwise the perch tab Sean was last
  in, which is the right target, because clicking in kestrel's panel takes
  focus away from perch. If there is none, it returns `false`. Otherwise it calls the existing `deliver(sid, text)`,
  reveals and focuses that tab, and returns `true`.
- No other perch behavior changes.

## Merging

Clicking **merge**:

1. A modal confirm: "Merge acme/widgets#42 'Add retry to uploader'?" with
   the merge method on the button, e.g. "Squash and merge".
2. Merge method: the repo's allowed methods come from the same query
   (`repository { squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed }`).
   kestrel uses the setting `kestrel.mergeMethod` (`squash` | `merge` |
   `rebase`, default `squash`) if the repo allows it, otherwise the first
   allowed of squash, merge, rebase *(builder's call)*.
3. After the confirm, kestrel reads the row again. If a poll changed it
   while the modal was open (no longer **merge**, or a new head commit),
   nothing is merged and the row shows "The PR changed; check it again"
   *(ruling during build, 2026-11-19)*.
4. GraphQL `mergePullRequest(pullRequestId, mergeMethod, expectedHeadOid: headRefOid)`.
   `expectedHeadOid` makes GitHub refuse if a new commit landed after the
   row was drawn, so kestrel never merges something Sean didn't see.
5. On success, the row is removed. Deleting the branch is left to the repo's
   "automatically delete head branches" setting *(builder's call)*.
6. On refusal, the row shows GitHub's message in red until the next poll
   recomputes its state. A 401 or network error during the merge shows
   "Merge not confirmed: {error}" and polls right away. The next poll
   either finds the PR gone (merged) or still open, so a merge is never
   retried blindly.
7. The merge uses the token of the account the row came from. A second
   click while a merge is in flight does nothing (the link shows
   "merging…"). Cancelling the confirm does nothing.

## How it is built

Same structure as chirp (`/git/chirp`), so Sean can work on both the same way:

- Plain JavaScript (CommonJS), no build step, no runtime dependencies.
  Engine `^1.90.0`. Publisher `seanahn`, MIT, repo `github.com/seanahn/kestrel`.
- `src/`: `extension.js` (activation, commands, wiring), `accounts.js`
  (gh logins and tokens), `github.js` (GraphQL client and query),
  `model.js` (PR → state, pure), `reviewSummary.js` (marker parsing,
  pure), `poller.js` (adapted from chirp's), `panel.js` (webview view
  host), `handoff.js` (perch or clipboard), `merge.js`.
- `media/`: `panel.js`, `panel.css`, icons.
- `test/`: `node --test`, a VS Code stub like chirp's `vscodeStub.js`,
  jsdom for the panel page. No network and no real `gh` in tests. The
  `gh` calls go through one function that tests replace.
- `Makefile` with the same targets as chirp (`deps check test install
  uninstall package install-vsix login publish clean`).
- `docs/notes/`: this note (101), and later notes in the same numbering
  as chirp (201+ build records, 901 setup).
- README for the marketplace, written without any employer mention.

The model is the part worth testing hardest. The state table above should
become a table-driven test, with one fixture PR per row plus the rule-order
cases (failure + running, conflict + failure, stale review summary).

## Decisions made while planning (2026-11-19)

All *(builder's call)* unless noted.

- **Public-repo guard.** A gitignored `.private-words` file lists the
  terms that must never appear. A test scans every tracked file and every
  commit message for them, and skips when the file is absent (on a fresh
  clone, for instance).
- **Search pagination.** 50 PRs per page, up to 4 pages (200 PRs). A
  truncated search would make the overflow look merged.
- **Detail fetches** are batched 20 ids per `nodes(ids:)` request. A PR is
  re-fetched in detail when any of `updatedAt, headOid, mergeable,
  mergeStateStatus, isDraft, reviewDecision`, or the check rollup changed,
  or while its rollup is pending.
- **Prompt texts** are fixed as in the state table, each ending with
  `({url})`.
- **The extra link** (findings or unresolved comments) shows on every row
  except draft, blockers and running.
- **Highlight.** A highlighted row is marked seen 4 s after it is drawn
  while the panel is visible, including rows that changed while it was
  hidden *(ruling during build, 2026-11-19; the hover rule is dropped, see
  "Events")*.
- **No `gh`, or no accounts:** the note shows and kestrel retries every
  30 s.
- **No allowed merge method:** the row shows "This repo allows no merge
  method kestrel can use".
- **`perch.insertText`** adds a leading space when the waiting draft
  doesn't end in whitespace. It reveals the tab and returns `true`, or
  returns `false` when there is no perch tab.

## Diagrams

A PR's review finishing and Sean handing it to the agent:

```
 Sean          kestrel panel      kestrel host          gh CLI        GitHub GraphQL      perch
  |                  |                  |                   |                 |               |
  |                  |                  |-- auth status --->|                 |               |
  |                  |                  |<-- accounts ------|                 |               |
  |                  |                  |-- auth token (each) ->|             |               |
  |                  |                  |<-- tokens ------------|             |               |
  |                  |                  |-- search open PRs (per account) --->|               |
  |                  |                  |<-- PRs, checks, reviews ------------|               |
  |                  |                  | state: "checks 4/5" (running, 20 s) |               |
  |                  |                  |   ... next poll ...                 |               |
  |                  |                  |-- search open PRs ----------------->|               |
  |                  |                  |<-- review on head: 1 blocker -------|               |
  |                  |<-- row → top, highlight, badge+1                       |               |
  |-- click "1 blocker" ->|             |                   |                 |               |
  |                  |-- handoff(prompt) ->|                |                 |               |
  |                  |                  | [perch.insertText exists]           |               |
  |                  |                  |-- perch.insertText(prompt) ------------------------>|
  |                  |                  |                   |  active() → deliver(+space) → focus tab
  |                  |                  |<-- true (text in active tab, unsent) --------------|
  |                  |                  | [no perch, or false]                |               |
  |                  |                  |-- clipboard + "Prompt copied" (status bar, 4 s)     |
  |-- reads, presses Enter in perch ------------------------------------------------------->|
```

Merging, including the case where a commit lands after the row was drawn:

```
 Sean          kestrel panel      kestrel host                    GitHub GraphQL
  |-- click merge ->|                 |                                 |
  |                 |-- merge(pr) --->|                                 |
  |                 |                 | method: kestrel.mergeMethod if allowed, else first allowed
  |<-- modal: "Merge acme/widgets#42 'Add retry…'?" [Squash and merge] --|
  |-- confirm ------------------------------------>|                     |
  |                 |<-- link: "merging…" (further clicks ignored)      |
  |                 |                 |   [cancel: nothing happens]     |
  |                 |                 |-- mergePullRequest(expectedHeadOid) ->|
  |                 |                 |   [merged]                      |
  |                 |<-- remove row --|<-- ok --------------------------|
  |                 |                 |   [head moved / not mergeable]  |
  |                 |<-- row shows GitHub's message; next poll recomputes state
  |                 |                 |   [401 / network error]         |
  |                 |<-- "Merge not confirmed"; poll now; never retried |
```

Token and throttling failures:

```
 kestrel host                    gh CLI               GitHub GraphQL
  |-- search (account A) -------------------------------->|
  |<-- 401 ----------------------------------------------|
  |-- auth token --user A ------>|                        |
  |<-- token --------------------|                        |
  |-- search again -------------------------------------->|
  |   [401 again: drop A's rows; note "A: gh login expired"; B keeps working]
  |   [403 secondary limit / 429: wait Retry-After or back off 5 s→5 min; "GitHub is throttling"]
  |   [200 with errors[] (e.g. SSO): keep A's rows as last seen; note the error]
  |   [rateLimit.remaining < 200: wait until resetAt; note it]
  |   [network error: back off; "Offline, retrying"; rows stay as last seen]
  |-- auth status (no gh / no accounts) ->|  "Sign in with gh auth login"; retry every 30 s
```
