/**
 * 作業與專案 (#/work) strings: SPEC-ux §3.3, §5 and §10. `·` as the meta
 * separator, buttons start with a verb; the assignment form follows the app locale.
 */
import type { AssignmentStatus } from "../../shared/assignments";
import type { GitHubCheckState, GitHubReviewDecision } from "../../shared/github";
import type { ProjectColor, ProjectStatus } from "../../shared/projects";
import { format, onboardingCopy } from "./onboarding";

export const WORK_PAGE = {
  sync: "立即同步",
  syncing: "同步中…",
  /** The action named in 「同步失敗：{reason}」. */
  syncFailed: "同步",
  loadError: "這一頁的資料暫時無法載入",
  settings: "連線與設定",
  backToProjects: "所有專案",
  projectEyebrow: "PROJECT",
} as const;

export const ASSIGNMENTS = {
  title: "作業",
  countLabel: (n: number) => `${n} 份作業`,
  filterLabel: "依學校系統篩選",
  all: "全部",
  noDue: "沒有期限",
  emptyTitle: "這週沒有要交的作業。",
  emptyHint: "連接 E3 或 Canvas，或把老師寄來的作業信轉成作業。",
  emptyConnected: "新的作業會在同步後出現在這裡。",
  /* SPEC-mail-assignments §5.8, §7.4: assignments from mail and added by hand. */
  create: "新增作業",
  edit: "編輯",
  editAria: (title: string) => `編輯「${title}」`,
  openMail: "開啟信件",
  markedByYou: "你標為已交",
  suggestionsTitle: "從信件找到",
  suggestionsCount: (n: number) => `${n} 份作業建議`,
  skipAria: "略過這個建議",
  createdToast: (title: string) => `已新增作業「${title}」`,
  savedToast: "已儲存作業",
  deletedToast: (title: string) => `已刪除作業「${title}」`,
  deleteFailed: (reason: string) => `刪除作業失敗：${reason}`,
  connect: "連接學校系統",
  firstSync: "正在同步作業…",
  markSubmitted: "標為已交",
  markSubmittedTouch: "已交",
  open: (site: string) => `開啟 ${site}`,
  notYetShown: (site: string) => `${site} 還沒顯示繳交`,
  grade: (grade: string) => `成績 ${grade}`,
  missing: "缺交",
  submittedToast: (title: string) => `已標為已交「${title}」`,
  filteredEmpty: "這個來源目前沒有作業。",
  courseCount: (n: number) => `${n} 份`,
  sitesTitle: "學校系統",
  sitesCount: (n: number) => `${n} 個已連線`,
  notConnected: "尚未連線",
  connectOne: "連接",
  reconnect: "重新連線",
  account: (name: string | undefined, time: string | undefined) => [name, time ? `上次同步 ${time}` : undefined].filter(Boolean).join(" · "),
  purpose: { moodle: "Moodle 作業、測驗與繳交狀態。", canvas: "Canvas 的作業、測驗與缺交提醒。" },
  siteName: { moodle: "Moodle（E3）", canvas: "Canvas" },
  reconnectTitle: (site: string) => `${site} 登入已失效`,
  reconnectHint: (time: string | undefined) => `重新登入後會自動同步作業。${time ? `上次同步 ${time}。` : ""}`,
  errorTitle: (site: string) => `${site} 暫時沒有回應`,
  errorHint: (message: string | null, time: string | undefined) => `${message ?? "同步時發生問題，稍後會自動重試。"}${time ? `顯示 ${time} 的資料。` : ""}`,
} as const;

/** 新增作業 / 編輯作業 (SPEC-mail-assignments §5.8, §7.4). */
export function assignmentFormCopy() {
  const copy = onboardingCopy().assignmentForm;
  return {
    ...copy,
    fromMail: (sender: string) => format(copy.fromMail, { sender }),
    saveFailed: (reason: string) => format(copy.saveFailed, { reason }),
  };
}

export const ASSIGNMENT_FORM = {
  get openRoles() { return onboardingCopy().assignmentForm.openRoles; },
} as const;

