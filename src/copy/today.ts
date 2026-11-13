/**
 * Today page strings (SPEC-ux §4, §5, §10 "Today"). zh-TW only: full-width
 * punctuation, `·` as the meta separator, `…` in progress text, half-width
 * spaces around Latin and numbers. Shared toast and error strings stay in
 * common.ts (ACTION_TOASTS, ERRORS, STALE, BUTTONS, AI_TAGS).
 */
import type { ActionId, QueueGroup } from "../../shared/today";

export const HERO = {
  /** `{greeting}，還有 <uline>{N} 件事</uline> 等你處理。` split around the underlined phrase. */
  openBefore: (greeting: string) => `${greeting}，還有 `,
  openCount: (n: number) => `${n} 件事`,
  openAfter: " 等你處理。",
  clearedBefore: "收工了，",
  clearedUline: "佇列清空了",
  clearedAfter: "。",
  empty: (greeting: string) => `${greeting}，今天沒有排定的事。`,
  weather: (city: string, tempC: number, text: string) => `${city} ${Math.round(tempC)}° ${text}`,
  rain: (time: string, pct: number) => `${time} 後降雨 ${pct}%`,
  loadingLabel: "正在載入今天的資料…",
  /** The page heading (screen readers) when the first load failed; the notice above says why. */
  unavailableLabel: "今天",
} as const;

/** A widget with no data because the first load failed: static, never 「正在載入」 (the page notice above says why, has 重試, and the page keeps polling). */
export const WIDGET_UNAVAILABLE = "暫時無法載入。";

export const BRIEF = {
  refresh: "重新整理摘要",
  refreshing: "正在重新整理摘要…",
  generatedAt: (time: string) => `AI 整理於 ${time}`,
  loading: "正在整理今日摘要…",
  fallback: (reason: string) => `AI 摘要暫時無法使用：${reason}。`,
  retry: "重試",
  settings: "每日摘要設定",
  refreshFailed: "重新整理摘要",
  refreshed: "已更新今日摘要",
  ruleUsed: "AI 沒有完成，先用規則整理。",
} as const;

export const PROGRESS = {
  label: "今日進度",
  handled: (n: number) => `已處理 ${n} 件`,
  paceBefore: "照這個節奏，約 ",
  paceMinutes: (m: number) => `${m} 分鐘`,
  paceAfter: " 清空",
  valueText: (handled: number, total: number) => `已處理 ${handled} 件，共 ${total} 件`,
  nextUpLabel: (time: string, title: string, relative: string) => `接下來：${time} ${title}，${relative}。開啟行事曆`,
} as const;

export const QUEUE = {
  title: "專注佇列",
  countLabel: (n: number) => `${n} 件待處理`,
  filterLabel: "依來源篩選",
  chips: { all: "全部", mail: "信件", work: "作業", github: "GitHub", events: "活動", tasks: "待辦" },
  chipError: (label: string) => `${label} 需要重新連線`,
  chipFailed: (label: string) => `${label} 同步失敗`,
  groups: {
    now: { title: "最重要" },
    today: { title: "今天內" },
    later: { title: "可以等", hint: "待辦與作業：未來 7 天內" },
  } satisfies Record<QueueGroup, { title: string; hint?: string }>,
  groupCount: (n: number) => `${n} 件`,
  more: (n: number) => `還有 ${n} 件 · 顯示全部`,
  fewer: "收合",
  handled: (n: number) => `今天已處理 ${n} 件`,
  show: "顯示",
  hide: "收合",
  newItems: (n: number) => `有 ${n} 件新的 · 顯示`,
  replying: "回覆中…",
  handledUndo: "復原",
  handledUndone: (title: string) => `已復原「${title}」`,
  handledAt: (time: string) => `${time} 處理`,
  rowActions: (title: string) => `「${title}」的動作`,
  dismissSuggestion: "略過這個建議",
  swipeDone: "放開以處理",
  swipeSnooze: "放開以延後",
  errorTitle: "佇列暫時無法更新",
  errorBody: (time: string) => `顯示 ${time} 的內容。`,
  emptyTitle: "今天沒有要處理的事。",
  emptyHint: "信件、作業與活動會自動加入。",
  loading: "正在載入佇列…",
} as const;

/** The verb in each action button, by action (SPEC §4.3 table; rows override with their own label). */
export const ACTION_HANDLED_LABELS: Record<ActionId, string> = {
  reply: "已回覆",
  open: "已開啟",
  archive: "已封存",
  read: "已讀",
  todo: "轉待辦",
  snooze: "已延後",
  done: "完成",
  submitted: "已交",
  reviewed: "已審查",
  calendar: "加入行事曆",
  going: "要參加",
  dismiss: "略過",
  schedule: "排進",
  trash: "移到垃圾桶",
  unarchive: "移回收件匣",
  assignment: "轉成作業",
};

/** `.link.ext` labels by queue source (SPEC §10 buttons: 在 Gmail 開啟 · 在 GitHub 開啟). */
export const EXTERNAL_LINKS: Record<string, string> = {
  gmail: "在 Gmail 開啟",
  github: "在 GitHub 開啟",
  moodle: "在 E3 開啟",
  canvas: "在 Canvas 開啟",
  ctftime: "在 CTFtime 開啟",
  feed: "開啟活動頁",
  ai: "開啟原始信件",
  assignment: "開啟信件",
};

