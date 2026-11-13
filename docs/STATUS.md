# BELL Personal status

Updated 2026-11-08 on branch `feat/suite-personal` (a draft pull request,
not merged or deployed): BELL Suite v1 — the app switcher, Today's 今日複習
from BELL Explain, 來源詳情, to-do drafts handed over from Explain and
解釋這個 on tasks, events, ideas and mail — plus deep links to one task,
event or idea, route-level code splitting, the `public-fetch` cancellations
on Node 22, and the Known gaps marked 已修 below (see “BELL Suite v1 and
friction fixes”). The cross-app demo with the Explain side waits for that
branch to be integrated.

Updated 2026-10-15, after the mail-actions and assignments-from-mail
branches were merged into `main`, integrated (see “Mail row actions,
archive, search and assignments from mail”) and fixed after their review
(see “Mail and assignments review fixes”). Before that (2026-10-13) the six
feature branches were merged (tasks, habits-brief, work, calendar-events,
mail, today-settings), integrated, and hardened after a server, security, AI,
ops and live-API review (see “Review fixes” below) and a UX review (see “UX
review fixes”). `npm run build` passes and `npm test` passes every test.
Updated 2026-10-13, after the six feature branches were merged into `main`
(tasks, habits-brief, work, calendar-events, mail, today-settings),
integrated, and then hardened after a server, security, AI, ops and live-API
review (see “Review fixes” below) and a UX review (see “UX review fixes”). `npm run build` passes and `npm test`
passes every test. 2026-10-15: quick capture's deadline scaffolding and 自動整理
(see “Capture tidy-up”), a mail's original layout with its images
(see “Mail original layout and images”), and 用 AI 處理 in the inbox reader
(see “Mail AI 處理”).

## How it was checked

- **Seeded demo, no fixture override.** `npm run seed:demo -- --data-dir ./data`,
  then the server on :4360 without `BELLPERSONAL_TODAY_FIXTURE`, so
  `GET /api/today` is built by the real modules. No credentials were
  configured: the CLIs were pointed at missing paths (`GH_CLI_PATH`,
  `CLAUDE_CLI_PATH`, `CODEX_CLI_PATH`), so nothing reached GitHub or a model,
  and the vault had no Google, Moodle or Canvas token. Open-Meteo (weather
  and geocoding) and, after its one-hour cache expired, CTFtime were fetched
  for real; both are public and keyless.
- **Today matches the mockup from real data:** 8 rows in 最重要 / 今天內 /
  可以等, the digest (電子報 3 · 學校公告 2 · GitHub 通知 4), the agenda with
  the free slot paired with HW3 and 健身 linked to 運動, three habits with
  12 天 / 4 週 / 27 天, two ideas, 明天與之後 and 專案, weather, the brief,
  and counts 3 / 11, unread 12, badges 待辦 4 · 作業與專案 3 · 活動 1. Row order
  follows the SPEC rule (deadline first), not the mockup's hand order.
- **`server/integration.test.ts`** boots every registered module on the
  seeded day and covers the contracts between teams over HTTP: the Today
  payload; 完成 and 復原; 延後 (and the deadline limit); 加入行事曆 on the
  SITCON suggestion and its undo; 要參加; 轉待辦 on an inbox mail Today does
  not serve; 排進; 全部標為已讀 undone inside the 6.5 s window with zero Gmail
  calls (fake Gmail); the 503 refusal without Gmail; capture → todo and
  capture → calendar with undo; habit check-ins; the GitHub habit from the
  contribution calendar; settings validation; the rule brief with AI off;
  feeds; export.
- **Against the running server** (curl and Playwright): the same flows, plus
  the palette's 快速新增 creating an event, a free slot's 新增行程, 標為已交 on
  #/work moving the badge, 延後 from the inbox reading pane with keys,
  N / J / K / G-chords / ?, `/privacy`, `/api/health`, JSON 404s for unknown
  API paths, ids and threads, the SPA fallback on deep paths, and the
  Origin, Host and JSON-only write guards.
- **Screenshots** of every route at 1440×900 light and dark and 390×844, and
  Today at 900, compared with `docs/design/mockup` renders. A Playwright
  audit of all 21 routes at 320, 390, 860, 1024 and 1440 in both themes
  finds no horizontal overflow, no readable text under 12px and no console
  errors on page load.

## What works

- **Today:** the whole SPEC §4 page from the modules' `today()`
  contributions; queue actions through `POST /api/actions` with undo;
  habit check-ins through the habits API; quick capture through the shared
  `CaptureField` with the live parse preview; brief refresh; 排進.
- **收件匣:** categories, the reading pane (原始版面 in a sandboxed frame with images
  on request through the server, or 純文字), 回覆 / 轉待辦 /
  延後 / 封存 / 標為已讀 through the Today action queue, mail suggestions with
  加入行事曆 / 略過. The snooze popover is the same component as Today's.
- **行事曆 and 活動:** day and week views, free slots with 排進 or a prefilled
  palette, local events, 打卡 on an ended habit-linked event, CTFtime and
  feed events with 要參加, feed subscriptions in settings.
- **待辦, 靈感, 作業與專案, 習慣:** full CRUD with undo, the palette's 快速新增 /
  AI 解析 / 搜尋, projects with milestones, assignments with 標為已交, the
  GitHub tab, habit history with the heat strip.
- **連線與設定, #/setup, 使用指南, 404, `/privacy`, export.**

## Needs real credentials to verify

None of these were exercised against the live service; tests use fakes.

- **Google OAuth** (client, consent, callback, paste fallback, refresh,
  revoke) and everything behind it: Gmail full and incremental sync, the 404
  history fallback, `threads.modify` / `batchModify` after the undo window,
  charset handling of real messages, Google Calendar sync, and inserting
  events (加入行事曆, 要參加, 排進, capture) into Google.
- **Moodle (E3) and Canvas:** the token exchange and the assignment syncs.
- **GitHub through `gh`:** the GraphQL query ran once by hand during
  development; review requests, notification `PATCH` (標為已讀) and the 304
  handling have not run against a live account with pending reviews.
- **Claude Code / Codex:** mail triage, the daily brief, capture AI parse and
  idea tags were checked with a replayed stream only. AI 解析 is offered only
  while the selected CLI is signed in. The capture parse now gets 45 s from
  the CLI's start instead of a hard 8 s (ARCHITECTURE §10.8); the palette
  still shows the rule result at once.
- **Codex `outputSchema`:** `turn/start` now sends the schema's strict-mode
  subset (`strictSchemaFor`). It is listed in codex-cli 0.159.0's
  `TurnStartParams` but was not smoke-tested here (no Codex login); zod
  still validates every answer, and a schema the subset cannot express is
  sent as prose only. Smoke-test it before relying on Codex (AGENTS.md).
- **Behaviour taken from API documentation and vendor source, not from a
  live account:** Calendar 403 reasons (rate and quota limits retried, scope
  errors reconnect), events.insert with a client id and the 409 reuse path,
  calendar.events-only grants reading the primary calendar; Gmail
  format=metadata for a message over 5 MB and `/mail/u/<address>/#all/`
  links; Canvas planner `assignment_id` keys for quizzes and graded
  discussions and `plannable_date` as the due date; Moodle `aftereventid`
  paging, `nosubmissions`/`submissionsenabled`, the `accessexception`
  retry on an expired token; `gh api graphql` exiting 1 with partial data.
