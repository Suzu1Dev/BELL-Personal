/**
 * 連線與設定 strings (SPEC-ux §3.3 連線與設定, §3.4 Google guide, §5 source
 * card states). Never an environment variable name, a path or raw CLI output.
 * The page head (eyebrow, H1, lead line) is PAGE_HEADS in common.ts.
 */
import type { GoogleErrorReason } from "../../shared/connect";
import type { ReasoningEffort } from "../../shared/models";
import { format, onboardingCopy } from "./onboarding";

export const SETTINGS = {
  /** The page-head link back to the first-run steps (#/setup has no nav entry). */
  setup: "回到新手設定",
  saved: "已儲存",
  saveFailed: "儲存設定",
  loadFailed: "設定暫時無法載入",
  loadFailedHint: "請確認 BELL Personal 正在執行，再重新整理。",
  retry: "重試",
  cancel: "取消",
  close: "關閉",
  lastSync: (time: string) => `上次同步 ${time}`,
  neverSynced: "還沒有同步過",
  syncNow: "立即同步",
  syncStarted: (label: string) => `已開始同步「${label}」`,
  disconnect: "中斷連線",
  connect: "連接",
  reconnect: "重新連線",
  account: (name: string) => `已連線為 ${name}`,
  vaultOffTitle: "伺服器還沒有設定加密金鑰",
  vaultOffBody: "需要帳號密碼或權杖的來源（Google、E3、Canvas、私人行事曆）暫時無法連線；其他功能照常。請依部署說明完成設定後重新啟動服務。",
} as const;

