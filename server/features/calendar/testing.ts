import type { calendar_v3 } from "@googleapis/calendar";
import type { CoreServices } from "../../services.js";
import type { FetchLike } from "../../sync.js";

/**
 * Test doubles for the calendar-events team (imported by *.test.ts only):
 * a fake of the Google Calendar v3 API and token endpoint behind ctx.fetch,
 * a fake for any other HTTPS URL (feeds, CTFtime), and a stored Google grant.
 * No test reaches the network.
 */

export interface RecordedRequest {
  method: string;
  url: URL;
  body: string;
  headers: Record<string, string>;
}

export interface FakeGoogleState {
  calendars: calendar_v3.Schema$CalendarListEntry[];
  events: Record<string, calendar_v3.Schema$Event[]>;
  /** Bodies of events.insert, in order. */
  inserted: calendar_v3.Schema$Event[];
  /** Event ids passed to events.delete. */
  deleted: string[];
  /** Answer every Calendar API call with this HTTP status instead. */
  failWith?: number;
  /** Answer events.list of these calendars with an error (status and Google `reason`). */
  failCalendar?: Record<string, { status: number; reason?: string }>;
  /** Events on the primary calendar by id (inserted ones land here; events.get and update read them). */
  byId: Record<string, calendar_v3.Schema$Event>;
  /** Event ids passed to events.update. */
  updated: string[];
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeNetwork(options: { google?: Partial<FakeGoogleState>; other?: (request: RecordedRequest) => Response | Promise<Response> | undefined } = {}) {
  const google: FakeGoogleState = { calendars: [], events: {}, inserted: [], deleted: [], byId: {}, updated: [], ...options.google };
  const requests: RecordedRequest[] = [];
  let nextId = 1;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => { headers[key] = value; });
    const request = { method, url, body, headers };
    requests.push(request);
    if (url.host === "oauth2.googleapis.com") return json({ access_token: "ya29.fresh", expires_in: 3600 });
    if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3/")) {
      if (google.failWith) return json({ error: { code: google.failWith, message: "fail" } }, google.failWith);
      const path = url.pathname.slice("/calendar/v3".length);
      if (path === "/users/me/calendarList") return json({ items: google.calendars });
      const list = /^\/calendars\/([^/]+)\/events$/.exec(path);
      if (list && method === "GET") {
        const failure = google.failCalendar?.[decodeURIComponent(list[1])];
        if (failure) return json({ error: { code: failure.status, message: "fail", errors: failure.reason ? [{ reason: failure.reason, domain: "usageLimits" }] : [] } }, failure.status);
        return json({ items: google.events[decodeURIComponent(list[1])] ?? [] });
      }
      if (list && method === "POST") {
        const event = JSON.parse(body) as calendar_v3.Schema$Event;
        google.inserted.push(event);
        const id = event.id ?? `gevent${nextId++}`;
        if (google.byId[id]) return json({ error: { code: 409, message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } }, 409);
        google.byId[id] = { ...event, id, status: "confirmed" };
        return json({ ...event, id, htmlLink: "https://calendar.google.com/event?eid=x" });
      }
      const one = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path);
      if (one) {
        const calId = decodeURIComponent(one[1]);
        const id = decodeURIComponent(one[2]);
        const fromList = (google.events[calId] ?? []).find((entry) => entry.id === id);
        if (method === "DELETE") {
          google.deleted.push(id);
          const existing = google.byId[id] ?? fromList;
          if (existing) google.byId[id] = { ...existing, id, status: "cancelled" };
          if (google.events[calId]) google.events[calId] = google.events[calId].filter((entry) => entry.id !== id);
          return new Response(null, { status: 204 });
        }
        if (method === "GET") {
          const event = google.byId[id] ?? fromList;
          return event ? json(event) : json({ error: { code: 404 } }, 404);
        }
        if (method === "PUT") {
          google.updated.push(id);
          google.byId[id] = { ...(JSON.parse(body) as calendar_v3.Schema$Event), id };
          return json(google.byId[id]);
        }
        if (method === "PATCH") {
          const existing = google.byId[id] ?? fromList;
          if (!existing) return json({ error: { code: 404 } }, 404);
          google.updated.push(id);
          const patch = JSON.parse(body) as Record<string, unknown>;
          const merged: Record<string, unknown> = { ...existing, ...patch, id };
          for (const timeKey of ["start", "end"] as const) {
            if (patch[timeKey] && typeof patch[timeKey] === "object") {
              const cleaned: Record<string, unknown> = {};
              for (const [k, v] of Object.entries({ ...(existing[timeKey] ?? {}), ...(patch[timeKey] as Record<string, unknown>) })) {
                if (v !== null && v !== undefined) cleaned[k] = v;
              }
              merged[timeKey] = cleaned;
            }
          }
          const updated = merged as calendar_v3.Schema$Event;
          google.byId[id] = updated;
          if (google.events[calId]) {
            const idx = google.events[calId].findIndex((entry) => entry.id === id);
            if (idx >= 0) google.events[calId][idx] = updated;
            else if (updated.status !== "cancelled") google.events[calId].push(updated);
          }
          return json(updated);
        }
      }
      return json({ error: { code: 404 } }, 404);
    }
    const answer = await options.other?.(request);
    return answer ?? new Response("not found", { status: 404 });
  };
  return { fetch, google, requests };
}

const ALL_CALENDAR_SCOPES = [
  "email", "openid",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

/** Stores a Google client and a grant with a valid access token (no refresh needed). */
export async function connectGoogle(services: Pick<CoreServices, "vault">, scopes: string[] = ALL_CALENDAR_SCOPES): Promise<void> {
  const clientId = "123456789012-abcdef.apps.googleusercontent.com";
  await services.vault.set("google.client", { clientId, clientSecret: "GOCSPX-test-secret-value-1234", kind: "web", savedAt: "2026-10-01T00:00:00.000Z" });
  await services.vault.set("google.oauth", {
    refreshToken: "1//refresh", scopes, clientId, connectedAt: "2026-10-01T00:00:00.000Z",
    accessToken: "ya29.valid", expiryDate: Date.now() + 3_600_000,
  });
}

export const taipei = (local: string) => new Date(`${local}:00+08:00`).toISOString();
