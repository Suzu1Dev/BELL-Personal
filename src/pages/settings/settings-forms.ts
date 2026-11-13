/**
 * Validation for the 連線與設定 forms, run before anything is sent (the
 * server validates again). Each returns the request body or localized field
 * errors that say what is wrong and how to fix it.
 */
import { APP_SETTING_LIMITS } from "../../../shared/settings";
import { CONNECT_LIMITS, type CanvasConnectRequest, type FeedCreateRequest, type GoogleClientRequest, type MoodleConnectRequest } from "../../../shared/connect";
import { MAIL_BODY_LIMITS } from "../../../shared/mail";
import { MAIL_DISPLAY_SETTINGS, SOURCES, VALIDATION, settingsCopy } from "../../copy/settings";

export type FieldErrors<K extends string> = Partial<Record<K, string>>;
export type Checked<T, K extends string> = { ok: true; value: T } | { ok: false; errors: FieldErrors<K> };

/** The Moodle default (decisions.md item 2). */
export const DEFAULT_MOODLE_URL = "https://e3p.nycu.edu.tw";

function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function result<T, K extends string>(errors: FieldErrors<K>, value: () => T): Checked<T, K> {
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: value() };
}

export function checkMoodle(input: { baseUrl: string; username: string; password: string }): Checked<MoodleConnectRequest, "baseUrl" | "username" | "password"> {
  const errors: FieldErrors<"baseUrl" | "username" | "password"> = {};
  const baseUrl = httpsUrl(input.baseUrl);
  if (!input.baseUrl.trim()) errors.baseUrl = VALIDATION.required(SOURCES.moodle.baseUrl);
  else if (!baseUrl || input.baseUrl.length > CONNECT_LIMITS.url) errors.baseUrl = VALIDATION.https;
  if (!input.username.trim()) errors.username = VALIDATION.required(SOURCES.moodle.username);
  else if (input.username.length > CONNECT_LIMITS.username) errors.username = VALIDATION.tooLong(SOURCES.moodle.username, CONNECT_LIMITS.username);
  if (!input.password) errors.password = VALIDATION.required(SOURCES.moodle.password);
  else if (input.password.length > CONNECT_LIMITS.password) errors.password = VALIDATION.tooLong(SOURCES.moodle.password, CONNECT_LIMITS.password);
  return result(errors, () => ({ baseUrl: baseUrl!, username: input.username.trim(), password: input.password }));
}

export function checkCanvas(input: { baseUrl: string; token: string }): Checked<CanvasConnectRequest, "baseUrl" | "token"> {
  const errors: FieldErrors<"baseUrl" | "token"> = {};
  const baseUrl = httpsUrl(input.baseUrl);
  if (!input.baseUrl.trim()) errors.baseUrl = VALIDATION.required(SOURCES.canvas.baseUrl);
  else if (!baseUrl || input.baseUrl.length > CONNECT_LIMITS.url) errors.baseUrl = VALIDATION.https;
  const token = input.token.trim();
  if (!token) errors.token = VALIDATION.required(SOURCES.canvas.token);
  else if (token.length > CONNECT_LIMITS.token) errors.token = VALIDATION.tooLong(SOURCES.canvas.token, CONNECT_LIMITS.token);
  return result(errors, () => ({ baseUrl: baseUrl!, token }));
}

/**
 * Feeds are fetched over HTTPS only (the server refuses anything else), so
 * an http:// address is pointed out here, next to the field; webcal://
 * (iCal) becomes https://.
 */
