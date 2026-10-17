---
name: weather-lookup
description: Look up current weather and short forecasts for a named location using public weather data, with explicit dates, local timezone, units, and source attribution.
---

# Weather lookup

Use `web` with `action: "fetch"` to read public JSON APIs; no dedicated weather tool is needed. Identify the requested city and date. If similarly named places could change the answer, ask for the region or use the supplied region to select a matching result. Do not infer a precise location from unrelated workspace information.

Open-Meteo offers a public non-commercial endpoint without an API key. Check its [terms](https://open-meteo.com/en/terms) for commercial use; do not imply unrestricted service or availability. Another public source can be used when appropriate.

1. Geocode the city with `https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=5&language=en&format=json`, replacing and URL-encoding the place name. Inspect country, administrative region, latitude, longitude, and timezone; do not assume the first match is correct.
2. Fetch the selected coordinates, for example `https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3`. Replace coordinates from geocoding; keep the returned fields and date range small. For Fahrenheit add `temperature_unit=fahrenheit`; otherwise use the returned unit metadata.
3. Read `current.time`, `current_units`, daily dates and units, and timezone. Report the selected place, the data's local time, and the requested current or forecast values. Current values are model-based estimates, not necessarily a local station observation. Forecasts are predictions. `retrievedAt` is not the observation time.

Common WMO weather codes: 0 clear; 1 mainly clear; 2 partly cloudy; 3 overcast; 45/48 fog; 51/53/55 drizzle; 56/57 freezing drizzle; 61/63/65 rain; 66/67 freezing rain; 71/73/75 snow; 77 snow grains; 80/81/82 rain showers; 85/86 snow showers; 95 thunderstorm; 96/99 thunderstorm with hail. Describe intensity only if supported by the specific code; do not guess an unknown code or treat missing/null values as zero.

Link the actual weather API source and attribute Open-Meteo when used. For official severe-weather warnings, historical dates, or requests beyond this short forecast, use `web` research to find an appropriate meteorological authority or documented endpoint; do not substitute a current forecast. If data cannot be retrieved, say so instead of answering from memory as though it were live.

Reference documentation: [Forecast API](https://open-meteo.com/en/docs), [Geocoding API](https://open-meteo.com/en/docs/geocoding-api).
