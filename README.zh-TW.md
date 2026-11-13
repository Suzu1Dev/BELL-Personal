# BELL Personal

[English](./README.md) · **繁體中文**

一天打開一次的個人每日工作台：在同一頁看完信件摘要、今日行程、作業與專案、即將到來的活動、待辦，順手記下靈感、完成習慣打卡，再讀一段 AI 整理的今日重點。可單獨執行（Standalone Edition），也可與 [BELL Suite](https://github.com/Suzu1Dev/bell-suite) 串聯運作。

## 一鍵安裝與 CLI 啟動

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/BELL-Personal/main/install.sh | sh
bell-personal

# 或透過 npx 直接啟動
npx bell-personal
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/BELL-Personal/main/install.ps1 | iex
bell-personal
```

常用 CLI 指令：

```bash
bell-personal start               # 獨立模式啟動（預設 http://127.0.0.1:4620）
bell-personal start --suite       # BELL Suite 模式啟動（預設 http://127.0.0.1:4601）
bell-personal doctor              # 檢查 Node、SQLite、資料目錄與選用 CLI 狀態
```

設計原則是「最精緻精簡、直覺、最低摩擦」：

- **今天優先**：所有模組都在 `#/today` 有一張精簡卡片，完整頁面只用來深入查看。
- **不需設定的來源先上線**：待辦、靈感、習慣、專案與 GitHub（使用已登入的 `gh`）開箱即用；需要憑證的來源（Gmail、Google 日曆、Moodle、Canvas）都是選用，壞掉也不會讓整頁空白。
- **AI 只提建議**：信件分類、每日重點、自然語言速記都先成為建議，你點一下才會生效；不會自動封存信件或建立任何東西。
- **每個區塊各自處理**載入中、錯誤、空白與過期資料；可復原的操作直接生效並提供「復原」。

> 所有功能模組與介面都已整合（今天、收件匣、行事曆與活動、待辦、靈感、作業與專案、習慣、連線與設定）。已驗證的範圍、還需要真實憑證才能驗證的部分與已知限制見 [`docs/STATUS.md`](docs/STATUS.md)；功能開發請先讀 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 與 [`AGENTS.md`](AGENTS.md)。

## 快速開始

需要 **Node.js 22.13 以上**（建議 24；`node:sqlite` 在 22 會印出 experimental 警告）與 npm。AI 功能另外需要已登入的 Claude Code CLI（`claude auth login`），GitHub 卡片需要已登入的 `gh`（`gh auth login`）。

```bash
npm install
npm run dev
```

開啟 <http://127.0.0.1:4330>。開發時網頁在 4330、API 在 4331，Vite 會把 `/api` 與 `/oauth` 轉給 API；兩者都只綁定本機。

其他指令：

```bash
npm run build      # tsc --noEmit && vite build
npm test           # node:test：server、shared 與 src 的 *.test.ts
npm start          # 用 dist/ 的正式前端在 127.0.0.1:4331 提供整個服務
```

不需要 `.env` 也能完整啟動。要調整連接埠、資料位置或啟用需要憑證的來源，複製 `.env.example` 成 `.env`（只有開發時會讀取）。資料預設在 `./data`（三個 SQLite），加密憑證在 `./.secrets`，兩者都已排除在 git 之外。

## 連接資料來源

所有連線都在「連線與設定」（`#/settings/sources`）完成；憑證只保存在這台電腦，經 AES-256-GCM 加密，瀏覽器不會儲存任何密碼。需要憑證的來源要先在伺服器設定主金鑰（`BELLPERSONAL_MASTER_KEY`，見 `.env.example`）。

| 來源 | 需要什麼 | 用在哪裡 |
| --- | --- | --- |
| GitHub | 伺服器上已登入的 `gh` | 專案進度、待審 PR、指派給你的 issue、貢獻日曆（可當作自動習慣） |
| Google（Gmail＋日曆） | 一次性的 Google Cloud OAuth 用戶端（約 15–20 分鐘，介面內有逐步說明），之後按「連線 Google」 | 需要回覆的信、帳單、學校、活動邀請；今日時間軸；一鍵加入行事曆 |
| iCal 訂閱 | 行事曆的 iCal 網址（例如 Google 的私密網址、KKTIX 主辦單位） | 時間軸或即將到來的活動 |
| Moodle（例如 NYCU E3） | 學校網址、帳號密碼只輸入一次換取 token，密碼不保存 | 待辦與作業 |
| Canvas（例如 NTU COOL） | 學校網址與個人存取權杖 | 待辦與作業 |
| CTFtime | 不需要；預設關閉，有在打 CTF 才在設定打開 | 即將到來的活動 |
| RSS／Atom | 不需要；可自行加入訂閱網址 | 即將到來的活動 |
| 每週課表 | 不需要；在快速記下輸入「每週一 10:10 作業系統」 | 今天與行事曆的行程（只存在 BELL，不會寫進 Google） |
| 天氣 | 不需要（Open-Meteo），可在設定選擇城市 | 今日標題旁的小天氣 |

AI 預設使用伺服器上已登入的 Claude Code（sonnet、思考強度 low），可在設定改用 Codex。模型在完全沒有工具的隔離模式下執行，信件與行程內容一律當作不可信資料；送出前會遮蔽看起來像權杖或金鑰的字串。

## 部署

正式環境建議以 systemd 使用者服務執行於本機 loopback（例如 `127.0.0.1:20003`），透過 Tailscale Serve 在私人網路提供 HTTPS，並透過 `BELLPERSONAL_TAILSCALE_USERS` 只放行指定的 Tailscale 帳號（環境變數範本見 [`deployment/environment.example`](deployment/environment.example)）。

## 專案結構

```
server/    Express API：index.ts（組裝）、app.ts（中介層與路由）、security.ts、db/、stores/、
           secrets/（遮蔽與加密憑證庫）、sync.ts（背景同步）、jobs.ts、ai/（模型呼叫）、features/（功能模組登錄）
shared/    前後端共用的型別、列舉與純函式（含台北時區的日期計算）
src/       React 19 前端：pages/（各頁面）、components/、copy/（介面文字）、lib/、styles/tokens.css 設計變數
public/    favicon、PWA manifest 與圖示、theme-boot.js
deployment/ systemd 單元、環境範本、備份腳本、Tailscale Serve 腳本、部署說明
docs/      ARCHITECTURE.md：功能模組的開發契約；STATUS.md：目前狀態與待驗證項目
```
