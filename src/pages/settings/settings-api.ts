/**
 * The endpoints 連線與設定 calls (ARCHITECTURE §10.4–§10.6). Bodies and
 * answers are the shared/connect.ts types; the owning teams implement the
 * routes. Every write is JSON; DELETE sends `{}`.
 */
import type {
  CanvasConnectRequest, DisconnectResponse, FeedCreateRequest, FeedDeleteResponse, FeedListResponse, FeedSummary, GeocodeResponse,
  GmailPurgeResponse, GoogleClientRequest, GoogleConnectResponse, GoogleDisconnectResponse, GoogleStatus, LmsConnectResponse, MoodleConnectRequest,
} from "../../../shared/connect";
import type { ProviderSettings, ProviderSnapshot } from "../../../shared/models";
import type { AiConnection, AiConnectionsResponse, AiKeyProvider, AiLoginMethod } from "../../../shared/ai-connections";
import type { AppSettings } from "../../../shared/settings";
import type { SourceId } from "../../../shared/sources";
import type { SuitePrStatus } from "../../../shared/suite";
import { api, send } from "../../api";

/** A browser navigation (not fetch): the server redirects to Google and back to #/settings/sources (or #/setup). */
export const OAUTH_START = "/oauth/google/start";
export const OAUTH_START_SETUP = "/oauth/google/start?return=setup";
export const OAUTH_START_PASTE = "/oauth/google/start?mode=paste";

export const settingsApi = {
  app: (signal?: AbortSignal) => api<AppSettings>("/settings/app", { signal }),
  saveApp: (patch: Partial<AppSettings>) => api<AppSettings>("/settings/app", send("PUT", patch)),
  provider: (signal?: AbortSignal) => api<ProviderSnapshot>("/settings/provider", { signal }),
  saveProvider: (patch: Partial<ProviderSettings>) => api<ProviderSnapshot>("/settings/provider", send("PUT", patch)),
  google: (signal?: AbortSignal) => api<GoogleStatus>("/google", { signal }),
  saveGoogleClient: (body: GoogleClientRequest) => api<GoogleStatus>("/google/client", send("PUT", body)),
  clearGoogleClient: () => api<GoogleStatus>("/google/client", send("DELETE")),
  pasteGoogle: (url: string) => api<GoogleConnectResponse>("/google/paste", send("POST", { url })),
  disconnectGoogle: () => api<GoogleDisconnectResponse>("/google", send("DELETE")),
  connectMoodle: (body: MoodleConnectRequest) => api<LmsConnectResponse>("/lms/moodle/connect", send("POST", body)),
  disconnectMoodle: () => api<DisconnectResponse>("/lms/moodle", send("DELETE")),
  connectCanvas: (body: CanvasConnectRequest) => api<LmsConnectResponse>("/lms/canvas/connect", send("POST", body)),
  disconnectCanvas: () => api<DisconnectResponse>("/lms/canvas", send("DELETE")),
  feeds: (signal?: AbortSignal) => api<FeedListResponse>("/events/feeds", { signal }),
  addFeed: (body: FeedCreateRequest) => api<FeedSummary>("/events/feeds", send("POST", body)),
  removeFeed: (id: string) => api<FeedDeleteResponse>(`/events/feeds/${encodeURIComponent(id)}`, send("DELETE")),
  geocode: (query: string, signal?: AbortSignal) => api<GeocodeResponse>(`/weather/geocode?q=${encodeURIComponent(query)}`, { signal }),
  purgeMail: () => api<GmailPurgeResponse>("/gmail/purge", send("POST", {})),
  sync: (sources: SourceId[]) => api<{ started: SourceId[] }>("/sync", send("POST", { sources, force: true })),
  aiConnections: (signal?: AbortSignal) => api<AiConnectionsResponse>("/ai/connections", { signal }),
  startAiLogin: (method: AiLoginMethod) => api<AiConnection>(`/ai/connections/${method}/login`, send("POST", {})),
  cancelAiLogin: (method: AiLoginMethod) => api<void>(`/ai/connections/${method}/login`, send("DELETE")),
  submitClaudeCode: (code: string) => api<AiConnection>("/ai/connections/claude/login/code", send("POST", { code })),
  saveAiKey: (provider: AiKeyProvider, key: string) => api<AiConnection>(`/ai/connections/keys/${provider}`, send("PUT", { key })),
  deleteAiKey: (provider: AiKeyProvider) => api<void>(`/ai/connections/keys/${provider}`, send("DELETE")),
  suitePr: (signal?: AbortSignal) => api<SuitePrStatus>("/suite/pr", { signal }),
  pairSuitePr: (code: string) => api<SuitePrStatus>("/suite/pr/pair", send("POST", { code })),
  saveSuitePrToken: (token: string) => api<SuitePrStatus>("/suite/pr/token", send("PUT", { token })),
  disconnectSuitePr: () => api<SuitePrStatus>("/suite/pr", send("DELETE")),
};
