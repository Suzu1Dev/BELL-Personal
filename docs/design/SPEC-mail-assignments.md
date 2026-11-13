# BELL Personal — UX addendum: mail row actions, archive, search, assignments from mail

Date: 2026-10-15. Owner: design and tech lead. Status: **locked for implementation**.

This addendum extends `docs/design/SPEC-ux.md` (the binding spec) for four requests from the owner:

> 信件的部分我希望可以不用點開也可以選擇封存或刪除，然後作業的部分，有些作業不是用 moodle 系統用作業設定的，而是老師寄信通知的，像這種我希望也都可以一起整合在作業專區，然後我希望也可以在收件夾去看封存過的信件，然後還有搜尋信件的功能

| # | Feature | Section |
|---|---|---|
| F1 | 封存 or 刪除 a conversation from a list row, without opening it (inbox rows, Today mail rows) | §2 |
| F2 | Assignments announced by email sit in 作業 next to E3 / Canvas ones | §5 |
| F3 | Archived mail can be browsed inside 收件匣 | §3 |
| F4 | Mail search | §4 |

Everything here follows SPEC-ux §1 (open once, finish once; AI proposes, you confirm; never silently wrong; optimistic and reversible; calm; zh-TW first). Where this file is silent, SPEC-ux applies. Where they disagree, this file wins; every override is listed in §0.2. The server contract (types, endpoints, owners) is `docs/ARCHITECTURE.md` §10.10; the types in `shared/` are the source of truth.

---

## 0. Decision record

