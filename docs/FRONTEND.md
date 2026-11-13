# BELL Personal frontend: shell, components and conventions

The contract for feature teams working in `src/`. The binding visual and
interaction rules are `docs/design/SPEC-ux.md`; this file says where things
live and how to plug into them. Server-side rules are in
`docs/ARCHITECTURE.md`.

```
src/
  main.tsx            createRoot + tokens.css + base.css + precise.css (C presentation)
  App.tsx             providers, shell, routed page, palette, ? dialog, global keys
  api.ts              api<T>() / send() / ApiError / followJob
  app/                the shell (owned by the shell team)
    AppShell.tsx      skip link, .app-shell, drawer, rail, main#main.page, quickbar, toast host
    Sidebar.tsx       brand, 快速記下, TODAY nav + counts, PROJECTS, streak, settings, guide, profile
    Topbar.tsx        breadcrumb, 快速前往 pill, sync chip, theme toggle, avatar
    QuickBar.tsx      ≤720 bottom bar
    nav.ts            NAV_ITEMS / BOTTOM_ITEMS / pageLabel()
    routes.tsx        route → page (never edit to add a page body: replace the page file)
    shell-context.tsx useShell(): openPalette(mode, text) / closePalette() / openHelp()
    ShortcutHelp.tsx  the ? dialog
    AppearanceControls.tsx  theme + 單鍵快捷鍵 controls for 連線與設定 › 外觀
  components/         shared components, one .tsx + one .css each (see inventory)
    command-palette/  CommandPalette, the 前往 section, the 快速新增 extension point
    toast/            ToastProvider, ToastHost, useToast
  copy/common.ts      shell + shared component strings
  lib/                router, today store, status store, keys, shortcuts, storage, preferences, usePoll
  pages/<dir>/<Name>Page.tsx (+ .css)   one folder per route
  styles/tokens.css   the only file with hex colours
  styles/base.css     reset, focus, kbd, .kp/.mono/.ico/.sr-only/.skip/.eyebrow/.m-only/.d-only
```

## 1. Pages

Every route in SPEC-ux §3.1 already renders. Feature teams **replace the
page file** (same path, same default export, same props); `src/app/routes.tsx`
does not change. Placeholders render the route's `.page-head` and a dashed
「建置中」 empty state through `src/pages/PagePlaceholder.tsx`.

| Route | File | Props |
| --- | --- | --- |
| `#/today` (default; `#/` and `""` redirect) | `src/pages/today/TodayPage.tsx` | `{ route: RouteOf<"today"> }` |
| `#/inbox`, `#/inbox/:threadId` (`?view=archive\|all&q=…`) | `src/pages/inbox/InboxPage.tsx` | `{ route: RouteOf<"inbox"> }` (`threadId?`, `view?`, `q?`; SPEC-mail-assignments §1.1) |
| `#/calendar?view=day\|week` | `src/pages/calendar/CalendarPage.tsx` | `{ route: RouteOf<"calendar"> }` (`view`, default `day`) |
| `#/tasks` | `src/pages/tasks/TasksPage.tsx` | `{ route: RouteOf<"tasks"> }` |
| `#/work?tab=assignments\|projects\|github`, `#/work/projects/:id` (`#/projects/:id` redirects) | `src/pages/work/WorkPage.tsx` | `{ route: RouteOf<"work"> \| RouteOf<"project"> }` |
| `#/events` | `src/pages/events/EventsPage.tsx` | `{ route: RouteOf<"events"> }` |
| `#/ideas` | `src/pages/ideas/IdeasPage.tsx` | `{ route: RouteOf<"ideas"> }` |
| `#/habits` | `src/pages/habits/HabitsPage.tsx` | `{ route: RouteOf<"habits"> }` |
| `#/settings/:tab` (`sources` default, `brief`, `appearance`, `privacy`), `#/settings/sources/google` | `src/pages/settings/SettingsPage.tsx` | `{ route: RouteOf<"settings"> \| RouteOf<"google-guide"> }` |
| `#/setup` | `src/pages/setup/SetupPage.tsx` | `{ route: RouteOf<"setup"> }` |
| `#/guide` (`#/guide#keys` is the keyboard section) | `src/pages/guide/GuidePage.tsx` | `{ route: RouteOf<"guide"> }` |
| anything else | `src/pages/not-found/NotFoundPage.tsx` (complete) | `{ route: RouteOf<"not-found"> }` (`path`) |

