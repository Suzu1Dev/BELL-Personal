import { Router, type Response } from "express";
import { z } from "zod";
import {
  ASSIGNMENT_LIMITS, type Assignment, type AssignmentDeleteResponse, type AssignmentSuggestionRow, type AssignmentView,
  type AssignmentsResponse, type LmsAccountView, type LmsOrigin, type LmsStatusResponse,
} from "../../../shared/assignments.js";
import { CONNECT_LIMITS, type DisconnectResponse, type LmsConnectResponse } from "../../../shared/connect.js";
import type { MailMessage } from "../../../shared/mail.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { AUTO_RETRY, ReconnectRequiredError, SourceTimeoutError, SourceUnreachableError, safeFetch } from "../../sync.js";
import { suggestionRow } from "../../today/suggestions.js";
import { canvasSelf, type CanvasSync } from "./canvas.js";
import { LMS_VAULT, assignmentView, cachedAssignments, compareAssignments, itemIdOf, normalizeBaseUrl, siteFor, type CanvasCredential, type MoodleCredential } from "./lms.js";
import { moodleCall, moodleToken, type MoodleSiteInfo, type MoodleSync } from "./moodle.js";
import { allAssignments, localAssignments, nativeUuid } from "./native.js";

const isoInstant = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), { message: "截止時間格式不正確。" });
const httpsLink = z.string().trim().max(ASSIGNMENT_LIMITS.url).refine((value) => {
  if (!value) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, { message: "連結必須是 https:// 開頭的網址。" });

/** POST /api/lms/assignments (AssignmentCreateRequest): 新增作業. */
const assignmentCreateSchema = z.object({
  title: z.string().max(ASSIGNMENT_LIMITS.title),
  courseName: z.string().max(ASSIGNMENT_LIMITS.courseName).optional(),
  dueAt: isoInstant.nullable().optional(),
  dueDateOnly: z.boolean().optional(),
  submitHint: z.string().max(ASSIGNMENT_LIMITS.submitHint).optional(),
  url: httpsLink.optional(),
  notes: z.string().max(ASSIGNMENT_LIMITS.notes).optional(),
}).strict();

/** PATCH /api/lms/assignments/:id (AssignmentUpdateRequest): any subset; null or "" clears an optional field. */
const assignmentUpdateSchema = z.object({
  title: z.string().max(ASSIGNMENT_LIMITS.title).optional(),
  courseName: z.string().max(ASSIGNMENT_LIMITS.courseName).nullable().optional(),
  dueAt: isoInstant.nullable().optional(),
  dueDateOnly: z.boolean().optional(),
  submitHint: z.string().max(ASSIGNMENT_LIMITS.submitHint).nullable().optional(),
  url: httpsLink.nullable().optional(),
  notes: z.string().max(ASSIGNMENT_LIMITS.notes).nullable().optional(),
}).strict();

/** Parses a body; a blank title is its own sentence (「作業名稱不能是空白。」), not a field path. */
function parseAssignmentBody<T extends { title?: string }>(schema: z.ZodType<T>, body: unknown): T {
  const input = schema.parse(body);
  if (input.title !== undefined && !input.title.trim()) throw new AppError(400, "作業名稱不能是空白。");
  return input;
}

/** How long a connect request may take in total (token exchange + account check). */
const CONNECT_TIMEOUT_MS = 40_000;

const moodleBody = z.object({
  baseUrl: z.string().trim().min(1).max(CONNECT_LIMITS.url),
  username: z.string().trim().min(1).max(CONNECT_LIMITS.username),
  password: z.string().min(1).max(CONNECT_LIMITS.password),
}).strict();

const canvasBody = z.object({
  baseUrl: z.string().trim().min(1).max(CONNECT_LIMITS.url),
  token: z.string().trim().min(8).max(CONNECT_LIMITS.token).regex(/^[\x21-\x7e]+$/, "權杖只能包含英數字與符號"),
}).strict();

/**
 * A connect is one request: when it fails nothing is stored and nothing
 * retries, so the background wording 「稍後會自動重試」 would tell the user to
 * wait for something that never happens. Say what to do instead.
 */
export function connectFailure(error: unknown): unknown {
  if (error instanceof SourceUnreachableError) return new AppError(502, "連不到這個網址，請確認學校系統的網址後再按一次連接。");
  if (error instanceof SourceTimeoutError || (error instanceof Error && error.name === "TimeoutError"))
    return new AppError(504, "學校系統沒有及時回應，請確認網址後再按一次連接。");
  if (error instanceof AppError && error.message.endsWith(AUTO_RETRY))
    return new AppError(error.status, `${error.message.slice(0, -AUTO_RETRY.length)}請稍後再按一次連接。`);
  return error;
}

/** Runs a connect's calls to the school's site with connectFailure() wording. */
async function connecting<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw connectFailure(error);
  }
}

