import { S3Client } from '@aws-sdk/client-s3';

export function createR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export const R2_BUCKETS = {
  radarTiles: process.env.R2_RADAR_BUCKET ?? 'radar-tiles',
  forecastTiles: process.env.R2_FORECAST_BUCKET ?? 'forecast-tiles',
};

// Each bucket has its own custom domain on Cloudflare CDN.
export const R2_PUBLIC_URLS = {
  radarTiles: process.env.R2_RADAR_TILES_URL ?? '',
  forecastTiles: process.env.R2_FORECAST_TILES_URL ?? '',
} as const;