Router (`src/lib/router.ts`): `parseHash(hash) → Route`, `routeHref(route)`,
`canonicalHash(hash)` (the redirects), `navSection(route)`, `useRoute()`,
`navigate(hash)`, `SETTINGS_TABS`, `WORK_TABS`, `CALENDAR_VIEWS`. Unknown
paths, unknown settings tabs and malformed ids are a 404, never a silent
redirect. Build links with `routeHref({ name: "work", tab: "github" })`.

Every route change closes the drawer and sets `document.title` to
「{page} · BELL Personal」. A new page (`pageKey(route)`: the route name, a
project id or a 404 path) also scrolls to the top and moves focus to
`main#main`; a change inside a page (日/週, a settings or work tab, an inbox
conversation) leaves scroll and focus to the page, so the control just used
keeps focus. Below 1180 the inbox does this itself: a conversation opens at
the top and 回到收件匣 / Esc restore the list's scroll with focus on the row
just read. Closing the drawer returns focus to ≡ (to `<main>` when a link in
it changed the route) after the render that lifts `inert` from the workspace.

Page layout: start with `<PageHead eyebrow title sub actions />` (SPEC-ux
§3.3) and reuse the components below; SPEC-ux §3.3 forbids new button, card,
pill or row styles. Page-only CSS goes in the page's own `.css`, built from
tokens.

## 2. Data stores

### TodayProvider / `useToday()` — `src/lib/today.tsx`

The one client store for `GET /api/today` (`TodayPayload`, `shared/today.ts`).
Counts are never computed twice: the sidebar, quickbar, H1, progress and
queue footer all read `data.counts`.

```ts
const today = useToday();
today.data        // TodayPayload | undefined (with optimistic edits applied)
today.state       // "loading" | "ready" | "stale" | "error"   (usePoll states)
today.error       // zh-TW sentence when the last fetch failed
today.updatedAt   // ms since epoch of the payload
today.refresh()   // refetch now
today.act(itemId, action, params?, { message?, silent?, onUndo?, onFailed? })   // → Promise<{ ok, actionId?, undoUntil?, error? }>
today.optimistic(payload => nextPayload)                       // → { settle(), revert() }
today.nav         // { today?, inbox?, tasks?, work?, events?, habits? } for badges
today.projects    // sidebar PROJECTS (≤5)
today.streak      // sidebar streak days, or undefined
```

- Polls every 60 s (`TODAY_POLL_MS`); skipped while the tab is hidden;
  refreshed on focus, visibility and `online`. The last good payload stays on
  a failed refresh (`state: "stale"`).
- `POST /api/sync {}` on mount and on window focus (at most every 15 s). When
  the answer's `started` is not empty, the sync chip shows the answer's
  `sources` at once (`useStatus().noteSources`), Today refreshes every 3 s
  until none of the started sources is `syncing` in `data.sources` (at most
  10 times), then `/api/status` is read again (`followSync`).
