export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
  /** IANA zone reported by the geocoder. */
  timezone?: string;
}

/** Open-Meteo snapshot for the Today hero. */
export interface Weather {
  location: string;
  /** Where it was fetched for, so a changed weather.location is not shown the old city's forecast. */
  coords?: { latitude: number; longitude: number };
  current: { temperatureC: number; apparentC?: number; code: number; isDay: boolean };
  today: { maxC: number; minC: number; precipitationProbability?: number; code: number };
  /** Hourly precipitation probability for the rest of today (the 「21:00 後降雨 60%」 segment). */
  hourly?: { time: string; precipitationProbability: number }[];
  fetchedAt: string;
}

export const DEFAULT_WEATHER_LOCATION: WeatherLocation = { name: "台北", latitude: 25.033, longitude: 121.5654, timezone: "Asia/Taipei" };

/** WMO weather interpretation codes used by Open-Meteo. */
export const WEATHER_CODE_LABELS: Record<number, string> = {
  0: "晴朗", 1: "大致晴朗", 2: "多雲時晴", 3: "陰天",
  45: "有霧", 48: "霧淞",
  51: "毛毛雨", 53: "毛毛雨", 55: "較強毛毛雨", 56: "凍毛毛雨", 57: "凍毛毛雨",
  61: "小雨", 63: "下雨", 65: "大雨", 66: "凍雨", 67: "凍雨",
  71: "小雪", 73: "下雪", 75: "大雪", 77: "雪粒",
  80: "陣雨", 81: "較強陣雨", 82: "豪雨",
  85: "陣雪", 86: "較強陣雪",
  95: "雷雨", 96: "雷雨伴隨冰雹", 99: "強雷雨伴隨冰雹",
};

export function weatherLabel(code: number): string {
  return WEATHER_CODE_LABELS[code] ?? "天氣資料";
}
