/**
 * MRMS Radar Tile Generator
 *
 * Downloads the latest MRMS GRIB2 files from AWS Open Data (free, no auth),
 * splits precipitation by type (rain / snow / hail) using the PrecipFlag product,
 * applies distinct color ramps per type, and generates XYZ map tiles (256px PNG,
 * Web Mercator) at zoom levels 3–8.
 *
 * Smoothing is done at the tile level (sharp blur) rather than at the raster
 * level (cubicspline upsampling) to keep intermediate files small (~200 MB
 * instead of ~7 GB), making this viable on a t4g.nano (0.5 GB RAM).
 *
 * Prerequisites:
 *   macOS:  brew install gdal
 *   Linux:  dnf install gdal gdal-python-tools   (Amazon Linux 2023)
 *
 * Run: npx tsx apps/web/scripts/generate-mrms-tiles.ts
 */

import { execSync } from "child_process";
import {
  mkdirSync,
  rmSync,
  existsSync,
  createWriteStream,
  readdirSync,
  statSync,
} from "fs";
import { resolve, join } from "path";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MRMS_BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com";

const PRODUCTS = {
  rate: "PrecipRate_00.00",
  flag: "PrecipFlag_00.00",
} as const;

const ZOOM_LEVELS = "3-8";
const TILE_PROCESSES = 2;
const BLUR_SIGMA = 2.0;

const SCRIPTS_DIR = resolve(__dirname);
const COLOR_RAMPS_DIR = resolve(SCRIPTS_DIR, "mrms", "color-ramps");
const WORK_DIR = resolve(SCRIPTS_DIR, "output", "mrms-work");
const TILES_DIR = resolve(SCRIPTS_DIR, "output", "mrms-tiles");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a PATH that includes GDAL on both macOS (Homebrew) and Linux. */
function gdalPath(): string {
  const base = process.env.PATH ?? "";
  // Homebrew on Apple Silicon / Intel
  if (existsSync("/opt/homebrew/bin")) return `/opt/homebrew/bin:${base}`;
  if (existsSync("/usr/local/bin/gdalwarp")) return `/usr/local/bin:${base}`;
  return base;
}

