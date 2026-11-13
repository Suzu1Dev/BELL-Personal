import type { MailMessage } from "../../../shared/mail.js";
import { INBOX_CATEGORIES } from "../../../shared/mail.js";
import { AppError } from "../../errors.js";
import { googleCapabilities, googleConnected } from "../../google/auth.js";
import type { ActionHandler, ActionPlan, ModuleContext } from "../../modules.js";
import { defaultLabel } from "../../today/actions.js";
import { GMAIL_ERRORS, GmailApi, mapLimit } from "./api.js";
import { classifyThread, DIGEST_CATEGORIES, latestByThread } from "./classify.js";
import type { LiveMail } from "./live.js";
import { digestMessages } from "./rows.js";
import type { LabelEdit, MailStore } from "./store.js";

/**
 * actions.gmail (ARCHITECTURE §10.3, §10.10, SPEC-ux §6.4, SPEC-mail-assignments §1.3). Targets:
 *   gmail:<message id>             one conversation (its newest listed message is the row), cached or not
 *   gmail:digest[:<key>]           Today's digest: 全部標為已讀, or one category's action
 *   gmail:category:<InboxCategory> #/inbox category header: 全部標為已讀
 * 封存 removes INBOX, 標為已讀 removes UNREAD, 刪除 moves the conversation to
 * Gmail's trash (threads.trash, never a permanent delete) and 移回收件匣 adds
 * INBOX: in the cache at once when the conversation is cached (the inbox,
 * the unread badge and the digest change before the 202), in Gmail after the
 * 6.5 s undo window, with the inverse change as `revert`. A conversation
 * outside the cache (封存 view, search) is resolved with one
 * messages.get(format=minimal) and changes only in Gmail. 回覆, 開啟, 延後 and
 * 略過 are the core's; this handler only labels them.
 */

const CORE_ACTIONS = new Set(["reply", "open", "snooze", "dismiss", "submitted", "reviewed"]);
const THREAD_ACTIONS = new Set(["archive", "read", "trash", "unarchive"]);
type ThreadAction = "archive" | "read" | "trash" | "unarchive";

export interface MailActionDeps {
  store: MailStore;
  /** Message ids an AI suggestion was made from (digest membership). */
  suggested: () => ReadonlySet<string>;
  /** Row ids set aside by item state (they are not in the digest either). */
  aside: () => ReadonlySet<string>;
  /** Live reads held in memory: an action on a conversation drops them. */
  live: LiveMail;
}

/** The one messages.get that resolves a conversation outside the cache, before the 202. */
const LOOKUP_TIMEOUT_MS = 20_000;

const LABELS: Record<ThreadAction, string> = { archive: "已封存", read: "已標為已讀", trash: "已移到垃圾桶", unarchive: "已移回收件匣" };

export function gmailActionHandler(deps: MailActionDeps): ActionHandler {
  return async (request, ctx) => {
    if (CORE_ACTIONS.has(request.action)) return { label: defaultLabel(request.action) };
    if (!THREAD_ACTIONS.has(request.action)) throw new AppError(400, "這封信不能這樣處理。");
    const action = request.action as ThreadAction;
    // Refuse at once rather than undo it 6.5 s later when the write cannot reach Gmail.
    if (!(await googleConnected(ctx)) || !(await googleCapabilities(ctx)).gmail) throw new AppError(503, GMAIL_ERRORS.notConnected);

    const bulk = /^(digest|category)(?::([a-z-]+))?$/.exec(request.sourceId);
    if (bulk) {
      if (action !== "archive" && action !== "read") throw new AppError(400, "這封信不能這樣處理。");
      const edit: LabelEdit = action === "archive" ? { add: [], remove: ["INBOX"] } : { add: [], remove: ["UNREAD"] };
      return bulkPlan(ctx, deps, action, edit, bulk[1] as "digest" | "category", bulk[2]);
    }

    const message = deps.store.get(request.sourceId);
    if (message) return cachedPlan(ctx, deps, action, message);
    return livePlan(ctx, deps, action, request.sourceId);
  };
}

/**
 * The local edits of an action on a cached conversation (one per label, so
 * undo restores exactly what changed). 移回收件匣 on a conversation in the
 * trash also takes it out of the trash.
 */