/** Source cards (SPEC-ux §3.3 帳號與來源, state 04). */
export const SOURCES = {
  google: {
    name: "Google 帳號",
    purpose: "Gmail 摘要與 Google 行事曆。一鍵前往 Google 授權即可同步。",
    notAuthorized: "尚未授權",
    connect: "連接 Google",
    reconnect: "重新連線 Google",
    guide: "連線選項",
    missing: (what: string) => `沒有授權：${what}`,
    scopes: { gmail: "Gmail", calendarRead: "讀取行事曆", calendarWrite: "新增行程" },
    disconnectTitle: "中斷 Google 連線？",
    disconnectBody: "會撤銷授權並刪除這台電腦上快取的信件和行程。用戶端設定會保留，之後可以直接重新連接。",
    disconnectConfirm: "中斷連線",
    disconnectKeep: "保留連線",
    disconnected: "已中斷 Google 連線",
    disconnectedLocal: "已在這台電腦中斷連線；Google 暫時沒有回應，可到 Google 帳戶權限頁再移除一次。",
    connected: "已連接 Google 帳號",
    connectedMissing: (what: string) => `已連接 Google 帳號，但沒有授權：${what}`,
  },
  moodle: {
    name: "NYCU E3（Moodle）",
    purpose: "作業和截止時間。只讀取，不會替你繳交。",
    connect: "連接 E3",
    baseUrl: "E3 網址",
    username: "學號",
    password: "密碼",
    passwordHint: "密碼只用一次換取權杖，不會儲存。",
    submit: "連接",
    connected: (name: string) => `已連接 E3${name ? `（${name}）` : ""}`,
    disconnectTitle: "中斷 E3 連線？",
    disconnectBody: "會刪除權杖和快取的作業，之後要重新輸入學號和密碼。",
    disconnected: "已中斷 E3 連線",
  },
  canvas: {
    name: "Canvas",
    purpose: "其他學校的 Canvas 作業。用個人存取權杖讀取。",
    connect: "連接 Canvas",
    baseUrl: "Canvas 網址",
    token: "存取權杖",
    tokenHint: "在 Canvas 的「帳號 › 設定 › 新增存取權杖」產生，只會加密保存在這台電腦。",
    submit: "連接",
    connected: (name: string) => `已連接 Canvas${name ? `（${name}）` : ""}`,
    disconnectTitle: "中斷 Canvas 連線？",
    disconnectBody: "會刪除權杖和快取的作業。",
    disconnected: "已中斷 Canvas 連線",
  },
  github: {
    name: "GitHub",
    purpose: "請你審查的 PR、你的 PR 和指派給你的 issue。",
    detected: (login: string) => `已偵測到 GitHub 帳號 ${login}`,
    missing: "沒有偵測到 GitHub 登入。在伺服器上登入 GitHub CLI 後，這裡會自動接上。",
  },
  ctftime: {
    name: "CTFtime",
    purpose: "即將舉行的 CTF。權重夠高的會出現在今天的佇列問你要不要參加。",
    enabled: "顯示 CTFtime 活動",
    minWeight: "最低權重",
    minWeightHint: "低於這個權重的 CTF 只列在活動頁，不進佇列。",
  },
  feeds: {
    name: "活動訂閱",
    purpose: "RSS、Atom 或 iCal 訂閱，例如 KKTIX 主辦單位或社群行事曆。",
    empty: "還沒有訂閱。",
    url: "訂閱網址",
    urlHint: "私人行事曆網址（含金鑰）會加密保存，畫面只顯示網域。",
    label: "名稱",
    labelPlaceholder: "例如：g0v 行事曆",
    add: "加入訂閱",
    added: (label: string) => `已加入訂閱「${label}」`,
    remove: "移除",
    removeLabel: (label: string) => `移除訂閱「${label}」`,
    removed: (label: string) => `已移除訂閱「${label}」`,
    events: (n: number) => `${n} 個活動`,
    kinds: { rss: "RSS", atom: "Atom", ics: "iCal" } as Record<string, string>,
    secret: "私人網址",
    failedToLoad: "訂閱清單暫時無法載入。",
    listLabel: "目前的訂閱",
  },
  weather: {
    name: "天氣",
    purpose: "今天頁開頭的氣溫和降雨提醒，資料來自 Open-Meteo。",
    enabled: "顯示天氣",
    city: "城市",
    current: (name: string) => `目前：${name}`,
    search: "搜尋城市",
    searchPlaceholder: "例如：新竹",
    searchSubmit: "搜尋",
    noResults: "找不到這個城市，換個寫法試試。",
    choose: "選擇",
    /** The accessible name of each result's 選擇, so a button list does not read 「選擇、選擇」. */
    chooseLabel: (label: string) => `選擇「${label}」`,
    chosen: (name: string) => `天氣改用「${name}」`,
    resultsLabel: "搜尋結果",
  },
  bellPr: {
    name: "BELL PR",
    purpose: "BELL Suite 貢獻與審查工作台。配對後可同步任務進度並讓 Personal Bot 直接查詢或啟動任務。",
    connect: "配對 BELL PR",
    codeLabel: "配對碼",
    codeHint: "在 BELL PR 產生一組配對碼，貼在這裡即可完成安全連線。",
    codePlaceholder: "輸入配對碼",
    pairSubmit: "完成配對",
    tokenToggle: "改用存取權杖連接",
    tokenLabel: "存取權杖",
    tokenPlaceholder: "貼上 BELL PR 權杖",
    tokenSubmit: "儲存權杖",
    openPr: "開啟 BELL PR",
    connectedEnv: "已透過部署設定連接",
    connectedDevice: (name: string) => `已配對（${name}）`,
    paired: "已連接 BELL PR",
    disconnectTitle: "中斷 BELL PR 連線？",
    disconnectBody: "會移除儲存在這台電腦上的配對權杖；之後可以隨時重新配對。",
    disconnected: "已中斷 BELL PR 連線",
  },
} as const;