- **Deployment:** `deployment/` (systemd units, Tailscale Serve, backups)
  was not run as part of this integration.

## Review fixes (2026-10-13)

- **Availability:** a `configured()` that throws (vault key change, corrupt
  secrets file) no longer crashes the process or blanks Today; hostile
  mail, feed and LMS text is parsed in linear time and cut first; feeds
  bound RRULE expansion and VEVENT counts; one oversized Gmail message or
  one throttled shared calendar no longer stops its source; Today cuts an
  over-long contribution instead of dropping the module.
- **Privacy:** purge, disconnect and the retention window also delete
  suggestions, queue state and handled-list subjects derived from mail;
  briefs follow mail retention; the action log is pruned daily; trash and
  `*.before-v<N>` copies expire; `pre-deploy-` snapshots expire after 30
  days; `/privacy` states backup retention. The Serve script no longer
  leaves the environment (master key) under `backups/`.
- **AI:** prompt data escapes `<`/`>`; CLI failures never show paths or raw
  output; triage splits failing batches, backs off, coalesces runs and
  reads offset-free times in `BELLPERSONAL_TZ`; interactive work goes ahead
  of background work for the agent slot.
- **Correctness:** duplicate closing actions, concurrent accepts and
  concurrent 要參加 are refused; boot repair rereads Gmail/GitHub; 略過 and
  標為已交 survive the 60-day prune; capture reads 24:00, evening ranges
  and 提早 correctly.

Not done (optional parts of the findings): a
`BELLPERSONAL_PREVIOUS_MASTER_KEYS` rotation path (changing the key still
means reconnecting); requeueing triage messages already marked `failed`
(they keep the rules); a per-day automatic retry of the brief beyond one
retry after a transient failure; GitHub `Retry-After` handling.

## UX review fixes (2026-10-13)

Checked with `npm test`, `npm run build` and Playwright against a seeded
data dir (and an empty one for the first run), desktop light and dark and
390 px touch.

- **Keyboard and focus:** focus is kept when the drawer closes (≡), on
  日/週, settings tabs and inbox conversations (only a new page moves it to
  `<main>`; the narrow inbox returns to the list's scroll and row), when
  the queue clears, comes back after 復原 or shows new rows, and when the
  E3 / Canvas form opens or closes. The first J on 待辦 and 收件匣 lands on
  the cursor row; Tab stays inside the snooze popover; ⌘Z / Ctrl Z undoes a
  capture from the empty field; single-key hints hide when 單鍵快捷鍵 is off;
  the focus ring is `--accent` (≥ 3:1).
- **Touch and contrast:** queue rows can be swiped (`touch-action`), text
  links have 44 px targets, past agenda rows keep 4.5:1, and the undo bar
  stays full under reduced motion.
- **Data flow:** the queue's undo toast shows before the POST returns;
  #/tasks keeps a completion until a later list shows it and `usePoll`
  queues a refresh asked for during a fetch; #/inbox polls once a minute
  and refetches a mail only when its row changes; identical toasts replace
  each other and offline errors close when the service answers.
- **Copy and flows:** #/setup is offered on a fresh install although CTFtime
  rows arrive at boot, and 連線與設定 links back to it; 要參加 / 略過 quote
  the event (`QueueItem.subject`); the topbar theme toggle flips light and
  dark; ⌘↵ hands text to the palette as its draft (and saves like ↵ with
  AI off); http:// feeds are refused at the field; 移除 on a feed has 復原;
  a failed school connect says to check the address and press 連接 again;
  weather results' 選擇 buttons name their city; widgets show a still line
  instead of skeletons when Today fails to load.
- **Capture parse:** the parse job is cancelled when its request goes away
  (`cancelOnDisconnect`), so a parse aborted while its POST was in flight no
  longer holds the agent slot.

Not verified live, or deliberately limited:

- `cancelOnDisconnect` was checked against the Node server directly. Behind
  Tailscale Serve it relies on the proxy closing its upstream connection
  when the browser aborts (Go's reverse proxy cancels the backend request);
  this was not exercised through the tailnet. If it ever does not, the job
  still ends at its 45 s deadline and a newer parse cancels it.
- The ⌘↵ hand-over to AI 解析 and the AI option were checked by unit tests
  only (no CLI login on this host).
- A removed feed is deleted when its undo toast passes (6 s, or when
  another undo toast replaces it). Closing the tab before that keeps the
  subscription; nothing is lost either way.

## Mail row actions, archive, search and assignments from mail (2026-10-15)

Spec: `docs/design/SPEC-mail-assignments.md`; contracts: ARCHITECTURE §10.10.
The contracts commit landed the shared types, action ids (`trash`,
`unarchive`, `assignment`), the `suggestion.assignment` row, migration v4
(`local_assignments`), the `#/inbox?view=&q=` route and the new shortcuts;
two teams built the behaviour (below), then both branches were merged into
`main` and checked together (“Integration”).

### Mail actions, archive and search (mail team)

Built (SPEC-mail-assignments §2–§4, §8, §13):

- **刪除 and 移回收件匣** through `POST /api/actions` like 封存: cached
  conversations change locally at once (刪除 drops INBOX and adds TRASH),
  Gmail gets `threads.trash` (empty body) or `threads.modify` add INBOX after
  the 6.5 s window, and 復原 after the commit is `messages.untrash` on the
  messages 刪除 moved (+ INBOX where it was) or the inverse modify. Conversations outside the
  cache are resolved with one `messages.get(format=minimal)`. 503 without
  Gmail, 409 already in the trash / inbox. Nothing ever calls a permanent
  delete. Mail rows on Today list 刪除 #.
- **Without opening:** inbox and Today mail rows show their primary, 封存 and
  刪除 on hover or focus (the cursor row too; two icon buttons beside the
  reading pane); `#` / Delete and `A` act on the cursor row; on touch a left
  swipe reveals the 封存 (移回) · 刪除 tray, a right swipe runs the E action.
- **封存 / 全部 views** (`GET /api/gmail/search`): 25 messages a page from
  Gmail, grouped per conversation; cached ones from the cache (AI summary,
  state), the rest read once as metadata and kept in memory for at most 5
  minutes (`server/features/gmail/live.ts`), never on disk or in the log;
  載入更多; the cached archived mail when Gmail is not connected or fails. The
  reader reads a conversation outside the cache live (plain text only) and
  offers 移回收件匣 E · 刪除 # · 轉成作業 A; `findMailMessage` reads live too.
- **Search:** the field (`/`), the cached matches at once (NFKC, every term,
  operators left to Gmail), Gmail's other results 400 ms after typing stops
  (never while an IME composes; checked with a composition in Chromium),
  highlights, the zh-TW states, `#/inbox?view=&q=` in the hash, and the
  palette's 「搜尋信件「…」」.
- `/privacy` carries the §8 sentences (effective 2026-10-15). The seed adds
  three archived conversations.

Checked with `npm test` (fake Gmail: every request shape above, paging,
fallbacks, 429 wording, nothing written to `source_items`, no query text in
the log) and against a seeded server without Google at 1440 light and dark,
1100, 390 and 320 (no horizontal scroll, no console errors).

Not verified against a live account: the view queries
(`-in:inbox -in:snoozed -in:sent -in:drafts`, from the Gmail search-operator
list), whether `messages.untrash` restores INBOX by itself (BELL adds it), the
exact error Gmail gives for an expired page token (any 400 on a page-two
request is read as expired), and the quota cost of a cold page (≤ 1,005 units by
the published table, checked 2026-10-15). Known limits: 封存 / 全部 and search
results are not polled (a reload or a new search refreshes them); live rows
offer no 轉待辦 or 延後.

### Assignments from mail (assignments team)

Built (2026-10-15), checked with `npm test` (fake Gmail, stubbed model, the
seeded day) and in a browser on a seeded scratch data directory (no Google
account):

- **Native assignments** live in `personal.sqlite local_assignments`
  (`server/features/lms/native.ts`): 新增作業, 編輯 and 刪除作業 with 復原 on
  #/work (`POST`/`PATCH`/`DELETE /api/lms/assignments`, trash restore), and
  they survive mail retention, purge and disconnect (ids and the Gmail link
  only). The store opens on a database upgraded from `personal.v1.sql`.
- **轉成作業** (`A` on any mail, the reader, Today mail rows) creates the
  assignment at once from the rule extraction, or from a pending suggestion
  for that mail (which is then accepted); one per mail (409), 復原 deletes it.
  **加入作業** on a suggestion (Today, the reader, #/work's 「從信件找到」 card,
  or `POST /api/suggestions/:id/accept`) reuses an assignment already made
  from the same mail.
- **Detection.** The triage answer's `assignments` become one suggestion per
  mail and that mail gets no todo; deadlines without an offset are Taipei
  time, a date alone is 23:59, past ones and non-https links are dropped.
  With AI off, triage failed, outside the triage window or pending over 30
  minutes, `detectAssignment` proposes the same suggestion (「規則判斷」) for
  inbox mail of the last 14 days. Golden cases: `shared/assignment-detect.test.ts`
  (27 zh/en mails, including E3's own reminders, newsletters, fees, exam
  notices, closed deadlines and year roll-over).
- **Everywhere an E3 row goes:** #/work (course groups merge origins, chips
  E3 · Canvas · 信件 · 手動, 標為已交 reads 已繳交 for native rows), the Today
  queue (開啟信件 opens `#/inbox/<threadId>` in the app), the agenda's 截止
  rows, 明天與之後, the free-slot pairing, `nav.work` and #/calendar's
  deadline rows. A mail assignment that E3 or Canvas also lists (same code or
  title, course, deadline within 36 h) shows once, as the LMS row; the rules
  and the triage then make no suggestion for it.
- **Demo seed:** the pending HW5 suggestion from 林志明 教授's mail, Lab 3
  already added from 王助教's mail, and the manual 專題提案書 (no course).

Not verified: the grown triage schema has not been smoke-tested with Claude
Code or Codex on this host (AGENTS.md), so the model's `assignments` answers
are covered by stubbed runs only. `POST /api/lms/assignments/from-mail` does
not exist: 轉成作業 is `POST /api/actions` (SPEC-mail-assignments D9).

### Integration (2026-10-15)

Both branches merged with `--no-ff`; the conflicts were the seed counts (the
mail team's computed totals kept, plus the assignments team's
`local_assignments` check) and the §10.10 rows. No new migration (v4 came with
the contracts). The four features were then run together:

- **`server/integration.test.ts`** (every module, fake Gmail): 刪除 on Today's
  bill row and 封存 on an inbox-only newsletter, both undone inside the
  window with zero Gmail writes; 刪除 committed (`threads.trash`, never a
  permanent delete) and undone from the handled list (`messages.untrash` +
  INBOX); 封存 committed, the 封存 view from Gmail, the reader, search in
  each scope (and the exact `q`), 移回收件匣 (in 收件匣 at once, Today's
  handled row stays closed); 轉成作業 on a professor's mail that is a Today
  row (the rules add 轉成作業 A) with 復原, and on an archived mail only Gmail
  has (read live, never cached; due tonight, so it is in 最重要 and the
  agenda's 「Lab 4 截止」); 加入作業 on the HW5 suggestion; `nav.work` equals
  #/work's deadlines within 7 days plus the PR review; Gmail untouched by
  either assignment action.
- **In a browser** against the real app and every module on a seeded scratch
  data directory, with Gmail replaced by the in-memory fake (a scratch
  launcher; nothing reached Google, and every other host was blocked, which
  is why CTFtime and 活動訂閱 show their sync-failed notices in the
  screenshots): hover 封存 · 刪除 on inbox and Today rows with 復原 / Z, `#`
  on the cursor row, the 封存 view and a live reader, 轉成作業 from it, 移回收件匣
  with 復原, search in 收件匣 and 全部, 加入作業 on Today, #/work with 開啟信件 back
  into the reader, and `A` on an inbox row. Screenshots of #/inbox (hover,
  封存, search), #/work and #/today at 1440 light and dark and 390 (with the
  swipe tray); no horizontal scroll and no text under 12px (other than mono
  eyebrows and `kbd`) at 320, 390, 1024 and 1440 in both themes; no console
  errors.

