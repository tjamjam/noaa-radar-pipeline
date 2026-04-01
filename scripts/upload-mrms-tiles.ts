/**
 * Upload MRMS tiles to Cloudflare R2 and rotate old frames.
 *
 * Usage:
 *   npx tsx scripts/upload-mrms-tiles.ts                 # upload latest frame
 *   npx tsx scripts/upload-mrms-tiles.ts --all           # upload all local frames
 *   npx tsx scripts/upload-mrms-tiles.ts --keep 5        # keep 5 most recent frames (default)
 *
 * Requires .env with R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * and R2_RADAR_TILES_URL.
 */

import {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { config } from 'dotenv';
import { createR2Client, R2_BUCKETS, R2_PUBLIC_URLS } from '../lib/r2-client';

// Load env from repo root .env
config({ path: resolve(__dirname, '..', '.env') });

const BUCKET = R2_BUCKETS.radarTiles;
const TILES_ROOT = resolve(__dirname, 'output', 'mrms-tiles');

if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY in .env');
  process.exit(1);
}

const r2 = createR2Client();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** List local frame directories (sorted newest first). */
function listLocalFrames(): string[] {
  try {
    return readdirSync(TILES_ROOT)
      .filter((d) => /^\d{8}-\d{6}$/.test(d) && statSync(join(TILES_ROOT, d)).isDirectory())
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Recursively collect all .png tile paths relative to the frame directory. */
function collectTilePaths(frameDir: string): string[] {
  const paths: string[] = [];

  function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, relPath);
      } else if (entry.endsWith('.png')) {
        paths.push(relPath);
      }
    }
  }

  walk(frameDir, '');
  return paths;
}

/** Upload a single frame's tiles to R2. */
async function uploadFrame(timestamp: string): Promise<number> {
  const frameDir = join(TILES_ROOT, timestamp);
  const tilePaths = collectTilePaths(frameDir);
  console.log(`  Uploading ${tilePaths.length} tiles for ${timestamp}...`);

  let uploaded = 0;
  let failed = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < tilePaths.length; i += BATCH_SIZE) {
    const batch = tilePaths.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (relPath) => {
        const key = `${timestamp}/${relPath}`;
        const buffer = readFileSync(join(frameDir, relPath));

        try {
          await r2.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: buffer,
            ContentType: 'image/png',
            CacheControl: 'public, max-age=3600',
          }));
          return true;
        } catch (err) {
          console.warn(`    Failed: ${key} — ${err instanceof Error ? err.message : err}`);
          return false;
        }
      }),
    );

    uploaded += results.filter(Boolean).length;
    failed += results.filter((r) => !r).length;
  }

  console.log(`  Done: ${uploaded} uploaded, ${failed} failed`);
  return uploaded;
}

/** List remote frame "directories" in R2 (top-level prefixes). */
async function listRemoteFrames(): Promise<string[]> {
  try {
    const response = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Delimiter: '/',
      MaxKeys: 100,
    }));

    return (response.CommonPrefixes ?? [])
      .map((p) => p.Prefix?.replace(/\/$/, '') ?? '')
      .filter((name) => /^\d{8}-\d{6}$/.test(name))
      .sort()
      .reverse();
  } catch (err) {
    console.warn('  Could not list remote frames:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Delete all tiles for a given frame timestamp from R2. */
async function deleteFrame(timestamp: string): Promise<void> {
  const allKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${timestamp}/`,
      ContinuationToken: continuationToken,
    }));

    for (const obj of response.Contents ?? []) {
      if (obj.Key) allKeys.push(obj.Key);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (allKeys.length === 0) return;

  for (let i = 0; i < allKeys.length; i += 1000) {
    const batch = allKeys.slice(i, i + 1000);
    await r2.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: batch.map((Key) => ({ Key })) },
    }));
  }

  console.log(`  Deleted ${allKeys.length} tiles from ${timestamp}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const uploadAll = args.includes('--all');
  const keepIndex = args.indexOf('--keep');
  const maxKeep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 5;

  console.log('MRMS Tile Uploader → Cloudflare R2');
  console.log('====================================\n');

  const localFrames = listLocalFrames();
  if (localFrames.length === 0) {
    console.error('No local MRMS frames found. Run generate-mrms-tiles.ts first.');
    process.exit(1);
  }

  console.log(`Local frames: ${localFrames.join(', ')}`);

  const framesToUpload = uploadAll ? localFrames : [localFrames[0]];
  console.log(`\nUploading ${framesToUpload.length} frame(s)...\n`);

  let totalTiles = 0;
  for (const ts of framesToUpload) {
    totalTiles += await uploadFrame(ts);
  }

  console.log(`\nRotating old frames (keeping ${maxKeep} most recent)...`);
  const remoteFrames = await listRemoteFrames();
  console.log(`  Remote frames: ${remoteFrames.join(', ') || '(none)'}`);

  const toDelete = remoteFrames.slice(maxKeep);
  if (toDelete.length > 0) {
    for (const ts of toDelete) {
      await deleteFrame(ts);
    }
  } else {
    console.log('  Nothing to rotate.');
  }

  const baseUrl = R2_PUBLIC_URLS.radarTiles;
  console.log('\n====================================');
  console.log(`Uploaded ${totalTiles} tiles total.`);
  console.log('\nPublic tile URL template:');
  console.log(`  ${baseUrl}/{timestamp}/{z}/{x}/{y}.png`);
  console.log(`\nLatest frame: ${framesToUpload[0]}`);
  console.log(`  ${baseUrl}/${framesToUpload[0]}/{z}/{x}/{y}.png`);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
