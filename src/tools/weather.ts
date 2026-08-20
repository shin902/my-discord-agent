import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { z } from "zod";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const WEATHER_CODE_DESCRIPTIONS = {
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
} satisfies Record<number, string>;

function describeWeatherCode(code: number): string {
  const description = Object.entries(WEATHER_CODE_DESCRIPTIONS).find(
    ([key]) => Number(key) === code,
  )?.[1];
  return description ?? `天気コード ${code}`;
}

const geocodingResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

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
  const data = geocodingResponseSchema.parse(await res.json());
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
    description: "天気を取得する地名（例: 東京、Tokyo、大阪）",
  }),
});

const currentWeatherResponseSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number(),
  }),
  current_units: z.record(z.string(), z.string()),
});

export const getCurrentWeatherTool: AgentTool<typeof currentWeatherParams> = {
  name: "get-current-weather",
  label: "現在の天気",
  description:
    "指定した地名の現在の天気・気温・湿度・風速を取得する。最新の天気状況を答える際に使う",
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
    const data = currentWeatherResponseSchema.parse(await res.json());
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
    description: "天気予報を取得する地名（例: 東京、Tokyo、大阪）",
  }),
  days: Type.Optional(
    Type.Integer({
      description: "予報日数（デフォルト: 3、最大: 7）",
      minimum: 1,
      maximum: 7,
    }),
  ),
});

const forecastResponseSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number()),
    weather_code: z.array(z.number()),
  }),
  daily_units: z.record(z.string(), z.string()),
});

export const getWeatherForecastTool: AgentTool<typeof forecastParams> = {
  name: "get-weather-forecast",
  label: "天気予報",
  description:
    "指定した地名の数日間の天気予報（最高/最低気温・降水確率）を取得する",
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
    const data = forecastResponseSchema.parse(await res.json());
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