Fixed while integrating:

- 移回收件匣 had no undo toast (it closes no Today row, so `offersUndo` said
  no); it now has 「已移回收件匣「…」」 with 復原.
- 復原 in the 封存 / 全部 views and in search results left the row hidden until
  a reload; the toast's undo now drops the page's own edit
  (`ActOptions.onUndo`), as it already did for Today rows.
- A conversation moved back from 封存 stayed hidden in 全部 and in searches
  for the rest of the session; 封存 and 移回收件匣 are now one `moved` edit
  that each view reads (`applyThreadEdits(…, view)`).
- 移回收件匣 was refused (400) when Today's last build still held the
  conversation's row from before its 封存; the core accepts it on `gmail:` ids
  like 轉成作業.
- 開啟信件 on an assignment whose mail had been deleted opened a reader that
  said 已封存 and offered 刪除 again; it now says 在垃圾桶, leaves 刪除 out, and
  移回收件匣 takes the conversation out of the trash (`threads.untrash`, then
  INBOX; 復原 trashes it again).
- An empty footer strip under the inbox list on phones (the key legend is
  hidden there).

Known limits: 封存 / 刪除 on a conversation that is not a Today row can be
undone only from its 6 s toast (Today's handled list lists Today rows only),
as 封存 already was. Inside the 6.5 s window a second 轉成作業 on the same
mail gets the core's 「這個項目剛剛已經處理過了。」.

### Mail and assignments review fixes (2026-10-15)

A review of the integrated branch found 30 problems; each is fixed at its
cause with a regression test (`npm test`: 683 tests), and the UI ones were
re-checked in a browser against the seeded scratch server with the fake
Gmail (port 4386, nothing reached Google).

- **Mail actions.** 刪除 (or 封存) right after 轉成作業, 標為已讀 or 封存 on a
  row that stays on screen is no longer refused as a duplicate: only a repeat
  of the same action is. 復原 of a committed 刪除 restores exactly the
  messages it moved (`messages.untrash`, never `threads.untrash`, which also
  brought back a message deleted in Gmail before); 復原 of a committed 標為已讀
  makes every message unread again that was, cached or not.
- **Archived mail and search.** A live row is placed by its whole
  conversation (`threads.get(format=metadata)`) with the reader's rule, so an
  inbox conversation whose newest message is my reply, or an archived one
  with a newer inbox reply, is no longer listed as 已封存 with 移回收件匣, and
  the list and the reader name the same message. A conversation only Gmail
  has, deleted from BELL, opens from 開啟信件 with 移回收件匣 instead of a
  404. Conversations and messages over the 5 MB response cap open (newest 20
  one by one, headers only when one alone is too big). 轉成作業 on live mail
  keeps no copy of the message past the 5-minute hold.
- **Inbox page.** 載入更多 shows whenever Gmail has more, even when every row
  of the loaded pages was acted on; it keeps focus while loading. Focus
  requests are one-shot, so typing in the search field never jumps to a row
  and runs E / # / A on it; ↓ from the field lands on the first result; ↵ on a
  title opens the conversation in 封存, 全部 and search results; hover buttons
  of a row that stays hand focus to its title; a failed deferred write drops
  the page's own edit; search notices sit under the local results; the
  compact 封存 tooltip names E only where E is 封存; matches are bold and
  underlined in `--accent`; the swipe reveal colours win over the hover and
  cursor fills again.
- **Assignments from mail.** Deadlines are read across commas (a date and
  its time in two clauses), only whole English month names count (「10
  marks」), procedures (憑證更新作業, 申報作業, 盤點作業…) and office or bill
  mail are not homework, a classmate's reply from a school address is not a
  teacher, and a short known course name matches whole words only. A mail
  assignment is merged with an LMS row only when both courses are known and
  the same (no more hidden records from another course's HW5). An
  announcement, its replies and reminders give one suggestion and one
  assignment (the owner's matching record is reused). The model's link is
  kept only when the cited mail carries it, and a long link no longer fails
  the whole triage batch. Inbox mail the model triaged before it was asked
  about assignments (`MailTriage.version` absent) gets the rule pass once.
  The 轉成作業 / 加入作業 toast is rewritten with the saved title and deadline;
  a mail already turned into an assignment says 已轉成作業 and no longer
  offers 轉成作業, and a 409 offers no 重試.
- **Work and Today.** Deleting an assignment from its dialog focuses the next
  row; Today's expanded mail row no longer gets the full-height swipe tray.

Not verified live: `messages.untrash` and the `threads.get(format=metadata)`
listing were checked against the fake Gmail only (both are in the Gmail API
reference and allowed by `gmail.modify`).
## Capture tidy-up (2026-10-15)

Reported by the owner: 「Deep Hacking 簡報 要在周日前生出來，主題是 Windows
Administrator Protection」 was stored as 「Deep Hacking 簡報 要在 生出來，主題是 …」
(only 周日前 removed, no AI ran), too long, and they asked for captures to
be tidied automatically.

- **Rule parser** (`shared/capture-parse.ts`): deadline scaffolding goes
  with its date or time (要在/得在/必須在/在/於, 最晚/最遲, 前/之前/以前/為止 + 要,
  到…為止, an attributive 的, before/by/until/due, on/at); a removed token
  between Han characters leaves no gap; doubled or dangling 「，」 and a
  trailing 的 go. English today/tomorrow/tonight and weekdays (abbreviations
  only capitalised or after next/before/by/on; narrowed by the review
  fixes below). The report now parses to
  「Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection」 due
  2026-10-18. 42 new golden cases plus a no-hole property over the table.
- **自動整理** (SPEC-ux §6.6.1, ARCHITECTURE §10.6.1): after the save, a
  `capture-tidy` job rewrites the title and notes (events: also the place),
  checked against the typed text, reversibly; 整理 on #/tasks and on local
  events in #/calendar (only records the owner typed: never mail, LMS,
  GitHub, feed or suggestion text); setting 自動整理快速記下的內容 (on). Records keep
  `originalText`. Events already in Google Calendar are not tidied (no
  Google update path); a pending insert waits for the tidy.

How it was checked:

- `npm test` (630 tests: the parser tables; `judgeTidy`; the job over HTTP
  with a replayed CLI stream — applied, no-op when equal, ungrounded date
  refused, secret refused, cancelled by an edit, edited through another
  path, AI off / setting off / short title → no call, CLI signed out →
  silent, one job per record, ahead of background triage for the slot,
  復原 and its 409 after an edit, events with the Google insert postponed
  then carrying the tidied title; the demo-day integration test through
  Today) and `npm run build`.
- A scratch server on :4391 (seeded demo, a fake CLI that replays the
  recorded stream with a 3.5 s delay): Playwright screenshots of the
  palette with the report, the 整理中… toast note and row pill, the
  「已整理成「Deep Hacking 簡報」 · 週日 10/18」 toast, the row editor with
  原文 and 整理, the settings switch and 整理 on a calendar event, at
  1440 light and dark and 390 light and dark; no console errors.
- **The real Claude CLI, three calls by hand** on that scratch server
  (Claude Code 2.1.292, sonnet, effort low): the first prompt gave
  「完成 Deep Hacking 簡報」 + 「主題：Windows Administrator Protection」,
  dueDay 2026-10-18 (2.8 s) — it added a verb, so the prompt now asks for
  the user's own words with an analogous example; the second gave
  「Deep Hacking 簡報」 + 「主題:Windows Administrator Protection」, dueDay
  2026-10-18 (3.3 s; notes now normalise the half-width colon); the manual
  整理 of the stored broken row gave 「Deep Hacking 簡報」 + 「主題：Windows
  Administrator Protection」 with the date kept (5.7 s).

Not verified or deliberately limited:

- Codex was not exercised with the tidy schema (it passes `strictSchemaFor`).
- Today's queue rows show the new title after the tidy but no 「整理中…」
  pill; a page reload while a tidy runs loses its toast (the rewrite still
  lands, and 原文 shows what was typed).
- 復原 tokens live in memory for an hour: not after a restart (復原整理 on
  the record does not need them; see the review fixes below).
- If a captured event's tidy waits more than two minutes for the agent
  slot, the Google insert goes ahead with the rule title and the tidy is
  then dropped (reason `google`).

## Capture tidy-up review fixes (2026-10-15)

A review of the tidy-up found fifteen problems; each is fixed at its cause
with a regression test.

- **Parser.** SAT, WED, sat and the Sun of 「Sun Moon Lake」/「Sun Yat-sen」
  are no longer weekdays (an abbreviation alone must be written Fri/Sat and
  not start a run of capitalised words; an unled weekday never overrides an
  earlier date). 於/在/會/得 that end a word stay (關於, 還在, 總會, 免得);
  after 關於/對於/由於/至於 the date is the topic and stays in the title,
  due that day at low confidence. The title is cut from the typed text
  (「：」 stays), joins without a space next to full-width punctuation
  (「簡報，要在週日前生出來」 → 「簡報，生出來」) and drops brackets that only
  held the date. 22 more golden rows; the no-hole property now also checks
  spaces after full-width punctuation, empty brackets, the colon and that
  every typed Latin word survives.
- **Checks.** A title must keep a key term that is not filler or a date
  word (「生出來」, 「主題是」, 「要在」 are refused) and add no word or Han
  character the text lacks (「Windows 更新」 is refused); notes are grounded
  the same way and a date in a note must be one the text names
  (「截止：10/25」 refuses the answer).
- **Undo that lasts.** The fields a tidy replaced stay on the record
  (`pretidy`); 復原整理 in the #/tasks editor and on a tidied local event
  (↶ in the wand's slot) puts them back any time, keeping 重要/完成/dates,
  until the user edits the title or notes. The toast's 復原 restores the
  same fields and works while they still read as the tidy wrote them. A
  title the user rewrote drops `originalText`, so 整理 reads the new title.
- **Toasts.** An automatic tidy's toast takes its capture toast's place
  while that is visible; otherwise it is a passive undo toast that leaves
  another capture's, 完成's or 刪除's 復原 and Z alone. Its date reads like
  the capture toast's: 「已整理成「Deep Hacking 簡報」· 10/18（日）」.
- **Editor.** An open #/tasks editor takes a tidy that lands into the
  fields the user has not touched; 儲存 sends only changed fields (an
  unchanged editor sends nothing).
- **Events.** Moved details go before 「來自 快速記下」, so the agenda meta
  shows them (「工程三館 · 記得帶筆電」); an event whose Google insert is in
  flight counts as in Google for tidy, 復原 and 復原整理
  (`CalendarService.isInserting`); 整理中… sits in the actions slot, so
  rows do not jump.
- **Scheduling.** Tidies wait at the new slot priority `soon`: behind an
  AI 解析 the user is watching, ahead of mail triage. A capture starts no
  tidy (and shows no 整理中…) when the last status probe found the CLI
  signed out; the save reads the cached probe and never waits for one.

How it was checked:

- `npm test` and `npm run build`. New tests: parser golden rows; `judgeTidy`
  with 「生出來」, 「主題是」, 「要在」, 「Windows 更新」 and dated or invented
  notes; 復原整理 over HTTP (keeps 重要, gone after a notes edit); 整理 after
  a title edit reads the new title; slot order AI 解析 › tidy › triage;
  signed-out probe → no tidy and no CLI spawned; 復原, 復原整理 and 整理
  refused while a Google insert is in flight, and a tidy landing then
  writes nothing; the agenda meta of a tidied event; the toast follow-up
  rules for capture → capture / 完成 / 刪除; the editor resync and
  changed-field patch; 整理中… in the calendar actions slot.
- A scratch server on :4394 (seeded demo, the fake CLI with a 3.5 s
  delay), Playwright at 1440 light and dark and 390: the palette capture
  (toast replaced in place, 復原), capture → capture and capture → 完成 (Z
  undoes the newer action; the tidy toast keeps its own 復原 and shows no
  key hint), the editor open while the tidy lands (fields follow, 重要 +
  儲存 keeps the tidy, 復原整理 later restores it with 重要 kept), a
  calendar event (row heights identical before and after; meta
  「工程三館 · 記得帶筆電」; ↶ offered), a signed-out CLI (no 整理中…), the
  settings hint; no console errors.
- **Real Claude CLI, two calls by hand** on that server (Claude Code
  2.1.292, sonnet, effort low): the report → 「Deep Hacking 簡報」 +
  「主題：Windows Administrator Protection」, due 2026-10-18 kept, applied
  through the new checks (3.0 s); 「今天 21:00 跟林教授 meeting
  討論期末專題提案，記得帶筆電 @工程三館」 → 「跟林教授 meeting」 with the
  rest moved to notes; the agenda meta read 「工程三館 · 內容：討論期末專題提案」
  (2.5 s).

Not verified or deliberately limited:

- The grounding checks are conservative: a title that rephrases with a
  character the user did not type (「回覆」 for 「回」) is refused and the
  rule result stays.
- A date after 關於/對於 still gives the due day (at low confidence, so the
  palette offers AI 解析); the parser cannot tell a topic from a deadline.
- 復原整理 is not offered on an event already in Google Calendar (no update
  path), so with Google connected it is only possible inside the insert's
  undo window.

## Mail original layout and images (2026-10-15)

Asked by the owner: 「信件有辦法顯示圖片嗎？在保持安全性的同時」, then chose 原始版面（沙盒）
and 外部圖片按一下才載入. Spec and every security decision:
`docs/design/SPEC-mail-html.md`; contract: ARCHITECTURE §10.11.

- **原始版面** (default, remembered as `mail.bodyView`, switchable in the reader and
  in 資料與隱私): the message's HTML is read live (`messages.get(format=full)`,
  never stored, 5 minutes in memory), sanitized on the server (sanitize-html 2.18.0
  allowlist, CSS rebuilt from a postcss parse, a fixpoint check) and shown in
  `<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  srcdoc>` with its own CSP, on a white card in both themes, sized to its content
  and zoomed to fit (down to half) on a phone. A mail without HTML, too large,
  unsafe or without Gmail shows its plain text with a one-line note.
- **Images:** `cid:` parts and image attachments come from Gmail through
  same-origin endpoints (raster only, by magic bytes, sandboxing headers); the
  attachments show as a strip under the message. Remote images are blocked until
  顯示圖片 (or `I`) or 一律顯示「address」的圖片; then the server fetches them
  through a signed proxy (HMAC per message, public addresses only, IP-pinned,
  ≤ 3 re-checked redirects, 10 s, 10 MB, no cookies or Referer), all at once when
  the body is built, so the mail's CSS cannot learn hover, screen or dark mode; the
  sender sees the server's IP address (the owner's own connection) and says so.
  Known tracking pixels (size, style, known hosts, redirects into them) are never
  loaded and are counted; a decoded 1×1 is hidden after its request went out.
- **信任的寄件者** (`mail.trustedImageSenders`): added from the reader by address,
  or in 資料與隱私 by address or domain; 移除 with 復原.
- `/privacy` states the HTML and image handling (§02, English summary).

How it was checked:

- `npm test` (840 tests) and `npm run build`. New: the SSRF guard (address table;
  decimal, octal, hex, short and IPv4-mapped forms; rebinding with a resolver that
  turns private after the check; redirects into private space; every-address rule;
  caps; a real socket pinned to the checked address), the sanitizer (an XSS / mXSS
  corpus of 114 entries in both image modes, read back by an independent tag and
  attribute check; fixpoint; CSS escapes, comments, at-rules and url() forms;
  tracking pixels; pathological input stays under 2.5 s), raster sniffing and file
  names, the proxy's signatures and budgets, and the endpoints over HTTP with the
  fake Gmail (rotating attachment ids, Big5 HTML, the 5 MB fallback, not connected,
  forged signatures, SVG / HTML / oversize / private answers, the guard and the
  identity gate, logs without URLs, subjects, senders or Content-IDs, purge), plus
  the reader's markup and frame rules.
- During development, 40,000 random sloppy documents fed to the sanitizer: none
  failed to settle.
- A scratch server on :4401 (seeded demo, the fake Gmail with five HTML fixtures,
  an in-process network serving demo images): Chromium at 1440 light and dark and
  390 light and dark — the newsletter blocked and shown, the cid mail with its
  attachment, the 720 px sale mail zoomed, the hostile mail (no script, handler,
  dialog, overlay or outside request; its one remote image was refused by the
  proxy without any network request), `I` from the reader and from inside the
  frame, 一律顯示 with 復原, 純文字 remembered across a reload, 資料與隱私 add and
  remove; no page-level horizontal scroll at 390; no request from the page left
  the app's origin.

Review fixes (same day; SPEC-mail-html D7, D8, D11, D13, D15, D16, D18–D21):

- Security and availability: the CSS number scan was cubic (ten 2,000-digit
  `width`s held the event loop for 47 s) — every scan is now linear and the
  sanitizer has a 3 s budget; images that declare too many pixels (a 64 KB PNG
  of 23000²) are refused for cid:, attachments, the proxy and `data:`; remote
  images are fetched by the server when the body is built and the proxy answers
  only from that (no hover, device or dark-mode side channel); lookups use c-ares
  and are cancelled at the deadline; one message holds at most 4 of the 6 proxy
  slots and waits at most 30 s for one; redirects into known trackers are not
  followed; sizes are capped with exponents, calc() products and sums, zoom and
  scale(); an escaped quote no longer hides a CSS function.
- Truthful copy: the banner note, 信任的寄件者 and /privacy no longer promise to
  hide the IP address or to never load any tracking pixel.
- Reader: Enter on a link inside the mail opens it (it ran 封存); the frame
  shrinks as well as grows (a one-line reply was a 160 px card); the paper stays
  white with dark text under a dark system setting; a failed image load says so
  with 重試 and 顯示圖片 / `I` work again; focus moves to the note after 顯示圖片;
  bodies with proxied images are asked for again after five minutes; links to
  nowhere are plain text; only the real host is a link's tooltip and a
  bidi-reversed mailto is no link; `<html dir="rtl">` mail is RTL; a plain-text
  conversation keeps the plain-text note; a refused attachment thumbnail is a
  quiet tile.
- Checked: `npm test` (864) and `npm run build`; a scratch server on :4403 with
  the review fixtures in Chromium at 1440 light/dark and 390 (the ReDoS mail
  answers in 57 ms with the server responsive, hover adds no upstream request,
  dark-scheme mails stay white, Enter on a link opens a popup and archives
  nothing, heights 56 px and 730 → 611 px, the failure/retry flow, focus, RTL,
  dead links, the bombs refused) and the hostile mail again (no script, handler,
  dialog, overlay or outside request, light and dark).

Not verified live: real `format=full` MIME trees and attachment-id rotation
(emulated in the fake), real senders' charsets in HTML parts, real CDNs behind the
proxy (redirect chains, `Content-Length` behaviour). Deliberately limited: default
ports only for remote images; AVIF without an `ispe` box is refused; the
sender sees the server's IP (no egress proxy); a proxied image no longer held
(5 minutes, the 32 MB cache) is not fetched again for the browser; a `<style>`
block that does not parse whole is dropped; older messages load their layout when
opened; a refused proxy image shows as broken and the browser logs the failed
request.

## Mail AI 處理 (2026-10-15)

Asked by the owner: 「在信件收件夾打開信後，可以按下 AI 處理選項自動決定要加入行事曆、
代辦等相關事項」. Contract: ARCHITECTURE §10.12.

- **用 AI 處理** in the reader's action row (cached conversations only; shown
  while 使用 AI is on and the selected CLI is signed in): the model reads the
  newest four messages of the conversation and decides which events, todos
  and assignment it holds. They appear under 從這封信找到 (and on Today as
  `ai:` rows) with their one-tap 加入行事曆 / 加入待辦 / 加入作業 and 略過.
  Following the product rule, the model decides *where* each item goes, and
  nothing is created until the owner taps it.
