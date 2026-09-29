import assert from "node:assert/strict";
import { createWebTool } from "../src/tools/web.js";

// Explicit public-network smoke checks. No model requests, API keys or workspace data.
const tool = createWebTool({ permission: "allow" });
let failures = 0;
async function check(name: string, args: unknown, verify: (page: Record<string, unknown>) => void) {
  const response = await tool.execute(args);
  if (!response.ok) {
    failures++;
    console.log(JSON.stringify({ check: name, ok: false, error: response.error }));
    return;
  }
  const page = response.result as Record<string, unknown>;
  try {
    verify(page);
    console.log(JSON.stringify({ check: name, ok: true, source: page.url, retrievedAt: page.retrievedAt }));
  } catch {
    failures++;
    console.log(JSON.stringify({ check: name, ok: false, error: "The response did not contain the expected public data." }));
  }
}

await check("research search", { action: "search", query: "Node.js official documentation", limit: 3 }, (page) => {
  assert.ok(Array.isArray(page.results) && page.results.length > 0);
});
await check("news search", { action: "search", query: "science news", recency: "week", limit: 3 }, (page) => {
  assert.ok(Array.isArray(page.results) && page.results.length > 0);
});
await check("public page", { action: "fetch", url: "https://nodejs.org/en/about/previous-releases" }, (page) => {
  assert.match(String(page.content), /Node.js Releases/);
});
let coordinates: { latitude: number; longitude: number } | undefined;
await check("weather geocoding", { action: "fetch", url: "https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=5&language=en&format=json" }, (page) => {
  assert.equal(page.truncated, false);
  const data = JSON.parse(String(page.content)) as { results: { latitude: number; longitude: number; country_code: string }[] };
  const place = data.results.find((entry) => entry.country_code === "DE");
  assert.ok(place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude));
  coordinates = place;
});
if (coordinates) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({ latitude: String(coordinates.latitude), longitude: String(coordinates.longitude),
    current: "temperature_2m,weather_code", daily: "temperature_2m_max,temperature_2m_min", timezone: "auto", forecast_days: "3" }).toString();
  await check("weather forecast", { action: "fetch", url: url.href }, (page) => {
    assert.equal(page.truncated, false);
    const data = JSON.parse(String(page.content));
    assert.equal(typeof data.current.time, "string");
    assert.equal(typeof data.current_units.temperature_2m, "string");
    assert.equal(typeof data.current.temperature_2m, "number");
    assert.equal(data.daily.time.length, 3);
  });
} else {
  failures++;
  console.log(JSON.stringify({ check: "weather forecast", ok: false, skipped: "Geocoding did not succeed." }));
}
console.log(JSON.stringify({ checks: 5, failures, modelRequests: 0 }));
process.exitCode = failures ? 1 : 0;
