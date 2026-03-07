import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "data");
const metadataPath = path.join(dataDir, "photos.ndjson");

const app = express();
const port = Number(process.env.PORT ?? 3000);
const defaultMaxFileSizeMb = process.env.NETLIFY ? 4 : 10;
const maxFileSizeBytes = Number(process.env.MAX_FILE_SIZE_MB ?? defaultMaxFileSizeMb) * 1024 * 1024;
const tokenTtlSeconds = Number(process.env.TOKEN_TTL_SECONDS ?? 86400 * 7);
const signedUrlSeconds = Number(process.env.SIGNED_URL_TTL_SECONDS ?? 60);
const photoViewUrlSeconds = Number(process.env.PHOTO_VIEW_URL_TTL_SECONDS ?? Math.max(signedUrlSeconds, 1800));
const publicBaseUrl = process.env.PUBLIC_ASSET_BASE_URL ?? "";
const isServerlessRuntime = Boolean(
  process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.AWS_EXECUTION_ENV
);
const defaultMetadataBackend = isServerlessRuntime ? "s3" : "file";
const metadataBackendRaw = String(process.env.METADATA_BACKEND ?? defaultMetadataBackend).toLowerCase();
const parsedMetadataBackend = ["file", "s3"].includes(metadataBackendRaw)
  ? metadataBackendRaw
  : defaultMetadataBackend;
const metadataBackend =
  isServerlessRuntime && parsedMetadataBackend === "file" ? "s3" : parsedMetadataBackend;
const metadataPrefix = String(process.env.METADATA_PREFIX ?? "_meta").replace(/^\/+|\/+$/g, "");
const rawUploadParser = express.raw({ type: () => true, limit: maxFileSizeBytes });

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
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.static(path.join(rootDir, "public")));

function missingEnvVars(keys) {
  return keys.filter((key) => !process.env[key]);
}

function requireEnvVars(res, keys) {
  const missing = missingEnvVars(keys);
  if (missing.length === 0) return true;

  res.status(503).json({
    error: `Server misconfigured. Missing environment variable(s): ${missing.join(", ")}`
  });
  return false;
}

const S3_REQUIRED_ENV = [
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_REGION"
];

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hmac(input) {
  return crypto.createHmac("sha256", process.env.TOKEN_SECRET).update(input).digest("base64url");
}