/** ?google=error&reason=… after the OAuth round trip (shared/connect.ts GOOGLE_ERROR_REASONS). */
export const GOOGLE_RETURN_ERRORS: Record<GoogleErrorReason, string> = {
  vault: "伺服器還沒有設定加密金鑰，無法保存 Google 授權。",
  client: "還沒有填寫 Google 用戶端 ID 和密碼，請先完成設定指南。",
  state: "這次授權已過期，或不是從這裡開始的。請重新按「連接 Google」。",
  denied: "你在 Google 取消了授權，沒有連線。",
  exchange: "Google 沒有完成授權交換，請再試一次。",
  "no-refresh-token": "Google 沒有提供長期授權。請到 Google 帳戶移除 BELL Personal 的存取權後再連接一次。",
  "no-scopes": "沒有勾選 Gmail 或 Google 行事曆的權限，所以沒有連線。請重新連接並勾選需要的權限。",
};

export const GOOGLE_RETURN = {
  failed: (reason: string) => `沒有連上 Google：${reason}`,
  unknown: "Google 沒有完成授權，請再試一次。",
} as const;

/** Scope names shown after partial consent (`missing=gmail.modify,calendar.events`). */
export const SCOPE_LABELS: Record<string, string> = {
  "gmail.modify": "Gmail",
  "calendar.readonly": "讀取行事曆",
  "calendar.events": "新增行程",
};

/** #/settings/sources/google (SPEC-ux §3.4): every step says why. */
export const GOOGLE_GUIDE = {
  back: "帳號與來源",
  intro: "照順序做一次就好，大約 10 分鐘。每完成一步就勾起來，下次回來會記得做到哪裡。",
  stepsLabel: "設定步驟",
  progress: (done: number, total: number) => `已完成 ${done} / ${total} 步`,
  steps: [
    {
      id: "project",
      title: "建立專案",
      why: "Google Cloud 專案是放這個應用程式設定的地方，只有你自己會用到。",
      link: { label: "開啟 Google Cloud 新增專案", href: "https://console.cloud.google.com/projectcreate" },
    },
    {
      id: "apis",
      title: "啟用 Gmail 與 Calendar API",
      why: "沒有啟用 API，授權之後也讀不到信件和行程。兩個都要啟用。",
      link: { label: "開啟 API 程式庫", href: "https://console.cloud.google.com/apis/library" },
    },
    {
      id: "consent",
      title: "設定同意畫面（外部、發布為正式版）",
      why: "測試版的授權 7 天就會失效；發布為正式版，才不用每週重新連線。首頁和隱私權政策網址填下面這兩個。",
      link: { label: "開啟 OAuth 同意畫面", href: "https://console.cloud.google.com/apis/credentials/consent" },
    },
    {
      id: "client",
      title: "建立網頁用戶端",
      why: "應用程式類型選「網頁應用程式」，Google 才會把你送回這台電腦。",
      link: { label: "開啟憑證頁面", href: "https://console.cloud.google.com/apis/credentials" },
    },
    {
      id: "redirect",
      title: "複製重新導向網址",
      why: "貼到用戶端的「已授權的重新導向 URI」，要和這裡一模一樣，連結尾的斜線都不能多。",
    },
    {
      id: "secret",
      title: "下載用戶端密碼",
      why: "建立後 Google 會顯示用戶端 ID 和密碼；把兩個貼到下面的欄位，密碼只會加密保存在這台電腦。",
    },
  ],
  homeUrl: "應用程式首頁",
  privacyUrl: "隱私權政策",
  redirectLabel: "重新導向網址",
  copy: "複製",
  copied: "已複製",
  copyFailed: "沒有複製到剪貼簿，請手動選取網址。",
  stepDone: (title: string) => `完成「${title}」`,
  clientTitle: "用戶端 ID 與密碼",
  clientId: "用戶端 ID",
  clientIdPlaceholder: "1234567890-abc.apps.googleusercontent.com",
  clientSecret: "用戶端密碼",
  clientSaved: "已儲存用戶端",
  clientSavedHint: (hint: string) => `用戶端 ${hint} · 密碼已加密保存`,
  clientFromServer: "這台伺服器已經在設定檔提供用戶端，不需要在這裡輸入。",
  saveClient: "儲存用戶端",
  replaceClient: "更換用戶端",
  connectTitle: "連接",
  connectHint: "會前往 Google 登入並勾選權限；完成後自動回到這裡。",
  connect: "連接 Google",
  needClient: "先儲存用戶端 ID 和密碼，才能連接。",
  fallbackSummary: "Google 不接受這個網址？",
  fallbackIntro: "網頁用戶端只接受 https 網址。這時改用「電腦版應用程式」用戶端：Google 會把你導回本機網址，頁面打不開沒關係，把網址列整段複製貼回來就好。",
  fallbackSteps: [
    "在憑證頁面建立「電腦版應用程式」用戶端，把 ID 和密碼存到下面。",
    "按「用貼上網址連接」，在 Google 完成授權。",
    "Google 導回的頁面打不開時，複製網址列的完整網址，貼到下面的欄位。",
  ],
  saveDesktopClient: "儲存電腦版用戶端",
  pasteStart: "用貼上網址連接",
  pasteLabel: "貼上重新導向網址",
  pastePlaceholder: "http://127.0.0.1:…/oauth/google/callback?state=…&code=…",
  pasteSubmit: "完成連接",
  connectedTitle: "已連接",
  connectedAs: (email: string) => `已連線為 ${email}`,
  connectedAt: (when: string) => `${when} 連接`,
  grantedLabel: "已授權",
  missingLabel: "沒有授權",
  scopeNames: {
    openid: "身分",
    email: "電子郵件地址",
    "https://www.googleapis.com/auth/gmail.modify": "Gmail（讀取、封存、標為已讀）",
    "https://www.googleapis.com/auth/calendar.readonly": "讀取行事曆",
    "https://www.googleapis.com/auth/calendar.events": "新增和修改你確認的行程",
  } as Record<string, string>,
  vaultOff: "伺服器還沒有設定加密金鑰，用戶端密碼和授權無法保存。請依部署說明完成設定後重新啟動服務。",
} as const;

