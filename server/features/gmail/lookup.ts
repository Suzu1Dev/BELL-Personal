import type { MailMessage } from "../../../shared/mail.js";
import { AppError } from "../../errors.js";
import { googleAccountEmail, googleCapabilities, googleConnected } from "../../google/auth.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { ResponseTooLargeError } from "../../sync.js";
import { GmailApi, liveFailure } from "./api.js";
import { liveMail } from "./live.js";
import { normalizeOrHeaders } from "./parse.js";

/**
 * The one way another module reads a Gmail message by id (the lms module's
 * 轉成作業 and assignment rules, SPEC-mail-assignments §5.6). Mail team owns
 * it; other modules import it like `calendarService(ctx)`.
 *
 * Contract: the cached copy first; a message outside the cache (archived
 * long ago, a search hit) is read live from Gmail (`messages.get`
 * format=full through `normalizeMessage`: metadata and a plain-text excerpt,
 * never HTML), kept in server memory for at most 5 minutes and never written
 * to `source_items`. Undefined when Gmail does not have it (404) or is not
 * connected; throws an AppError (zh-TW) when Gmail fails.
 */
export async function findMailMessage(ctx: ModuleContext, messageId: string, signal?: AbortSignal): Promise<MailMessage | undefined> {
  const cached = ctx.sourceItems.get<MailMessage>("gmail", messageId)?.value;
  if (cached) return cached;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(messageId)) return undefined;
  const live = liveMail(ctx);
  if (!(await googleConnected(ctx)) || !(await googleCapabilities(ctx)).gmail) {
    live.clear();
    return undefined;
  }
  // A metadata copy from a list page has no excerpt: read the full message once for the text.
  const held = live.message(messageId);
  if (held?.excerpt) return held;
  try {
    const api = GmailApi.withSignal(ctx, signal ?? AbortSignal.timeout(20_000));
    // A message over the response cap is read as its headers alone, like the sync does (no excerpt then).
    const resource = await api.message(messageId, "full").catch((error: unknown) => {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      logEvent("gmail.message_too_large", {});
      return api.message(messageId, "metadata");
    });
    if (!resource) return undefined;
    const message = normalizeOrHeaders(resource, await googleAccountEmail(ctx));
    live.putMessage(message);
    return message;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new AppError(error instanceof AppError && error.status === 429 ? 429 : 502, liveFailure(error));
  }
}
