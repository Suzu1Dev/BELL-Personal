import type { CliStatus } from "../shared/api.js";
import type { AgentProvider } from "../shared/models.js";
import { claudeEnvironment, codexEnvironment, ghEnvironment, type CommandRunner } from "./ai/process.js";

export interface CliProbe {
  clis: Record<AgentProvider, CliStatus>;
  github: { authenticated: boolean; login?: string };
  checkedAt: string;
}

export interface StatusServiceOptions {
  command: CommandRunner;
  claudePath: string;
  codexPath: string;
  ghPath: string;
  /** Default 10 s, like bell-pr's status cache. */
  cacheMs?: number;
}

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0].trim().slice(0, 80);

export type CliAccount = NonNullable<CliStatus["account"]>;

/**
 * `claude auth status` (JSON by default since 2.1): {loggedIn, authMethod:
 * "claude.ai" | "api_key" | …, subscriptionType: "pro" | "max" | …, email, …}.
 * Only the kind and the plan are kept.
 */
export function claudeAccount(stdout: string): CliAccount | undefined {
  let json: Record<string, unknown>;
  try { json = JSON.parse(stdout); } catch { return undefined; }
  if (json?.loggedIn !== true) return undefined;
  if (json.authMethod === "api_key") return { kind: "api_key" };
  const plan = typeof json.subscriptionType === "string" && /^[a-z0-9_-]{1,20}$/i.test(json.subscriptionType) ? json.subscriptionType.toLowerCase() : undefined;
  return { kind: "subscription", ...(plan ? { plan } : {}) };
}

/** `codex login status` writes to stderr: "Logged in using ChatGPT" or "API key configured - sk-…" (codex-cli 0.167). */
export function codexAccount(output: string): CliAccount | undefined {
  if (/\bChatGPT\b/.test(output)) return { kind: "subscription" };
  if (/\bAPI key\b/i.test(output)) return { kind: "api_key" };
  return undefined;
}

const withAccount = (account: CliAccount | undefined) => (account ? { account } : {});

/**
 * CLI health for GET /api/status: installed, signed in, versions, and the gh
 * login. Every probe is a separate short-lived process, so results are cached
 * for 10 s and concurrent callers share one probe.
 */
export class StatusService {
  private cache?: { value: CliProbe; expires: number };
  private pending?: Promise<CliProbe>;

  constructor(private readonly options: StatusServiceOptions) {}

  async probe(): Promise<CliProbe> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    if (this.pending) return this.pending;
    this.pending = this.run().then((value) => {
      this.cache = { value, expires: Date.now() + (this.options.cacheMs ?? 10_000) };
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /**
   * The last probe without waiting for one (undefined before the first); an
   * old one is refreshed in the background. For request paths that must not
   * spawn and wait on CLIs, such as quick capture deciding on 自動整理.
   */
  peek(): CliProbe | undefined {
    if (!this.cache || this.cache.expires <= Date.now()) void this.probe();
    return this.cache?.value;
  }

  /** Forget the cached probe, e.g. after the user says they logged in. */
  invalidate(): void {
    this.cache = undefined;
  }

  private async run(): Promise<CliProbe> {
    const { command, claudePath, codexPath, ghPath } = this.options;
    const [claudeVersion, claudeAuth, codexVersion, codexAuth, github] = await Promise.allSettled([
      command(claudePath, ["--version"], { timeoutMs: 5000, env: claudeEnvironment(), maxBytes: 20_000 }),
      command(claudePath, ["auth", "status"], { timeoutMs: 10_000, env: claudeEnvironment(), maxBytes: 20_000 }),
      command(codexPath, ["--version"], { timeoutMs: 5000, env: codexEnvironment(), maxBytes: 20_000 }),
      command(codexPath, ["login", "status"], { timeoutMs: 10_000, env: codexEnvironment(), maxBytes: 20_000 }),
      command(ghPath, ["api", "user", "--jq", ".login"], { timeoutMs: 10_000, env: ghEnvironment(), maxBytes: 20_000 }),
    ]);
    const login = github.status === "fulfilled" ? firstLine(github.value.stdout) : "";
    return {
      clis: {
        claude: {
          installed: claudeVersion.status === "fulfilled",
          authenticated: claudeAuth.status === "fulfilled",
          ...(claudeVersion.status === "fulfilled" ? { version: firstLine(claudeVersion.value.stdout) } : {}),
          ...withAccount(claudeAuth.status === "fulfilled" ? claudeAccount(claudeAuth.value.stdout) : undefined),
        },
        codex: {
          installed: codexVersion.status === "fulfilled",
          authenticated: codexAuth.status === "fulfilled",
          ...(codexVersion.status === "fulfilled" ? { version: firstLine(codexVersion.value.stdout) } : {}),
          ...withAccount(codexAuth.status === "fulfilled" ? codexAccount(`${codexAuth.value.stdout}\n${codexAuth.value.stderr}`) : undefined),
        },
      },
      github: { authenticated: github.status === "fulfilled", ...(/^[A-Za-z0-9-]{1,39}$/.test(login) ? { login } : {}) },
      checkedAt: new Date().toISOString(),
    };
  }
}
