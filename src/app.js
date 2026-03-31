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
const usersPath = path.join(dataDir, "users.json");

const app = express();
const port = Number(process.env.PORT ?? 3000);
const defaultMaxFileSizeMb = process.env.NETLIFY ? 150 : 250;
const maxFileSizeBytes = Number(process.env.MAX_FILE_SIZE_MB ?? defaultMaxFileSizeMb) * 1024 * 1024;
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
const authCookieName = "cameraapp_unlock";
const authSessionHours = Math.max(1, Math.floor(Number(process.env.AUTH_SESSION_HOURS ?? 12) || 12));
const authSessionSeconds = authSessionHours * 60 * 60;
const sharedPassword = envString("APP_PASSWORD", "APP_PASSCODE");
const authCookieSecret =
  envString("AUTH_COOKIE_SECRET", "TOKEN_SECRET") ||
  sharedPassword ||
  crypto.randomBytes(32).toString("hex");
const sharedPasswordHash = sharedPassword
  ? crypto.createHash("sha256").update(sharedPassword).digest()
  : null;
const passwordFingerprint = sharedPasswordHash ? sharedPasswordHash.toString("hex").slice(0, 24) : "";

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@+\- ]{0,39}$/;
const DEFAULT_UPLOADER_NAME = "camera";

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

const S3_REQUIRED_ENV = [
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_REGION"
];

function envString(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

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

function canUseS3() {
  return missingEnvVars(S3_REQUIRED_ENV).length === 0;
}

function hasConfiguredPassword() {
  return Boolean(sharedPasswordHash && sharedPassword);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function passwordMatches(candidate) {
  if (!sharedPasswordHash || typeof candidate !== "string") return false;
  const candidateHash = crypto.createHash("sha256").update(candidate).digest();
  return constantTimeEqual(candidateHash, sharedPasswordHash);
}

function parseCookies(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.trim().length === 0) {
    return {};
  }

  return cookieHeader.split(/;\s*/).reduce((cookies, pair) => {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) return cookies;

    const name = pair.slice(0, separatorIndex).trim();
    const rawValue = pair.slice(separatorIndex + 1).trim();
    if (!name) return cookies;

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }

    return cookies;
  }, {});
}

function isSecureRequest(req) {
  if (req.secure) return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string" && forwardedProto.trim().length > 0) {
    return forwardedProto.split(",")[0].trim() === "https";
  }

  if (Array.isArray(forwardedProto) && typeof forwardedProto[0] === "string") {
    return forwardedProto[0].trim() === "https";
  }

  return Boolean(process.env.NETLIFY);
}

function serializeCookie(name, value, req, maxAgeSeconds = authSessionSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearAuthCookie(req, res) {
  res.setHeader("Set-Cookie", serializeCookie(authCookieName, "", req, 0));
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

function signAuthPayload(payload) {
  return crypto.createHmac("sha256", authCookieSecret).update(payload).digest("base64url");
}

function createAuthToken() {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + authSessionSeconds * 1000,
      fp: passwordFingerprint
    })
  ).toString("base64url");

  return `${payload}.${signAuthPayload(payload)}`;
}

function isValidAuthToken(token) {
  if (typeof token !== "string" || token.trim().length === 0) return false;

  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) return false;

  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = signAuthPayload(payload);

  if (!constantTimeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (
      Number.isFinite(decoded?.exp) &&
      decoded.exp > Date.now() &&
      decoded.fp === passwordFingerprint
    );
  } catch {
    return false;
  }
}

function isAuthenticatedRequest(req) {
  if (!hasConfiguredPassword()) return false;
  const cookies = parseCookies(req.headers.cookie);
  return isValidAuthToken(cookies[authCookieName]);
}

function requireConfiguredPassword(res) {
  if (hasConfiguredPassword()) return true;

  res.status(503).json({
    error: "Server misconfigured. APP_PASSWORD is not set."
  });
  return false;
}

function requireAuthenticatedApp(req, res, next) {
  if (!requireConfiguredPassword(res)) {
    return;
  }

  if (isAuthenticatedRequest(req)) {
    next();
    return;
  }

  setNoStore(res);
  clearAuthCookie(req, res);
  res.status(401).json({ error: "Unlock required." });
}