export const BRIEF_SETTINGS = {
  title: "每日摘要",
  aiEnabled: "使用 AI",
  aiEnabledHint: "關閉後不會呼叫任何模型：摘要改用規則整理，信件不分類，快速記下只用規則解析。",
  provider: "AI 服務",
  providerHint: "用伺服器上已登入的 CLI，不需要另外的 API 金鑰。",
  model: "模型",
  modelDefault: (name: string) => `預設（${name}）`,
  modelDefaultPlain: "預設",
  effort: "思考強度",
  effortDefault: "依模型預設",
  effortNone: "這個模型不支援思考強度。",
  cliReady: (name: string, version?: string) => `${name} 已登入${version ? ` · ${version}` : ""}`,
  cliNotLoggedIn: (name: string) => `${name} 尚未登入：請在伺服器的終端機登入後重新整理。`,
  cliMissing: (name: string) => `伺服器上找不到 ${name}。`,
  catalogError: "模型清單暫時無法載入。",
  autoTime: "自動產生時間",
  autoTimeHint: "每天這個時間整理一次今日摘要。",
  onFirstOpen: "也在每天第一次打開時產生",
  onFirstOpenHint: "如果還沒有今天的摘要，打開今天頁時就整理一份。",
  mailTriage: "AI 整理新信件",
  mailTriageHint: "同步後把新信分成待回覆、帳單、通知…；只產生建議，不會自動封存。",
  captureTidy: "自動整理快速記下的內容",
  // 復原 on the toast, or 復原整理 on the todo / local event later (an event already in Google Calendar cannot be changed back here).
  captureTidyHint: "新增待辦或行程後，AI 在背景把標題整理得簡潔、細節移到備註，日期不變；待辦和本機行程之後都能按「復原整理」改回來。",
  ideaTags: "AI 建議靈感標籤",
  ideaTagsHint: "新的靈感旁邊出現虛線標籤，點一下才會加上。",
  providerSaved: (name: string) => `已改用 ${name}`,
} as const;

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "不思考",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "極高",
};

