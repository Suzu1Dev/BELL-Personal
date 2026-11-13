import test from "node:test";
import assert from "node:assert/strict";
import { addDays, dayBounds, dayKey, daysBetween, isDayKey, isValidTimeZone, localTime, timeZoneOffsetMinutes, todayKey, weekdayOf, zonedTimeToUtc } from "./time.js";

const TPE = "Asia/Taipei";

test("today is computed in Asia/Taipei even though the host clock is UTC", () => {
  // 15:59:59Z is 23:59:59 in Taipei; one second later it is already tomorrow there.
  assert.equal(todayKey(TPE, new Date("2026-10-12T15:59:59.999Z")), "2026-10-12");
  assert.equal(todayKey(TPE, new Date("2026-10-12T16:00:00.000Z")), "2026-10-13");
  // The UTC calendar disagrees for the second instant; the helper must not use it.
  assert.equal(new Date("2026-10-12T16:00:00.000Z").toISOString().slice(0, 10), "2026-10-12");
  assert.equal(dayKey(TPE, "2026-12-31T16:30:00Z"), "2027-01-01");
  assert.equal(dayKey("UTC", "2026-12-31T16:30:00Z"), "2026-12-31");
});

test("day bounds are local midnight to local midnight as UTC instants", () => {
  assert.deepEqual(dayBounds(TPE, "2026-10-13"), { start: "2026-10-12T16:00:00.000Z", end: "2026-10-13T16:00:00.000Z" });
  // Month and year rollover.
  assert.deepEqual(dayBounds(TPE, "2026-12-31"), { start: "2026-12-30T16:00:00.000Z", end: "2026-12-31T16:00:00.000Z" });
  assert.equal(timeZoneOffsetMinutes(TPE, "2026-10-12T00:00:00Z"), 480);
  assert.equal(zonedTimeToUtc(TPE, "2026-10-13", 6, 30).toISOString(), "2026-10-12T22:30:00.000Z");
  assert.equal(localTime(TPE, "2026-10-12T22:30:00Z"), "06:30");
});

test("zones with daylight saving time get 23- and 25-hour days", () => {
  const spring = dayBounds("America/New_York", "2026-03-08");
  assert.equal((Date.parse(spring.end) - Date.parse(spring.start)) / 3_600_000, 23);
  const autumn = dayBounds("America/New_York", "2026-11-01");
  assert.equal((Date.parse(autumn.end) - Date.parse(autumn.start)) / 3_600_000, 25);
  assert.equal(spring.start, "2026-03-08T05:00:00.000Z");
});

test("calendar helpers validate and step days", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(daysBetween("2026-10-12", "2026-10-15"), 3);
  assert.equal(weekdayOf("2026-10-12"), 1); // Monday
  assert.equal(isDayKey("2026-02-30"), false);
  assert.equal(isDayKey("2026-2-3"), false);
  assert.equal(isDayKey("2026-10-12"), true);
  assert.equal(isValidTimeZone(TPE), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.throws(() => addDays("nope", 1), RangeError);
});