/** Source-failure notices above the queue groups (SPEC §5 state 03). */
export const SOURCE_NOTICES = {
  reconnectTitle: (label: string) => `${label} 需要重新連線`,
  errorTitle: (label: string) => `${label} 同步失敗`,
  reason: {
    gmail: "Google 撤銷了授權",
    moodle: "E3 登入已失效",
    canvas: "Canvas 權杖已失效",
    github: "GitHub 連線已失效",
    ctftime: "CTFtime 暫時沒有回應",
    feeds: "活動訂閱暫時無法讀取",
  } as Record<string, string>,
  failed: "上次同步沒有完成",
  missing: {
    gmail: "新信件",
    moodle: "新作業",
    canvas: "新作業",
    github: "新的審查請求",
    ctftime: "新活動",
    feeds: "新活動",
  } as Record<string, string>,
  body: (reason: string, what: string, n: number, time?: string) =>
    `${reason}，${what}沒有列入佇列，所以「${n} 件」可能少算。${time ? `上次同步 ${time}。` : ""}`,
  reconnect: "重新連線",
  retry: "重試",
  many: (n: number) => `${n} 個來源需要注意`,
  manyBody: "有些來源沒有同步，佇列的件數可能少算。",
  view: "查看",
} as const;

export const SNOOZE = {
  title: "延後到…",
  label: (title: string) => `延後「${title}」`,
  tonight: "今晚 20:00",
  tomorrow: "明天 08:00",
  saturday: "週六 09:00",
  nextMonday: "下週一 08:00",
  pick: "選擇時間…",
  pickLabel: "延後到這個時間",
  pickSubmit: "延後",
  pickInvalid: "請選一個之後的時間。",
  tooLate: "會超過截止時間",
  past: "已經過了",
  custom: (monthDay: string, time: string) => `${monthDay} ${time}`,
  close: "關閉延後選單",
} as const;

export const CELEBRATION = {
  title: (n: number) => `今天的 ${n} 件事都處理完了。`,
  stats: { reply: "回覆", done: "完成", snooze: "延後", calendar: "行事曆" },
  statsLabel: "今天的處理方式",
  habitsLeft: (n: number) => `還差 ${n} 個習慣`,
} as const;

export const DIGEST = {
  title: (n: number) => `另外 ${n} 封信已自動分類，不用處理`,
  stillInGmail: "信都還在你的 Gmail",
  staleSuffix: (time: string) => `${time} 的分類`,
  readAll: "全部標為已讀",
  byCategory: "逐類看",
  readAllToast: (n: number) => `已將 ${n} 封標為已讀`,
  categoryRead: (label: string, n: number) => `已將「${label}」${n} 封標為已讀`,
  categoryArchive: (label: string, n: number) => `已封存「${label}」${n} 封`,
  actions: { read: "標為已讀", open: "開啟", archive: "封存" } as Record<string, string>,
  categoriesLabel: "信件分類",
  /** Fallback when the payload carries no account link (fixtures, older servers). */
  gmailInbox: "https://mail.google.com/mail/u/0/#inbox",
} as const;

export const LATER = {
  label: "明天與之後、專案",
  events: "明天與之後",
  eventsLink: "活動",
  projects: "專案",
  projectsLink: "作業與專案",
  next: (text: string) => `下一步：${text}`,
  pr: "PR",
  noEvents: "接下來兩週沒有活動。",
  noProjects: "還沒有專案。",
  addProject: "新增專案",
  failed: "暫時無法載入",
  retry: "重試",
  staleNote: (label: string, time: string) => `${label} 顯示 ${time} 的資料`,
  sumFirst: (label: string, title: string) => `${label} ${title}`,
  sumEvents: (n: number) => `本週還有 ${n} 個活動`,
  sumProjects: (n: number) => `${n} 個專案進行中`,
  sumEmpty: "明天與之後、專案",
  expand: "展開明天與之後、專案",
} as const;

/** The card around the shared CaptureField (its field, hint and toasts are src/copy/capture.ts). */
export const CAPTURE = {
  label: "快速記下",
  ideasLink: "靈感",
  recentLabel: "最近的靈感",
} as const;

export const HABITS = {
  title: "習慣打卡",
  keysBefore: "按 ",
  keysAfter: " 打卡",
  doneLabel: (done: number, total: number) => `今天完成 ${done} 個，共 ${total} 個`,
  checkLabel: (name: string, done: boolean, key?: number) =>
    `${name}，今天${done ? "已完成" : "尚未完成"}。${key ? `按 ${key} 切換` : "點一下切換"}`,
  streakLabel: (n: number, unit: string) => `連續 ${n} ${unit}`,
  more: (n: number) => `+${n}`,
  moreLabel: (n: number) => `還有 ${n} 個習慣，前往習慣頁`,
  emptyTitle: "還沒有習慣，從一個小的開始吧。",
  add: "新增習慣",
  addChip: "＋ 新增習慣",
  listLabel: "今天的習慣",
} as const;