function localEdits(action: ThreadAction, trashed: boolean): LabelEdit[] {
  switch (action) {
    case "archive": return [{ add: [], remove: ["INBOX"] }];
    case "read": return [{ add: [], remove: ["UNREAD"] }];
    case "trash": return [{ add: ["TRASH"], remove: [] }, { add: [], remove: ["INBOX"] }];
    case "unarchive": return [{ add: ["INBOX"], remove: [] }, ...(trashed ? [{ add: [], remove: ["TRASH"] }] : [])];
  }
}

/** An action on a conversation in the cache: local at once, Gmail after the commit (threads.modify / trash). */
function cachedPlan(ctx: ModuleContext, deps: MailActionDeps, action: ThreadAction, message: MailMessage): ActionPlan {
  const { store, live } = deps;
  const { threadId } = message;
  const thread = store.thread(threadId);
  const ids = thread.map((item) => item.id);
  const inInbox = thread.some((item) => item.labels.includes("INBOX"));
  const trashed = thread.every((item) => item.labels.includes("TRASH"));
  if (action === "trash" && trashed) throw new AppError(409, GMAIL_ERRORS.alreadyTrash);
  if (action === "unarchive" && inInbox && !trashed) throw new AppError(409, GMAIL_ERRORS.alreadyInbox);
  let edits: Array<ReturnType<MailStore["edit"]>> = [];
  let before: ThreadSnapshot | undefined;
  return {
    label: LABELS[action],
    apply: () => {
      edits = localEdits(action, trashed).map((edit) => store.edit(ids, edit));
      live.forgetThread(threadId);
    },
    remote: async (signal) => {
      before = await remoteWrite(GmailApi.withSignal(ctx, signal), action, threadId, trashed);
      for (const edit of edits) edit.settle();
      live.forgetThread(threadId);
    },
    undo: () => {
      for (const edit of [...edits].reverse()) edit.revert();
      live.forgetThread(threadId);
    },
    revert: async (signal) => {
      await remoteRevert(GmailApi.withSignal(ctx, signal), action, threadId, { inInbox, trashed, before });
      live.forgetThread(threadId);
    },
  };
}

/**
 * An action on a conversation outside the cache (封存 view, search results):
 * one messages.get(format=minimal) finds its thread and labels; nothing local
 * changes, so the next list from Gmail shows the result.
 */
async function livePlan(ctx: ModuleContext, deps: MailActionDeps, action: ThreadAction, messageId: string): Promise<ActionPlan> {
  const resource = await GmailApi.withSignal(ctx, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)).message(messageId, "minimal");
  if (!resource) throw new AppError(404, GMAIL_ERRORS.messageMissing);
  const { threadId } = resource;
  const labels = resource.labelIds ?? [];
  const inInbox = labels.includes("INBOX");
  const trashed = labels.includes("TRASH");
  if (action === "trash" && trashed) throw new AppError(409, GMAIL_ERRORS.alreadyTrash);
  if (action === "unarchive" && inInbox && !trashed) throw new AppError(409, GMAIL_ERRORS.alreadyInbox);
  const { live } = deps;
  let before: ThreadSnapshot | undefined;
  return {
    label: LABELS[action],
    apply: () => { live.forgetThread(threadId); },
    remote: async (signal) => {
      before = await remoteWrite(GmailApi.withSignal(ctx, signal), action, threadId, trashed);
      live.forgetThread(threadId);
    },
    revert: async (signal) => {
      await remoteRevert(GmailApi.withSignal(ctx, signal), action, threadId, { inInbox, trashed, before });
      live.forgetThread(threadId);
    },
  };
}

/**
 * The conversation's messages just before 刪除 or 標為已讀 reached Gmail
 * (one threads.get format=minimal): which were outside the trash, which had
 * INBOX and which were unread, so 復原 after the commit restores exactly those
 * and nothing the owner had already deleted or read in Gmail.
 */
interface ThreadSnapshot {
  outsideTrash: string[];
  inbox: string[];
  unread: string[];
}

async function snapshotThread(api: GmailApi, threadId: string): Promise<ThreadSnapshot> {
  const messages = (await api.thread(threadId, "minimal"))?.messages ?? [];
  const having = (label: string) => messages.filter((message) => (message.labelIds ?? []).includes(label)).map((message) => message.id);
  const trashed = new Set(having("TRASH"));
  return { outsideTrash: messages.map((message) => message.id).filter((id) => !trashed.has(id)), inbox: having("INBOX"), unread: having("UNREAD") };
}

