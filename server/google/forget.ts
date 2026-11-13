import type { ModuleContext } from "../modules.js";

/** What the handled list shows for an action on mail whose data was deleted. */
export const FORGOTTEN_MAIL_TITLE = "（已清除的信件）";

/**
 * Deletes what BELL derived from Gmail messages besides the cached mail
 * itself (/privacy: 中斷連線, 清除快取的信件 and the retention window): AI
 * suggestions made from them (pending ones go, decided ones keep only the
 * decision), the queue state of their `ai:` rows and `gmail:` rows, and the
 * subjects kept as titles in the action log. Every message, or only
 * `messageIds` (mail leaving the retention window).
 */
export function forgetMailDerivedData(ctx: Pick<ModuleContext, "suggestions" | "itemState">, messageIds?: readonly string[]): void {
  if (messageIds && !messageIds.length) return;
  const suggestions = ctx.suggestions.forgetSource("gmail", messageIds);
  ctx.itemState.forget({
    ids: [...suggestions.map((id) => `ai:${id}`), ...(messageIds ?? []).map((id) => `gmail:${id}`)],
    ...(messageIds ? {} : { prefix: "gmail:" }),
  }, FORGOTTEN_MAIL_TITLE);
}