export const AGENDA = {
  title: "今日行程",
  countLabel: (n: number) => `${n} 個行程`,
  link: "行事曆",
  now: "現在",
  nowLabel: (time: string) => `現在 ${time}`,
  allDay: "全天",
  gapTitle: (hours: string) => `${hours} 小時空檔`,
  schedule: "排進",
  pastFold: (n: number) => `已結束 ${n} 個 · 顯示`,
  checkInLater: (habit: string) => `結束後一鍵打卡「${habit}」`,
  checkIn: (habit: string) => `打卡「${habit}」`,
  /** Read before a weekly row's meta (the repeat icon itself is decorative). */
  repeatLabel: "每週重複，",
  empty: "今天沒有行程，留點時間給自己。",
  notSetUp: "今天沒有行程。新增一個，或連接行事曆，行程就會自動出現。",
  add: "新增行程",
  connectGoogle: "連接 Google",
  errorTitle: "無法讀取 Google 行事曆",
  errorReconnect: "授權已過期。重新連線後會自動補上今天的行程。",
  errorFailed: "這次同步沒有完成，稍後會自動重試。",
  retry: "重試",
  reconnect: "重新連線",
} as const;

/** One quiet line under the queue: undated todos captured before today (payload.backlog). */
export const BACKLOG = {
  line: (n: number) => `還有 ${n} 件待辦沒排日期`,
  action: "去排一下",
} as const;

export const ENDMARK = {
  title: "今天的版面到這裡。",
  next: (time: string) => `下一份摘要明天 ${time} 送到。`,
  off: "AI 摘要已關閉。",
} as const;

/** Relative-day words for stale notes: 「顯示 昨天 22:10 的資料」. */
export const TIME_WORDS = {
  yesterday: "昨天",
} as const;

export const BOT = {
  title: "Personal Bot",
  subtitle: "跟它說任何事，自動整理並操作 Personal 與 BELL Suite。",
  suitePersonal: "Personal",
  suiteExplain: "Explain",
  suitePr: "PR",
  autonomy: {
    cautious: "每次詢問",
    balanced: "分級權限",
    auto: "全自動",
  },
  autonomyTitle: "前往 AI 設定調整 Personal Bot 自主權限",
  newChat: "新對話",
  collapse: "收合對話",
  expand: (n: number) => `展開對話（${n} 則）`,
  quickCapture: "快速記下",
  placeholder: "跟 Personal Bot 說任何事：整理今天重點、新增待辦、產生 Explain 筆記或啟動 PR 任務…",
  inputLabel: "傳送訊息給 Personal Bot",
  send: "傳送",
  sending: "處理中…",
  thinkingDefault: "正在讀取 Personal 與 BELL Suite 資料…",
  startersLabel: "常用指令建議",
  starters: [
    "整理我今天最重要的事與學習進度",
    "幫我新增待辦並排進今天的空檔",
    "查看 BELL Explain 講義與 BELL PR 任務狀態",
  ],
  followUpsLabel: "建議下一步",
  approvalBadge: "需要確認",
  approve: "核准執行",
  approving: "執行中…",
  dismiss: "略過",
  undo: "復原",
  undoing: "復原中…",
  openResult: "查看",
  approvedToast: (label: string) => `已執行：${label}`,
  undoneToast: (label: string) => `已復原：${label}`,
  status: {
    executed: "已完成",
    dismissed: "已略過",
    undone: "已復原",
    failed: "執行失敗",
  },
  appBadge: {
    personal: "Personal",
    explain: "BELL Explain",
    pr: "BELL PR",
  },
  aiOffHint: "尚未啟用 AI，前往「連線與設定 › AI」開啟後即可讓 Personal Bot 為你整理與操作。",
  aiSettings: "AI 設定",
  errorTitle: "Personal Bot 暫時無法完成這項要求",
  hint: "Enter 傳送 · Shift+Enter 換行",
  welcomeTitle: "今天想先處理哪一件事？",
  welcomeSub: "支援跨產品整理今日重點、建立待辦與行程、生成 Explain 講義或啟動 PR 任務；所有對話皆可依主題歸檔。",
  historyTitle: "對話紀錄",
  historyToggle: "開啟對話紀錄側欄",
  searchPlaceholder: "搜尋過往對話…",
  emptyHistory: "還沒有歷史對話，送出第一則訊息後會自動歸檔在這裡。",
  noMatchHistory: "沒有符合篩選條件的對話紀錄。",
  folders: {
    daily: "今日與排程",
    tasks: "待辦與靈感",
    suite: "Explain / PR",
    general: "一般對話",
  },
  filters: {
    all: "全部",
    pinned: "已釘選",
  },
  pin: "釘選對話",
  unpin: "取消釘選",
  deleteChat: "刪除對話",
  folderGroupLabel: "設定此對話的分類標籤",
  openFullWorkspace: "展開完整頁面",
  floatingLabel: "Personal Bot",
  floatingAria: "開啟 Personal Bot 隨身視窗",
  floatingClose: "收合隨身視窗",
  messageUnit: (n: number) => `${n} 則`,
} as const;
