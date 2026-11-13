# BELL Personal — UX spec v1 (authoritative)

Date: 2026-10-13. Owner: design lead. Status: **locked for implementation**.

Addenda: `SPEC-mail-assignments.md` (2026-10-15: mail row actions, archive, search, assignments from mail) overrides the sections it lists in its §0.2. `SPEC-ux-c-precise.md` (2026-11-08) overrides the v1 visual, copy, switcher and stack rules it names.

This spec overrides `brief.md` §B4–§B7 wherever they disagree. Where it is silent, the brief and `decisions.md` still apply. Every number, class name and string here is meant to be copied, not reinterpreted. If two engineers would make different choices from this text, that is a spec bug: raise it, don't improvise.

**Reference files** (all in `scratchpad/bp/design/final/`):
- `index.html`: the Today page at 2026-10-12 08:42. Captures: `desktop.png`, `desktop-dark.png`, `mobile.png`, `mobile-dark.png`, `tablet-900.png`.
- `states.html`: eight states. Captures: `states-desktop.png`, `states-desktop-dark.png`, `states-mobile.png`.
- `src/`: `tokens.css`, `app.css` (shared component CSS), `states.css` (state-board layout plus celebration, palette and source-card CSS), `sprite.html` (lucide paths), and the two body files. `tools/build-final.mjs` assembles them.

The CSS in `src/app.css` is the reference implementation for every class named in §9. Port it into per-component files. Don't restyle it.

---

## 0. Decision record

**Base concept:** B, 「專注佇列」 (focus queue). Its scores were: friction 9 (winner), robust 8 (winner) and craft 8, one point behind A. The user's first priority is lowest friction, and B is the only concept where the first decision takes zero navigation. The cursor sits on the top item, already open, with its actions showing. It is also the shortest page and the only one that scales to 40 mails or 12 todos without growing linearly.

B was refined towards A's calm, because A won the craft lens:
- Queue rows lost the 4px rail and nearly all status pills, so module identity now comes from one tinted tile. Status words moved into the meta line.
- Only one row is highlighted by default: the cursor.
- Section dividers are hairlines.
- The page ends with A's end mark, so it reads as finite.

**Grafts:**

| From | What | Where it lives now |
|---|---|---|
| A | finite-page end mark 「今天的版面到這裡。」 | `.endmark` |
| A | one-tap bulk 「全部標為已讀」 on folded mail | `.digest` |
| A | habits come straight after "what's next" on mobile | `.today-grid .habits{order:1}` |
| A | "what's next" in the hero, not only in the side panel | `.next-up` under the progress meter (all widths) |
| A | one visible labelled primary action per row on touch | `.q-primary` |
| C | free-slot suggestion with one-tap 排進 | `.tl-gap .gap-box` |
| C | stale-data note | `.stale-note` |
| C | 32px round habit buttons and a weekday header | `.hcheck`, `.h-days` |
| C | per-category contextual action in the digest | 「逐類看」 expansion (§4.6) |
| D | three 44px one-tap habit chips under the hero (≤1080) | `.habits` chip mode |
| D | event-linked habit check-in (健身 → 打卡「運動」) | agenda meta, then a button after the event ends |
| D | rain line in the eyebrow (「21:00 後降雨 60%」) | `.eyebrow .wx` |
| D | 明天與之後 peek | `.later` |

**Removed from brief §B5:**
- The 今日重點 decision grid. Its job is done by the queue's three groups.
- The metric strip. Its job is done by the progress meter and the sidebar counts.

The judges showed that both repeated the same items three or four times.

**Every must-fix from the three verdicts** is resolved, either in the mockups or in this spec:
- mobile habits buried → chips at order 1
- 2-tap touch actions → `.q-primary`
- composer below the fold → the capture card is first in the side column
- IME-unsafe single-key shortcuts → §6.2 guard
- celebration contradicting the habits → §5 and states 02
- §0 rule 1 coverage → the `.later` card
- the digest offered navigation only → 全部標為已讀 plus 逐類看
- hover hid the due time → `.when` is always visible
- "complete" semantics for external items → §6.4
- meta truncation hid the key fact → the due phrase lives in `.when`
- action column misalignment → actions are part of `.q-end`
- streak orphan → `.kp` plus a title/body split
- invalid ARIA → §11
- scale caps → §4.3
- source failure visible → §5 and state 03
- AI fallback → §4.2 and state 05
- 320px reflow → §11
- kbd contrast → §2
- quickbar always fixed → §7

---

## 1. Principles (apply to every page)

1. **Open once, finish once.** Today is a finite list you work down. Each item has **one primary action**, visible and reachable in one click, one key or one tap. Everything else is secondary.
2. **AI proposes, you confirm.** Model output only ever creates *suggestions* with a one-tap confirm. Nothing is archived, sent, created or deleted without a user action. Every AI surface has a rule-based fallback, and the page never waits on a model. AI text is always marked: `.ai-tag` 「AI 摘要」/「AI 建議」, or the sparkles icon in `.q-sum`.
3. **Never silently wrong.** Counts come from one store (§4.3). A broken source is shown where its items would be (§5), never hidden.
4. **Optimistic and reversible.** No confirm dialogs for reversible actions. The UI updates first, then shows a 6 s undo toast, and remote writes are deferred until the toast expires (§6.5).
5. **Calm.** One accent (clay) for the primary action and the cursor only. Module colours appear only on 28–30px tiles, timeline bars and habit fills. No pills unless a status is not already said elsewhere. No emoji. No text under 12px except mono eyebrows and `<kbd>`.
6. **zh-TW first.** Use full-width punctuation, `·` as the separator, CJK phrase-safe line breaking (`.kp`), and the Asia/Taipei day boundary.

---

## 2. Tokens (final, full CSS)

`src/styles/tokens.css` = the brief §B2 block **verbatim** (both dark blocks identical) + the B2.1 additions below.

The additions are **non-colour only**, so dark mode needs no change. No hex values may appear anywhere else in the codebase; CI should grep `src/**/*.css` (excluding `tokens.css`) for `#[0-9a-f]{3,8}\b` and fail.

```css
:root{
  --font-sans:"DM Sans","PingFang TC","Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei",system-ui,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,"SFMono-Regular",monospace;
  --fs-2xs:11px; /* mono eyebrow / kbd ONLY */ --fs-xs:12px; --fs-sm:13px; --fs-md:14px; --fs-lg:16px;
  --fs-xl:20px; --fs-2xl:26px; --fs-hero:30px; --lh-tight:1.35; --lh-body:1.7; --lh-hero:1.55; --track-eyebrow:1.4px;
  --canvas:#faf9f6; --surface:#ffffff; --surface-soft:#f5f2ec; --surface-sunk:#efebe3;
  --ink:#2a2722; --ink-2:#5c564c; --muted:#736b5f; --faint:#8f877a;
  --border:#e8e3da; --border-strong:#d6cfc2;
  --accent:#a4532c; --accent-strong:#87421f; --accent-soft:#f6ebe3; --accent-ring:#e8c3ab; --on-accent:#ffffff;
  --ok:#2f7350; --ok-soft:#e9f4ee; --warn:#99620f; --warn-soft:#fbf3e2; --danger:#b03e36; --danger-soft:#fcedeb; --info:#3f5fbf; --info-soft:#edf1fc;
  --m-mail:#4f6f95;  --m-mail-bg:#edf2f7;  --m-cal:#6f58a0;   --m-cal-bg:#f2eff8;
  --m-task:#2f7350;  --m-task-bg:#ecf4ee;  --m-event:#8a6320; --m-event-bg:#faf3e4;
  --m-idea:#a5506d;  --m-idea-bg:#f9eef2;  --m-habit:#2a716e; --m-habit-bg:#e9f4f3;
  --r-xs:5px; --r-sm:7px; --r-md:10px; --r-lg:13px; --r-xl:16px; --r-pill:999px;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px; --sp-8:32px; --sp-10:40px;
  --shadow-card:0 2px 10px rgb(42 33 22 / .04); --shadow-btn:0 1px 2px rgb(42 33 22 / .06);
  --shadow-pop:0 8px 24px rgb(42 33 22 / .12); --shadow-modal:0 28px 100px rgb(42 33 22 / .25),0 8px 28px rgb(42 33 22 / .08);
  --scrim:rgb(32 26 20 / .38);
  --sidebar:228px; --sidebar-rail:64px; --sidebar-current:var(--sidebar); --topbar:64px; --page-max:1240px;
  --ease:cubic-bezier(.2,.7,.2,1); --dur-1:.15s; --dur-2:.22s;
  color-scheme:light; font-family:var(--font-sans); font-size:14px; color:var(--ink); background:var(--canvas); font-synthesis:none;
}
@media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){
  color-scheme:dark; --canvas:#171512; --surface:#201d19; --surface-soft:#26221d; --surface-sunk:#2c2822;
  --ink:#ece6dc; --ink-2:#c2b9ab; --muted:#a39a8c; --faint:#857d71; --border:#353029; --border-strong:#4a443b;
  --accent:#e08a5c; --accent-strong:#eea47d; --accent-soft:#3a2a20; --accent-ring:#7a4a30; --on-accent:#171512;
  --ok:#6fbf8f; --ok-soft:#1f3328; --warn:#e0b060; --warn-soft:#3a2f1c; --danger:#ef8a80; --danger-soft:#3d2321; --info:#93a9f0; --info-soft:#232b42;
  --m-mail:#8fb0d6; --m-mail-bg:#1f2a36; --m-cal:#b6a3e0; --m-cal-bg:#2a2438; --m-task:#6fbf8f; --m-task-bg:#1f3328;
  --m-event:#e0b060; --m-event-bg:#3a2f1c; --m-idea:#e090ac; --m-idea-bg:#3a2129; --m-habit:#6cc4bf; --m-habit-bg:#1c3332;
  --shadow-card:0 1px 0 rgb(255 255 255 / .03),0 2px 10px rgb(0 0 0 / .25); --scrim:rgb(0 0 0 / .55);
}}
:root[data-theme="dark"]{
  color-scheme:dark; --canvas:#171512; --surface:#201d19; --surface-soft:#26221d; --surface-sunk:#2c2822;
  --ink:#ece6dc; --ink-2:#c2b9ab; --muted:#a39a8c; --faint:#857d71; --border:#353029; --border-strong:#4a443b;
  --accent:#e08a5c; --accent-strong:#eea47d; --accent-soft:#3a2a20; --accent-ring:#7a4a30; --on-accent:#171512;
  --ok:#6fbf8f; --ok-soft:#1f3328; --warn:#e0b060; --warn-soft:#3a2f1c; --danger:#ef8a80; --danger-soft:#3d2321; --info:#93a9f0; --info-soft:#232b42;
  --m-mail:#8fb0d6; --m-mail-bg:#1f2a36; --m-cal:#b6a3e0; --m-cal-bg:#2a2438; --m-task:#6fbf8f; --m-task-bg:#1f3328;
  --m-event:#e0b060; --m-event-bg:#3a2f1c; --m-idea:#e090ac; --m-idea-bg:#3a2129; --m-habit:#6cc4bf; --m-habit-bg:#1c3332;
  --shadow-card:0 1px 0 rgb(255 255 255 / .03),0 2px 10px rgb(0 0 0 / .25); --scrim:rgb(0 0 0 / .55);
}

/* ===== B2.1 additions — non-colour only, shared by light & dark ===== */
:root{
  --side-col:340px; --tap:44px; --quickbar-h:64px; --dur-3:.32s;
  --z-topbar:30; --z-scrim:39; --z-sidebar:40; --z-quickbar:45; --z-toast:60; --z-modal:80;
}
```