- A second run proposes nothing it already proposed (pending, added or
  dismissed), and what the background triage already found is not doubled.
  A message with a secret shape is never sent; `/privacy` §04 and the English
  summary say what the button sends.
- **Checked:** `server/features/gmail/process.test.ts` (a stubbed runner and
  the recorded stream-json fixture through the real runner) and
  `src/pages/inbox/mail-process.test.ts`; `npm run build`; `npm test`: 868
  pass, 3 `public-fetch` tests cancelled in this sandbox, the same 3 as on the
  unmodified base. (2026-11-08 correction: not DNS. On Node 22 the tests'
  fakes held no event-loop handle, so node:test cancelled them at
  `beforeExit`; fixed in the tests, see “BELL Suite v1 and friction fixes”.) On the seeded demo, with a
  fake `claude` that replays the fixture with a canned answer (no model,
  Gmail or network call): 用 AI 處理 → 處理中… and the server's progress line
  → 「AI 找到 2 個項目，請在下方「從這封信找到」確認要不要加入。」 → 加入行事曆
  with 復原 → a second run says 「AI 沒有找到新的項目，先前找到的都列在下方。」,
  in the split view at 1440 px and on a 390 px phone.
- **Not verified:** a real Claude Code or Codex answer to this prompt and
  schema. The Claude argv is the verified one, unchanged.

