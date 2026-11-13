import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TodayPayload } from "../../../shared/today.js";
import type { Weather, WeatherLocation } from "../../../shared/weather.js";
import { appContext } from "../../app.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { forecastUrl, heroWeather, mapForecast, mapGeocode, rainAfter } from "./open-meteo.js";
import { weatherModule } from "./index.js";

const TZ = "Asia/Taipei";
const HSINCHU: WeatherLocation = { name: "新竹", latitude: 24.8138, longitude: 120.9675, timezone: TZ };
/** Monday 2026-10-12 08:42 in Taipei. */
const MORNING = new Date("2026-10-12T00:42:00.000Z");
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** A fetch fake: answers by host and records every URL. */
function fakeFetch(routes: Record<string, () => Response>) {
  const urls: URL[] = [];
  const fetch = async (input: string | URL) => {
    const url = new URL(input);
    urls.push(url);
    const route = routes[url.host];
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
  return { fetch, urls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("an Open-Meteo forecast maps to the cached Weather with the next 24 hours of rain", () => {
  const weather = mapForecast(fixture("open-meteo-forecast.json"), HSINCHU, MORNING, TZ);
  assert.equal(weather.location, "新竹");
  assert.deepEqual(weather.coords, { latitude: 24.8138, longitude: 120.9675 });
  assert.deepEqual(weather.current, { temperatureC: 23.6, apparentC: 25.1, code: 2, isDay: true });
  assert.deepEqual(weather.today, { maxC: 27.4, minC: 21.2, precipitationProbability: 60, code: 3 });
  assert.equal(weather.hourly?.length, 24);
  assert.equal(weather.hourly?.[0].time, "2026-10-12T00:00:00.000Z", "from the current hour (08:00 local)");
  assert.equal(weather.fetchedAt, MORNING.toISOString());
  assert.throws(() => mapForecast({ current: { temperature_2m: "warm" } }, HSINCHU, MORNING, TZ), /格式不正確/);

  const url = forecastUrl(HSINCHU, TZ);
  assert.equal(url.origin, "https://api.open-meteo.com");
  assert.equal(url.searchParams.get("timezone"), TZ);
  assert.equal(url.searchParams.get("timeformat"), "unixtime");
  assert.match(url.searchParams.get("hourly") ?? "", /precipitation_probability/);
});

test("rain is the first hour later today at 50 % or more, never tomorrow's", () => {
  const weather = mapForecast(fixture("open-meteo-forecast.json"), HSINCHU, MORNING, TZ);
  assert.deepEqual(rainAfter(weather, MORNING, TZ), { from: "2026-10-12T13:00:00.000Z", pct: 60 }); // 21:00 local
  // At 21:30 the current hour still counts.
  assert.deepEqual(rainAfter(weather, new Date("2026-10-12T13:30:00.000Z"), TZ)?.from, "2026-10-12T13:00:00.000Z");
  const dry: Weather = { ...weather, hourly: weather.hourly!.map((hour) => ({ ...hour, precipitationProbability: Date.parse(hour.time) >= Date.parse("2026-10-12T16:00:00.000Z") ? 90 : 20 })) };
  assert.equal(rainAfter(dry, MORNING, TZ), undefined, "90 % after midnight is tomorrow's rain");

  assert.deepEqual(heroWeather(weather, HSINCHU, MORNING, TZ), { city: "新竹", tempC: 24, text: "多雲時晴", rain: { from: "2026-10-12T13:00:00.000Z", pct: 60 } });
  assert.equal(heroWeather(weather, { ...HSINCHU, name: "台北", latitude: 25.033, longitude: 121.5654 }, MORNING, TZ), undefined, "fetched for another city");
  assert.equal(heroWeather(weather, HSINCHU, new Date(MORNING.getTime() + 4 * 3_600_000), TZ), undefined, "older than 3 hours");
  assert.equal(heroWeather(undefined, HSINCHU, MORNING, TZ), undefined);
});

test("geocoding maps places to locations with a readable label", () => {
  const { results } = mapGeocode(fixture("open-meteo-geocode.json"));
  assert.deepEqual(results[0], { name: "新竹市", latitude: 24.80361, longitude: 120.96861, timezone: TZ, label: "新竹市 · 台灣", country: "台灣" });
  assert.equal(results[1].label, "新竹縣 · 台灣省 · 台灣");
  assert.equal(results[1].admin, "台灣省");
  assert.deepEqual(mapGeocode({ generationtime_ms: 0.2 }), { results: [] }, "no match is an empty list");
  const village = mapGeocode({ results: [{ name: "新竹", latitude: 22.46, longitude: 120.47, country: "台湾", admin1: "臺灣省 or 台灣省" }] }).results[0];
  assert.equal(village.label, "新竹 · 臺灣省 · 台湾", "alternative spellings are dropped");
});

test("the weather source fetches the configured city and today() shows the hero segments", async (t) => {
  const fake = fakeFetch({ "api.open-meteo.com": () => json(fixture("open-meteo-forecast.json")) });
  const services = testServices(t, { seams: { fetch: fake.fetch, now: () => MORNING } });
  services.settings.update({ "weather.location": HSINCHU });
  const app = await startTestServer(t, services, { modules: [weatherModule] });
  const source = appContext(app.app).modules.source("weather")!;

  const status = await source.sync();
  assert.equal(status.state, "ok");
  assert.equal(fake.urls[0].searchParams.get("latitude"), "24.8138");
  assert.equal(fake.urls[0].searchParams.get("timezone"), TZ);
  assert.equal(fake.urls[0].protocol, "https:");

  const today = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.deepEqual(today.weather, { city: "新竹", tempC: 24, text: "多雲時晴", rain: { from: "2026-10-12T13:00:00.000Z", pct: 60 } });
  assert.equal(today.sources.find((item) => item.id === "weather")?.state, "ok");

  // A different city in settings: the old forecast is not shown and the new city is fetched.
  services.settings.update({ "weather.location": { name: "台北", latitude: 25.033, longitude: 121.5654 } });
  assert.equal(source.isStale(), true);
  const moved = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(moved.weather, undefined);
  await source.sync();
  assert.equal(fake.urls.at(-1)?.searchParams.get("latitude"), "25.033");
  assert.equal(((await app.call("GET", "/api/today")).json as TodayPayload).weather?.city, "台北");

  // Off: no segments and no fetching.
  services.settings.update({ "weather.enabled": false });
  const off = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(off.weather, undefined);
  assert.equal(off.sources.find((item) => item.id === "weather")?.state, "off");
  const before = fake.urls.length;
  await source.sync();
  assert.equal(fake.urls.length, before);
});

test("a failing forecast leaves the source in error and the hero without weather", async (t) => {
  const fake = fakeFetch({ "api.open-meteo.com": () => json({ error: true, reason: "boom" }, 500) });
  const services = testServices(t, { seams: { fetch: fake.fetch, now: () => MORNING } });
  const app = await startTestServer(t, services, { modules: [weatherModule] });
  const status = await appContext(app.app).modules.source("weather")!.sync();
  assert.equal(status.state, "error");
  assert.match(status.lastError ?? "", /天氣服務 回應 HTTP 500/);
  const today = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(today.weather, undefined);
  assert.equal(today.sources.find((item) => item.id === "weather")?.state, "error");
});

test("GET /api/weather/geocode searches Open-Meteo in Chinese and reports failures in zh-TW", async (t) => {
  let answer = () => json(fixture("open-meteo-geocode.json"));
  const fake = fakeFetch({ "geocoding-api.open-meteo.com": () => answer() });
  const services = testServices(t, { seams: { fetch: fake.fetch } });
  const app = await startTestServer(t, services, { modules: [weatherModule] });

  const found = await app.call("GET", `/api/weather/geocode?q=${encodeURIComponent(" 新竹 ")}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.results.length, 2);
  assert.equal(found.json.results[0].label, "新竹市 · 台灣");
  const url = fake.urls[0];
  assert.equal(url.searchParams.get("name"), "新竹");
  assert.equal(url.searchParams.get("language"), "zh");
  assert.equal(url.searchParams.get("count"), "8");

  assert.equal((await app.call("GET", "/api/weather/geocode")).status, 400);
  assert.equal((await app.call("GET", `/api/weather/geocode?q=${"a".repeat(81)}`)).status, 400);
  answer = () => json({ error: true }, 503);
  const down = await app.call("GET", "/api/weather/geocode?q=Taipei");
  assert.equal(down.status, 502);
  assert.match(down.json.error, /地點搜尋服務暫時無法使用/);
  answer = () => { throw new TypeError("fetch failed"); };
  const offline = await app.call("GET", "/api/weather/geocode?q=Taipei");
  assert.equal(offline.status, 502);
  assert.match(offline.json.error, /地點搜尋服務沒有回應/);
});
