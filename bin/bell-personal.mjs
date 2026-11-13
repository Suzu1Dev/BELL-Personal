#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

const HELP = `BELL Personal v${pkg.version} — Local-first daily workspace

Usage:
  bell-personal [start] [options]  Start BELL Personal locally
  bell-personal doctor [--json]    Verify Node, SQLite, data dir, and optional CLIs
  bell-personal --version, -v      Print version
  bell-personal --help, -h         Show this help

Options (start):
  --port <n>      Port to listen on (default: 4620 standalone, 4601 with --suite)
  --host <host>   Host to bind (default: 127.0.0.1)
  --no-open       Do not open the browser automatically
  --suite         Enable BELL Suite edition with default local sibling links
`;

function parseArgs(argv) {
  const opts = { cmd: "start", port: undefined, host: undefined, open: true, suite: false, json: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) {
    opts.cmd = rest.shift();
  }
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--help" || arg === "-h") { opts.cmd = "help"; }
    else if (arg === "--version" || arg === "-v") { opts.cmd = "version"; }
    else if (arg === "--no-open") { opts.open = false; }
    else if (arg === "--suite") { opts.suite = true; }
    else if (arg === "--json") { opts.json = true; }
    else if (arg === "--port" && rest.length > 0) { opts.port = Number(rest.shift()); }
    else if (arg.startsWith("--port=")) { opts.port = Number(arg.slice(7)); }
    else if (arg === "--host" && rest.length > 0) { opts.host = rest.shift(); }
    else if (arg.startsWith("--host=")) { opts.host = arg.slice(7); }
    else { throw new Error(`Unknown or incomplete option: ${arg}`); }
  }
  return opts;
}

function defaultDirs() {
  const inRepo = existsSync(join(rootDir, "data")) || existsSync(join(rootDir, ".git"));
  const base = inRepo ? rootDir : join(homedir(), ".bell-personal");
  return {
    dataDir: process.env.BELLPERSONAL_DATA_DIR ? resolve(process.env.BELLPERSONAL_DATA_DIR) : join(base, "data"),
    secretsDir: process.env.BELLPERSONAL_SECRETS_DIR ? resolve(process.env.BELLPERSONAL_SECRETS_DIR) : join(base, ".secrets"),
  };
}

function checkCmd(bin, args = ["--version"]) {
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"] });
  return res.status === 0 ? (res.stdout || res.stderr || "").trim().split("\n")[0] : null;
}

async function runDoctor(json) {
  const nodeVersion = process.versions.node;
  const [major] = nodeVersion.split(".").map(Number);
  const nodeOk = major >= 20;
  let sqliteOk = false;
  let sqliteDetail = "unavailable (requires Node >= 22.13)";
  try {
    await import("node:sqlite");
    sqliteOk = true;
    sqliteDetail = `node:sqlite ready (Node v${nodeVersion})`;
  } catch (err) {
    sqliteDetail = err instanceof Error ? err.message : String(err);
  }

  const { dataDir } = defaultDirs();
  let dataWritable = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    dataWritable = true;
  } catch {}

  const distReady = existsSync(join(rootDir, "dist", "index.html"));
  const claude = checkCmd(process.env.CLAUDE_CLI_PATH || "claude");
  const codex = checkCmd(process.env.CODEX_CLI_PATH || "codex");
  const gh = checkCmd(process.env.GH_CLI_PATH || "gh");

  const checks = [
    { name: "node", ok: nodeOk && sqliteOk, detail: sqliteOk ? `v${nodeVersion} (${sqliteDetail})` : `v${nodeVersion} — ${sqliteDetail}` },
    { name: "dataDir", ok: dataWritable, detail: dataDir },
    { name: "frontendBuild", ok: distReady, detail: distReady ? join(rootDir, "dist") : "not built yet (auto-builds on start)" },
    {
      name: "optionalClis",
      ok: true,
      detail: [
        claude ? `claude (${claude})` : null,
        codex ? `codex (${codex})` : null,
        gh ? `gh (${gh})` : null,
      ].filter(Boolean).join(", ") || "none detected (tasks, ideas, habits, and schedule work offline without CLIs)",
    },
  ];
  const ok = checks.every(c => c.ok || c.name === "frontendBuild");
  if (json) {
    console.log(JSON.stringify({ app: "bell-personal", version: pkg.version, ok, checks }, null, 2));
  } else {
    console.log(`BELL Personal v${pkg.version} doctor\n`);
    for (const c of checks) {
      const mark = c.ok ? "[OK]" : c.name === "frontendBuild" ? "[WARN]" : "[FAIL]";
      console.log(`  ${mark} ${c.name.padEnd(15)} ${c.detail}`);
    }
    console.log(ok ? "\nReady to start: bell-personal start" : "\nFix the failing checks above before starting.");
  }
  process.exit(ok ? 0 : 1);
}

