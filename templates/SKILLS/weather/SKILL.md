---
name: weather
description: Get current weather and forecasts for a place.
---

# Weather

Pass the capability's JSON arguments unchanged:

```bash
bash SKILLS/weather/scripts/weather.sh get-current-weather '{"location":"Tokyo"}'
bash SKILLS/weather/scripts/weather.sh get-weather-forecast '{"location":"Tokyo","days":5}'
```

Capabilities: `get-current-weather`, `get-weather-forecast`.

The script does not parse or transform arguments. Use the capability's canonical Tool schema when constructing the JSON object.
