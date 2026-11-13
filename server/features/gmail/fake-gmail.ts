/**
 * Test support only (imported by *.test.ts): an in-memory Gmail behind a fake
 * fetch, answering the REST calls GmailApi makes (profile, messages.list with
 * a subset of the search syntax, messages.get, threads.get, history.list,
 * threads.modify, threads.trash, threads.untrash, messages.untrash,
 * messages.batchModify). It
 * keeps a history log like Gmail does, so incremental syncs see the same
 * changes a real mailbox would produce. Never used by the server at runtime.
 *
 * Like Gmail's format=full, image and attachment parts carry an
 * `attachmentId` instead of their bytes, served by messages.attachments.get;
 * `rotateAttachmentIds` makes the ids change on every read of the message
 * (Gmail does) so a stale id answers 400.
 *
 * messages.list understands what BELL sends (SPEC-mail-assignments §3.6):
 * `in:<inbox|sent|drafts|spam|trash|snoozed|anywhere>` with or without a
 * leading `-`, `newer_than:Nd`, `from:`, `subject:`, and plain words matched
 * against the subject, sender, snippet and body (case-insensitive, AND).
 * Like Gmail, spam and trash are left out unless the query names them or
 * includeSpamTrash is set. Snoozed mail carries the label SNOOZED here (Gmail
 * keeps it internal). A page token is an offset; anything else answers 400.
 */
import { GOOGLE_SCOPES } from "../../../shared/connect.js";
import type { CoreServices } from "../../services.js";
import type { FetchLike } from "../../sync.js";
import { GOOGLE_VAULT_CLIENT, GOOGLE_VAULT_OAUTH } from "../../google/auth.js";
import type { GmailHistoryRecord } from "./api.js";
import type { GmailMessageResource, GmailPart } from "./parse.js";

export interface FakeMessageInput {
  id: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  labels?: string[];
  /** ISO receive time. */
  at: string;
  /** A ready-made MIME tree; default: a text/plain part with `text`. */
  payload?: GmailPart;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

interface Stored { resource: GmailMessageResource }

export interface RecordedRequest { method: string; path: string; body?: unknown }

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

export class FakeGmail {
  readonly messages = new Map<string, Stored>();
  readonly requests: RecordedRequest[] = [];
  private records: GmailHistoryRecord[] = [];
  private historyId = 5000;
  /** Answer history.list with 404 (expired historyId). */
  historyExpired = false;
  /** Leave labelIds off history messages, as the history.list reference allows (id and threadId only). */
  historyWithoutLabels = false;
  /** Answer every Gmail call with this status (401, 500…). */
  failWith: number | undefined;
  /** Answer only modify, trash and untrash calls with this status. */
  failModify: number | undefined;
  /** Answer only messages.list with this status (429 rate limit, 500…). */
  failList: number | undefined;
  /** Answer GET message and thread reads with this status. */
  failGet: number | undefined;
  /** Answer 401 to requests carrying this (stale) access token. */
  rejectToken: string | undefined;
  /** Token endpoint calls (refreshes). */
  refreshes = 0;
  /** Attachment bytes by `${messageId}/${partId}` (format=full answers an attachmentId instead). */
  readonly attachments = new Map<string, Buffer>();
  /** New attachment ids on every read of a message (Gmail's behaviour); an older id answers 400. */
  rotateAttachmentIds = false;
  private reads = 0;

  constructor(private readonly now: () => Date, readonly email = "suzu1dev@gmail.com") {}

