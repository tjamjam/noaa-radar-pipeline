---
description: Render a PNG gradient preview of a gdaldem color-ramp file
argument-hint: <path-to-ramp.txt> [output.png]
---

Render a horizontal gradient preview of a `gdaldem color-relief` ramp file so the user can eyeball the colors without running the full pipeline.

Arguments: `$ARGUMENTS`
- First arg: path to the ramp file (e.g. `scripts/mrms/color-ramps/rain.txt`). Required.
- Second arg: output PNG path. Optional; default to `/tmp/ramp-preview-<basename>.png`.

Steps:

1. Read the ramp file. Each non-blank, non-comment line is `value R G B A` (A optional, defaults to 255). Lines may be space- or tab-separated. Skip `#` comments.
2. Parse stops into `{ value, r, g, b, a }[]`, sorted ascending by value. If fewer than 2 stops, stop and tell the user.
3. Render a 512×128 PNG where each column's color is linearly interpolated between the two bracketing stops, matching `gdaldem color-relief` behavior (values below the first stop use the first stop's color; values above the last use the last).
4. Use `sharp` (already a dependency) with raw RGBA input. Premultiply the alpha correctly so the preview shows how tiles will actually composite.
5. Write the PNG to the chosen output path and print:
   - The output path
   - The number of stops parsed
   - The value range (min → max)

Keep the implementation inline using `npx tsx` with a temp file, or run it directly via `node -e` style scripting. Do not add a permanent script to the repo unless the user asks.
