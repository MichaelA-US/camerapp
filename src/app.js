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

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@+\- ]{0,39}$/;
const ROLE_VALUES = new Set(["admin", "user"]);

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

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hmac(input) {
  return crypto.createHmac("sha256", process.env.TOKEN_SECRET).update(input).digest("base64url");
}

function createToken(user) {
  const payload = {
    sub: user.id,
    un: user.username,
    rl: user.role,
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
  if (payload.un !== undefined && typeof payload.un !== "string") return null;
  if (payload.rl !== undefined && typeof payload.rl !== "string") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
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
  return slug || "user";
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

function normalizeRole(value) {
  if (typeof value !== "string") return "user";
  const normalized = value.trim().toLowerCase();
  return ROLE_VALUES.has(normalized) ? normalized : "user";
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

function metadataIndexKey(userId) {
  return `${metadataPrefix}/${userId}/index.json`;
}

function usersIndexKey() {
  return `${metadataPrefix}/_admin/users.json`;
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

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const safePassword = typeof password === "string" ? password : "";
  const hash = crypto.scryptSync(safePassword, salt, 64).toString("hex");
  return { salt, hash };
}

function safeCompareHex(left, right) {
  try {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function verifyPassword(password, salt, expectedHash) {
  if (typeof salt !== "string" || typeof expectedHash !== "string") return false;
  const { hash } = hashPassword(password, salt);
  return safeCompareHex(hash, expectedHash);
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

function extractPassword(req) {
  const headerPassword = req.headers["x-password"];
  if (typeof headerPassword === "string" && headerPassword.length > 0) {
    return headerPassword;
  }
  if (Array.isArray(headerPassword) && typeof headerPassword[0] === "string" && headerPassword[0].length > 0) {
    return headerPassword[0];
  }

  const headerPasscode = req.headers["x-passcode"];
  if (typeof headerPasscode === "string" && headerPasscode.length > 0) {
    return headerPasscode;
  }
  if (Array.isArray(headerPasscode) && typeof headerPasscode[0] === "string" && headerPasscode[0].length > 0) {
    return headerPasscode[0];
  }

  if (typeof req.body?.password === "string") {
    return req.body.password;
  }
  if (typeof req.body?.passcode === "string") {
    return req.body.passcode;
  }

  if (typeof req.body === "string") {
    const textBody = req.body;
    if (!textBody) return "";

    try {
      const parsed = JSON.parse(textBody);
      if (typeof parsed?.password === "string") return parsed.password;
      if (typeof parsed?.passcode === "string") return parsed.passcode;
    } catch {
      // Ignore parse errors and use raw body.
    }

    return textBody;
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

function buildPhotoEntry({ user, key, contentType, sizeBytes, width, height, capturedAt, publicUrl, album, isPublic }) {
  const normalizedAlbum = normalizeAlbum(album);
  const isPublicPhoto = parseBooleanFlag(
    isPublic,
    typeof publicUrl === "string" && publicUrl.length > 0
  );

  return {
    id: randomId("photo_"),
    userId: user.id,
    ownerUsername: user.username,
    key,
    contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null,
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
    capturedAt: typeof capturedAt === "string" ? capturedAt : new Date().toISOString(),
    publicUrl: isPublicPhoto && typeof publicUrl === "string" ? publicUrl : null,
    album: normalizedAlbum,
    isPublic: isPublicPhoto,
    uploaderName: user.username,
    createdAt: new Date().toISOString()
  };
}

function normalizeStoredPhotoEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const userId = typeof entry.userId === "string" ? entry.userId : "";
  const ownerUsername = normalizeUsername(entry.ownerUsername || entry.uploaderName || "");
  const publicUrl = typeof entry.publicUrl === "string" ? entry.publicUrl : null;

  return {
    ...entry,
    userId,
    ownerUsername,
    album: normalizeAlbum(entry.album),
    isPublic: parseBooleanFlag(entry.isPublic, Boolean(publicUrl)),
    publicUrl
  };
}

function normalizeUserRecord(record) {
  if (!record || typeof record !== "object") return null;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const username = normalizeUsername(record.username);
  const passwordHash = typeof record.passwordHash === "string" ? record.passwordHash : "";
  const passwordSalt = typeof record.passwordSalt === "string" ? record.passwordSalt : "";

  if (!id || !username || !passwordHash || !passwordSalt) return null;

  return {
    id,
    username,
    passwordHash,
    passwordSalt,
    role: normalizeRole(record.role),
    active: parseBooleanFlag(record.active, true),
    linkedUserIds: Array.isArray(record.linkedUserIds)
      ? Array.from(
          new Set(
            record.linkedUserIds
              .filter((value) => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
          )
        )
      : [],
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
  };
}

function normalizeUserStore(store) {
  const sourceUsers = Array.isArray(store?.users) ? store.users : [];
  const users = [];
  const seenIds = new Set();
  const seenUsernames = new Set();

  sourceUsers.forEach((rawUser) => {
    const user = normalizeUserRecord(rawUser);
    if (!user) return;
    if (seenIds.has(user.id) || seenUsernames.has(user.username)) return;

    seenIds.add(user.id);
    seenUsernames.add(user.username);
    users.push(user);
  });

  const validIds = new Set(users.map((user) => user.id));
  users.forEach((user) => {
    user.linkedUserIds = user.linkedUserIds.filter((id) => id !== user.id && validIds.has(id));
  });

  const byId = new Map(users.map((user) => [user.id, user]));
  users.forEach((user) => {
    user.linkedUserIds.forEach((linkedId) => {
      const other = byId.get(linkedId);
      if (!other) return;
      if (!other.linkedUserIds.includes(user.id)) {
        other.linkedUserIds.push(user.id);
      }
    });
  });

  users.forEach((user) => {
    user.linkedUserIds = Array.from(new Set(user.linkedUserIds)).filter((id) => id !== user.id);
  });

  return {
    version: 1,
    users
  };
}

function createUserRecord({ username, password, role = "user", active = true }) {
  const normalizedUsername = normalizeUsername(username);
  if (!isValidUsername(normalizedUsername)) {
    throw new Error(
      "Invalid username. Use 1-40 chars with letters, numbers, spaces, dot, underscore, dash, @, or +."
    );
  }

  if (typeof password !== "string" || password.length < 4) {
    throw new Error("Password must be at least 4 characters.");
  }

  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();

  return {
    id: randomId("user_"),
    username: normalizedUsername,
    passwordHash: hash,
    passwordSalt: salt,
    role: normalizeRole(role),
    active: parseBooleanFlag(active, true),
    linkedUserIds: [],
    createdAt: now,
    updatedAt: now
  };
}

function serializeUserForSession(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active
  };
}

function serializeUsersForAdmin(users) {
  const byId = new Map(users.map((user) => [user.id, user]));
  return users
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      active: user.active,
      linkedUserIds: user.linkedUserIds.slice().sort((a, b) => a.localeCompare(b)),
      linkedUsernames: user.linkedUserIds
        .map((id) => byId.get(id)?.username)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }));
}

function computeVisibleUsers(user, allUsers) {
  const activeUsers = allUsers.filter((candidate) => candidate.active);
  if (user.role === "admin") {
    return activeUsers
      .map((candidate) => ({ id: candidate.id, username: candidate.username }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  const allowedIds = new Set([user.id, ...user.linkedUserIds]);
  return activeUsers
    .filter((candidate) => allowedIds.has(candidate.id))
    .map((candidate) => ({ id: candidate.id, username: candidate.username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function resolveLinkedUserIds(input, users) {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];

  const byId = new Map(users.map((user) => [user.id, user.id]));
  const byUsername = new Map(users.map((user) => [user.username, user.id]));
  const resolved = new Set();

  values.forEach((value) => {
    if (typeof value !== "string") return;

    const trimmed = value.trim();
    if (!trimmed) return;

    if (byId.has(trimmed)) {
      resolved.add(trimmed);
      return;
    }

    const normalizedUsername = normalizeUsername(trimmed);
    if (byUsername.has(normalizedUsername)) {
      resolved.add(byUsername.get(normalizedUsername));
    }
  });

  return Array.from(resolved);
}

function applyBidirectionalLinks(users, userId, requestedLinkedIds) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const user = byId.get(userId);
  if (!user) return;

  const validLinkedIds = Array.from(
    new Set(requestedLinkedIds.filter((id) => id !== userId && byId.has(id)))
  );

  users.forEach((candidate) => {
    candidate.linkedUserIds = candidate.linkedUserIds.filter((id) => id !== userId);
  });

  user.linkedUserIds = validLinkedIds;

  validLinkedIds.forEach((linkedId) => {
    const other = byId.get(linkedId);
    if (!other) return;
    if (!other.linkedUserIds.includes(userId)) {
      other.linkedUserIds.push(userId);
    }
  });
}

function countActiveAdmins(users, ignoreUserId = "", nextRole = "", nextActive = null) {
  return users.filter((user) => {
    const role = user.id === ignoreUserId && nextRole ? nextRole : user.role;
    const active = user.id === ignoreUserId && typeof nextActive === "boolean" ? nextActive : user.active;
    return role === "admin" && active;
  }).length;
}

function bootstrapUserIdForUsername(username) {
  const normalized = normalizeUsername(username) || "user";
  const digest = crypto
    .createHash("sha256")
    .update(`bootstrap-user:${normalized}`)
    .digest("hex")
    .slice(0, 20);
  return `user_bootstrap_${digest}`;
}

function configuredPasswordForBootstrapUsername(username) {
  const normalized = normalizeUsername(username);
  const envKeysByUsername = {
    admin: ["ADMIN_PASSWORD", "APP_PASSCODE", "DEFAULT_USER_PASSWORD"],
    m: ["USER_PASSWORD_M", "DEFAULT_USER_PASSWORD", "APP_PASSCODE", "ADMIN_PASSWORD"],
    v: ["USER_PASSWORD_V", "DEFAULT_USER_PASSWORD", "APP_PASSCODE", "ADMIN_PASSWORD"],
    boys: ["USER_PASSWORD_BOYS", "DEFAULT_USER_PASSWORD", "APP_PASSCODE", "ADMIN_PASSWORD"]
  };
  const envKeys = envKeysByUsername[normalized] ?? ["DEFAULT_USER_PASSWORD", "APP_PASSCODE", "ADMIN_PASSWORD"];
  for (const key of envKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length >= 4) {
      return value;
    }
  }
  return "";
}

function buildBootstrapUser(username, role) {
  const normalizedUsername = normalizeUsername(username);
  if (!isValidUsername(normalizedUsername)) return null;

  const password = configuredPasswordForBootstrapUsername(normalizedUsername);
  if (!password) return null;

  try {
    const user = createUserRecord({
      username: normalizedUsername,
      password,
      role,
      active: true
    });
    user.id = bootstrapUserIdForUsername(normalizedUsername);
    return user;
  } catch (error) {
    console.error(`Could not bootstrap user ${normalizedUsername}:`, error);
    return null;
  }
}

function ensurePreconfiguredUsers(store) {
  const normalizedStore = normalizeUserStore(store);
  const byUsername = new Map(normalizedStore.users.map((user) => [user.username, user]));
  const preconfigured = [
    buildBootstrapUser("m", "user"),
    buildBootstrapUser("v", "user"),
    buildBootstrapUser("admin", "admin"),
    buildBootstrapUser("boys", "user")
  ].filter(Boolean);
  let changed = false;

  preconfigured.forEach((user) => {
    if (!byUsername.has(user.username)) {
      normalizedStore.users.push(user);
      byUsername.set(user.username, user);
      changed = true;
    }
  });

  const adminUser = byUsername.get("admin");
  if (adminUser && (adminUser.role !== "admin" || !adminUser.active)) {
    adminUser.role = "admin";
    adminUser.active = true;
    adminUser.updatedAt = new Date().toISOString();
    changed = true;
  }

  return {
    changed,
    store: normalizeUserStore(normalizedStore)
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

async function readUsersFromFile() {
  const parsed = await readJsonFromFile(usersPath, { version: 1, users: [] });
  return normalizeUserStore(parsed);
}

async function writeUsersToFile(store) {
  await writeJsonToFile(usersPath, normalizeUserStore(store));
}

async function readUsersFromS3() {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: usersIndexKey()
      })
    );

    const body = await response.Body?.transformToString?.();
    if (!body) return { version: 1, users: [] };

    return normalizeUserStore(JSON.parse(body));
  } catch (error) {
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      return { version: 1, users: [] };
    }
    throw error;
  }
}

async function writeUsersToS3(store) {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: usersIndexKey(),
      Body: JSON.stringify(normalizeUserStore(store)),
      ContentType: "application/json"
    })
  );
}

async function readUserStore() {
  if (metadataBackend === "s3") {
    return readUsersFromS3();
  }

  try {
    return await readUsersFromFile();
  } catch (error) {
    if (["EROFS", "EACCES", "EPERM"].includes(error?.code) && canUseS3()) {
      return readUsersFromS3();
    }
    throw error;
  }
}

async function writeUserStore(store) {
  if (metadataBackend === "s3") {
    await writeUsersToS3(store);
    return { backend: "s3" };
  }

  try {
    await writeUsersToFile(store);
    return { backend: "file" };
  } catch (error) {
    if (["EROFS", "EACCES", "EPERM"].includes(error?.code) && canUseS3()) {
      await writeUsersToS3(store);
      return { backend: "s3-fallback" };
    }
    throw error;
  }
}

let bootstrapPromise = null;

async function ensureUserStoreBootstrapped() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const store = await readUserStore();
    const preconfiguredResult = ensurePreconfiguredUsers(store);
    if (!preconfiguredResult.changed) return preconfiguredResult.store;

    await writeUserStore(preconfiguredResult.store);
    return preconfiguredResult.store;
  })();

  try {
    return await bootstrapPromise;
  } finally {
    bootstrapPromise = null;
  }
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

