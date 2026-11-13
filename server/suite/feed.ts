import { z } from "zod";
import {
  allowedSuiteRoute,
  SUITE_ITEM_STATES,
  SUITE_LIMITS,
  SUITE_OBJECT_ID,
  SUITE_UNSAFE_TEXT,
  validSuiteHref,
  type SuiteSiblingId,
  type SuiteTodayFeed,
} from "../../shared/suite.js";

/**
 * Strict validation of a sibling's `GET /api/suite/today` (suite-contract v1
 * §3), ported from bell-suite/contracts/v1/reference.mjs (validateFeed,
 * validateItem, allowedRoute). Unknown keys anywhere, one bad item, an href
 * that is not one of the sender's allowed routes (§5.1) or a feed from another
 * app reject the whole feed: nothing is partially adopted.
 */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OBJECT_TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const COUNT_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
/** The contract's relative-hash-route rule (item href; the handoff `back` uses the same rule). */
export const validHref = validSuiteHref;

/** Non-empty plain text: at most `max` code points, no control or bidi characters. */
const plain = (max: number) =>
  z.string().refine((value) => value.trim() !== "" && [...value].length <= max && !SUITE_UNSAFE_TEXT.test(value));
const isoUtc = z.string().refine((value) => ISO_UTC.test(value) && !Number.isNaN(Date.parse(value)));

function feedSchema(appId: SuiteSiblingId) {
  const item = z.strictObject({
    sourceApp: z.literal(appId),
    type: z.string().regex(OBJECT_TYPE),
    id: z.string().regex(SUITE_OBJECT_ID),
    title: plain(SUITE_LIMITS.title),
    href: z.string().refine((value) => allowedSuiteRoute(appId, value)),
    state: z.enum(SUITE_ITEM_STATES),
    updatedAt: isoUtc,
    dueAt: isoUtc.optional(),
    detail: plain(SUITE_LIMITS.detail).optional(),
  });
  return z.strictObject({
    schemaVersion: z.literal(1),
    appId: z.literal(appId),
    generatedAt: isoUtc,
    counts: z
      .record(z.string().regex(COUNT_KEY), z.number().int().min(0).max(SUITE_LIMITS.countMax))
      .refine((counts) => Object.keys(counts).length <= SUITE_LIMITS.counts),
    items: z.array(item).max(SUITE_LIMITS.items),
    truncated: z.boolean(),
  });
}

const schemas: Record<SuiteSiblingId, ReturnType<typeof feedSchema>> = {
  explain: feedSchema("explain"),
  pr: feedSchema("pr"),
  reader: feedSchema("reader"),
  campaign: feedSchema("campaign"),
};

export type FeedCheck = { ok: true; feed: SuiteTodayFeed } | { ok: false; reason: "invalid" | "version" };

/**
 * The feed `appId` must send, validated; the result is zod's fresh copy, so
 * nothing the schema does not name reaches the browser. A numeric
 * schemaVersion other than 1 is reported as "version" (unavailable, §4).
 */
export function parseTodayFeed(value: unknown, appId: SuiteSiblingId): FeedCheck {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const version = (value as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version !== 1) return { ok: false, reason: "version" };
  }
  const result = schemas[appId].safeParse(value);
  return result.success ? { ok: true, feed: result.data } : { ok: false, reason: "invalid" };
}