## Student polish: less noise, a way out of the pile, a 課表 (2026-10-23)

Owner brief: the best one-day tool for a student, fewer features of higher
quality, low friction, no noise, nothing left unorganized. An audit of the
running app (seeded and fresh install, desktop and 390 px) found five things;
each is fixed at its cause. `npm run build` and `npm test` (924 tests) pass.

- **A fresh install is calm.** Its whole Today queue used to be CTFtime
  contests (“辛苦了，還有 2 件事等你處理”), plus a permanent “AI 摘要暫時無法使用：
  Claude 尚未登入” line and a “到 連線與設定 加入活動來源” nag. Now:
  - `ctftime.enabled` defaults to **off** (opt-in, 連線與設定 and the last
    setup step). Settings migration v3 keeps it **on** for any install that
    already has a `ctftime.*` row (the owner's `ctftime.minWeight`), and never
    overwrites an explicit choice (`server/db/database.test.ts`). The demo
    seed turns it on, so the mockup day is unchanged.
  - #/setup now asks for the school first (步驟 1), Google second, and only
    then the optional extras (天氣 on, GitHub, CTFtime off). The always-on
    disabled “待辦、靈感、習慣” switch is gone.
  - A model that is simply signed out no longer prints a warning on Today
    (capture tidy and mail AI were already silent); the 規則整理 tag says who
    wrote the brief. Timeouts, usage limits, bad answers and connection
    failures still show the note with 重試.
  - The 明天與之後／專案 card renders nothing when it has nothing (and nothing
    is broken).
- **The pile has a way out** (todos with no date, ideas):
  - #/tasks: 排日期 on every undated row (hover or focus, always visible on
    touch; `S`, then 1–5): 今天 · 明天 · 這週末 · 下週一 · 選日期…, optimistic with
    復原. `#/tasks?group=someday` focuses the first undated row.
  - Today: one muted line under the queue, 「還有 N 件待辦沒排日期 · 去排一下」, for
    open undated todos created before today's local day. It changes no count.
  - #/ideas: 轉成待辦 makes a todo and archives the idea in one transaction;
    復原 restores both (ARCHITECTURE §10.13).
