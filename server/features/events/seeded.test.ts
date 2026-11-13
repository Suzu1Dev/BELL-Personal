import test from "node:test";
import assert from "node:assert/strict";
import type { CalendarResponse } from "../../../shared/calendar.js";
import type { EventsResponse } from "../../../shared/events.js";
import type { TodayPayload } from "../../../shared/today.js";
import { seedDemo } from "../../../scripts/seed-demo.js";
import { openDatabases } from "../../db/database.js";
import { createServices } from "../../services.js";
import { startTestServer, tempDir, testConfig } from "../../test-helpers.js";
import { todayPayloadSchema } from "../../today/schema.js";
import { calendarModule } from "../calendar/index.js";
import { calendarService } from "../calendar/store.js";
import { eventsModule } from "./index.js";

const MOCKUP_NOW = new Date("2026-10-12T00:42:00.000Z"); // 08:42 in Asia/Taipei

/** `npm run seed:demo` + the calendar and events modules reproduce their parts of the SPEC §13 mockup. */
test("the demo seed drives the agenda, 明天與之後, the Balsn CTF row and #/calendar and #/events", async (t) => {
  const dir = tempDir(t);
  const config = testConfig(dir);
  const db = openDatabases(config.dataDir);
  seedDemo(db, { now: MOCKUP_NOW, timeZone: "Asia/Taipei" });
  db.close();
  const services = createServices(config, { now: () => MOCKUP_NOW, fetch: async () => { throw new Error("no network in tests"); } });
  t.after(() => services.close());
  const server = await startTestServer(t, services, { modules: [calendarModule, eventsModule] });
  t.after(() => calendarService(services).dropPending());

  const response = await server.call("GET", "/api/today");
  assert.equal(response.status, 200, response.text);
  assert.ok(todayPayloadSchema.safeParse(response.json).success);
  const today = response.json as TodayPayload;
  assert.deepEqual(today.agenda.items.map((item) => [item.title, item.meta, item.habitLink ?? ""]), [
    ["作業系統", "工程三館 EC115 · 林志明", ""],
    ["OS 讀書會 · Ch.5", "浩然圖書館 討論室 B", ""],
    ["健身", "光復校區 體育館", "運動"],
  ]);
  assert.deepEqual(today.nextUp, { start: "2026-10-12T02:10:00.000Z", title: "作業系統" });
  const balsn = today.queue[2].items.find((item) => item.id === "ctftime:2846")!;
  assert.deepEqual([balsn.title, balsn.meta, balsn.when?.label], ["Balsn CTF 2026，要參加嗎？", ["CTFtime", "10/17（六）08:00 起 48 小時", "線上", "權重 55"], "還有 5 天"]);
  assert.equal(today.queue[2].items.filter((item) => item.kind === "event.decide").length, 1, "TSG CTF is below the weight; g0v is 12 days away");
  assert.deepEqual(today.later.events.map((event) => [event.date, event.label, event.title, event.meta]), [
    ["10/13", "明天", "09:00 計算機網路", "工程三館 EC122 · Google 行事曆"],
    ["10/24", "週六", "g0v 零時政府第柒拾次大松", "中研院 · g0v 行事曆訂閱"],
  ]);
  assert.equal(today.counts.nav?.events, 1, "the SITCON suggestion");
  assert.deepEqual(today.sources.filter((source) => ["ctftime", "feeds"].includes(source.id)).map((source) => source.state), ["ok", "ok"]);

  const calendar = (await server.call("GET", "/api/calendar")).json as CalendarResponse;
  assert.deepEqual(calendar.days[0].items.map((item) => item.title), ["作業系統", "OS 讀書會 · Ch.5", "健身", "HW3 截止"]);
  assert.deepEqual(calendar.days[0].free.map((slot) => slot.minutes), [120, 240, 150]);

  const events = (await server.call("GET", "/api/events")).json as EventsResponse;
  assert.deepEqual(events.events.map((event) => [event.title, event.sourceLabel]), [
    ["Balsn CTF 2026", "CTFtime"],
    ["g0v 零時政府第柒拾次大松", "g0v 行事曆訂閱"],
    ["停修申請截止", "NYCU 校園行事曆"],
    ["HITCON CTF 2026 Quals", "CTFtime"],
  ]);
  assert.deepEqual(events.suggestions.map((item) => [item.id, item.title, item.origin]), [["ai:sg-sitcon-autumn", "SITCON 秋季交流會", "KKTIX 報名成功信"]]);
  assert.equal(events.feeds, 2);
});
