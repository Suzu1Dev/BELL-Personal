/**
 * A message's original layout (GET /api/gmail/messages/:id/body, SPEC-mail-html
 * §2): fetched when the reader shows the message in 原始版面, with
 * `images=1` once the owner asked for its images. Answers are kept for the
 * page session (the server holds the HTML for 5 minutes and never stores it),
 * so reopening a message or toggling the view does not refetch; asking for
 * images keeps the old document on screen until the new one arrives. An
 * answer with proxied images is kept only as long as the server keeps them
 * (MAIL_BODY_TTL_MS): its signed image URLs are answered only from what the
 * server fetched for that body, and a server restart changes the signing
 * key, so an older document is asked for again instead of showing broken
 * images. `attempt` asks again after a failure (顯示圖片 or I pressed again).
 */
import { useCallback, useEffect, useState } from "react";
import type { MailBodyResponse } from "../../../shared/mail";
import { ApiError, api } from "../../api";
import { ERRORS } from "../../copy/common";

const MAX_HELD = 30;
/** How long the server holds a body's proxied images (LiveMail's 5 minutes). */
export const MAIL_BODY_TTL_MS = 5 * 60_000;
const held = new Map<string, { body: MailBodyResponse; at: number }>();
/** Requests in flight, by key (the I key does not start a second one); the token is the request's own. */
const loading = new Map<string, object>();
const keyOf = (messageId: string, images: boolean) => `${messageId}|${images ? 1 : 0}`;

/** A held answer, unless its proxied images have expired on the server. */
function heldBody(key: string, now = Date.now()): MailBodyResponse | undefined {
  const entry = held.get(key);
  if (!entry) return undefined;
  const proxied = entry.body.images.shown && entry.body.images.remote > 0;
  if (proxied && now - entry.at >= MAIL_BODY_TTL_MS) {
    held.delete(key);
    return undefined;
  }
  return entry.body;
}

/** The answer already held for a message (the I key asks whether there are images to show). */
export function peekMailBody(messageId: string, images = false): MailBodyResponse | undefined {
  return heldBody(keyOf(messageId, images));
}

/** Whether that answer is being fetched right now. */
export function mailBodyLoading(messageId: string, images = false): boolean {
  return loading.has(keyOf(messageId, images));
}

/** Forget every held answer (a sender was trusted or untrusted: the server's answer changes). */
export function forgetMailBodies(): void {
  held.clear();
}

/** Tests: holds an answer as if it was fetched at `at`. */
export function holdMailBody(body: MailBodyResponse, images: boolean, at = Date.now()): void {
  remember(keyOf(body.messageId, images), body, at);
}

function remember(key: string, body: MailBodyResponse, at = Date.now()): void {
  held.delete(key);
  held.set(key, { body, at });
  while (held.size > MAX_HELD) held.delete(held.keys().next().value!);
}

export interface MailBodyState {
  state: "idle" | "loading" | "ready" | "error";
  data?: MailBodyResponse;
  error?: string;
  retry(): void;
}

export function useMailBody(messageId: string | undefined, images: boolean, enabled: boolean, attempt = 0): MailBodyState {
  const key = messageId ? keyOf(messageId, images) : "";
  const [result, setResult] = useState<{ key: string; state: MailBodyState["state"]; data?: MailBodyResponse; error?: string }>(() => {
    const cached = key ? heldBody(key) : undefined;
    return cached ? { key, state: "ready", data: cached } : { key: "", state: "idle" };
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!messageId || !enabled) return;
    const cached = heldBody(key);
    if (cached) {
      setResult({ key, state: "ready", data: cached });
      return;
    }
    const controller = new AbortController();
    // The previous document (the same message without images) stays until this one arrives.
    setResult((previous) => ({ key, state: "loading", ...(previous.data?.messageId === messageId ? { data: previous.data } : {}) }));
    const token = {};
    loading.set(key, token);
    const done = () => { if (loading.get(key) === token) loading.delete(key); };
    api<MailBodyResponse>(`/gmail/messages/${encodeURIComponent(messageId)}/body${images ? "?images=1" : ""}`, { signal: controller.signal })
      .then((body) => {
        remember(key, body);
        setResult({ key, state: "ready", data: body });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof ApiError || cause instanceof Error ? cause.message : ERRORS.offline;
        setResult((previous) => ({ key, state: "error", error: message, ...(previous.data?.messageId === messageId ? { data: previous.data } : {}) }));
      })
      .finally(done);
    return () => {
      controller.abort();
      done();
    };
  }, [key, messageId, images, enabled, tick, attempt]);

  const retry = useCallback(() => {
    if (key) held.delete(key);
    setTick((value) => value + 1);
  }, [key]);
  if (!messageId || !enabled) return { state: "idle", retry };
  const current = result.key === key || result.data?.messageId === messageId ? result : { state: "loading" as const };
  return { ...current, retry };
}
