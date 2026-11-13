import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Assignment } from "../shared/assignments.js";
import type { DailyBrief } from "../shared/brief.js";
import type { CalendarEvent, ManualEvent } from "../shared/calendar.js";
import type { ExternalEvent, FeedSubscription } from "../shared/events.js";
import type { ContributionDay, GitHubItem } from "../shared/github.js";
import type { Habit } from "../shared/habits.js";
import type { Idea } from "../shared/ideas.js";
import type { MailMessage } from "../shared/mail.js";
import type { Project } from "../shared/projects.js";
import type { SourceId, SourceItemKind } from "../shared/sources.js";
import type { AiSuggestion, EventSuggestion } from "../shared/suggestions.js";
import { addDays, DEFAULT_TIME_ZONE, isValidTimeZone, todayKey, weekdayOf, zonedTimeToUtc, type DayKey } from "../shared/time.js";
import type { Todo } from "../shared/todos.js";
import type { Weather } from "../shared/weather.js";
import { openDatabases, type Databases } from "../server/db/database.js";
import { AppSettingsStore } from "../server/stores/app-settings.js";
import { SourceItemStore, type SourceItemInput } from "../server/stores/source-items.js";
import { SyncStateStore } from "../server/stores/sync-state.js";
import { demoAssignmentMail, seedLocalAssignments } from "./seed-demo-assignments.js";
import { seedKit } from "./seed-demo-kit.js";
import { demoArchivedMail } from "./seed-demo-mail.js";

/**
 * Demo data for a development data directory: the SPEC §13 mockup day
 * (林教授's mail, HW3 due tonight, the SITCON suggestion, Balsn CTF, three
 * habits with streaks…) written RELATIVE to --now, so the page always looks
 * current. Writes the normalised shared types into source_items (as the
 * sources would), the native tables, one pending AI suggestion, today's
 * brief, three items handled earlier this morning and ok sync_state rows.
 *
 *   npm run seed:demo -- --data-dir ./data [--now 2026-10-12T08:42:00+08:00]
 *
 * Re-running replaces the demo rows (ids start with "demo-" or are the
 * mockup's ids) and the seeded sources' cached items. Refused when
 * NODE_ENV=production. Never touches the vault.
 */

export interface SeedOptions {
  now: Date;
  timeZone: string;
}

export interface SeedSummary {
  day: DayKey;
  sourceItems: Record<string, number>;
  todos: number;
  habits: number;
  habitLogs: number;
  ideas: number;
  projects: number;
  suggestions: number;
  handledToday: number;
  /** local_assignments rows (assignments team's seed). */
  localAssignments: number;
}

const loose = z.looseObject({ id: z.string() });