async function readMetadataForUser(userId) {
  if (metadataBackend === "s3") {
    return readMetadataFromS3(userId);
  }

  const all = await readAllMetadataFromFile();
  return all.filter((item) => item?.userId === userId);
}

async function auth(req, res, next) {
  if (!requireEnvVars(res, ["TOKEN_SECRET"])) {
    return;
  }

  if (metadataBackend === "s3" && !requireEnvVars(res, S3_REQUIRED_ENV)) {
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    await ensureUserStoreBootstrapped();
    const store = await readUserStore();
    let user = store.users.find((candidate) => candidate.id === payload.sub);
    if (!user && typeof payload.un === "string" && payload.un.trim().length > 0) {
      const tokenUsername = normalizeUsername(payload.un);
      user = store.users.find((candidate) => candidate.username === tokenUsername);
    }

    if (!user || !user.active) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const visibleUsers = computeVisibleUsers(user, store.users);

    req.user = {
      ...user,
      visibleUsers,
      visibleUserIds: visibleUsers.map((candidate) => candidate.id)
    };

    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin" || normalizeUsername(req.user?.username) !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

app.get("/api/health", async (_req, res) => {
  const missingAuthConfig = missingEnvVars(["TOKEN_SECRET"]);
  if (!process.env.ADMIN_PASSWORD && !process.env.APP_PASSCODE) {
    missingAuthConfig.push("ADMIN_PASSWORD (or APP_PASSCODE for bootstrap)");
  }

  let usersCount = 0;
  try {
    const store = await readUserStore();
    usersCount = store.users.length;
  } catch {
    usersCount = 0;
  }

  res.json({
    ok: true,
    metadataBackend,
    metadataBackendRequested: metadataBackendRaw,
    metadataBackendForcedToS3: isServerlessRuntime && parsedMetadataBackend === "file",
    isServerlessRuntime,
    port,
    usersCount,
    missingAuthConfig,
    missingS3Config: missingEnvVars(S3_REQUIRED_ENV)
  });
});

app.post("/api/login", async (req, res, next) => {
  try {
    if (!requireEnvVars(res, ["TOKEN_SECRET"])) {
      return;
    }

    if (metadataBackend === "s3" && !requireEnvVars(res, S3_REQUIRED_ENV)) {
      return;
    }

    await ensureUserStoreBootstrapped();
    const store = await readUserStore();
    if (store.users.length === 0) {
      res.status(503).json({
        error: "No users configured. Set ADMIN_PASSWORD (or APP_PASSCODE) to bootstrap the first admin."
      });
      return;
    }

    const username = extractUsername(req);
    if (!username) {
      res.status(400).json({ error: "Username is required." });
      return;
    }

    const password = extractPassword(req);
    if (typeof password !== "string" || password.length === 0) {
      res.status(400).json({ error: "Password is required." });
      return;
    }

    const user = store.users.find((candidate) => candidate.username === username);
    if (!user || !user.active || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      res.status(401).json({ error: "Invalid username or password." });
      return;
    }

    const token = createToken(user);
    const visibleUsers = computeVisibleUsers(user, store.users);

    res.json({
      token,
      expiresInSeconds: tokenTtlSeconds,
      user: serializeUserForSession(user),
      visibleUsers
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/login", (_req, res) => {
  res.status(405).json({ error: "Use POST /api/login with username and password in the request body." });
});

app.get("/api/me", auth, (req, res) => {
  res.json({
    user: serializeUserForSession(req.user),
    visibleUsers: req.user.visibleUsers
  });
});

app.get("/api/admin/users", auth, requireAdmin, async (_req, res, next) => {
  try {
    const store = await readUserStore();
    res.json({
      users: serializeUsersForAdmin(store.users)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users", auth, requireAdmin, async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = normalizeRole(req.body?.role);

    if (!isValidUsername(username)) {
      res.status(400).json({
        error: "Invalid username. Use 1-40 chars with letters, numbers, spaces, dot, underscore, dash, @, or +."
      });
      return;
    }

    if (password.length < 4) {
      res.status(400).json({ error: "Password must be at least 4 characters." });
      return;
    }

    const store = await readUserStore();
    if (store.users.some((candidate) => candidate.username === username)) {
      res.status(409).json({ error: "That username already exists." });
      return;
    }

    const user = createUserRecord({ username, password, role, active: true });
    store.users.push(user);

    const hasLinkedInput =
      Object.hasOwn(req.body ?? {}, "linkedUsers") || Object.hasOwn(req.body ?? {}, "linkedUserIds");
    if (hasLinkedInput) {
      const requestedLinked = resolveLinkedUserIds(
        req.body?.linkedUsers ?? req.body?.linkedUserIds,
        store.users
      );
      applyBidirectionalLinks(store.users, user.id, requestedLinked);
    }

    await writeUserStore(store);

    res.status(201).json({
      user: serializeUserForSession(user),
      users: serializeUsersForAdmin(store.users)
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/users/:userId", auth, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.params.userId ?? "");
    if (!userId) {
      res.status(400).json({ error: "userId is required." });
      return;
    }

    const store = await readUserStore();
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const hasRole = Object.hasOwn(req.body ?? {}, "role");
    const nextRole = hasRole ? normalizeRole(req.body.role) : user.role;

    const hasActive = Object.hasOwn(req.body ?? {}, "active");
    const nextActive = hasActive ? parseBooleanFlag(req.body.active, user.active) : user.active;

    if (req.user.id === user.id && !nextActive) {
      res.status(400).json({ error: "You cannot deactivate your own account." });
      return;
    }

    const activeAdmins = countActiveAdmins(store.users, user.id, nextRole, nextActive);
    if (activeAdmins < 1) {
      res.status(400).json({ error: "At least one active admin is required." });
      return;
    }

    user.role = nextRole;
    user.active = nextActive;

    const incomingPassword = typeof req.body?.password === "string" ? req.body.password : "";
    if (incomingPassword.length > 0) {
      if (incomingPassword.length < 4) {
        res.status(400).json({ error: "Password must be at least 4 characters." });
        return;
      }
      const { salt, hash } = hashPassword(incomingPassword);
      user.passwordSalt = salt;
      user.passwordHash = hash;
    }

    const hasLinkedInput =
      Object.hasOwn(req.body ?? {}, "linkedUsers") || Object.hasOwn(req.body ?? {}, "linkedUserIds");
    if (hasLinkedInput) {
      const requestedLinked = resolveLinkedUserIds(
        req.body?.linkedUsers ?? req.body?.linkedUserIds,
        store.users
      );
      applyBidirectionalLinks(store.users, user.id, requestedLinked);
    }

    const now = new Date().toISOString();
    user.updatedAt = now;

    if (hasLinkedInput) {
      store.users.forEach((candidate) => {
        if (candidate.linkedUserIds.includes(user.id) || candidate.id === user.id) {
          candidate.updatedAt = now;
        }
      });
    }

    await writeUserStore(store);

    res.json({
      user: serializeUserForSession(user),
      users: serializeUsersForAdmin(store.users)
    });
  } catch (error) {
    next(error);
  }
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
    const key = buildObjectKey(req.user.id, req.user.username, extension, album);

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
      isPublic: isPublicPhoto,
      ownerUsername: req.user.username
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
    const key = buildObjectKey(req.user.id, req.user.username, extension, album);

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
      user: req.user,
      key,
      contentType,
      sizeBytes: req.body.length,
      width: widthHeader ? Math.round(widthHeader) : null,
      height: heightHeader ? Math.round(heightHeader) : null,
      capturedAt: typeof capturedAtHeader === "string" ? capturedAtHeader : new Date().toISOString(),
      publicUrl: buildPublicUrl(key),
      album,
      isPublic: isPublicPhoto
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

    if (!key.startsWith(`${req.user.id}/`)) {
      res.status(403).json({ error: "Invalid key for current user." });
      return;
    }

    const entry = buildPhotoEntry({
      user: req.user,
      key,
      contentType,
      sizeBytes,
      width,
      height,
      capturedAt,
      publicUrl: typeof publicUrl === "string" && publicUrl.length > 0 ? publicUrl : buildPublicUrl(key),
      album,
      isPublic: isPublicPhoto
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

    const ownerQuery = typeof req.query?.owner === "string" ? req.query.owner.trim() : "";

    const limitRequested = Number(req.query?.limit);
    const limit =
      Number.isFinite(limitRequested) && limitRequested > 0
        ? Math.min(Math.floor(limitRequested), 300)
        : 120;

    const visibleUsers = req.user.visibleUsers;
    const visibleUserMap = new Map(visibleUsers.map((user) => [user.id, user.username]));

    const entriesByUser = await Promise.all(
      visibleUsers.map(async (visibleUser) => {
        const records = await readMetadataForUser(visibleUser.id);
        return records
          .map((record) => {
            const normalized = normalizeStoredPhotoEntry({
              ...record,
              userId:
                typeof record?.userId === "string" && record.userId.length > 0
                  ? record.userId
                  : visibleUser.id,
              ownerUsername: record?.ownerUsername || record?.uploaderName || visibleUser.username
            });
            if (!normalized) return null;
            if (!normalized.userId) {
              normalized.userId = visibleUser.id;
            }
            if (!normalized.ownerUsername) {
              normalized.ownerUsername = visibleUser.username;
            }
            return normalized;
          })
          .filter(Boolean);
      })
    );

    const allPhotos = entriesByUser
      .flat()
      .filter((entry) => visibleUserMap.has(entry.userId))
      .sort((a, b) => {
        const aTime = Date.parse(a?.createdAt ?? "") || 0;
        const bTime = Date.parse(b?.createdAt ?? "") || 0;
        return bTime - aTime;
      });

    const owners = Array.from(
      new Map(
        allPhotos.map((photo) => [
          photo.userId,
          {
            id: photo.userId,
            username: photo.ownerUsername || visibleUserMap.get(photo.userId) || "unknown"
          }
        ])
      ).values()
    ).sort((a, b) => a.username.localeCompare(b.username));

    let ownerFilterId = "";
    if (ownerQuery) {
      if (visibleUserMap.has(ownerQuery)) {
        ownerFilterId = ownerQuery;
      } else {
        const normalizedOwnerUsername = normalizeUsername(ownerQuery);
        const found = owners.find((owner) => owner.username === normalizedOwnerUsername);
        if (found) ownerFilterId = found.id;
      }
    }

    const albums = Array.from(new Set(allPhotos.map((item) => item.album).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );

    const photos = allPhotos
      .filter((item) => {
        if (normalizedAlbumFilter && item.album !== normalizedAlbumFilter) return false;
        if (publicOnly && !item.isPublic) return false;
        if (ownerFilterId && item.userId !== ownerFilterId) return false;
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
      owners,
      filters: {
        album: normalizedAlbumFilter || null,
        publicOnly,
        owner: ownerFilterId || null
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