export const APPEARANCE_SETTINGS = {
  weekStartsMonday: "一週從星期一開始",
  weekStartsMondayHint: "行事曆的週檢視和習慣的星期標頭從星期一排起。",
} as const;

export const PRIVACY_SETTINGS = {
  retention: "信件保留天數（天）",
  retentionHint: "超過這個天數的信件摘要、內文片段和 AI 分類會自動刪除；信本身一直在你的 Gmail。",
  purge: "清除快取的信件",
  purgeHint: "立刻刪除這台電腦上所有快取的信件資料，下次同步會重新抓取最近的信。",
  purgeTitle: "清除快取的信件？",
  purgeBody: "會刪除這台電腦上所有信件摘要、內文片段和 AI 分類，無法復原。Gmail 裡的信不受影響。",
  purgeConfirm: "清除信件",
  purgeKeep: "保留",
  purged: (n: number) => `已清除 ${n} 封快取的信件`,
  export: "匯出資料",
  exportHint: "下載一份 JSON，包含待辦、靈感、習慣、專案、行程與設定；不含任何密碼或權杖。",
  exportSources: "也包含來源快取（信件摘要、行程、作業和 AI 建議）",
  exportButton: "下載匯出檔",
  privacy: "隱私權政策",
  privacyHint: "說明哪些資料留在這台電腦、哪些會交給你自己的 AI CLI，以及怎麼撤銷 Google 授權。",
  privacyLink: "閱讀隱私權政策",
  local: "所有資料只保存在這台電腦；連線憑證另外加密保存，瀏覽器不會存任何密碼。",
} as const;

/** 資料與隱私 › 信件顯示 (SPEC-mail-html §6). */
export const MAIL_DISPLAY_SETTINGS = {
  title: "信件顯示",
  bodyView: "預設顯示方式",
  bodyViewHint: "原始版面會在不能執行程式的框架中顯示信件本身的排版；純文字只顯示文字內容。在信件裡切換也會記住。",
  original: "原始版面",
  plain: "純文字",
  trusted: "信任的寄件者",
  trustedHint: "這些寄件者的外部圖片會自動經由你的伺服器載入：寄件者看不到你的裝置或瀏覽器，但會看到伺服器的 IP 位址，也會知道信被打開；已知的追蹤像素不會載入。",
  trustedEmpty: "還沒有信任的寄件者。在信件裡按「一律顯示…的圖片」就會加到這裡。",
  trustedListLabel: "信任的寄件者清單",
  domain: "整個網域",
  address: "寄件者",
  remove: "移除",
  removeLabel: (entry: string) => `移除「${entry}」`,
  removed: (entry: string) => `已移除信任的寄件者「${entry}」`,
  add: "加入",
  addField: "新增信任的寄件者",
  addHint: "輸入信箱（news@example.com）或網域（example.com，包含子網域）。",
  placeholder: "news@example.com 或 example.com",
  added: (entry: string) => `已加入信任的寄件者「${entry}」`,
  invalid: "請輸入寄件者的信箱或網域，例如 news@example.com 或 example.com。",
  duplicate: "這個寄件者已經在清單裡了。",
  full: (n: number) => `最多 ${n} 個信任的寄件者，請先移除一些。`,
} as const;

/** Inline validation messages (settings-forms.ts). */
export const VALIDATION = {
  required: (label: string) => `請填寫${/^[A-Za-z0-9]/.test(label) ? " " : ""}${label}。`,
  https: "請輸入以 https:// 開頭的完整網址。",
  url: "請輸入完整網址，例如 https://example.com/feed.xml。",
  tooLong: (label: string, max: number) => `${label}最多 ${max} 個字。`,
  clientId: "用戶端 ID 應以 .apps.googleusercontent.com 結尾。",
  clientSecret: "用戶端密碼至少 8 個字，不可包含空白。",
  retention: (min: number, max: number) => `請輸入 ${min}–${max} 之間的天數。`,
  weight: (min: number, max: number) => `請輸入 ${min}–${max} 之間的權重。`,
  time: "請輸入 00:00–23:59 之間的時間。",
  pasteUrl: "請貼上瀏覽器網址列的完整網址，裡面要有 code=。",
} as const;

