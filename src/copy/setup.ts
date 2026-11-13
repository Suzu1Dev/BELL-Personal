/**
 * #/setup strings (SPEC-ux §3.4 first run): three steps, every one
 * skippable. The page head is PAGE_HEADS.setup in common.ts.
 */
export const SETUP = {
  skip: "略過，先用用看",
  finish: "完成，前往今天",
  stepsLabel: "開始使用的三個步驟",
  later: "稍後再說",
  skipped: "已略過，之後可以在 連線與設定 接上。",
  step: (n: number) => `步驟 ${n}`,
  local: {
    title: "還可以打開（選填）",
    hint: "天氣預設開著；GitHub 與 CTFtime 有需要再打開。",
    github: "GitHub",
    githubFound: (login: string) => `已偵測到 GitHub 帳號 ${login}`,
    githubMissing: "沒有偵測到 GitHub 登入，之後在伺服器登入 GitHub CLI 就會自動接上。",
    ctftime: "CTFtime",
    ctftimeHint: "有在打 CTF 才需要。打開後，權重夠高的比賽會問你要不要參加。",
    weather: "天氣",
    weatherHint: "今天頁開頭的氣溫和降雨提醒。",
    city: "城市",
    cityChosen: (name: string) => `天氣改用「${name}」`,
    moreCities: "搜尋其他城市",
  },
  school: {
    title: "連接學校",
    hint: "作業和截止時間會自動出現在今天的佇列。只讀取，不會替你繳交。",
    canvasToggle: "學校用 Canvas？",
    moodleToggle: "改用 NYCU E3（Moodle）",
    done: "學校已連接",
  },
  google: {
    title: "連接 Google（選填）",
    hint: "接上 Gmail 和 Google 行事曆後，需要回覆的信和今天的行程都會排進今天頁。需要先在 Google Cloud 建立一個只有你用的用戶端，大約 10 分鐘。",
    start: "開始設定",
    connected: (email: string) => `已連接 Google 帳號 ${email}`,
    connectedPlain: "已連接 Google 帳號",
  },
} as const;
