# BELL Personal

**English** · [繁體中文](./README.zh-TW.md)

Local-first daily workspace for tasks, inbox triage, calendar & events, ideas, habits, coursework/projects, and a Personal Bot assistant. Built around a calm **Today-first** view (`#/today`) where zero-config local modules work immediately out-of-the-box and credentialed sources (Gmail, Google Calendar, GitHub, Moodle, Canvas, iCal) connect optionally with local AES-256-GCM credential storage.

Runs smoothly as an **independent Standalone App** (zero environment variables required) or as the daily hub of **[BELL Suite](https://github.com/Suzu1Dev/bell-suite)** alongside BELL Explain, BELL PR, BELL Web Reader, and BELL Campaign.

## Quick Start

### Install in One Line (macOS / Linux / WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/BELL-Personal/main/install.sh | sh
bell-personal
```

The installer checks npm first and automatically falls back to cloning from GitHub (`~/.local/share/bell-personal/app`) and symlinking `~/.local/bin/bell-personal`, bootstrapping Node.js 24 if needed.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/BELL-Personal/main/install.ps1 | iex
bell-personal
```

### Run via `npx` or From Source

```bash
# Run directly with npx
npx bell-personal

# Or clone and run from source
git clone https://github.com/Suzu1Dev/BELL-Personal.git
cd BELL-Personal
npm install && npm run build
./bin/bell-personal.mjs start
```

## CLI Usage

```text
bell-personal [start] [--port <n>] [--host <h>] [--no-open] [--suite]
bell-personal doctor [--json]
bell-personal --version | --help
```

- **Standalone Edition (default)**: listens on `http://127.0.0.1:4620` with local SQLite databases in `./data/` (checkout) or `~/.bell-personal/data/` (global install).
- **BELL Suite Edition (`--suite` or `bell-suite start`)**: listens on `http://127.0.0.1:4601`, aggregates read-only `/api/suite/today` summaries from sibling apps, accepts `#/tasks?draft=...` handoffs, and sends tasks/ideas straight to BELL Explain (`#/explain`) or BELL PR (`#/discover`).

## Architecture Overview

```text
bin/bell-personal.mjs  Standalone & Suite CLI (start, doctor, --version, --help)
server/                Express 5 API, SQLite stores (node:sqlite), AES-256-GCM vault,
                       background sync, Personal Bot, and Suite Contract v1 bridge
shared/                Shared TypeScript schemas, timezone helpers, Suite route rules
src/                   React 19 UI (Today, Inbox, Events, Tasks, Ideas, Work, Habits, Settings)
Formula/               Homebrew formula template
```

## Development & Verification

Requires **Node.js 22.13+** (Node.js 24 LTS recommended) for built-in `node:sqlite`.

```bash
npm install
npm run dev        # Vite frontend (4330) + API watch (4331)
npm test           # Full unit & integration test suite
npm run build      # TypeScript check + production Vite bundle
```

## License

[Apache-2.0](./LICENSE) · [Trademarks](./TRADEMARKS.md)