### 0.1 Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **刪除 moves the whole conversation to Gmail's trash** (`threads.trash`, allowed by `gmail.modify`). BELL never deletes permanently (`messages.delete` / `threads.delete` are never called). | It is what Gmail's own 刪除 does to a conversation, it is recoverable for 30 days in Gmail, and the privacy policy promises no permanent deletion. Rows are conversations everywhere (SPEC-ux §3.3), so the verb acts on the conversation, like 封存 (`threads.modify`). |
| D2 | **One action pipeline.** 刪除 (`trash`), 移回收件匣 (`unarchive`) and 轉成作業 / 加入作業 (`assignment`) are `ActionId`s sent to `POST /api/actions`, like 封存 and 轉待辦. There are no direct `/api/gmail/messages/:id/archive…` endpoints. | One optimistic update, one 6 s undo toast, one deferred remote write (6.5 s), one handled list and one count system (SPEC-ux §6.5). 轉待辦 already works on inbox mail Today does not serve, through the same route. |
| D3 | **Every conversation target is `gmail:<messageId>`** of the conversation's newest listed message, cached or not. The gmail handler resolves the thread from the cache, or with one `messages.get(format=minimal)` when the message is not cached. | No second id grammar; the inbox, the archive view, search results and Today rows all post the same body. |
| D4 | **Archived mail and search results are read live and never cached on disk** (`GET /api/gmail/search`). The server keeps them in memory for at most 5 minutes. | The 30-day cache stays the inbox window it is today (decisions.md item 9); `/privacy` gets one sentence instead of a new retention class. |
| D5 | **Mail and manual assignments are native records** in a new personal table `local_assignments`, not `source_items`. Their Today and action id is `assignment:<uuid>` (new queue source `assignment`, owned by the lms module). | They are the owner's own records (like todos): they survive mail retention, purge and disconnect, and the LMS syncs (which replace their own source items) can never remove them. |
| D6 | **Three ways in, one record.** (a) AI triage proposes an `assignment` suggestion; (b) when AI is off or failed, a rule detector proposes the same suggestion; (c) 轉成作業 on any mail creates the assignment at once (the user's tap is the confirmation), with rule extraction; (d) 新增作業 on `#/work`. All four end in the same `local_assignments` row, editable afterwards. | Product rule: model output is only ever a suggestion; a direct user action may create. |
| D7 | **A native assignment marked 標為已交 shows 已繳交**, not 已交（本機）. | 已交（本機） means "BELL's mark, waiting for E3 to agree" (SPEC-ux §6.4). Nothing will ever agree or disagree for a teacher's email, so the pill would suggest a pending state forever. The mark uses the same core action (`submitted`, until-change) as LMS rows. |
| D8 | **Endpoint names follow conversations.** List and search: `GET /api/gmail/search?view=&q=&pageToken=`. Reader: the existing `GET /api/gmail/threads/:threadId`, which falls back to a live read for conversations outside the cache. | The task's proposed `/api/gmail/messages…` names would return conversations under a "messages" path and duplicate the existing thread reader. |
| D9 | **No `POST /api/lms/assignments/from-mail`.** 轉成作業 is `POST /api/actions {itemId: "gmail:<id>", action: "assignment"}` (D2). | The action route already gives the row exit, counts, the handled list and 復原; a second endpoint would need its own undo. |
| D10 | **Archive view query:** `-in:inbox -in:snoozed -in:sent -in:drafts -in:spam -in:trash` (see §3.6 for the evidence). | It names exactly "not in the inbox, not snoozed, not my sent mail, not drafts, never spam or trash", using only system-label operators. |

### 0.2 Overrides of SPEC-ux

| SPEC-ux | Override |
|---|---|
| §3.3 收件匣 (layout) | The list card's head gains a tools row: search field and the 收件匣 · 封存 · 全部 view switch (§3.1, §4.1). Category chips show only in the 收件匣 view without a query. |
| §3.3 收件匣 (reader actions) | 回覆 ↵ · 轉待辦 T · 延後 S · 封存 E · **刪除 #** · **轉成作業 A** · 在 Gmail 開啟. Archived conversations: **移回收件匣 E** · 刪除 # · 轉待辦 T · 轉成作業 A · 回覆 · 在 Gmail 開啟. |
| §4.3 Hover | Mail rows (Today and inbox) show **their primary, 封存 and 刪除** on hover instead of `actions.slice(0, 3)` (§2.2). Other kinds are unchanged. |
| §4.3 kinds table | `mail.*` rows gain 刪除 #; new kind `suggestion.assignment` (§5.6); `assignment` rows can come from mail or be manual (§5.7). |
| §6.2 Keyboard | Adds `#` / Delete (刪除), `A` (轉成作業 / 加入作業), `/` (focus mail search); `E` in the 封存 view is 移回收件匣 (§6). |
| §6.4 Action semantics | Adds 刪除, 移回收件匣, 轉成作業, 加入作業 (§1.3). |
| §7 Swipe | Mail rows: swipe left **reveals a two-button tray (封存 · 刪除)** instead of opening the snooze sheet (§2.4). Swipe right is unchanged (the row's E action). |
| §3.3 作業與專案 › 作業 | Source chips E3 · Canvas · **信件 · 手動**; page action **新增作業**; a 「從信件找到」 suggestion card; native rows are editable (§5.8). |
| §10 Copy | Additions in §7 of this file. |

---

## 1. Shared vocabulary

### 1.1 Views

| View (`MailView`) | Label | What it lists | Source |
|---|---|---|---|
| `inbox` | 收件匣 | Conversations with an INBOX message (today's behaviour) | cache (`GET /api/gmail/threads`); with a query, cache + live Gmail search |
| `archive` | 封存 | Conversations archived: no INBOX, not snoozed in Gmail, not only mine | live Gmail (`GET /api/gmail/search?view=archive`); cache-only fallback |
| `all` | 全部 | Every conversation except spam, trash and drafts | live Gmail; cache-only fallback |

The view is part of the URL: `#/inbox` (inbox), `#/inbox?view=archive`, `#/inbox?view=all`, plus `&q=<text>` for a search. A conversation keeps its view and query: `#/inbox/<threadId>?view=archive&q=hw5`. Changing the view or the query never moves page focus or scroll (same `pageKey`).

### 1.2 Live and cached rows

- A **cached** row is a conversation whose messages are in `source_items` (the inbox window, plus mail archived from BELL or elsewhere while it was cached). It has the AI summary and triage.
- A **live** row (`InboxThread.live: true`) came from Gmail for this view or query only. It has the rule summary (snippet), no AI summary, and is never written to disk. Its reader reads the conversation from Gmail when opened (plain text only, never HTML, never remote images).

### 1.3 New actions

| Action (`ActionId`) | Label · touch · key | Where | Effect | Remote write (after 6.5 s) | Undo |
|---|---|---|---|---|---|
| `trash` 刪除 | 刪除 · 刪除 · `#` (and Delete) | every mail row and reader, all views | leaves the list, the Today queue and the digest; closes a Today row (handled, `done` bucket); unread badge −1 if unread | `threads.trash` (after one `threads.get(format=minimal)` that notes which messages it moves) | before commit: cancel. After: `messages.untrash` on exactly the messages 刪除 moved (`threads.untrash` would also restore a message the owner had deleted on its own), then `INBOX` on the ones that had it (the API reference does not say whether untrash restores labels; adding INBOX back is idempotent) |
| `unarchive` 移回收件匣 | 移回收件匣 · 移回 · `E` (封存 view) | archived rows and reader | leaves the 封存 list; appears in 收件匣 on the next list refresh; does not reopen a Today row already handled today | `threads.modify` add `INBOX` | before commit: cancel. After: remove `INBOX` |
| `assignment` 轉成作業 | 轉成作業 · 轉作業 · `A` | any `gmail:` row or reader (accepted even when the row does not list it, like 排進) | creates a native assignment from the mail (rule extraction, §5.4); a Today mail row closes (handled, like 轉待辦); the mail is untouched in Gmail | none (local) | deletes the assignment (if this action created it) and restores the row; 24 h |
| `assignment` 加入作業 | 加入作業 · 加入作業 · `A` | `ai:` rows of kind `suggestion.assignment` (Today, reader, `#/work`) | accepts the suggestion and creates the assignment from its payload | none | deletes it and reopens the suggestion; 24 h |

`archive` 封存, `read` 標為已讀 and the rest keep SPEC-ux §6.4.

---

## 2. F1 — 封存 and 刪除 without opening

### 2.1 Where

| Surface | Rows | Actions offered without opening |
|---|---|---|
| `#/inbox` list, 收件匣 view | every conversation | primary, 封存, 刪除 |
| `#/inbox` list, 封存 view | every conversation | 移回收件匣, 刪除 |
| `#/inbox` list, 全部 view and search results | every conversation | inbox rows: primary, 封存, 刪除 · archived rows: 移回收件匣, 刪除 |
| `#/today` queue | `mail.reply`, `mail.bill`, `mail.action` | primary, 封存, 刪除 |

### 2.2 Desktop (pointer: fine, > 720 px)

- **Rule.** `mailHoverActions(actions)` = `actions[0]`, then the first `archive` or `unarchive`, then `trash`; duplicates dropped; at most 3. Examples: 回覆 · 封存 · 刪除 (needs reply), 標為已讀 · 封存 · 刪除 (unread notice), 封存 · 刪除 (read mail whose primary is 封存), 移回收件匣 · 刪除 (archived).
- **Look.** The existing `.q-acts` inside `.q-end`, to the left of `.when`: `btn-ghost btn-sm` with icon and kbd (`Reply ↵`, `Archive E`, `Trash2 #`, `ArchiveRestore E`). `.when` never hides; the unread dot hides while the actions show (as today). The row gets `--surface-soft`.
- **When.** `:hover` and `:focus-within`, **including the cursor row** in the single-list inbox (< 1180 px), which today hides them. On Today the expanded cursor row shows its full `.q-actions` instead (unchanged), so hover actions stay hidden there.
- **Split inbox (≥ 1180 px).** The reading pane already shows the cursor's actions, and labelled buttons would squeeze the subject, so hover shows a compact set: two `btn-icon btn-sm` buttons (`.q-acts.is-compact`): 封存 (or 移回收件匣) and 刪除, 32 × 32, `aria-label` 「封存「{subject}」」 / 「刪除「{subject}」」, `title` 「封存（E）」 / 「刪除（#）」. The cursor row shows them too.
- **At rest nothing changes**: no buttons, no icons, no extra column.
- Hover buttons are `tabIndex={-1}` on Today (the queue has a roving cursor; keys reach them) and normal tab stops in the inbox list (inside the focused row only, via `:focus-within`).

### 2.3 Keyboard

| Key | Inbox list (cursor row) and reader | Today queue (cursor row) |
|---|---|---|
| `E` | 封存 (收件匣); 移回收件匣 (封存 view); the row's E action otherwise (標為已讀 on unread notices, as today) | the row's E action (unchanged) |
| `#`, Delete | 刪除 | 刪除 on mail rows |
| `A` | 轉成作業 | 轉成作業 on mail rows; 加入作業 on `suggestion.assignment` rows |

After the action the row exits (SPEC-ux §8), the cursor moves to the next row (or the previous when it was last) and DOM focus follows to that row's title (existing `leave()` / `cursorAfterRemoval`). In the reader below 1180 px, 封存 / 刪除 / 移回收件匣 return to the list with focus on the next row.

### 2.4 Touch (pointer: coarse, or ≤ 720 px)

The row stays as it is at rest: `.when` above one `.q-primary`. Swipe gives the rest; the reader (tap the row) is the visible fallback for every action.

| Gesture | Mail rows (Today and inbox) | Other Today rows |
|---|---|---|
| **Swipe right** (finger moves right) | commits the row's E action (封存; 移回收件匣 in the 封存 view; 標為已讀 on unread notices), `--ok-soft` reveal with the label at the left edge — unchanged from SPEC-ux §7 | unchanged |
| **Swipe left** | **reveals the tray**: two 72 px buttons pinned to the right edge, `.q-tray` › `button.q-tray-btn.is-archive` 封存 (or `.is-restore` 移回) and `button.q-tray-btn.is-trash` 刪除 | unchanged (snooze sheet) |

Tray rules:
- **Tracking.** As today: a horizontal drag starts after 12 px with |dx| > |dy|; the row sets `touch-action: pan-y pinch-zoom`.
- **Opening.** The content layer (`.q-row > :not(.q-tray)`) follows the finger left up to 144 px, with 0.3× resistance beyond. On release it **snaps open** (translateX(−144px)) when dragged ≥ 56 px or flicked ≥ 0.6 px/ms; otherwise it springs back. `navigator.vibrate(8)` on opening.
- **Buttons.** Each 72 px wide, full row height (≥ 56 px), icon 16 px above a 12 px/550 label; 封存 `background: var(--ok-soft); color: var(--ok)`, 移回 `background: var(--info-soft); color: var(--info)`, 刪除 `background: var(--danger-soft); color: var(--danger)`. These are the swipe-reveal family of `.q-swipe` (§9 of SPEC-ux lists `.q-swipe`); no other button style is added. Each is a native `<button>` with `aria-label` 「封存「{subject}」」 / 「移回收件匣「{subject}」」 / 「刪除「{subject}」」.
- **Closing.** Tapping a tray button runs it (the row exits). Tapping the row's content, swiping right on it, scrolling the page, touching another row or pressing Esc closes the tray. Only one tray is open at a time. Opening a tray never moves the queue cursor.
- **Hidden when closed.** The tray is `inert` and `aria-hidden` while closed, so it is never a tab stop or announced.
- **Reduced motion.** No slide or spring: the tray appears fully open at the threshold and disappears on close.
- **Snooze on Today mail rows** stays one tap away in the expanded cursor row (`.q-actions` grid) and on `S`; only the left swipe changes for mail rows.
- **Not on the expanded cursor row.** Its detail already shows 封存 and 刪除, so a full-height tray would only cover them: there a left swipe snoozes, as on other rows.

### 2.5 Toasts and failures

| Event | Toast |
|---|---|
| 刪除 | `[Trash2] 已移到垃圾桶「{subject}」 [↶ 復原 Z]` (6 s, SPEC-ux §6.5) |
| 移回收件匣 | `[ArchiveRestore] 已移回收件匣「{subject}」 [↶ 復原 Z]` |
| 封存 | unchanged: 已封存「{subject}」 |
| POST refused (503 not connected) | error toast 「刪除失敗：Gmail 尚未連接，信件沒有變動。請到「連線與設定」連接 Google。」 [重試]; the row returns to its place |
| Deferred write failed (`GET /api/actions/:id` → failed) | 「刪除失敗：{error}」 [重試]; the server already put the row back (SPEC-ux §6.5) |
| Undo failed | 「沒有復原：{reason}」 (existing `ERRORS.undoFailed`) |

### 2.6 Today integration

- Server rows (`server/features/gmail/rows.ts`, mail team): `mail.reply` = 回覆 ↵ · 轉待辦 T · 延後 S · 封存 E · 刪除 #; `mail.bill` = 轉成待辦 T · 封存 E · 延後 S · 刪除 #; `mail.action` = 標為已讀 E · 轉待辦 T · 延後 S · 封存 · 刪除 #. When the rule detector (§5.4) recognises an assignment announcement, 轉成作業 A is appended (so the expanded row shows it); `A` works on every mail row regardless (D2 exemption).
- The expanded cursor row (`.q-detail .q-actions`) lists every action; on phones its 4-column grid wraps to a second row (5–6 buttons). `在 Gmail 開啟` stays right-aligned below.
- Counts: 刪除 closes the row like 封存 (`ACTION_EFFECTS.trash`: handled, `done`), and lowers `inboxUnread` when the row was unread (`applyActionToPayload`).
- The digest strip does not get 刪除 (its bulk verbs stay 標為已讀 / 封存).

---

## 3. F3 — archived mail inside 收件匣

### 3.1 View switch

- **Placement.** The list card's head (`.card.queue.inbox-list` › `.q-head`) gets a tools row `.inbox-tools` under the card title: `label.inbox-search` (§4.1, flexible width) then the view switch, a `SegmentedControl` (`.seg`, label 「信件範圍」) with 收件匣 · 封存 · 全部. The category chips (`.chips`) follow on their own row, only in the 收件匣 view without a query.
- **Behaviour.** Choosing a view rewrites the hash in place (`history.replaceState`; `#/inbox?view=archive`), keeps the query, resets the cursor to the first row, and keeps focus on the segment. The PageHead (eyebrow INBOX, H1 「先處理需要你回覆的。」, the unread subline, 立即同步) does not change.
- **Phone (≤ 720 px).** The tools row stacks: the search field full width (44 px tall), then the segmented control full width with three equal segments (44 px tall on coarse pointers). No horizontal scroll at 320 px.

### 3.2 The 封存 list

- One `section.q-group` (no category groups) with `.q-ghead`: `h3` 「封存的信」, `.hint` 「依收到時間排列」. No count (the total is unknown; Gmail gives only an estimate, and SPEC-ux §1.3 forbids numbers that may be wrong).
- Rows: the `.q-row` grammar of the inbox list — initial or category tile (rule classification), title = subject, meta = `寄件者 · 一行摘要` (AI summary when cached, else the rule summary of the snippet), `.when` = received (`receivedWhen`). Unread archived mail keeps the bold title and the dot.
- Order: newest first, as Gmail lists them. A conversation appears once (the client drops a `threadId` it already shows when the next page repeats it).
- **Paging.** 20 rows per page. Below the list `.q-more` holds `btn-ghost btn-sm` 「載入更多」 whenever Gmail has a `nextPageToken`, even when no row of the loaded pages is left on screen (all acted on, or a search's Gmail page repeats what the local results show); the empty state shows only without one. While loading it reads 「載入中…」 with `aria-busy` and `aria-disabled` (a `disabled` button would drop keyboard focus, §9); when Gmail has no `nextPageToken`, `.inbox-none` reads 「沒有更多信了。」 Pages never auto-load on scroll.
- **Actions.** Hover / tray: 移回收件匣 E · 刪除 #. The reader: 移回收件匣 E · 刪除 # · 轉待辦 T (cached rows only) · 轉成作業 A · 回覆 · 在 Gmail 開啟. Live rows offer no 轉待辦 (the tasks module reads the cache) and no 延後.
- **全部 view.** The same flat list (`h3` 「所有信件」, same hint). Archived rows start their meta with 「已封存 · 」 so the two kinds are told apart without a pill; inbox rows act as in the 收件匣 view.

### 3.3 Reading an archived conversation

- `#/inbox/<threadId>?view=archive`: the same `.mail-reader`. Its `.mr-state` line reads 「已封存」 for archived conversations.
- Live conversations add a `.mr-note` under the text: 「這封信不在本機快取，內容是剛從 Gmail 讀取的純文字，只暫存幾分鐘。」 (the existing 「只顯示純文字內容…」 note stays).
- After 移回收件匣 or 刪除 in the reader, the list view (or the split list) shows the next row, focus on its title.
- A conversation that Gmail no longer has (404): Notice 「這封信暫時無法載入」 / 「這封信已經不在 Gmail，可能已被永久刪除。」 [重試].

### 3.4 States

| State | 封存 / 全部 view |
|---|---|
| Loading (first page) | the list card head plus 4 `SkeletonRow`s; sr-only 「正在載入封存的信…」 |
| Empty (connected, nothing archived) | dashed `.empty-state`, Archive tile `t-mail`: 「沒有封存的信。」 / 「在收件匣按 E 封存的信會出現在這裡。」 (全部: 「信箱是空的。」 / 「新信會在同步後出現在這裡。」) |
| Error (Gmail failed) | `.notice-error` in the card: 「封存的信暫時無法載入」 / 「{reason}」 [重試]; rows from the cache (if any) follow with `.stale-note`-style line 「先顯示這台電腦上已同步的信。」 |
| Rate limited (429) | the same notice with reason 「Gmail 暫時限制讀取次數，請過一分鐘再試。」 |
| Not connected, cache has archived rows | `.notice` (neutral, Unplug): 「Gmail 尚未連接」 / 「只顯示這台電腦上已同步、之後封存的信。連接 Google 後可以看到所有封存的信。」 [連接 Google] |
| Not connected, nothing cached | `.empty-state` Unplug: 「還沒有連接 Gmail。」 / 「連接 Google 帳號後，就能在這裡看到封存的信。」 [連接 Google] |
| Needs reconnect | the existing reconnect notice (「Gmail 需要重新連線」…), then cached rows |
| Load more failed | the button returns; error toast 「載入更多失敗：{reason}」 [重試] |

### 3.5 Data flow

1. `GET /api/gmail/search?view=archive[&pageToken=…]` → `MailSearchResponse` (`shared/mail.ts`): `threads` (InboxThread rows), `nextPageToken?`, `origin: "gmail" | "cache"`, `error?`, `source`.
2. Server (mail team): `messages.list` with the view query (§3.6), `maxResults=25`, `pageToken`; group the ids by `threadId` (in Gmail's order); conversations already cached use the cache (triage, AI summary); the rest are read whole with `threads.get(format=metadata, metadataHeaders=From,Subject,Date,List-Unsubscribe)`, 4 at a time, normalised with the existing parser, classified with the rules, and held in an in-memory map for 5 minutes (≤ 200 conversations, LRU). Gmail lists messages but a row is a conversation: its place (inbox when any visible message has INBOX, else archived) and its message (the newest inbox message not sent by the owner, else the newest not sent by the owner) come from all its messages, with the reader's rule, so the list and the reader name the same item id and an archived thread with a newer inbox reply is never listed in 封存. A conversation too big for the 5 MB response cap falls back to its listed message. **Nothing is written to `source_items`, `sync_state` or the logs** (log `gmail.search {view, ms, rows, hasQuery}` only).
3. Quota (Gmail usage limits page, checked 2026-10-15): `messages.list` 5 units, `threads.get` 40 units, `messages.get` 20 units, per-user 6,000 units/minute — a cold page of 25 conversations is ≤ 1,005 units, about 5 cold pages a minute (the 5-minute memory makes repeats free). A 429 maps to 「Gmail 暫時限制讀取次數，請過一分鐘再試。」
4. Without Gmail (not connected, reconnect, or the call failed) the server answers the cached messages that match the view (no INBOX label for 封存) with `origin: "cache"` (and `error` when Gmail failed), so the page never blanks (SPEC-ux §5).
5. The reader `GET /api/gmail/threads/:threadId` first looks in the cache; otherwise it reads `threads.get(format=full)` (a conversation over the 5 MB cap: `threads.get(format=minimal)`, then its newest 20 messages one by one, a message over the cap as headers only), keeps plain text only (the existing `normalizeMessage`, excerpt ≤ 8 KB), holds it 5 minutes in memory and answers `InboxThreadResponse` with `thread.live: true`. A conversation in the trash answers `trashed: true` (移回收件匣, as for cached mail); spam only is a 404.
6. Every gmail action on a thread drops that thread's in-memory entries, so a list refetched after 刪除 never shows the stale row.

### 3.6 The Gmail queries (D10)

| View | Query sent as `q` (always followed by ` -in:spam -in:trash`) |
|---|---|
| 收件匣 | `in:inbox` |
| 封存 | `-in:inbox -in:snoozed -in:sent -in:drafts` |
| 全部 | `-in:drafts` |

Evidence: the Gmail API `users.messages.list` / `users.threads.list` reference — `q` "supports the same query format as the Gmail search box", `includeSpamTrash` defaults to false; the Gmail Help search-operator list (support.google.com/mail/answer/7190) documents `in:archive`, `in:snoozed` and `in:anywhere`. `in:archive` describes the same set, but the explicit form is used because it relies only on system-label operators the sync already uses (`in:inbox`, `in:sent`) and makes the Sent and Drafts exclusions certain. ` -in:spam -in:trash` is appended so a user's `in:anywhere` can never surface trash. The user's text goes between the view query and that suffix unchanged (Gmail's OR binds tighter than the implicit AND, so `from:a OR from:b` stays scoped); unbalanced parentheses are replaced by spaces. Implemented in `server/features/gmail/views.ts` (`gmailViewQuery`), tested. **Not verified against a live account** (no live calls from this host); the mail team records that in STATUS.

---

## 4. F4 — search

### 4.1 The field

- `label.inbox-search` in `.inbox-tools` (§3.1): lucide `Search` 16 px in `--muted`, `input[type=search]` (placeholder 「搜尋信件」, `aria-label` 「搜尋信件」, `enterkeyhint="search"`, `autocomplete="off"`, `spellcheck="false"`, `maxlength="200"`), then either a `kbd` 「/」 (empty field, not focused, 單鍵快捷鍵 on, pointer fine) or a clear `btn-icon btn-sm` with X, `aria-label` 「清除搜尋」 (non-empty). Built from tokens, mirroring `.cap-field`: 36 px tall (44 on coarse), `--surface-soft` fill, 1 px `--border`, `--r-md`, focus ring per SPEC-ux §11.
- The field sits in a `role="search"` container labelled 「搜尋信件」.

### 4.2 Behaviour

1. **URL.** The query lives in the hash: `#/inbox?q=hw5` (`&view=` when not 收件匣). Typing rewrites it with `history.replaceState` (no history entries per keystroke); a link or the palette can open a search directly.
2. **Instant local filter** (every input event, not while an IME composes; applied once on `compositionend`): over the rows already loaded for the view (the cached inbox list for 收件匣, the loaded pages for 封存 / 全部). Text is NFKC-normalised and lower-cased; the query splits on whitespace; every term must occur in the subject, the sender's name or address, the summary or the snippet. Gmail operators (`word:value`) and `-term` are skipped locally (the server applies them).
3. **Gmail search**, 400 ms after the last input (never while composing; ↵ sends at once): `GET /api/gmail/search?view=<view>&q=<text>`; a newer query aborts the older request. Results already shown locally are dropped (by `threadId`); the rest are appended below the local results under a second `section.q-group`: `h3` 「Gmail 中其他符合的信」, so nothing above the user's cursor moves when the answer arrives. 「載入更多」 pages them (§3.2).
4. **Grouping while searching.** Category chips and category groups disappear; local results form one group `h3` 「符合「{q}」的信」 (newest first). Clearing the query restores the view exactly as it was (chips, filter, cursor).
5. **Highlight.** Matched terms in the title and meta are wrapped in `<mark class="hit">`: `background: var(--accent-soft); color: inherit; border-radius: var(--r-xs); padding: 0 1px; font-weight: 650; text-decoration: underline 2px var(--accent); text-underline-offset: 3px`. The fill alone is about 1.1:1 on the hover and cursor rows, so the weight and the `--accent` underline (≥ 3:1 on `--surface`, `--surface-soft` and the cursor tint, both themes) carry it. Only literal terms are highlighted (not operators).
6. **Keys inside the field.** ↓ moves focus to the first result's title (it becomes the cursor); Esc clears a non-empty query, a second Esc returns focus to the list cursor (or `<main>`); ↵ sends the Gmail search at once. J/K and letters type text (the global guard ignores typing targets).
7. **Opening a result.** Clicking a row or ↵ on its title opens the reader (split pane, or `#/inbox/<threadId>?q=…` below 1180 px); the same holds in the 封存 and 全部 views, whose rows lead with 移回收件匣 or 封存 (↵ is the row's primary action only in the plain 收件匣 list). 回到收件匣 / Esc return to the results with the query, the scroll and the row focused.
8. **Live region.** A polite `.sr-only` status announces 「找到 {n} 封符合的信」 after the Gmail answer (local count while Gmail is not answering), or 「沒有找到符合的信」.

### 4.3 States

| State | What shows |
|---|---|
| Searching Gmail | local results, then `.skel-status` 「正在搜尋 Gmail…」 under them; every notice below (failed, not connected) also sits under the local results, never above them |
| No result anywhere | dashed `.empty-state`, Search tile `t-mail`: 「找不到符合「{q}」的信。」 / view ≠ 全部: 「換個關鍵字，或在全部信件中再找一次。」 + `btn-secondary` 「在全部信件中搜尋」 (switches to 全部, keeps q) · view = 全部: 「換個關鍵字試試，也可以用 from: 或 subject: 縮小範圍。」 |
| Gmail failed | local results, then `.notice-warn` 「Gmail 搜尋暫時無法使用」 / 「先顯示這台電腦上已同步的信中符合的結果。{reason}」 [重試] |
| Not connected | local results only, `.notice` 「Gmail 尚未連接」 / 「只搜尋這台電腦上已同步的信。連接 Google 後可以搜尋整個信箱。」 [連接 Google] |
| Query too long (server 400) | cannot happen from the UI (`maxlength`); the server answers 「搜尋文字太長了，請少於 200 個字。」 |
| Expired page token (400) | 「搜尋結果已經過期，請重新搜尋。」 toast; the list reloads page 1 |
| Offline | the page-level offline error (existing) |

### 4.4 Command palette

- A section provider `useMailSearchSection` (`src/components/command-palette/mailSearchSection.tsx`, mail team; already registered after 搜尋): in go mode, with non-empty text that is not a capture (`+`) entry, one option in section 「信件」: title 「搜尋信件「{text}」」, meta 「在所有信件中搜尋」, `Search` icon, tone `mail`, `enterLabel` 「搜尋」. ↵ → `navigate("#/inbox?view=all&q=" + encodeURIComponent(text))`, and the field shows the text.
- It is the palette's last section, so it never pushes 快速新增 or 前往 down.

---

## 5. F2 — assignments from mail

### 5.1 The record

A native assignment is an `Assignment` (`shared/assignments.ts`) with `origin: "mail" | "manual"`:

| Field | Mail | Manual |
|---|---|---|
| `id` | `assignment:<uuid>` (also its Today item id) | same |
| `externalId` | `<uuid>` (the `:id` in `/api/lms/assignments/:id`) | same |
| `courseName` | extracted course, else 「未分類」 | as typed, else 「未分類」 |
| `title` | extracted assignment name | as typed |
| `dueAt` | ISO instant or null; a date without a time is 23:59 local and `dueDateOnly: true` | same |
| `submission` | `not-submitted` (標為已交 is item state, D7) | same |
| `site` | `{ label: "信件", short: "信件" }` | `{ label: "手動", short: "手動" }` |
| `mailRef` | `{ messageId, threadId, url }` (url = the Gmail web link) | — |
| `submitHint`, `url`, `notes`, `createdAt` | optional | optional |

Stored in `personal.sqlite local_assignments` (migration v4: `id, json, updated_at, origin, due_at, source_message_id, created_at`), a DocTable with `ctx.trash` (刪除作業 has 復原). Owned by the lms module.

### 5.2 Entry points

```
teacher mail ──sync──► cache ──AI triage (ai.enabled && ai.mailTriage)──► suggestion kind "assignment" (dedupe mail-assignment:<id>)
                         │      └ AI off / failed / backlog ──rules (§5.4)──┘ (same suggestion, payload.detectedBy "rule")
                         │                                                         │
                         │                     Today ai: row / reader .q-row.is-ai / #/work 「從信件找到」
                         │                                                         │ 加入作業 A (one tap)            略過 E
                         │                                                         ▼                                  ▼
                         └── 轉成作業 A on any mail (rules, at once) ──────► local_assignments row ◄── 新增作業 on #/work   dismissed (never returns)
                                                                                   │
                         #/work 作業 · Today queue (kind assignment) · agenda 「… 截止」 · 明天與之後 · free slot · nav badge
```

### 5.3 AI triage extension (exact schema)

`triageAnswerSchema` gains a required array (strict; every field required, `null` when unknown) — defined in `server/features/gmail/triage-assignments.ts` (assignments team) and spread into the triage schema:

```json
"assignments": {
  "type": "array", "maxItems": 15,
  "items": {
    "type": "object", "additionalProperties": false,
    "required": ["sourceId", "title", "course", "due", "submit", "url"],
    "properties": {
      "sourceId": { "type": "string", "maxLength": 100 },
      "title":    { "type": "string", "maxLength": 200 },
      "course":   { "type": ["string", "null"], "maxLength": 80 },
      "due":      { "type": ["string", "null"], "maxLength": 40 },
      "submit":   { "type": ["string", "null"], "maxLength": 120 },
      "url":      { "type": ["string", "null"], "maxLength": 500 }
    }
  }
}
```

Prompt line (zh-TW, appended to the triage prompt; `{offset}` is the user's zone):
「assignments：老師、助教或課程寄來、要你在期限前繳交的作業、報告或實驗（不包含學校系統自動寄出的通知、考試公告、電子報）；title 用作業名稱（例如「HW5：系統呼叫實作」），course 為課程名稱，due 為 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM{offset}，submit 為繳交方式（例如「上傳到 E3」），url 為信中寫的繳交或說明網址（只填 https 開頭的網址），不知道的欄位填 null。列在 assignments 的信，不要再列進 todos。」

Parsing (assignments team, `assignmentSuggestionsFromTriage`): the `sourceId` must be in the batch and still cached; title trimmed ≤ 120; `due` through the existing `parseDay` / `modelInstant` (offset-free = `BELLPERSONAL_TZ`), date-only → 23:59 local with `dueDay`; a due more than one day in the past drops the item; `url` kept only when it parses as `https:`, is at most 500 characters, `secretInPatch` is false, and the cited mail's own text carries it (one batch holds 15 mails, and the link becomes #/calendar's deadline link); the answer schema accepts `url` and `submit` of any length so one long link never fails the batch, while the model is still given the schema above; no suggestion for an assignment the owner already has or was offered (the same code in the same conversation, or the same code, course and deadline: replies, follow-ups and reminders); one suggestion per message (`dedupeKey: mail-assignment:<messageId>`, `origin: suggestionOrigin(message)`, `sourceRef` gmail with the Gmail link, `modelExecution`). A message that produced an assignment suggestion gets **no todo suggestion** (triage.ts skips the ids the hook returns). Events are unaffected.

### 5.4 Rule detection and extraction (`shared/assignment-detect.ts`)

Pure, linear-time on text cut to 4,000 characters; used by the rule fallback (suggestions), 轉成作業 (always returns a draft) and the Today row hint.

- **Signals.** S1 assignment words in the subject or the first 300 characters: 作業, HW / Homework + number, Assignment, Lab + number, 實驗報告, 書面報告, 期末報告, 期中報告, 報告繳交, 繳交, 上傳. S2 a deadline phrase: 截止 / 前繳交 / 前上傳 / 前交 / due / deadline near a date. S3 a school or teaching sender: an address in `mail.schoolDomains` (or `.edu.tw`), or a sender name containing 教授 / 老師 / 助教 / TA.
- **Detect** (`detectAssignment`) proposes only when S1 **and** (S2 or S3), and never for automated mail (`isAutomated`: List-Unsubscribe, noreply-style senders — this also leaves out E3's own notification mail, which Moodle already syncs), promotions, bills or GitHub notifications. 作業 as an office or bank procedure (更新, 申報, 盤點, 考核作業…) is not S1, and a bare 作業 needs a course word near it (課, 老師, 助教, E3, 報告…); a hand-in verb alone (繳交, 上傳) needs a teacher by name, not a school address; on a reply (`Re:`) a school address alone is not S3 (classmates write from one too).
- **Extract** (`extractAssignment`): title = the first `HW…` / `Lab…` / `作業…` phrase up to the end of its clause, else the subject without `Re:` / `Fw:` / `[公告]` / a leading `【課程】`; course = the `【…】` / `[…]` tag of the subject, else the triage `context`, else none; due = the first date (and time) next to an S2 word, read in `BELLPERSONAL_TZ` relative to the received day (`M/D`, `M月D日`, `YYYY/M/D`, 週X, 下週X, 明天, `HH:MM`, 中午 12:00, 23:59 default), never before the received day; a comma never separates a date from its time (「due Oct 20, 9:00 AM」, 「10/16（五），上午 9:00 前」, 「Friday, October 23」), and with several dates in a sentence the clause with the deadline word decides; only whole English month names count (「10 marks」 is not March); submitHint = the clause containing 上傳 / 繳交 / 寄到 / 紙本 (≤ 60 characters); url = the first `https://` link on a known submission host (e3p.nycu.edu.tw, cool.ntu.edu.tw, forms.gle, docs.google.com/forms, classroom.github.com) — never any other link.

Golden examples (received Mon 2026-10-12 09:00 Asia/Taipei, school domain `nycu.edu.tw`):

| From | Subject | Text | detect | Draft |
|---|---|---|---|---|
| 林志明 教授 <cmlin@cs.nycu.edu.tw> | 【作業系統】HW5 公告 | HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。 | yes | 「HW5：系統呼叫實作」 · 作業系統 · 2026-10-16T15:59Z · 上傳至 E3 |
| 王助教 <ta-net@cs.nycu.edu.tw> | Re: 計網 Lab 3 繳交方式 | Lab 3 請在下週三中午 12:00 前把報告寄到 ta-net@cs.nycu.edu.tw | yes | 「Lab 3」 · (no course) · 2026-10-21T04:00Z · 把報告寄到 ta-net@cs.nycu.edu.tw |
| 陳老師 <chen.t@gmail.com> | 期末報告繳交通知 | 期末報告請在 12/20 前繳交紙本到系辦。 | yes | 「期末報告」 · 2026-12-20T15:59Z (date only) · 繳交紙本到系辦 |
| 王助教 <ta-os@cs.nycu.edu.tw> | HW6 已發布 | HW6 題目已上傳到 E3，截止時間另行公告。 | yes | 「HW6」 · dueAt null |
| iThome 電子報 (List-Unsubscribe) | 本週作業系統新聞 | … | no | — |
| NYCU 圖書館 <lib@nycu.edu.tw> | [公告] 圖書館期中考週延長開放 | … | no | — |
| E3 <noreply@e3p.nycu.edu.tw> | 作業 HW3 即將截止 | … | no (automated) | — |

### 5.5 加入作業 (suggestion)

- **Today row** (core, `server/today/suggestions.ts`): kind `suggestion.assignment`, tile `t-accent` Sparkles, title 「從信件找到 1 份作業，要加入嗎？」, meta `{title} · {course} · {deadline}` (`metaDeadline`, or 「沒有寫截止時間」) `· 來自 {origin}`, plus 「規則判斷」 when `detectedBy: "rule"`; buttons always visible: `btn-secondary` 加入作業 `A`, `btn-ghost` 略過 (`aria-label` 「略過這個建議」); group 今天內; never expands.
- **Reader** (`.mr-suggestions`) and **#/work** 「從信件找到」 card render the same `.q-row.is-ai`.
- **Accept** (`suggestionActions.assignment` and `acceptSuggestion.assignment`, lms): creates the record from the payload (origin `mail`, `mailRef` from the suggestion's `sourceRef` and the cached message's thread), returns `resultId`; toast 「已加入作業「{title}」· {deadline}」 [復原]; undo deletes the record and reopens the suggestion.
- **略過** dismisses it for good (the dedupe key keeps it from returning).

### 5.6 轉成作業 (direct)

- Offered: the reader of every conversation (`btn-secondary` with GraduationCap, `A`), inbox rows through `A` and the reader, Today mail rows through `A` (and as a button when the rule hint is on, §2.6).
- `POST /api/actions {itemId: "gmail:<messageId>", action: "assignment"}` → `anySourceActions.assignment` (lms): reads the message with `findMailMessage(ctx, id)` (cache, else a live read through the mail module), runs `extractAssignment`, and in `apply()` creates the record; `undo()` deletes it if it was created by this action. A message already converted answers 409 「這封信已經轉成作業了。」 (the toast says so; nothing is created).
- The Today row closes (handled, `done`), the inbox row and the reader show 「已轉成作業 · 」 (like 「已轉成待辦」) and no longer offer 轉成作業 — also after 加入作業 on the mail's suggestion — and Gmail is untouched. The reader hides 轉成作業 while its own 加入作業 suggestion is shown.
- Another mail of the same conversation, or a reminder of an assignment the owner already has (same code, course and deadline), reuses that assignment instead of making a second one; a pending suggestion from another mail of the conversation supplies the fields and is accepted with it.
- Toast 「已加入作業「{title}」· {deadline}」 [復原]. The toast is the only confirmation: it shows at once with the page's guess (on Today, the title only: a row does not know the mail's text or the day it arrived), and the action's answer rewrites it with the saved title and deadline (`ActionAccepted.created`); the extracted fields are editable on `#/work` (D6). Errors: 「轉成作業失敗：{reason}」 [重試] (no 重試 on a 409, which would answer the same).

### 5.7 Today, agenda and badges

Native assignments behave exactly like LMS ones (lms `today()`), with these differences:

| Part | LMS | Mail | Manual |
|---|---|---|---|
| Row id / source | `moodle:<cmid>` / moodle | `assignment:<uuid>` / assignment | same |
| Meta | `NYCU E3 · 作業系統 · 今晚 23:59 截止 · 尚未繳交` | `信件 · 作業系統 · 週五 23:59 截止 · 尚未繳交` | `手動 · …` |
| Primary (desktop ↵) | 開啟 E3 (new tab) | **開啟信件** → `#/inbox/<threadId>` in the app (`url` starts with `#/`, so no new tab, ArrowRight icon) | 開啟 → `#/work` |
| Touch primary | 已交 | 已交 | 已交 |
| Fingerprint | `dueAt|submission` | `dueAt|submission` (the same `assignmentFingerprint`: editing the due date brings a 標為已交 row back) | same |

Due phrases, 逾期, the 7-day window, 標為已交 (`submitted`, until-change), 延後 (≤ deadline − 2 h), agenda 「HW5 截止」 rows, 明天與之後, the free-slot pairing (「適合寫 HW5」) and `nav.work` (due ≤ 7 days, not marked) are the LMS rules unchanged. The rule brief counts them (kind `assignment`). An assignment without `dueAt` is never in the queue, only on `#/work`.

### 5.8 `#/work` 作業 tab

- **Page action.** `btn-primary` 「新增作業」 (Plus) on the 作業 tab; 立即同步 (when an LMS is connected) moves next to it as `btn-secondary`.
- **「從信件找到」 card.** Above the list, only when pending assignment suggestions exist: `.card` with `CardHead` (Sparkles, `t-accent`, title 「從信件找到」, mono count), then the `.q-row.is-ai` rows of §5.5. Empty → no card.
- **Source chips.** E3 · Canvas · 信件 · 手動 — each only when connected or holding rows; counts = pending rows; second click clears (SPEC-ux §9 Chip).
- **Course groups** merge origins by course name (trimmed, case-insensitive): 「作業系統」 from E3 and from a teacher's mail are one group; the group `.hint` lists the sites present (「NYCU E3 · 信件」). No course → group 「未分類」, last.
- **Native rows** (`WorkRow`): tile GraduationCap `t-task` (manual) or `t-mail` (mail); title; meta `信件 · 週五 23:59 截止 · 上傳到 E3` (site, deadline or 「沒有期限」, `submitHint`); status pill 未繳交 / 逾期 / 已繳交 (D7: a mark shows 已繳交 and the meta adds 「你標為已交」); `.when` as LMS rows. Hover: 標為已交 · 開啟信件 (mail) · 編輯; touch primary 已交; tapping the title opens 編輯 (native) — LMS titles keep opening the LMS page.
- **編輯 / 新增 dialog** (`Dialog`, native `<dialog>`, `Field` controls): 作業名稱 (required), 課程, 截止日期 (date), 截止時間 (time, hint 「沒填就是當天 23:59」), 繳交方式, 連結 (https only), 備註; footer `btn-primary` 儲存 · `btn-ghost` 取消, and for an existing one `btn-ghost` 刪除作業 at the left (danger text colour; no confirm — undo toast). Mail-made ones show a read-only line 「來自 {sender} 的信 · 開啟信件」.
- **Toasts.** 「已新增作業「{title}」」 [復原] · 「已儲存作業」 · 「已刪除作業「{title}」」 [復原] (trash restore) · 「已標為已交「{title}」」 (existing).
- **Empty.** 「這週沒有要交的作業。」 / 「連接 E3 或 Canvas，或把老師寄來的作業信轉成作業。」 + `btn-secondary` 「新增作業」. The 學校系統 side card keeps the connect buttons.
- **States.** Loading, error, stale and per-LMS problems are unchanged; native rows render even when every LMS is broken (they are local).

### 5.9 Calendar

`#/calendar` deadline rows (`server/features/calendar/agenda.ts › deadlineItems`) include native assignments through an lms export (`listAssignments(ctx)`); the assignments team makes that three-line change (the calendar team is not involved in this request).

---

## 6. Keyboard additions

All keys go through the one dispatcher and guard (SPEC-ux §6.2): nothing while an IME composes (`isComposing || keyCode === 229`), nothing in typing targets or blocking dialogs, letters and symbols off when 單鍵快捷鍵 is off. The search field's own handlers call `isComposing(event)` first: ↵, Esc and ↓ do nothing while composing.

| Key | Scope | Action | Registry id |
|---|---|---|---|
| `#`, Delete | list (inbox, Today mail rows) | 刪除 (move to Gmail trash) | `trash` |
| `A` | list (mail rows, `suggestion.assignment` rows) | 轉成作業 / 加入作業 | `assignment` |
| `/` | 收件匣 | focus the search field and select its text | `search` |
| `E` | 收件匣, 封存 view | 移回收件匣 | (`close`) |
| Esc | search field | clear the query, then leave the field | — |
| ↓ | search field | first result | — |

- `SHORTCUTS` (`src/lib/shortcuts.ts`) lists the three new ids; the `?` dialog and `#/guide#keys` show them under 清單 and a new scope 收件匣.
- **Inbox legend** (`.q-foot .legend`, pointer fine, single keys on): `J K 移動 · E 封存 · # 刪除 · / 搜尋 · Z 復原 · ? 全部`. Today's legend is unchanged.
- Delete follows the 單鍵快捷鍵 setting like the letters (it is destructive, even if undoable).

---

## 7. Copy deck (zh-TW, verbatim)

### 7.1 Buttons and labels

- Actions: `刪除` (touch `刪除`) · `移回收件匣` (touch `移回`) · `轉成作業` (touch `轉作業`) · `加入作業` · `開啟信件` · `新增作業` · `編輯` · `儲存` · `取消` · `刪除作業` · `載入更多` · `在全部信件中搜尋` · `連接 Google`
- Views: `收件匣` · `封存` · `全部`; switch label `信件範圍`
- Search: placeholder and label `搜尋信件` · clear `清除搜尋` · palette section `信件`, option `搜尋信件「{text}」`, meta `在所有信件中搜尋`, enter `搜尋`
- Tray and compact hover labels: `封存「{subject}」` · `移回收件匣「{subject}」` · `刪除「{subject}」`; tooltips `封存（E）` · `移回收件匣（E）` · `刪除（#）`
- Handled list (`ACTION_HANDLED_LABELS`): `移到垃圾桶` · `移回收件匣` · `轉成作業`
- Error-toast verbs (`ACTION_LABELS`): `刪除` · `移回收件匣` · `轉成作業`

### 7.2 Toasts

- `已移到垃圾桶「{subject}」` · `已移回收件匣「{subject}」` · `已加入作業「{title}」· {deadline}` (without a deadline: `已加入作業「{title}」`) · `已新增作業「{title}」` · `已儲存作業` · `已刪除作業「{title}」`
- Errors: `刪除失敗：{reason}` · `移回收件匣失敗：{reason}` · `轉成作業失敗：{reason}` · `載入更多失敗：{reason}` · `沒有存到作業：{reason}` · `刪除作業失敗：{reason}`

### 7.3 Inbox headings, states and notes

- Groups: `封存的信` · `所有信件` · hint `依收到時間排列` · `符合「{q}」的信` · `Gmail 中其他符合的信` · end `沒有更多信了。` · loading `載入中…` · `正在載入封存的信…` · `正在搜尋 Gmail…`
- Archived meta prefix: `已封存`; reader state: `已封存`; converted: `已轉成作業`
- Live note: `這封信不在本機快取，內容是剛從 Gmail 讀取的純文字，只暫存幾分鐘。`
- Gone: `這封信已經不在 Gmail，可能已被永久刪除。`
- Empty: `沒有封存的信。` / `在收件匣按 E 封存的信會出現在這裡。` · `信箱是空的。` / `新信會在同步後出現在這裡。`
- No result: `找不到符合「{q}」的信。` / `換個關鍵字，或在全部信件中再找一次。` · `換個關鍵字試試，也可以用 from: 或 subject: 縮小範圍。`
- Live region: `找到 {n} 封符合的信` · `沒有找到符合的信`
- Notices: `封存的信暫時無法載入` / `{reason}` · `先顯示這台電腦上已同步的信。` · `Gmail 搜尋暫時無法使用` / `先顯示這台電腦上已同步的信中符合的結果。{reason}` · `Gmail 尚未連接` / `只顯示這台電腦上已同步、之後封存的信。連接 Google 後可以看到所有封存的信。` · `Gmail 尚未連接` / `只搜尋這台電腦上已同步的信。連接 Google 後可以搜尋整個信箱。` · `還沒有連接 Gmail。` / `連接 Google 帳號後，就能在這裡看到封存的信。`

### 7.4 Today and work

- Suggestion row: `從信件找到 1 份作業，要加入嗎？` · `沒有寫截止時間` · `規則判斷`
- Work: chips `E3` · `Canvas` · `信件` · `手動`; site labels `信件` · `手動`; group `未分類`; card `從信件找到`; meta `你標為已交`; source line `來自 {sender} 的信`; empty hint `連接 E3 或 Canvas，或把老師寄來的作業信轉成作業。`
- Dialog: titles `新增作業` · `編輯作業`; fields `作業名稱` (placeholder `例如 HW5：系統呼叫實作`) · `課程` (placeholder `例如 作業系統`) · `截止日期` · `截止時間` (hint `沒填就是當天 23:59`) · `繳交方式` (placeholder `例如 上傳到 E3、紙本交到系辦`) · `連結` (hint `繳交頁面或說明文件，選填`) · `備註`; validation `請輸入作業名稱。` · `連結必須是 https:// 開頭的網址。` · `截止時間需要先選日期。`

### 7.5 Server errors (`{ error }`)

- `Gmail 尚未連接，信件沒有變動。請到「連線與設定」連接 Google。` (503, existing) · `找不到這封信，可能已經被刪除。請重新整理後再試。` (404, existing) · `這封信已經在收件匣了。` (409, unarchive) · `這封信已經在垃圾桶了。` (409, trash) · `Gmail 暫時限制讀取次數，請過一分鐘再試。` (429) · `搜尋文字太長了，請少於 200 個字。` (400) · `搜尋結果已經過期，請重新搜尋。` (400)
- `這封信已經轉成作業了。` (409) · `這個項目不能轉成作業。` (400) · `找不到這封信，沒有建立作業。` (404) · `找不到這份作業。` (404) · `學校系統的作業不能在這裡修改。` (409) · `作業名稱不能是空白。` (400)

### 7.6 Shortcut help

- `trash`: `刪除信件（移到 Gmail 垃圾桶）` / short `刪除` · `assignment`: `把信轉成作業，或加入建議的作業` / short `轉作業` · `search`: `搜尋信件` / short `搜尋` · scope `收件匣`

---

## 8. Privacy (`/privacy`, owned by the mail team, lands with F1/F3/F4)

Replace or add exactly these sentences (zh first, then the English summary), and move `PRIVACY_EFFECTIVE_DATE` and the 生效日期 line to the release date:

1. `gmail.modify` (§01): 「讀取信件的寄件者、主旨、摘要與純文字節錄，用來分類信件、整理今天要處理的事；擁有者打開「封存」或搜尋信件時，才即時讀取符合的信。只有在擁有者按下按鈕時，才會封存信件、移回收件匣、標為已讀、移到垃圾桶或變更標籤。移到垃圾桶的信由 Gmail 保留 30 天後自動清除；BELL Personal 不會寄出信件，也不會永久刪除信件。」
2. Storage (§02), new item: 「封存的信與搜尋結果只在擁有者查看時向 Gmail 讀取，暫存在伺服器記憶體中最多 5 分鐘，不寫入資料庫、記錄檔或備份；搜尋文字也不會被記錄。」
3. Retention (§03), the "own records" item: 「擁有者確認後建立的待辦、作業與行程屬於擁有者自己的紀錄，不會因此刪除；從信件建立的作業只保留作業內容與指回原信的連結。」
4. AI (§04): 「AI 的結果只是建議：必須由擁有者確認後，才會變成待辦、作業或行程；不會自動封存、刪除、寄送或建立任何東西。」
5. English summary: "…`gmail.modify` to read message metadata, snippets and plain-text excerpts to organise the owner's day, to list archived mail and search the mailbox only when the owner opens those views, and to archive, move back to the inbox, mark as read, move to trash or relabel messages only when the owner taps an action (it never sends or permanently deletes mail; Gmail empties its trash after 30 days)…" and "Archived-mail listings and search results are read on demand and kept only in server memory for up to five minutes; search text is not logged."

---

## 9. Accessibility

- The search container is `role="search"`; the result count is a polite live region (§4.2); the view switch is the existing `.seg` with `aria-pressed` buttons and a group label.
- Tray buttons and compact hover buttons are native buttons with zh `aria-label`s that name the conversation; the tray is `inert` when closed.
- Every hover or swipe action is also in the reader (and the Today expanded row): SPEC-ux §7 "no hover-only affordances".
- Focus after any row action lands on the next row's title, never on `<body>` or a toast (SPEC-ux §11).
- 載入更多 keeps focus on itself while loading (`aria-disabled`, not `disabled`); after the last page it is replaced by 「沒有更多信了。」 and focus moves to the first newly loaded row's title; the rows are announced through the live region (「載入了 {n} 封」).
- A hover button whose action keeps the row (標為已讀, 封存 in 全部) hands focus back to the row's title; deleting an assignment from its 編輯作業 dialog focuses the next row's title (else 新增作業).
- Targets ≥ 44 px on coarse pointers (tray buttons 72 × row height; search 44 px; segments 44 px).
- Contrast: `--ok`/`--info`/`--danger` on their `-soft` fills are ≥ 4.5:1 in both themes (brief §B2 pairs); `mark.hit` keeps the text colour on `--accent-soft` and adds the `--accent` underline (≥ 3:1 on every row fill).

---

## 10. Motion

| What | Duration | How |
|---|---|---|
| Tray open / close | `--dur-2` | translateX of the content layer, `--ease`; spring-back on a short drag |
| Row exit after 刪除 / 移回 / 轉成作業 | SPEC-ux §8 | unchanged |
| Search results arriving | none | appended below; nothing above the cursor moves |
| 載入更多 | none | rows appear in place |

Reduced motion: every transition above is instant.

---

## 11. Ownership, build order and contracts

Two teams build in parallel on top of the contracts commit (`docs/ARCHITECTURE.md` §10.10 has the endpoint table and the file map):

| Team | Owns |
|---|---|
| MAIL | `server/features/gmail/**` except `triage-assignments.ts` (+ its test); `src/pages/inbox/**`; `src/copy/inbox.ts`; mail-row changes in `src/pages/today/**` (hover set, tray, `#` / Delete / A keys) and `src/copy/today.ts` strings for them; `src/components/command-palette/mailSearchSection.tsx`; `server/privacy.ts` wording; `scripts/seed-demo-mail.ts`; `server/integration-mail.test.ts`; its STATUS subsection |
| ASSIGNMENTS | `server/features/lms/**` (+ the `local_assignments` store); `server/features/gmail/triage-assignments.ts` (+ test); `shared/assignment-detect.ts` (+ test); `shared/assignments.ts` additions; `src/pages/work/**`; `src/copy/work.ts`; the 3-line `deadlineItems` change in `server/features/calendar/agenda.ts`; `scripts/seed-demo-assignments.ts`; `server/integration-assignments.test.ts`; its STATUS subsection |
| Lead (done in the contracts commit) | `shared/today*.ts`, `shared/suggestions.ts`, `shared/mail.ts` types, `server/modules.ts`, `server/today/**`, `server/db/schema.ts` v4, `src/lib/**`, `src/copy/common.ts`, the palette registration, icons, docs |

Build order inside each team: server contract + tests → UI against the fake Gmail / seeded data → screenshots (1440 × 900 light and dark, 390 × 844) → STATUS.

---

## 12. Test plan

### 12.1 Unit (node:test, pure)

- `shared/today-logic.test.ts`: `trash` closes a mail row and lowers `inboxUnread` when unread; `unarchive` is a no-op on the payload; `assignment` closes like `todo`; `suggestion.assignment` groups into 今天內.
- `server/features/gmail/views.test.ts`: the three view queries, the spam/trash suffix, `in:anywhere` stays scoped, unbalanced parentheses, length cap.
- `src/lib/router.test.ts`: `#/inbox?view=archive&q=…` and `#/inbox/<id>?view=all` round-trip; unknown views fall back to 收件匣; `pageKey` unchanged.
- `shared/assignment-detect.test.ts` (assignments): the golden table of §5.4 plus year roll-over, 下週X, 中午, date-only 23:59, links on unknown hosts dropped, automated senders refused.
- `src/pages/inbox/inbox-model.test.ts` (mail): `mailHoverActions`, local filter (NFKC, multi-term AND, operators skipped), highlight ranges, merge and dedupe of local and Gmail rows, `applyEdits` for 刪除 / 移回.
- `src/pages/work/work-model.test.ts` (assignments): course merge across origins, chips with 信件 / 手動, native pill 已繳交.

### 12.2 Server (fake Gmail, `startTestServer`)

- Mail: 刪除 on a cached conversation → nothing reaches Gmail within 6.5 s and undo sends nothing; after the commit `threads/<id>/trash` once; undo after commit → `untrash` + `modify add INBOX`; 503 without Gmail; a live (uncached) message id resolves its thread with one `messages.get(minimal)`; 移回收件匣 likewise; the archive list with the exact `q`, paging tokens, cache-only fallback with `origin: "cache"`, 429 wording; no `source_items` row is written by search; the reader's live fallback returns plain text only (an HTML-only fixture yields no tags); search logs carry no query text.
- Assignments: the `local_assignments` store on a database migrated from `personal.v1.sql`; the triage answer with `assignments` creates one suggestion per message and suppresses that message's todo; rule fallback with AI off; 加入作業 and its undo (suggestion reopened); 轉成作業 on cached and live mail, the 409 duplicate, undo; CRUD with trash restore; 409 on LMS rows; native rows in `today()` (queue, agenda, later, gap, nav) and in `GET /api/lms/assignments`; the fingerprint brings a 標為已交 row back after a due-date edit.
- Core (lead, this commit): the `assignment` exemption on gmail rows, refusal on `ai:` rows of another kind, the `suggestion.assignment` row shape, schema acceptance of the new keys `#` and `A`.

### 12.3 Integration and browser

- `server/integration-mail.test.ts` and `server/integration-assignments.test.ts` on the seeded day (separate files: no merge conflicts).
- Playwright against `:4381` with the seeded data dir: hover shows 封存 · 刪除 on inbox and Today mail rows; `#` deletes with the toast and Z restores; the 封存 view lists the seeded archived mail; `/` focuses search, typing 注音 does not search until composition ends, Esc clears; the palette's 搜尋信件 lands on `#/inbox?view=all&q=…`; 轉成作業 (A) creates a row on `#/work`; 加入作業 on the seeded suggestion; 新增作業 and 編輯 dialogs; zero console errors.
- Screenshots: `#/inbox`, `#/inbox?view=archive`, `#/inbox?q=作業`, `#/today`, `#/work` at 1440 × 900 light and dark and 390 × 844, plus the tray open on a phone row; the 320 px reflow check (no horizontal scroll).

---

## 13. Demo data

- `scripts/seed-demo-mail.ts` (mail team): three archived conversations (labels without INBOX) from the last week — one from 林志明 教授 already answered, one KKTIX receipt, one 系辦 notice — so the 封存 view has cache-only rows without Google.
- `scripts/seed-demo-assignments.ts` (assignments team): a teacher's mail in the inbox (「【作業系統】HW5 公告」, due in 4 days), a pending `assignment` suggestion made from it, and one native mail assignment already added (計算機網路 Lab 3, due in 6 days) plus one manual (專題提案書, no course).
- Both are called from `scripts/seed-demo.ts` (already wired): their messages join the one Gmail `replace`, so re-running the seed moves them to the new day.
