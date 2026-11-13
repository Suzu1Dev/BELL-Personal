import { Router, type Express } from "express";
import { z } from "zod";
import { CAPTURE_LIMITS, TIDY_TARGETS, type CaptureSearchResponse, type CaptureSearchResult, type CaptureStatus } from "../../../shared/connect.js";
import { isModuleVisible } from "../../../shared/profile.js";
import { appContext } from "../../app.js";
import { googleCapabilities, googleConnected } from "../../google/auth.js";
import { streamJob } from "../../jobs-router.js";
import type { FeatureModule, ModuleContext } from "../../modules.js";
import { ideaStore } from "../ideas/store.js";
import { readProjects } from "../todos/projects.js";
import { todoStore } from "../todos/store.js";
import { captureRequestSchema, createCapture } from "./create.js";
import { startParseJob } from "./parse-job.js";
import { revertTidy, startTidy, undoTidy } from "./tidy.js";

const parseSchema = z.object({ text: z.string().trim().min(1, { message: "請先寫下內容" }).max(CAPTURE_LIMITS.text) }).strict();
const tidySchema = z.object({ kind: z.enum(TIDY_TARGETS), id: z.string().min(1).max(100) }).strict();
const tidyUndoSchema = z.object({ token: z.string().uuid() }).strict();

/** The palette's 搜尋 section: todos (open first), ideas and projects whose text matches. */
export function searchCaptures(ctx: ModuleContext, rawQuery: string): CaptureSearchResult[] {
  const query = rawQuery.trim().replace(/^[#＃]/, "").toLowerCase().slice(0, CAPTURE_LIMITS.searchQuery);
  if (!query) return [];
  const todos: CaptureSearchResult[] = todoStore(ctx).search(query, 6).map((todo) => ({
    kind: "todo", id: todo.id, title: todo.title, href: `#/tasks?focus=${encodeURIComponent(todo.id)}`,
    ...(todo.status === "done" ? { done: true } : {}),
    ...(todo.dueDay ? { dueDay: todo.dueDay } : {}), ...(todo.dueTime ? { dueTime: todo.dueTime } : {}),
  }));
  const ideas: CaptureSearchResult[] = ideaStore(ctx).list({ limit: 2000 })
    .filter((idea) => idea.text.toLowerCase().includes(query) || (idea.title ?? "").toLowerCase().includes(query) || idea.tags.some((tag) => tag.toLowerCase().includes(query)))
    .slice(0, 6)
    .map((idea) => ({ kind: "idea", id: idea.id, title: idea.title ?? idea.text, href: `#/ideas?focus=${encodeURIComponent(idea.id)}`, at: idea.createdAt }));
  // 設定 › 身分與功能: no project results while the projects feature is hidden.
  const settings = ctx.settings.get();
  const projects: CaptureSearchResult[] = !isModuleVisible("projects", settings["profile.roles"], settings["features.overrides"]) ? [] : readProjects(ctx)
    .filter((project) => project.status !== "archived" && project.name.toLowerCase().includes(query))
    .slice(0, 4)
    .map((project) => ({ kind: "project", id: project.id, title: project.name, href: `#/work/projects/${encodeURIComponent(project.id)}`, pct: project.pct }));
  // Interleave so one kind never hides the others, then cap.
  const out: CaptureSearchResult[] = [];
  for (let index = 0; out.length < CAPTURE_LIMITS.searchResults && index < 6; index++)
    for (const list of [todos, ideas, projects]) if (list[index] && out.length < CAPTURE_LIMITS.searchResults) out.push(list[index]);
  return out;
}

/**
 * 快速記下 module (tasks team): POST /api/capture creates the todo, event or
 * idea a capture describes (the rule parser in shared/capture-parse.ts runs
 * again here when the client sends no type); POST /api/capture/parse is the
 * optional AI parse (job `quick-capture`, CAPTURE_PARSE_TIMEOUT_MS once the CLI runs, cancelled when its request goes away); GET /api/capture/search backs
 * the palette's 搜尋. Events go through the calendar module's `event`
 * acceptor (docs/ARCHITECTURE.md §10.6). No today() contribution.
 *
 * 自動整理 (tidy.ts): a capture that saved a todo or event starts the
 * `capture-tidy` job and returns it as `tidy`; POST /api/capture/tidy runs the
 * same job on demand (整理), POST /api/capture/tidy/undo puts the fields back
 * (the toast's 復原), POST /api/capture/tidy/revert does it from the record (復原整理).
 */
export const captureModule: FeatureModule = {
  name: "capture",
  label: "快速記下",
  setup(ctx) {
    // Load both stores now so their trash restorers exist even before the todos/ideas routes are used.
    todoStore(ctx);
    ideaStore(ctx);
    const router = Router();

    router.post("/", async (req, res) => {
      const input = captureRequestSchema.parse(req.body);
      const acceptor = appContext(req.app as Express).modules.acceptor("event");
      res.status(201).json(await createCapture(ctx, input, acceptor));
    });

    router.post("/parse", (req, res) => {
      const { text } = parseSchema.parse(req.body);
      const job = startParseJob(ctx, text);
      // Only this request reads the parse and the palette never resumes it: when the palette aborts it
      // (typing on, closing) the job stops too, even if it never read the job id to send DELETE.
      streamJob(res, ctx.jobs, job.id, 0, { cancelOnDisconnect: true });
    });

    router.post("/tidy", (req, res) => {
      const { kind, id } = tidySchema.parse(req.body);
      res.status(202).json(startTidy(ctx, kind, id, { auto: false }));
    });

    router.post("/tidy/undo", (req, res) => {
      res.json(undoTidy(ctx, tidyUndoSchema.parse(req.body).token));
    });

    router.post("/tidy/revert", (req, res) => {
      const { kind, id } = tidySchema.parse(req.body);
      res.json(revertTidy(ctx, kind, id));
    });

    router.get("/search", (req, res) => {
      const query = typeof req.query.q === "string" ? req.query.q : "";
      const body: CaptureSearchResponse = { results: searchCaptures(ctx, query) };
      res.json(body);
    });

    return {
      router,
      status: async (): Promise<CaptureStatus> => {
        const google = ctx.settings.value("calendar.addToGoogle") && (await googleConnected(ctx)) && (await googleCapabilities(ctx)).calendarWrite;
        // Offer AI 解析 only when it can run: 使用 AI on and the selected CLI signed in (the probe is cached 10 s and shared with /api/status).
        const provider = ctx.provider.settings().provider;
        const signedIn = ctx.settings.value("ai.enabled") && (await ctx.status.probe()).clis[provider].authenticated;
        return { aiParse: signedIn, eventTarget: google ? "google" : "local" };
      },
    };
  },
};