  /** Adds a message; `record` logs it in history (as an incremental sync would see it). */
  add(input: FakeMessageInput, record = true): GmailMessageResource {
    const headers = [
      { name: "From", value: input.from ?? "Someone <someone@example.com>" },
      { name: "Subject", value: input.subject ?? "Hello" },
      ...Object.entries(input.headers ?? {}).map(([name, value]) => ({ name, value })),
    ];
    const payload: GmailPart = input.payload
      ? { ...structuredClone(input.payload), headers: [...headers, ...(input.payload.headers ?? [])] }
      : input.html !== undefined
        ? { mimeType: "multipart/alternative", headers, parts: [{ partId: "0", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { size: input.html.length, data: b64(input.html) } }] }
        : { mimeType: "text/plain", headers: [...headers, { name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: (input.text ?? "").length, data: b64(input.text ?? input.snippet ?? "") } };
    const resource: GmailMessageResource = {
      id: input.id,
      threadId: input.threadId ?? input.id,
      labelIds: input.labels ?? ["INBOX", "UNREAD"],
      snippet: input.snippet ?? (input.text ?? "").slice(0, 100),
      internalDate: String(Date.parse(input.at)),
      historyId: String(++this.historyId),
      payload,
    };
    this.moveAttachments(resource.id, resource.payload, "");
    this.messages.set(resource.id, { resource });
    if (record) this.records.push({ id: String(this.historyId), messagesAdded: [{ message: { id: resource.id, threadId: resource.threadId, labelIds: [...resource.labelIds!] } }] });
    return resource;
  }

  /** Image and attachment parts keep their bytes here and an attachmentId in the payload, as Gmail's format=full answers. */
  private moveAttachments(messageId: string, part: GmailPart | undefined, path: string): void {
    if (!part) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    const partId = part.partId ?? path;
    part.partId = partId;
    if (part.body?.data && (mime.startsWith("image/") || !!part.filename || mime === "application/pdf")) {
      const bytes = Buffer.from(part.body.data, "base64url");
      this.attachments.set(`${messageId}/${partId}`, bytes);
      part.body = { size: bytes.length, attachmentId: `att:${partId}` };
    }
    (part.parts ?? []).forEach((child, index) => this.moveAttachments(messageId, child, path ? `${path}.${index}` : String(index)));
  }

  /** The attachment ids of one read: `att:<partId>`, or with rotation `att:<read>:<partId>`. */
  private withAttachmentIds(part: GmailPart | undefined, read: number): GmailPart | undefined {
    if (!part) return part;
    const copy: GmailPart = { ...part, ...(part.parts ? { parts: part.parts.map((child) => this.withAttachmentIds(child, read)!) } : {}) };
    if (part.body?.attachmentId && this.rotateAttachmentIds) copy.body = { ...part.body, attachmentId: `att:${read}:${part.partId}` };
    return copy;
  }

  /** Changes labels the way the Gmail UI would, with history records. */
  relabel(id: string, change: { add?: string[]; remove?: string[] }): void {
    const stored = this.messages.get(id);
    if (!stored) return;
    const labels = (stored.resource.labelIds ?? []).filter((label) => !(change.remove ?? []).includes(label));
    for (const label of change.add ?? []) if (!labels.includes(label)) labels.push(label);
    stored.resource.labelIds = labels;
    const message = { id, threadId: stored.resource.threadId, labelIds: [...labels] };
    this.historyId++;
    if (change.add?.length) this.records.push({ id: String(this.historyId), labelsAdded: [{ message, labelIds: change.add }] });
    if (change.remove?.length) this.records.push({ id: String(this.historyId), labelsRemoved: [{ message, labelIds: change.remove }] });
  }

  remove(id: string): void {
    const stored = this.messages.get(id);
    if (!stored) return;
    this.messages.delete(id);
    this.records.push({ id: String(++this.historyId), messagesDeleted: [{ message: { id, threadId: stored.resource.threadId } }] });
  }

  labels(id: string): string[] {
    return [...(this.messages.get(id)?.resource.labelIds ?? [])];
  }

  /** Requests whose path matches (method + path prefix). */
  calls(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && (typeof path === "string" ? request.path.startsWith(path) : path.test(request.path)));
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
    if (url.host === "oauth2.googleapis.com") {
      this.refreshes++;
      return json({ access_token: "ya29.refreshed-access-token-0123456789", expires_in: 3600, scope: GOOGLE_SCOPES.join(" ") });
    }
    if (url.host !== "gmail.googleapis.com") return new Response("not found", { status: 404 });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    this.requests.push({ method, path: `${path}${url.search}`, ...(body ? { body } : {}) });
    if (this.failWith) return json({ error: { code: this.failWith } }, this.failWith);
    const authorization = new Headers(init?.headers).get("authorization");
    if (this.rejectToken && authorization === `Bearer ${this.rejectToken}`) return json({ error: { code: 401 } }, 401);
    if (path === "/profile") return json({ emailAddress: this.email, historyId: String(this.historyId) });
    if (this.failList && path === "/messages" && method === "GET") return json({ error: { code: this.failList } }, this.failList);
    if (this.failGet && method === "GET" && /^\/(messages|threads)\/[^/]+$/.test(path)) return json({ error: { code: this.failGet } }, this.failGet);
    if (path === "/messages" && method === "GET") return this.list(url);
    if (path === "/history") return this.history(url);
    if (path === "/messages/batchModify" && method === "POST") {
      if (this.failModify) return json({ error: { code: this.failModify } }, this.failModify);
      for (const id of body.ids as string[]) this.relabel(id, { add: body.addLabelIds, remove: body.removeLabelIds });
      return new Response(null, { status: 204 });
    }
    const thread = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (thread && method === "POST") {
      if (this.failModify) return json({ error: { code: this.failModify } }, this.failModify);
      const ids = [...this.messages.values()].filter((item) => item.resource.threadId === decodeURIComponent(thread[1])).map((item) => item.resource.id);
      if (!ids.length) return json({ error: { code: 404 } }, 404);
      for (const id of ids) this.relabel(id, { add: body.addLabelIds, remove: body.removeLabelIds });
      return json({ id: thread[1] });
    }
    const trash = /^\/threads\/([^/]+)\/(trash|untrash)$/.exec(path);
    if (trash && method === "POST") {
      if (this.failModify) return json({ error: { code: this.failModify } }, this.failModify);
      const ids = this.threadIds(decodeURIComponent(trash[1]));
      if (!ids.length) return json({ error: { code: 404 } }, 404);
      // Moving to the trash takes INBOX away; untrash only takes TRASH away (Gmail's reference is silent on INBOX).
      for (const id of ids) this.relabel(id, trash[2] === "trash" ? { add: ["TRASH"], remove: ["INBOX"] } : { remove: ["TRASH"] });
      return json({ id: trash[1] });
    }
    const untrash = /^\/messages\/([^/]+)\/untrash$/.exec(path);
    if (untrash && method === "POST") {
      if (this.failModify) return json({ error: { code: this.failModify } }, this.failModify);
      const id = decodeURIComponent(untrash[1]);
      if (!this.messages.has(id)) return json({ error: { code: 404 } }, 404);
      this.relabel(id, { remove: ["TRASH"] });
      return json(this.view(this.messages.get(id)!.resource, "minimal"));
    }
    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attachment && method === "GET") {
      const id = decodeURIComponent(attachment[1]);
      const token = decodeURIComponent(attachment[2]);
      const parsed = /^att:(?:(\d+):)?([0-9.]+)$/.exec(token);
      if (!this.messages.has(id) || !parsed) return json({ error: { code: 400, message: "Invalid attachment token" } }, 400);
      if (this.rotateAttachmentIds && Number(parsed[1]) !== this.reads) return json({ error: { code: 400, message: "Invalid attachment token" } }, 400);
      const bytes = this.attachments.get(`${id}/${parsed[2]}`);
      if (!bytes) return json({ error: { code: 404 } }, 404);
      return json({ size: bytes.length, data: bytes.toString("base64url") });
    }
    const threadGet = /^\/threads\/([^/]+)$/.exec(path);
    if (threadGet && method === "GET") {
      const ids = this.threadIds(decodeURIComponent(threadGet[1]));
      if (!ids.length) return json({ error: { code: 404 } }, 404);
      const format = url.searchParams.get("format");
      return json({ id: threadGet[1], historyId: String(this.historyId), messages: ids.map((id) => this.view(this.messages.get(id)!.resource, format)) });
    }
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message && method === "GET") {
      const stored = this.messages.get(decodeURIComponent(message[1]));
      if (!stored) return json({ error: { code: 404 } }, 404);
      return json(this.view(stored.resource, url.searchParams.get("format")));
    }
    return json({ error: { code: 404 } }, 404);
  };

  /** A message resource as messages.get and threads.get return it for a format. */
  private view(resource: GmailMessageResource, format: string | null): GmailMessageResource {
    const { payload, ...rest } = resource;
    if (format === "metadata") return { ...rest, payload: { mimeType: payload?.mimeType, headers: payload?.headers ?? [] } };
    if (format === "minimal") return rest;
    return { ...rest, payload: this.withAttachmentIds(payload, ++this.reads) };
  }

  /** A conversation's message ids, oldest first. */
  private threadIds(threadId: string): string[] {
    return [...this.messages.values()].filter((item) => item.resource.threadId === threadId)
      .sort((a, b) => Number(a.resource.internalDate) - Number(b.resource.internalDate)).map((item) => item.resource.id);
  }

  private list(url: URL): Response {
    const q = url.searchParams.get("q") ?? "";
    const max = Number(url.searchParams.get("maxResults") ?? 100);
    const token = url.searchParams.get("pageToken");
    if (token !== null && !/^\d+$/.test(token)) return json({ error: { code: 400, message: "Invalid pageToken" } }, 400);
    const offset = Number(token ?? 0);
    const matches = fakeQuery(q, this.now(), url.searchParams.get("includeSpamTrash") === "true");
    const all = [...this.messages.values()].map((item) => item.resource)
      .filter(matches)
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    const page = all.slice(offset, offset + max);
    return json({
      ...(page.length ? { messages: page.map((resource) => ({ id: resource.id, threadId: resource.threadId })) } : {}),
      ...(offset + max < all.length ? { nextPageToken: String(offset + max) } : {}),
      resultSizeEstimate: all.length,
    });
  }

  private history(url: URL): Response {
    if (this.historyExpired) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    const start = Number(url.searchParams.get("startHistoryId"));
    let records = this.records.filter((record) => Number(record.id) > start);
    if (this.historyWithoutLabels) records = JSON.parse(JSON.stringify(records, (key, value) => (key === "message" ? { id: value.id, threadId: value.threadId } : value)));
    return json({ ...(records.length ? { history: records } : {}), historyId: String(this.historyId) });
  }
}