/** Status pills (SPEC-ux §3.3): 未繳交 / 已交（本機） / 已繳交 / 逾期. */
export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  open: "未繳交",
  overdue: "逾期",
  local: "已交（本機）",
  submitted: "已繳交",
  graded: "已繳交",
};

export const PROJECTS = {
  title: "專案",
  countLabel: (n: number) => `${n} 個專案`,
  filterLabel: "依狀態篩選",
  all: "全部",
  create: "新增專案",
  emptyTitle: "還沒有專案。",
  emptyHint: "把期末專題、社團或自己的作品放進來，今天頁會提醒下一步。",
  filteredEmpty: "這個狀態目前沒有專案。",
  next: (text: string) => `下一步：${text}`,
  nextNone: "還沒有里程碑",
  nextAllDone: "里程碑都完成了",
  milestones: (done: number, total: number) => `${done}/${total} 個里程碑`,
  todos: (n: number) => `${n} 件待辦`,
  progressLabel: (name: string, pct: number) => `${name}，完成 ${pct}%`,
  upcomingTitle: "接下來的里程碑",
  weekday: (char: string) => `週${char}`,
  upcomingEmpty: "還沒有排日期的里程碑。",
  notFoundTitle: "找不到這個專案。",
  notFoundHint: "它可能已經被刪除了。",
  deleted: (name: string) => `已刪除專案「${name}」`,
  created: (name: string) => `已新增專案「${name}」`,
  saved: "已儲存專案",
} as const;

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "進行中",
  paused: "暫停",
  done: "已完成",
  archived: "已封存",
};

export const PROJECT_COLOR_LABELS: Record<ProjectColor, string> = {
  accent: "赤陶",
  mail: "藍",
  cal: "紫",
  task: "綠",
  event: "琥珀",
  idea: "玫瑰",
  habit: "青",
};

export const PROJECT_DETAIL = {
  edit: "編輯專案",
  milestonesTitle: "里程碑",
  milestonesCount: (done: number, total: number) => `完成 ${done} 個，共 ${total} 個`,
  milestonesEmpty: "還沒有里程碑，先寫下第一步。",
  addMilestone: "新增里程碑",
  milestonePlaceholder: "新增里程碑…",
  milestoneDate: "日期（選填）",
  add: "新增",
  noDate: "沒有日期",
  deleteMilestone: (title: string) => `刪除里程碑「${title}」`,
  toggleMilestone: (title: string) => `「${title}」完成`,
  milestoneDeleted: (title: string) => `已刪除里程碑「${title}」`,
  todosTitle: "待辦",
  todosLink: "待辦",
  todosEmpty: "還沒有待辦連到這個專案。",
  todosHint: "在待辦頁把待辦歸到這個專案，就會出現在這裡。",
  todoDone: "已完成",
  progressTitle: "進度",
  progressAuto: (done: number, total: number) => (total ? `依里程碑計算 · ${done}/${total} 完成` : "依里程碑計算 · 還沒有里程碑"),
  progressManual: "手動設定",
  reposTitle: "連結的 Repo",
  reposEmpty: "還沒有連結 repo。",
  reposHint: "在「編輯專案」加上 owner/name，PR 和 issue 會出現在這裡。",
  repoCounts: (prs: number, issues: number) => `${prs} 個 PR · ${issues} 個 issue`,
  repoQuiet: "沒有進行中的 PR 或 issue",
} as const;

export const PROJECT_FORM = {
  createTitle: "新增專案",
  editTitle: "編輯專案",
  name: "名稱",
  namePlaceholder: "例如：OS 期末專題",
  description: "說明",
  descriptionHint: "一兩句話說明這個專案要做什麼。",
  color: "顏色",
  status: "狀態",
  repos: "連結的 GitHub repo",
  reposHint: "每行一個，格式是 owner/name。",
  reposError: (line: string) => `「${line}」不是 owner/name 格式。`,
  progressManual: "手動設定進度",
  progressHint: "關閉時依完成的里程碑計算。",
  progress: "進度（%）",
  firstMilestone: "第一個里程碑（選填）",
  firstMilestonePlaceholder: "例如：題目提案",
  save: "儲存",
  create: "建立專案",
  cancel: "取消",
  delete: "刪除專案",
  nameRequired: "請輸入專案名稱。",
} as const;