function run(cmd: string, label?: string): string {
  if (label) console.log(`  → ${label}`);
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PATH: gdalPath() },
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Command failed: ${cmd}\n${msg}`);
  }
}

async function downloadAndGunzip(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`No body for ${url}`);

  const gunzip = createGunzip();
  const fileStream = createWriteStream(dest);

  await pipeline(res.body, gunzip, fileStream);
}

function parseLatestFile(xml: string): string | null {
  const keyRegex = /<Key>([^<]*)<\/Key>/g;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(xml)) !== null) {
    if (match[1].endsWith(".grib2.gz")) keys.push(match[1]);
  }
  if (keys.length === 0) return null;
  keys.sort();
  return keys[keys.length - 1];
}

function countTiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const zDir of readdirSync(dir)) {
    const zPath = join(dir, zDir);
    if (!statSync(zPath).isDirectory()) continue;
    for (const xDir of readdirSync(zPath)) {
      const xPath = join(zPath, xDir);
      if (!statSync(xPath).isDirectory()) continue;
      total += readdirSync(xPath).filter((f) => f.endsWith(".png")).length;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log("MRMS Radar Tile Generator");
  console.log("=========================\n");

  // Clean and create work directories
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(TILES_DIR, { recursive: true });

  // --- Step 1: Find latest MRMS files on S3 ---
  console.log("Step 1: Finding latest MRMS files on S3...");

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const yesterday = new Date(Date.now() - 86400000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  async function findLatestFile(product: string): Promise<string> {
    for (const date of [today, yesterday]) {
      const listUrl = `${MRMS_BUCKET}?list-type=2&prefix=CONUS/${product}/${date}/&max-keys=1000`;
      const res = await fetch(listUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      const key = parseLatestFile(xml);
      if (key) return key;
    }
    throw new Error(`No ${product} files found for ${today} or ${yesterday}`);
  }

  const [latestRateKey, latestFlagKey] = await Promise.all([
    findLatestFile(PRODUCTS.rate),
    findLatestFile(PRODUCTS.flag),
  ]);

  const timestampMatch = latestRateKey.match(/(\d{8}-\d{6})\.grib2\.gz$/);
  if (!timestampMatch) throw new Error(`Cannot parse timestamp from ${latestRateKey}`);
  const timestamp = timestampMatch[1];

  console.log(`  PrecipRate: ${latestRateKey}`);
  console.log(`  PrecipFlag: ${latestFlagKey}`);

  // --- Step 2: Download GRIB2 files ---
  console.log("\nStep 2: Downloading GRIB2 files...");

  const rateGrib = join(WORK_DIR, "PrecipRate.grib2");
  const flagGrib = join(WORK_DIR, "PrecipFlag.grib2");

  await Promise.all([
    downloadAndGunzip(`${MRMS_BUCKET}/${latestRateKey}`, rateGrib).then(() =>
      console.log("  ✓ PrecipRate downloaded"),
    ),
    downloadAndGunzip(`${MRMS_BUCKET}/${latestFlagKey}`, flagGrib).then(() =>
      console.log("  ✓ PrecipFlag downloaded"),
    ),
  ]);

  // --- Step 3: Reproject to Web Mercator ---
  console.log("\nStep 3: Reprojecting to Web Mercator...");

  const rate3857 = join(WORK_DIR, "rate_3857.tif");
  const flag3857 = join(WORK_DIR, "flag_3857.tif");

  run(
    `gdalwarp -t_srs EPSG:3857 -r bilinear -tr 1000 1000 -of GTiff "${rateGrib}" "${rate3857}"`,
    "PrecipRate → EPSG:3857",
  );
  // Delete source to save disk
  rmSync(rateGrib);

  run(
    `gdalwarp -t_srs EPSG:3857 -r near -tr 1000 1000 -of GTiff "${flagGrib}" "${flag3857}"`,
    "PrecipFlag → EPSG:3857",
  );
  rmSync(flagGrib);

  // --- Step 4: Mask by precipitation type ---
  console.log("\nStep 4: Masking by precipitation type...");

  const rainTif = join(WORK_DIR, "rain.tif");
  const snowTif = join(WORK_DIR, "snow.tif");
  const hailTif = join(WORK_DIR, "hail.tif");

  run(
    `gdal_calc.py -A "${rate3857}" -B "${flag3857}" --outfile="${rainTif}" --calc="A*((B==1)|(B==2))" --NoDataValue=0 --quiet`,
    "Rain mask (flag 1 or 2)",
  );

  run(
    `gdal_calc.py -A "${rate3857}" -B "${flag3857}" --outfile="${snowTif}" --calc="A*(B==3)" --NoDataValue=0 --quiet`,
    "Snow mask (flag 3)",
  );

  run(
    `gdal_calc.py -A "${rate3857}" -B "${flag3857}" --outfile="${hailTif}" --calc="A*((B==4)|(B==6))" --NoDataValue=0 --quiet`,
    "Hail mask (flag 4 or 6)",
  );

  // Free reprojected sources
  rmSync(rate3857);
  rmSync(flag3857);

  // --- Step 5: Apply color ramps ---
  console.log("\nStep 5: Applying color ramps...");

  const rainRgba = join(WORK_DIR, "rain_rgba.tif");
  const snowRgba = join(WORK_DIR, "snow_rgba.tif");
  const hailRgba = join(WORK_DIR, "hail_rgba.tif");

  run(
    `gdaldem color-relief "${rainTif}" "${join(COLOR_RAMPS_DIR, "rain.txt")}" "${rainRgba}" -alpha`,
    "Rain color ramp",
  );
  rmSync(rainTif);

  run(
    `gdaldem color-relief "${snowTif}" "${join(COLOR_RAMPS_DIR, "snow.txt")}" "${snowRgba}" -alpha`,
    "Snow color ramp",
  );
  rmSync(snowTif);

  run(
    `gdaldem color-relief "${hailTif}" "${join(COLOR_RAMPS_DIR, "hail.txt")}" "${hailRgba}" -alpha`,
    "Hail color ramp",
  );
  rmSync(hailTif);

  // --- Step 6: Merge layers and generate tiles ---
  console.log("\nStep 6: Merging layers and generating tiles...");

  const composite = join(WORK_DIR, "composite.tif");
  const outputDir = join(TILES_DIR, timestamp);

  run(
    `gdal_merge.py -o "${composite}" "${rainRgba}" "${snowRgba}" "${hailRgba}" -co COMPRESS=LZW`,
    "Merging rain + snow + hail",
  );

  // Free RGBA sources
  rmSync(rainRgba);
  rmSync(snowRgba);
  rmSync(hailRgba);

  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });

  run(
    `gdal2tiles.py --zoom=${ZOOM_LEVELS} --xyz --processes=${TILE_PROCESSES} "${composite}" "${outputDir}"`,
    `Generating tiles (zoom ${ZOOM_LEVELS}, ${TILE_PROCESSES} processes)`,
  );

  // Free composite
  rmSync(composite);

  // --- Step 7: Smooth tiles with premultiplied-alpha blur ---
  console.log("\nStep 7: Smoothing tiles (premultiplied blur)...");

  const sharpMod = (await import("sharp")).default;
  let smoothed = 0;

  // Scale blur by zoom: at max zoom (8) use full BLUR_SIGMA,
  // at lower zooms use proportionally less since each pixel covers more ground.
  const MAX_ZOOM = 8;

  for (const zDir of readdirSync(outputDir)) {
    const zPath = join(outputDir, zDir);
    if (!statSync(zPath).isDirectory()) continue;

    const zoom = Number(zDir);
    // sigma scales with zoom: z8 = full, z7 = half, z6 = quarter, etc.
    const sigma = Math.max(0.5, BLUR_SIGMA * Math.pow(2, zoom - MAX_ZOOM));

    for (const xDir of readdirSync(zPath)) {
      const xPath = join(zPath, xDir);
      if (!statSync(xPath).isDirectory()) continue;
      for (const file of readdirSync(xPath)) {
        if (!file.endsWith(".png")) continue;
        const tilePath = join(xPath, file);
        const meta = await sharpMod(tilePath).metadata();
        const w = meta.width!, h = meta.height!;
        const raw = await sharpMod(tilePath).ensureAlpha().raw().toBuffer();

        // Skip fully transparent tiles
        let hasContent = false;
        for (let i = 0; i < w * h; i++) {
          if (raw[i * 4 + 3] > 0) { hasContent = true; break; }
        }
        if (!hasContent) continue;

        // Premultiply alpha
        const premul = Buffer.alloc(raw.length);
        for (let i = 0; i < w * h; i++) {
          const a = raw[i * 4 + 3] / 255;
          premul[i * 4] = Math.round(raw[i * 4] * a);
          premul[i * 4 + 1] = Math.round(raw[i * 4 + 1] * a);
          premul[i * 4 + 2] = Math.round(raw[i * 4 + 2] * a);
          premul[i * 4 + 3] = raw[i * 4 + 3];
        }

        // Blur all 4 channels (sigma 0.5 minimum for sharp to accept)
        const blurred = await sharpMod(premul, { raw: { width: w, height: h, channels: 4 } })
          .blur(Math.max(0.5, sigma))
          .raw()
          .toBuffer();

        // Un-premultiply
        const result = Buffer.alloc(raw.length);
        for (let i = 0; i < w * h; i++) {
          const a = blurred[i * 4 + 3];
          result[i * 4 + 3] = a;
          if (a > 0) {
            const inv = 255 / a;
            result[i * 4] = Math.min(255, Math.round(blurred[i * 4] * inv));
            result[i * 4 + 1] = Math.min(255, Math.round(blurred[i * 4 + 1] * inv));
            result[i * 4 + 2] = Math.min(255, Math.round(blurred[i * 4 + 2] * inv));
          }
        }

        await sharpMod(result, { raw: { width: w, height: h, channels: 4 } })
          .png()
          .toFile(tilePath);

        smoothed++;
      }
    }
  }
  console.log(`  ✓ Smoothed ${smoothed} tiles`);

  // --- Done ---
  const totalTiles = countTiles(outputDir);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=========================`);
  console.log(`Done in ${elapsed}s — ${totalTiles} tiles → ${outputDir}`);

  // Clean up work directory
  rmSync(WORK_DIR, { recursive: true });
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err.message || err);
  process.exit(1);
});
