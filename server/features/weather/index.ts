import { Router } from "express";
import { z } from "zod";
import { CONNECT_LIMITS } from "../../../shared/connect.js";
import type { Weather } from "../../../shared/weather.js";
import { AppError } from "../../errors.js";
import type { FeatureModule, ModuleContext } from "../../modules.js";
import { expectOk, safeFetch, SourceSync, type SyncContext, type SyncOutcome } from "../../sync.js";
import { forecastUrl, geocodeUrl, heroWeather, mapForecast, mapGeocode, sameLocation } from "./open-meteo.js";

/** Forecasts change slowly: every 30 minutes, and a page open refetches only after 15. */
export const WEATHER_INTERVAL_MS = 30 * 60_000;
export const WEATHER_STALE_AFTER_MS = 15 * 60_000;
/** A changed city is fetched at most this often from today() (the settings page also forces a sync). */
const RELOCATE_KICK_MS = 60_000;

/** Open-Meteo forecast for weather.location → source_items weather/current. Configured = weather.enabled. */
export class WeatherSource extends SourceSync {
  constructor(private readonly ctx: ModuleContext, options: { intervalMs?: number } = {}) {
    super({
      id: "weather",
      state: ctx.syncState,
      intervalMs: options.intervalMs ?? WEATHER_INTERVAL_MS,
      staleAfterMs: WEATHER_STALE_AFTER_MS,
      fetch: ctx.fetch,
      now: ctx.now,
    });
  }

  configured(): boolean {
    return this.ctx.settings.value("weather.enabled");
  }

  protected async run({ http, now }: SyncContext): Promise<SyncOutcome> {
    const location = this.ctx.settings.value("weather.location");
    const response = expectOk(await http(forecastUrl(location, this.ctx.config.timeZone)), "天氣服務");
    const weather = mapForecast(response.json(), location, now, this.ctx.config.timeZone);
    this.ctx.sourceItems.replace<Weather>("weather", "weather", [{ kind: "weather", externalId: "current", value: weather }]);
    return { items: 1 };
  }

  /** Whether the cache was fetched for a different city than the one in settings. */
  isStale(): boolean {
    const cached = this.ctx.sourceItems.get<Weather>("weather", "current")?.value;
    if (cached && !sameLocation(cached, this.ctx.settings.value("weather.location"))) return true;
    return super.isStale();
  }
}

/**
 * 天氣 module (habits-brief team). Contract: docs/ARCHITECTURE.md §10 and
 * docs/design/SPEC-ux.md §4.2 (hero eyebrow).
 *
 * Source `weather` (Open-Meteo, no key; weather.enabled, weather.location) →
 *   source_items weather/current (Weather with the next 24 h of rain chances).
 * Routes (/api/weather): GET /geocode?q= → GeocodeResponse; the settings page
 *   saves the choice with PUT /api/settings/app {"weather.location"} and then
 *   POST /api/sync {sources:["weather"], force:true}.
 * today(): weather { city, tempC, text, rain? } (rain only when ≥ 50 % later
 *   today); nothing when off, missing, older than 3 h or for another city.
 */
export const weatherModule: FeatureModule = {
  name: "weather",
  label: "天氣",
  setup(ctx) {
    const source = new WeatherSource(ctx);
    let lastKick = 0;
    const router = Router();

    router.get("/geocode", async (req, res) => {
      const { q } = z.object({ q: z.string().trim().min(1, { message: "請輸入城市名稱。" }).max(CONNECT_LIMITS.geocodeQuery, { message: "城市名稱太長了。" }) }).parse(req.query);
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      let response: Awaited<ReturnType<typeof safeFetch>>;
      try {
        response = await safeFetch(ctx.fetch, geocodeUrl(q), controller.signal, { timeoutMs: 8_000, maxBytes: 500_000 });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new AppError(502, "地點搜尋服務沒有回應，請稍後再試。");
      }
      if (!response.ok) throw new AppError(502, `地點搜尋服務暫時無法使用（HTTP ${response.status}），請稍後再試。`);
      res.json(mapGeocode(response.json()));
    });

    return {
      router,
      sources: [source],
      today: (_ctx, { now, timeZone, settings }) => {
        if (!settings["weather.enabled"]) return {};
        const location = settings["weather.location"];
        const cached = ctx.sourceItems.get<Weather>("weather", "current")?.value;
        if (cached && !sameLocation(cached, location) && now.getTime() - lastKick > RELOCATE_KICK_MS) {
          // The city changed: fetch it in the background; the hero shows no weather until it lands.
          lastKick = now.getTime();
          source.schedule();
        }
        const weather = heroWeather(cached, location, now, timeZone);
        return weather ? { weather } : {};
      },
    };
  },
};