function canOpenBrowser(openFlag) {
  if (!openFlag || process.env.CI || process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function waitAndOpen(url, openFlag) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        if (canOpenBrowser(openFlag)) openBrowser(url);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
}

async function runStart(opts) {
  const distIndex = join(rootDir, "dist", "index.html");
  if (!existsSync(distIndex)) {
    console.log("Building BELL Personal frontend (dist/)...");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const build = spawnSync(npmCmd, ["run", "build"], { cwd: rootDir, stdio: "inherit" });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }

  const suiteMode = opts.suite || process.env.BELLPERSONAL_EDITION === "suite" || Boolean(process.env.BELLPERSONAL_SUITE_LINKS?.trim());
  const port = opts.port ?? (process.env.BELLPERSONAL_PORT ? Number(process.env.BELLPERSONAL_PORT) : suiteMode ? 4601 : 4620);
  const host = opts.host ?? process.env.BELLPERSONAL_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid port: ${port} (must be 1024-65535)`);
  }

  const { dataDir, secretsDir } = defaultDirs();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const env = {
    ...process.env,
    BELLPERSONAL_HOST: host,
    BELLPERSONAL_PORT: String(port),
    BELLPERSONAL_FRONTEND_PORT: process.env.BELLPERSONAL_FRONTEND_PORT || String(port),
    BELLPERSONAL_DATA_DIR: dataDir,
    BELLPERSONAL_SECRETS_DIR: secretsDir,
    BELLPERSONAL_EDITION: suiteMode ? "suite" : "standalone",
  };
  if (opts.suite && !env.BELLPERSONAL_SUITE_LINKS) {
    env.BELLPERSONAL_SUITE_LINKS = "explain=http://127.0.0.1:4602,pr=http://127.0.0.1:4603,reader=http://127.0.0.1:4604,campaign=http://127.0.0.1:4605";
    if (!env.BELLPERSONAL_SUITE_FETCH) {
      env.BELLPERSONAL_SUITE_FETCH = "explain=http://127.0.0.1:4602,pr=http://127.0.0.1:4603,reader=http://127.0.0.1:4604";
    }
  }

  const localTsx = join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const bin = existsSync(localTsx) ? localTsx : (process.platform === "win32" ? "npx.cmd" : "npx");
  const args = existsSync(localTsx)
    ? ["--env-file-if-exists=.env", "server/index.ts"]
    : ["tsx", "--env-file-if-exists=.env", "server/index.ts"];

  const browseHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${browseHost}:${port}`;
  console.log(`Starting BELL Personal (${suiteMode ? "Suite edition" : "Standalone edition"}) at ${url}`);

  const child = spawn(bin, args, { cwd: rootDir, stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { if (!child.killed) child.kill(sig); });
  }
  void waitAndOpen(url, opts.open);
  child.on("exit", (code) => process.exit(code ?? 0));
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === "version") console.log(pkg.version);
  else if (opts.cmd === "help") console.log(HELP);
  else if (opts.cmd === "doctor") await runDoctor(opts.json);
  else if (opts.cmd === "start") await runStart(opts);
  else throw new Error(`Unknown command: ${opts.cmd}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
