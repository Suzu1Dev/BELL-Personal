/**
 * Shell and shared-component strings (SPEC-ux §10 "Fixed strings", §3.1 page
 * heads, §5 shared errors). commonCopy() applies the signed-off locale copy;
 * the constants below retain the zh-TW defaults for other feature pages.
 *
 * Convention: feature teams add `src/copy/<domain>.ts` (e.g. `today.ts`,
 * `inbox.ts`) and import it directly. Do not add an index file; never inline
 * user-facing strings in components.
 */
import { format, onboardingCopy } from "./onboarding";

export const META = {
  title: "BELL Personal · 你的每日工作台",
  /** document.title on routes other than Today: 「收件匣 · BELL Personal」 */
  titleFor: (page: string) => `${page} · BELL Personal`,
  brandLabel: "BELL Personal 今日",
} as const;

export const SHELL = {
  skip: "跳至主要內容",
  drawerOpen: "開啟選單",
  drawerClose: "關閉選單",
  railCollapse: "收合側欄",
  railExpand: "展開側欄",
  sidebarLabel: "主要導覽",
  navLabel: "模組",
  quickbarLabel: "快速列",
  breadcrumbLabel: "麵包屑",
  capture: "快速記下",
  captureTitle: "快速記下（N）",
  todayLabel: "今日",
  projectsLabel: "專案",
  settings: "連線與設定",
  guide: "使用指南",
  localWorkspace: "本機工作空間",
  quickGo: "搜尋",
  quickbarCapture: "捕捉",
  /** Profile row name when no GitHub login is known. */
  profileFallback: "我的工作台",
  streakTitle: (days: number) => `連續 ${days} 天`,
  streakBody: "習慣正在長出來。",
  streakZero: "今天開始第一天。",
  streakLink: "看看本週 ↗",
} as const;

/** Sidebar nav labels and the units their mono counts carry in aria-label. */
export const NAV = {
  today: "今日",
  bot: "Personal Bot",
  inbox: "收件匣",
  calendar: "行事曆",
  tasks: "待辦",
  work: "作業與專案",
  workDev: "專案",
  events: "活動",
  ideas: "靈感",
  habits: "習慣",
  settings: "連線與設定",
  guide: "使用指南",
  setup: "開始使用",
  notFound: "找不到頁面",
} as const;

export const NAV_COUNT_LABELS = {
  today: (n: number) => `${n} 件待處理`,
  inbox: (n: number) => `${n} 封未讀`,
  tasks: (n: number) => `${n} 件進行中`,
  work: (n: number) => `${n} 件近期到期或待審查`,
  events: (n: number) => `${n} 個新建議`,
  habits: (n: number) => `今天還差 ${n} 個`,
} as const;

export const SYNC = {
  ok: "已同步",
  syncing: "同步中…",
  warn: (n: number) => `${n} 個來源需要注意`,
  none: "尚未連接來源",
  offline: "無法連線",
  okAria: (time: string) => `所有來源已同步，${time}。開啟連線與設定`,
  syncingAria: "來源同步中。開啟連線與設定",
  warnAria: (n: number) => `${n} 個來源需要注意。開啟連線與設定`,
  noneAria: "還沒有連接任何來源。開啟連線與設定",
  offlineAria: "無法連線至本機服務。開啟連線與設定",
} as const;

export const THEME = {
  toDark: "切換深色模式",
  toLight: "切換淺色模式",
  current: { system: "目前：跟隨系統", light: "目前：淺色", dark: "目前：深色" },
  options: { system: "跟隨系統", light: "淺色", dark: "深色" },
} as const;

export const PALETTE = {
  label: "快速前往與快速新增",
  placeholderGo: "搜尋頁面，或輸入「+」快速新增…",
  placeholderCapture: "記下任何事…",
  sectionQuickAdd: "快速新增",
  sectionAi: "AI 解析 · 規則看不懂時",
  sectionGo: "前往",
  sectionSearch: "搜尋",
  noMatch: "沒有符合的頁面。",
  captureSoon: "快速新增還在建置中，先用「前往」切換頁面。",
  footSelect: "選擇",
  footGo: "前往",
  footClose: "關閉",
  footTab: "切換類型",
  footAi: "交給 AI",
  close: "esc",
} as const;

