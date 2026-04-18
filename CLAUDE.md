# NOAA Radar Pipeline

A Node.js/TypeScript data pipeline that downloads free NOAA weather data (MRMS live radar, HRRR 24hr forecast precipitation), reprojects and colorizes it with GDAL, generates XYZ map tiles, and uploads to Cloudflare R2. Runs on a small EC2 instance via cron. Not a web app, has no UI, no server.

## Development commands

```bash
npm run mrms            # Full MRMS pipeline: generate + upload
npm run hrrr            # Full HRRR pipeline: generate + upload
npm run mrms:generate   # Generate MRMS tiles only (writes to scripts/output/mrms-tiles)
npm run mrms:upload     # Upload latest MRMS frame to R2
npm run hrrr:generate   # Generate HRRR tiles only
npm run hrrr:upload     # Upload latest HRRR run to R2
npx tsc --noEmit        # Type check (no build step; tsx runs TS directly)
```

Upload scripts accept `--keep N` (retain N most recent frames/runs on R2) and `--all` (upload all local frames).

## System prerequisites

- Node.js 20+
- GDAL CLI tools on PATH: `gdalwarp`, `gdal_calc.py`, `gdaldem`, `gdal_merge.py`, `gdal2tiles.py`
  - macOS: `brew install gdal`
  - Amazon Linux 2023: `dnf install gdal310 gdal310-python-tools python3`
- `.env` at repo root with R2 credentials (see `.env.example`)

## Architecture

| Path | Purpose |
|---|---|
| `scripts/generate-mrms-tiles.ts` | Download PrecipRate + PrecipFlag GRIB2 from NOAA MRMS S3, mask by type, colorize, tile, smooth |
| `scripts/generate-hrrr-tiles.ts` | Byte-range fetch HRRR GRIB2 from AWS Open Data, accumulate 24hr precip by type, tile |
| `scripts/upload-{mrms,hrrr}-tiles.ts` | Push tiles to R2, rotate old frames |
| `scripts/{mrms,hrrr}/color-ramps/` | `gdaldem color-relief` ramp files (value R G B A per line) |
| `scripts/output/` | Generated tiles and intermediate GeoTIFFs (gitignored) |
| `lib/r2-client.ts` | Shared R2/S3 client factory and bucket config |
| `infra/user-data.sh` | EC2 Phase 1: install GDAL, Node, create `mrms` user, set up swap |
| `infra/setup.sh` | EC2 Phase 2: copy files, npm install, write wrapper + cron |
| `infra/deploy.sh` | Pull latest main on the instance |

The pipelines are plain procedural scripts. GDAL is shelled out via `execSync`. Sharp is used for per-tile premultiplied-alpha blur (intentionally at tile level, not raster level, to keep memory footprint small enough for t4g.nano/small).

## Key conventions

- **TypeScript strict, CommonJS target, ES2022.** No build step; `tsx` runs sources directly. Imports use relative paths (no `@/` aliases).
- **GDAL PATH helper.** Always invoke shell commands through the `gdalPath()` helper in each generate script so Homebrew (`/opt/homebrew/bin`) and Linux (`/usr/local/bin`) both work.
- **Aggressively delete intermediates.** The generate scripts `rmSync` each GeoTIFF the moment it's no longer needed. Preserve this pattern: a t4g.nano has 0.5 GB RAM and limited disk.
- **Timestamps are `YYYYMMDD-HHMMSS`** (UTC). MRMS uses the source file timestamp; HRRR uses the run label (e.g. `20260418-18z`). Both the local output dirs and R2 key prefixes follow this scheme.
- **Env via dotenv.** Scripts call `config({ path: resolve(__dirname, '..', '.env') })` so they work from any cwd. The cron wrappers use `set -a; source /home/mrms/.env` instead.
- **Batch uploads.** Upload scripts send tiles in parallel batches of 20 to R2. Don't unbound the concurrency.
- **No tests, no linter.** Intentional for a single-script pipeline. Don't add either unless asked.
- **No comments on self-evident logic.** The scripts already have block comments marking each pipeline stage. Match that style; don't add line-by-line commentary.

## External services

- **NOAA MRMS (S3):** `noaa-mrms-pds` bucket, CONUS PrecipRate/PrecipFlag, new file every ~2 min. Free, no auth.
- **NOAA HRRR (AWS Open Data):** `noaa-hrrr-bdp-pds` bucket. Extended runs at 00/06/12/18z, byte-range indexed via `.idx` sidecar files. Free, no auth.
- **Cloudflare R2:** tile storage and CDN. Two buckets: `radar-tiles` (MRMS) and `forecast-tiles` (HRRR). S3-compatible API; accessed via `@aws-sdk/client-s3` in `lib/r2-client.ts`.

## Deployment

Production runs on EC2 (t4g.small recommended, us-east-1 to avoid NOAA S3 egress). Cron schedule:
- MRMS: `*/5 * * * *`
- HRRR: `30 * * * *`

Both cron wrappers use `flock` to prevent overlapping runs. Use `infra/deploy.sh <ip> <key>` to ship new code; it `git reset --hard origin/main` on the instance and the next cron tick picks it up.
