import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const metadataPath = path.join(dataDir, "photos.ndjson");

const requiredEnvVars = [
  "APP_PASSCODE",
  "TOKEN_SECRET",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_REGION"
];

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const app = express();
const port = Number(process.env.PORT ?? 3000);
const defaultMaxFileSizeMb = process.env.NETLIFY ? 4 : 10;
const maxFileSizeBytes = Number(process.env.MAX_FILE_SIZE_MB ?? defaultMaxFileSizeMb) * 1024 * 1024;
const tokenTtlSeconds = Number(process.env.TOKEN_TTL_SECONDS ?? 86400 * 7);
const signedUrlSeconds = Number(process.env.SIGNED_URL_TTL_SECONDS ?? 60);
const publicBaseUrl = process.env.PUBLIC_ASSET_BASE_URL ?? "";
const metadataBackend = String(process.env.METADATA_BACKEND ?? (process.env.NETLIFY ? "s3" : "file")).toLowerCase();
const metadataPrefix = String(process.env.METADATA_PREFIX ?? "_meta").replace(/^\/+|\/+$/g, "");
const rawUploadParser = express.raw({ type: () => true, limit: maxFileSizeBytes });

if (!["file", "s3"].includes(metadataBackend)) {
  throw new Error("Invalid METADATA_BACKEND. Use 'file' or 's3'.");
}

const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE ?? "false").toLowerCase() === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(rootDir, "public")));

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hmac(input) {
  return crypto.createHmac("sha256", process.env.TOKEN_SECRET).update(input).digest("base64url");
}

