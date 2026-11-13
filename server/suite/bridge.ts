import {
  SUITE_LIMITS,
  SUITE_OBJECT_ID,
  type SuitePrStatus,
} from "../../shared/suite.js";
import { AppError } from "../errors.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { redact } from "../secrets/redact.js";
import { VaultKeyError, type Vault } from "../secrets/vault.js";
import { callSiblingJson, SuiteReadError, type SuiteCallTransport } from "./client.js";
import type { SuiteService } from "./service.js";

export const SUITE_PR_VAULT_KEY = "suite.pr.token";

interface StoredPrToken {
  token: string;
  deviceId?: string;
  deviceName?: string;
  savedAt: string;
}

export interface ExplainLessonDigest {
  id: string;
  title: string;
  summary: string;
  category?: string;
  tags: string[];
  updatedAt: string;
  href?: string;
}

export interface ExplainSuiteSnapshot {
  configured: boolean;
  link: string | null;
  status: string;
  counts: Record<string, number> | null;
  lessons: ExplainLessonDigest[];
}

export interface PrRepoDigest {
  id: string;
  name: string;
  defaultBranch?: string;
}

export interface PrRunDigest {
  id: string;
  repoId: string;
  title: string;
  status: string;
  learnByHand: boolean;
  prUrl?: string;
  createdAt?: string;
  href?: string;
}

export interface PrSuiteSnapshot {
  configured: boolean;
  connected: boolean;
  link: string | null;
  status: string;
  counts: Record<string, number> | null;
  repos: PrRepoDigest[];
  runs: PrRunDigest[];
}

export interface SuiteBridgeOptions {
  call?: SuiteCallTransport;
  now?: () => Date;
  timeoutMs?: number;
  onPrChanged?: () => void;
}

const clip = (text: string, max: number): string => {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
};

function siblingErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string") {
    const raw = (json as { error: string }).error.trim();
    if (raw && raw.length <= 200) return redact(raw);
  }
  return fallback;
}