**Component-level colour decisions** (not tokens, but binding):
- **Kbd inside a primary button:** `background:var(--accent-strong); color:var(--on-accent); border-color:transparent`. This fixes the robust-lens 3.98:1 failure. Light #fff on #87421f is about 7.9:1; dark #171512 on #eea47d is about 9.9:1.
- **Kbd elsewhere:** `color:var(--ink-2)`, not `--muted`.
- **Toast:** `background:var(--ink); color:var(--canvas)`, which inverts automatically in dark mode. The error toast uses `--danger-soft` with `--ink` text and a `--danger` icon.
- **Skeleton:** `linear-gradient(100deg,var(--surface-sunk) 30%,var(--surface-soft) 50%,var(--surface-sunk) 70%)`. Skeletons often sit on `--canvas`, where the brief's soft/surface pair is invisible.
- **Cursor row:** `background:color-mix(in srgb,var(--accent-soft) 50%,var(--surface)); border-color:var(--accent-ring)`.
- **AI suggestion row:** `linear-gradient(115deg,var(--accent-soft),transparent 70%)`.
- **`--faint`** is for icons, borders and separator dots only, never for readable text. Section numbers, times and counts use `--muted` or `--ink-2`.
- **Never put `--muted` text on `--surface-sunk`.** Use `--ink-2` there.

**Type ramp in use:**

| Use | Spec |
|---|---|
| Today H1 | `--fs-hero` 30px / 1.45 / 500 (mobile 24px) |
| Page H1 (all other routes) | `--fs-2xl` 26px / 1.4 / 500 (mobile 22px) |
| Card title | 14px / 650 |
| Row title | 14px / 550 |
| Meta | 13px `--muted` |
| Hint and secondary | 12px |
| Mono eyebrow | 11px uppercase, `letter-spacing:1.4px` |
| Times and counts | IBM Plex Mono 12px |

Use weights 450, 500, 550, 600 and 650 only.

**CJK breaking:**
- Apply `.kp{word-break:keep-all;overflow-wrap:anywhere}` to every H1, brief, AI summary, empty-state text, notice text, toast text and the mobile row title.
- Everything gets `text-wrap:pretty; line-break:strict` (base).
- Write copy with half-width spaces around Latin and numbers (`OS HW3`, `23:59 截止`). Those spaces are the break opportunities.

---

## 3. Information architecture

### 3.1 Routes

The hash router is copied from CV. The brief's `#/projects/:id` becomes `#/work/projects/:id`; keep a redirect.

| Route | Nav label (icon) | Eyebrow | H1 (default) | Purpose |
|---|---|---|---|---|
| `#/today` (default; `#/` redirects) | 今天 (Sun) · count = open queue items | `MON · 10/12` | §4.2 | The daily page. Everything has a compact form here. |
| `#/inbox` and `#/inbox/:threadId` | 收件匣 (Inbox) · unread | `INBOX` | 先處理需要你回覆的。 | AI-triaged Gmail. |
| `#/calendar` and `?view=day\|week` | 行事曆 (CalendarDays) | `SCHEDULE` | 把今天安排得剛剛好。 | Agenda plus week grid, free slots, adding events. |
| `#/tasks` | 待辦 (ListTodo) · open count | `TASKS` | 一件一件來。 | Native todos. |
| `#/work` and `?tab=assignments\|projects\|github`; `#/work/projects/:id` | 作業與專案 (FolderKanban) · due ≤ 7 d + review requests | `TASKS & PROJECTS` | 作業、專案和 PR，都在這裡。 | LMS assignments, native projects, GitHub. |
| `#/events` | 活動 (Ticket) · new suggestions | `UPCOMING` | 值得去的，先標起來。 | CTFtime, RSS/Atom/iCal feeds, events found in mail. |
| `#/ideas` | 靈感 (Lightbulb) | `IDEAS` | 讓好靈感不再溜走。 | Capture and browse ideas. |
| `#/habits` | 習慣 (Flame) · remaining today | `HABITS` | 小習慣，天天累積。 | Habit history and editing. |
| `#/settings/:tab` (`sources` default, `brief`, `appearance`, `privacy`) | 連線與設定 (Settings), in the sidebar bottom | `CONNECTIONS` | 連線與設定 | Sources, AI, appearance, data. |
| `#/settings/sources/google` | — | `CONNECTIONS` | 連接 Google 帳號 | Step-by-step Google Cloud guide (§3.4). |
| `#/setup` | — (first run) | `WELCOME` | 先用起來，之後再連。 | Onboarding (§3.4). |
| `#/guide` | 使用指南 (HelpCircle), sidebar bottom, `?` key | `GUIDE` | 怎麼用最順手。 | Shortcuts, how AI works, privacy. |
| anything else | — | `404` | 找不到這一頁。 | One CTA: 回到今天. |

### 3.2 Global chrome

The chrome is the same on every route.
- **Sidebar** (§B4 order):
  1. brand
  2. `＋ 快速記下 N`
  3. `TODAY` label plus the 8 nav items above, each with an optional mono count (`.nav .n`)
  4. `PROJECTS` (up to 5, colour dot plus mono %)
  5. pushed to the bottom: streak card (`連續 12 天` bold title line, then body 「習慣正在長出來。」, then 看看本週 ↗), 連線與設定, 使用指南 `?`, profile row (`本機工作空間` with a status dot)
- **Topbar:**
  - Left: `[≡ mobile][⇤ desktop] {page}`.
  - Right: `快速前往 ⌘K` pill (Ctrl K off Apple), sync chip, theme toggle (light ↔ dark from what is shown; 跟隨系統 is set in 外觀), avatar.
  - The avatar is hidden at ≤720.
- **Sync chip states:**
  - `● 已同步 08:40`: ok dot, mono time
  - `◌ 同步中…`: 13px spinner
  - `⚠ N 個來源需要注意`: `.sync-chip.is-warn`
  - Click → `#/settings/sources`.
- **Counts** in nav, the quickbar badge and the H1 all come from `GET /api/today` `counts` (§12). Never compute them twice.
- **Quickbar** (≤720 only): 今天 · 收件匣 (badge = unread) · 待辦 · ＋捕捉. It is `position:fixed` at the bottom with safe-area padding.

### 3.3 Pages other than Today

These are layout contracts. Each page uses `.page` with a `.page-head`:
- `.page-head{display:flex;align-items:flex-end;gap:16px;margin-bottom:24px}`
- eyebrow, then the 26px H1, then a muted subline (`.page-sub`, 14px `--muted`)
- the page-level primary action on the right

Each page reuses the components in §9 and adds no new button, card, pill or row styles.

- **收件匣.** Chips: 需要回覆 · 帳單 · 學校 · 活動邀請 · 電子報 · 通知 · 其他 (mono counts; second click clears). The list uses `.q-row` grammar (person avatar or tile, title = subject, meta = `寄件者 · AI 一行摘要`, `.when` = received time).
  - ≥1180: two panes, list plus a reading pane.
  - Below 1180: the reading pane opens in place (`#/inbox/:threadId`).
  - The reading pane shows sender, subject, the AI summary (`.q-sum`), the **plain-text excerpt only** (never HTML, never remote images; superseded 2026-10-15 by `SPEC-mail-html.md`: 原始版面 in a sandboxed frame, remote images on request through the server), the action row (`.q-actions`: 回覆 ↵ · 轉待辦 T · 延後 S · 封存 E · 在 Gmail 開啟), and extracted suggestions (event/todo) as `.q-row.is-ai`.
  - Each category header offers 全部標為已讀 (deferred, undoable).
  - Empty: 「收件匣清空了。」 / 「新信會在同步後出現在這裡。」
- **行事曆.**
  - Segmented control 日 / 週. Day = agenda (`.agenda` grammar at full width, free slots shown). Week = 7-column grid at ≥980, otherwise agenda grouped by day.
  - 新增行程 opens the palette prefilled with `+`.
  - Sources: Google, local and feed events marked 要參加.
  - Empty day: 「今天沒有行程，留點時間給自己。」
- **待辦.**
  - Groups 逾期 · 今天 · 明天 · 本週 · 之後 · 沒有期限. Each row has an 18px checkbox, title, meta (`來源 · 期限`) and `.when`.
  - The top row is an inline add field with live parse (§6.6).
  - Completed today folds into 「今天完成 N 件 · 顯示」.
  - Empty: 「沒有待辦，享受一下。」 / 「按 N 隨時記下一件事。」
- **作業與專案.** Tabs:
  - 作業: by course, with status pills 未繳交 / 已交 (本機) / 已繳交 / 逾期. Source chips E3 · Canvas.
  - 專案: `ProjectRow` list. Detail page has milestones, linked repos and linked todos.
  - GitHub: 請你審查 · 我的 PR (checks, review state) · 指派給我 · 通知 (bulk 標為已讀).
  - 「標為已交」 is local and shows 「E3 還沒顯示繳交」 until the LMS agrees (§6.4).
- **活動.**
  - Filter chips 全部 · 要參加 · CTF · 社群 · 從信件找到.
  - `EventCard` list by date: date block, title, place, `還有 N 天`, plus 要參加 / 加入行事曆.
  - 「從信件找到」 items are suggestions (`.is-ai`, 加入行事曆 / 略過).
  - Header action: 管理訂閱 → `#/settings/sources`.
- **靈感.**
  - Full `Composer` at the top: tabs 靈感 · 待辦 · 筆記, autosize textarea, footer `已自動儲存` plus a primary button; drafts per tab are kept in localStorage.
  - List grouped by day, with tags as `#tag` in `--m-idea` and optional AI tag suggestions as dashed chips (confirm by tapping).
  - Search field.
- **習慣.**
  - Each habit row has a 5-week heat strip (dots 12px), streak, cadence and an edit menu.
  - 新增習慣 asks for name, cadence (每天 / 每週 N 次) and an optional short label (2–4 characters, used by the chips).
  - Optional automatic habit 「GitHub 有貢獻」 from the contribution calendar.
  - Empty: 「還沒有習慣，從一個小的開始吧。」
- **連線與設定.** Tabs 帳號與來源 · 每日摘要 · 外觀 · 資料與隱私, with the lead line 「憑證只保存在這台電腦，瀏覽器不會儲存任何密碼。」
  - **帳號與來源:** one `.source-card` per source (state 04): icon tile, name, one-line purpose, StatusPill (已連線 / 尚未授權 / 同步失敗 / 需要重新連線), `帳號 · 上次同步 08:12`, and actions (立即同步 / 重新連線 / 中斷連線). Sources: Google (Gmail and Calendar), NYCU E3 (Moodle), Canvas, GitHub (`gh`), CTFtime, 訂閱 (RSS/Atom/iCal list with add/remove), 天氣 (city search, on/off). No environment variable names anywhere in the UI.
  - **每日摘要:** 使用 AI (master switch), provider Claude Code / Codex, model, effort, auto time (06:30), 「也在每天第一次打開時產生」.
  - **外觀:** theme (跟隨系統 / 淺色 / 深色), 單鍵快捷鍵 (on/off, §6.2), 一週從星期一開始.
  - **資料與隱私:** mail retention (30 天), 清除快取的信件, 匯出資料.

### 3.4 Onboarding and connection guide

- **First run** (no source connected and no native data) redirects to `#/setup`. Today must still work at zero sources, so `#/setup` can always be skipped (略過，先用用看).
  1. **不用設定就能用:** toggles for 待辦/靈感/習慣 (always on), GitHub (detected `gh` login: 「已偵測到 GitHub 帳號 Suzu1Dev」), CTFtime, 天氣 (city default 台北, with 新竹 suggested as a chip).
  2. **連接學校:** Moodle base URL (prefilled `https://e3p.nycu.edu.tw`), 學號 and 密碼, with the line 「密碼只用一次換取權杖，不會儲存。」 Canvas URL plus token is an optional link. 稍後再說 is allowed.
  3. **連接 Google** (optional): a short explanation, then 開始設定 → the guide.
- **Google guide** (`#/settings/sources/google`):
  - A numbered checklist (`<ol>` with checkboxes the user ticks, persisted): 建立專案 · 啟用 Gmail 與 Calendar API · 設定同意畫面（外部、發布為正式版）· 建立網頁用戶端 · 複製重新導向網址 · 下載用戶端密碼.
  - The redirect URI is shown in a mono field with a 複製 button.
  - Fields: 用戶端 ID and 用戶端密碼 (masked after save), then 連接 Google.
  - Fallback disclosure: 「Google 不接受這個網址？」 opens the desktop-client paste flow, with a textarea 「貼上重新導向網址」.
  - Every step has one sentence of why. No env var names.