function createToken(userId) {
  const payload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + tokenTtlSeconds
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = hmac(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  const expectedSignature = hmac(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || typeof payload.sub !== "string") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function auth(req, res, next) {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.user = { id: payload.sub };
  next();
}

function randomId() {
  return crypto.randomUUID();
}

function normalizeContentType(contentType) {
  if (typeof contentType !== "string") return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

function extensionFromType(contentType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif"
  };
  return map[contentType] ?? null;
}

function buildObjectKey(userId, extension) {
  const day = new Date().toISOString().slice(0, 10);
  return `${userId}/${day}/${Date.now()}-${randomId()}.${extension}`;
}

function buildPublicUrl(key) {
  return publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/${key}` : null;
}

function metadataIndexKey(userId) {
  return `${metadataPrefix}/${userId}/index.json`;
}

function buildPhotoEntry({ userId, key, contentType, sizeBytes, width, height, capturedAt, publicUrl }) {
  return {
    id: randomId(),
    userId,
    key,
    contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null,
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
    capturedAt: typeof capturedAt === "string" ? capturedAt : new Date().toISOString(),
    publicUrl: typeof publicUrl === "string" ? publicUrl : null,
    createdAt: new Date().toISOString()
  };
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function appendMetadataToFile(entry) {
  await ensureDataDir();
  await fs.appendFile(metadataPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readAllMetadataFromFile() {
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readMetadataFromS3(userId) {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: metadataIndexKey(userId)
      })
    );

    const body = await response.Body?.transformToString?.();
    if (!body) return [];

    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      return [];
    }
    throw error;
  }
}

async function appendMetadataToS3(entry) {
  const current = await readMetadataFromS3(entry.userId);
  const next = [entry, ...current].slice(0, 500);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: metadataIndexKey(entry.userId),
      Body: JSON.stringify(next),
      ContentType: "application/json"
    })
  );
}

async function appendPhotoMetadata(entry) {
  if (metadataBackend === "s3") {
    await appendMetadataToS3(entry);
    return;
  }
  await appendMetadataToFile(entry);
}

async function readMetadataForUser(userId) {
  if (metadataBackend === "s3") {
    return readMetadataFromS3(userId);
  }

  const all = await readAllMetadataFromFile();
  return all.filter((item) => item.userId === userId);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, metadataBackend, port });
});

app.post("/api/login", (req, res) => {
  const { passcode } = req.body ?? {};
  if (typeof passcode !== "string" || passcode.length === 0) {
    res.status(400).json({ error: "Passcode is required." });
    return;
  }

  const provided = Buffer.from(passcode);
  const expected = Buffer.from(process.env.APP_PASSCODE);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: "Invalid passcode." });
    return;
  }

  const token = createToken("owner");
  res.json({
    token,
    expiresInSeconds: tokenTtlSeconds
  });
});

app.post("/api/upload-url", auth, async (req, res, next) => {
  try {
    const { contentType, fileSize } = req.body ?? {};
    const normalizedContentType = normalizeContentType(contentType);

    if (!normalizedContentType) {
      res.status(400).json({ error: "contentType is required." });
      return;
    }

    if (typeof fileSize !== "number" || fileSize <= 0) {
      res.status(400).json({ error: "fileSize must be a positive number." });
      return;
    }

    if (fileSize > maxFileSizeBytes) {
      res.status(413).json({
        error: `File is too large. Max size is ${Math.round(maxFileSizeBytes / (1024 * 1024))} MB.`
      });
      return;
    }

    const extension = extensionFromType(normalizedContentType);
    if (!extension) {
      res.status(400).json({
        error: "Unsupported contentType. Use JPEG, PNG, WEBP, HEIC, or HEIF."
      });
      return;
    }

    const key = buildObjectKey(req.user.id, extension);
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: normalizedContentType
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: signedUrlSeconds });
    const publicUrl = buildPublicUrl(key);

    res.json({
      key,
      uploadUrl,
      expiresInSeconds: signedUrlSeconds,
      publicUrl
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/upload", auth, rawUploadParser, async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Image body is required." });
      return;
    }

    if (req.body.length > maxFileSizeBytes) {
      res.status(413).json({
        error: `File is too large. Max size is ${Math.round(maxFileSizeBytes / (1024 * 1024))} MB.`
      });
      return;
    }

    const contentType = normalizeContentType(req.headers["content-type"]);
    const extension = extensionFromType(contentType);
    if (!extension) {
      res.status(400).json({
        error: "Unsupported contentType. Use JPEG, PNG, WEBP, HEIC, or HEIF."
      });
      return;
    }

    const key = buildObjectKey(req.user.id, extension);
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: req.body,
        ContentType: contentType
      })
    );

    const widthHeader = Number(req.headers["x-image-width"]);
    const heightHeader = Number(req.headers["x-image-height"]);
    const capturedAtHeader = req.headers["x-captured-at"];

    const entry = buildPhotoEntry({
      userId: req.user.id,
      key,
      contentType,
      sizeBytes: req.body.length,
      width: Number.isFinite(widthHeader) ? widthHeader : null,
      height: Number.isFinite(heightHeader) ? heightHeader : null,
      capturedAt: typeof capturedAtHeader === "string" ? capturedAtHeader : new Date().toISOString(),
      publicUrl: buildPublicUrl(key)
    });

    await appendPhotoMetadata(entry);
    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
});

app.post("/api/photos", auth, async (req, res, next) => {
  try {
    const { key, contentType, sizeBytes, width, height, capturedAt, publicUrl } = req.body ?? {};
    if (typeof key !== "string" || key.length === 0) {
      res.status(400).json({ error: "key is required." });
      return;
    }

    const entry = buildPhotoEntry({
      userId: req.user.id,
      key,
      contentType,
      sizeBytes,
      width,
      height,
      capturedAt,
      publicUrl
    });

    await appendPhotoMetadata(entry);
    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
});

app.get("/api/photos", auth, async (req, res, next) => {
  try {
    const photos = (await readMetadataForUser(req.user.id))
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = Date.parse(a?.createdAt ?? "") || 0;
        const bTime = Date.parse(b?.createdAt ?? "") || 0;
        return bTime - aTime;
      })
      .slice(0, 100);

    res.json({ photos });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

export default app;
