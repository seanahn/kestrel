# 201 — Build record

How kestrel 0.1.0 was built and what was checked. Written 2026-11-19. It
extends [101](101-design.md), which covers what kestrel is and does.

## How it was built

Built on 2026-11-19, on the branch `feat/kestrel` (from `321ebbd`), one
task at a time from a written plan. Each task had its own review and fix
round, and the whole branch had a final review and a fix wave before this
note. The plan file was deleted in the commit that added this note; its
last commit was `d989e9f` (the README, the lockfile and the measured cost
in 101 went in just before it).

Commits, oldest first (`git log 321ebbd..d989e9f`):

```
42ec66c chore: scaffold kestrel
a9c2b24 feat: review bot summary parsing
d0fb959 feat: PR row state
8a34c1a feat: gh accounts and tokens
e2f8058 feat: GitHub GraphQL client
b0cf907 fix: treat 2xx without JSON data as an http error
073ea7c feat: row tracker
c7fd3c9 feat: polling and sync
62ea481 fix: keep watched rows on failed fetches, floor rate wait
6a3dc6f feat: hand-off and merge
7791453 feat: PRs panel
59520c2 feat: wire kestrel together
360a7fd docs: hiding a PR, per Sean's live-check request
8899d3d feat: hide a PR from the list
0f99553 fix: keep the throttle note every round, and hold kick during a backoff or rate wait
d4fd4c4 fix: drop accounts gh no longer has, keep failed logins, list accounts only when needed
6a767a3 fix: watch only open PRs a signed-in account authored, and unwatch on merge
45bd573 fix: re-check the row after the merge confirm
0798eb5 fix: treat unseen checks as running, and primary rate-limit responses as a rate wait
8aa6fa5 fix: let a focused link handle Enter, and spin the running dot
deb9de6 test: assert the extra hand-off for real, and scan tracked paths for private words
66b5281 docs: perch.insertText appends at the end of the box
d989e9f docs: README, measured query cost in 101; commit the lockfile
```

## Checked live

On 2026-11-19, after a window reload, the PRs tab appeared beside Terminal
with Sean's real open PRs from both `gh` accounts. Rows showed "behind
base", "conflicts" and "N unresolved comments" correctly. Sean then asked
to hide old PRs, which became hiding per PR (see 101, "Hiding a PR").

**Not yet confirmed live:** clicking a reason into perch's box, the
clipboard fallback in a window without perch, and the cost line below
against a running window. The merge button was not exercised on a real PR.
The tests cover these paths with a stub, not a real editor.

## Measured query cost

Read-only, one account, 2026-11-19, with `rateLimit { cost }`:

- The list query (search, `first: 50`, with the rollup only): **cost 1**
  (3 PRs came back).
- The detail query for those 3 PRs by node id: **cost 2**.

So a quiet poll costs 1 point per account, as 101 estimated.

## The perch change

`perch.insertText` lives in a separate repo, `/git/perch`. Its two
commits, `1848b92` and `683e04b`, were fast-forwarded onto perch's
`main` and pushed on 2026-11-19, with no PR.

## Where it stands

- No PR, by Sean's choice: master was pushed straight to github.com/seanahn/kestrel (public) on 2026-11-19. The perch change went straight to perch's main the same day (5597082..683e04b).

## 0.1.2

- A hidden PR stays hidden when one search round misses it. It leaves the
  hidden list only when fetched by URL as merged or closed (up to 5 per
  round, rotating), merged from the panel, or missing from every successful
  list of its account for 24 hours. `kestrel.hidden` now stores
  `{ url, missingSince, account }`; the old array of urls still loads.

## Known gaps

Parked or deferred on purpose; none blocks 0.1.0.

- An expired `gh` login is retried every round (account list, token, two
  401s), bounded by the poll interval. Skipping dropped logins until
  Refresh would stop the wasted calls.
- A PR with more than 50 checks stays "running" and never shows **merge**.
  Using the rollup state would fix it.
- A rate limit with no reset header waits 60 s; a 403 with both
  `x-ratelimit-remaining: 0` and `retry-after` waits for the reset. Both
  err toward waiting longer.
- Watched PRs: the owner lookup includes expired logins, and the fetch
  always uses the first account's token. Rare.
- The 4-page search cap (200 PRs) truncates silently.
- A missing `rateLimit` in a response reads as 0 remaining, which could
  stall the below-200 guard.
- `merge()` doesn't validate that `expectedHeadOid` and the method are set.
- Hiding: hidden URLs of PRs closed while the extension was off are never
  pruned; the "hidden" view stays on after the last unhide; **×** isn't
  keyboard-focusable (the `h` key is).
- A row that changed while the panel was hidden fades 4 s after the panel
  is shown, so a change made while it was closed is easy to miss; the
  badge still counts it.
- The test stub keeps unused pieces from chirp; editor-tab reveal and
  view focus in perch's tests aren't asserted.
