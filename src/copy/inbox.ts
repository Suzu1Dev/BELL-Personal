/**
 * #/inbox strings (SPEC-ux §3.3, §6.4, §10). zh-TW, full-width punctuation,
 * `·` separators, buttons that start with a verb.
 */
import type { InboxCategory } from "../../shared/mail";

export const INBOX = {
  listTitle: "收件匣",
  listCountLabel: (n: number) => `${n} 個對話`,
  readerLabel: "閱讀窗格",
  filterLabel: "依分類篩選",
  all: "全部",
  sub: (unread: number) => (unread ? `${unread} 封未讀` : ""),
  syncNow: "立即同步",
  syncing: "同步中…",
  markAllRead: "全部標為已讀",
  markAllReadLabel: (category: string) => `把「${category}」全部標為已讀`,
  openInGmail: "在 Gmail 開啟",
  back: "回到收件匣",
  snoozedNote: (n: number) => `另有 ${n} 封延後中，時間到了會回到這裡。`,
  replying: "回覆中…",
  replied: "已回覆",
  handledTodo: "已轉成待辦",
  mine: "我",
  textOnly: "只顯示純文字內容，不載入圖片與連結預覽。",
  noText: "這封信只有預覽片段，完整內容請在 Gmail 開啟。",
  suggestionsTitle: "從這封信找到",
  unreadPrefix: "未讀，",
  loading: "正在載入這封信…",
  archived: "已封存",
  trashed: "在垃圾桶",
  converted: "已轉成作業",
  liveNote: "這封信不在本機快取，內容是剛從 Gmail 讀取的純文字，只暫存幾分鐘。",
} as const;

/**
 * The reader's 用 AI 處理: the model reads the conversation and proposes what
 * to add to the calendar, the todos or the assignments; the proposals are
 * listed under 從這封信找到, each added with one tap.
 */
export const MAIL_PROCESS = {
  action: "用 AI 處理",
  hint: "AI 讀這封信，找出要加入行事曆、待辦或作業的事，由你確認後才加入。",
  working: "處理中…",
  /** Announced once while the model works; the visible line shows the server's progress. */
  progress: "AI 正在讀這封信，找出要加入行事曆、待辦或作業的事…",
  added: (n: number) => `AI 找到 ${n} 個項目，請在下方「從這封信找到」確認要不要加入。`,
  nothingNew: "AI 沒有找到新的項目，先前找到的都列在下方。",
  handled: "AI 找到的項目先前都已經加入或略過了。",
  none: "AI 看過了，這封信沒有要加入行事曆、待辦或作業的事。",
  failed: (reason: string) => `AI 沒有處理這封信：${reason.replace(/。$/, "")}。`,
} as const;

/** The 收件匣 · 封存 · 全部 switch (SPEC-mail-assignments §3.1, §7.1). */
export const INBOX_VIEWS = {
  label: "信件範圍",
  inbox: "收件匣",
  archive: "封存",
  all: "全部",
} as const;

/** Archived mail and search (SPEC-mail-assignments §3–§4, §7). */
export const MAIL_SEARCH = {
  label: "搜尋信件",
  placeholder: "搜尋信件",
  clear: "清除搜尋",
  archiveGroup: "封存的信",
  allGroup: "所有信件",
  byDate: "依收到時間排列",
  matches: (q: string) => `符合「${q}」的信`,
  moreInGmail: "Gmail 中其他符合的信",
  loadMore: "載入更多",
  loadingMore: "載入中…",
  noMore: "沒有更多信了。",
  loadingArchive: "正在載入封存的信…",
  loadingAll: "正在載入信件…",
  searching: "正在搜尋 Gmail…",
  searchAll: "在全部信件中搜尋",
  found: (n: number) => `找到 ${n} 封符合的信`,
  notFound: "沒有找到符合的信",
  loaded: (n: number) => `載入了 ${n} 封`,
  loadMoreFailed: (reason: string) => `載入更多失敗：${reason}`,
  expired: "搜尋結果已經過期，請重新搜尋。",
  /** The palette's 信件 section (§4.4). */
  paletteSection: "信件",
  paletteOption: (text: string) => `搜尋信件「${text}」`,
  paletteMeta: "在所有信件中搜尋",
  paletteEnter: "搜尋",
} as const;

export const MAIL_SEARCH_EMPTY = {
  archiveTitle: "沒有封存的信。",
  archiveHint: "在收件匣按 E 封存的信會出現在這裡。",
  allTitle: "信箱是空的。",
  allHint: "新信會在同步後出現在這裡。",
  noResultTitle: (q: string) => `找不到符合「${q}」的信。`,
  noResultHint: "換個關鍵字，或在全部信件中再找一次。",
  noResultHintAll: "換個關鍵字試試，也可以用 from: 或 subject: 縮小範圍。",
  notConnectedTitle: "還沒有連接 Gmail。",
  notConnectedHint: "連接 Google 帳號後，就能在這裡看到封存的信。",
} as const;

export const MAIL_SEARCH_NOTICES = {
  archiveFailedTitle: "封存的信暫時無法載入",
  cachedRows: "先顯示這台電腦上已同步的信。",
  searchFailedTitle: "Gmail 搜尋暫時無法使用",
  searchFailedBody: (reason: string) => `先顯示這台電腦上已同步的信中符合的結果。${reason}`,
  notConnectedTitle: "Gmail 尚未連接",
  notConnectedArchive: "只顯示這台電腦上已同步、之後封存的信。連接 Google 後可以看到所有封存的信。",
  notConnectedSearch: "只搜尋這台電腦上已同步的信。連接 Google 後可以搜尋整個信箱。",
} as const;