---

## 4. Today page (`#/today`)

### 4.1 Layout and order

| Width | Layout |
|---|---|
| ≥1081 | `.today-hero` grid `minmax(0,1fr) 340px`. Below it, `.today-grid` grid `minmax(0,1fr) 340px`, gap 24. **Main column:** queue → digest → later. **Side column:** capture → habits → agenda. Then `.endmark` across the full width. |
| 721–1080 | Hero in one column, with the progress block under the brief (max 560px). `.today-grid` becomes a flex column with `.col{display:contents}` and this order: **habit chips (1) → queue (2) → digest (3) → agenda (4) → capture (5) → later (6)**. |
| ≤720 | Same order as above, plus the mobile rules in §7. |

Desktop fold check at 1440×900: H1, brief, progress, next-up, the whole 最重要 group, the AI suggestion, the capture field, all habits and the first two agenda items are all above the fold. Keep it that way; it is a regression test (§13).

### 4.2 Hero (`.today-hero`)

- **Eyebrow:** `{WEEKDAY} · {M/D}`, then optional weather segments `.wx`:
  - city, temperature and condition, with a lucide icon in `--m-event`;
  - a rain segment only if the probability is ≥ 50% after now (`21:00 後降雨 60%`, rain icon in `--m-mail`).
  - Weather off or failed → segments omitted, with no error shown.
- **H1** (`.hero-title.kp`), rule-generated and never by AI:
  - open > 0: `{greeting}，還有 <uline>{N} 件事</uline> 等你處理。`
  - open = 0, handled > 0: `收工了，<uline>佇列清空了</uline>。`
  - open = 0, handled = 0: `{greeting}，今天沒有排定的事。`
  - Greeting by local time: 05:00–10:59 早安 · 11:00–16:59 午安 · 17:00–04:59 辛苦了.
  - `.uline` is accent colour, weight 550, with the hand-drawn SVG path `M2 8 Q125 -2 268 6` stroked in `--accent-ring` 3px. Underline only the count phrase.
- **Brief** (`.brief`): `.ai-tag` 「AI 摘要」 (title attribute 「AI 整理於 06:30」), then the text, then a 24px `.brief-refresh` icon button (hit area 44px on touch).
  - **AI brief contract:** at most 2 sentences and at most 80 CJK characters. Name the single most important item first, then the next time-bound thing, then optionally the largest free slot. It must not state numbers that contradict `counts`.
  - Generated at 06:30 (configurable). If missing, it is generated on the first open of the day. 重新整理 regenerates it (one job at a time; the button shows the spinner state).
  - **Loading** (state 05a): show the H1 at once; in place of the brief, show `.skel-status` 「正在整理今日摘要…」 plus two `.skel` lines (96% and 72%). Wait **up to 8 s**, then fall back to the rule brief.
  - **Rule brief** (state 05b): tag `.ai-tag.rule` 「規則整理」. Template, dropping any clause whose value is 0:
    `{n_reply} 封信待回覆，{n_due24} 項作業{今晚 HH:MM|明天 HH:MM}截止。第一個行程是 {HH:MM} {title}，{HH:MM} 後有 {H} 小時空檔。`
    If everything is 0: `沒有到期的作業，也沒有行程。下一個是 {date} {HH:MM} {title}。`
  - When AI failed rather than being off, add a `.fallback-note`: `⚠ AI 摘要暫時無法使用：{reason}。 重試 · 每日摘要設定`. Reasons: `Claude 尚未登入` · `Codex 尚未登入` · `產生逾時` · `回應格式不正確`. When AI is switched off in settings, show no note.
- **Progress** (`.progress-wrap`, right column):
  - `今日進度` with `{handled} / {total}` in mono 22px.
  - Segmented bar: one `<i>` per item, `--n` = total, `.on` = handled, `--ok` fill. Above 15 items, render a single continuous bar with the same height.
  - Foot: `已處理 {handled} 件` and, only when handled ≥ 3, `照這個節奏，約 {M} 分鐘 清空`. M = (time from the first to the last handled action today ÷ handled) × open, clamped 5–120 and rounded to 5.
  - ARIA: `role="progressbar"` on `.segs` with `aria-valuenow/max` and `aria-valuetext="已處理 3 件，共 11 件"`.
- **Next-up** (`.next-up`): `[calendar icon] {HH:MM mono} {title bold} {relative in --m-cal} ›`.
  - Shows the next event that has not started. Relative text: `N 分後` (<60 min), `N 小時 M 分後`, `明天 HH:MM`.
  - Links to `#/calendar`. Hidden when there are no further events today or tomorrow.

### 4.3 Focus queue (`.queue`)

**Item kinds and their primary action.** The primary action is the first action in the row and the `↵` default.

| kind | Source | Tile | Title | Meta (joined with ` · `) | `.when` | Primary (touch label) | Secondary (keys) |
|---|---|---|---|---|---|---|---|
| `mail.reply` | Gmail, triage `action=reply` or rule | `.person` serif initial | subject | sender · course/org · `待回覆` | received `HH:MM` / 昨天 / `M/D` | 回覆 ↵ (回覆) | 轉待辦 T · 延後 S · 封存 E · 在 Gmail 開啟 |
| `mail.bill` | Gmail `finance` | `t-warn` Receipt | `{payee} {month}帳單 NT${amount}` | `帳單 · {M/D} 截止 · {autopay note}` | `還有 N 天` | 轉成待辦 T (轉待辦) | 封存 E · 延後 S |
| `mail.action` | Gmail, other actionable | `t-mail` Mail | subject | sender · AI one-line | received | 標為已讀 E (已讀) | 轉待辦 T · 延後 S |
| `assignment` | Moodle / Canvas | `t-task` GraduationCap | `{course} {name}` | `NYCU E3 · {course} · {今晚/週三} HH:MM 截止 · 尚未繳交` | `剩 15 小時` | 開啟 E3 ↵ (desktop) / 已交 E (touch) | 標為已交 E · 延後 S |
| `review` | GitHub review-requested | `t-info` GitPullRequest | `審查 #{n} {title}` | `{repo} · {who} 請你審查 · +a −d` | 昨天 / `HH:MM` | 開始審查 ↵ (審查) | 標為已審查 E · 延後 S |
| `pr.changes` | my PR with changes requested | `t-info` GitPullRequest | `修改 #{n} {title}` | `{repo} · {who} 要求修改` | relative | 開啟 ↵ | 延後 S |
| `todo` | native | `t-task` ListTodo | title | `待辦 · {context} · 預估 N 分鐘` | due `HH:MM` | 完成 E (完成) | 延後 S · 開啟 ↵ |
| `suggestion.event` | AI extraction from mail | `t-accent` Sparkles | `從信件找到 1 個活動，要加入行事曆嗎？` | `{title} · {M/D（週）HH:MM} · {place} · 來自 {sender} {信件類型}` | — | 加入行事曆 C (always visible) | 略過 E |
| `suggestion.todo` | AI extraction | `t-accent` Sparkles | `從信件找到 1 件待辦，要加入嗎？` | `{title} · {due}` | — | 加入待辦 T | 略過 E |
| `event.decide` | CTFtime / feeds, matching interests | `t-event` Flag | `{name}，要參加嗎？` | `{source} · {M/D（週）HH:MM} 起 {duration} · {place} · {extra}` | `還有 N 天` | 要參加 C | 略過 E |

**Grouping.** Groups are rule-based and computed on the server in `shared/today.ts`. The AI may reorder items *within* a group and may set `mail.reply` priority, but it never moves an item across groups on its own.
- **最重要** (`now`). Any of:
  - overdue anything;
  - an assignment, bill or todo with a hard deadline within 24 h;
  - `mail.reply` with triage priority high, or (rule fallback) Gmail `IMPORTANT` and not automated (no `List-Unsubscribe`, not `noreply`);
  - a review request older than 24 h;
  - `pr.changes`.
- **今天內** (`today`):
  - a deadline within 48 h;
  - todos due today;
  - every `suggestion.*`;
  - `mail.bill` and `mail.action`;
  - review requests under 24 h old.
- **可以等** (`later`), hint 「待辦與作業：未來 7 天內」:
  - a deadline within 7 days;
  - `event.decide` (at most 2, nearest first);
  - todos due this week.
- **Not in the queue:**
  - newsletters, notifications and promos (they go to the digest);
  - anything due later than 7 days (it goes to `.later` or the module pages);
  - snoozed items until their wake time.

