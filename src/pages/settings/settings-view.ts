/**
 * Pure rules for 連線與設定: one pill per card from the sources behind it,
 * the Google return parameters, and the time phrases on the cards.
 */
import { GOOGLE_ERROR_REASONS, type GoogleErrorReason } from "../../../shared/connect";
import type { SourceState, SourceStatus } from "../../../shared/sources";
import { DEFAULT_TIME_ZONE, dayKey, daysBetween, localTime } from "../../../shared/time";
import { monthDay } from "../../../shared/today-format";
import { format, onboardingCopy } from "../../copy/onboarding";

/** Worst first: a card shows the state that needs the user most. */
const SEVERITY: SourceState[] = ["needs_reconnect", "error", "syncing", "idle", "ok", "disabled", "not_configured"];

export interface CardState {
  state: SourceState;
  /** The failing source's last error (one zh sentence). */
  error?: string;
  lastSyncedAt?: string;
  configured: boolean;
}

/** The combined state of the sources behind one card (Google = gmail + google-calendar). */
export function cardState(statuses: SourceStatus[] | undefined, ids: readonly string[]): CardState {
  const list = (statuses ?? []).filter((status) => ids.includes(status.id));
  const active = list.filter((status) => status.state !== "not_configured" && status.state !== "disabled");
  const pool = active.length ? active : list;
  if (!pool.length) return { state: "not_configured", configured: false };
  const state = SEVERITY.find((candidate) => pool.some((status) => status.state === candidate)) ?? "not_configured";
  const failing = pool.find((status) => status.state === state && status.lastError);
  const lastSyncedAt = pool.map((status) => status.lastSyncedAt).filter((value): value is string => !!value).sort().at(-1);
  return {
    state,
    configured: active.length > 0,
    ...(failing?.lastError && (state === "error" || state === "needs_reconnect") ? { error: failing.lastError } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
  };
}

export type GoogleReturn = { kind: "connected"; missing?: string } | { kind: "error"; reason?: GoogleErrorReason };

/** `#/settings/sources?google=connected&missing=…` or `?google=error&reason=…` after the OAuth round trip (ARCHITECTURE §10.5). */
export function googleReturn(hash: string): GoogleReturn | undefined {
  const query = hash.replace(/^[^?]*\?/, "").replace(/#.*$/, "");
  if (query === hash || !query) return undefined;
  const params = new URLSearchParams(query);
  const google = params.get("google");
  if (google === "connected") {
    const missing = params.get("missing");
    return { kind: "connected", ...(missing ? { missing } : {}) };
  }
  if (google === "error") {
    const reason = params.get("reason");
    return { kind: "error", ...(reason && (GOOGLE_ERROR_REASONS as readonly string[]).includes(reason) ? { reason: reason as GoogleErrorReason } : {}) };
  }
  return undefined;
}

/** 「08:12」 today, 「昨天 22:10」, else 「10/9 22:10」 (the card's 上次同步). */
export function syncPhrase(iso: string, now: Date = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  const days = daysBetween(dayKey(timeZone, iso), dayKey(timeZone, now));
  const time = localTime(timeZone, iso);
  if (days <= 0) return time;
  if (days === 1) return format(onboardingCopy().googleGuide.yesterdayTime, { time });
  return `${monthDay(timeZone, iso)} ${time}`;
}
