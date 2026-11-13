import { readFileSync } from "node:fs";
import { Router } from "express";

/**
 * GET /privacy (+ /privacy.css): the static privacy policy Google requires to
 * publish the OAuth app (decisions.md item 16). Server-rendered, works without
 * JavaScript, carries no personal data, so the identity gate lets it through
 * like /api/health. Styled with the app's own tokens (src/styles/tokens.css),
 * light and dark.
 */
export const PRIVACY_PATHS = ["/privacy", "/privacy.css"] as const;
export const PRIVACY_EFFECTIVE_DATE = "2026-10-15";
export const PRIVACY_CONTACT = "suzu1dev@gmail.com";
const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_CONNECTIONS = "https://myaccount.google.com/connections";

const tokens = (() => {
  try { return readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8"); }
  catch { return ""; }
})();

const PRIVACY_CSS = `${tokens}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--canvas,Canvas);color:var(--ink,CanvasText);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--fs-md,14px);line-height:var(--lh-body,1.7);text-wrap:pretty;line-break:strict}
.doc{max-width:760px;margin:0 auto;padding:var(--sp-10,40px) var(--sp-4,16px) calc(var(--sp-10,40px) * 2)}
.brand{display:inline-flex;align-items:baseline;gap:0;color:var(--ink);text-decoration:none;font-size:var(--fs-lg,16px);letter-spacing:-.2px}
.brand b{font-weight:650}
.brand i{color:var(--accent);font-style:normal;font-weight:650}
.eyebrow{margin:var(--sp-8,32px) 0 var(--sp-2,8px);font-family:var(--font-mono,monospace);font-size:var(--fs-2xs,11px);letter-spacing:var(--track-eyebrow,1.4px);text-transform:uppercase;color:var(--muted)}
h1{margin:0;font-size:var(--fs-2xl,26px);line-height:1.4;font-weight:500;word-break:keep-all;overflow-wrap:anywhere}
.sub{margin:var(--sp-2,8px) 0 0;color:var(--muted);font-size:var(--fs-sm,13px)}
.lead{margin:var(--sp-6,24px) 0 0;padding:var(--sp-4,16px) var(--sp-5,20px);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg,13px);box-shadow:var(--shadow-card)}
.lead p{margin:0}
section{margin-top:var(--sp-8,32px);padding-top:var(--sp-6,24px);border-top:1px solid var(--border)}
h2{margin:0 0 var(--sp-3,12px);font-size:var(--fs-lg,16px);line-height:var(--lh-tight,1.35);font-weight:650}
h2 .n{display:inline-block;min-width:1.6em;font-family:var(--font-mono,monospace);font-size:var(--fs-xs,12px);color:var(--muted);font-weight:500}
p,li{word-break:keep-all;overflow-wrap:anywhere}
p{margin:0 0 var(--sp-3,12px)}
ul{margin:0;padding-left:1.2em}
li{margin:0 0 var(--sp-2,8px)}
li::marker{color:var(--faint)}
dl{margin:0;display:grid;gap:var(--sp-3,12px)}
dl>div{padding:var(--sp-3,12px) var(--sp-4,16px);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md,10px)}
code{font-family:var(--font-mono,monospace);font-size:var(--fs-xs,12px);color:var(--ink-2);background:var(--surface-sunk);border-radius:var(--r-xs,5px);padding:1px 6px;overflow-wrap:break-word}
dd{margin:var(--sp-1,4px) 0 0;color:var(--ink-2)}
.quote{margin:var(--sp-4,16px) 0 0;padding:var(--sp-3,12px) var(--sp-4,16px);border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 var(--r-sm,7px) var(--r-sm,7px) 0;color:var(--ink)}
.quote p{margin:0}
.quote p+p{margin-top:var(--sp-2,8px)}
a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}
a:hover{color:var(--accent-strong)}
a:focus-visible{outline:3px solid var(--accent-ring);outline-offset:3px;border-radius:var(--r-xs,5px)}
.en{margin-top:var(--sp-10,40px);padding:var(--sp-5,20px);background:var(--surface-soft);border:1px solid var(--border);border-radius:var(--r-lg,13px)}
.en h2{font-size:var(--fs-md,14px)}
.en p{color:var(--ink-2);font-size:var(--fs-sm,13px)}
footer{margin-top:var(--sp-10,40px);color:var(--muted);font-size:var(--fs-sm,13px)}
@media (max-width:720px){.doc{padding-top:var(--sp-6,24px)}h1{font-size:22px}}
`;

function html(origin: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>隱私權政策 · BELL Personal</title>
<meta name="description" content="BELL Personal 如何使用、保存與保護來自 Google 的使用者資料。">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/privacy.css">
</head>
<body>
<main class="doc">
<a class="brand" href="/" aria-label="BELL Personal 首頁"><b>bell</b>/personal<i>.</i></a>
<p class="eyebrow">Privacy policy</p>
<h1>隱私權政策</h1>
<p class="sub">生效日期：2026 年 10 月 15 日 · 適用於 ${escapeHtml(origin)}</p>

<div class="lead"><p>BELL Personal 是擁有者自行架設、只供本人使用的每日工作台。它執行在擁有者自己的伺服器上，只能透過擁有者的私人網路開啟；沒有其他使用者、沒有註冊，也不對外提供服務。這份政策說明它如何使用從 Google 取得的資料。</p></div>

<section aria-labelledby="scopes">
<h2 id="scopes"><span class="n">01</span>使用哪些 Google 權限，以及為什麼</h2>
<dl>
<div><dt><code>openid</code> <code>email</code></dt><dd>確認連接的是哪一個 Google 帳號，並在設定頁顯示「已連線為 …」。</dd></div>
<div><dt><code>https://www.googleapis.com/auth/<wbr>gmail.modify</code></dt><dd>讀取信件的寄件者、主旨、摘要與純文字節錄，用來分類信件、整理今天要處理的事；擁有者打開「封存」或搜尋信件時，才即時讀取符合的信；擁有者打開一封信時，才即時讀取它的原始版面（HTML）與信內圖片。只有在擁有者按下按鈕時，才會封存信件、移回收件匣、標為已讀、移到垃圾桶或變更標籤。移到垃圾桶的信由 Gmail 保留 30 天後自動清除；BELL Personal 不會寄出信件，也不會永久刪除信件。</dd></div>
<div><dt><code>https://www.googleapis.com/auth/<wbr>calendar.readonly</code></dt><dd>顯示今天的行程與可用的空檔。</dd></div>
<div><dt><code>https://www.googleapis.com/auth/<wbr>calendar.events</code></dt><dd>只在擁有者確認後（例如按「加入行事曆」或「排進」）新增行程，或在復原時移除剛新增的行程。</dd></div>
</dl>
</section>

<section aria-labelledby="storage">
<h2 id="storage"><span class="n">02</span>資料存放在哪裡</h2>
<ul>
<li>所有資料只存在擁有者自己的伺服器（SQLite 資料庫），不會上傳到其他雲端服務。</li>
<li>信件只保存寄件者、主旨、時間、摘要、最多 8 KB 的純文字節錄與 AI 摘要；不保存 HTML。</li>
<li>擁有者打開一封信的「原始版面」時，才即時向 Gmail 讀取它的 HTML 與信內圖片，經過伺服器過濾後放在不能執行程式的隔離框架中顯示；只暫存在伺服器記憶體中最多 5 分鐘，不寫入資料庫、記錄檔或備份。</li>
<li>信中的外部圖片預設不載入。只有擁有者按下「顯示圖片」，或把寄件者加入「信任的寄件者」時，才由這台伺服器代為下載，而且在打開信時一次下載整封信的圖片：寄件者看不到擁有者的裝置、瀏覽器或 Cookie，也無從得知擁有者在信中看了或點了什麼，但會看到這台伺服器所在網路的 IP 位址（通常就是擁有者家中或伺服器的網路），也會知道信在何時被打開。圖片只暫存在記憶體中最多 5 分鐘，圖片網址也不會被記錄。已知的追蹤像素不會載入；下載後才認出的 1×1 追蹤像素不會顯示，但它的請求已經送到寄件者。「信任的寄件者」清單只存在設定中，可以隨時在「連線與設定」移除。</li>
<li>封存的信與搜尋結果只在擁有者查看時向 Gmail 讀取，暫存在伺服器記憶體中最多 5 分鐘，不寫入資料庫、記錄檔或備份；搜尋文字也不會被記錄。</li>
<li>Google 授權權杖以 AES-256-GCM 加密，存放在資料目錄之外的憑證檔；不會寫進資料庫、記錄檔或備份，也從不傳到瀏覽器。</li>
</ul>
</section>

<section aria-labelledby="retention">
<h2 id="retention"><span class="n">03</span>保留期限</h2>
<ul>
<li>快取的信件內容預設保留 30 天（可在「連線與設定」調整），到期自動刪除；從信件產生、還沒確認的 AI 建議，以及「已處理」清單中的信件主旨，也會一起刪除。每日摘要同樣只保留這段期間。「清除快取的信件」可立即刪除以上全部。</li>
<li>行事曆只快取近期的行程範圍，舊的行程會在下次同步時移除。</li>
<li>中斷 Google 連線時，會向 Google 撤銷授權，並刪除所有快取的 Gmail 與行事曆資料，以及上述從信件衍生的資料。</li>
<li>擁有者確認後建立的待辦、作業與行程屬於擁有者自己的紀錄，不會因此刪除；從信件建立的作業只保留作業內容與指回原信的連結。</li>
<li>伺服器每天在同一台機器上自動備份資料庫：自動備份最多保留約 5 週（最近 7 天各一份、最近 4 週各一份），更新前的備份保留 30 天，到期後連同其中的信件快取一起刪除。清除快取或中斷連線不會修改既有的備份。</li>
</ul>
</section>

<section aria-labelledby="ai">
<h2 id="ai"><span class="n">04</span>AI 處理</h2>
<ul>
<li>為了分類信件和產生每日摘要，信件的主旨、摘要與節錄會交給擁有者自己在這台伺服器上登入的 Claude Code 或 Codex 命令列工具處理，使用的是擁有者本人的訂閱帳號。擁有者在一封信按下「用 AI 處理」時，同一個工具會讀這個對話最新幾封已同步的信（寄件者、主旨與純文字節錄），找出可以加入行事曆、待辦或作業的事；看起來含有密碼或驗證碼的信不會送出。</li>
<li>AI 的結果只是建議：必須由擁有者確認後，才會變成待辦、作業或行程；不會自動封存、刪除、寄送或建立任何東西。</li>
<li>唯一的例外是擁有者開啟的「自動整理快速記下的內容」：擁有者自己剛記下的待辦或行程，會把那句話交給同一個 AI 工具整理標題與備註並直接套用；原文會保留、日期不會改動、每次整理都可以復原，也可以隨時關閉。這只處理擁有者自己輸入的文字，不包含 Google 使用者資料。</li>
<li>BELL Personal 不會使用 Google 使用者資料來開發、改進或訓練一般化的人工智慧或機器學習模型。</li>
<li>AI 功能可以在「連線與設定」中完全關閉，關閉後不會有任何資料送去 AI 處理。</li>
</ul>
</section>

<section aria-labelledby="sharing">
<h2 id="sharing"><span class="n">05</span>分享與使用限制</h2>
<ul>
<li>不出售、不出租、不分享 Google 使用者資料給任何第三方，也不用於廣告。</li>
<li>除了上述由擁有者自己登入的 AI 工具之外，資料不會傳送到其他服務。</li>
<li>除了擁有者本人，沒有任何人會讀取這些資料。</li>
</ul>
<div class="quote">
<p>BELL Personal 對從 Google API 取得之資訊的使用及傳輸，將遵守 <a href="${USER_DATA_POLICY}" rel="noopener noreferrer">Google API 服務使用者資料政策</a>，包括其中的「有限使用」（Limited Use）規定。</p>
<p lang="en">BELL Personal's use and transfer to any other app of information received from Google APIs will adhere to the <a href="${USER_DATA_POLICY}" rel="noopener noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
</div>
</section>

<section aria-labelledby="revoke">
<h2 id="revoke"><span class="n">06</span>如何撤銷授權</h2>
<ul>
<li>在 BELL Personal 的「連線與設定」按「中斷連線」：撤銷 Google 授權，並刪除快取的資料。</li>
<li>或到 Google 帳戶的<a href="${GOOGLE_CONNECTIONS}" rel="noopener noreferrer">第三方應用程式和服務</a>頁面，移除 BELL Personal 的存取權。</li>
</ul>
</section>

<section aria-labelledby="contact">
<h2 id="contact"><span class="n">07</span>聯絡與變更</h2>
<p>對這份政策有任何問題，請寄信到 <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>。政策若有變更，會更新這一頁與上方的生效日期。</p>
</section>

<section class="en" lang="en" aria-labelledby="summary">
<h2 id="summary">English summary</h2>
<p>BELL Personal is a single-user, self-hosted daily dashboard that its owner runs on the owner's own server, reachable only over the owner's private network. It requests <code>openid</code> and <code>email</code> to identify the connected account; <code>gmail.modify</code> to read message metadata, snippets and plain-text excerpts to organise the owner's day, to list archived mail, search the mailbox and show a message's original layout only when the owner opens them, and to archive, move back to the inbox, mark as read, move to trash or relabel messages only when the owner taps an action (it never sends or permanently deletes mail; Gmail empties its trash after 30 days); <code>calendar.readonly</code> to show today's agenda and free time; and <code>calendar.events</code> to add events the owner confirms.</p>
<p>Data stays on the owner's server in SQLite. Cached mail (no HTML, excerpts up to 8 KB) is deleted after 30 days by default, together with the pending AI suggestions, handled-list subjects and daily briefs derived from it; clearing the mail cache or disconnecting Google deletes them at once. Archived-mail listings and search results are read on demand and kept only in server memory for up to five minutes; search text is not logged. When the owner opens a message, its HTML and inline images are read from Gmail on demand, filtered on the server, shown in a sandboxed frame that cannot run scripts, and kept only in server memory for up to five minutes; HTML is never stored. Remote images are not loaded unless the owner asks or trusts the sender; they are then fetched by the owner's server, never by the browser, all at once when the message is opened, so the sender sees the server's network address (usually the owner's own connection) and when the message was opened, but not the owner's device, browser or cookies; they are kept in memory for up to five minutes, and known tracking pixels are not loaded. Daily backups on the same server keep copies for up to about five weeks (pre-update backups for 30 days) and then expire; clearing or disconnecting does not rewrite existing backups. OAuth tokens are encrypted with AES-256-GCM outside the database and backups and never reach the browser. Mail snippets are processed for triage and the daily brief, and the newest cached messages of one conversation when the owner taps “用 AI 處理” (to propose events, todos and assignments), only by the owner's own Claude Code or Codex command-line login on the same server; AI output is a suggestion the owner confirms, and AI can be turned off. Google user data is not sold, shared, used for advertising, or used to develop, improve or train generalized AI or machine-learning models.</p>
<p>BELL Personal's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. Revoke access with “中斷連線” (Disconnect) in Settings or at <a href="${GOOGLE_CONNECTIONS}" rel="noopener noreferrer">myaccount.google.com/connections</a>. Contact: <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>.</p>
</section>

<footer><p>BELL Personal · 自行架設的個人工作台 · <a href="/">回到首頁</a></p></footer>
</main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Mounted at the root before the SPA fallback. `origin` is the public origin shown on the page. */
export function createPrivacyRouter(origin: string): Router {
  const router = Router();
  const page = html(origin);
  router.get("/privacy", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("html").send(page);
  });
  router.get("/privacy.css", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("css").send(PRIVACY_CSS);
  });
  return router;
}
