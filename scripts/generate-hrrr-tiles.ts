/**
 * HRRR Forecast Precipitation Tile Generator
 *
 * Downloads the latest HRRR extended run from AWS Open Data (free, no auth),
 * computes 24-hour accumulated precipitation, splits by precip type
 * (rain / snow / ice), applies distinct color ramps, and generates XYZ map
 * tiles (256px PNG, Web Mercator) at zoom levels 3–8.
 *
 * Uses byte-range downloads via .idx files to fetch only the needed GRIB2
 * variables (~5 MB each instead of ~700 MB full files).
 *
 * Prerequisites:
 *   macOS:  brew install gdal
 *   Linux:  dnf install gdal gdal-python-tools   (Amazon Linux 2023)
 *
 * Run: npx tsx apps/web/scripts/generate-hrrr-tiles.ts
 */

import { execSync } from "child_process";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { resolve, join } from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HRRR_BUCKET = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com";

/** Extended HRRR runs (00z, 06z, 12z, 18z) go out to 48h. */
const EXTENDED_RUN_HOURS = [18, 12, 6, 0];
const FORECAST_HOURS = { start: 0, end: 24 };
/** Sample type flags at these forecast hours to build a composite type mask. */
const TYPE_SAMPLE_FHS = [6, 12, 18, 24];

const ZOOM_LEVELS = "3-8";
const TILE_PROCESSES = 2;
const BLUR_SIGMA = 2.0;
const WARP_RES = 3000; // 3km resolution in EPSG:3857

const SCRIPTS_DIR = resolve(__dirname);
const COLOR_RAMPS_DIR = resolve(SCRIPTS_DIR, "hrrr", "color-ramps");
const WORK_DIR = resolve(SCRIPTS_DIR, "output", "hrrr-work");
const TILES_DIR = resolve(SCRIPTS_DIR, "output", "hrrr-tiles");

// ---------------------------------------------------------------------------
// Helpers (shared with MRMS pipeline)
// ---------------------------------------------------------------------------

function gdalPath(): string {
  const base = process.env.PATH ?? "";
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
// HRRR-specific helpers
// ---------------------------------------------------------------------------

interface IdxEntry {
  offset: number;
  nextOffset: number | null;
  variable: string;
  level: string;
  description: string;
}

/** Parse a GRIB2 .idx file into structured entries with byte offsets. */
function parseIdx(text: string): IdxEntry[] {
  const lines = text.trim().split("\n");
  const entries: IdxEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Format: N:OFFSET:d=YYYYMMDDHH:VAR:LEVEL:description
    const parts = lines[i].split(":");
    if (parts.length < 7) continue;

    const offset = Number(parts[1]);
    // Next entry's offset tells us where this variable's data ends
    let nextOffset: number | null = null;
    if (i + 1 < lines.length) {
      const nextParts = lines[i + 1].split(":");
      if (nextParts.length >= 2) nextOffset = Number(nextParts[1]);
    }

    entries.push({
      offset,
      nextOffset,
      variable: parts[3],
      level: parts[4],
      description: parts.slice(5).join(":"),
    });
  }

  return entries;
}

/**
 * Download a single variable from a GRIB2 file using HTTP Range request
 * guided by the .idx index. This fetches ~2-5 MB instead of ~700 MB.
 */