/**
 * Gmail is not connected: 封存 · 標為已讀 · 刪除 · 移回收件匣 write to Gmail and
 * would be refused, so they stay on screen but cannot run (buttons dimmed,
 * keys answered with the same sentence as a toast).
 */
export const GMAIL_OFFLINE = {
  verbs: { archive: "封存", read: "標為已讀", trash: "刪除", unarchive: "移回收件匣" } as Record<string, string>,
  message: (verbs: string) => `Gmail 尚未連線，無法${verbs}；請先到設定連線 Gmail。`,
  settings: "前往設定",
} as const;

/** Row actions without opening (SPEC-mail-assignments §2, §7.1): compact hover buttons and the swipe tray. */
export const ROW_ACTIONS = {
  archive: (subject: string) => `封存「${subject}」`,
  restore: (subject: string) => `移回收件匣「${subject}」`,
  trash: (subject: string) => `刪除「${subject}」`,
  archiveTitle: "封存（E）",
  restoreTitle: "移回收件匣（E）",
  /** Tooltips when E is another action on that row (標為已讀 on unread notices). */
  archiveShortTitle: "封存",
  restoreShortTitle: "移回收件匣",
  trashTitle: "刪除（#）",
  archiveShort: "封存",
  restoreShort: "移回",
  trashShort: "刪除",
  trayLabel: (subject: string) => `「${subject}」的動作`,
} as const;

export const INBOX_CATEGORY_LABELS: Record<InboxCategory, string> = {
  "needs-reply": "需要回覆",
  bill: "帳單",
  school: "學校",
  invitation: "活動邀請",
  newsletter: "電子報",
  notification: "通知",
  other: "其他",
};

export const INBOX_EMPTY = {
  title: "收件匣清空了。",
  hint: "新信會在同步後出現在這裡。",
  category: (label: string) => `「${label}」沒有信。`,
  pickTitle: "選一封信來看。",
  pickHint: "按 J、K 移動，Enter 回覆，E 封存。",
  notConnectedTitle: "還沒有連接 Gmail。",
  notConnectedHint: "連接 Google 帳號後，信會自動分類，需要回覆的會排進今天的佇列。",
  connect: "連接 Google",
} as const;

export const INBOX_NOTICES = {
  loadFailedTitle: "收件匣暫時無法載入",
  readerFailedTitle: "這封信暫時無法載入",
  notConnectedTitle: "Gmail 尚未連接",
  notConnectedBody: "顯示的是先前同步的信。連接 Google 後會自動更新。",
  reconnectTitle: "Gmail 需要重新連線",
  reconnectBody: (time?: string) => `Google 的授權失效了，新信件不會出現在這裡，也不會列入今天的佇列。${time ? `上次同步 ${time}。` : ""}`,
  errorTitle: "Gmail 同步失敗",
  errorBody: (reason: string) => `${reason}先顯示已同步的信。`,
  reconnect: "重新連線",
  missing: "這封信已經不在收件匣，可能封存了或超過保留天數。",
  gone: "這封信已經不在 Gmail，可能已被永久刪除。",
} as const;


/** The reader's original layout (SPEC-mail-html §6 copy deck). */
export const MAIL_BODY = {
  viewLabel: "顯示方式",
  original: "原始版面",
  plain: "純文字",
  frameTitle: "信件內容",
  loading: "正在載入原始版面…",
  blockedTitle: "已封鎖外部圖片，保護你的隱私。",
  showImages: "顯示圖片",
  trustSender: (sender: string) => `一律顯示「${sender}」的圖片`,
  trustSenderLabel: (sender: string) => `之後一律顯示「${sender}」寄來的信中的圖片`,
  trackers: (n: number) => `已擋下 ${n} 個追蹤像素。`,
  proxied: "圖片經由你的伺服器載入：寄件者看不到你的裝置或瀏覽器，但會看到伺服器的 IP 位址。",
  imagesFailed: (reason: string) => `外部圖片沒有載入：${reason}`,
  trusted: (sender: string) => `你信任「${sender}」，圖片會自動經由你的伺服器載入。`,
  manage: "管理",
  fallback: {
    "too-large": "這封信的版面太大，先顯示純文字。",
    unsafe: "這封信的版面無法安全顯示，先顯示純文字。",
    "not-connected": "Gmail 尚未連接，只能顯示純文字。",
    failed: "原始版面暫時無法載入，先顯示純文字。",
  },
  retry: "重試",
  attachments: "圖片附件",
  openAttachment: (name: string) => `開啟圖片「${name}」`,
  attachmentRefused: "這張圖片無法顯示",
  sandboxNote: "原始版面在不能執行程式的框架中顯示；外部圖片要經過你的伺服器才會載入。",
  liveNote: "這封信不在本機快取，內容是剛從 Gmail 讀取的，只暫存幾分鐘。",
  trustToast: (sender: string) => `之後會自動顯示「${sender}」的圖片`,
  trustFailed: (reason: string) => `沒有加入信任的寄件者：${reason}`,
  viewFailed: (reason: string) => `儲存顯示方式失敗：${reason}`,
} as const;
