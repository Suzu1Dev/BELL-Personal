import { Router } from "express";
import { z } from "zod";
import type { GmailPurgeResponse } from "../../../shared/connect.js";
import type { InboxListResponse, InboxSourceState, InboxThreadResponse, MailModuleStatus, MailProcessStart, MailSearchResponse } from "../../../shared/mail.js";
import { isModuleVisible } from "../../../shared/profile.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { FeatureModule, ModuleContext } from "../../modules.js";
import { forgetMailDerivedData } from "../../google/forget.js";
import { todaySource } from "../../today/service.js";
import { gmailActionHandler } from "./actions.js";
import { addBodyRoutes, imageProxyRouter } from "./body-routes.js";
import { ImageProxy, ImageSigner } from "./image-proxy.js";
import { GMAIL_ERRORS, liveFailure } from "./api.js";
import { inboxList, inboxThread, type InboxInput } from "./inbox.js";
import { liveMail } from "./live.js";
import { startMailProcess } from "./process.js";
import { mailContribution } from "./rows.js";
import { gmailReady, readLiveThread, searchMail } from "./search.js";
import { MailStore } from "./store.js";
import { GmailSync } from "./sync.js";
import { MailTriageQueue } from "./triage.js";
import { ruleAssignmentSuggestions } from "./triage-assignments.js";
import { localAssignments } from "../lms/native.js";

/**
 * Gmail module (mail team). Source `gmail` (GmailSync: full sync, then
 * history.list every 2 minutes; metadata, snippet and a plain-text excerpt
 * only), the AI triage queue (MailTriageQueue: batches of ≤ 15 once five
 * mails wait, the oldest waited ten minutes, or the inbox is open; rule
 * fallback otherwise), today() rows mail.reply / mail.bill /
 * mail.action plus the digest and the unread badge, actions.gmail (封存,
 * 標為已讀, 刪除 and 移回收件匣, deferred and undoable, single conversations
 * cached or not, and bulk), and the #/inbox endpoints:
 *
 *   GET  /api/gmail/threads             InboxListResponse
 *   GET  /api/gmail/threads/:threadId   InboxThreadResponse (a conversation outside the cache is read live)
 *   POST /api/gmail/threads/:threadId/process  {} → 202 MailProcessStart (the reader's 用 AI 處理, ./process.ts)
 *   GET  /api/gmail/search?view=&q=&pageToken=   MailSearchResponse (封存, 全部, search; SPEC-mail-assignments §3–§4)
 *   GET  /api/gmail/messages/:id/body[?images=1]  MailBodyResponse (the reader's 原始版面, SPEC-mail-html)
 *   GET  /api/gmail/messages/:id/inline/:contentId, …/attachments/:partId   raster images from Gmail
 *   GET  /api/mail-images/proxy?m=&u=&s=  remote images, signed per message, fetched by the server
 *   POST /api/gmail/purge  {}           GmailPurgeResponse (資料與隱私 › 清除快取的信件)
 *
 * Live reads (archived mail, search results, the reader outside the cache,
 * HTML bodies and images) stay in server memory for at most 5 minutes
 * (./live.ts), never on disk.
 *
 * 轉待辦 on a mail row is the tasks module's (anySourceActions.todo); the
 * events and todos the model finds (the triage, or 用 AI 處理 on one
 * conversation) become suggestions accepted by the calendar and tasks modules.
 */

/** Message ids any AI suggestion (pending or decided) was made from: those mails are represented by the suggestion. */
function suggestedIds(ctx: ModuleContext): Set<string> {
  const ids = new Set<string>();
  for (const suggestion of ctx.suggestions.list({ limit: 500 }))
    if (suggestion.sourceRef?.source === "gmail") ids.add(suggestion.sourceRef.externalId);
  return ids;
}

/** Gmail row ids that item state sets aside right now: snoozed until later, or handled / dismissed. */
function asideIds(ctx: ModuleContext): Set<string> {
  const now = ctx.now().getTime();
  const ids = new Set<string>();
  for (const [itemId, state] of ctx.itemState.states()) {
    if (!itemId.startsWith("gmail:")) continue;
    if (state.state === "snoozed" ? !!state.until && Date.parse(state.until) > now : state.state !== "replying") ids.add(itemId);
  }
  return ids;
}

/** Conversations an assignment was made from (轉成作業, 加入作業): their rows say 已轉成作業. */
function convertedThreads(ctx: ModuleContext): Set<string> {
  return new Set(localAssignments(ctx).list().flatMap((assignment) => (assignment.mailRef?.threadId ? [assignment.mailRef.threadId] : [])));
}

const threadIdSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const gmailModule: FeatureModule = {
  name: "gmail",
  label: "Gmail",
  setup(ctx) {
    const store = new MailStore(ctx.sourceItems);
    const live = liveMail(ctx);
    const triage = new MailTriageQueue(ctx, store);
    const sync = new GmailSync(ctx, store, {
      onSynced: () => {
        triage.kick();
        // Assignment announcements the model will not read get rule-made suggestions (lms team's hook).
        try { ruleAssignmentSuggestions(ctx, store); } catch (error) { logEvent("gmail.assignment_rules_failed", { errorClass: error instanceof Error ? error.name : typeof error }); }
      },
    });

    const sourceState = async (): Promise<InboxSourceState> => {
      const status = await sync.status();
      const view = todaySource(status, sync.intervalMs, ctx.now());
      return {
        connected: status.configured,
        state: view.state,
        ...(view.lastSyncedAt ? { lastSyncedAt: view.lastSyncedAt } : {}),
        ...(view.message ? { message: view.message } : {}),
      };
    };
    const inboxInput = async (): Promise<InboxInput> => {
      const settings = ctx.settings.get();
      return {
        messages: store.all(),
        stateOf: (itemId) => ctx.itemState.get(itemId),
        context: {
          schoolDomains: settings["mail.schoolDomains"], timeZone: ctx.config.timeZone, now: ctx.now(), suggested: suggestedIds(ctx),
          assignments: isModuleVisible("lms", settings["profile.roles"], settings["features.overrides"]),
        },
        source: await sourceState(),
        converted: convertedThreads(ctx),
      };
    };

    const router = Router();
    // The reader's original layout: HTML read live and sanitized, images from Gmail or through the signed proxy.
    const signer = new ImageSigner();
    const proxy = new ImageProxy({ network: ctx.publicNetwork, live });
    const ready = async () => gmailReady(ctx, { source: await sourceState() });
    addBodyRoutes(router, ctx, { live, signer, proxy, ready });
    router.get("/threads", async (_req, res) => {
      // Someone is reading the inbox: triage what is waiting now instead of coalescing.
      triage.kick({ now: true });
      const body: InboxListResponse = inboxList(await inboxInput());
      res.json(body);
    });
    router.get("/threads/:threadId", async (req, res) => {
      const parsed = threadIdSchema.safeParse(req.params.threadId);
      if (!parsed.success) throw new AppError(404, "找不到這封信。");
      const input = await inboxInput();
      const suggestions = ctx.suggestions.list({ status: "pending", limit: 500 });
      const found = inboxThread(input, parsed.data, suggestions);
      if (found) {
        const body: InboxThreadResponse = found;
        res.json(body);
        return;
      }
      // Outside the cache (an archived or searched conversation): read it from Gmail, plain text only.
      if (!(await gmailReady(ctx, input))) throw new AppError(404, GMAIL_ERRORS.notCached);
      const body: InboxThreadResponse = await readLiveThread(ctx, { live, input: inboxInput }, input, parsed.data, suggestions)
        .catch((error: unknown) => { throw error instanceof AppError && error.status === 404 ? error : new AppError(error instanceof AppError && error.status === 429 ? 429 : 502, liveFailure(error)); });
      res.json(body);
    });
    router.post("/threads/:threadId/process", (req, res) => {
      const parsed = threadIdSchema.safeParse(req.params.threadId);
      if (!parsed.success) throw new AppError(404, "找不到這封信。");
      z.object({}).strict().parse(req.body ?? {});
      const body: MailProcessStart = startMailProcess(ctx, store, parsed.data);
      res.status(202).json(body);
    });
    router.get("/search", async (req, res) => {
      const body: MailSearchResponse = await searchMail(ctx, { live, input: inboxInput }, req.query);
      res.json(body);
    });
    router.post("/purge", (req, res) => {
      z.object({}).strict().parse(req.body ?? {});
      live.clear();
      const removed = store.clear();
      // Everything derived from the mail goes too: its suggestions, queue state and handled-list subjects.
      forgetMailDerivedData(ctx);
      // The next sync starts over with a full sync of the retention window.
      ctx.syncState.save("gmail", { cursor: null, items: 0 });
      logEvent("gmail.purged", { removed });
      const body: GmailPurgeResponse = { removed };
      res.json(body);
    });

    return {
      router,
      routes: [{ path: "/api/mail-images", router: imageProxyRouter({ signer, proxy }) }],
      sources: [sync],
      today: (context, input) => mailContribution({
        messages: store.all(),
        now: input.now,
        timeZone: input.timeZone,
        schoolDomains: input.settings["mail.schoolDomains"],
        suggested: suggestedIds(context),
        aside: asideIds(context),
        account: sync.account,
        assignments: isModuleVisible("lms", input.settings["profile.roles"], input.settings["features.overrides"]),
      }),
      actions: { gmail: gmailActionHandler({ store, live, suggested: () => suggestedIds(ctx), aside: () => asideIds(ctx) }) },
      status: async (): Promise<MailModuleStatus> => {
        // Offer AI 處理 only when it can run (the probe is cached 10 s and shared with /api/status).
        const provider = ctx.provider.settings().provider;
        const aiProcess = ctx.settings.value("ai.enabled") && (await ctx.status.probe()).clis[provider].authenticated;
        return { messages: store.count(), triage: triage.pending(), triaging: triage.active, aiProcess };
      },
      close: () => { live.close(); return triage.close(); },
    };
  },
};