async function downloadVar(
  grib2Url: string,
  idxUrl: string,
  variable: string,
  levelMatch: string,
  descMatch: string,
  dest: string,
): Promise<void> {
  const idxRes = await fetch(idxUrl);
  if (!idxRes.ok) throw new Error(`HTTP ${idxRes.status} fetching ${idxUrl}`);
  const idxText = await idxRes.text();
  const entries = parseIdx(idxText);

  const entry = entries.find(
    (e) =>
      e.variable === variable &&
      e.level.includes(levelMatch) &&
      e.description.includes(descMatch),
  );
  if (!entry) {
    throw new Error(
      `Variable ${variable} (${levelMatch}, ${descMatch}) not found in ${idxUrl}`,
    );
  }

  const rangeEnd = entry.nextOffset ? entry.nextOffset - 1 : "";
  const rangeHeader = `bytes=${entry.offset}-${rangeEnd}`;

  const res = await fetch(grib2Url, {
    headers: { Range: rangeHeader },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} fetching ${grib2Url} (range: ${rangeHeader})`);
  }
  if (!res.body) throw new Error(`No body for ${grib2Url}`);

  const fileStream = createWriteStream(dest);

  await pipeline(res.body, fileStream);
}

/** Format a Date as YYYYMMDD. */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Format a number as zero-padded 2-digit string. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Find the latest available extended HRRR run by checking backwards
 * through run times. Returns { date: "YYYYMMDD", hour: HH }.
 */
async function findLatestRun(): Promise<{ date: string; hour: number }> {
  const now = new Date();

  // Check last 24h of extended runs (00z, 06z, 12z, 18z)
  for (let hoursBack = 0; hoursBack <= 24; hoursBack += 6) {
    const candidate = new Date(now.getTime() - hoursBack * 3600000);
    // Snap to most recent extended run hour at or before this time
    for (const runHour of EXTENDED_RUN_HOURS) {
      const runTime = new Date(candidate);
      runTime.setUTCHours(runHour, 0, 0, 0);
      if (runTime > now) continue;

      // HRRR data takes ~2h to become available after run time
      if (now.getTime() - runTime.getTime() < 2 * 3600000) continue;

      const date = fmtDate(runTime);
      // Check if fh24 .idx exists (proves this run completed)
      const idxUrl = `${HRRR_BUCKET}/hrrr.${date}/conus/hrrr.t${pad2(runHour)}z.wrfsfcf24.grib2.idx`;
      try {
        const res = await fetch(idxUrl, { method: "HEAD" });
        if (res.ok) {
          return { date, hour: runHour };
        }
      } catch {
        // Network error, try next
      }
    }
  }

  throw new Error("No available HRRR extended run found in the last 24 hours");
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log("HRRR Forecast Tile Generator");
  console.log("============================\n");

  // --- Step 1: Find latest HRRR extended run ---
  console.log("Step 1: Finding latest HRRR extended run...");
  const { date: runDate, hour: runHour } = await findLatestRun();
  const runId = `${runDate}${pad2(runHour)}`;
  console.log(`  Run: ${runId} (${runDate} ${pad2(runHour)}z)`);

  // --- Staleness check ---
  const manifestPath = join(TILES_DIR, runId, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (existing.run === runId) {
        console.log(`  Already generated tiles for run ${runId} — skipping.`);
        return;
      }
    } catch {
      // Corrupt manifest, regenerate
    }
  }

  // Clean and create work directories
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(TILES_DIR, { recursive: true });

  const baseUrl = `${HRRR_BUCKET}/hrrr.${runDate}/conus/hrrr.t${pad2(runHour)}z`;

  // --- Step 2: Download APCP at fh00 + each sample hour ---
  // We need APCP at boundaries to compute per-interval accumulation, plus
  // type flags at each sample hour for accumulation-weighted type compositing.
  const apcpFhs = [0, ...TYPE_SAMPLE_FHS]; // [0, 6, 12, 18, 24]
  console.log(`\nStep 2: Downloading APCP at fh${apcpFhs.join(", fh")}...`);

  const apcpGribs: Record<number, string> = {};
  await Promise.all(
    apcpFhs.map((fh) => {
      const dest = join(WORK_DIR, `apcp_fh${pad2(fh)}.grib2`);
      apcpGribs[fh] = dest;
      return downloadVar(
        `${baseUrl}.wrfsfcf${pad2(fh)}.grib2`,
        `${baseUrl}.wrfsfcf${pad2(fh)}.grib2.idx`,
        "APCP",
        "surface",
        "acc",
        dest,
      ).then(() => console.log(`  ✓ APCP fh${pad2(fh)}`));
    }),
  );

  // --- Step 3: Download precip type flags at each sample hour ---
  console.log(`\nStep 3: Downloading precip type flags at fh${TYPE_SAMPLE_FHS.join(", fh")}...`);

  const typeGribs: Record<number, { crain: string; csnow: string; cfrzr: string; cicep: string }> = {};
  const typeVars = ["CRAIN", "CSNOW", "CFRZR", "CICEP"] as const;
  const typeKeys = ["crain", "csnow", "cfrzr", "cicep"] as const;

  await Promise.all(
    TYPE_SAMPLE_FHS.flatMap((fh) => {
      const fhUrl = `${baseUrl}.wrfsfcf${pad2(fh)}.grib2`;
      const fhIdxUrl = `${fhUrl}.idx`;
      const paths = {
        crain: join(WORK_DIR, `crain_fh${pad2(fh)}.grib2`),
        csnow: join(WORK_DIR, `csnow_fh${pad2(fh)}.grib2`),
        cfrzr: join(WORK_DIR, `cfrzr_fh${pad2(fh)}.grib2`),
        cicep: join(WORK_DIR, `cicep_fh${pad2(fh)}.grib2`),
      };
      typeGribs[fh] = paths;
      return typeVars.map((v, vi) =>
        downloadVar(fhUrl, fhIdxUrl, v, "surface", "", paths[typeKeys[vi]]).then(() =>
          console.log(`  ✓ ${v} fh${pad2(fh)}`),
        ),
      );
    }),
  );

  // --- Step 4: Reproject everything to Web Mercator ---
  console.log("\nStep 4: Reprojecting to Web Mercator...");

  // Reproject APCP grids
  const apcp3857: Record<number, string> = {};
  for (const fh of apcpFhs) {
    const dest = join(WORK_DIR, `apcp${pad2(fh)}_3857.tif`);
    apcp3857[fh] = dest;
    run(
      `gdalwarp -t_srs EPSG:3857 -r bilinear -tr ${WARP_RES} ${WARP_RES} -of GTiff "${apcpGribs[fh]}" "${dest}"`,
      `APCP fh${pad2(fh)} → EPSG:3857`,
    );
    rmSync(apcpGribs[fh]);
  }

  // Reproject type flags
  const type3857: Record<number, { crain: string; csnow: string; cfrzr: string; cicep: string }> = {};
  for (const fh of TYPE_SAMPLE_FHS) {
    const paths = {
      crain: join(WORK_DIR, `crain${pad2(fh)}_3857.tif`),
      csnow: join(WORK_DIR, `csnow${pad2(fh)}_3857.tif`),
      cfrzr: join(WORK_DIR, `cfrzr${pad2(fh)}_3857.tif`),
      cicep: join(WORK_DIR, `cicep${pad2(fh)}_3857.tif`),
    };
    type3857[fh] = paths;
    for (const key of typeKeys) {
      run(
        `gdalwarp -t_srs EPSG:3857 -r near -tr ${WARP_RES} ${WARP_RES} -of GTiff "${typeGribs[fh][key]}" "${paths[key]}"`,
        `${key.toUpperCase()} fh${pad2(fh)} → EPSG:3857`,
      );
      rmSync(typeGribs[fh][key]);
    }
  }

  // --- Step 5: Compute 24h accumulation + per-interval accumulations ---
  console.log("\nStep 5: Computing accumulations...");

  const accum24 = join(WORK_DIR, "accum24.tif");
  run(
    `gdal_calc.py -A "${apcp3857[24]}" -B "${apcp3857[0]}" --outfile="${accum24}" --calc="A-B" --NoDataValue=-9999 --quiet`,
    "Total 24h accumulation",
  );

  // Per-interval accumulations: 0→6, 6→12, 12→18, 18→24
  const intervals = TYPE_SAMPLE_FHS.map((fh, i) => {
    const prevFh = i === 0 ? 0 : TYPE_SAMPLE_FHS[i - 1];
    const dest = join(WORK_DIR, `accum_${pad2(prevFh)}_${pad2(fh)}.tif`);
    run(
      `gdal_calc.py -A "${apcp3857[fh]}" -B "${apcp3857[prevFh]}" --outfile="${dest}" --calc="numpy.maximum(A-B,0)" --NoDataValue=-9999 --quiet`,
      `Interval accumulation fh${pad2(prevFh)}→fh${pad2(fh)}`,
    );
    return { fh, prevFh, accumPath: dest };
  });

  // Free all APCP rasters
  for (const fh of apcpFhs) rmSync(apcp3857[fh]);

  // --- Step 6: Check if there's meaningful precipitation ---
  console.log("\nStep 6: Checking precipitation...");

  const statsOutput = run(`gdalinfo -stats "${accum24}"`, "Getting raster stats");
  const maxMatch = statsOutput.match(/STATISTICS_MAXIMUM=([0-9.e+-]+)/);
  const maxPrecip = maxMatch ? parseFloat(maxMatch[1]) : 0;
  console.log(`  Max accumulation: ${maxPrecip.toFixed(2)} mm`);

  // Compute valid time range
  const runTime = new Date(
    Date.UTC(
      parseInt(runDate.slice(0, 4)),
      parseInt(runDate.slice(4, 6)) - 1,
      parseInt(runDate.slice(6, 8)),
      runHour,
    ),
  );
  const validStart = new Date(runTime.getTime() + FORECAST_HOURS.start * 3600000);
  const validEnd = new Date(runTime.getTime() + FORECAST_HOURS.end * 3600000);

  const outputDir = join(TILES_DIR, runId);
  mkdirSync(outputDir, { recursive: true });

  if (maxPrecip < 0.1) {
    console.log("  No significant precipitation — writing dry manifest.");
    const manifest = {
      run: runId,
      generatedAt: new Date().toISOString(),
      validStart: validStart.toISOString(),
      validEnd: validEnd.toISOString(),
      hasPrecip: false,
    };
    writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    rmSync(WORK_DIR, { recursive: true });
    console.log("\nDone — no tiles needed (dry forecast).");
    return;
  }

  // --- Step 7: Build accumulation-weighted composite type mask ---
  // For each grid cell, sum how much precip fell as rain vs snow vs ice
  // across all intervals. The type with the most accumulation wins.
  console.log("\nStep 7: Building composite type mask (accumulation-weighted)...");

  // Compute per-type weighted accumulation across all intervals:
  //   rainWeighted  = sum( interval_accum * CRAIN_flag  for each interval )
  //   snowWeighted  = sum( interval_accum * CSNOW_flag  for each interval )
  //   iceWeighted   = sum( interval_accum * (CFRZR|CICEP) for each interval )
  const rainWeighted = join(WORK_DIR, "rain_weighted.tif");
  const snowWeighted = join(WORK_DIR, "snow_weighted.tif");
  const iceWeighted = join(WORK_DIR, "ice_weighted.tif");

  // Start with zeros — gdal_calc doesn't have an accumulator, so we build
  // incrementally: compute each interval's contribution, then sum them.
  const rainParts: string[] = [];
  const snowParts: string[] = [];
  const iceParts: string[] = [];

  for (const { fh, accumPath } of intervals) {
    const t = type3857[fh];
    const rp = join(WORK_DIR, `rain_part_fh${pad2(fh)}.tif`);
    const sp = join(WORK_DIR, `snow_part_fh${pad2(fh)}.tif`);
    const ip = join(WORK_DIR, `ice_part_fh${pad2(fh)}.tif`);

    run(
      `gdal_calc.py -A "${accumPath}" -B "${t.crain}" --outfile="${rp}" --calc="A*(B==1)" --NoDataValue=-9999 --quiet`,
      `Rain weight fh${pad2(fh)}`,
    );
    run(
      `gdal_calc.py -A "${accumPath}" -B "${t.csnow}" --outfile="${sp}" --calc="A*(B==1)" --NoDataValue=-9999 --quiet`,
      `Snow weight fh${pad2(fh)}`,
    );
    run(
      `gdal_calc.py -A "${accumPath}" -B "${t.cfrzr}" -C "${t.cicep}" --outfile="${ip}" --calc="A*((B==1)|(C==1))" --NoDataValue=-9999 --quiet`,
      `Ice weight fh${pad2(fh)}`,
    );

    rainParts.push(rp);
    snowParts.push(sp);
    iceParts.push(ip);
  }

  // Sum the parts: A+B+C+D for 4 intervals
  const sumCalc = "A+B+C+D";
  run(
    `gdal_calc.py -A "${rainParts[0]}" -B "${rainParts[1]}" -C "${rainParts[2]}" -D "${rainParts[3]}" --outfile="${rainWeighted}" --calc="${sumCalc}" --NoDataValue=-9999 --quiet`,
    "Sum rain-weighted accumulation",
  );
  run(
    `gdal_calc.py -A "${snowParts[0]}" -B "${snowParts[1]}" -C "${snowParts[2]}" -D "${snowParts[3]}" --outfile="${snowWeighted}" --calc="${sumCalc}" --NoDataValue=-9999 --quiet`,
    "Sum snow-weighted accumulation",
  );
  run(
    `gdal_calc.py -A "${iceParts[0]}" -B "${iceParts[1]}" -C "${iceParts[2]}" -D "${iceParts[3]}" --outfile="${iceWeighted}" --calc="${sumCalc}" --NoDataValue=-9999 --quiet`,
    "Sum ice-weighted accumulation",
  );

  // Clean up interval parts and type rasters
  for (const p of [...rainParts, ...snowParts, ...iceParts]) rmSync(p);
  for (const { accumPath } of intervals) rmSync(accumPath);
  for (const fh of TYPE_SAMPLE_FHS) {
    for (const key of typeKeys) rmSync(type3857[fh][key]);
  }

  // Now assign each grid cell's total accumulation to the dominant type:
  //   ice wins if iceWeighted >= snowWeighted AND iceWeighted >= rainWeighted
  //   snow wins if snowWeighted > iceWeighted AND snowWeighted >= rainWeighted
  //   rain gets everything else
  const rainTif = join(WORK_DIR, "rain.tif");
  const snowTif = join(WORK_DIR, "snow.tif");
  const iceTif = join(WORK_DIR, "ice.tif");

  run(
    `gdal_calc.py -A "${accum24}" -B "${iceWeighted}" -C "${snowWeighted}" -D "${rainWeighted}" --outfile="${iceTif}" --calc="A*((B>=C)&(B>=D)&(B>0))" --NoDataValue=0 --quiet`,
    "Ice mask (dominant by accumulation)",
  );
  run(
    `gdal_calc.py -A "${accum24}" -B "${snowWeighted}" -C "${iceWeighted}" -D "${rainWeighted}" --outfile="${snowTif}" --calc="A*((B>C)&(B>=D)&(B>0))" --NoDataValue=0 --quiet`,
    "Snow mask (dominant by accumulation)",
  );
  run(
    `gdal_calc.py -A "${accum24}" -B "${rainWeighted}" -C "${snowWeighted}" -D "${iceWeighted}" --outfile="${rainTif}" --calc="A*(((B>=C)&(B>=D))|((C==0)&(D==0)))" --NoDataValue=0 --quiet`,
    "Rain mask (dominant or default)",
  );

  // Free weighted rasters
  rmSync(accum24);
  rmSync(rainWeighted);
  rmSync(snowWeighted);
  rmSync(iceWeighted);

  // --- Step 8: Apply color ramps ---
  console.log("\nStep 8: Applying color ramps...");

  const rainRgba = join(WORK_DIR, "rain_rgba.tif");
  const snowRgba = join(WORK_DIR, "snow_rgba.tif");
  const iceRgba = join(WORK_DIR, "ice_rgba.tif");

  run(
    `gdaldem color-relief "${rainTif}" "${join(COLOR_RAMPS_DIR, "rain-accum.txt")}" "${rainRgba}" -alpha`,
    "Rain color ramp",
  );
  rmSync(rainTif);

  run(
    `gdaldem color-relief "${snowTif}" "${join(COLOR_RAMPS_DIR, "snow-accum.txt")}" "${snowRgba}" -alpha`,
    "Snow color ramp",
  );
  rmSync(snowTif);

  run(
    `gdaldem color-relief "${iceTif}" "${join(COLOR_RAMPS_DIR, "ice-accum.txt")}" "${iceRgba}" -alpha`,
    "Ice color ramp",
  );
  rmSync(iceTif);

  // --- Step 9: Merge layers and generate tiles ---
  console.log("\nStep 9: Merging layers and generating tiles...");

  const composite = join(WORK_DIR, "composite.tif");

  run(
    `gdal_merge.py -o "${composite}" "${rainRgba}" "${snowRgba}" "${iceRgba}" -co COMPRESS=LZW`,
    "Merging rain + snow + ice",
  );

  rmSync(rainRgba);
  rmSync(snowRgba);
  rmSync(iceRgba);

  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  run(
    `gdal2tiles.py --zoom=${ZOOM_LEVELS} --xyz --processes=${TILE_PROCESSES} "${composite}" "${outputDir}"`,
    `Generating tiles (zoom ${ZOOM_LEVELS}, ${TILE_PROCESSES} processes)`,
  );

  rmSync(composite);

  // --- Step 10: Smooth tiles with premultiplied-alpha blur ---
  console.log("\nStep 10: Smoothing tiles (premultiplied blur)...");

  const sharpMod = (await import("sharp")).default;
  let smoothed = 0;
  const MAX_ZOOM = 8;

  for (const zDir of readdirSync(outputDir)) {
    const zPath = join(outputDir, zDir);
    if (!statSync(zPath).isDirectory()) continue;
    if (zDir === "manifest.json") continue;

    const zoom = Number(zDir);
    if (isNaN(zoom)) continue;
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
          if (raw[i * 4 + 3] > 0) {
            hasContent = true;
            break;
          }
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

        // Blur all 4 channels
        const blurred = await sharpMod(premul, {
          raw: { width: w, height: h, channels: 4 },
        })
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
            result[i * 4 + 1] = Math.min(
              255,
              Math.round(blurred[i * 4 + 1] * inv),
            );
            result[i * 4 + 2] = Math.min(
              255,
              Math.round(blurred[i * 4 + 2] * inv),
            );
          }
        }

        await sharpMod(result, {
          raw: { width: w, height: h, channels: 4 },
        })
          .png()
          .toFile(tilePath);

        smoothed++;
      }
    }
  }
  console.log(`  ✓ Smoothed ${smoothed} tiles`);

  // --- Write manifest ---
  const manifest = {
    run: runId,
    generatedAt: new Date().toISOString(),
    validStart: validStart.toISOString(),
    validEnd: validEnd.toISOString(),
    hasPrecip: true,
  };
  writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // --- Done ---
  const totalTiles = countTiles(outputDir);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n============================`);
  console.log(`Done in ${elapsed}s — ${totalTiles} tiles → ${outputDir}`);

  rmSync(WORK_DIR, { recursive: true });
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err.message || err);
  process.exit(1);
});