export function seedDemo(databases: Databases, options: SeedOptions): SeedSummary {
  const { now, timeZone } = options;
  const kit = seedKit(options);
  const { day, at, ago, md } = kit;
  const items = new SourceItemStore(databases.sources, () => now);
  const sync = new SyncStateStore(databases.sources, () => now);
  const counts: Record<string, number> = {};
  const replace = <T>(source: SourceId, kind: SourceItemKind, rows: SourceItemInput<T>[]) => {
    items.replace(source, kind, rows);
    counts[`${source}/${kind}`] = rows.length;
  };

  /* ------------------------------------------------------------- Gmail */
  const { gmailUrl, mail, triage } = kit;
  const github = { name: "GitHub", email: "notifications@github.com" };
  const messages: MailMessage[] = [
    mail("18c2f0a1b2c3d4e5", { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, "Re: OS 期末專題題目討論", at(0, "08:05"), {
      snippet: "同學好，我看過你的提案了，用 eBPF 觀察排程延遲很適合當期末專題…",
      excerpt: "同學好，\n\n我看過你的提案了，用 eBPF 觀察排程延遲很適合當期末專題。請在週三 10:00 meeting 前回信，附上一頁提案，並確認那天的時間可以。\n\n林志明",
      labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL"],
      triage: triage("needs-reply", "教授同意用 eBPF 觀察排程延遲當期末專題，請你在週三 10:00 meeting 前回信，附上一頁提案並確認時間。", { priority: "high", action: "reply", rank: 1, context: "作業系統" }),
    }),
    mail("18c2e9d0a1b2c3f6", { name: "中華電信", email: "ebill@cht.com.tw" }, "中華電信 9 月電子帳單", at(0, "06:12"), {
      snippet: "親愛的用戶您好，您 9 月份的電信費用為 NT$599，繳費期限…",
      excerpt: `親愛的用戶您好：\n\n您 9 月份的電信費用為 NT$599，繳費期限為 ${md(8)}。\n這個門號目前沒有設定自動扣繳，可使用 Hami Pay、網路銀行或至超商代收繳費。\n\n中華電信 敬上`,
      labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
      triage: triage("bill", `9 月電信費 NT$599，${md(8)} 前繳。這個門號沒有設定自動扣繳，可用 Hami Pay 或超商代收。`, {
        priority: "medium", action: "todo", rank: 2, bill: { payee: "中華電信", amount: 599, currency: "TWD", dueDay: addDays(day, 8), period: "9 月", autopay: false },
      }),
    }),
    mail("18c2d1c0b9a8f7e6", { name: "KKTIX", email: "no-reply@kktix.com" }, "報名成功：SITCON 秋季交流會", at(-1, "21:30"), {
      snippet: `您已成功報名 SITCON 秋季交流會，活動時間 ${md(13)} 13:30…`,
      excerpt: `您已成功報名 SITCON 秋季交流會。\n\n活動時間：${md(13)} 13:30–17:30\n活動地點：中研院人文館\n\n入場時請出示 QR Code 票券。`,
      labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], listUnsubscribe: true,
      triage: triage("invitation", `SITCON 秋季交流會報名成功，${md(13)} 13:30 在中研院人文館。`, { action: "calendar", rank: 3 }),
    }),
    ...[["iThome 電子報", "newsletter@ithome.com.tw", "本週資安焦點：供應鏈攻擊再升級"], ["Medium Daily Digest", "noreply@medium.com", "How I built a tiny scheduler in Rust"], ["Cloudflare Blog", "blog@cloudflare.com", "This week on the Cloudflare blog"]]
      .map(([name, email, subject], index) => mail(`demo-news-${index + 1}`, { name, email }, subject, at(0, `0${3 + index}:15`), {
        labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], listUnsubscribe: true, triage: triage("newsletter", "電子報，不用處理。"),
      })),
    mail("demo-school-1", { name: "NYCU 教務處", email: "aa@nycu.edu.tw" }, "[公告] 本學期停修申請期間", at(-1, "16:20"), {
      excerpt: `各位同學好：\n\n本學期停修申請即日起開放，${md(18)} 截止，請於期限內至單一入口完成線上申請。\n\n教務處 註冊組`,
      triage: triage("school", `停修申請到 ${md(18)} 截止。`, { action: "none" }) }),
    mail("demo-school-2", { name: "NYCU 圖書館", email: "lib@nycu.edu.tw" }, "[公告] 圖書館期中考週延長開放", at(-1, "11:05"), {
      excerpt: "期中考週期間，浩然圖書館延長開放至 24:00，自習室同步開放。",
      triage: triage("school", "期中考週圖書館延長開放到 24:00。", { action: "none" }) }),
    ...[["sitcon-tw/2027.sitcon.org", "CI failed on main"], ["vitejs/vite", "Re: fix(css): preserve @layer order (#18234)"], ["Suzu1Dev/ctf-notes", "Dependabot: bump vite"], ["sitcon-tw/2027.sitcon.org", "New comment on #127"]]
      .map(([repo, title], index) => mail(`demo-gh-${index + 1}`, github, `[${repo}] ${title}`, at(0, `0${1 + index}:40`), { triage: triage("notification", "GitHub 通知。") })),
    mail("18c2a7b6c5d4e3f2", { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, "Re: HW2 成績疑問", at(-1, "18:40"), {
      unread: false, labels: ["INBOX"], repliedAt: at(0, "08:20"),
      excerpt: "同學好，\n\nHW2 第 3 題我重新批改了，分數已更新到 E3。如果沒有問題，回信確認一下就好。\n\n王助教",
      triage: triage("needs-reply", "助教確認 HW2 第 3 題重新批改，請回信確認。", { priority: "medium", action: "reply", context: "作業系統" }),
    }),
    // The two teams' additions (SPEC-mail-assignments §13): archived conversations and teachers' announcements.
    ...demoArchivedMail(kit),
    ...demoAssignmentMail(kit),
  ];
  replace("gmail", "mail", messages.map((value) => ({ kind: "mail" as const, externalId: value.id, value, updatedAt: value.receivedAt })));

  /* ---------------------------------------------------- Google Calendar */
  const event = (key: string, offset: number, start: string, end: string, title: string, location: string, description?: string): CalendarEvent => ({
    id: `google:primary:${key}`, origin: "google", calendarId: "primary", calendarName: "Suzu", title, start: at(offset, start), end: at(offset, end),
    allDay: false, location, ...(description ? { description } : {}), status: "confirmed", updatedAt: ago(600),
    url: `https://calendar.google.com/calendar/event?eid=${key}`,
  });
  const events = [
    event("demo-os-lecture", 0, "10:10", "12:00", "作業系統", "工程三館 EC115", "林志明"),
    event("demo-study-group", 0, "14:00", "15:30", "OS 讀書會 · Ch.5", "浩然圖書館 討論室 B"),
    event("demo-gym", 0, "19:30", "20:30", "健身", "光復校區 體育館"),
    event("demo-network-lecture", 1, "09:00", "10:50", "計算機網路", "工程三館 EC122"),
  ];
  replace("google-calendar", "calendar-event", events.map((value) => ({ kind: "calendar-event" as const, externalId: value.id, value, startsAt: value.start })));

  /* -------------------------------------------------------------- Moodle */
  const assignment = (id: string, courseName: string, title: string, dueAt: string): Assignment => ({
    id: `moodle:${id}`, origin: "moodle", externalId: id, courseName, title, dueAt, submission: "not-submitted",
    url: `https://e3p.nycu.edu.tw/mod/assign/view.php?id=${id}`, updatedAt: ago(720),
  });
  const assignments = [
    assignment("30512", "作業系統", "HW3：CPU Scheduling 模擬", at(0, "23:59")),
    assignment("30744", "計算機網路", "Lab 2：Socket Programming", at(2, "23:59")),
    assignment("30801", "作業系統", "HW4：Memory Management", at(16, "23:59")),
  ];
  replace("moodle", "assignment", assignments.map((value) => ({ kind: "assignment" as const, externalId: value.externalId, value, dueAt: value.dueAt })));

  /* -------------------------------------------------------------- GitHub */
  const githubItems: GitHubItem[] = [
    { id: "review-request:PR_kwDOSitcon127", kind: "review-request", repo: "sitcon-tw/2027.sitcon.org", title: "新增議程頁深色模式", number: 127,
      url: "https://github.com/sitcon-tw/2027.sitcon.org/pull/127", updatedAt: at(-1, "08:00"), author: "yuchen", additions: 142, deletions: 38, requestedAt: at(-1, "08:00") },
    { id: "pr:PR_kwDOVite18234", kind: "pr", repo: "vitejs/vite", title: "fix(css): preserve @layer order", number: 18234,
      url: "https://github.com/vitejs/vite/pull/18234", updatedAt: at(-3, "15:00"), createdAt: at(-3, "15:00"), reviewDecision: "REVIEW_REQUIRED", checks: "SUCCESS", isDraft: false },
    // Notification ids are GitHub thread ids (digits): 標為已讀 sends PATCH notifications/threads/<id>.
    { id: "notification:21000000001", kind: "notification", repo: "sitcon-tw/2027.sitcon.org", title: "CI failed on main", url: "https://github.com/sitcon-tw/2027.sitcon.org/actions", updatedAt: at(0, "01:40"), reason: "ci_activity", unread: true, subjectType: "CheckSuite" },
    { id: "notification:21000000002", kind: "notification", repo: "sitcon-tw/2027.sitcon.org", title: "新增議程頁深色模式", number: 127, url: "https://github.com/sitcon-tw/2027.sitcon.org/pull/127", updatedAt: at(-1, "08:00"), reason: "review_requested", unread: true, subjectType: "PullRequest" },
    { id: "notification:21000000003", kind: "notification", repo: "Suzu1Dev/ctf-notes", title: "heap 筆記的 tcache 範例跑不起來", number: 12, url: "https://github.com/Suzu1Dev/ctf-notes/issues/12", updatedAt: at(-2, "22:15"), reason: "mention", unread: true, subjectType: "Issue" },
    { id: "issue:I_kwDOBell9", kind: "issue", repo: "Suzu1Dev/bell-personal", title: "Week view overflows at 320px", number: 9, url: "https://github.com/Suzu1Dev/bell-personal/issues/9", updatedAt: at(-2, "10:00"), createdAt: at(-4, "10:00"), author: "Suzu1Dev" },
  ];
  replace("github", "github-item", githubItems.map((value) => ({ kind: "github-item" as const, externalId: value.id, value, updatedAt: value.updatedAt })));
  const contributions: ContributionDay[] = Array.from({ length: 60 }, (_, index) => {
    const date = addDays(day, index - 59);
    return { date, count: (index * 7 + 3) % 5 === 0 ? 0 : ((index * 13) % 6) + 1 };
  });
  replace("github", "contribution-day", contributions.map((value) => ({ kind: "contribution-day" as const, externalId: value.date, value })));

  /* ---------------------------------------------------- CTFtime and feeds */
  const ctf = (id: string, title: string, startOffset: number, hours: number, weight: number, location = "線上"): ExternalEvent => ({
    id: `ctftime:${id}`, origin: "ctftime", title, start: at(startOffset, "08:00"), end: new Date(Date.parse(at(startOffset, "08:00")) + hours * 3_600_000).toISOString(),
    location, url: `https://ctftime.org/event/${id}`, format: "Jeopardy", weight, online: location === "線上", organizer: title.split(" ")[0], updatedAt: ago(42),
  });
  const ctfEvents = [ctf("2846", "Balsn CTF 2026", 5, 48, 55), ctf("2851", "TSG CTF 2026", 6, 24, 24), ctf("2860", "HITCON CTF 2026 Quals", 19, 48, 70)];
  replace("ctftime", "external-event", ctfEvents.map((value) => ({ kind: "external-event" as const, externalId: value.id, value, startsAt: value.start })));
  const feedEvents: ExternalEvent[] = [
    { id: "feed:g0v:hackath70n", origin: "feed", feedId: "demo-feed-g0v", feedName: "g0v 行事曆訂閱", title: "g0v 零時政府第柒拾次大松", start: at(12, "09:00"), end: at(12, "17:00"),
      location: "中研院", url: "https://g0v.kktix.cc/events/hackath70n", organizer: "g0v", updatedAt: ago(42) },
    { id: "ics:nycu:withdraw-deadline", origin: "ics", feedId: "demo-feed-nycu", feedName: "NYCU 校園行事曆", title: "停修申請截止", start: at(18, "00:00"), allDay: true,
      url: "https://www.nycu.edu.tw/calendar", updatedAt: ago(42) },
  ];
  replace("feeds", "external-event", feedEvents.map((value) => ({ kind: "external-event" as const, externalId: value.id, value, startsAt: value.start })));
  // The subscriptions behind those events (events module, event_feeds), so the feeds source reads as set up.
  const feedStamp = ago(60 * 24 * 20);
  const subscriptions: FeedSubscription[] = [
    { id: "demo-feed-g0v", label: "g0v 行事曆訂閱", url: "https://g0v.kktix.cc/events.atom", kind: "atom", enabled: true, target: "events", createdAt: feedStamp, lastSyncedAt: ago(42), lastError: null, updatedAt: ago(42) },
    { id: "demo-feed-nycu", label: "NYCU 校園行事曆", url: "https://www.nycu.edu.tw/calendar/2026-fall.ics", kind: "ics", enabled: true, target: "events", createdAt: feedStamp, lastSyncedAt: ago(42), lastError: null, updatedAt: ago(42) },
  ];
  const feedRow = databases.personal.db.prepare(`INSERT INTO event_feeds (id, json, updated_at, enabled, target, created_at) VALUES (?, ?, ?, 1, 'events', ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, enabled = 1, target = 'events', created_at = excluded.created_at`);
  for (const feed of subscriptions) feedRow.run(feed.id, JSON.stringify(feed), feed.updatedAt!, feed.createdAt);

  /* ------------------------------------------------------------- Weather */
  const weather: Weather = {
    location: "新竹",
    current: { temperatureC: 24, apparentC: 25, code: 2, isDay: true },
    today: { maxC: 27, minC: 21, precipitationProbability: 60, code: 3 },
    hourly: Array.from({ length: 15 }, (_, index) => {
      const hour = 9 + index;
      return { time: at(0, `${String(hour).padStart(2, "0")}:00`), precipitationProbability: hour >= 21 ? 60 : hour >= 18 ? 30 : 10 };
    }),
    fetchedAt: ago(12),
  };
  replace("weather", "weather", [{ kind: "weather", externalId: "current", value: weather }]);

  /* ---------------------------------------------------------- Sync state */
  const synced: Array<[SourceId, number]> = [["gmail", 2], ["google-calendar", 2], ["moodle", 11], ["github", 4], ["ctftime", 42], ["feeds", 42], ["weather", 12]];
  for (const [source, minutes] of synced)
    sync.save(source, { state: "ok", lastSyncedAt: ago(minutes), lastAttemptAt: ago(minutes), lastError: null, items: items.count(source) });

  /* ------------------------------------------------------- Native tables */
  const stamp = ago(60 * 24 * 10);
  const todos = databases.personal.docs<Todo>({
    table: "todos", label: "待辦", schema: loose as unknown as z.ZodType<Todo>,
    columns: (todo) => ({ status: todo.status, due_day: todo.dueDay ?? null, project_id: todo.projectId ?? null, created_at: todo.createdAt }),
  });
  const todo = (id: string, title: string, extra: Partial<Todo> = {}): Todo =>
    ({ id, title, status: "open", priority: "normal", origin: "manual", createdAt: stamp, updatedAt: stamp, ...extra });
  todos.putMany([
    todo("todo-study-slides", "準備讀書會簡報：Ch.5 Deadlocks", { dueDay: day, dueTime: "14:00", estimateMinutes: 40, notes: "讀書會 14:00 前", projectId: "os-final" }),
    todo("todo-os-proposal", "整理 OS 期末專題提案（一頁）", { projectId: "os-final" }),
    todo("todo-usb-c", "買 USB-C 轉接頭"),
    todo("todo-club-form", "回覆社團器材借用表單"),
    todo("todo-dorm-fee", "繳宿舍網路費", { status: "done", completedAt: at(0, "08:27"), updatedAt: at(0, "08:27") }),
    todo("todo-scholarship", "寄出獎學金申請文件", { status: "done", completedAt: at(0, "08:33"), updatedAt: at(0, "08:33") }),
  ]);

  // The 課表 without Google: one weekly local class (Thursdays, so the mockup Monday stays as it is), started four weeks ago.
  const localEvents = databases.personal.docs<ManualEvent>({
    table: "manual_events", label: "行程", schema: loose as unknown as z.ZodType<ManualEvent>,
    columns: (event) => ({ starts_at: event.start, ends_at: event.end ?? null, created_at: event.createdAt }),
  });
  const classDay = addDays(addDays(day, -((weekdayOf(day) + 6) % 7)), -28 + 3);
  localEvents.put({
    id: "demo-class-probability", title: "機率與統計", location: "工程四館 EC026", allDay: false,
    start: zonedTimeToUtc(timeZone, classDay, 14, 10).toISOString(), end: zonedTimeToUtc(timeZone, classDay, 15, 50).toISOString(),
    repeat: { freq: "weekly" }, createdAt: stamp, updatedAt: stamp,
  });

  const habits = databases.personal.docs<Habit>({
    table: "habits", label: "習慣", schema: loose as unknown as z.ZodType<Habit>,
    columns: (habit) => ({ archived: habit.archived ? 1 : 0, sort_order: habit.order, created_at: habit.createdAt }),
  });
  const habitStamp = ago(60 * 24 * 90);
  habits.putMany([
    { id: "habit-read", name: "閱讀 20 分鐘", short: "閱讀", cadence: "daily", targetPerDay: 1, archived: false, order: 0, createdAt: habitStamp, updatedAt: habitStamp },
    { id: "habit-move", name: "運動", short: "運動", cadence: "weekly", timesPerWeek: 3, targetPerDay: 1, keywords: ["健身", "重訓", "跑步"], archived: false, order: 1, createdAt: habitStamp, updatedAt: habitStamp },
    { id: "habit-diary", name: "寫日記", short: "日記", hint: "睡前", cadence: "daily", targetPerDay: 1, archived: false, order: 2, createdAt: habitStamp, updatedAt: habitStamp },
  ]);
  const logs: Array<{ habitId: string; day: DayKey; createdAt: string }> = [];
  for (let offset = -11; offset <= 0; offset++) logs.push({ habitId: "habit-read", day: addDays(day, offset), createdAt: offset === 0 ? at(0, "07:50") : at(offset, "22:30") });
  for (let offset = -27; offset <= -1; offset++) logs.push({ habitId: "habit-diary", day: addDays(day, offset), createdAt: at(offset, "23:40") });
  const monday = addDays(day, -((weekdayOf(day) + 6) % 7));
  for (let week = 1; week <= 4; week++)
    for (const weekday of [1, 3, 5]) {
      const logDay = addDays(monday, -7 * week + weekday);
      logs.push({ habitId: "habit-move", day: logDay, createdAt: zonedTimeToUtc(timeZone, logDay, 20, 40).toISOString() });
    }
  databases.personal.transaction(() => {
    databases.personal.db.prepare("DELETE FROM habit_logs WHERE habit_id IN ('habit-read', 'habit-move', 'habit-diary')").run();
    const insert = databases.personal.db.prepare("INSERT INTO habit_logs (habit_id, day, count, note, created_at, updated_at) VALUES (?, ?, 1, NULL, ?, ?)");
    for (const log of logs) insert.run(log.habitId, log.day, log.createdAt, log.createdAt);
  });

  const ideas = databases.personal.docs<Idea>({
    table: "ideas", label: "靈感", schema: loose as unknown as z.ZodType<Idea>,
    columns: (idea) => ({ archived: idea.archived ? 1 : 0, pinned: idea.pinned ? 1 : 0, created_at: idea.createdAt }),
  });
  const idea = (id: string, text: string, createdAt: string, tags: string[] = []): Idea => ({ id, text, tags, pinned: false, archived: false, origin: "quick-capture", createdAt, updatedAt: createdAt });
  ideas.putMany([
    idea("idea-ebpf-cfs", "用 eBPF 量 CFS 排程延遲，當期末專題", at(-1, "23:10"), ["OS"]),
    idea("idea-ctf-blog", "CTF writeup 改寫成部落格系列", at(-3, "21:00"), ["CTF", "寫作"]),
    idea("idea-habit-heatmap", "習慣頁可以加一個整年的熱度圖", at(-6, "12:20")),
  ]);

  const projects = databases.personal.docs<Project>({
    table: "projects", label: "專案", schema: loose as unknown as z.ZodType<Project>,
    columns: (project) => ({ status: project.status, created_at: project.createdAt }),
  });
  const projectStamp = ago(60 * 24 * 40);
  projects.putMany([
    { id: "os-final", name: "OS 期末專題", description: "用 eBPF 觀察 CFS 排程延遲。", color: "task", status: "active", progress: 20, createdAt: projectStamp, updatedAt: ago(90),
      milestones: [
        { id: "m-topic", title: "題目討論", done: true, doneAt: at(-2, "16:00") },
        { id: "m-proposal", title: "題目提案", dueDay: addDays(day, 7), done: false },
        { id: "m-midterm", title: "期中進度報告", dueDay: addDays(day, 30), done: false },
        { id: "m-demo", title: "期末 demo", dueDay: addDays(day, 60), done: false },
      ] },
    { id: "ctf-notes", name: "ctf-notes", color: "event", status: "active", progress: 64, repo: "Suzu1Dev/ctf-notes", createdAt: projectStamp, updatedAt: ago(300),
      milestones: [{ id: "m-heap", title: "Balsn 前整理 heap 筆記", dueDay: addDays(day, 4), done: false }] },
    { id: "bell-personal", name: "bell-personal", color: "accent", status: "active", progress: 38, repo: "Suzu1Dev/bell-personal", createdAt: projectStamp, updatedAt: ago(30),
      milestones: [{ id: "m-today", title: "完成 Today 頁", done: false }] },
  ]);

  const briefs = databases.personal.docs<DailyBrief & { id: string }>({
    table: "daily_briefs", label: "每日摘要", schema: loose as unknown as z.ZodType<DailyBrief & { id: string }>, columns: (brief) => ({ source: brief.source }),
  });
  briefs.put({
    id: day, day, source: "ai", generatedAt: at(0, "06:30"),
    text: "先回林教授的專題信，再把 OS HW3 收尾，今晚 23:59 截止。下午 2:00 讀書會前記得準備 Ch.5 簡報；15:30 後有 4 小時空檔。",
    refs: [{ kind: "mail", id: "18c2f0a1b2c3d4e5" }, { kind: "assignment", id: "moodle:30512" }],
  });

  /* ------------------------------------------------------ AI suggestion */
  const suggestions = databases.sources.docs<AiSuggestion<EventSuggestion>>({
    table: "ai_suggestions", label: "建議", schema: loose as unknown as z.ZodType<AiSuggestion<EventSuggestion>>,
    columns: (suggestion) => ({ kind: suggestion.kind, status: suggestion.status, created_at: suggestion.createdAt }),
  });
  suggestions.put({
    id: "sg-sitcon-autumn", kind: "event", status: "pending", title: "SITCON 秋季交流會", origin: "KKTIX 報名成功信", createdAt: at(-1, "21:35"),
    payload: { title: "SITCON 秋季交流會", start: at(13, "13:30"), end: at(13, "17:30"), allDay: false, location: "中研院人文館" },
    sourceRef: { source: "gmail", externalId: "18c2d1c0b9a8f7e6", url: gmailUrl("18c2d1c0b9a8f7e6") },
  });
  databases.sources.db.prepare("UPDATE ai_suggestions SET dedupe_key = ? WHERE id = ?").run("mail-event:18c2d1c0b9a8f7e6", "sg-sitcon-autumn");

  /* ------------------------------- Assignments from mail and by hand */
  const native = seedLocalAssignments(databases, kit);

  /* ------------------------------------- Handled earlier this morning */
  const handled = [
    { id: "demo-action-1", itemId: "gmail:18c2a7b6c5d4e3f2", kind: "mail.reply", action: "reply", title: "Re: HW2 成績疑問", at: at(0, "08:20"), actor: "sync" },
    { id: "demo-action-2", itemId: "native:todo-dorm-fee", kind: "todo", action: "done", title: "繳宿舍網路費", at: at(0, "08:27"), actor: "user" },
    { id: "demo-action-3", itemId: "native:todo-scholarship", kind: "todo", action: "done", title: "寄出獎學金申請文件", at: at(0, "08:33"), actor: "user" },
  ];
  databases.personal.transaction(() => {
    const db = databases.personal.db;
    db.prepare("DELETE FROM action_log WHERE id LIKE 'demo-%'").run();
    const log = db.prepare(`INSERT INTO action_log (id, day, item_id, kind, action, title, params, at, undone, closes, remote, commit_at, error, previous, actor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 1, 'none', NULL, NULL, NULL, ?, ?)`);
    const state = db.prepare(`INSERT INTO item_state (item_id, state, until, day, fingerprint, action, action_id, at) VALUES (?, 'handled', NULL, ?, NULL, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET state = excluded.state, until = NULL, day = excluded.day, fingerprint = NULL, action = excluded.action, action_id = excluded.action_id, at = excluded.at`);
    for (const entry of handled) {
      log.run(entry.id, day, entry.itemId, entry.kind, entry.action, entry.title, entry.at, entry.actor, entry.at);
      state.run(entry.itemId, day, entry.action, entry.id, entry.at);
    }
  });

  /* ------------------------------------------------------------ Settings */
  new AppSettingsStore(databases.settings).update({ "weather.location": { name: "新竹", latitude: 24.8138, longitude: 120.9675, timezone: "Asia/Taipei" }, "ctftime.enabled": true,
    // Every feature on and 初次設定 done, as in the mockups.
    "profile.roles": ["student", "developer", "ctf"], "onboarding.completedAt": now.toISOString() });

  return {
    day,
    sourceItems: counts,
    todos: todos.count(),
    habits: habits.count(),
    habitLogs: logs.length,
    ideas: ideas.count(),
    projects: projects.count(),
    suggestions: 1 + native.suggestions,
    handledToday: handled.length,
    localAssignments: native.assignments,
  };
}