export class SuiteBridge {
  private readonly call: SuiteCallTransport;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private onPrChanged?: () => void;
  private suite?: SuiteService;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly vault: Vault,
    options: SuiteBridgeOptions = {},
  ) {
    this.call = options.call ?? callSiblingJson;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? SUITE_LIMITS.fetchTimeoutMs;
    this.onPrChanged = options.onPrChanged;
  }

  attachSuite(suite: SuiteService): void {
    this.suite = suite;
    const prev = this.onPrChanged;
    this.onPrChanged = () => {
      suite.clearCache("pr");
      prev?.();
    };
  }

  private async storedPr(): Promise<StoredPrToken | undefined> {
    if (!this.vault.enabled) return undefined;
    try {
      return await this.vault.get<StoredPrToken>(SUITE_PR_VAULT_KEY);
    } catch (error) {
      if (error instanceof VaultKeyError) return undefined;
      throw error;
    }
  }

  async prToken(): Promise<string | null> {
    if (this.config.suitePrToken) return this.config.suitePrToken;
    const stored = await this.storedPr();
    return stored?.token ?? null;
  }

  async prStatus(): Promise<SuitePrStatus> {
    const link = this.config.suite.links.pr;
    const fetchConfigured = Boolean(this.config.suite.fetch.pr);
    const configured = Boolean(link || fetchConfigured);
    if (this.config.suitePrToken) {
      return {
        configured,
        fetchConfigured,
        ...(link ? { link } : {}),
        connected: true,
        source: "env",
        vaultEnabled: this.vault.enabled,
      };
    }
    const stored = await this.storedPr();
    if (stored?.token) {
      return {
        configured,
        fetchConfigured,
        ...(link ? { link } : {}),
        connected: true,
        source: "vault",
        ...(stored.deviceName ? { deviceName: stored.deviceName } : {}),
        ...(stored.savedAt ? { connectedAt: stored.savedAt } : {}),
        vaultEnabled: this.vault.enabled,
      };
    }
    return {
      configured,
      fetchConfigured,
      ...(link ? { link } : {}),
      connected: false,
      source: null,
      vaultEnabled: this.vault.enabled,
    };
  }

  async pairPr(rawCode: string): Promise<SuitePrStatus> {
    if (!this.vault.enabled) throw new AppError(503, "伺服器還沒有設定加密金鑰，無法保存 BELL PR 連線憑證。");
    const origin = this.config.suite.fetch.pr;
    if (!origin) throw new AppError(409, "尚未設定 BELL PR 本機連線位址。");
    const code = rawCode.trim();
    if (!code || code.length > 32) throw new AppError(400, "請輸入 BELL PR 顯示的配對碼。");

    let response;
    try {
      response = await this.call({
        origin,
        method: "POST",
        path: "/api/pair",
        body: { code, name: "BELL Personal" },
        timeoutMs: Math.max(this.timeoutMs, 5000),
        maxBytes: SUITE_LIMITS.fetchMaxBytes,
      });
    } catch (error) {
      throw new AppError(502, error instanceof SuiteReadError && error.reason === "timeout"
        ? "連線 BELL PR 逾時，請確認 BELL PR 正在執行。"
        : "無法連線 BELL PR，請確認服務正在執行。");
    }

    if (response.status === 423) {
      throw new AppError(423, "BELL PR 配對已暫時鎖定，請先在 BELL PR 解除鎖定後再試。");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(401, "配對碼無效或已過期，請在 BELL PR 重新產生配對碼。");
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new AppError(502, siblingErrorMessage(response.json, "BELL PR 未完成配對，請稍後再試。"));
    }

    const body = response.json as { token?: unknown; deviceId?: unknown; name?: unknown } | null;
    if (!body || typeof body.token !== "string" || !body.token.trim()) {
      throw new AppError(502, "BELL PR 回傳的配對資料不完整。");
    }

    await this.vault.set(SUITE_PR_VAULT_KEY, {
      token: body.token.trim(),
      ...(typeof body.deviceId === "string" ? { deviceId: body.deviceId } : {}),
      deviceName: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "BELL Personal",
      savedAt: this.now().toISOString(),
    } satisfies StoredPrToken);
    this.onPrChanged?.();
    return this.prStatus();
  }

  async setPrToken(rawToken: string): Promise<SuitePrStatus> {
    if (!this.vault.enabled) throw new AppError(503, "伺服器還沒有設定加密金鑰，無法保存 BELL PR 連線憑證。");
    const origin = this.config.suite.fetch.pr;
    if (!origin) throw new AppError(409, "尚未設定 BELL PR 本機連線位址。");
    const token = rawToken.trim();
    if (!token || token.length > 256 || /\s/.test(token)) {
      throw new AppError(400, "請輸入有效的 BELL PR 存取權杖（不可包含空白）。");
    }

    let check;
    try {
      check = await this.call({
        origin,
        method: "GET",
        path: "/api/suite/today",
        bearerToken: token,
        timeoutMs: Math.max(this.timeoutMs, 5000),
        maxBytes: SUITE_LIMITS.fetchMaxBytes,
      });
    } catch {
      throw new AppError(502, "無法連線 BELL PR 驗證權杖，請確認服務正在執行。");
    }
    if (check.status === 401 || check.status === 403) {
      throw new AppError(401, "BELL PR 拒絕了這組存取權杖，請確認後再試。");
    }
    if (check.status !== 200) {
      throw new AppError(502, "BELL PR 暫時無法驗證權杖，請稍後再試。");
    }

    await this.vault.set(SUITE_PR_VAULT_KEY, {
      token,
      deviceName: "存取權杖",
      savedAt: this.now().toISOString(),
    } satisfies StoredPrToken);
    this.onPrChanged?.();
    return this.prStatus();
  }

  async disconnectPr(): Promise<SuitePrStatus> {
    if (this.config.suitePrToken) {
      throw new AppError(409, "BELL PR 權杖由部署設定提供，無法在畫面中移除。");
    }
    if (!this.vault.enabled) throw new AppError(503, "伺服器還沒有設定加密金鑰。");
    await this.vault.delete(SUITE_PR_VAULT_KEY);
    this.onPrChanged?.();
    return this.prStatus();
  }

  /* ── Cross-Product Reads & Actions for Personal Bot ─────────────────── */

  async readExplainSnapshot(): Promise<ExplainSuiteSnapshot> {
    const origin = this.config.suite.fetch.explain;
    const link = this.config.suite.links.explain ?? null;
    if (!origin) {
      return {
        configured: Boolean(link),
        link,
        status: "unconfigured",
        counts: null,
        lessons: [],
      };
    }

    const [sourcesRes, lessonsRes] = await Promise.allSettled([
      this.suite ? this.suite.sources(false) : Promise.resolve(null),
      this.call({
        origin,
        method: "GET",
        path: "/api/lessons",
        timeoutMs: this.timeoutMs,
        maxBytes: 256 * 1024,
      }),
    ]);

    const explainSource = sourcesRes.status === "fulfilled"
      ? sourcesRes.value?.sources.find((s) => s.appId === "explain")
      : undefined;
    const status = explainSource?.status ?? "unavailable";
    const counts = explainSource?.feed?.counts ?? null;

    const lessons: ExplainLessonDigest[] = [];
    if (lessonsRes.status === "fulfilled" && lessonsRes.value.status === 200 && Array.isArray(lessonsRes.value.json)) {
      const rawLessons = lessonsRes.value.json as Array<Record<string, unknown>>;
      const userFirst = rawLessons.filter((item) => item && typeof item === "object" && item.isDemo !== true);
      userFirst.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      for (const item of userFirst) {
        if (lessons.length >= 8) break;
        const id = typeof item.id === "string" ? item.id : "";
        const title = typeof item.title === "string" ? clip(item.title, 120) : "";
        if (!id || !title) continue;
        const summarySource = typeof item.answer === "string" && item.answer.trim()
          ? item.answer
          : typeof item.summary === "string" && item.summary.trim()
            ? item.summary
            : typeof item.subtitle === "string"
              ? item.subtitle
              : "";
        const tags = Array.isArray(item.tags)
          ? item.tags.filter((t): t is string => typeof t === "string").slice(0, 5).map((t) => clip(t, 32))
          : [];
        lessons.push({
          id,
          title,
          summary: clip(summarySource, 180),
          ...(typeof item.category === "string" && item.category.trim() ? { category: clip(item.category, 40) } : {}),
          tags,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
          ...(link && SUITE_OBJECT_ID.test(id) ? { href: `${link}/#/note/${id}` } : {}),
        });
      }
    }

    return {
      configured: true,
      link,
      status,
      counts,
      lessons,
    };
  }

  async createExplainNote(input: {
    content: string;
    question?: string | null;
    depth?: "beginner" | "intermediate" | "advanced" | null;
  }): Promise<{ jobId: string; title: string; href?: string }> {
    const origin = this.config.suite.fetch.explain;
    if (!origin) throw new AppError(409, "尚未設定 BELL Explain 連線位址。");
    const content = input.content.trim();
    if (content.length < 2) throw new AppError(400, "請提供至少 2 個字元的學習筆記主題或內容。");
    const kind = /^https?:\/\/\S+$/i.test(content) ? "url" : "concept";
    const question = input.question?.trim() || undefined;
    const depth = input.depth ?? "intermediate";

    let response;
    try {
      response = await this.call({
        origin,
        method: "POST",
        path: "/api/generate",
        body: {
          kind,
          content,
          depth,
          ...(question ? { question } : {}),
        },
        timeoutMs: Math.max(this.timeoutMs, 8000),
        maxBytes: SUITE_LIMITS.fetchMaxBytes,
        firstNdjsonLine: true,
      });
    } catch {
      throw new AppError(502, "無法連線 BELL Explain 建立學習筆記，請確認服務正在執行。");
    }

    if (response.status !== 200) {
      throw new AppError(
        response.status >= 400 && response.status < 500 ? response.status : 502,
        siblingErrorMessage(response.json, "BELL Explain 無法開始產生這篇筆記。"),
      );
    }
    const event = response.json as { type?: unknown; id?: unknown } | null;
    const jobId = event && event.type === "job" && typeof event.id === "string" ? event.id : "started";
    const title = clip(question ?? content.split("\n")[0] ?? "學習筆記", 80);
    const link = this.config.suite.links.explain;
    return {
      jobId,
      title,
      ...(link ? { href: `${link}/#/library` } : {}),
    };
  }

  async readPrSnapshot(): Promise<PrSuiteSnapshot> {
    const statusInfo = await this.prStatus();
    const origin = this.config.suite.fetch.pr;
    const link = statusInfo.link ?? null;
    const token = await this.prToken();
    if (!origin || !token) {
      return {
        configured: statusInfo.configured,
        connected: false,
        link,
        status: statusInfo.configured ? "unsupported" : "unconfigured",
        counts: null,
        repos: [],
        runs: [],
      };
    }

    const [sourcesRes, reposRes, runsRes] = await Promise.allSettled([
      this.suite ? this.suite.sources(false) : Promise.resolve(null),
      this.call({
        origin,
        method: "GET",
        path: "/api/repos",
        bearerToken: token,
        timeoutMs: this.timeoutMs,
        maxBytes: 128 * 1024,
      }),
      this.call({
        origin,
        method: "GET",
        path: "/api/runs",
        bearerToken: token,
        timeoutMs: this.timeoutMs,
        maxBytes: 256 * 1024,
      }),
    ]);

    const prSource = sourcesRes.status === "fulfilled"
      ? sourcesRes.value?.sources.find((s) => s.appId === "pr")
      : undefined;

    const repos: PrRepoDigest[] = [];
    if (reposRes.status === "fulfilled" && reposRes.value.status === 200 && reposRes.value.json && typeof reposRes.value.json === "object") {
      const list = (reposRes.value.json as { repos?: unknown }).repos;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (repos.length >= 10) break;
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : "";
          const name = typeof record.name === "string" ? clip(record.name, 80) : "";
          if (!id || !name) continue;
          repos.push({
            id,
            name,
            ...(typeof record.defaultBranch === "string" ? { defaultBranch: clip(record.defaultBranch, 40) } : {}),
          });
        }
      }
    }

    const runs: PrRunDigest[] = [];
    if (runsRes.status === "fulfilled" && runsRes.value.status === 200 && runsRes.value.json && typeof runsRes.value.json === "object") {
      const list = (runsRes.value.json as { runs?: unknown }).runs;
      if (Array.isArray(list)) {
        const sorted = [...list].filter((r): r is Record<string, unknown> => Boolean(r && typeof r === "object"));
        sorted.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
        for (const record of sorted) {
          if (runs.length >= 8) break;
          const id = typeof record.id === "string" ? record.id : "";
          const repoId = typeof record.repoId === "string" ? record.repoId : "";
          const title = typeof record.title === "string" ? clip(record.title, 120) : "";
          const runStatus = typeof record.status === "string" ? record.status : "unknown";
          if (!id || !title) continue;
          runs.push({
            id,
            repoId,
            title,
            status: runStatus,
            learnByHand: record.learnByHand === true,
            ...(typeof record.prUrl === "string" ? { prUrl: record.prUrl } : {}),
            ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
            ...(link && SUITE_OBJECT_ID.test(id) ? { href: `${link}/#/runs/${id}` } : {}),
          });
        }
      }
    }

    return {
      configured: true,
      connected: true,
      link,
      status: prSource?.status ?? (reposRes.status === "fulfilled" && reposRes.value.status === 200 ? "ready" : "unavailable"),
      counts: prSource?.feed?.counts ?? null,
      repos,
      runs,
    };
  }

  async createPrRun(input: {
    repoId: string;
    prompt: string;
    title?: string | null;
    learnByHand?: boolean | null;
  }): Promise<{ runId: string; title: string; status: string; href?: string }> {
    const origin = this.config.suite.fetch.pr;
    const token = await this.prToken();
    if (!origin || !token) {
      throw new AppError(409, "尚未連接 BELL PR，請先在「連線與設定 › 帳號與來源」完成配對。");
    }
    const title = input.title?.trim() ? input.title.trim().slice(0, 180) : undefined;
    let prompt = input.prompt.trim();
    if (prompt.length < 10 && title) prompt = `${title}：${prompt}`.trim();
    if (prompt.length < 10) prompt = `${prompt}（由 BELL Personal Bot 建立）`;

    let response;
    try {
      response = await this.call({
        origin,
        method: "POST",
        path: "/api/runs",
        bearerToken: token,
        body: {
          repoId: input.repoId.trim(),
          prompt,
          ...(title ? { title } : {}),
          ...(input.learnByHand ? { learnByHand: true } : {}),
        },
        timeoutMs: Math.max(this.timeoutMs, 8000),
        maxBytes: 128 * 1024,
      });
    } catch {
      throw new AppError(502, "無法連線 BELL PR 建立任務，請確認服務正在執行。");
    }

    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      throw new AppError(
        response.status >= 400 && response.status < 500 ? response.status : 502,
        siblingErrorMessage(response.json, "BELL PR 無法建立這項任務。"),
      );
    }

    const run = (response.json as { run?: Record<string, unknown> } | null)?.run;
    const runId = typeof run?.id === "string" ? run.id : "";
    if (!runId) throw new AppError(502, "BELL PR 回傳的任務資料不完整。");
    const runTitle = typeof run?.title === "string" ? clip(run.title, 120) : title ?? clip(prompt, 80);
    const runStatus = typeof run?.status === "string" ? run.status : "queued";
    this.onPrChanged?.();
    const link = this.config.suite.links.pr;
    return {
      runId,
      title: runTitle,
      status: runStatus,
      ...(link && SUITE_OBJECT_ID.test(runId) ? { href: `${link}/#/runs/${runId}` } : {}),
    };
  }

  async approvePrPlan(input: { runId: string }): Promise<{ runId: string; title: string; status: string; href?: string }> {
    const origin = this.config.suite.fetch.pr;
    const token = await this.prToken();
    if (!origin || !token) {
      throw new AppError(409, "尚未連接 BELL PR，請先在「連線與設定 › 帳號與來源」完成配對。");
    }
    const runId = input.runId.trim();
    if (!SUITE_OBJECT_ID.test(runId)) throw new AppError(400, "任務編號格式不正確。");

    let response;
    try {
      response = await this.call({
        origin,
        method: "POST",
        path: `/api/runs/${encodeURIComponent(runId)}/plan/approve`,
        bearerToken: token,
        body: {},
        timeoutMs: Math.max(this.timeoutMs, 8000),
        maxBytes: 128 * 1024,
      });
    } catch {
      throw new AppError(502, "無法連線 BELL PR 核准計畫，請確認服務正在執行。");
    }

    if (response.status !== 200) {
      throw new AppError(
        response.status >= 400 && response.status < 500 ? response.status : 502,
        siblingErrorMessage(response.json, "BELL PR 無法核准這份計畫。"),
      );
    }

    const run = (response.json as { run?: Record<string, unknown> } | null)?.run;
    const runTitle = typeof run?.title === "string" ? clip(run.title, 120) : runId;
    const runStatus = typeof run?.status === "string" ? run.status : "running";
    this.onPrChanged?.();
    const link = this.config.suite.links.pr;
    return {
      runId,
      title: runTitle,
      status: runStatus,
      ...(link && SUITE_OBJECT_ID.test(runId) ? { href: `${link}/#/runs/${runId}` } : {}),
    };
  }
}