- **A weekly 課表 without Google** (ARCHITECTURE §10.13): local events can
  repeat every week (optional 直到), from quick capture (「每週一 10:10 作業系統
  @EC115」) or the 重複 chip, skip a single week (只刪這一次) or delete the
  series, each with 復原. They show on Today, #/calendar day and week, free
  slots and habit links. They are never inserted into Google Calendar (the
  toast and the preview say 只存在 BELL). The empty Today agenda now offers
  新增行程 first and 連接 Google second. The seed adds a Thursday class.

Checked in Chromium against seeded and fresh scratch servers (no Google, no
model): the fresh Today, the setup page, a captured weekly class on Today, in
the week view of the following Monday and with its toast, 排日期 by key with
復原, at 1440 and 390 (no horizontal overflow). Not verified: dark theme and
721–1080 px widths for the new rows, IME composition in the real input
methods, and a Google-connected account with a weekly class (the fake Google
is covered by `server/features/calendar/repeat.test.ts`).

### Round 2 (2026-10-24): found on the owner's real Today, then deployed

On the live service the headline read 「還有 31 件事」: 25 of them were mail
proposals (campus lectures from mailing lists, one of them already over). Now
Today shows at most three event and todo proposals, the most urgent first, none
that are moot and no event more than two weeks away (open items 31 → 9);
assignment proposals are exempt. #/events and the 活動 badge leave started
events out. Nothing is dismissed (ARCHITECTURE §10.13).