const FAKE_LABELS: Record<string, string> = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", spam: "SPAM", trash: "TRASH", snoozed: "SNOOZED" };

/** The subset of Gmail's search syntax the fake understands (see the header comment). */
export function fakeQuery(q: string, now: Date, includeSpamTrash = false): (resource: GmailMessageResource) => boolean {
  const tokens = q.match(/-?\w+:"[^"]*"|-?\w+:\S+|"[^"]*"|\S+/g) ?? [];
  const checks: Array<(resource: GmailMessageResource) => boolean> = [];
  let anywhere = includeSpamTrash;
  const named = new Set<string>();
  for (const raw of tokens) {
    if (raw === "OR" || raw === "AND") continue;
    const negate = raw.startsWith("-");
    const token = negate ? raw.slice(1) : raw;
    const operator = /^(\w+):(.*)$/.exec(token);
    const key = operator?.[1];
    const value = (operator ? operator[2] : token).replace(/^"|"$/g, "").toLowerCase();
    let check: (resource: GmailMessageResource) => boolean;
    if (key === "in" && value === "anywhere") { anywhere = true; continue; }
    if (key === "in" && FAKE_LABELS[value]) {
      if (!negate) named.add(FAKE_LABELS[value]);
      check = (resource) => (resource.labelIds ?? []).includes(FAKE_LABELS[value]);
    } else if (key === "newer_than") {
      const since = now.getTime() - Number(/^(\d+)d$/.exec(value)?.[1] ?? 3650) * 86_400_000;
      check = (resource) => Number(resource.internalDate) >= since;
    } else if (key === "from") check = (resource) => fakeHeader(resource, "from").includes(value);
    else if (key === "subject") check = (resource) => fakeHeader(resource, "subject").includes(value);
    else check = (resource) => [fakeHeader(resource, "from"), fakeHeader(resource, "subject"), (resource.snippet ?? "").toLowerCase(), fakeBody(resource)].some((text) => text.includes(value));
    checks.push(negate ? (resource) => !check(resource) : check);
  }
  return (resource) => {
    const labels = resource.labelIds ?? [];
    if (!anywhere && labels.some((label) => (label === "SPAM" || label === "TRASH") && !named.has(label))) return false;
    return checks.every((check) => check(resource));
  };
}