**Order within a group:** hard deadline ascending, then AI rank, then received descending, then start time ascending (only an event to decide on has one, so 可以等's two events read soonest first).

**Caps:**
- 最重要 and 今天內 show at most 5 rows each; 可以等 shows at most 3.
- Overflow becomes one `.q-more` row: 「還有 {N} 件 · 顯示全部」 (`btn-ghost btn-sm`), which expands in place.
- Titles are 1 line on desktop and clamped to 2 lines at ≤720. Meta is always 1 line.

**Header:**
- `.card-head`: target tile, 「專注佇列」, mono count.
- Source chips (`.chips`, right-aligned; on mobile its own row that scrolls horizontally with an 80% fade mask): 全部 · 信件 · 作業 · GitHub · 活動 · 待辦, each with a mono count.
- Chips are filters: a second click returns to 全部.
- A disconnected source shows as `.chip.is-error` (dashed, Unplug icon, no count, `title="Gmail 需要重新連線"`).

**Counts** (one store, server-computed, in `GET /api/today` `counts`):
- `open` = items currently in the queue (all groups, uncapped).
- `handled` = items closed today by any action, including 延後 and 略過 (a decision is a decision).
- `total` = open + handled.
- The H1 N, the nav 今天 badge, the progress meter and `.q-foot` all read these. Habits are **not** in `total`; they have their own counter (§4.8).

**Cursor and expansion:**
- Exactly one row is the cursor (`.is-focus`, `aria-current="true"`). It is **expanded in place**: AI one-line summary `.q-sum` with the sparkles icon, then `.q-actions` (primary as `btn-primary btn-sm`, others `btn-secondary`, archive `btn-ghost`; each with its kbd), and the external link `.link.ext` at the right.
- On load, the cursor is the first row of the first non-empty group.
- J/K, clicking a title or tapping a row moves the cursor; the previous row collapses.
- Esc collapses the cursor row and keeps the cursor.
- `suggestion.*` rows never expand. Their buttons are always visible.

**Hover (desktop, pointer:fine):**
- `.q-acts` (ghost buttons with kbd hints, max 3) appears **to the left of `.when`**. `.when` never hides; only a `.pill` would hide.
- The row gets `--surface-soft`.
- The same applies on `:focus-within` for keyboard users.

**Touch** (pointer:coarse, or any width ≤720):
- `.q-acts` never shows.
- `.q-primary` (`btn-secondary btn-sm`, icon plus a 2–3 character label, 36px visual, 44px hit area) sits under `.when` in the right column.
- Swipe (§7) offers the secondaries.

**After an action:**
- The row exits (§8), the cursor moves to the next row in DOM order (or the previous one if it was last), and DOM focus follows to that row's `.q-title`.
- `counts` update optimistically and the undo toast appears (§6.5).

**Footer** (`.q-foot`):
- `✓ 今天已處理 {handled} 件` plus 「顯示」, which expands today's handled items in place, each with 復原 while undo is still possible server-side (local actions only, within 24 h).

**Cleared state** (state 02):
- When open = 0 and handled > 0, the queue body is replaced by the solid `.empty-state` celebration: 54px `t-ok` check tile with five 7px confetti squares in module colours; 「今天的 {total} 件事都處理完了。」; `.e-stats` (回覆 · 完成 · 延後 · 行事曆 counts).
- **If habits remain**, add `.left-habits`: 「還差 {n} 個習慣」 plus one `.hchip` per remaining habit, each toggling in one tap.
- No 「比上週早了…」 copy unless that history exists. Confetti is static, so nothing animates under reduced motion.
- The H1 switches (§4.2) and the progress bar fills.

### 4.4 Digest strip (`.digest`)

- Non-actionable mail is never in the queue. Show the strip only when n > 0.
- **Content:** inbox tile; 「另外 {n} 封信已自動分類，不用處理」; a sub-line listing categories with mono counts (電子報 3 · 學校公告 2 · GitHub 通知 4), ending in 「信都還在你的 Gmail」.
- **Actions:**
  - `btn-secondary btn-sm` **全部標為已讀** (CheckCheck icon): one tap, deferred and undoable. Toast: 「已將 9 封標為已讀」 [復原].
  - `btn-ghost btn-sm` 「逐類看 ⌄」 expands one row per category with **one contextual action**:
    - 電子報 → 標為已讀
    - 學校公告 → 開啟 (in Gmail)
    - GitHub 通知 → 標為已讀 (GitHub `PATCH notifications/threads`)
    - 促銷 → 封存
    - 其他 → 開啟
- **Categorisation:** AI triage (`newsletter`, `school`, `notification`, `promo`, `other`). Rule fallback:
  - Gmail `CATEGORY_PROMOTIONS` → 促銷
  - `List-Unsubscribe` header → 電子報
  - `notifications@github.com` → GitHub 通知
  - sender domain in the school list (default `nycu.edu.tw`) → 學校公告
  - else → 其他

### 4.5 Later card (`.later`)

Two halves separated by a 1px divider. There is no tile in the heads, to keep this footer quiet.
- **明天與之後**, at most 3 `.ev-row`s: the first event tomorrow, then the next events or deadlines within 14 days that are **not in the queue**.
  - Date block `.dblock`: mono `M/D` plus `明天` or `週X`.
  - Title, then meta `地點 · 來源`.
  - Link 「活動 →」.
- **專案**, at most 3 `.pj-row`s:
  - active projects ordered by next milestone (name, mono %, 4px `.bar` in the project colour, `下一步：…`);
  - my PRs waiting more than 2 days (`repo #n`, label `PR`, meta `標題 · 等待審查 N 天`).
  - Link 「作業與專案 →」.
- **≤720:** collapsed to `.later-sum`: 「明天 09:00 計算機網路 · 本週還有 3 個活動 · 3 個專案進行中 ⌄」. Tapping it expands.
- **Desktop:** expanded by default. Collapse state persists in `bell-personal.today.collapsed-widgets`.
- **Empty half:** 「接下來兩週沒有活動。」 / 「還沒有專案。 新增專案」.

### 4.6 Capture card (`.capture`, first in the side column)

- `.cap-field`: Lightbulb icon in `--m-idea`, a 32px-tall input with placeholder 「記下任何事…」, and kbd `N`.
- `.cap-hint` (12px muted, sparkles in accent): **idle** text 「例如「明天 9:00 交報告」，Enter 自動分類」; while typing it becomes the **live parse preview** 「→ 待辦 · 明天 10/13（二）09:00 · Tab 換類型」 (§6.6). Right side: link 「靈感 →」.
- `.recent`: the 2 latest ideas, one line each (6px idea square, text ellipsis, muted relative date).
- **On submit:** clear the field, show the toast 「已加入待辦「交報告」· 明天 09:00」 [復原], and prepend the item to `.recent` if it is an idea.

### 4.7 Habits (`.habits`)

**Desktop (≥1081):**
- Card head: flame tile, 「習慣打卡」, mono `{done}/{n}`, and `.keys` 「按 1–3 打卡」 (hidden on touch).
- `.h-head` row with weekday initials (`二 三 四 五 六 日 一`; today in accent 650).
- Each `.habit` row:
  - 32px round `.hcheck` button (`aria-pressed`; done = `--m-habit` fill with an `--on-accent` check);
  - name (`.h-name`) and cadence (`.h-cad`: 「今天 07:50 完成」 / 「每週 3 次 · 0/3」 / 「每天 · 睡前」);
  - 7 dots `.h-dots`, 12px with a 5px gap:
    - `.y` = done, `--m-habit`
    - plain = missed, `--surface-sunk`
    - `.rest` = not required that day (weekly cadence), 1.5px `--border-strong` ring
    - `.t` = today, an accent ring outside; with `.y` it is fill plus ring
  - `.h-streak`: Flame plus a mono number; unit 天 for daily habits, 週 for weekly, given in `aria-label`.

**≤1080:** three one-tap chips with no card chrome.
- Each chip is a 44px pill: 22px check circle, `.h-short` (2–4 characters), streak.
- Done = `--m-habit-bg` fill. The whole chip is the hit area (`.hcheck::after{inset:0}`).
- More than 3 habits: show the first 3 by user order, plus a `+N` chip linking to `#/habits`.

**Other rules:**
- **Keys 1–9** toggle habits in order, on Today and `#/habits`.
- Toggling is optimistic. There is no toast for checking in; there *is* an undo toast for un-checking (「已取消「閱讀」的打卡」).
- **Event-linked:** if an agenda event matches a habit keyword (健身/重訓/跑步 → 運動), its meta reads 「結束後一鍵打卡「運動」」. After the event ends, that meta becomes a `btn-ghost btn-sm` 「打卡「運動」」.

### 4.8 Agenda (`.agenda`)

- Card head: calendar tile, 「今日行程」, mono count of events, link 「行事曆 →」.
- `.tl-now`: mono now time, an accent line with dot, and the label 「現在」. Placed before the first future item.
- `.tl-row`:
  - mono start/end;
  - a 3px bar in `--m-cal` (or `--m-habit` for habit-linked events);
  - title, plus `.soon` 「1 小時 28 分後」 for the next event only;
  - meta `地點 · 備註`.
- Past rows are `.is-past`: time and place `--muted`, title `--ink-2`, the bar at opacity .4 (text stays ≥ 4.5:1; element opacity is not used). More than 2 past rows fold into 「已結束 N 個 · 顯示」.
- `.is-due`: a hard deadline today (dashed `--danger` bar, time in danger).
- **Free slot** `.tl-gap`, at most 1 per day:
  - a gap of at least 90 min between now and 22:00, paired with the top queue item that has a deadline in 48 h;
  - `.gap-box` (dashed): sparkles, bold 「{H} 小時空檔」, muted 「適合寫 HW3」, `btn-secondary btn-sm` **排進**;
  - 排進 creates a calendar block for the gap, or for the item's estimate if shorter (Google if connected, else local), with an undo toast.
  - This is a suggestion only: no badge, no count, never in the queue.
- **Empty:** 「今天沒有行程，留點時間給自己。」 (one line, no dashed box inside this card).

### 4.9 End mark (`.endmark`)

7px accent square, then **「今天的版面到這裡。」** followed by 「下一份摘要明天 06:30 送到。」 (or 「AI 摘要已關閉。」). It always renders last, including in the empty and cleared states.

---

## 5. Widget states (every widget, no exceptions)

| Widget | Loading | Empty | Error | Stale | Disconnected / not set up |
|---|---|---|---|---|---|
| Hero brief | `.skel-status` plus 2 `.skel` lines, at most 8 s | — (rule brief always exists) | rule brief, `.ai-tag.rule`, plus `.fallback-note` with reason and 重試 | n/a (regenerated daily) | AI off → rule brief, no note |
| Hero H1 / progress | render from the cached `counts` immediately | H1 variants in §4.2 | keep the last counts. The page-level Notice says 「無法連線至本機服務，請確認 BELL Personal 正在執行。」 with 重試 | — | — |
| Queue | head plus 3 skeleton rows (30px tile block, 2 lines) | state 01: dashed `.empty-state` with Sunrise tile, 「今天沒有要處理的事。」 / 「信件、作業與活動會自動加入。」 / `btn-secondary` 「＋ 記下一件事 N」 | `.notice-error` at the top of the list: 「佇列暫時無法更新」 / 「顯示 08:12 的內容。」 [重試] | `.stale-note` under the head: 「顯示 08:12 的資料 · 重新整理」 when any source is older than 2× its interval | per source (state 03): `.chip.is-error`, plus a `.notice-warn` above the groups 「{Gmail} 需要重新連線」 / 「{reason}，新信件沒有列入佇列，所以「{N} 件」可能少算。上次同步 {time}。」 [重新連線]. One notice per broken source, max 2; beyond that: 「{n} 個來源需要注意」 [查看] |
| Digest | hidden until loaded | hidden | hidden (the queue notice covers Gmail) | sub-line suffix 「· 08:12 的分類」 | hidden |
| Later | 3 skeleton rows per half | per-half copy (§4.5) | 「暫時無法載入」 + 重試, per half | `.stale-note` per half (e.g. 「CTFtime 顯示 08:00 的資料 · 重新整理」) | omit that source's rows. If both halves would be empty: one line 「到 連線與設定 加入活動來源。」 |
| Capture | never loading (local first) | — | submit fails → error toast 「沒有記下來：無法連線至本機服務。草稿已保留。」 [重試], with the text kept in the field and in localStorage | — | — |
| Habits | 3 skeleton rows / 3 skeleton chips | dashed `.empty-state`: 「還沒有習慣，從一個小的開始吧。」 [新增習慣] (desktop). ≤1080: one chip 「＋ 新增習慣」 | toggle fails → revert, error toast 「打卡沒有存到，請再試一次。」 | — | — |
| Agenda | 4 skeleton rows | 「今天沒有行程，留點時間給自己。」 | state 04: `.notice-error` 「無法讀取 Google 行事曆」 / 「授權已過期。重新連線後會自動補上今天的行程。」 [重試], then the last data `.is-stale` (opacity .6) plus `.stale-note` | `.stale-note` 「顯示 昨天 22:10 的資料 · 重新整理」 | not set up: 「連接 Google 行事曆或加入 iCal 訂閱，行程就會出現在這裡。」 [連接] |
| Source card (settings) | — | — | pill `同步失敗` plus last error in one zh sentence, [立即同步] | — | pill `需要重新連線` (warn) plus [重新連線 Google] (primary) and [中斷連線] (ghost). `尚未授權` → [連接] |

Rules:
- A widget never blanks because a sibling failed.
- Error copy says **what failed and what to do**, never a stack trace or an env var.
- The topbar sync chip turns `.is-warn` whenever any source is in `需要重新連線` or `同步失敗`.

---

## 6. Interaction model

### 6.1 Entry, sync and focus

- **On load and on window focus**, `POST /api/sync` (202) for stale sources. Then poll `GET /api/today` using `usePoll` (60 s; skipped while hidden).
- **New items arriving while the user is working** never jump the list. If the cursor row is above the insertion point, insert silently. Otherwise show a 32px pill at the top of the queue, 「有 {n} 件新的 · 顯示」, and insert on click.
- **Focus on load:** the page `<main>`. The first J or ↓ moves into the queue cursor. The skip link 「跳至主要內容」 is the first Tab stop.

### 6.2 Keyboard

The global handler lives in `src/lib/keys.ts` (one listener, one guard).

**Guard:** ignore the event when **any** of these is true:
- `e.isComposing || e.keyCode === 229` (Bopomofo / IME);
- the target is `input`, `textarea` or `select`, or is `contentEditable`;
- a `<dialog open>` other than the palette is present;
- `e.altKey`;
- `e.metaKey`/`e.ctrlKey`, except for the explicit ⌘ combos below;
- the setting 單鍵快捷鍵 is off (single-key shortcuts only; ⌘K always works). This is the WCAG 2.1.4 compliance.

| Key | Scope | Action |
|---|---|---|
| ⌘K / Ctrl K | everywhere, including inputs (not while composing) | open the command palette |
| N | everywhere | Today ≥1081: focus `.cap-field input`. Elsewhere: open the palette in capture mode (`+` prefix) |
| ? | everywhere | open the shortcut help dialog (`#/guide#keys` content in a `<dialog>`) |
| G then T / I / C / D / W / E / L / H | everywhere, 1 s chord window | go to 今天 / 收件匣 / 行事曆 / 待辦 / 作業與專案 / 活動 / 靈感 / 習慣 |
| J / ↓, K / ↑ | Today queue, inbox list, tasks list | move the cursor (roving focus) |
| ↵ | list row | primary action (§4.3 table) |
| E | list row | close: 封存 / 標為已讀 / 完成 / 標為已交 / 標為已審查 / 略過, depending on kind |
| S | list row | open the snooze popover (§6.4) |
| T | list row | turn into a todo (mail, bill, suggestion.todo) |
| C | list row | 加入行事曆 / 要參加 (suggestion.event, event.decide, mail with a detected event) |
| Space | list row | expand / collapse without moving |
| Esc | — | close popover → close palette → collapse the cursor row, in that order |
| Z / ⌘Z | everywhere while an undo toast is visible | undo the newest undoable action |
| 1–9 | Today, 習慣 | toggle habit n for today |

The kbd hints shown in the UI must match this table. The `?` dialog is generated from one `shortcuts.ts` array.

### 6.3 Mouse

- Every primary action is one click.
- Row hover shows at most 3 labelled ghost buttons with kbd hints (§4.3).
- Clicking a row's title moves the cursor there and expands it. Clicking empty row space does the same. Clicking the expanded title collapses it.
- External links (`在 Gmail 開啟`, `開啟 E3`, `開始審查`) open in a new tab with `rel="noopener noreferrer"`.

### 6.4 Action semantics per source

Read this before wiring any button.

| Action | Effect | Remote write | Undo |
|---|---|---|---|
| 封存 (mail) | leaves queue and digest | Gmail `modify` remove `INBOX`, **deferred 6.5 s** | cancel before commit; after commit, re-add `INBOX` |
| 標為已讀 / 全部標為已讀 | leaves queue or digest | Gmail remove `UNREAD` (batchModify), deferred | same |
| 回覆 ↵ | opens the Gmail thread in a new tab; the row stays and is marked `回覆中…` | none | — (auto-closes as handled when the next sync sees a SENT message in the thread; also offers E) |
| 轉待辦 / 轉成待辦 | creates a native todo (title from AI or subject, due from extraction), then archives the source row from the queue (mail stays unread in Gmail) | local only | delete the todo (trash) and restore the row |
| 標為已交 (assignment) | local `dismissed_until_change`; leaves the queue | none (LMS is read-only) | local restore. In `#/work` the row shows `已交（本機）`, plus 「E3 還沒顯示繳交」 until the LMS reports submitted. If the LMS later changes the due date or the status reverts, it returns to the queue |
| 標為已審查 (review) | local dismiss until the GitHub state changes | none | local restore. Comes back if re-requested |
| 完成 (todo) | `done_at = now` | local | clear `done_at` |
| 延後 S | popover: **今晚 20:00 · 明天 08:00 · 週六 09:00 · 下週一 08:00 · 選擇時間…** (keys 1–5). Items with a hard deadline never snooze past deadline − 2 h; options beyond that are disabled with the hint 「會超過截止時間」 | local `snoozed_until` | clear it |
| 加入行事曆 C (suggestion) | confirms the suggestion and creates the event | Google `events.insert` (if connected and `calendar.events` was granted), deferred; else a local event | cancel before commit / delete the event after |
| 要參加 C (event.decide) | marks the event going; also adds it to Google if 「要參加時同時加入 Google 行事曆」 is on (default on) | as above | as above |
| 略過 E (suggestion / event) | dismisses that suggestion permanently for that source id | none | restore |
| 排進 (free slot) | creates a time block event titled with the item title | as for 加入行事曆 | as above |
| 打卡 (habit) | toggles today's log | local | toggle back |

### 6.5 Optimistic updates and undo

**Client:**
1. Apply the change to the local store (row exits, counts update).
2. `POST /api/actions {itemId, action, params}` → `{actionId, undoUntil}`.
3. Show the toast.

**Server:**
- **Local mutations** are applied at once, and the inverse is stored with `actionId`.
- **Remote writes** (Gmail, Calendar, GitHub) are queued with `commitAt = now + 6.5 s`. `DELETE /api/actions/:id` before `commitAt` cancels the write, so nothing reaches the remote. After `commitAt`, `DELETE` performs the inverse remote call.
- The server owns the timer, so closing the tab does not lose or duplicate the commit.

**Toast** (`ToastHost`, bottom centre at `left: calc(50% + var(--sidebar-current)/2)`; ≤720: above the quickbar):

| Toast | Duration | Role | Example |
|---|---|---|---|
| with 復原 | **6 s**, paused while hovered or focused or while the tab is hidden; a 2px `.timer` bar shrinks (full and still under reduced motion); shown with the optimistic edit, before the server answers | `status` | `[icon] 已封存「Re: OS 期末專題題目討論」 [↶ 復原 Z]` |
| plain success | 3.5 s | `status` | — |
| error | until closed | `alert` | `[alert] 封存失敗：Gmail 沒有回應，信還在收件匣。 [重試]` |

This resolves the brief's "action 10 s" in favour of the §B6 checkbox spec. Other toast rules:
- At most 3 toasts stack. A new undoable action replaces the previous undo toast; the previous action commits. A toast with the same message as a visible one replaces it; 「無法連線至本機服務」 errors close once the service answers again.
- Toast text wraps to 2 lines (`-webkit-line-clamp:2`), with `max-width: calc(100vw - 32px)`. It never clips 復原 at 320px.
- If a commit fails, the row reappears in its old position and the error toast is shown. Counts revert.
- Screen readers: the toast region is `aria-live="polite"`. After a row action, focus moves to the next row's title; it never moves into the toast. Z works anywhere outside a text field, and ⌘Z / Ctrl Z also from an empty one (the capture field right after ↵); the toast shows ⌘Z / Ctrl Z while a text field has focus or 單鍵快捷鍵 is off.

### 6.6 Quick capture (palette, field and sheet)

**Entry points:**
- **N:** the side field on Today ≥1081; otherwise the palette in capture mode.
- **Sidebar 「＋ 快速記下」:** the palette in capture mode.
- **⌘K:** palette. Typing text that matches no nav item well puts **快速新增** first.
- **Mobile ＋捕捉:** palette as a bottom sheet, input autofocused, `enterkeyhint="done"`.
- **Inline fields:** 待辦 page add-row and the 靈感 Composer.

**Pipeline** (identical everywhere, `shared/capture-parse.ts`, pure and synchronous):

1. **Rule parser.** Runs on every keystroke, with no network call. It recognises:
   - **Dates:** 今天 · 明天 · 後天 · 大後天 · (這|下)?週[一二三四五六日天] (also 周/星期/禮拜) · 下週 · `M/D` · `M月D日` · `YYYY-MM-DD` · 月底 · today/tomorrow/tonight · (next|this)? Friday. An English abbreviation alone counts only written Fri/Sat (title case, not before another capitalised word): SAT, WED, sat and the Sun of 「Sun Moon Lake」/「Sun Yat-sen」 stay in the title; an English weekday nobody leads into never overrides an earlier date.
   - **Deadline scaffolding** goes with its date or time and never stays in the title: 要在/得在/必須在/在/於 … · 最晚/最遲 … · … 前/之前/以前/為止 (+ 要) · 到 … 為止 · before/by/until/due … · on/at … · 週五「的」作業. 「X 前」 means due X (end of that day without a time). Not inside a word: 只要, 記得, 現在, 還在, 總會, 免得 keep their characters (「免得在明天遲到」 → 「免得遲到」); after 關於/對於/由於/至於… the date is the topic, so it stays in the title with its 的 (「寫關於週五的報告」 stays whole, due that day at **low** confidence; another date in the text wins).
   - **No hole:** the title is cut from the text as typed (「：」 stays full-width). A removed token between two Han characters or full-width punctuation leaves no gap (「報告週五前完成」 → 「報告完成」, 「簡報，要在週日前生出來」 → 「簡報，生出來」), anywhere else one space; doubled or dangling 「，」, brackets that only held the date (「報告（週五前）交」 → 「報告交」) and a 的 left at the end go too. The input marks highlight the scaffolding with its date (「要在周日前」).
   - **Times:** `H:MM` · `H點(半|N分)?` · 上午/早上/中午/下午/傍晚/晚上 + time (下午 = +12 for 1–11) · `HHMM`.
   - **Duration:** `N 小時` / `N 分(鐘)?` / `N-M` ranges (`14:00-15:30`).
   - **Type signals:**
     - event: 跟|和|與 … (meeting|開會|討論|見面|聚|吃飯|約), @地點, or a time range;
     - todo: a verb-first object (交|繳|寫|做|準備|讀|回|買|寄|改|整理|報名) or 截止/前/due;
     - idea: a leading 想到 / 靈感 / 點子 / `idea:` / `#靈感`, or more than 40 characters with no date.
   - **Tags:** `#tag`.

   **Output:** `{type, title, start?, end?, due?, allDay, tags[], spans[], confidence: "high"|"low"}`. `spans` are highlighted in the input (`mark`, `--m-cal-bg`/`--m-cal`).

   **Type decision:**
   - time plus event signal → **event** (default 1 h);
   - date/time plus todo verb, or a date/time with no event signal → **todo** with due;
   - no date/time → **idea** in a 靈感 context, else **todo** without due.

   `confidence = "high"` when every non-title token was consumed and the type was decided by a signal.

   **Golden examples** (unit tests in `shared/capture-parse.test.ts`, with now = 2026-10-12T08:42+08:00):

   | Input | Result |
   |---|---|
   | `明天 9:00 交報告` | todo「交報告」, due 2026-10-13T09:00+08:00, high |
   | `明天下午三點 跟教授 meeting` | event「跟教授 meeting」, 2026-10-13 15:00–16:00, high |
   | `週三前 回林教授信` | todo「回林教授信」, due 2026-10-14T23:59 (前 = end of that day), high |
   | `10/25 13:30 SITCON 秋季交流會 @中研院` | event, location 中研院, high |
   | `用 eBPF 量 CFS 排程延遲，當期末專題` | idea, high (no date, more than 40 chars or idea context) |
   | `下週找時間跟教授聊提案` | todo「跟教授聊提案」, due none, **low** → offer AI |
   | `Deep Hacking 簡報 要在周日前生出來，主題是 Windows Administrator Protection` (now Thu 2026-10-15) | todo「Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection」, due 2026-10-18T23:59, high; 自動整理 then makes it「Deep Hacking 簡報」 (§6.6.1) |
   | `Finish slides before Friday` | todo「Finish slides」, due Friday 23:59, high |

2. **AI parse** (optional):
   - Runs only if AI is on **and** (confidence is low or the user presses ⌘↵), after a 600 ms debounce. Job `capture.parse`, 8 s timeout, zero tools, JSON schema.
   - The result appears as a **second option** in the 「AI 解析 · 規則看不懂時」 section with `.ai-tag` 「AI 建議」 and the meta explaining its inference (「從「週三 meeting 前」推得」).
   - It is never auto-selected while a high-confidence rule result exists. If the AI result arrives after the user pressed Enter, it is discarded.

3. **Confirm.** ↵ commits the **active option** (rule by default). Tab cycles the type (待辦 → 行程 → 靈感) for the active option. The parse row shows the segmented type control and token chips (`10/13（二）09:00`); clicking a chip edits it in place.
   - Commit is optimistic, with a toast: 「已加入待辦「交報告」· 明天 09:00」 [復原] / 「已加入行程…」 / 「已記下靈感」.
   - Events go to Google Calendar when connected and 「新行程加到 Google 行事曆」 is on; otherwise they stay local.
   - One Enter creates exactly one item.

4. **Drafts.** The unsent text persists in `bell-personal.composer.draft` (try/catch) and is restored on reopen.

5. **自動整理 (tidy-up)**, see §6.6.1: after ↵ saved a todo or an event, AI rewrites its title and notes in the background, reversibly.

**Palette layout** (state 06): `.palette` (`width:min(760px,calc(100vw - 32px))`, radius 16, `--shadow-modal`, native `<dialog>`, `::backdrop{background:var(--scrim);backdrop-filter:blur(5px)}`), containing in order:
1. `.pal-q` input row with the search icon and `esc` kbd;
2. sections in order 快速新增 → AI 解析 → 前往 → 搜尋;
3. `.pal-opt` rows (tile, title, meta, right side with tag/kbd);
4. `.pal-opt.is-active` with accent-soft;
5. `.pal-foot` key legend: `↑↓ 選擇 · ↵ {建立待辦|建立行程|記下靈感|前往} · Tab 切換類型 · ⌘↵ 交給 AI · esc 關閉`.

The IME guard is copied from PR (`CommandPalette.tsx` L148 and L228–229). ↵ does nothing while composing.

### 6.6.1 自動整理 — tidy-up after a capture (addendum, 2026-10-15)

The owner asked for it after 「Deep Hacking 簡報 要在周日前生出來，主題是 Windows Administrator Protection」 was saved with a long title: *新增代辦或相關行程的時候也可以幫我自動整理*. It is the one place where model output changes a record without a tap, so it is bounded: it only rewrites the record the user just created (or asked to tidy), never creates, sends or archives anything, keeps what was typed, never moves a date, says so in a toast with 復原, and can be switched off.

**Flow** (palette, Today capture card, 待辦 add row, Composer's 待辦 tab, ＋捕捉 sheet — every surface that uses `useCaptureCommit`):

1. ↵ saves at once with the rule result (§6.6 step 3, unchanged): 「已加入待辦「Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection」· 10/18（日）」 [復原].
2. If the server started a tidy (`CaptureResponse.tidy`), the same toast gains a note with a spinner 「整理中…」 and the new row on #/tasks (and a local event on #/calendar) shows the pill 「整理中…」 (`.ai-tag.tidy-mark`). Typing is never blocked; the palette is already closed.
3. When the model answers and the answer passes the checks below, the record is rewritten: title 「Deep Hacking 簡報」, notes 「主題：Windows Administrator Protection」, due still 2026-10-18. Toast (undo kind, 6 s): **「已整理成「Deep Hacking 簡報」· 10/18（日）」 [↶ 復原 Z]** — the same when-part as the capture toast (今天/明天, 「· 明天 15:00」, 「· 10/25（日）13:30」). While the capture toast is still visible it takes that toast's place with a fresh 6 s. If the user has meanwhile done something else that has its own undo toast (another capture, 完成, 刪除), that toast keeps its 復原 and Z: the tidy's toast appears beside it as a *passive* undo toast — its own 復原 button works, Z / ⌘Z skip it and it shows no key hint. 復原 puts back the title, notes and place from before the tidy; everything else (重要, 完成, dates) stays.
4. If nothing changed (already tidy, unsure, refused, edited meanwhile) or the tidy failed (AI off, CLI signed out, timeout), the rule result simply stays: no toast, the note and the pill go away.

**When it runs:** setting **每日摘要 › 自動整理快速記下的內容** (`ai.captureTidy`, on by default) and 使用 AI on; only for todos and events (not 靈感), not for a confirmed 「AI 建議」 option, and only when the title is worth a call (more than 16 characters, or punctuation such as 「，」 joining two thoughts). 「明天 交報告」 never costs a model call.

**Manual 整理:** the #/tasks row editor has 「整理」 (wand icon, ghost button; it closes the editor so its fields cannot overwrite the result) and local events on #/calendar have a wand icon button next to 刪除. An editor the user opened before an automatic tidy lands takes the new title and notes into the fields they have not touched, and 儲存 sends only the fields they changed, so toggling 重要 never writes the long rule title back. They run the same job; they are offered only while AI 解析 is available, and only on text the owner typed: todos made by hand or by quick capture and local events from quick capture. Records made from mail, assignments, GitHub, feeds or AI suggestions never go to the model this way (409 「這一項來自信件或其他來源，不能用 AI 整理。」). A manual 整理 that changes nothing says why in a plain toast: 「已經很簡潔了，不需要整理。」, 「AI 看不太懂這一項，保留原本的內容。」, 「AI 的整理結果不夠可靠，保留原本的內容。」, 「整理期間內容改過了，保留你的修改。」, 「這個行程已在 Google 行事曆，請到 Google 行事曆修改。」; a failure: 「沒有整理：{reason}。」. A failed 復原: 「沒有復原整理：{reason}」.

**What the model returns** (strict schema, zero tools, zh-TW trust boundary; the user's own text is the data): `{title, notes[], dueDay|null, dueTime|null, location|null, confidence}`. Title: at most ~24 CJK / ~48 mixed characters, the user's own words, proper nouns and English as written, no dates or filler (要/記得), colloquial verbs (生出來, 弄好) may go. Notes: one detail per line (「主題：…」). The text it reads is what was typed (`originalText`); once the user rewrote the title by hand, it reads the current title and notes instead (the typed sentence is dropped then, and so is the 「原文」 line).

**Checks before anything is written** (`judgeTidy`):
- confidence `low` → unchanged;
- the title is not empty, at most 60 characters, keeps a key word of what was typed — a Latin word or two Han characters that name something, not filler, a label or a date word (「生出來」, 「主題是」, 「要在」 are refused) — and adds no word or Han character the text does not have (「Windows 更新」 is refused; a joining 的/與/和 is fine, 週 equals 周);
- every note says only what the text says: the value after its label (「主題：」) adds no word or character, and a date or time in it must be one the text names (「截止：10/25」 is refused);
- a `dueDay`/`dueTime` must equal the rule parse of the typed text (read on the day it was written) or the saved record — otherwise the whole answer is refused; the tidy never moves a saved date or time;
- a place is added only to an event without one, and only when it appears in the text;
- secrets in the answer are refused by the model layer;
- the record must be exactly as it was when the tidy started (title, notes, dates, status…): an edit, 完成 or 刪除 meanwhile wins (an edit from #/tasks also cancels the job at once);
- nothing different (same title, no new notes, no place) → unchanged.

**Events and Google Calendar:** a captured event's Google insert normally waits 6.5 s (§6.5). While its tidy runs that insert is postponed (at most 2 minutes), then gets a fresh 6.5 s window, so Google receives the tidied event once and 復原 inside the window sends the restored one. An event already in Google Calendar, or whose insert is on its way, is not tidied or restored — there is no Google update path, the same rule as 刪除 on #/calendar — so BELL and Google never show different titles; 整理 is not offered on its row (409 「這個行程已在 Google 行事曆，請到 Google 行事曆修改。」). The details moved out of an event's title go first in its notes (before 「來自 快速記下」), so the agenda row's meta line shows them: 「工程三館 · 記得帶筆電」.

**Concurrency:** one tidy per record (a second 整理 joins the running one); for the agent slot a tidy waits behind an AI 解析 the user is watching and goes ahead of queued background work such as mail triage (`priority: "soon"`), and gets 60 s once its CLI runs; at most four run at once (a fifth capture just keeps its rule result). When the last status probe found the selected CLI signed out, a capture starts no tidy and shows no 「整理中…」 (the save never waits for a probe).

**Row states:** on #/tasks the pill sits at the row's end; on #/calendar 「整理中…」 takes the actions slot (where the wand is), so the row keeps its height and the rows below do not move.

**Kept and reversible later:** `originalText` (what was typed, when the title is not all of it), `tidiedAt` and `pretidy` (the title, notes and place the tidy replaced) on the record. The #/tasks editor shows 「原文：…」 and a ghost button **「↶ 復原整理」**; a tidied local event on #/calendar shows an ↶ icon button in the wand's place (aria 「復原「{title}」的整理」). Both put `pretidy` back any time later (toast 「已復原成「{title}」」), until the user edits the title or notes (then there is nothing to restore without overwriting the edit) or the event reaches Google Calendar. The toast's 復原 works for an hour after the tidy while the fields still read as the tidy wrote them (in memory: not after a restart). The setting's hint says so: 「新增待辦或行程後，AI 在背景把標題整理得簡潔、細節移到備註，日期不變；待辦和本機行程之後都能按「復原整理」改回來。」

---

## 7. Mobile and touch (≤720 unless stated)

- **Shell.**
  - The sidebar becomes a 280px drawer with `--scrim` (tap the scrim or Esc to close; focus is trapped; the opener is ≡ in the topbar).
  - Topbar 56px: ≡, a 26px brand tile, the page name, search icon (opens the palette), the sync chip as a dot plus mono time, the theme toggle.
- **Quickbar.**
  - `position:fixed` at **every** ≤720 width, not only touch.
  - Height `calc(64px + env(safe-area-inset-bottom))`, glass background.
  - The page gets `padding-bottom: calc(64px + 32px + env(safe-area-inset-bottom))`.
  - ＋捕捉 is the accent pill.
  - The 收件匣 badge is the unread count (mono 12px).
- **Today order:** hero (24px H1; the AI tag sits on its own line above the brief) → progress card (bordered surface, includes next-up) → **habit chips** → queue → digest → agenda → capture → later (collapsed) → end mark.
- **Queue rows:**
  - title 2-line clamp with `.kp`; meta 1 line;
  - the right column stacks `.when` above `.q-primary` (36px visual, 44px hit);
  - pills hidden;
  - the cursor row's `.q-actions` become a 4-column grid of 44px buttons with no kbd;
  - `在 Gmail 開啟` sits right-aligned below.
- **Swipe** on a queue row (pointer:coarse only), with a visible button fallback always present:
  - **right** = the E action of that kind (green `--ok` reveal, label 「封存」/「完成」/「已交」…);
  - **left** = snooze, which opens the snooze bottom sheet (`--warn` reveal);
  - threshold 35% of row width, or a velocity flick;
  - rubber-band below the threshold; haptic `navigator.vibrate(8)` where available;
  - swipeable rows set `touch-action: pan-y pinch-zoom`, or the browser claims the drag as a pan and cancels it.
- **Touch targets:** every interactive element is ≥ 44×44 via padding or a centred `::after` at least `--tap` tall (`.link`: 8px wider each side). This covers `.brief-refresh`, `.link`, the habit chips and `.chip` (min-height 44 on coarse).
- **Toasts** sit above the quickbar (`bottom: calc(64px + 12px + safe-area)`) and wrap to 2 lines.
- **No hover-only affordances.** Everything reachable by hover on desktop is reachable by a visible control or a swipe with a fallback.
- **320px reflow:** no horizontal scroll at 320. Verified for both reference files. The chip row scrolls horizontally inside its container with a fade mask, and each chip is keyboard focusable.

---

## 8. Motion

All motion uses `--ease cubic-bezier(.2,.7,.2,1)`. The brief's `prefers-reduced-motion` block (CV) is mandatory and turns everything below into instant changes.

| What | Duration | How |
|---|---|---|
| Hover / pressed colour | `--dur-1` .15s | background, border, colour |
| Row expand / collapse (cursor move) | `--dur-2` .22s | `grid-template-rows: 0fr → 1fr` on `.q-detail`, plus opacity |
| Row exit after an action | `--dur-2` .22s, then the height collapses over .18s | translateX(12px) + opacity 0, then height → 0; the next row slides up |
| Row re-insert on undo | `--dur-2` | height 0 → auto, a 1 s `--accent-soft` background flash |
| Drawer | `--dur-2` | translateX(-102%) → 0; scrim opacity |
| Toast enter / exit | `--dur-3` .32s / .15s | translateY(8px) + opacity |
| Habit check | .15s | `.hcheck` scale .92 → 1, fill colour |
| Progress segment fill | `--dur-3` | background colour, staggered 30 ms per newly filled segment |
| Palette / dialog | .18s | scale .98 → 1 + opacity; backdrop fade |
| Skeleton shimmer | 1.4s linear infinite | gradient position |
| Celebration | none | static confetti (no animation by design) |

There is no parallax, no bouncing and no scroll-triggered animation. Never animate layout on poll refresh.

---

## 9. Component inventory (class names are binding)

Each component lives in `src/components/<Name>.tsx` + `<Name>.css`, with Today-specific ones in `src/today/`. All styling comes from `final/src/app.css` (and `states.css` where noted); port the rules verbatim into the matching file.

| Component | File | Root class / parts | Notes |
|---|---|---|---|
| AppShell | components/AppShell | `.app-shell` › `aside.sidebar#primary-sidebar` › `.side-inner` + `.scrim` + `.workspace` › `header.topbar` + `main#main.page`; `.skip` | `--sidebar-current` set per breakpoint |
| Sidebar | components/Sidebar | `.brand` `.brand-tile` `.wordmark>b,i` · `.cta` · `.side-label` · `.nav a[aria-current] .ico .n` · `.side-proj .proj .dot .pct` · `.side-bottom .streak-card .profile .okdot` | rail at 721–980: labels clipped with `clip-path:inset(50%)`, `title=` on every item |
| Topbar | components/Topbar | `.crumbs .ws b` · `.top-actions` · `.kpill` · `.sync-chip(.is-warn) .okdot .lbl .mono` · theme toggle `[data-theme-toggle] .tg-moon .tg-sun` · `.avatar` | `.m-only` / `.d-only` helpers |
| QuickBar | components/QuickBar | `nav.quickbar a[aria-current] .badge .cap .plus` | fixed at ≤720 |
| Button | components/Button | `.btn` + `.btn-primary/-secondary/-ghost/-danger/-icon` + `.btn-sm`; `kbd` child | min-height 36 (sm 32), 44 on coarse |
| Link | components/Link | `.link(.accent)`, `.link.ext` | 12px, arrow / arrow-up-right icon |
| Kbd | base.css | `kbd` | 11px mono, the only other sub-12 text |
| Card | components/Card | `.card` › `.card-head` (`.tile.t-*`, `h2`, `.count`, `.link`) | modifiers below |
| Tile | components/Tile | `.tile.t-mail/-cal/-task/-event/-idea/-habit/-accent/-info/-warn/-danger/-ok` | 28px (30 in rows, 36 in source cards, 54 `.tile54` in empty states) |
| StatusPill | components/Pill | `.pill(.dot) .p-danger/-warn/-ok/-info/-accent` | 2–4 character labels |
| Chip | components/Chip | `.chips` › `.chip[aria-pressed] .mono`, `.chip.is-error` | second click clears |
| Notice | components/Notice | `.notice.notice-warn/-error/-ok` › icon, `div>b+p`, `.n-acts` | wraps under the text at ≤720 |
| EmptyState | components/EmptyState | `.empty-state(.solid)` › `.tile54`, `h3`, `p`, one `.btn` | dashed by default |
| Skeleton | components/Skeleton | `.skel` (block), `.skel-status` + `.spin` | — |
| StaleNote | components/StaleNote | `.stale-note` › clock icon, text, `button` | — |
| ToastHost / Toast | components/Toast | `.toast-host` › `.toast(.toast-error)` › icon, `span`, `button`, `.timer` | §6.5 |
| Dialog | components/Dialog | native `<dialog>` | `--r-lg`, `--shadow-modal`, close button 「關閉視窗」 |
| CommandPalette | components/CommandPalette | `.palette` › `.pal-q (mark, .caret)` · `.pal-body` › `.pal-sec` · `.pal-opt(.is-active)` › `.tile .t .m .r` · `.parse-row` › `.seg button[aria-pressed]` `.tokchip` · `.pal-foot` | CSS in `states.css` |
| SourceCard | settings/SourceCard | `.source-card` › `.tile`, `h3`, `p`, `.meta`, `.pill`, `.acts` | CSS in `states.css` |
| TodayHero | today/TodayHero | `.today-hero` › `.eyebrow .sep .wx .rain` · `h1.hero-title.kp .uline svg` · `.brief .ai-tag(.rule) .brief-refresh` · `.fallback-note` | — |
| Progress | today/Progress | `.progress-wrap` › `.progress .prog-top .segs[role=progressbar] i.on .prog-foot` · `a.next-up .mono b .in .chev` | `--n` = total |
| FocusQueue | today/FocusQueue | `.card.queue` › `.q-head` (`.card-head` + `.chips`) · `section.q-group` › `.q-ghead h3 .count .hint` · `ul.q-list` › `li.q-row(.is-focus/.is-ai/.is-hover/.is-done)` › `.tile`/`.person` · `.q-main .q-title .q-meta (.hot .add .del)` · `.q-end .q-acts .when(.zh .hot .warm) .q-primary` · `.q-detail .q-sum .q-actions .ext` · `.q-more` · `.q-foot .done` | `.is-hover` is mockup-only; real hover uses `:hover` |
| Celebration | today/Celebration | `.empty-state.solid` › `.e-art i` + `.tile54.t-ok` · `.e-stats` · `.left-habits .hchip` | CSS in `states.css` |
| DigestStrip | today/DigestStrip | `.card.digest` › `.tile.t-mail .txt b span .mono .acts` | — |
| LaterCard | today/LaterCard | `.card.later` › `.later-sum` · `section` › `.card-head` · `.ev-row .dblock b span .t .m` · `.pj-row .pj-top .pct .bar i` | — |
| CaptureCard | today/CaptureCard | `.card.capture` › `label.cap-field` (icon, `input`, kbd) · `.cap-hint` · `.recent .idea span small` | — |
| HabitsCard | today/HabitsCard (shared with `#/habits` rows) | `.card.habits` › `.habit-list` › `.habit.h-head .h-days .today` · `.habit(.is-done)` › `button.hcheck[aria-pressed]` · `.h-name .h-short .h-cad` · `.h-dots i(.y .rest .t)` · `.h-streak` | chip mode ≤1080 |
| AgendaCard | today/AgendaCard (shared with `#/calendar` day view) | `.card.agenda` › `.tl` › `.tl-now` · `.tl-row(.is-due .is-past .tl-gap)` › `.tl-time small` `.tl-bar` `.tl-body b .soon span` · `.gap-box b span .btn` | — |
| EndMark | today/EndMark | `footer.endmark i p b` | — |

**Not in the mockup but required.** Use exactly these names, built from the same tokens:
- `.page-head`, `.page-sub` (route heads)
- `.seg` (segmented control, reused from the palette)
- `.checkbox` (18px, `--r-xs`, 2px `--border-strong`; checked = accent fill plus Check)
- `.event-card` (date block `.dblock` at 48px)
- `.project-row`
- `.mail-reader`
- `.snooze-pop` (popover: `--surface`, `--shadow-pop`, `--r-md`, options as `.pal-opt`-style rows with kbd 1–5)
- `.sync-pills` (bottom-right job pills, EX pattern)

**Global helpers:** `.kp`, `.mono`, `.sr-only`, `.ico(.ico-sm .ico-xs)`, `.m-only`, `.d-only`.

---

## 10. Copy deck (zh-TW)

**Fixed strings.** Use these verbatim; put them in `src/copy.ts` so the six pages share one source.

**Meta and identity**
- `<title>`: `BELL Personal · 你的每日工作台` · wordmark `bell/personal.`
- Skip link: `跳至主要內容` · drawer: `開啟選單` / `關閉選單` · rail toggle: `收合側欄` / `展開側欄` · theme: `切換深色模式` / `切換淺色模式`

**Sidebar and topbar**
- `快速記下` · `TODAY` · `PROJECTS` · `連線與設定` · `使用指南` · `本機工作空間` · `快速前往`
- Streak card: `連續 {n} 天` / `習慣正在長出來。` / `看看本週 ↗` (0 days: `今天開始第一天。`)
- Sync chip: `已同步 {HH:MM}` · `同步中…` · `{n} 個來源需要注意`

**Today**
- Eyebrow: `{MON} · {M/D}` · weather `{城市} {t}° {天氣}` · `{HH:MM} 後降雨 {p}%`
- H1: `{早安|午安|辛苦了}，還有 {N} 件事 等你處理。` · `收工了，佇列清空了。` · `{greeting}，今天沒有排定的事。`
- Brief tags: `AI 摘要` · `規則整理` · refresh `重新整理摘要` · loading `正在整理今日摘要…` · fallback `AI 摘要暫時無法使用：{reason}。` `重試` `每日摘要設定`
- Progress: `今日進度` · `已處理 {n} 件` · `照這個節奏，約 {m} 分鐘 清空`
- Next-up: `{HH:MM} {title} {N 分後|N 小時 M 分後}`
- Queue: `專注佇列` · groups `最重要` · `今天內` · `可以等` / `待辦與作業：未來 7 天內` · chips `全部 · 信件 · 作業 · GitHub · 活動 · 待辦` · `還有 {n} 件 · 顯示全部` · `今天已處理 {n} 件` `顯示` · new items `有 {n} 件新的 · 顯示`
- Suggestions: `從信件找到 1 個活動，要加入行事曆嗎？` · `從信件找到 1 件待辦，要加入嗎？` · `{name}，要參加嗎？` · meta source `來自 {sender} {報名成功信|邀請信}`
- Digest: `另外 {n} 封信已自動分類，不用處理` · `信都還在你的 Gmail` · `全部標為已讀` · `逐類看`
- Later: `明天與之後` · `專案` · `下一步：{milestone}` · `等待審查 {n} 天` · summary `明天 {HH:MM} {title} · 本週還有 {n} 個活動 · {m} 個專案進行中`
- Capture: placeholder `記下任何事…` · hint `例如「明天 9:00 交報告」，Enter 自動分類` · preview `→ {待辦|行程|靈感} · {when} · Tab 換類型`
- Habits: `習慣打卡` · `按 1–3 打卡` · `今天 {HH:MM} 完成` · `每週 {n} 次 · {d}/{n}` · `還差 {n} 個習慣` · `結束後一鍵打卡「{habit}」` · `打卡「{habit}」`
- Agenda: `今日行程` · `現在` · `{H} 小時空檔` · `適合寫 {item}` · `排進` · `已結束 {n} 個 · 顯示`
- End mark: `今天的版面到這裡。` + `下一份摘要明天 06:30 送到。`

**Buttons.** Verb first, at most 5 characters on touch.
- `回覆` · `轉待辦` / `轉成待辦` · `延後` · `封存` · `標為已讀` · `標為已交` (touch `已交`) · `開始審查` (touch `審查`) · `標為已審查` · `完成` · `開啟 E3` / `開啟` · `在 Gmail 開啟` · `在 GitHub 開啟` · `加入行事曆` · `要參加` · `略過` · `排進` · `重新連線` · `重新連線 Google` · `中斷連線` · `立即同步` · `重試` · `重新整理` · `記下一件事` · `新增習慣` · `新增專案` · `復原`
- Snooze: `今晚 20:00` · `明天 08:00` · `週六 09:00` · `下週一 08:00` · `選擇時間…` · disabled `會超過截止時間`

**Toasts**
- `已封存「{subject}」` · `已將 {n} 封標為已讀` · `已完成「{title}」` · `已標為已交「{title}」` · `已延後到{明天 08:00}` · `已加入行事曆「{title}」· {when}` · `已加入待辦「{title}」· {when}` · `已記下靈感` · `已整理成「{title}」· {when}` (自動整理, §6.6.1; note while it runs: `整理中…`) · `已復原成「{title}」` (復原整理) · `已取消「{habit}」的打卡`
- Errors: `封存失敗：Gmail 沒有回應，信還在收件匣。` · `沒有加到行事曆：Google 行事曆需要重新連線。` · `打卡沒有存到，請再試一次。` · `沒有記下來：無法連線至本機服務。草稿已保留。`

**Empty states** (title / hint / CTA)
- Today queue: `今天沒有要處理的事。` / `信件、作業與活動會自動加入。` / `記下一件事`
- Cleared: `今天的 {n} 件事都處理完了。`
- Inbox: `收件匣清空了。` / `新信會在同步後出現在這裡。`
- Calendar: `今天沒有行程，留點時間給自己。`
- Tasks: `沒有待辦，享受一下。` / `按 N 隨時記下一件事。`
- Work · 作業: `這週沒有要交的作業。` / `連接 E3 或 Canvas 後，作業會自動出現。` / `連接學校系統`
- Work · GitHub: `沒有等你審查的 PR。`
- Events: `接下來兩週沒有活動。` / `加入 CTFtime 或 KKTIX 訂閱，好活動不會錯過。` / `管理訂閱`
- Ideas: `還沒有靈感，先寫下第一個。` / `任何頁面按 N 都能記。`
- Habits: `還沒有習慣，從一個小的開始吧。` / `新增習慣`
- 404: `找不到這一頁。` / `回到今天`

**Errors and notices** (what failed + what to do)
- `無法連線至本機服務，請確認 BELL Personal 正在執行。`
- `{Gmail} 需要重新連線` / `Google 撤銷了授權，新信件沒有列入佇列，所以「{N} 件」可能少算。上次同步 {time}。`
- `無法讀取 Google 行事曆` / `授權已過期。重新連線後會自動補上今天的行程。`
- `E3 登入已失效` / `重新登入後會自動同步作業。`
- `CTFtime 暫時沒有回應` / `顯示 {HH:MM} 的資料。`
- Stale: `顯示 {time} 的資料 · 重新整理`
- AI reasons: `Claude 尚未登入` · `Codex 尚未登入` · `產生逾時` · `回應格式不正確`

**Time phrasing for `.when` and meta**

| Situation | Phrase | Style |
|---|---|---|
| Deadline under 1 h | `剩 {m} 分鐘` | hot |
| Deadline under 24 h | `剩 {h} 小時` | hot |
| Deadline tomorrow | `明天到期` | — |
| Deadline 2–7 days | `還有 {d} 天` | muted |
| Overdue | `逾期 {d} 天` / `逾期 {h} 小時` | hot |
| Event or todo time today | `HH:MM` mono | warm if within 6 h |
| Event or todo tomorrow | `明天 HH:MM` | — |
| Mail received | `HH:MM` today · `昨天` · `M/D` | — |
| Meta deadline | `今晚 23:59 截止` · `週三 23:59 截止` · `10/20 截止` | — |

Dates in meta use `M/D（週）`, for example `10/25（六）`. All dates go through `Intl.DateTimeFormat("zh-TW", {timeZone: "Asia/Taipei"})`.

---

## 11. Accessibility (binding)

- **Landmarks:** the sidebar is `aside` with `aria-label="主要導覽"`, nav `aria-label="模組"`, the topbar `header`, the page `main#main`, the quickbar `nav aria-label="快速列"`.
- **Queue semantics:**
  - each group is `<section aria-labelledby>` with an `<h3>`, then `<ul>` of `<li class="q-row">`;
  - the cursor is a **roving tabindex on `.q-title` buttons** (`tabindex="0"` on the cursor, `-1` on the others);
  - `aria-expanded` on the title reflects expansion;
  - the cursor `li` has `aria-current="true"`.
  - Do **not** nest `role=group` / `role=listitem` (the invalid structure from B).
  - J/K move DOM focus to the next or previous title.
  - Action buttons are native buttons inside the row (Tab reaches them while expanded).
- **Progress:** `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext` and `aria-labelledby`.
- **Habits:** `button.hcheck[aria-pressed]` with `aria-label="{name}，今天{已完成|尚未完成}。按 {n} 切換"`. Streaks carry `aria-label="連續 12 天"`. Dots are `aria-hidden`.
- **Labels:** icon-only buttons have zh `aria-label`. All icons are `aria-hidden="true"`. Counts in nav carry an `aria-label` with their unit.
- **Contrast:**
  - text ≥ 4.5:1 in both themes (the pairs are measured in brief §B2);
  - kbd in primary buttons uses `--accent-strong`;
  - `--faint` is never text;
  - `--muted` never sits on `--surface-sunk`.
- **Targets:** ≥ 24px everywhere (WCAG 2.5.8) and ≥ 44px on coarse pointers (§7).
- **Focus:** `outline:3px solid var(--accent); outline-offset:3px` on every focusable element (≥ 3:1 against the card and the cursor row in both themes, and distinct from the cursor row's `--accent-ring` border). Focus is never lost after an action (§4.3).
- **Reflow:** usable at 320px with no horizontal scroll. Text spacing overrides must not clip (no fixed heights on text containers).
- **Live regions:** the toast host is `role="status" aria-live="polite"`; error toasts are `role="alert"`. Source-failure notices in the queue use `role="alert"` once per session.
- **Shortcuts:** single-key shortcuts can be disabled (§6.2), and the `?` dialog lists them all.

---

## 12. UI data contract for Today

This contract is agreed so Today, the inbox and the server can be built in parallel. The server lead may rename fields, but must keep the semantics.

```ts
// shared/today.ts
export const QUEUE_GROUPS = ["now", "today", "later"] as const;            // 最重要 / 今天內 / 可以等
export const QUEUE_KINDS = ["mail.reply","mail.bill","mail.action","assignment","review","pr.changes",
  "todo","suggestion.event","suggestion.todo","event.decide"] as const;
export type ActionId = "reply"|"open"|"archive"|"read"|"todo"|"snooze"|"done"|"submitted"|"reviewed"|"calendar"|"going"|"dismiss"|"schedule";
export interface QueueItem {
  id: string;                       // `${source}:${sourceId}`
  kind: (typeof QUEUE_KINDS)[number];
  group: (typeof QUEUE_GROUPS)[number];
  source: "gmail"|"moodle"|"canvas"|"github"|"native"|"ctftime"|"feed"|"ai";
  title: string; meta: string[];    // UI joins meta with " · "
  avatar?: { initial: string } ;    // mail.reply from a person
  when?: { label: string; tone: "hot"|"warm"|"muted"; mono: boolean };
  summary?: string; summarySource?: "ai"|"rule";
  actions: { id: ActionId; label: string; touchLabel: string; key?: "Enter"|"E"|"S"|"T"|"C" }[]; // [0] = primary
  url?: string;                     // external open target
  snoozeLimit?: string;             // ISO; latest allowed snooze
}
export interface TodayPayload {
  date: string; now: string; greeting: "早安"|"午安"|"辛苦了";
  weather?: { city: string; tempC: number; text: string; rain?: { from: string; pct: number } };
  brief: { state: "ready"|"generating"|"fallback"|"off"; text: string; source: "ai"|"rule"; generatedAt?: string; reason?: string };
  counts: { open: number; handled: number; total: number; handledBy: { reply: number; done: number; snooze: number; calendar: number }; inboxUnread: number; habitsLeft: number };
  paceMinutes?: number;             // only when handled >= 3
  nextUp?: { start: string; title: string };
  queue: { group: QueueItem["group"]; items: QueueItem[]; hidden: number }[];
  digest?: { total: number; categories: { key: string; label: string; count: number; action: ActionId }[] };
  agenda: { items: { start: string; end?: string; title: string; meta: string; kind: "event"|"due"; habitLink?: string; past: boolean }[]; gap?: { start: string; hours: number; forItemId: string; label: string } };
  habits: { id: string; name: string; short: string; cadence: string; doneToday: boolean; week: ("y"|"n"|"rest")[]; streak: number; streakUnit: "天"|"週" }[];
  ideas: { id: string; text: string; at: string }[];               // latest 2
  later: { events: { date: string; label: string; title: string; meta: string }[]; projects: { name: string; pct?: number; next: string; color?: string; pr?: boolean }[] };
  sources: { id: string; label: string; state: "ok"|"syncing"|"stale"|"error"|"reconnect"|"off"; lastSyncedAt?: string; message?: string }[];
}
// POST /api/actions { itemId, action: ActionId, params? } -> 202 { actionId, undoUntil }   (remote writes deferred 6.5 s)
// DELETE /api/actions/:actionId -> 200 (undo)          POST /api/capture { text, type?, start?, due? } -> 201
// POST /api/capture/parse { text } -> 202 job (AI parse)   GET /api/today -> TodayPayload (counts are the single source of truth)
```

---

## 13. Build order, ownership and consistency checks

Suggested split for 6 engineers. Shared components land first, in day 1, from E1:

| Engineer | Scope |
|---|---|
| E1 | tokens/base, AppShell, Sidebar, Topbar, QuickBar, Button, Card, Tile, Pill, Chip, Notice, EmptyState, Skeleton, StaleNote, Toast, Dialog, `keys.ts`, `shortcuts.ts`, `copy.ts` |
| E2 | Today (all of §4) plus `shared/today.ts` grouping and counts |
| E3 | CommandPalette, `capture-parse.ts` with golden tests, Ideas page, Tasks page |
| E4 | Inbox (reader pane, digest categories, bulk actions), the deferred action queue on the server side of `/api/actions` |
| E5 | Calendar, Events, the AgendaCard shared with Today |
| E6 | Work (assignments, projects, GitHub), Habits page, Settings + `#/setup` + Google guide |

**Consistency gates** (CI or review checklist, every PR):
1. No hex outside `tokens.css`; no new button, card, pill or row variant without a spec change.
2. No readable text under 12px (Playwright audit: computed `font-size < 12` and not mono and not `kbd` → fail).
3. No horizontal overflow at 320, 390, 860, 1024 and 1440 (`scrollWidth === innerWidth`).
4. Both themes render. The two dark token blocks are byte-identical (`diff`).
5. Every widget renders loading, empty, error, stale and disconnected states from fixtures (`server/fixtures/today-*.json`), screenshot-tested against `states.html`.
6. The 1440×900 fold check from §4.1 holds with the fixture `today-2026-10-12.json` (the mockup data).
7. Keyboard: the IME guard unit test (keydown with `isComposing:true` on `E` does nothing); J/K and ↵ on the queue; Z undo within 6 s cancels the remote write (server test with fake timers).
8. Counts: the H1, nav badge, progress and footer all equal `counts` after every action (component test).
9. Copy comes only from `copy.ts`. zh-TW full-width punctuation; no English UI strings except eyebrows, product names and kbd.

**Mockup data** (use it for fixtures). Monday 2026-10-12, now 08:42, 新竹 24° 多雲, rain 60% after 21:00.
- **Queue (8):**
  - 林志明 教授「Re: OS 期末專題題目討論」(08:05)
  - E3 作業系統 HW3 (23:59)
  - review sitcon-tw/2027.sitcon.org #127 (yuchen, +142 −38)
  - AI: SITCON 秋季交流會 10/25（六）13:30 中研院人文館 from the KKTIX mail
  - 中華電信 9 月帳單 NT$599 (10/20)
  - todo 準備讀書會簡報 Ch.5 (14:00)
  - E3 計算機網路 Lab 2 (週三 23:59)
  - Balsn CTF 2026 (CTFtime, 10/17 08:00, 48h, 權重 55)
- **Counts:** handled 3, total 11.
- **Digest (9):** 電子報 3 · 學校公告 2 · GitHub 通知 4. Inbox unread 12.
- **Agenda:** 10:10–12:00 作業系統 EC115 · 14:00–15:30 OS 讀書會 Ch.5 · gap 15:30 (4 h, HW3) · 19:30–20:30 健身 (→ 運動) · 23:59 HW3 截止.
- **Habits:** 閱讀 20 分鐘 (done 07:50, 12 天) · 運動 (每週 3 次, 0/3, 4 週) · 寫日記 (27 天).
- **Ideas:** 「用 eBPF 量 CFS 排程延遲，當期末專題」(昨天) · 「CTF writeup 改寫成部落格系列」(10/9).
- **Later:** 10/13 09:00 計算機網路 EC122 · 10/24 g0v 零時政府第柒拾次大松 · 10/30 停修申請截止. Projects: OS 期末專題 20% · ctf-notes 64% · vitejs/vite #18234 等待審查 3 天.
- **Sidebar projects:** OS 期末專題 20% · ctf-notes 64% · bell-personal 38%.
