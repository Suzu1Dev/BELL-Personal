import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { AppError } from "../errors.js";
import { redact, redactCliOutput } from "../secrets/redact.js";

export { redact };

/**
 * Child processes never inherit the service environment: it holds the master
 * key, the Google client secret and every other BELLPERSONAL_* value. Each
 * CLI gets an allow-list of what it needs to find its own login, network
 * and locale.
 */
const baseVariables = [
  "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

function pick(names: string[], source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

/** Default for command(): enough to run git, gh or a helper, nothing secret. */
export function baseEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...pick(baseVariables, source), NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
}

/**
 * bell-explain's claudeEnvironment(): only what the CLI needs to find its login.
 * ANTHROPIC_API_KEY is deliberately excluded so Claude Code uses the signed-in
 * subscription, not API billing; BELLPERSONAL_* never reaches the model process.
 */
export function claudeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = pick([...baseVariables, "CLAUDE_CONFIG_DIR"], source);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/** Codex keeps its login in CODEX_HOME (or ~/.codex); API-key logins are passed through as bell-pr does. */
export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...pick([...baseVariables, "CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY"], source), NO_COLOR: "1" };
}

/** gh keeps its login in GH_CONFIG_DIR (or ~/.config/gh). */
export function ghEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...baseEnvironment(source), ...pick(["GH_CONFIG_DIR", "GH_HOST"], source) };
}

export interface CommandOptions {
  cwd?: string;
  input?: string;
  /** Instead of input: piped to stdin, which stays open until the stream ends (a login that waits for a pasted code). */
  stdin?: Readable;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Values that must not appear in a failure message, such as the key this spawn got in `env`; their fragments are masked too. */
  secrets?: readonly string[];
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  allowedCodes?: number[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** The injectable shape of command(), so tests replay JSONL instead of spawning a CLI. */
export type CommandRunner = (executable: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

/**
 * bell-pr's command(): arguments go straight to the executable (never a
 * shell), the prompt goes on stdin, the whole process group is killed on
 * abort or timeout (SIGTERM, then SIGKILL after 1.5 s). Errors: 409 aborted,
 * 504 timeout, 422 too much output or a non-zero exit, 503 spawn failure.
 * Messages are redacted. `onLine` receives complete lines; it must not throw
 * (abort through your own AbortController instead).
 */
export async function command(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) throw new AppError(409, "工作已取消。");
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? baseEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let byteCount = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const pending = { stdout: "", stderr: "" };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* Already exited. */
        }
      };
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1500);
      killTimer.unref();
    };
    const abort = () => stop(new AppError(409, "工作已取消。"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(new AppError(504, `${executable} 執行逾時。`)),
      options.timeoutMs ?? 60_000,
    );
    const deliver = (line: string, stream: "stdout" | "stderr") => {
      try {
        options.onLine?.(line, stream);
      } catch {
        stop(new AppError(502, `${executable} 的輸出無法處理。`));
      }
    };
    const consume = (stream: "stdout" | "stderr", buffer: Buffer) => {
      byteCount += buffer.byteLength;
      if (byteCount > (options.maxBytes ?? 2_000_000)) {
        stop(new AppError(422, `${executable} 輸出超過安全上限；請縮小工作範圍。`));
        return;
      }
      const text = buffer.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (options.onLine) {
        pending[stream] += text;
        let end: number;
        while ((end = pending[stream].indexOf("\n")) >= 0) {
          deliver(pending[stream].slice(0, end), stream);
          pending[stream] = pending[stream].slice(end + 1);
        }
      }
    };
    child.stdout.on("data", (buffer: Buffer) => consume("stdout", buffer));
    child.stderr.on("data", (buffer: Buffer) => consume("stderr", buffer));
    child.stdin.on("error", () => {
      /* Process may exit before consuming input. */
    });
    child.on("error", (error) => {
      failure = new AppError(503, `${executable} 無法啟動：${redactCliOutput(error.message, options.secrets)}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      for (const stream of ["stdout", "stderr"] as const) {
        if (pending[stream]) deliver(pending[stream], stream);
      }
      if (failure) reject(failure);
      else if (!(options.allowedCodes ?? [0]).includes(code ?? -1)) {
        // Masked before the cut, from a window wider than the cut plus any key, so a key split by the window is a fragment the mask still catches.
        const output = (stderr || stdout || `exit ${code}`).trim().slice(-4000);
        reject(new AppError(422, `${executable} 執行失敗：${redactCliOutput(output, options.secrets).slice(-1800)}`));
      } else resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (options.stdin) options.stdin.pipe(child.stdin);
    else child.stdin.end(options.input ?? "");
  });
}