/** `.ai-tag` labels (SPEC-ux §1 rule 2, §4.2, §6.6). */
export const AI_TAGS = {
  summary: "AI 摘要",
  suggestion: "AI 建議",
  rule: "規則整理",
  ruleParse: "規則解析",
} as const;

export const DIALOG = {
  close: "關閉視窗",
} as const;

export const HELP = {
  title: "鍵盤快捷鍵",
  intro: "單鍵快捷鍵可以在 連線與設定 › 外觀 關閉。輸入文字或使用注音輸入法時不會觸發。",
  scopes: {
    everywhere: "任何頁面",
    list: "清單（今天、收件匣、待辦）",
    habits: "今天、習慣",
    inbox: "收件匣",
    toast: "復原提示出現時",
  },
  then: "接著",
} as const;

export const TOAST = {
  undo: "復原",
  retry: "重試",
  dismiss: "關閉提示",
  regionLabel: "通知",
} as const;

/** Undo-toast text per queue action (SPEC-ux §10 "Toasts"). */
export const ACTION_TOASTS = {
  archive: (title: string) => `已封存「${title}」`,
  read: (title: string) => `已標為已讀「${title}」`,
  readMany: (n: number) => `已將 ${n} 封標為已讀`,
  done: (title: string) => `已完成「${title}」`,
  submitted: (title: string) => `已標為已交「${title}」`,
  reviewed: (title: string) => `已標為已審查「${title}」`,
  snooze: (when: string) => `已延後到${when}`,
  snoozeGeneric: (title: string) => `已延後「${title}」`,
  calendar: (title: string, when?: string) => `已加入行事曆「${title}」${when ? `· ${when}` : ""}`,
  going: (title: string) => `已標為要參加「${title}」`,
  todo: (title: string, when?: string) => `已加入待辦「${title}」${when ? `· ${when}` : ""}`,
  dismiss: (title: string) => `已略過「${title}」`,
  schedule: (title: string) => `已排進行事曆「${title}」`,
  trash: (title: string) => `已移到垃圾桶「${title}」`,
  unarchive: (title: string) => `已移回收件匣「${title}」`,
  assignment: (title: string, when?: string) => `已加入作業「${title}」${when ? `· ${when}` : ""}`,
  idea: "已記下靈感",
  habitUndo: (habit: string) => `已取消「${habit}」的打卡`,
} as const;

/** Labels used in error toasts: 「{label}失敗：{reason}」. */
export const ACTION_LABELS = {
  reply: "回覆",
  open: "開啟",
  archive: "封存",
  read: "標為已讀",
  todo: "轉待辦",
  snooze: "延後",
  done: "完成",
  submitted: "標為已交",
  reviewed: "標為已審查",
  calendar: "加入行事曆",
  going: "要參加",
  dismiss: "略過",
  schedule: "排進",
  trash: "刪除",
  unarchive: "移回收件匣",
  assignment: "轉成作業",
} as const;

export const ERRORS = {
  offline: "無法連線至本機服務，請確認 BELL Personal 正在執行。",
  actionFailed: (label: string, reason: string) => `${label}失敗：${reason}`,
  undoFailed: (reason: string) => `沒有復原：${reason}`,
  /** A deferred remote write failed without a reason from the server. */
  remoteFailed: "沒有送出，項目已放回佇列。",
  todayTitle: "今天的資料暫時無法載入",
  todayHint: (reason: string) => `${reason}其他頁面仍可使用。`,
  retry: "重試",
} as const;

/** Route-level code splitting (src/app/routes.tsx): a page's code is still loading, or failed to load. */
export const ROUTE_LOAD = {
  loading: "正在載入這一頁…",
  failedTitle: "無法載入這個頁面",
  failedHint: "可能是網路中斷，或 BELL Personal 剛更新過；請重新載入這一頁。",
  reload: "重新載入",
} as const;