export const GITHUB = {
  reviewsTitle: "請你審查",
  reviewsCount: (n: number) => `${n} 個 PR 等你審查`,
  reviewsEmpty: "沒有等你審查的 PR。",
  prsTitle: "我的 PR",
  prsCount: (n: number) => `${n} 個開啟中的 PR`,
  prsEmpty: "沒有開啟中的 PR。",
  issuesTitle: "指派給我",
  issuesCount: (n: number) => `${n} 個 issue`,
  issuesEmpty: "沒有指派給你的 issue。",
  notificationsTitle: "通知",
  notificationsCount: (n: number) => `${n} 則未讀`,
  notificationsEmpty: "通知都看完了。",
  markAllRead: "全部標為已讀",
  markRead: "標為已讀",
  markReadOne: (title: string) => `把「${title}」標為已讀`,
  readToast: (n: number) => (n === 1 ? "已標為已讀" : `已將 ${n} 則通知標為已讀`),
  reviewed: "標為已審查",
  reviewedTouch: "已審查",
  reviewedPill: "已審查",
  reviewedToast: (title: string) => `已標為已審查「${title}」`,
  startReview: "開始審查",
  startReviewTouch: "審查",
  openOnGitHub: "在 GitHub 開啟",
  open: "開啟",
  requestedBy: (who: string) => `${who} 請你審查`,
  changesBy: (who: string) => `${who} 要求修改`,
  waiting: (days: number) => `等待審查 ${days} 天`,
  waitingToday: "等待審查",
  draft: "草稿",
  updated: (when: string) => `更新於 ${when}`,
  accountTitle: "GitHub 帳號",
  accountLine: (login: string | undefined, time: string | undefined) => [login, time ? `上次同步 ${time}` : undefined].filter(Boolean).join(" · "),
  contributions: (week: number, month: number) => `最近 7 天 ${week} 次貢獻 · 30 天 ${month} 次`,
  notConnectedTitle: "GitHub 尚未連線",
  notConnectedHint: "在伺服器登入 GitHub CLI（gh）後，PR、審查和通知就會出現在這裡。",
  /** gh's login on the host died (server GH_RECONNECT_MESSAGE says the same): only `gh auth login` there fixes it. */
  reconnectTitle: "GitHub 連線已失效",
  reconnectHint: (time: string | undefined) => `請在執行 BELL Personal 的主機上重新登入 GitHub CLI，再按重試。${time ? `上次同步 ${time}。` : ""}`,
  errorTitle: "GitHub 暫時沒有回應",
} as const;

export const CHECK_LABELS: Record<GitHubCheckState, string> = {
  SUCCESS: "檢查通過",
  FAILURE: "檢查沒有通過",
  ERROR: "檢查出錯",
  PENDING: "檢查中",
  EXPECTED: "等待檢查",
};

export const REVIEW_PILLS: Record<GitHubReviewDecision | "DRAFT" | "NONE", string> = {
  APPROVED: "已核准",
  CHANGES_REQUESTED: "要求修改",
  REVIEW_REQUIRED: "等待審查",
  DRAFT: "草稿",
  NONE: "等待審查",
};

/** GitHub notification reasons, shown in the meta line. */
export const NOTIFICATION_REASONS: Record<string, string> = {
  review_requested: "請你審查",
  mention: "提到你",
  team_mention: "提到你的團隊",
  assign: "指派給你",
  author: "你發起的",
  comment: "新留言",
  ci_activity: "CI 狀態",
  state_change: "狀態變更",
  subscribed: "訂閱",
  manual: "訂閱",
  security_alert: "安全性警告",
  invitation: "邀請",
  approval_requested: "等待核准",
};