function createToken(userId, uploaderName = "") {
  const payload = {
    sub: userId,
    nm: typeof uploaderName === "string" ? uploaderName : "",
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
  if (payload.nm !== undefined && typeof payload.nm !== "string") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function auth(req, res, next) {
  if (!requireEnvVars(res, ["TOKEN_SECRET"])) {
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const normalizedSessionName = normalizeName(payload.nm || "");
  if (!normalizedSessionName) {
    res.status(401).json({ error: "Session missing name. Please log in again." });
    return;
  }

  req.user = { id: payload.sub, name: normalizedSessionName };
  next();
}

function randomId() {
  return crypto.randomUUID();
}

function normalizeContentType(contentType) {
  if (typeof contentType !== "string") return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

function coercePositiveNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 60);
}

function normalizeAlbum(value) {
  if (typeof value !== "string") return "general";
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 50);
  return normalized || "general";
}

function slugFromName(value) {
  const slug = normalizeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "photo";
}

function slugFromAlbum(value) {
  const slug = normalizeAlbum(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return slug || "general";
}

function parseBooleanFlag(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off", ""].includes(normalized)) return false;
  }
  return defaultValue;
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

function buildObjectKey(userId, extension, uploaderName = "", album = "general") {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const shortId = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const nameSlug = slugFromName(uploaderName);
  const albumSlug = slugFromAlbum(album);
  return `${userId}/${day}/${albumSlug}/${nameSlug}-${shortId}.${extension}`;
}

function buildPublicUrl(key) {
  return publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/${key}` : null;
}

async function buildSignedViewUrl(key) {
  if (typeof key !== "string" || key.length === 0) return null;
  if (missingEnvVars(S3_REQUIRED_ENV).length > 0) return null;

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key
    });
    return await getSignedUrl(s3, command, { expiresIn: photoViewUrlSeconds });
  } catch (error) {
    console.error("Could not create signed view URL:", error);
    return null;
  }
}

function metadataIndexKey(userId) {
  return `${metadataPrefix}/${userId}/index.json`;
}

function buildPhotoEntry({
  userId,
  key,
  contentType,
  sizeBytes,
  width,
  height,
  capturedAt,
  publicUrl,
  album,
  isPublic,
  uploaderName
}) {
  const normalizedAlbum = normalizeAlbum(album);
  const isPublicPhoto = parseBooleanFlag(isPublic, false);
  return {
    id: randomId(),
    userId,
    key,
    contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null,
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
    capturedAt: typeof capturedAt === "string" ? capturedAt : new Date().toISOString(),
    publicUrl: isPublicPhoto && typeof publicUrl === "string" ? publicUrl : null,
    album: normalizedAlbum,
    isPublic: isPublicPhoto,
    uploaderName: normalizeName(uploaderName),
    createdAt: new Date().toISOString()
  };
}

function normalizeStoredPhotoEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    ...entry,
    album: normalizeAlbum(entry.album),
    isPublic: parseBooleanFlag(entry.isPublic, false),
    uploaderName: normalizeName(entry.uploaderName)
  };
}

function extractPasscode(req) {
  const headerPasscode = req.headers["x-passcode"];
  if (typeof headerPasscode === "string" && headerPasscode.length > 0) {
    return headerPasscode;
  }
  if (Array.isArray(headerPasscode) && typeof headerPasscode[0] === "string" && headerPasscode[0].length > 0) {
    return headerPasscode[0];
  }

  if (typeof req.body?.passcode === "string") {
    return req.body.passcode;
  }

  if (typeof req.body === "string") {
    const textBody = req.body;
    if (!textBody) return "";

    try {
      const parsed = JSON.parse(textBody);
      if (typeof parsed?.passcode === "string") return parsed.passcode;
    } catch {
      // If not JSON, treat the raw text body as the passcode.
    }

    return textBody;
  }

  return "";
}

function extractUploaderName(req) {
  const headerName = req.headers["x-uploader-name"];
  if (typeof headerName === "string" && headerName.length > 0) {
    return normalizeName(headerName);
  }
  if (Array.isArray(headerName) && typeof headerName[0] === "string" && headerName[0].length > 0) {
    return normalizeName(headerName[0]);
  }
  if (typeof req.body?.name === "string") {
    return normalizeName(req.body.name);
  }
  return "";
}

function extractAlbum(req) {
  const headerAlbum = req.headers["x-album"];
  if (typeof headerAlbum === "string" && headerAlbum.length > 0) {
    return normalizeAlbum(headerAlbum);
  }
  if (Array.isArray(headerAlbum) && typeof headerAlbum[0] === "string" && headerAlbum[0].length > 0) {
    return normalizeAlbum(headerAlbum[0]);
  }
  if (typeof req.body?.album === "string") {
    return normalizeAlbum(req.body.album);
  }
  return "general";
}

function extractIsPublic(req, defaultValue = false) {
  const headerIsPublic = req.headers["x-is-public"];
  if (typeof headerIsPublic === "string") {
    return parseBooleanFlag(headerIsPublic, defaultValue);
  }
  if (Array.isArray(headerIsPublic) && typeof headerIsPublic[0] === "string") {
    return parseBooleanFlag(headerIsPublic[0], defaultValue);
  }
  if (req.body && Object.hasOwn(req.body, "isPublic")) {
    return parseBooleanFlag(req.body.isPublic, defaultValue);
  }
  return defaultValue;
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

function canUseS3Metadata() {
  return missingEnvVars(S3_REQUIRED_ENV).length === 0;
}

async function appendPhotoMetadata(entry) {
  if (metadataBackend === "s3") {
    await appendMetadataToS3(entry);
    return { stored: true, backend: "s3" };
  }

  try {
    await appendMetadataToFile(entry);
    return { stored: true, backend: "file" };
  } catch (error) {
    if (["EROFS", "EACCES", "EPERM"].includes(error?.code) && canUseS3Metadata()) {
      await appendMetadataToS3(entry);
      return { stored: true, backend: "s3-fallback" };
    }
    throw error;
  }
}

async function readMetadataForUser(userId) {
  if (metadataBackend === "s3") {
    return readMetadataFromS3(userId);
  }

  const all = await readAllMetadataFromFile();
  return all.filter((item) => item.userId === userId);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    metadataBackend,
    metadataBackendRequested: metadataBackendRaw,
    metadataBackendForcedToS3: isServerlessRuntime && parsedMetadataBackend === "file",
    isServerlessRuntime,
    port,
    missingAuthConfig: missingEnvVars(["APP_PASSCODE", "TOKEN_SECRET"]),
    missingS3Config: missingEnvVars(S3_REQUIRED_ENV)
  });
});

app.post("/api/login", (req, res) => {
  if (!requireEnvVars(res, ["APP_PASSCODE", "TOKEN_SECRET"])) {
    return;
  }

  const uploaderName = extractUploaderName(req);
  if (!uploaderName) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  const passcode = extractPasscode(req);
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

  const token = createToken("owner", uploaderName);
  res.json({
    token,
    expiresInSeconds: tokenTtlSeconds,
    name: uploaderName
  });
});

app.get("/api/login", (_req, res) => {
  res.status(405).json({ error: "Use POST /api/login with name and passcode in the request body." });
});

app.post("/api/upload-url", auth, async (req, res, next) => {
  try {
    if (!requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    const { contentType, fileSize } = req.body ?? {};
    const headerContentType = req.headers["x-content-type"];
    const headerFileSize = req.headers["x-file-size"];

    const normalizedContentType = normalizeContentType(
      typeof contentType === "string" && contentType.length > 0 ? contentType : headerContentType
    );
    const effectiveFileSize = coercePositiveNumber(
      typeof fileSize === "number" ? fileSize : Array.isArray(headerFileSize) ? headerFileSize[0] : headerFileSize
    );

    if (!normalizedContentType) {
      res.status(400).json({ error: "contentType is required." });
      return;
    }

    if (!effectiveFileSize) {
      res.status(400).json({ error: "fileSize must be a positive number." });
      return;
    }

    if (effectiveFileSize > maxFileSizeBytes) {
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

    const album = extractAlbum(req);
    const isPublicPhoto = extractIsPublic(req, false);
    const key = buildObjectKey(req.user.id, extension, req.user.name, album);
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: normalizedContentType
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: signedUrlSeconds });
    const publicUrl = isPublicPhoto ? buildPublicUrl(key) : null;

    res.json({
      key,
      uploadUrl,
      expiresInSeconds: signedUrlSeconds,
      publicUrl,
      album,
      isPublic: isPublicPhoto
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/upload", auth, rawUploadParser, async (req, res, next) => {
  try {
    if (!requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

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

    const album = extractAlbum(req);
    const isPublicPhoto = extractIsPublic(req, false);
    const key = buildObjectKey(req.user.id, extension, req.user.name, album);
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: req.body,
        ContentType: contentType
      })
    );

    const widthHeader = coercePositiveNumber(req.headers["x-image-width"]);
    const heightHeader = coercePositiveNumber(req.headers["x-image-height"]);
    const capturedAtHeader = req.headers["x-captured-at"];

    const entry = buildPhotoEntry({
      userId: req.user.id,
      key,
      contentType,
      sizeBytes: req.body.length,
      width: widthHeader ? Math.round(widthHeader) : null,
      height: heightHeader ? Math.round(heightHeader) : null,
      capturedAt: typeof capturedAtHeader === "string" ? capturedAtHeader : new Date().toISOString(),
      publicUrl: buildPublicUrl(key),
      album,
      isPublic: isPublicPhoto,
      uploaderName: req.user.name
    });

    let metadataStored = true;
    let metadataStoreBackend = metadataBackend;
    try {
      const metadataResult = await appendPhotoMetadata(entry);
      metadataStoreBackend = metadataResult?.backend ?? metadataStoreBackend;
    } catch (metadataError) {
      metadataStored = false;
      console.error("Metadata write failed after successful object upload:", metadataError);
    }

    res.status(201).json({
      ...entry,
      viewUrl: entry.publicUrl || (await buildSignedViewUrl(entry.key)),
      metadataStored,
      metadataStoreBackend
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/photos", auth, async (req, res, next) => {
  try {
    if (metadataBackend === "s3" && !requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    const { key, contentType, sizeBytes, width, height, capturedAt, publicUrl } = req.body ?? {};
    const album = extractAlbum(req);
    const isPublicPhoto = extractIsPublic(req, false);
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
      publicUrl: typeof publicUrl === "string" && publicUrl.length > 0 ? publicUrl : buildPublicUrl(key),
      album,
      isPublic: isPublicPhoto,
      uploaderName: req.user.name
    });

    let metadataStored = true;
    let metadataStoreBackend = metadataBackend;
    try {
      const metadataResult = await appendPhotoMetadata(entry);
      metadataStoreBackend = metadataResult?.backend ?? metadataStoreBackend;
    } catch (metadataError) {
      metadataStored = false;
      console.error("Metadata write failed on /api/photos:", metadataError);
    }

    res.status(201).json({
      ...entry,
      viewUrl: entry.publicUrl || (await buildSignedViewUrl(entry.key)),
      metadataStored,
      metadataStoreBackend
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/photos", auth, async (req, res, next) => {
  try {
    if (metadataBackend === "s3" && !requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    const albumQuery = typeof req.query?.album === "string" ? req.query.album : "";
    const normalizedAlbumFilter = albumQuery.trim().length > 0 ? normalizeAlbum(albumQuery) : "";
    const publicOnly = parseBooleanFlag(req.query?.publicOnly, false);
    const limitRequested = Number(req.query?.limit);
    const limit =
      Number.isFinite(limitRequested) && limitRequested > 0
        ? Math.min(Math.floor(limitRequested), 250)
        : 100;

    const allPhotos = (await readMetadataForUser(req.user.id))
      .map(normalizeStoredPhotoEntry)
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = Date.parse(a?.createdAt ?? "") || 0;
        const bTime = Date.parse(b?.createdAt ?? "") || 0;
        return bTime - aTime;
      });

    const albums = Array.from(new Set(allPhotos.map((item) => item.album).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );

    const photos = allPhotos
      .filter((item) => {
        if (normalizedAlbumFilter && item.album !== normalizedAlbumFilter) return false;
        if (publicOnly && !item.isPublic) return false;
        return true;
      })
      .slice(0, limit);

    const photosWithViewUrls = await Promise.all(
      photos.map(async (item) => ({
        ...item,
        viewUrl: item.publicUrl || (await buildSignedViewUrl(item.key))
      }))
    );

    res.json({
      photos: photosWithViewUrls,
      albums,
      filters: {
        album: normalizedAlbumFilter || null,
        publicOnly
      }
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

export default app;
