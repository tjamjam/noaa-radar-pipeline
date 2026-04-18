---
description: Run a single-zoom MRMS or HRRR generation as a fast local smoke test
argument-hint: <mrms|hrrr> [zoom=3]
---

Run a fast end-to-end smoke test of the tile generation pipeline by forcing a single zoom level. Use this before shipping pipeline changes instead of waiting for a full zoom 3–8 run.

Arguments: `$ARGUMENTS`
- First arg: `mrms` or `hrrr`. Required.
- Second arg: zoom level (default `3`). Any value accepted by `gdal2tiles.py --zoom`.

Steps:

1. Locate the generate script: `scripts/generate-mrms-tiles.ts` or `scripts/generate-hrrr-tiles.ts`.
2. Show the user the current `ZOOM_LEVELS` line and the temporary change you're about to make. Wait for confirmation only if the working tree has uncommitted changes to that file; otherwise proceed.
3. Edit the file to replace `const ZOOM_LEVELS = "3-8";` with `const ZOOM_LEVELS = "<zoom>";` using the Edit tool.
4. Run the corresponding generate script: `npm run mrms:generate` or `npm run hrrr:generate`. Stream the output.
5. **Always revert the edit** when the run finishes — success or failure. Use Edit to restore `"3-8"`. Confirm with `git diff scripts/generate-*-tiles.ts` that the working tree is clean at the end.
6. Report: wall time, tile count, and the output directory under `scripts/output/`.

Do not run the upload step — this is a local-only smoke test. Do not delete the output tiles; the user may want to spot-check them.
