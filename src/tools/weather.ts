import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "晴れ",
  1: "ほぼ晴れ",
  2: "一部曇り",
  3: "曇り",
  45: "霧",
  48: "霧（着氷性）",
  51: "弱い霧雨",
  53: "霧雨",
  55: "強い霧雨",
  56: "弱い着氷性の霧雨",
  57: "着氷性の霧雨",
  61: "小雨",
  63: "雨",
  65: "強い雨",
  66: "弱い着氷性の雨",
  67: "着氷性の雨",
  71: "小雪",
  73: "雪",
  75: "大雪",
  77: "細氷",
  80: "弱いにわか雨",
  81: "にわか雨",
  82: "激しいにわか雨",
  85: "弱いにわか雪",
  86: "にわか雪",
  95: "雷雨",
  96: "雷雨（小粒のあられ）",
  99: "雷雨（大粒のあられ）",
};

function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `天気コード ${code}`;
}

type GeocodingResponse = {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
  }>;
};

type Place = {
  latitude: number;
  longitude: number;
  label: string;
};

async function geocodeLocation(location: string): Promise<Place> {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(location)}&count=1&language=ja&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ジオコーディングAPIエラー ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as GeocodingResponse;
  const first = data.results?.[0];
  if (!first) {
    throw new Error(`地名「${location}」が見つかりませんでした`);
  }
  const label = [first.name, first.admin1, first.country]
    .filter(Boolean)
    .join(", ");
  return { latitude: first.latitude, longitude: first.longitude, label };
}

const currentWeatherParams = Type.Object({
  location: Type.String({
    description:
      "Place name whose current weather should be fetched, for example Tokyo or Osaka.",
  }),
});

export function isCurrentWeatherArgs(
  value: unknown,
): value is { location: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).location === "string"
  );
}

type CurrentWeatherResponse = {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  current_units: Record<string, string>;
};

export const getCurrentWeatherTool: AgentTool<typeof currentWeatherParams> = {
  name: "get-current-weather",
  label: "現在の天気",
  description:
    "Get the current weather, temperature, humidity, and wind speed for a specified place. Use it when answering about current weather conditions.",
  parameters: currentWeatherParams,
  execute: async (_toolCallId, { location }) => {
    const place = await geocodeLocation(location);
    const url =
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`天気APIエラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as CurrentWeatherResponse;
    const c = data.current;
    const units = data.current_units;

    const lines = [
      `## ${place.label} の現在の天気`,
      "",
      `- 時刻: ${c.time}`,
      `- 天気: ${describeWeatherCode(c.weather_code)}`,
      `- 気温: ${c.temperature_2m}${units.temperature_2m ?? "°C"}（体感: ${c.apparent_temperature}${units.apparent_temperature ?? "°C"}）`,
      `- 湿度: ${c.relative_humidity_2m}${units.relative_humidity_2m ?? "%"}`,
      `- 風速: ${c.wind_speed_10m}${units.wind_speed_10m ?? "km/h"}`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        location: place.label,
        latitude: place.latitude,
        longitude: place.longitude,
      },
    };
  },
};

const forecastParams = Type.Object({
  location: Type.String({
    description:
      "Place name whose weather forecast should be fetched, for example Tokyo or Osaka.",
  }),
  days: Type.Optional(
    Type.Integer({
      description: "Number of forecast days. Defaults to 3; maximum 7.",
      minimum: 1,
      maximum: 7,
    }),
  ),
});

export function isWeatherForecastArgs(
  value: unknown,
): value is { location: string; days?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const args = value as Record<string, unknown>;
  return (
    typeof args.location === "string" &&
    (args.days === undefined ||
      (typeof args.days === "number" && Number.isSafeInteger(args.days)))
  );
}

type ForecastResponse = {
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    weather_code: number[];
  };
  daily_units: Record<string, string>;
};

export const getWeatherForecastTool: AgentTool<typeof forecastParams> = {
  name: "get-weather-forecast",
  label: "天気予報",
  description:
    "Get a multi-day weather forecast for a specified place, including high and low temperatures and precipitation probability.",
  parameters: forecastParams,
  execute: async (_toolCallId, { location, days = 3 }) => {
    const forecastDays = Math.min(Math.max(days, 1), 7);
    const place = await geocodeLocation(location);
    const url =
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
      `&timezone=auto&forecast_days=${forecastDays}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`天気APIエラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as ForecastResponse;
    const d = data.daily;
    const units = data.daily_units;

    const lines = [`## ${place.label} の天気予報`, ""];
    for (let i = 0; i < d.time.length; i++) {
      lines.push(
        `### ${d.time[i]}`,
        `- 天気: ${describeWeatherCode(d.weather_code[i])}`,
        `- 最高/最低気温: ${d.temperature_2m_max[i]}${units.temperature_2m_max ?? "°C"} / ${d.temperature_2m_min[i]}${units.temperature_2m_min ?? "°C"}`,
        `- 降水確率: ${d.precipitation_probability_max[i]}${units.precipitation_probability_max ?? "%"}`,
        "",
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { location: place.label, days: forecastDays },
    };
  },
};