export function checkFeed(input: { url: string; label: string }): Checked<FeedCreateRequest, "url" | "label"> {
  const errors: FieldErrors<"url" | "label"> = {};
  let url: string | undefined;
  const raw = input.url.trim().replace(/^webcal:\/\//i, "https://");
  let protocol: string | undefined;
  try {
    const parsed = new URL(raw);
    protocol = parsed.protocol;
    if (parsed.protocol === "https:" && parsed.hostname && !parsed.username && !parsed.password) url = parsed.toString();
  } catch {
    url = undefined;
  }
  if (!input.url.trim()) errors.url = VALIDATION.required(SOURCES.feeds.url);
  else if (protocol === "http:") errors.url = VALIDATION.https;
  else if (!url || raw.length > CONNECT_LIMITS.url) errors.url = VALIDATION.url;
  const label = input.label.trim();
  if (!label) errors.label = VALIDATION.required(SOURCES.feeds.label);
  else if (label.length > CONNECT_LIMITS.feedLabel) errors.label = VALIDATION.tooLong(SOURCES.feeds.label, CONNECT_LIMITS.feedLabel);
  return result(errors, () => ({ url: url!, label }));
}

const CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/;

export function checkGoogleClient(input: { clientId: string; clientSecret: string }, kind: "web" | "desktop" = "web"): Checked<GoogleClientRequest, "clientId" | "clientSecret"> {
  const { GOOGLE_GUIDE } = settingsCopy();
  const errors: FieldErrors<"clientId" | "clientSecret"> = {};
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId) errors.clientId = GOOGLE_GUIDE.validation.clientId.required;
  else if (!CLIENT_ID.test(clientId) || clientId.length > 200) errors.clientId = GOOGLE_GUIDE.validation.clientId.invalid;
  if (!clientSecret) errors.clientSecret = GOOGLE_GUIDE.validation.clientSecret.required;
  else if (clientSecret.length < 8 || clientSecret.length > 200 || /\s/.test(clientSecret)) errors.clientSecret = GOOGLE_GUIDE.validation.clientSecret.invalid;
  return result(errors, () => ({ clientId, clientSecret, kind }));
}

/** The desktop-client paste flow needs the whole address-bar URL with its code. */
export function checkPasteUrl(value: string): Checked<{ url: string }, "url"> {
  const url = value.trim();
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("code") || parsed.searchParams.get("error")) return { ok: true, value: { url } };
  } catch {
    // fall through
  }
  return { ok: false, errors: { url: settingsCopy().GOOGLE_GUIDE.validation.pasteUrl.invalid } };
}

export function checkRetention(value: string): Checked<number, "days"> {
  const { min, max } = APP_SETTING_LIMITS.retentionDays;
  const days = Number(value);
  if (!/^\d+$/.test(value.trim()) || days < min || days > max) return { ok: false, errors: { days: VALIDATION.retention(min, max) } };
  return { ok: true, value: days };
}

export function checkWeight(value: string): Checked<number, "weight"> {
  const { min, max } = APP_SETTING_LIMITS.ctftimeWeight;
  const weight = Number(value);
  if (!/^\d+$/.test(value.trim()) || weight < min || weight > max) return { ok: false, errors: { weight: VALIDATION.weight(min, max) } };
  return { ok: true, value: weight };
}

export function checkTime(value: string): Checked<string, "time"> {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { ok: false, errors: { time: VALIDATION.time } };
  return { ok: true, value: `${match[1].padStart(2, "0")}:${match[2]}` };
}

/** `missing=gmail.modify,calendar.events` → 「Gmail、新增行程」. */
export function missingScopeNames(missing: string | null, labels: Record<string, string>, listSep = "、"): string | undefined {
  if (!missing) return undefined;
  const names = missing.split(",").map((scope) => labels[scope.trim()] ?? scope.trim()).filter(Boolean);
  return names.length ? names.join(listSep) : undefined;
}

const TRUSTED_DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TRUSTED_ADDRESS = /^(?=.{3,254}$)[^\s@<>"'(),;:\\]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * An entry for 信任的寄件者 (SPEC-mail-html §6): an address or a domain,
 * lower-cased; a leading 「@」 or 「*.」 is dropped (「@example.com」 means the domain).
 */
export function checkTrustedSender(input: string, existing: readonly string[]): Checked<string, "entry"> {
  const value = input.trim().toLowerCase().replace(/^(\*\.|@)/, "");
  if (!value) return { ok: false, errors: { entry: VALIDATION.required(MAIL_DISPLAY_SETTINGS.address) } };
  if (!TRUSTED_ADDRESS.test(value) && !TRUSTED_DOMAIN.test(value)) return { ok: false, errors: { entry: MAIL_DISPLAY_SETTINGS.invalid } };
  if (existing.includes(value)) return { ok: false, errors: { entry: MAIL_DISPLAY_SETTINGS.duplicate } };
  if (existing.length >= MAIL_BODY_LIMITS.trustedSenders) return { ok: false, errors: { entry: MAIL_DISPLAY_SETTINGS.full(MAIL_BODY_LIMITS.trustedSenders) } };
  return { ok: true, value };
}