/** The write after the undo window; 刪除 and 標為已讀 return what they are about to change, for 復原. */
async function remoteWrite(api: GmailApi, action: ThreadAction, threadId: string, trashed: boolean): Promise<ThreadSnapshot | undefined> {
  switch (action) {
    case "archive":
      await api.modifyThread(threadId, { remove: ["INBOX"] });
      return undefined;
    case "read": {
      const before = await snapshotThread(api, threadId);
      await api.modifyThread(threadId, { remove: ["UNREAD"] });
      return before;
    }
    case "trash": {
      const before = await snapshotThread(api, threadId);
      await api.trashThread(threadId);
      return before;
    }
    case "unarchive":
      // From the trash (a reader opened by a link): out of the trash first, then INBOX, as Gmail's 移至收件匣 does.
      if (trashed) await api.untrashThread(threadId);
      await api.modifyThread(threadId, { add: ["INBOX"] });
      return undefined;
  }
}

/**
 * 復原 after the commit. 刪除: messages.untrash on exactly the messages that
 * were outside the trash (threads.untrash would also bring back a message
 * the owner had deleted in Gmail before), then INBOX on the ones that had it
 * (the reference does not say whether untrash restores labels; adding it
 * again is harmless). 標為已讀: UNREAD on the messages that were unread.
 */
async function remoteRevert(api: GmailApi, action: ThreadAction, threadId: string, state: { inInbox: boolean; trashed: boolean; before?: ThreadSnapshot }): Promise<void> {
  const { before } = state;
  switch (action) {
    case "archive": return api.modifyThread(threadId, { add: ["INBOX"] });
    case "unarchive": return state.trashed ? api.trashThread(threadId) : api.modifyThread(threadId, { remove: ["INBOX"] });
    case "read":
      if (before?.unread.length) await api.batchModify(before.unread, { add: ["UNREAD"] });
      return;
    case "trash":
      if (!before) {
        // Written before snapshots existed (or Gmail answered nothing): the whole conversation, as before.
        await api.untrashThread(threadId);
        if (state.inInbox) await api.modifyThread(threadId, { add: ["INBOX"] });
        return;
      }
      await mapLimit(before.outsideTrash, 4, (id) => api.untrashMessage(id));
      if (before.inbox.length) await api.batchModify(before.inbox, { add: ["INBOX"] });
  }
}

function bulkPlan(ctx: ModuleContext, deps: MailActionDeps, action: "archive" | "read", edit: LabelEdit, scope: "digest" | "category", key: string | undefined): ActionPlan {
  const settings = ctx.settings.get();
  const base = { schoolDomains: settings["mail.schoolDomains"], timeZone: ctx.config.timeZone, now: ctx.now(), suggested: deps.suggested() };
  let messages: MailMessage[];
  if (scope === "digest") {
    if (key && !DIGEST_CATEGORIES.some((category) => category.key === key)) throw new AppError(400, "沒有這個信件分類。");
    if (key && DIGEST_CATEGORIES.find((category) => category.key === key)!.action !== action && action !== "read")
      throw new AppError(400, "這個分類不能這樣處理。");
    messages = digestMessages({ ...base, messages: deps.store.all(), aside: deps.aside() }, key);
  } else {
    if (!key || !(INBOX_CATEGORIES as readonly string[]).includes(key)) throw new AppError(400, "沒有這個信件分類。");
    if (action !== "read") throw new AppError(400, "這個分類不能這樣處理。");
    messages = latestByThread(deps.store.inbox())
      .filter((thread) => classifyThread(thread, base).category === key)
      .flatMap((thread) => thread.messages);
  }
  const label = action === "read" ? "UNREAD" : "INBOX";
  const ids = messages.filter((message) => message.labels.includes(label)).map((message) => message.id);
  if (!ids.length) throw new AppError(409, action === "read" ? "這個分類已經沒有未讀的信。" : "這個分類已經沒有信了。");
  const threads = new Set(messages.filter((message) => ids.includes(message.id)).map((message) => message.threadId)).size;
  let local: ReturnType<MailStore["edit"]> | undefined;
  return {
    label: action === "read" ? `已將 ${threads} 封標為已讀` : `已封存 ${threads} 封`,
    apply: () => { local = deps.store.edit(ids, edit); },
    remote: async (signal) => {
      await GmailApi.withSignal(ctx, signal).batchModify(ids, edit);
      local?.settle();
    },
    undo: () => { local?.revert(); },
    revert: async (signal) => {
      if (local?.changed.length) await GmailApi.withSignal(ctx, signal).batchModify(local.changed, { add: edit.remove });
    },
  };
}
