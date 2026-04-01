/**
 * weather.ts — Fetch current conditions and forecast from wttr.in
 *
 * wttr.in is a free, no-API-key weather service.
 * Endpoint: https://wttr.in/{location}?format=j1
 */

export interface HourlyForecast {
  timeLabel: string;    // "8 AM", "2 PM", etc.
  tempF: number;
  chanceOfRain: number; // 0–100
  chanceOfSnow: number;
  description: string;
}

export interface WeatherData {
  location: string;
  tempF: number;
  feelsLikeF: number;
  highF: number;
  lowF: number;
  description: string;
  windSpeedMph: number;
  windDir: string;
  humidity: number;
  visibility: number;  // miles
  uvIndex: number;
  /** Chance of rain/precip for the day (%) */
  chanceOfRain: number;
  chanceOfSnow: number;
  /** Next 24 hours in 3-hour blocks */
  hourly: HourlyForecast[];
  /** Tomorrow's forecast */
  tomorrow: {
    highF: number;
    lowF: number;
    description: string;
    chanceOfRain: number;
  };
}

export async function fetchWeather(zipCode = '10010'): Promise<WeatherData> {
  const url = `https://wttr.in/${zipCode}?format=j1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'curl/7.79.1' },
    });

    if (!res.ok) throw new Error(`wttr.in returned HTTP ${res.status}`);

    const data = await res.json() as any;

    const current = data.current_condition[0];
    const today = data.weather[0];
    const tomorrow = data.weather[1] ?? data.weather[0];

    // Parse hourly for today
    const hourly: HourlyForecast[] = (today.hourly as any[]).map((h: any) => {
      const time24 = parseInt(h.time, 10);
      const hour = time24 / 100;
      const period = hour < 12 ? 'AM' : 'PM';
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      return {
        timeLabel: `${displayHour} ${period}`,
        tempF: parseInt(h.tempF, 10),
        chanceOfRain: parseInt(h.chanceofrain ?? '0', 10),
        chanceOfSnow: parseInt(h.chanceofsnow ?? '0', 10),
        description: h.weatherDesc?.[0]?.value ?? '',
      };
    });

    return {
      location: 'StuyTown / Peter Cooper Village, NYC (10010)',
      tempF: parseInt(current.temp_F, 10),
      feelsLikeF: parseInt(current.FeelsLikeF, 10),
      highF: parseInt(today.maxtempF, 10),
      lowF: parseInt(today.mintempF, 10),
      description: current.weatherDesc?.[0]?.value ?? '',
      windSpeedMph: parseInt(current.windspeedMiles, 10),
      windDir: current.winddir16Point ?? '',
      humidity: parseInt(current.humidity, 10),
      visibility: parseInt(current.visibility, 10),
      uvIndex: parseInt(current.uvIndex, 10),
      chanceOfRain: Math.max(...(today.hourly as any[]).map((h: any) => parseInt(h.chanceofrain ?? '0', 10))),
      chanceOfSnow: Math.max(...(today.hourly as any[]).map((h: any) => parseInt(h.chanceofsnow ?? '0', 10))),
      hourly,
      tomorrow: {
        highF: parseInt(tomorrow.maxtempF, 10),
        lowF: parseInt(tomorrow.mintempF, 10),
        description: tomorrow.hourly?.[4]?.weatherDesc?.[0]?.value ?? '',
        chanceOfRain: Math.max(...(tomorrow.hourly as any[]).map((h: any) => parseInt(h.chanceofrain ?? '0', 10))),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
