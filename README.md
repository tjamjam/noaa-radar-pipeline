# NOAA Radar Pipeline

Self-hosted NEXRAD radar tile pipeline using free NOAA data. Replaces commercial radar tile APIs (~$1K/mo at scale) with a $4/mo EC2 instance.

## Demo

[LucidSky](https://apps.apple.com/app/lucidsky/id6477759178) — iOS weather app using this pipeline for live radar and 24hr forecast precip maps.

## What it does

**MRMS (live radar):** Downloads NOAA's Multi-Radar Multi-Sensor (MRMS) GRIB2 data every 5 minutes, reprojects to Web Mercator, applies separate color ramps for rain, snow, and hail, and generates XYZ PNG tiles. Uploads to Cloudflare R2.

**HRRR (24hr forecast precip):** Downloads HRRR extended forecast runs from AWS Open Data using byte-range requests (~5 MB per run instead of ~700 MB full GRIB2), computes 24-hour accumulated precipitation split by type (rain/snow/ice), and generates XYZ tiles. Uploads to Cloudflare R2.

Both pipelines produce 0.01° (~1km) resolution tiles at zoom levels 3–8 with precipitation-type differentiation — something most commercial radar APIs don't offer.

## Prerequisites

**System:**
- Node.js 20+
- GDAL tools: `gdalwarp`, `gdal_calc.py`, `gdaldem`, `gdal_merge.py`, `gdal2tiles.py`
  - macOS: `brew install gdal`
  - Amazon Linux 2023: `dnf install gdal310 gdal310-python-tools python3`

**Infrastructure:**
- Cloudflare R2 account with two buckets (e.g. `radar-tiles`, `forecast-tiles`)
- Public access enabled on both buckets (custom domain or R2.dev subdomain)

## Setup

```bash
git clone https://github.com/yourusername/noaa-radar-pipeline.git
cd noaa-radar-pipeline
npm install
cp .env.example .env
# Edit .env with your R2 credentials
```

## Usage

```bash
# Run full MRMS pipeline (generate + upload)
npm run mrms

# Run full HRRR pipeline (generate + upload)
npm run hrrr

# Run steps individually
npm run mrms:generate
npm run mrms:upload
npm run hrrr:generate
npm run hrrr:upload

# Control frame retention
npx tsx scripts/upload-mrms-tiles.ts --keep 20   # keep 20 most recent frames (~100 min)
npx tsx scripts/upload-hrrr-tiles.ts --keep 2    # keep 2 most recent HRRR runs
```

Tiles are served directly from R2 CDN:
```
{R2_RADAR_TILES_URL}/{timestamp}/{z}/{x}/{y}.png
{R2_FORECAST_TILES_URL}/{run}/{z}/{x}/{y}.png
```

## EC2 Deployment

The `infra/` directory contains scripts to provision and deploy to an AWS EC2 instance (t4g.small recommended, us-east-1 for zero egress cost from NOAA S3).

**First-time setup:**
```bash
# 1. Launch an EC2 instance using infra/user-data.sh as the User Data script
# 2. Once running, provision it:
./infra/setup.sh <instance-ip> <path-to-ssh-key.pem>
```

**Deploy updates:**
```bash
./infra/deploy.sh <instance-ip> <path-to-ssh-key.pem>
```

The setup script installs dependencies, copies all pipeline files, configures cron, and starts the pipeline automatically:
- MRMS: every 5 minutes (`*/5 * * * *`)
- HRRR: hourly at :30 (`30 * * * *`)

Both cron jobs use file locking to prevent overlapping runs.

## Cost

| Component | Cost |
|---|---|
| EC2 t4g.small (us-east-1) | ~$4/mo |
| NOAA MRMS S3 data | Free |
| HRRR AWS Open Data | Free |
| Cloudflare R2 storage + egress | Free (R2 has no egress fees) |