function randomId(prefix = "") {
  const raw = crypto.randomUUID().replace(/-/g, "");
  return prefix ? `${prefix}${raw.slice(0, 20)}` : raw;
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

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
}

function isValidUsername(username) {
  return USERNAME_PATTERN.test(username);
}

function normalizeAlbum(value) {
  if (typeof value !== "string") return "general";
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 50);
  return normalized || "general";
}

function slugFromUsername(value) {
  const slug = normalizeUsername(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || DEFAULT_UPLOADER_NAME;
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
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-m4v": "m4v"
  };
  return map[contentType] ?? null;
}

function mediaTypeFromContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  if (normalized.startsWith("video/")) return "video";
  return "image";
}

function metadataIndexKey(userId) {
  return `${metadataPrefix}/${userId}/index.json`;
}

function usersIndexKey() {
  return `${metadataPrefix}/_admin/users.json`;
}

function contributorIdForUsername(username) {
  const normalized = normalizeUsername(username) || DEFAULT_UPLOADER_NAME;
  const digest = crypto
    .createHash("sha256")
    .update(`online-camera-app:${normalized}`)
    .digest("hex")
    .slice(0, 20);
  return `user_${digest}`;
}

function buildObjectKey(userId, username, extension, album = "general") {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const shortId = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const userSlug = slugFromUsername(username);
  const albumSlug = slugFromAlbum(album);
  return `${userId}/${day}/${albumSlug}/${userSlug}-${shortId}.${extension}`;
}