/** Today at 08:42 in the zone (the mockup's moment). */
export function defaultSeedNow(timeZone: string, now = new Date()): Date {
  return zonedTimeToUtc(timeZone, todayKey(timeZone, now), 8, 42);
}

export function parseSeedArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { dataDir: string; now: Date; timeZone: string } {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${name} 需要一個值。`);
    return next;
  };
  const timeZone = value("--tz") ?? env.BELLPERSONAL_TZ?.trim() ?? DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new Error("--tz 必須是有效的 IANA 時區名稱，例如 Asia/Taipei。");
  const nowText = value("--now");
  const now = nowText ? new Date(nowText) : defaultSeedNow(timeZone);
  if (Number.isNaN(now.getTime())) throw new Error("--now 必須是 ISO 時間，例如 2026-10-12T08:42:00+08:00。");
  return { dataDir: path.resolve(value("--data-dir") ?? env.BELLPERSONAL_DATA_DIR?.trim() ?? "data"), now, timeZone };
}

function main(): void {
  if (process.env.NODE_ENV === "production") throw new Error("seed:demo 只能在開發環境執行（NODE_ENV=production 時拒絕寫入示範資料）。");
  const { dataDir, now, timeZone } = parseSeedArgs(process.argv.slice(2));
  const databases = openDatabases(dataDir);
  try {
    const summary = seedDemo(databases, { now, timeZone });
    console.log(`已寫入示範資料到 ${dataDir}（${summary.day}，現在時間 ${now.toISOString()}）`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    databases.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