export const STALE = {
  showing: (time: string) => `顯示 ${time} 的資料`,
  refresh: "重新整理",
} as const;

export const BUTTONS = {
  backToToday: "回到今天",
  retry: "重試",
  refresh: "重新整理",
  captureOne: "記下一件事",
} as const;

export const FORMS = {
  required: "必填",
  optional: "選填",
  on: "開啟",
  off: "關閉",
} as const;

/** Strings for the Today placeholder only (the Today team brings src/copy/today.ts). */
export const TODAY_STUB = {
  loading: "正在載入今天的資料…",
  counts: (open: number, handled: number, total: number) => `還有 ${open} 件待處理 · 已處理 ${handled} / ${total} 件`,
} as const;

/** Route tab labels (SPEC-ux §3.1, §3.3). */
export const SETTINGS_TAB_LABELS = {
  sources: "帳號與來源",
  brief: "每日摘要",
  appearance: "外觀",
  privacy: "資料與隱私",
} as const;

export const WORK_TAB_LABELS = {
  assignments: "作業",
  projects: "專案",
  github: "GitHub",
} as const;

export const TAB_GROUP_LABELS = {
  settings: "設定分頁",
  work: "作業與專案分頁",
} as const;

export const APPEARANCE = {
  theme: "主題",
  themeHint: "跟隨系統時，會隨裝置的深色模式切換。",
  singleKey: "單鍵快捷鍵",
  singleKeyHint: "關閉後，只保留 ⌘K / Ctrl K、方向鍵、Enter 與 Esc。",
  /** The action named in 「{label}失敗：{reason}」 when saving to the server fails. */
  save: "儲存外觀設定",
} as const;

export const BUILDING = {
  title: "建置中",
  hint: "這一頁正在建置，先回到今天看看。",
} as const;

/** Page heads keep their product sentences; empty optional lines are not rendered. */
export const PAGE_HEADS = {
  today: { eyebrow: "", title: "把今天安排得剛剛好。", sub: "" },
  bot: { eyebrow: "", title: "Personal Bot", sub: "" },
  inbox: { eyebrow: "", title: "先處理需要你回覆的。", sub: "" },
  calendar: { eyebrow: "", title: "把今天安排得剛剛好。", sub: "" },
  tasks: { eyebrow: "", title: "一件一件來。", sub: "" },
  work: { eyebrow: "", title: "作業、專案和 PR，都在這裡。", sub: "" },
  events: { eyebrow: "", title: "值得去的，先標起來。", sub: "" },
  ideas: { eyebrow: "", title: "讓好靈感不再溜走。", sub: "" },
  habits: { eyebrow: "", title: "小習慣，天天累積。", sub: "" },
  settings: { eyebrow: "", title: "連線與設定", sub: "憑證只保存在這台電腦，瀏覽器不會儲存任何密碼。" },
  googleGuide: { eyebrow: "", title: "連接 Google 帳號", sub: "照著步驟建立用戶端，Gmail 和行事曆就會自動同步。" },
  setup: { eyebrow: "", title: "先用起來，之後再連。", sub: "不用設定就能記待辦、靈感和習慣，來源可以慢慢接上。" },
  guide: { eyebrow: "", title: "怎麼用最順手。", sub: "" },
  notFound: { eyebrow: "", title: "找不到這一頁。", sub: "" },
} as const;