function buildPublicUrl(key) {
  return publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/${key}` : null;
}

async function buildSignedViewUrl(key) {
  if (typeof key !== "string" || key.length === 0) return null;
  if (!canUseS3()) return null;

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

function extractUsername(req) {
  const headerUsername = req.headers["x-username"];
  if (typeof headerUsername === "string" && headerUsername.length > 0) {
    return normalizeUsername(headerUsername);
  }
  if (Array.isArray(headerUsername) && typeof headerUsername[0] === "string" && headerUsername[0].length > 0) {
    return normalizeUsername(headerUsername[0]);
  }

  const headerLegacyName = req.headers["x-uploader-name"];
  if (typeof headerLegacyName === "string" && headerLegacyName.length > 0) {
    return normalizeUsername(headerLegacyName);
  }
  if (
    Array.isArray(headerLegacyName) &&
    typeof headerLegacyName[0] === "string" &&
    headerLegacyName[0].length > 0
  ) {
    return normalizeUsername(headerLegacyName[0]);
  }

  if (typeof req.body?.username === "string") {
    return normalizeUsername(req.body.username);
  }
  if (typeof req.body?.name === "string") {
    return normalizeUsername(req.body.name);
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

function buildPhotoEntry({
  user,
  key,
  contentType,
  sizeBytes,
  width,
  height,
  durationSeconds,
  capturedAt,
  publicUrl,
  album
}) {
  const normalizedAlbum = normalizeAlbum(album);
  const resolvedPublicUrl =
    typeof publicUrl === "string" && publicUrl.length > 0 ? publicUrl : buildPublicUrl(key);
  const normalizedContentType =
    typeof contentType === "string" && contentType.length > 0 ? contentType : "application/octet-stream";
  const mediaType = mediaTypeFromContentType(normalizedContentType);

  return {
    id: randomId("photo_"),
    userId: user.id,
    ownerUsername: user.username,
    key,
    contentType: normalizedContentType,
    mediaType,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null,
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
    durationSeconds: typeof durationSeconds === "number" && Number.isFinite(durationSeconds) ? durationSeconds : null,
    capturedAt: typeof capturedAt === "string" ? capturedAt : new Date().toISOString(),
    publicUrl: resolvedPublicUrl,
    album: normalizedAlbum,
    isPublic: Boolean(resolvedPublicUrl),
    uploaderName: user.username,
    createdAt: new Date().toISOString()
  };
}

function normalizeStoredPhotoEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const ownerUsername =
    normalizeUsername(entry.ownerUsername || entry.uploaderName || DEFAULT_UPLOADER_NAME) || DEFAULT_UPLOADER_NAME;
  const publicUrl =
    typeof entry.publicUrl === "string" && entry.publicUrl.trim().length > 0 ? entry.publicUrl : null;
  const userId =
    typeof entry.userId === "string" && entry.userId.trim().length > 0
      ? entry.userId.trim()
      : contributorIdForUsername(ownerUsername);

  return {
    ...entry,
    userId,
    ownerUsername,
    mediaType: mediaTypeFromContentType(entry.contentType),
    album: normalizeAlbum(entry.album),
    isPublic: parseBooleanFlag(entry.isPublic, Boolean(publicUrl)),
    publicUrl,
    durationSeconds:
      typeof entry.durationSeconds === "number" && Number.isFinite(entry.durationSeconds)
        ? entry.durationSeconds
        : null,
    uploaderName: ownerUsername
  };
}

function normalizeContributorRecord(record) {
  if (!record || typeof record !== "object") return null;

  const username = normalizeUsername(record.username);
  if (!username || !isValidUsername(username)) return null;

  const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : contributorIdForUsername(username);
  const now = new Date().toISOString();

  return {
    id,
    username,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now
  };
}

function normalizeContributorStore(store) {
  const sourceUsers = Array.isArray(store?.users)
    ? store.users
    : Array.isArray(store?.profiles)
      ? store.profiles
      : [];

  const users = [];
  const seenIds = new Set();
  const seenUsernames = new Set();

  sourceUsers.forEach((rawUser) => {
    const user = normalizeContributorRecord(rawUser);
    if (!user) return;
    if (seenIds.has(user.id) || seenUsernames.has(user.username)) return;

    seenIds.add(user.id);
    seenUsernames.add(user.username);
    users.push(user);
  });

  return {
    version: 2,
    users: users.sort((a, b) => a.username.localeCompare(b.username))
  };
}

function createContributorRecord(username) {
  const normalizedUsername = normalizeUsername(username) || DEFAULT_UPLOADER_NAME;
  if (!isValidUsername(normalizedUsername)) {
    throw new Error(
      "Invalid name. Use 1-40 chars with letters, numbers, spaces, dot, underscore, dash, @, or +."
    );
  }

  const now = new Date().toISOString();
  return {
    id: contributorIdForUsername(normalizedUsername),
    username: normalizedUsername,
    createdAt: now,
    updatedAt: now
  };
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function readJsonFromFile(pathname, defaultValue) {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return defaultValue;
    throw error;
  }
}

async function writeJsonToFile(pathname, value) {
  await ensureDataDir();
  await fs.writeFile(pathname, JSON.stringify(value, null, 2), "utf8");
}

async function readContributorsFromFile() {
  const parsed = await readJsonFromFile(usersPath, { version: 2, users: [] });
  return normalizeContributorStore(parsed);
}

async function writeContributorsToFile(store) {
  await writeJsonToFile(usersPath, normalizeContributorStore(store));
}

async function readContributorsFromS3() {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: usersIndexKey()
      })
    );

    const body = await response.Body?.transformToString?.();
    if (!body) return { version: 2, users: [] };

    return normalizeContributorStore(JSON.parse(body));
  } catch (error) {
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      return { version: 2, users: [] };
    }
    throw error;
  }
}

async function writeContributorsToS3(store) {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: usersIndexKey(),
      Body: JSON.stringify(normalizeContributorStore(store)),
      ContentType: "application/json"
    })
  );
}

async function readContributorStore() {
  if (metadataBackend === "s3") {
    return readContributorsFromS3();
  }

  try {
    return await readContributorsFromFile();
  } catch (error) {
    if (["EROFS", "EACCES", "EPERM"].includes(error?.code) && canUseS3()) {
      return readContributorsFromS3();
    }
    throw error;
  }
}

async function writeContributorStore(store) {
  if (metadataBackend === "s3") {
    await writeContributorsToS3(store);
    return { backend: "s3" };
  }

  try {
    await writeContributorsToFile(store);
    return { backend: "file" };
  } catch (error) {
    if (["EROFS", "EACCES", "EPERM"].includes(error?.code) && canUseS3()) {
      await writeContributorsToS3(store);
      return { backend: "s3-fallback" };
    }
    throw error;
  }
}

async function ensureContributor(usernameInput) {
  const normalizedUsername = normalizeUsername(usernameInput);
  const username =
    normalizedUsername && isValidUsername(normalizedUsername) ? normalizedUsername : DEFAULT_UPLOADER_NAME;
  const store = await readContributorStore();
  const existing = store.users.find((user) => user.username === username);
  if (existing) return existing;

  const contributor = createContributorRecord(username);
  store.users.push(contributor);
  await writeContributorStore(store);
  return contributor;
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
  const next = [entry, ...current].slice(0, 600);

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
    return { stored: true, backend: "s3" };
  }

  try {
    await appendMetadataToFile(entry);
    return { stored: true, backend: "file" };
  } catch (error) {
    if (["EROFS", "EACCES", "EPERM"].includes(error?.code) && canUseS3()) {
      await appendMetadataToS3(entry);
      return { stored: true, backend: "s3-fallback" };
    }
    throw error;
  }
}

async function readSharedMetadata() {
  if (metadataBackend === "s3") {
    const store = await readContributorStore();
    const entriesByUser = await Promise.all(
      store.users.map(async (user) => {
        const records = await readMetadataFromS3(user.id);
        return records
          .map((record) =>
            normalizeStoredPhotoEntry({
              ...record,
              userId:
                typeof record?.userId === "string" && record.userId.trim().length > 0
                  ? record.userId
                  : user.id,
              ownerUsername: record?.ownerUsername || record?.uploaderName || user.username
            })
          )
          .filter(Boolean);
      })
    );

    return entriesByUser.flat();
  }

  return (await readAllMetadataFromFile()).map(normalizeStoredPhotoEntry).filter(Boolean);
}

app.get("/api/health", async (_req, res) => {
  let contributorsCount = 0;
  try {
    const store = await readContributorStore();
    contributorsCount = store.users.length;
  } catch {
    contributorsCount = 0;
  }

  res.json({
    ok: true,
    authEnabled: hasConfiguredPassword(),
    authSessionHours,
    metadataBackend,
    metadataBackendRequested: metadataBackendRaw,
    metadataBackendForcedToS3: isServerlessRuntime && parsedMetadataBackend === "file",
    isServerlessRuntime,
    port,
    contributorsCount,
    defaultUploaderName: DEFAULT_UPLOADER_NAME,
    missingS3Config: missingEnvVars(S3_REQUIRED_ENV)
  });
});

app.get("/api/session", (req, res) => {
  setNoStore(res);
  res.json({
    authenticated: isAuthenticatedRequest(req),
    authEnabled: hasConfiguredPassword(),
    authSessionHours
  });
});

app.post("/api/unlock", (req, res) => {
  setNoStore(res);
  if (!requireConfiguredPassword(res)) {
    return;
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) {
    res.status(400).json({ error: "Password is required." });
    return;
  }

  if (!passwordMatches(password)) {
    clearAuthCookie(req, res);
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  res.setHeader("Set-Cookie", serializeCookie(authCookieName, createAuthToken(), req));
  res.json({
    authenticated: true,
    expiresInSeconds: authSessionSeconds
  });
});

app.post("/api/logout", (req, res) => {
  setNoStore(res);
  clearAuthCookie(req, res);
  res.json({ authenticated: false });
});

app.use(["/api/upload-url", "/api/upload", "/api/photos"], requireAuthenticatedApp);

app.post("/api/upload-url", async (req, res, next) => {
  try {
    if (!requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    const { contentType, fileSize } = req.body ?? {};
    const headerContentType = req.headers["x-content-type"];
    const headerFileSize = req.headers["x-file-size"];
    const contributor = await ensureContributor(extractUsername(req));

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
        error: "Unsupported contentType. Use JPEG, PNG, WEBP, HEIC, HEIF, MP4, MOV, M4V, or WEBM."
      });
      return;
    }

    const album = extractAlbum(req);
    const key = buildObjectKey(contributor.id, contributor.username, extension, album);

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
      publicUrl,
      album,
      ownerUsername: contributor.username,
      userId: contributor.id,
      isPublic: Boolean(publicUrl)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/upload", rawUploadParser, async (req, res, next) => {
  try {
    if (!requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Media body is required." });
      return;
    }

    if (req.body.length > maxFileSizeBytes) {
      res.status(413).json({
        error: `File is too large. Max size is ${Math.round(maxFileSizeBytes / (1024 * 1024))} MB.`
      });
      return;
    }

    const contributor = await ensureContributor(extractUsername(req));
    const contentType = normalizeContentType(req.headers["content-type"]);
    const extension = extensionFromType(contentType);
    if (!extension) {
      res.status(400).json({
        error: "Unsupported contentType. Use JPEG, PNG, WEBP, HEIC, HEIF, MP4, MOV, M4V, or WEBM."
      });
      return;
    }

    const album = extractAlbum(req);
    const key = buildObjectKey(contributor.id, contributor.username, extension, album);

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
    const durationHeader = coercePositiveNumber(req.headers["x-media-duration"]);
    const capturedAtHeader = req.headers["x-captured-at"];

    const entry = buildPhotoEntry({
      user: contributor,
      key,
      contentType,
      sizeBytes: req.body.length,
      width: widthHeader ? Math.round(widthHeader) : null,
      height: heightHeader ? Math.round(heightHeader) : null,
      durationSeconds: durationHeader ? Number(durationHeader.toFixed(3)) : null,
      capturedAt: typeof capturedAtHeader === "string" ? capturedAtHeader : new Date().toISOString(),
      publicUrl: buildPublicUrl(key),
      album
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

app.post("/api/photos", async (req, res, next) => {
  try {
    if (metadataBackend === "s3" && !requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    const contributor = await ensureContributor(extractUsername(req));
    const { key, contentType, sizeBytes, width, height, durationSeconds, capturedAt, publicUrl } = req.body ?? {};
    const album = extractAlbum(req);

    if (typeof key !== "string" || key.length === 0) {
      res.status(400).json({ error: "key is required." });
      return;
    }

    if (!key.startsWith(`${contributor.id}/`)) {
      res.status(403).json({ error: "Invalid key for current uploader." });
      return;
    }

    const entry = buildPhotoEntry({
      user: contributor,
      key,
      contentType,
      sizeBytes,
      width,
      height,
      durationSeconds:
        typeof durationSeconds === "number" && Number.isFinite(durationSeconds) ? durationSeconds : null,
      capturedAt,
      publicUrl: typeof publicUrl === "string" && publicUrl.length > 0 ? publicUrl : buildPublicUrl(key),
      album
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

app.get("/api/photos", async (req, res, next) => {
  try {
    if (metadataBackend === "s3" && !requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    const albumQuery = typeof req.query?.album === "string" ? req.query.album : "";
    const normalizedAlbumFilter = albumQuery.trim().length > 0 ? normalizeAlbum(albumQuery) : "";
    const uploaderQuery = typeof req.query?.uploader === "string" ? normalizeUsername(req.query.uploader) : "";

    const limitRequested = Number(req.query?.limit);
    const limit =
      Number.isFinite(limitRequested) && limitRequested > 0
        ? Math.min(Math.floor(limitRequested), 300)
        : 120;

    const allPhotos = (await readSharedMetadata()).sort((a, b) => {
      const aTime = Date.parse(a?.createdAt ?? "") || 0;
      const bTime = Date.parse(b?.createdAt ?? "") || 0;
      return bTime - aTime;
    });

    const albums = Array.from(new Set(allPhotos.map((item) => item.album).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );

    const contributors = Array.from(
      new Map(
        allPhotos.map((photo) => [
          photo.userId,
          {
            id: photo.userId,
            username: photo.ownerUsername || DEFAULT_UPLOADER_NAME
          }
        ])
      ).values()
    ).sort((a, b) => a.username.localeCompare(b.username));

    const photos = allPhotos
      .filter((item) => {
        if (normalizedAlbumFilter && item.album !== normalizedAlbumFilter) return false;
        if (uploaderQuery && item.ownerUsername !== uploaderQuery) return false;
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
      contributors,
      filters: {
        album: normalizedAlbumFilter || null,
        uploader: uploaderQuery || null
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