Local events can be edited in place (`PATCH /api/calendar/events/:id`, pencil on
day rows, a click on a week-grid block, 復原), a weekly class included; the
week grid shows the repeat mark and can delete. Events already in Google are
refused with a pointer to Google Calendar. `npm test`: 952 pass.

Deployed as releases `20261023-student-polish-b22ffca` and
`20261024-suggestion-cap-30fe21c` (data snapshot `pre-deploy-*` before each;
settings migration v3 kept CTFtime on for the owner's database).

## BELL Suite v1 and friction fixes (2026-11-08)

Branch `feat/suite-personal`, contract `suite-contract v1` rev. d (owned by
`bell-suite/contracts/`; Personal keeps its own copy in `shared/suite.ts`).
Architecture: `docs/ARCHITECTURE.md` §10.14.

### BELL Suite

- **Settings.** `BELLPERSONAL_SUITE_LINKS` (browser links) and
  `BELLPERSONAL_SUITE_FETCH` (server reads) are separate. Links: loopback
  http/https, otherwise https on this app's own tailnet only. Reads:
  `http://127.x.x.x:port` or `http://[::1]:port` only, no DNS. Credentials,
  paths, queries, fragments, wildcards, port 0, duplicates and self links
  stop the server at start with a zh-TW message naming the variable.
- **API.** `GET /api/suite/manifest` and `GET /api/suite/sources[?refresh=1]`,
  behind the same Host/Origin/Sec-Fetch-Site guard and identity gate as the
  core routes, `Cache-Control: no-store`, no CORS, CSP unchanged. No write
  endpoint: siblings cannot write Personal (`POST` → 404).
- **Reads.** Per source: 3 s total, a 64 KB stream cap, no redirects, only a
  200 `application/json`, strict schema (one bad item or an unknown field
  makes the whole feed `unavailable`), `href` must be one of Explain's
  allowed routes. Memory-only cache: 60 s fresh on page entry, 5-minute
  refresh while the page is visible, `?refresh=1` joins a read in flight,
  feeds older than 30 minutes without a success are dropped. Request
  parameters cannot choose the target. PR is `unconfigured` or
  `unsupported`; no numbers are made up.
- **UI.** Topbar app switcher (未連結 for a sibling without a link); Today's
  今日複習 card from Explain with loading, empty, `stale` (上次更新 … ·
  目前無法連線 BELL Explain, 重試), `unavailable` and `unconfigured` states,
  never a 0 for an unknown count; 來源詳情 drawer (desktop side panel,
  full-width on phones) saying what is read.
- **Handoffs.** `#/tasks?draft=&from=explain&back=`: validated, removed from
  the URL with `replaceState`, kept in `sessionStorage`
  (`bell.suite.handoff.tasks`), a new handoff replaces the old one. The
  draft panel writes nothing until 建立待辦, which is guarded against a
  double submit. 回到 BELL Explain is built from the configured link plus an
  allowed Explain route, never from the handoff. 解釋這個 on a task, event,
  idea or mail opens `#/explain?text=&title=&from=personal&back=` on Explain
  with a Personal route as `back` (raw id, or the list page when the id does
  not fit the contract). Opening or prefilling never calls a model.
- **Repeated fields (contract D9).** A handoff that repeats `text`, `title`,
  `draft`, `from` or `back` — also under a percent-encoded name such as
  `dr%61ft` — is refused as a whole: the URL is cleaned, the old draft is
  cleared, and the page says 「已忽略這份草稿：連結裡有重複的欄位，無法確定內容與
  來源」, so two parsers cannot read two different drafts from one link. Other
  repeated parameters are ignored; a link without the optional fields still
  works. The contract fixtures (rev. d) are copied into
  `src/suite/handoff.test.ts`.
- **Handoff attempts (contract rev. d).** On `#/tasks` only, any reserved
  key (`text`, `title`, `draft`, `from`, `back`) — even empty, even
  percent-encoded — is a new handoff attempt: the URL is cleaned and the old
  draft cleared before anything is checked. An attempt without `draft`
  (only `from`, `back` or `title`, or Explain's `text`) or with nothing left
  after cleaning is refused with 「已忽略這個連結：裡面沒有可以建立的草稿內容」 and
  關閉, writing nothing. `#/tasks`, `?group=someday`, `?focus=…`, other
  parameters, other routes and a differently cased key (`Draft`) are
  ordinary visits that keep the stored draft. Covered by the contract cases
  E1–E11 and by `task-handoff-capture.test.ts`.
- **Text direction (D7).** The draft keeps the user's text exactly (no
  stripping of direction marks); the title and notes fields are
  `dir="auto"` and the created title is in `<bdi>`, so right-to-left text
  cannot reorder the copy around it. The heading names the sender from
  Personal's own table (`SUITE_APPS`), never from the handoff.
- **Logic apart from the look.** `useTaskHandoff` and `useTaskDraftForm`
  hold the reading, the checks and the one write; `TaskDraftFormView` and
  `TaskHandoffNotice` only render what they return, for the v2 visual layer.
- **Deep links.** `#/tasks/{id}`, `#/events/{id}`, `#/ideas/{id}` land on
  the object (scroll, flash, focus), a finished task shows its own panel
  with 改回未完成, and a missing one shows 找不到這個待辦／活動／靈感 with a
  way back. A malformed, multi-segment or dot-segment (`.`, `..`) id is the
  404 page and never reaches an API path.
- **Code splitting.** Pages are lazy route chunks (main `index` ≈ 466 kB,
  gzip ≈ 157 kB, no chunk-size warning) prefetched when idle. A chunk that
  fails to load shows 「無法載入這個頁面」 with 重新載入; a missing
  `/assets/*` file is now a plain 404 (before: the SPA page with a 200).
- **Habits heat strip.** Each cell of the last 35 days (the days the server
  lets you edit) is a toggle: one tab stop for the strip, ←/→ a day, ↑/↓ a
  week, Home/End, Space or ↵ to check or uncheck that day (POST/DELETE
  `/api/habits/:id/check` with `day`). Cancelling a past day shows 復原,
  which puts back the original check time; a second press while a write is
  out is ignored. Future days, days before the habit existed and the GitHub
  auto habit stay a picture. 取消昨天的打卡 now also gets 復原. No new CSS:
  the dots are the same `<i>` inside a reset `<button>`.
- **可以等 order.** The two events to decide on are shown soonest first:
  start time breaks the tie after deadline, rank and received (it was id).

### Known gaps from this list

| Gap | State |
|---|---|
| Mail actions while Gmail is not connected | 已修 in the inbox list and reader: 封存／標為已讀／刪除／移回收件匣 are refused in the page with an explanation instead of a 503 (still not queued). Today's focus-queue mail actions: not checked. |
| Rule fallback files a professor's mail under 學校公告 | 需真實帳號: which senders lack the IMPORTANT label only shows on a real mailbox; a rule change without it could misfile other mail |
| 用 AI 處理 shortcut and live-Gmail conversations | 待決定: the shortcut is a new key in the locked SPEC-ux §6.2 table, and one key press would start a model run (about 1–2 h with the `?` dialog and tests); a conversation read live has to be fetched into the cache first, which only real Gmail can check |
| Weekly events: no repeat icon on Today | 已修 (repeat mark before 每週X) |
| Weekly series not in Google Calendar | 需真實帳號, later phase: a Google recurring-event write (RRULE, skipped weeks, one Google id per series) is a new write path, about 1–2 days |
| Mail proposals page | Later phase (after the v2 look): a new page and route; most of the work is the page itself |
| Calendar free slots, deletion, 可以等 order | 可以等 order 已修 (start time breaks the tie). Free slots: a new week-view layer, after the v2 look. Deleting an event already in Google needs a Google delete path and a real account |
| Feeds without event dates, private hosts | 待決定: an undated item has no place in 活動 (skip it, as now, or a new reading list). Blocking private hosts would also stop tailnet and LAN feeds that work today; routing feeds through `public-fetch` is about half a day |
| Work: linked todos read-only | 已修: each links to `#/tasks/{id}` (editing stays on 待辦) |
| Work: GitHub reconnect message | 已修: says to log `gh` in again on the server, with 重試 |
| Habits: ⋯ menu under toasts | 已修: opens upward when it would not fit, stacks above toasts and the quickbar |
| Habits: heat-strip cells not clickable | 已修: the last 35 days toggle from the strip, by mouse or keyboard (above) |
| Weather geocoding names | 需線上驗證: preferring city-level matches can only be checked against the live geocoder, which tests do not call |
| Today weather icon, E3/Canvas account name | Icon: after the v2 look (a new icon set). Account name: needs the name kept at connect (a settings field) and a real E3 or Canvas to see what it returns |
| Tasks: tags, bare 1–6 o'clock | Tags: a data-model change (stored tags, API, capture parsing, a filter), about a day plus a migration. Bare 1–6: a product choice of the default (afternoon as now, morning, or asking) |
| 自動整理 cannot change a Google event | 需真實帳號 (no Google update path) |
| One 574 kB bundle | 已修 (route-level chunks, above) |

### `public-fetch` on Node 22

The 3 cancelled tests were not DNS. Their fakes (a request that never
answers, a resolver that never settles) held no event-loop handle, and the
timeout is an unref'd `AbortSignal.timeout`, so on Node 22 the loop emptied
and node:test cancelled the pending tests at `beforeExit`; Node 24's runner
keeps the loop alive for pending tests (nodejs/node#58800), which hid it.
The fix is in the test doubles only (`holdEventLoop`: a never-firing
interval released when the request's signal aborts); `server/public-fetch.ts`,
the timeouts and `engines` are unchanged, no test was removed or skipped.

### How it was checked

- `npm run typecheck`, `npm run build` and `npm test` on Node v22.22.1 and
  v24.21.0: see the pull request for the exact exit codes and counts (logs
  in `bell-suite/logs/2026-11-08/lin/`).
- Isolated dev servers on 127.0.0.1 only (Personal :21103 with
  `BELLPERSONAL_TAILSCALE_USERS` unset, not production; Explain :21104 from
  the suite API branch), data under `/tmp`, model, `gh` and Google paths
  pointing at missing files. curl: manifest, sources, `refresh=1`, a
  `target=` parameter ignored, 403 for a cross-site `Sec-Fetch-Site` and a
  foreign Host, 404 for `POST /api/suite/sources` and a missing chunk; with
  Explain stopped, sources turn `stale` and keep the last feed.
- In a browser on that instance: the switcher (Explain linked, PR 未連結),
  今日複習 ready then 資料過時 after Explain stopped, 來源詳情, a to-do draft
  from Explain (URL cleared, one to-do after a double click, back link to
  `#/note/b:c.d_e-f`), an unlinked `from=pr` ignored, an absolute `back`
  dropped, `#/tasks/{id}` landing, missing task/event/idea pages, dark mode,
  and a dynamic import of a missing chunk rejecting on the 404.
- **Not verified:** the 360 px layout in a real browser (the viewport could
  not be resized there), Explain's `#/explain` page receiving 解釋這個
  (it lives on the Explain frontend branch), any real Gmail, Google, LMS,
  GitHub or model account, and the production deploy.

## Known gaps

- Mail: 封存, 標為已讀, 刪除 and 移回收件匣 are refused while Gmail is
  not connected, rather than queued (the inbox now says so before sending,
  2026-11-08). The rule fallback can file a professor's mail without
  the IMPORTANT label under 學校公告; AI triage fixes it when it runs.
  用 AI 處理 has no single-key shortcut and is not offered on conversations
  read live from Gmail (封存 or search results outside the cache).
- Weekly events: a series is never in Google Calendar, so an event already in Google cannot be edited in
  BELL either (「請到 Google 行事曆修改」).
- Mail proposals beyond Today's three most urgent wait pending; todo and
  assignment proposals have no page of their own, only Today and the reader.
- Calendar: the week view shows no free slots; only local events that are
  not also in Google can be deleted from #/calendar.
- Feeds: RSS/Atom items without a recognisable event date are skipped, so a
  plain blog feed yields no events. Feed URLs must be HTTPS without
  redirects, but private or loopback hosts are not blocked (only the owner,
  behind the identity gate, can add feeds).
- Weather: Open-Meteo geocoding with `language=zh` can return Simplified
  Chinese names and village-level matches (「新竹」 finds villages before
  新竹市).
- Today: the weather icon only tells rain from everything else; the account
  name of a connected E3 or Canvas only appears in the connect toast.
- Tasks: todos have no tags, so `#tags` typed into a todo capture are kept
  in its notes. The rule parser reads a bare 1–6 o'clock as the afternoon
  (low confidence). 自動整理 cannot change an event that is already in
  Google Calendar (no Google update path yet).

## Running the demo

```sh
npm run build
npm run seed:demo -- --data-dir ./data          # the mockup day relative to now
BELLPERSONAL_PORT=4360 BELLPERSONAL_FRONTEND_PORT=4360 \
BELLPERSONAL_DATA_DIR=./data BELLPERSONAL_SECRETS_DIR=./.secrets \
BELLPERSONAL_MASTER_KEY=<32 random bytes, base64> npm start
```

The seed marks CTFtime and the feeds as fetched 42 minutes before `--now`.
Once that cache is an hour old, a page load fetches them for real: the live
CTFtime list replaces the demo CTFs, and the demo feed addresses replace or
fail their events. Re-run the seed to get the mockup day back. Point
`GH_CLI_PATH`, `CLAUDE_CLI_PATH` and `CODEX_CLI_PATH` at a missing file to
keep a demo run away from your GitHub account and model subscription.