/** Weekday eyebrow tokens (SPEC-ux §4.2: `MON · 10/12`). */
export const WEEKDAYS_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/** Shortcut descriptions for the `?` dialog and the queue legend (SPEC-ux §6.2, §4.3 footer). */
export const SHORTCUT_LABELS = {
  palette: { label: "開啟快速前往", short: "快速前往" },
  capture: { label: "快速記下（今天頁的輸入框，其他頁開啟快速新增）", short: "記下" },
  help: { label: "顯示所有快捷鍵", short: "全部" },
  goToday: { label: "前往今天", short: "今天" },
  goBot: { label: "前往 Personal Bot", short: "Bot" },
  goInbox: { label: "前往收件匣", short: "收件匣" },
  goCalendar: { label: "前往行事曆", short: "行事曆" },
  goTasks: { label: "前往待辦", short: "待辦" },
  goWork: { label: "前往作業與專案", short: "作業與專案" },
  goEvents: { label: "前往活動", short: "活動" },
  goIdeas: { label: "前往靈感", short: "靈感" },
  goHabits: { label: "前往習慣", short: "習慣" },
  next: { label: "移到下一項", short: "移動" },
  prev: { label: "移到上一項", short: "移動" },
  primary: { label: "執行這一項的主要動作", short: "主要動作" },
  close: { label: "處理完：封存、標為已讀、完成、標為已交、標為已審查或略過", short: "處理完" },
  snooze: { label: "延後；在待辦頁，替沒有期限的待辦排日期", short: "延後" },
  todo: { label: "轉成待辦", short: "轉待辦" },
  calendar: { label: "加入行事曆或要參加", short: "行事曆" },
  expand: { label: "展開或收合，不移動游標", short: "展開" },
  escape: { label: "關閉彈出選單、指令面板，或收合目前這一列", short: "關閉" },
  undo: { label: "復原最近一個動作", short: "復原" },
  habits: { label: "切換第 1–9 個習慣今天的打卡", short: "打卡" },
  trash: { label: "刪除信件（移到 Gmail 垃圾桶）", short: "刪除" },
  assignment: { label: "把信轉成作業，或加入建議的作業", short: "轉作業" },
  search: { label: "搜尋信件", short: "搜尋" },
  images: { label: "顯示這封信的外部圖片（經由你的伺服器載入）", short: "顯示圖片" },
} as const;

export function commonCopy() {
  const copy = onboardingCopy();
  return {
    META: {
      title: copy.meta.documentTitle,
      titleFor: (page: string) => format(copy.meta.titleFor, { page }),
      brandLabel: copy.meta.brandLabel,
      description: copy.meta.description,
    },
    SHELL: {
      ...SHELL,
      ...copy.shell,
      todayLabel: copy.nav.today,
      projectsLabel: copy.nav.workDev,
      settings: copy.settings.title,
      guide: copy.nav.guide,
      srParens: (label: string) => format(copy.shell.srParens, { label }),
      streakTitle: (days: number) => format(copy.shell.streak.title, { days }),
      streakZero: copy.shell.streak.zero,
      streakBody: copy.shell.streak.body,
      streakLink: copy.shell.streak.link,
    },
    NAV: { ...NAV, ...copy.nav, work: copy.nav.workStudent },
    NAV_COUNT_LABELS: {
      today: (n: number) => format(copy.navCount.today, { n }),
      inbox: (n: number) => format(copy.navCount.inbox, { n }),
      tasks: (n: number) => format(copy.navCount.tasks, { n }),
      work: (n: number) => format(copy.navCount.work, { n }),
      events: (n: number) => format(copy.navCount.events, { n }),
      habits: (n: number) => format(copy.navCount.habits, { n }),
    },
    SYNC: {
      ok: copy.sync.ok,
      syncing: copy.sync.syncing,
      warn: (n: number) => format(copy.sync.warn, { n }),
      none: copy.sync.none,
      offline: copy.sync.offline,
      okAria: (time: string) => format(copy.sync.okAria, { time }),
      syncingAria: copy.sync.syncingAria,
      warnAria: (n: number) => format(copy.sync.warnAria, { n }),
      noneAria: copy.sync.noneAria,
      offlineAria: copy.sync.offlineAria,
    },
    THEME: copy.theme,
    APPEARANCE: copy.appearance,
    ERRORS: {
      ...ERRORS,
      offline: copy.googleGuide.offline,
      actionFailed: (label: string, reason: string) => format(copy.googleGuide.actionFailed, { label, reason }),
    },
    PAGE_HEADS: {
      ...PAGE_HEADS,
      settings: { ...PAGE_HEADS.settings, title: copy.settings.title, sub: copy.settings.lead },
      googleGuide: { ...PAGE_HEADS.googleGuide, title: copy.googleGuide.title, sub: copy.googleGuide.sub },
    },
  };
}