export interface LmsSources {
  moodle: MoodleSync;
  canvas: CanvasSync;
}

/**
 * /api/lms (docs/ARCHITECTURE.md §10.6):
 *   GET    /                    LmsStatusResponse (both connections, no tokens)
 *   GET    /assignments         AssignmentsResponse (#/work 作業; LMS and native rows, pending mail suggestions)
 *   POST   /assignments         AssignmentCreateRequest → 201 AssignmentView (新增作業; SPEC-mail-assignments §5.8)
 *   PATCH  /assignments/:id     AssignmentUpdateRequest → AssignmentView (native only; LMS rows 409)
 *   DELETE /assignments/:id     {} → AssignmentDeleteResponse (native only; 復原 = POST /api/trash/restore)
 *   POST   /moodle/connect      MoodleConnectRequest → 201 LmsConnectResponse
 *   DELETE /moodle              → DisconnectResponse
 *   POST   /canvas/connect      CanvasConnectRequest → 201 LmsConnectResponse
 *   DELETE /canvas              → DisconnectResponse
 * The Moodle password lives only in the request: it is exchanged once at
 * login/token.php and never stored, logged or returned.
 */
export function createLmsRouter(ctx: ModuleContext, sources: LmsSources): Router {
  const router = Router();

  const requireVault = () => {
    if (!ctx.vault.enabled) throw new AppError(503, "尚未設定主金鑰，無法保存連線憑證。請依部署說明設定後重新啟動服務。");
  };
  const http = (signal: AbortSignal) => (url: string | URL, init?: Parameters<typeof safeFetch>[3]) => safeFetch(ctx.fetch, url, signal, init);

  async function accounts(): Promise<LmsAccountView[]> {
    const [moodle, canvas, moodleStatus, canvasStatus] = await Promise.all([
      sources.moodle.credential().catch(() => undefined),
      sources.canvas.credential().catch(() => undefined),
      sources.moodle.status(),
      sources.canvas.status(),
    ]);
    const moodleSite = siteFor("moodle", moodle?.baseUrl ?? "https://e3p.nycu.edu.tw", moodle?.siteName);
    const canvasSite = siteFor("canvas", canvas?.baseUrl);
    return [
      {
        source: "moodle", connected: !!moodle, short: moodleSite.short, siteLabel: moodleSite.label, status: moodleStatus,
        ...(moodle ? { baseUrl: moodle.baseUrl, connectedAt: moodle.connectedAt, account: { name: moodle.fullName, username: moodle.username, siteName: moodle.siteName } } : {}),
      },
      {
        source: "canvas", connected: !!canvas, short: canvasSite.short, siteLabel: canvasSite.label, status: canvasStatus,
        ...(canvas ? { baseUrl: canvas.baseUrl, connectedAt: canvas.connectedAt, account: { name: canvas.name } } : {}),
      },
    ];
  }

  router.get("/", async (_req, res) => {
    res.json({ accounts: await accounts() } satisfies LmsStatusResponse);
  });

  /** A row for #/work: its status, the mail's sender while the mail is cached, an LMS row's announcing mail. */
  const view = (assignment: Assignment, now: Date, twin?: Assignment): AssignmentView => {
    const row = assignmentView(assignment, ctx.itemState.get(itemIdOf(assignment)), now);
    const mailRef = assignment.mailRef ?? twin?.mailRef;
    const sender = mailRef ? ctx.sourceItems.get<MailMessage>("gmail", mailRef.messageId)?.value.from : undefined;
    return { ...row, ...(mailRef ? { mailRef } : {}), ...(sender ? { mailSender: (sender.name ?? sender.email).slice(0, 80) } : {}) };
  };

  router.get("/assignments", async (_req, res) => {
    const now = ctx.now();
    const merged = allAssignments(ctx);
    const assignments = [...merged.lms, ...merged.native]
      .sort(compareAssignments)
      .map((assignment) => view(assignment, now, merged.duplicates.get(assignment.id)));
    const input = { now, timeZone: ctx.config.timeZone };
    const suggestions: AssignmentSuggestionRow[] = ctx.suggestions.list({ status: "pending", kind: "assignment", limit: 100 })
      .flatMap((suggestion) => {
        const row = suggestionRow(suggestion, input);
        return row ? [{ itemId: row.id, title: row.title, meta: row.meta, actions: row.actions, ...(row.url ? { url: row.url } : {}) }] : [];
      });
    res.json({ accounts: await accounts(), assignments, suggestions } satisfies AssignmentsResponse);
  });

  // Native assignments (local_assignments, SPEC-mail-assignments §5.1, §5.8): 新增作業, 編輯, 刪除作業.
  const store = localAssignments(ctx);
  /** `:id` is the native uuid (or `assignment:<uuid>`); an LMS row is a 409, anything else a 404. */
  const nativeId = (id: string) => {
    if (/^(moodle|canvas)[:-]/.test(id) || cachedAssignments(ctx).some((row) => row.externalId === id || row.id === id))
      throw new AppError(409, "學校系統的作業不能在這裡修改。");
    if (!nativeUuid(id) || !store.get(id)) throw new AppError(404, "找不到這份作業。");
    return id;
  };

  router.post("/assignments", (req, res) => {
    const input = parseAssignmentBody(assignmentCreateSchema, req.body);
    const created = store.create({ origin: "manual", ...input, dueAt: input.dueAt ?? null });
    logEvent("lms.assignment_created", { origin: created.origin });
    res.status(201).json(view(created, ctx.now()));
  });

  router.patch("/assignments/:id", (req, res) => {
    const id = nativeId(req.params.id);
    const patch = parseAssignmentBody(assignmentUpdateSchema, req.body);
    res.json(view(store.update(id, patch), ctx.now()));
  });

  router.delete("/assignments/:id", (req, res) => {
    const id = nativeId(req.params.id);
    z.object({}).strict().parse(req.body ?? {});
    const result = store.delete(id);
    res.json({ deleted: true, ...(result.undoToken ? { undoToken: result.undoToken } : {}) } satisfies AssignmentDeleteResponse);
  });

  router.post("/moodle/connect", async (req, res) => {
    const input = moodleBody.parse(req.body);
    requireVault();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const fetcher = http(AbortSignal.timeout(CONNECT_TIMEOUT_MS));
    const token = await connecting(() => moodleToken(fetcher, baseUrl, input.username, input.password));
    let info: MoodleSiteInfo;
    try {
      info = await connecting(() => moodleCall<MoodleSiteInfo>(fetcher, { baseUrl, token }, "core_webservice_get_site_info"));
    } catch (error) {
      if (error instanceof ReconnectRequiredError) throw new AppError(502, "Moodle 不接受剛取得的權杖，請稍後再試。");
      throw error;
    }
    const credential: MoodleCredential = {
      token,
      baseUrl,
      ...(typeof info.userid === "number" ? { userId: info.userid } : {}),
      ...(info.username ? { username: String(info.username).slice(0, 200) } : {}),
      ...(info.fullname ? { fullName: String(info.fullname).slice(0, 200) } : {}),
      ...(info.sitename ? { siteName: String(info.sitename).slice(0, 200) } : {}),
      connectedAt: ctx.now().toISOString(),
    };
    await ctx.vault.set(LMS_VAULT.moodle, credential);
    await connected("moodle", res, { name: credential.fullName, username: credential.username, siteName: credential.siteName });
  });

  router.delete("/moodle", async (_req, res) => {
    res.json(await disconnect("moodle"));
  });

  router.post("/canvas/connect", async (req, res) => {
    const input = canvasBody.parse(req.body);
    requireVault();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const user = await connecting(() => canvasSelf(http(AbortSignal.timeout(CONNECT_TIMEOUT_MS)), { baseUrl, token: input.token }));
    const name = (user.name ?? user.short_name)?.slice(0, 200);
    const credential: CanvasCredential = {
      token: input.token,
      baseUrl,
      ...(typeof user.id === "number" ? { userId: user.id } : {}),
      ...(name ? { name } : {}),
      connectedAt: ctx.now().toISOString(),
    };
    await ctx.vault.set(LMS_VAULT.canvas, credential);
    await connected("canvas", res, { name, siteName: siteFor("canvas", baseUrl).label });
  });

  router.delete("/canvas", async (_req, res) => {
    res.json(await disconnect("canvas"));
  });

  async function connected(source: LmsOrigin, res: Response, account: LmsConnectResponse["account"]) {
    const sync = sources[source];
    sync.reset();
    void sync.sync();
    logEvent("lms.connected", { source });
    const body: LmsConnectResponse = { connected: true, source, account: dropEmpty(account), status: await sync.status() };
    res.status(201).json(body);
  }

  async function disconnect(source: LmsOrigin): Promise<DisconnectResponse> {
    requireVault();
    await ctx.vault.delete(LMS_VAULT[source]);
    const removedItems = ctx.sourceItems.clear(source);
    sources[source].reset();
    logEvent("lms.disconnected", { source });
    return { disconnected: true, removedItems };
  }

  return router;
}

function dropEmpty<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")) as T;
}