export function settingsCopy() {
  const copy = onboardingCopy();
  const guide = copy.googleGuide;
  const steps = GOOGLE_GUIDE.steps.map((step) => {
    const text = guide.steps[step.id];
    return {
      ...step,
      title: text.title,
      why: text.why,
      ...("link" in step && "linkLabel" in text ? { link: { ...step.link, label: text.linkLabel } } : {}),
    };
  });
  return {
    listSep: copy.listSep,
    SETTINGS: {
      ...SETTINGS,
      retry: copy.ai.errors.retry,
      loadFailed: guide.loadFailed,
      disconnect: guide.disconnect,
    },
    ERRORS: {
      offline: guide.offline,
      actionFailed: (label: string, reason: string) => format(guide.actionFailed, { label, reason }),
    },
    SOURCES: {
      ...SOURCES,
      google: {
        ...SOURCES.google,
        scopes: {
          gmail: copy.scopeLabels.gmailModify,
          calendarRead: copy.scopeLabels.calendarReadonly,
          calendarWrite: copy.scopeLabels.calendarEvents,
        },
        connected: guide.connectedTitle,
        connectedMissing: (what: string) => copy.listSep === ", " ? `${guide.connectedTitle} · ${guide.missingLabel}: ${what}` : SOURCES.google.connectedMissing(what),
        disconnectTitle: guide.disconnectTitle,
        disconnectBody: guide.disconnectBody,
        disconnectConfirm: guide.disconnectConfirm,
        disconnectKeep: guide.disconnectKeep,
        disconnected: guide.disconnected,
        disconnectedLocal: guide.disconnectedLocal,
      },
    },
    GOOGLE_RETURN_ERRORS: {
      ...GOOGLE_RETURN_ERRORS,
      ...copy.googleReturn.errors,
      "no-refresh-token": copy.googleReturn.errors.noRefreshToken,
      "no-scopes": copy.googleReturn.errors.noScopes,
    },
    GOOGLE_RETURN: {
      failed: (reason: string) => format(copy.googleReturn.failed, { reason }),
      unknown: copy.googleReturn.unknown,
    },
    SCOPE_LABELS: {
      "gmail.modify": copy.scopeLabels.gmailModify,
      "calendar.readonly": copy.scopeLabels.calendarReadonly,
      "calendar.events": copy.scopeLabels.calendarEvents,
    },
    GOOGLE_GUIDE: {
      ...GOOGLE_GUIDE,
      ...guide,
      steps,
      progress: (done: number, total: number) => format(guide.progress, { done, total }),
      stepDone: (title: string) => format(guide.stepDone, { title }),
      fallbackSteps: [guide.fallbackSteps["1"], guide.fallbackSteps["2"], guide.fallbackSteps["3"]],
      clientSavedHint: (hint: string) => format(guide.clientSavedHint, { hint }),
      connectedAs: (email: string) => format(guide.connectedAs, { email }),
      connectedAt: (when: string) => format(guide.connectedAt, { when }),
      scopeNames: {
        openid: guide.scopeNames.openid,
        email: guide.scopeNames.email,
        "https://www.googleapis.com/auth/gmail.modify": guide.scopeNames.gmailModify,
        "https://www.googleapis.com/auth/calendar.readonly": guide.scopeNames.calendarReadonly,
        "https://www.googleapis.com/auth/calendar.events": guide.scopeNames.calendarEvents,
      } as Record<string, string>,
    },
  };
}
