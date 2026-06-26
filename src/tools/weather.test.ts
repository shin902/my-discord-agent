import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentWeatherTool, getWeatherForecastTool } from "./weather.js";

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

const geocodingResponse = {
  results: [
    {
      name: "東京",
      latitude: 35.6895,
      longitude: 139.6917,
      country: "日本",
      admin1: "東京都",
    },
  ],
};

describe("get-current-weather", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("地名から現在の天気を取得する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geocodingResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current: {
            time: "2026-06-13T12:00",
            temperature_2m: 25.4,
            apparent_temperature: 27.1,
            relative_humidity_2m: 60,
            wind_speed_10m: 5.2,
            weather_code: 1,
          },
          current_units: {
            temperature_2m: "°C",
            apparent_temperature: "°C",
            relative_humidity_2m: "%",
            wind_speed_10m: "km/h",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentWeatherTool.execute("id", {
      location: "東京",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("geocoding-api.open-meteo.com"),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("api.open-meteo.com/v1/forecast"),
    );

    const text = firstText(result);
    expect(text).toContain("東京, 東京都, 日本");
    expect(text).toContain("ほぼ晴れ");
    expect(text).toContain("25.4°C");
    expect(text).toContain("60%");
  });

  it("地名が見つからない場合は例外を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      }),
    );

    await expect(
      getCurrentWeatherTool.execute("id", { location: "存在しない地名" }),
    ).rejects.toThrow("見つかりませんでした");
  });

  it("天気APIエラー時に例外を投げる", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geocodingResponse,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getCurrentWeatherTool.execute("id", { location: "東京" }),
    ).rejects.toThrow("天気APIエラー 500");
  });
});

describe("get-weather-forecast", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("地名から数日間の天気予報を取得する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geocodingResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daily: {
            time: ["2026-06-13", "2026-06-14"],
            temperature_2m_max: [28.0, 26.5],
            temperature_2m_min: [20.1, 19.8],
            precipitation_probability_max: [10, 80],
            weather_code: [1, 61],
          },
          daily_units: {
            temperature_2m_max: "°C",
            temperature_2m_min: "°C",
            precipitation_probability_max: "%",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWeatherForecastTool.execute("id", {
      location: "東京",
      days: 2,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("forecast_days=2"),
    );

    const text = firstText(result);
    expect(text).toContain("2026-06-13");
    expect(text).toContain("ほぼ晴れ");
    expect(text).toContain("28°C / 20.1°C");
    expect(text).toContain("2026-06-14");
    expect(text).toContain("小雨");
    expect(text).toContain("80%");
  });

  it("daysの指定がない場合は3日分取得する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geocodingResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daily: {
            time: [],
            temperature_2m_max: [],
            temperature_2m_min: [],
            precipitation_probability_max: [],
            weather_code: [],
          },
          daily_units: {},
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await getWeatherForecastTool.execute("id", { location: "東京" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("forecast_days=3"),
    );
  });

  it("daysが範囲外の場合は1〜7にクランプする", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geocodingResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daily: {
            time: [],
            temperature_2m_max: [],
            temperature_2m_min: [],
            precipitation_probability_max: [],
            weather_code: [],
          },
          daily_units: {},
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await getWeatherForecastTool.execute("id", { location: "東京", days: 10 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("forecast_days=7"),
    );
  });
});