- `act()` (SPEC-ux §6.5): the row leaves its group and counts move from
  `open` to `handled` (and `handledBy`, and `inboxUnread` for mail
  archive/read) at once, with `applyActionToPayload` from
  `shared/today-logic.ts` — the same `ACTION_EFFECTS` rule the server uses —
  and the undo toast shows at once with the SPEC copy (「已完成「…」」,
  「已封存「…」」, `params.label` feeds 「已延後到{label}」 and the `· {when}`
  suffix; a row with a `subject`, such as 「…，要參加嗎？」, is quoted by its
  subject) while `POST /api/actions {itemId, action, params?}` →
  `ActionAccepted {actionId, undoUntil, label}` → refresh runs. 復原 or Z →
  the row returns to its old place and `DELETE /api/actions/:actionId` (body
  `{}`) follows once the POST has answered → refresh. A failed POST puts the
  row back, drops the undo toast and shows 「{動作}失敗：{reason}」 with 重試. 回覆 marks the row
  `replying` (回覆中…) and 開啟 keeps it, both without a toast (nothing to
  undo); 排進 (`schedule`) removes `agenda.gap` and does show one. The server's
  `label` is for logs and the handled list; the toast quotes the row title.
- After `undoUntil` + 1.5 s the action's `GET /api/actions/:actionId` is read
  (again every 2 s while `pending`, at most 4 reads; skipped once undone).
  `state: "failed"` means the deferred Gmail/Calendar/GitHub write failed and
  the server already put the row back: the caller's own edits go
  (`onFailed`, e.g. #/inbox's 封存 / 全部 / search pages), an error toast
  「{動作}失敗：{error}」 with 重試 appears and Today refreshes
  (`remoteFailure`, `reportRemoteFailure`). A refused POST that answered 409
  (already done) gets no 重試.
- 轉成作業 / 加入作業 answer `ActionAccepted.created` (the record's title and
  deadline): the undo toast is rewritten with it (`toast.update`,
  `createdToast`), so the only confirmation names what was saved.
- `optimistic()` is the same mechanism for other widgets (habit check-ins,
  digest bulk read): apply, call your endpoint, then `settle()` on success or
  `revert()` on failure. A settled edit is dropped once a refresh that
  started after it lands; edits are written to be no-ops on data that
  already reflects them.
- Pure helpers with tests: `src/lib/today-model.ts` (`restoreQueueItem`,
  `navCounts`, `sidebarProjects`, `streakDays`, `offersUndo`,
  `remoteFailure`, `followSync`, `syncChipState`, `dayEyebrow`,
  `clockTime`). Test fixture: `src/lib/today.fixture.ts` (`mockupToday()`,
  the SPEC-ux §13 day).

Where the shell's numbers come from (server contract, `shared/today.ts`):
nav badges 今天 = `counts.open`, 收件匣 and the quickbar = `counts.inboxUnread`,
習慣 = `counts.habitsLeft`, 待辦 / 作業與專案 / 活動 = `counts.nav.tasks` /
`.work` / `.events` (absent or 0 = no badge). PROJECTS = `sidebar.projects`
(`{id, name, pct, color}` → `#/work/projects/:id`, `color` a `ProjectColor`
name) whenever the payload has a `sidebar`, else the native rows of
`later.projects` (their in-app `href`, else `#/work?tab=projects`). The
streak card = `sidebar.streakDays`, else the shortest daily-habit streak.

### StatusProvider / `useStatus()` — `src/lib/status.tsx`

One shared poll of `GET /api/status` every 60 s (`STATUS_POLL_MS`; each probe
starts the CLIs and a GitHub API call, so not every 10 s) plus focus,
visibility and reconnect. `useStatus()` is the usual `Poll<StatusResponse>`
plus `chip: SyncChipState` — `ok {at}` / `syncing` / `warn {count}` (any
configured source `needs_reconnect` or `error`) / `none` (nothing
connected) / `offline` (service unreachable) — and `noteSources(sources)`,
which shows source states newer than the last poll (the `POST /api/sync`
answer) until the next status fetch. The chip always reflects the real
server: under the dev fixture override (`BELLPERSONAL_TODAY_FIXTURE`) only
`/api/today` and `/api/actions` are fixtures.

## 3. Shell API

- `useShell().openPalette("go" | "capture", text?)` — e.g. Today's empty
  state 「＋ 記下一件事」 opens capture mode; Calendar's 新增行程 can prefill.
- `useShell().openHelp()` — the `?` dialog.
- `useToast()` — see Toast below.
- Breakpoints (`MEDIA` in `src/lib/useMediaQuery.ts`): `mobile` ≤720 (drawer +
  quickbar), `rail` ≤980 (64px rail unless the user expanded it), `wide`
  ≥1081 (Today two columns). `useMediaQuery(MEDIA.mobile)`.
- Sidebar width: `bell-personal.sidebar.collapsed` = `"true"` (rail),
  `"false"` (full) or unset (rail only at ≤980). `.app-shell[data-sidebar="rail"]`
  drives the CSS and `--sidebar-current`.
- Theme and 單鍵快捷鍵 are AppSettings (`theme`, `singleKeyShortcuts`, saved
  with `PUT /api/settings/app`) cached in localStorage: `bell-personal.theme`
  = `light` | `dark` | unset (system), applied to `<html data-theme>` (and
  before first paint by `public/theme-boot.js`), and
  `bell-personal.shortcuts.single-key = "off"`. On load the server's values
  replace the cache (`useServerPreferences()`, unless the user changed one
  meanwhile); `chooseTheme(mode)` / `chooseSingleKeys(on)` apply at once and
  save (a failed save shows 「儲存外觀設定失敗：…」). `useThemeMode()`,
  `useSingleKeyShortcuts()` in `src/lib/preferences.ts`. The topbar toggle
  cycles system → the opposite of the system theme → the same → system.

## 4. Keyboard

One window listener and one guard (`src/lib/shortcuts.ts`, `src/lib/keys.ts`,
SPEC-ux §6.2):

1. IME composing (`isComposing || keyCode === 229`) → nothing, not even ⌘K.
2. Under the C addendum, ⌘K / Ctrl K opens the suite switcher and Ctrl+1–3 selects a product. The topbar 搜尋 button opens the existing command palette directly; N and capture keys are unchanged.
3. Typing targets (input, textarea, select, contentEditable), an open
   non-palette `<dialog>`, Alt, and other ⌘/Ctrl combos → ignored. ⌘Z →
   `"mod+z"`.
4. 單鍵快捷鍵 off (`bell-personal.shortcuts.single-key = "off"`) → letters,
   digits and symbols are ignored; Esc, ↵, arrows and Space still work.
5. `G` then a key within 1 s → the chord `"g x"`.

Register page keys while mounted; the newest handler runs first, return
`false` to pass a key on:

```ts
useShortcuts({ j: () => move(1), arrowdown: () => move(1), e: () => close(), "1": () => toggleHabit(0) });
```

Combos: single keys lower-case (`"e"`, `"?"`, `"1"`), named keys
(`"enter"`, `"escape"`, `"space"`, `"arrowdown"`), `"mod+k"`, `"mod+z"`,
chords `"g i"`. The shell owns ⌘K, N, ?, the G chords and drawer Esc; the
toast provider owns Z / ⌘Z (only while an undo toast is visible).

Every other keydown handler (inputs, rows) must call `isComposing(e.nativeEvent)`
first. `SHORTCUTS` is the single list behind the `?` dialog and
`#/guide#keys` (`<ShortcutList />`).
`GO_CHORDS` maps chords to hashes. Use `<Keys keys={["Mod", "K"]} />` to show
⌘ or Ctrl correctly. SPEC-mail-assignments §6 adds `#` / Delete (刪除), `A`
(轉成作業 / 加入作業) and `/` (mail search, scope 收件匣); the inbox footer uses
`inboxLegendItems()` (`J K 移動 · E 封存 · # 刪除 · / 搜尋 · Z 復原 · ? 全部`).
Row action kbds are `QUEUE_ACTION_KEYS` (`shared/today.ts`).
On #/tasks `S` opens 排日期 on an undated cursor row (1–5 pick a preset, the
same guards and `snoozeKeyIntent` as Today's 延後); the legend adds
`S 排日期` while an undated row exists. The palette's 行程 preview has a 重複
chip (`ParseRow.onRepeat`, palette only) with an optional 直到 date.

## 5. Command palette

`src/components/command-palette/CommandPalette.tsx`: a native modal
`<dialog class="palette">` (bottom sheet at ≤720), opened by ⌘K (go mode) and
by N, 快速記下, ＋捕捉 (capture mode; a leading `+` also switches to capture).
↑↓ move, ↵ runs, Esc closes, nothing happens while composing; the text in
capture mode persists in `bell-personal.composer.draft` until an option runs.

Sections, in SPEC order 快速新增 → AI 解析 → 前往 → 搜尋 → 信件:

- `quickAdd.tsx` (`useQuickAddSection: PaletteSectionsHook`, tasks team): the
  rule option (title, `待辦 · 明天 10/13（二）09:00 到期`, `規則解析` tag, the
  `.parse-row` with the type control and chips), a second option with the
  other dated type (`建立行程「交報告」`), and, when AI is on and the rules
  were unsure in capture mode (or ⌘↵), the 「AI 建議」 option from
  `POST /api/capture/parse`. Tab / Shift+Tab cycle the type; ↵ commits once,
  optimistically (undo toast; a failed save puts the text back as the draft).
  It also returns `marks`: the parser's tokens, drawn in `--m-cal` through a
  mirror layer behind the input (hidden while an IME composes).
- `goSection.tsx`: 前往 (built in).
- `searchSection.tsx`: 搜尋 todos, ideas and projects (`GET /api/capture/search`),
  ↵ opens `#/tasks?focus=<id>`, `#/ideas?focus=<id>` or the project.
- `mailSearchSection.tsx` (mail team): 信件 — 「搜尋信件「…」」 opens
  `#/inbox?view=all&q=…` (SPEC-mail-assignments §4.4).

The hook gets `{ mode, text, open }` and returns `{ sections, onKeyDown?,
footer?, marks? }` or `null` (types in `types.ts`). An option is `{ id, title,
meta?, icon, tone?, aside?, detail?, enterLabel?, run }`; `detail` renders
under the active option, `onKeyDown` sees every key first, `run()` returning
`false` or throwing keeps the palette open. Quick-add sections come first in
capture mode and when the text matches no page label.

### Quick capture everywhere (`src/components/capture/`, tasks team)

One pipeline (SPEC-ux §6.6) behind every capture surface:

| Export | Use |
| --- | --- |
| `<CaptureField context? hintAside? onCommit? onCreated? kbd? draftKey? />` | Today's capture card: `.cap-field` + `.cap-hint` with the live preview 「→ 待辦 · 明天 10/13（二）09:00 · Tab 換類型」. ↵ commits, Tab cycles the type, ⌘↵ hands the text to the palette (AI 解析), Esc blurs. Wrap it in `<section class="card capture">` and add `.recent` from `useToday().data.ideas`; `onCommit(parse)` fires at once (prepend an idea). Default `context="idea"` (no date → 靈感). The shell's N focuses its input on Today ≥1081. |
| `<Composer onSaved? />` | #/ideas: tabs 靈感 · 待辦 · 筆記, drafts per tab. |
| `<ParseRow parse timeZone onType onMoment hideHint? />` | `.parse-row`: `.seg` type control and `.tokchip` chips (the date chip edits in place). |
| `useCaptureEnv()` | `{ timeZone, aiParse, eventTarget }` from `/api/status` `modules.capture`. |
| `useCaptureState(text, context, timeZone)` | `{ rule, parse, setType, cycleType, setMoment }`. |
| `useCaptureCommit(timeZone)` | `commit(text, parse \| aiOption, { onFailed, onCreated, suggestionId })`: undo toast at once, POST /api/capture behind it, 復原 = DELETE `undoPath`, failure → 「沒有記下來：…草稿已保留。」 [重試]. |
| `useAiParse(text, wanted)` | the 600 ms-debounced AI parse; aborting cancels the server job. |
| `useTidyFollower()`, `useTidyAction()`, `useTidyRevert()` (`capture/tidy.ts`) | 自動整理 (SPEC-ux §6.6.1): `follow(start, { manual?, toastId? })` follows a `capture-tidy` job, refreshes the lists when it rewrote something and shows 「已整理成「…」· 10/18（日）」 [復原] (automatic no-ops and failures stay silent; a manual one says why). `useCaptureCommit` calls it with its toast's id when `CaptureResponse.tidy` is set and puts the note 「整理中…」 on the capture toast meanwhile; the result goes through `toast.followUp(toastId, …)`, so it never takes another action's 復原 or Z. `useTidyAction()(kind, id)` is the 整理 button (POST /api/capture/tidy); `useTidyRevert()(kind, id)` is 復原整理 (POST /api/capture/tidy/revert, shown while the record has `pretidy`). |
| `useTidying(kind, id)`, `isTidying` + `useTidyVersion()` | whether a record's tidy runs, for the 「整理中…」 pill (`.ai-tag.inline.tidy-mark`) on #/tasks rows and #/calendar local events. |
| `CAPTURED_EVENT` | window event after a capture or its undo; pages listing todos or ideas refetch. Today refreshes itself. |

localStorage keys: `bell-personal.capture.field` (the field's draft),
`bell-personal.composer.idea|todo|note` (Composer drafts),
`bell-personal.composer.tab`; the palette keeps `bell-personal.composer.draft`.

## 6. Components

All in `src/components/`, class names exactly as SPEC-ux §9, CSS ported from
`docs/design/mockup/src/app.css` / `states.css`. Icons are lucide-react,
always through `<Icon>` (adds `.ico` and `aria-hidden`).

| Component | Import | Props / notes |
| --- | --- | --- |
| `Icon` + glyph re-exports | `components/Icon` | `{ icon, size?: "md"\|"sm"\|"xs", className }` — 16/14/13px |
| `Button` | `components/Button` | `{ variant?: "primary"\|"secondary"\|"ghost"\|"danger"\|"icon", size?: "md"\|"sm", icon?, kbd?, href?, external? }` + button/anchor attributes. `buttonClass()` for custom elements. 44px on coarse pointers |
| `TextLink` | `components/Link` | `{ href, accent?, external?, bare? }` → `.link(.accent/.ext)` with arrow |
| `Kbd`, `Keys` | `components/Kbd` | `<Keys keys={["G","T"]} />`; "Mod" → ⌘/Ctrl |
| `Card`, `CardHead` | `components/Card` | `Card { as?, className }`; `CardHead { title, titleId?, icon?, tone?, count?, countLabel?, link?: {href,label}, children }` |
| `Tile` | `components/Tile` | `{ icon, tone?: TileTone, size?: "md"\|"xl" }` → `.tile.t-*` / `.tile54` |
| `Pill`, `StatusPill` | `components/Pill` | `Pill { tone?: "neutral"\|"danger"\|"warn"\|"ok"\|"info"\|"accent", dot? }`; `StatusPill { state: SourceState, label? }` |
| `Chip`, `ChipGroup` | `components/Chip` | `ChipGroup { label, options: {value,label,count?,error?,errorTitle?}[], value, allValue, onChange }` — second click returns to `allValue` (`nextChipValue`) |
| `Checkbox` | `components/Checkbox` | `{ checked, onChange(next) → void \| Promise, label?, ariaLabel? }` — optimistic, reverts when the promise rejects |
| `Notice` | `components/Notice` | `{ tone?: "warn"\|"error"\|"ok", title, children (text), actions?, icon?, role? }` |
| `EmptyState` | `components/EmptyState` | `{ icon, tone?, title, hint?, action? (one Button), solid?, art? }` |
| `Skeleton`, `SkeletonRow`, `SkeletonStatus`, `Spinner` | `components/Skeleton` | `Skeleton { width?, height?, radius? }`; `SkeletonStatus` = `.skel-status` + `.spin` |
| `StaleNote` | `components/StaleNote` | `{ time, onRefresh?, text? }` → 「顯示 {time} 的資料 · 重新整理」 |
| `ToastProvider`, `ToastHost`, `useToast` | `components/toast/ToastProvider` | `toast.undo(msg, onUndo, {icon?, onExpire?})` 6 s + Z; `toast.success(msg)` 3.5 s; `toast.error(msg, onRetry?)` sticky, `role=alert`; `toast.update(id, msg)` rewrites a visible one; `toast.dismiss(id)`, `toast.undoLatest()`. Pauses on hover/focus/hidden tab; max 3; a new undo toast commits the previous one |
| `ToastProvider`, `ToastHost`, `useToast` | `components/toast/ToastProvider` | `toast.undo(msg, onUndo, {icon?, onExpire?})` 6 s + Z; `toast.success(msg)` 3.5 s; `toast.error(msg, onRetry?)` sticky, `role=alert`; `toast.dismiss(id)`, `toast.undoLatest()`; `toast.update(id, { note })` sets or clears a short status with a spinner after the message (「整理中…」, never clamped); `toast.followUp(previousId, input)` shows a late follow-up of an earlier undo toast — in its place with a fresh timer while it is visible, else `passive` (its own 復原 only: Z / ⌘Z skip it, no key hint, and it ends no other undo toast) while another action's undo toast is up, else a normal undo toast. Pauses on hover/focus/hidden tab; max 3; a new (non-passive) undo toast commits the previous one |
| `Dialog`, `useNativeDialog` | `components/Dialog` | `{ open, onClose, title, children, footer?, className?, initialFocus? }` — native `<dialog>` + 「關閉視窗」 |
| `Avatar` | `components/Avatar` | `{ name, initial?, variant?: "person" (serif) \| "self" }` |
| `SegmentedControl` | `components/SegmentedControl` | `{ label, options: {value,label}[], value, onChange }` → `.seg` |
| `Tabs` | `components/Tabs` | `{ label, items: {value,label,href?,count?,controls?}[], value, onChange? }` — links with `aria-current` when every item has `href`, else an ARIA tablist |
| `Field`, `TextInput`, `Textarea`, `Select`, `Switch` | `components/Field` | `Field { label, hint?, error?, children: one control }` wires id/aria; `Switch { checked, onChange, label, hint? }` |
| `PageHead` | `components/PageHead` | `{ eyebrow, title, sub?, actions?, titleId? }` |
| `AiTag` | `components/AiTag` | `{ kind: "summary"\|"suggestion"\|"rule"\|"ruleParse", title? }` |
| `ShortcutList` | `components/ShortcutList` | every shortcut by scope |

Habit check-ins are shared with Today through `src/pages/habits/useHabitKeys.ts`
(habits team): `useHabitToggle()` returns `toggle({id, name, doneToday})` for the
`.hcheck` buttons, the ≤1080 chips, the cleared state's `.hchip`s and the
agenda's 「打卡「運動」」 (optimistic on the Today store, then
`POST`/`DELETE /api/habits/:id/check`; an undo toast only when un-checking;
「打卡沒有存到，請再試一次。」 on failure); `useHabitKeys(habits, toggle)` wires
keys 1–9; `useTodayHabitKeys()` does both over `useToday().data.habits`. The
automatic habit (`AUTO_HABIT_ID` in `shared/habits.ts`) is never toggled by hand.

Today-specific components (TodayHero, FocusQueue, DigestStrip, LaterCard,
CaptureCard, HabitsCard, AgendaCard, EndMark, Celebration) and SourceCard
are the feature teams'; the class names and CSS for them are in the mockup.
Row swipes are shared by Today's queue and the inbox list:
`src/pages/today/swipe.ts` (`useRowSwipe`, the pure `swipeOffset` /
`swipeDecision` rules, `useTrayDismiss`) and `SwipeTray.tsx` (+ `.css`, which
also holds `.q-swipe`), the mail-row 封存 · 刪除 tray of SPEC-mail-assignments
§2.4. Mail rows' hover set is `mailHoverActions()` in `today-view.ts`.

The Today page lives in `src/pages/today/`: one presentational component
per widget (props in, callbacks out, so `renderToStaticMarkup` tests cover
every state), `TodayPage.tsx` wires them to `useToday()`, `today-view.ts`
holds the pure rules (chips, cursor, keys, snooze times, the agenda
timeline) and `today-api.ts` the calls to other teams' endpoints (brief
refresh, sync). A row whose `url` starts with `#/` (an assignment from mail
opens `#/inbox/<threadId>`) opens inside the app (`isInAppUrl`), not in a new
tab. Habit check-ins (chips, keys 1–9, the agenda's 打卡) use the
habits team's `useHabitToggle()`; the capture card wraps the tasks team's
`<CaptureField>` (live parse preview, Tab, undo toast). 全部標為已讀 / 逐類看 act on
`gmail:digest` / `gmail:digest:<key>` through `act()`. Settings, the Google
guide and `#/setup` live in `src/pages/settings/` and `src/pages/setup/`
(`settings-api.ts`, `settings-forms.ts` validation, `useAppSettings()`).
Their browser-only keys: `bell-personal.today.collapsed-widgets` (widgets
opened on a phone, `["later"]`), `bell-personal.setup.seen` (first run
offered once) and `bell-personal.google-guide.steps` (ticked guide steps).

### The mail reader's original layout (SPEC-mail-html)

`src/pages/inbox/MailBody.tsx` renders one message in 原始版面 or 純文字 (states,
the blocked-images notice, the attachment strip); `MailFrame.tsx` is the only place
untrusted HTML reaches the page: `<iframe sandbox="allow-same-origin allow-popups
allow-popups-to-escape-sandbox" srcdoc>` (never add `allow-scripts`), sized to its
content (`HeightGuard`) and zoomed to fit (`fitZoom`, `mail-frame.ts`), handing
keys to the shortcut dispatcher. `useMailBody.ts` keeps answers for the page
session (`peekMailBody`, `forgetMailBodies`). The view is `useMailView()` /
`chooseMailView()` (`src/lib/preferences.ts`, AppSettings `mail.bodyView`, cache
`bell-personal.mail.view`); `I` is the `images` shortcut (scope 收件匣).

## 7. Copy

- All user-facing zh-TW text comes from `src/copy/*.ts`. `common.ts` holds the
  shell and shared-component strings (SPEC-ux §10), page heads
  (`PAGE_HEADS`), toast templates (`ACTION_TOASTS`), errors and AI tags.
- Feature teams add `src/copy/<domain>.ts` (`today.ts`, `inbox.ts`,
  `calendar.ts`, …) and import it directly. There is no index file to edit.
- Group strings in `as const` objects; templates are functions
  (`(n: number) => \`${n} 封未讀\``). Full-width punctuation, `·` separators,
  `…` in progress text, half-width spaces around Latin and numbers.

## 8. Styling rules

- Tokens only: no hex outside `src/styles/tokens.css` (both dark blocks stay
  byte-identical). New non-colour tokens are added there.
- No readable text under 12px (11px is for mono eyebrows and `<kbd>`).
- `--muted` text never sits on `--surface-sunk`; `--faint` is never text.
- Focus is the global `outline: 3px solid var(--accent-ring)`.
- Touch: interactive elements reach 44px on `(pointer: coarse)`.
- Motion uses `--ease` and `--dur-*`; base.css turns it off under
  `prefers-reduced-motion`.
- localStorage keys are `bell-personal.*` (`STORAGE_KEYS` in
  `src/lib/storage.ts`); always go through `readStorage`/`writeStorage` or
  `storedValue()`, which never throw.

## 9. Tests

`npm test` runs `src/**/*.test.ts` under node:test with CSS imports stubbed
(`test/css-stub.mjs`). Keep logic that needs tests in pure modules (see
`today-model.ts`, `router.ts`, `shortcuts.ts`, `command-palette/match.ts`)
and inject seams (`createShortcutDispatcher({ singleKeys, apple, dialogOpen, now })`).
