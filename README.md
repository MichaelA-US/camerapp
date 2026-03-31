# Online Camera App

Tiny web app for iPhone Safari:

- stays behind one shared password
- takes photos and records videos in-browser
- uploads directly to cloud storage through a signed URL
- stores media metadata on your server
- avoids building up local media storage on the phone

## 1) Install and run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## 2) Configure storage

This app uses S3-compatible uploads. Both Cloudflare R2 and Backblaze B2 work.

### Cloudflare R2

1. Create an R2 bucket.
2. Create an API token with object read/write to that bucket.
3. In R2 dashboard, copy the S3 API endpoint:
   - `https://<accountid>.r2.cloudflarestorage.com`
4. Set:
   - `S3_BUCKET=<bucket-name>`
   - `S3_ACCESS_KEY_ID=<access-key-id>`
   - `S3_SECRET_ACCESS_KEY=<secret>`
   - `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
   - `S3_REGION=auto`
   - `S3_FORCE_PATH_STYLE=false`

Optional public links:

- make bucket public or serve via custom domain
- set `PUBLIC_ASSET_BASE_URL=https://<public-base-url>`

### Backblaze B2 (S3-Compatible)

1. Create a bucket and application key with read/write.
2. Find your S3 endpoint:
   - `https://s3.<region>.backblazeb2.com`
3. Set:
   - `S3_BUCKET=<bucket-name>`
   - `S3_ACCESS_KEY_ID=<key-id>`
   - `S3_SECRET_ACCESS_KEY=<application-key>`
   - `S3_ENDPOINT=https://s3.<region>.backblazeb2.com`
   - `S3_REGION=<region>` (example: `us-west-004`)
   - `S3_FORCE_PATH_STYLE=true`

Optional public links:

- make the bucket/file public in B2
- set `PUBLIC_ASSET_BASE_URL=https://f000.backblazeb2.com/file/<bucket-name>`

### Configure bucket CORS (required for browser uploads)

Your app domain must be allowed to send `PUT` requests to the bucket endpoint.

Recommended CORS policy:

- Allowed origin: your app URL (example: `https://camera.yourdomain.com`)
- Allowed methods: `PUT,GET,HEAD`
- Allowed headers: `Content-Type`
- Expose headers: `ETag`
- Max age: `3600`

## 3) App settings

In `.env`:

- `APP_PASSWORD`: shared password required before anyone can open the camera or gallery
- `APP_PASSCODE`: legacy alias for `APP_PASSWORD`; if both are set, `APP_PASSWORD` wins
- `MAX_FILE_SIZE_MB`: max photo or video upload size
- `PUBLIC_ASSET_BASE_URL`: optional public base URL for direct image links
- `METADATA_BACKEND`: set to `s3` on serverless hosts such as Netlify

## 4) Deploy on Netlify (safe setup)

This repo includes:

- `netlify.toml` for API routing and security headers
- `netlify/functions/api.js` to run Express as a Netlify Function

### Netlify steps

1. Push this repo to GitHub.
2. In Netlify, **Add new site** -> **Import from Git**.
3. Leave build settings from `netlify.toml` (publish `public`).
4. In Netlify site settings -> **Environment variables**, add:
   - `APP_PASSWORD=<your-shared-password>`
   - `S3_BUCKET`
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
   - `S3_ENDPOINT`
   - `S3_REGION=auto`
   - `S3_FORCE_PATH_STYLE=false`
   - `METADATA_BACKEND=s3`
   - `MAX_FILE_SIZE_MB=150`
5. Deploy.

Use `APP_PASSWORD` on Netlify. `APP_PASSCODE` still works as a legacy alias, but only when `APP_PASSWORD` is absent.

Why `METADATA_BACKEND=s3`: Netlify Functions do not provide persistent local disk, so photo metadata is stored in object storage (`_meta/<contributor>/index.json` plus the contributor directory).

Why `MAX_FILE_SIZE_MB=150`: larger videos should still go straight to object storage through signed URLs, while the backend relay remains a fallback for smaller uploads.

### Security checklist

- Rotate any secrets already pasted in chat/history before production use.
- Keep all credentials only in Netlify environment variables (not committed files).
- Use a custom domain with HTTPS.
- Keep preview deploys non-public if they contain production credentials.
- Keep R2 bucket CORS restricted to your Netlify domain.
- If Netlify secrets scanning flags non-secret values (`PORT`, `S3_REGION=auto`, `METADATA_BACKEND=s3`), keep `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml` and continue scanning real secrets.

### Local Netlify test

```bash
npm install
npm run netlify:dev
```

This runs static frontend + function routes together.

### Troubleshooting Netlify 502/500

- Open `/api/health` after deploy.
- Check `authEnabled`, `authConfigSource`, `contributorsCount`, and `missingS3Config` in the JSON response.
- If both `APP_PASSWORD` and `APP_PASSCODE` exist in Netlify, the app uses `APP_PASSWORD`.
- In Netlify UI, ensure variables are set for the **same context** (Production/Preview) you are testing.
- Trigger a fresh deploy after changing auth env vars so the function and static site are on the same release.
- Check Netlify Function logs for `/api/upload` or `/api/photos` errors.
- `/.netlify/functions/api/health` now works too, but `/api/health` is the public route you should use from the site.

## 5) Deploy elsewhere

You can also run this as a normal Node app:

- Render
- Fly.io
- Railway
- DigitalOcean App Platform
- VPS (Docker + Caddy/Nginx)

Docker option:

```bash
docker build -t online-camera-app .
docker run --env-file .env -p 3000:3000 online-camera-app
```

## 6) Use on iPhone

1. Open your deployed HTTPS URL in Safari.
2. Enter the shared password to unlock the app.
3. Allow camera permission.
4. Optional: add your name so uploads are labeled.
5. Tap **Take Photo** or **Record Video** to upload.
6. Optional: Safari Share menu -> **Add to Home Screen**.

## API endpoints

- `GET /api/session`
- `POST /api/unlock`
- `POST /api/upload-url`
- `POST /api/upload`
- `POST /api/photos`
- `GET /api/photos`
- `GET /api/health`

## Notes

- The app captures photos and can record videos from the camera preview, then uploads them to object storage.
- The camera and gallery stay behind one shared password. Successful unlocks use an `httpOnly` cookie instead of local storage.
- If browser-to-R2 CORS blocks direct upload, the app automatically retries through your backend (`/api/upload`) and still stores to R2.
- Uploaded image bytes are not written to server disk.
- Metadata is stored in local file (`data/photos.ndjson`) by default, or in object storage when `METADATA_BACKEND=s3`.
