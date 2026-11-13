import { z } from "zod";
import type { GeocodeResponse } from "../../../shared/connect.js";
import { CONNECT_LIMITS } from "../../../shared/connect.js";
import { dayKey } from "../../../shared/time.js";
import type { TodayPayload } from "../../../shared/today.js";
import { weatherLabel, type Weather, type WeatherLocation } from "../../../shared/weather.js";
import { AppError } from "../../errors.js";

/**
 * Open-Meteo (no key): the forecast for the Today hero and the geocoder for
 * 連線與設定 › 天氣. Pure request builders and response mappers; the source
 * and the route do the I/O through safeFetch.
 */

export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
/** The hero shows rain from the first hour today at or above this probability. */
export const RAIN_THRESHOLD = 50;
/** Older than this, the cached forecast is not shown (the hero omits weather instead of showing a stale temperature). */
export const WEATHER_MAX_AGE_MS = 3 * 60 * 60_000;
const HOUR_MS = 3_600_000;

export function forecastUrl(location: WeatherLocation, timeZone: string): URL {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,is_day");
  url.searchParams.set("hourly", "precipitation_probability");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  // Daily values follow the user's day; unix times avoid parsing zone-less local strings.
  url.searchParams.set("timezone", timeZone);
  url.searchParams.set("timeformat", "unixtime");
  url.searchParams.set("forecast_days", "2");
  return url;
}

const numbers = z.array(z.number().nullable());
const forecastSchema = z.object({
  current: z.object({
    time: z.number(),
    temperature_2m: z.number(),
    apparent_temperature: z.number().nullable().optional(),
    weather_code: z.number().int(),
    is_day: z.number().int().optional(),
  }),
  hourly: z.object({ time: z.array(z.number()), precipitation_probability: numbers }).optional(),
  daily: z.object({
    time: z.array(z.number()),
    weather_code: numbers,
    temperature_2m_max: numbers,
    temperature_2m_min: numbers,
    precipitation_probability_max: numbers.optional(),
  }).optional(),
});

/** An Open-Meteo forecast → the cached Weather (hourly rain for the next 24 h). */
export function mapForecast(body: unknown, location: WeatherLocation, now: Date, timeZone: string): Weather {
  const parsed = forecastSchema.safeParse(body);
  if (!parsed.success) throw new AppError(502, "天氣服務回傳的資料格式不正確，稍後會自動重試。");
  const { current, hourly, daily } = parsed.data;
  const today = dayKey(timeZone, now);
  const dayIndex = daily ? Math.max(0, daily.time.findIndex((time) => dayKey(timeZone, time * 1000) === today)) : -1;
  const pick = (values: (number | null)[] | undefined) => (values && dayIndex >= 0 ? values[dayIndex] ?? undefined : undefined);
  const hourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const hours = (hourly?.time ?? [])
    .map((time, index) => ({ at: time * 1000, pct: hourly?.precipitation_probability[index] }))
    .filter((hour): hour is { at: number; pct: number } => typeof hour.pct === "number" && hour.at >= hourStart && hour.at < hourStart + 24 * HOUR_MS)
    .map((hour) => ({ time: new Date(hour.at).toISOString(), precipitationProbability: Math.round(hour.pct) }));
  const max = pick(daily?.temperature_2m_max);
  const min = pick(daily?.temperature_2m_min);
  const rain = pick(daily?.precipitation_probability_max);
  return {
    location: location.name,
    coords: { latitude: location.latitude, longitude: location.longitude },
    current: {
      temperatureC: current.temperature_2m,
      ...(typeof current.apparent_temperature === "number" ? { apparentC: current.apparent_temperature } : {}),
      code: current.weather_code,
      isDay: current.is_day !== 0,
    },
    today: {
      maxC: max ?? current.temperature_2m,
      minC: min ?? current.temperature_2m,
      ...(typeof rain === "number" ? { precipitationProbability: Math.round(rain) } : {}),
      code: pick(daily?.weather_code) ?? current.weather_code,
    },
    hourly: hours,
    fetchedAt: now.toISOString(),
  };
}

/**
 * 「21:00 後降雨 60%」: the first hour of the rest of today (the current hour
 * included) whose probability reaches 50 %, with the highest probability from
 * then until midnight. undefined when no hour today reaches it.
 */
export function rainAfter(weather: Weather, now: Date, timeZone: string): { from: string; pct: number } | undefined {
  const today = dayKey(timeZone, now);
  const rest = (weather.hourly ?? [])
    .filter((hour) => Date.parse(hour.time) + HOUR_MS > now.getTime() && dayKey(timeZone, hour.time) === today)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const first = rest.findIndex((hour) => hour.precipitationProbability >= RAIN_THRESHOLD);
  if (first < 0) return undefined;
  const pct = Math.max(...rest.slice(first).map((hour) => hour.precipitationProbability));
  return { from: rest[first].time, pct };
}

/** Whether the cache answers for the location in settings (it was fetched for it). */
export function sameLocation(weather: Weather, location: WeatherLocation): boolean {
  if (weather.coords) return Math.abs(weather.coords.latitude - location.latitude) < 0.01 && Math.abs(weather.coords.longitude - location.longitude) < 0.01;
  return weather.location === location.name;
}

/** The hero eyebrow segments (SPEC §4.2), or undefined when the cache is missing, stale or for another city. */
export function heroWeather(weather: Weather | undefined, location: WeatherLocation, now: Date, timeZone: string): TodayPayload["weather"] {
  if (!weather || !sameLocation(weather, location)) return undefined;
  if (now.getTime() - Date.parse(weather.fetchedAt) > WEATHER_MAX_AGE_MS) return undefined;
  const rain = rainAfter(weather, now, timeZone);
  return {
    city: location.name,
    tempC: Math.round(weather.current.temperatureC),
    text: weatherLabel(weather.current.code),
    ...(rain ? { rain } : {}),
  };
}

export function geocodeUrl(query: string): URL {
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", query);
  url.searchParams.set("count", String(CONNECT_LIMITS.geocodeResults));
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");
  return url;
}

const geocodeSchema = z.object({
  results: z.array(z.object({
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string().optional(),
    country: z.string().optional(),
    admin1: z.string().optional(),
  }).passthrough()).optional(),
});

/** Open-Meteo geocoding → GeocodeResponse (label 「新竹市 · 台灣」). No results is an empty list, not an error. */
export function mapGeocode(body: unknown): GeocodeResponse {
  const parsed = geocodeSchema.safeParse(body);
  if (!parsed.success) throw new AppError(502, "地點搜尋服務回傳的資料格式不正確，請稍後再試。");
  return {
    results: (parsed.data.results ?? []).slice(0, CONNECT_LIMITS.geocodeResults).map((place) => {
      // GeoNames joins alternative spellings with " or " (「臺灣省 or 台灣省」): keep the first.
      const region = place.admin1?.split(" or ")[0].trim();
      const admin = region && region !== place.name ? region : undefined;
      return {
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        ...(place.timezone ? { timezone: place.timezone } : {}),
        label: [place.name, admin, place.country].filter(Boolean).join(" · "),
        ...(place.country ? { country: place.country } : {}),
        ...(admin ? { admin } : {}),
      };
    }),
  };
}