const fakeHeader = (resource: GmailMessageResource, name: string) =>
  (resource.payload?.headers?.find((item) => item.name.toLowerCase() === name)?.value ?? "").toLowerCase();

function fakeBody(resource: GmailMessageResource): string {
  const parts: GmailPart[] = [];
  const walk = (part: GmailPart | undefined) => { if (!part) return; parts.push(part); part.parts?.forEach(walk); };
  walk(resource.payload);
  return parts.map((part) => (part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "")).join("\n").toLowerCase();
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Stores a Google client and a token with gmail.modify (valid for an hour of real time) in the vault. */
export async function connectGoogle(services: Pick<CoreServices, "vault">, scopes: readonly string[] = GOOGLE_SCOPES, email?: string): Promise<void> {
  await services.vault.set(GOOGLE_VAULT_CLIENT, { clientId: "123456789012-test.apps.googleusercontent.com", clientSecret: "test-client-secret", kind: "web", savedAt: new Date().toISOString() });
  await services.vault.set(GOOGLE_VAULT_OAUTH, {
    refreshToken: "1//test-refresh", scopes: [...scopes], clientId: "123456789012-test.apps.googleusercontent.com", ...(email ? { email } : {}),
    connectedAt: new Date().toISOString(), accessToken: "test-access-token", expiryDate: Date.now() + 3_600_000,
  });
}
