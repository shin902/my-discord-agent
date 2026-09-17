---
name: weather
description: Get current weather and forecasts for a place.
---

# Weather

Capabilities and uses:

- `get-current-weather`: get current weather for a place
- `get-weather-forecast`: get a forecast for a place

First retrieve only the capability you need, then follow its description (including safety requirements) and parameters when constructing raw JSON. Set the `bash` Tool's `timeoutMs` to `130000` for every script call; this is only an outer ceiling, while each capability keeps its own runtime timeout.

```bash
# Read the canonical Tool contract without executing it
bash SKILLS/weather/scripts/weather.sh get-current-weather
# Execute with JSON matching that contract
bash SKILLS/weather/scripts/weather.sh get-current-weather '{"location":"Tokyo"}'
```

The script does not parse or transform arguments. Skill selection does not grant permission: the run must allow the capability through native `tools` or trusted `toolSets` (normally `weather`).
