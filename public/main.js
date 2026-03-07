const loginForm = document.getElementById("login-form");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const sessionUserEl = document.getElementById("session-user");
const logoutButton = document.getElementById("logout-button");

const albumInput = document.getElementById("album-name");
const publicToggleInput = document.getElementById("public-toggle");
const captureButton = document.getElementById("capture");
const flipButton = document.getElementById("flip-camera");
const uploadFilesButton = document.getElementById("upload-files");
const filePickerInput = document.getElementById("file-picker");

const video = document.getElementById("preview");
const canvas = document.getElementById("capture-canvas");
const statusEl = document.getElementById("status");

const albumGridEl = document.getElementById("album-grid");
const ownerFilterSelect = document.getElementById("owner-filter");
const albumFilterSelect = document.getElementById("album-filter");
const publicOnlyFilterInput = document.getElementById("public-only-filter");

const previewModalEl = document.getElementById("preview-modal");
const previewBackdropEl = document.getElementById("preview-backdrop");
const previewCloseEl = document.getElementById("preview-close");
const previewImageEl = document.getElementById("preview-image");

const adminPanelEl = document.getElementById("admin-panel");
const createUserForm = document.getElementById("create-user-form");
const newUserUsernameInput = document.getElementById("new-user-username");
const newUserPasswordInput = document.getElementById("new-user-password");
const newUserRoleSelect = document.getElementById("new-user-role");
const adminStatusEl = document.getElementById("admin-status");
const adminUsersListEl = document.getElementById("admin-users-list");

const TOKEN_KEY = "onlineCameraToken";
const USERNAME_KEY = "onlineCameraUsername";
const ALBUM_KEY = "onlineCameraAlbum";
const PUBLIC_UPLOAD_KEY = "onlineCameraPublicUpload";
const FILTER_ALBUM_KEY = "onlineCameraFilterAlbum";
const FILTER_PUBLIC_KEY = "onlineCameraFilterPublic";
const FILTER_OWNER_KEY = "onlineCameraFilterOwner";
const MAX_ALBUM_ITEMS = 80;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@+\- ]{1,39}$/;
const USERNAME_RULES_ERROR =
  "Username must be 2-40 chars and may include letters, numbers, spaces, dot, underscore, dash, @, or +.";

let authToken = localStorage.getItem(TOKEN_KEY) || "";
let authUser = null;
let stream = null;
let currentFacingMode = "environment";
let hasMultipleCameras = true;

let selectedAlbumFilter = normalizeOptionalAlbum(localStorage.getItem(FILTER_ALBUM_KEY));
let selectedOwnerFilter = normalizeOwnerFilter(localStorage.getItem(FILTER_OWNER_KEY));
let publicOnlyFilter = parseBooleanFlag(localStorage.getItem(FILTER_PUBLIC_KEY), false);

const albumEntries = new Map();
const albumOrder = [];
const knownAlbums = new Set();
const knownOwners = new Map();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setAdminStatus(message, isError = false) {
  if (!adminStatusEl) return;
  adminStatusEl.textContent = message || "";
  adminStatusEl.classList.toggle("error", isError);
}

function authHeaders(includeJsonContentType = true) {
  const headers = {
    Authorization: `Bearer ${authToken}`
  };
  if (includeJsonContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
}

function isValidUsername(value) {
  return USERNAME_PATTERN.test(value);
}

function normalizeAlbum(value) {
  if (typeof value !== "string") return "general";
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 50);
  return normalized || "general";
}

function normalizeOptionalAlbum(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? normalizeAlbum(trimmed) : "";
}

function normalizeOwnerFilter(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeImageContentType(value) {
  const normalized = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
  return normalized || "image/jpeg";
}

function normalizeFileSize(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

function cameraLabel(facingMode) {
  return facingMode === "user" ? "front" : "rear";
}

function formatAlbumTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function isAdmin() {
  return authUser?.role === "admin";
}

function setSessionUi() {
  if (authUser) {
    sessionUserEl.textContent = `${authUser.username} (${authUser.role})`;
    logoutButton.disabled = false;
    usernameInput.value = authUser.username;
  } else {
    sessionUserEl.textContent = "Not signed in";
    logoutButton.disabled = true;
  }

  adminPanelEl.hidden = !isAdmin();
  setCameraControlsEnabled(Boolean(authUser));
}

function closePhotoPreview() {
  if (previewModalEl.hidden) return;
  previewModalEl.hidden = true;
  previewImageEl.removeAttribute("src");
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  authToken = "";
  authUser = null;
  stopCameraStream();
  closePhotoPreview();

  albumOrder.slice().forEach((key) => removeAlbumEntry(key, { render: false, syncFilters: false }));
  knownOwners.clear();
  knownAlbums.clear();
  registerAlbum("general");
  syncOwnerFilterOptions();
  syncAlbumFilterOptions();
  renderAlbum();

  adminUsersListEl.innerHTML = "";
  setAdminStatus("");

  setSessionUi();
}

function registerAlbum(value) {
  knownAlbums.add(normalizeAlbum(value));
}

function registerOwner(id, username) {
  if (typeof id !== "string" || !id.trim()) return;
  const normalizedUsername = normalizeUsername(username);
  knownOwners.set(id, normalizedUsername || id);
}

function syncAlbumFilterOptions() {
  const availableAlbums = Array.from(knownAlbums).sort((a, b) => a.localeCompare(b));
  albumFilterSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All albums";
  albumFilterSelect.appendChild(allOption);

  availableAlbums.forEach((album) => {
    const option = document.createElement("option");
    option.value = album;
    option.textContent = album;
    albumFilterSelect.appendChild(option);
  });

  if (selectedAlbumFilter && knownAlbums.has(selectedAlbumFilter)) {
    albumFilterSelect.value = selectedAlbumFilter;
  } else {
    selectedAlbumFilter = "";
    albumFilterSelect.value = "";
  }
}

function syncOwnerFilterOptions() {
  ownerFilterSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All visible users";
  ownerFilterSelect.appendChild(allOption);

  Array.from(knownOwners.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([ownerId, username]) => {
      const option = document.createElement("option");
      option.value = ownerId;
      option.textContent = username;
      ownerFilterSelect.appendChild(option);
    });

  if (selectedOwnerFilter && knownOwners.has(selectedOwnerFilter)) {
    ownerFilterSelect.value = selectedOwnerFilter;
  } else {
    selectedOwnerFilter = "";
    ownerFilterSelect.value = "";
  }
}

function currentUploadOptions() {
  const album = normalizeAlbum(albumInput.value);
  const isPublic = Boolean(publicToggleInput.checked);

  albumInput.value = album;
  localStorage.setItem(ALBUM_KEY, album);
  localStorage.setItem(PUBLIC_UPLOAD_KEY, isPublic ? "1" : "0");
  registerAlbum(album);

  return {
    album,
    isPublic
  };
}

function updateFiltersFromUi() {
  selectedOwnerFilter = normalizeOwnerFilter(ownerFilterSelect.value);
  selectedAlbumFilter = normalizeOptionalAlbum(albumFilterSelect.value);
  publicOnlyFilter = Boolean(publicOnlyFilterInput.checked);

  localStorage.setItem(FILTER_OWNER_KEY, selectedOwnerFilter);
  localStorage.setItem(FILTER_ALBUM_KEY, selectedAlbumFilter);
  localStorage.setItem(FILTER_PUBLIC_KEY, publicOnlyFilter ? "1" : "0");

  renderAlbum();
}

function removeAlbumEntry(key, { render = true, syncFilters = true } = {}) {
  if (!key || !albumEntries.has(key)) return;

  const entry = albumEntries.get(key);
  if (entry?.isLocalPreview && typeof entry.displayUrl === "string" && entry.displayUrl.startsWith("blob:")) {
    URL.revokeObjectURL(entry.displayUrl);
  }

  albumEntries.delete(key);
  const index = albumOrder.indexOf(key);
  if (index !== -1) albumOrder.splice(index, 1);

  if (syncFilters) {
    syncAlbumFilterOptions();
    syncOwnerFilterOptions();
  }
  if (render) renderAlbum();
}

function trimAlbumEntries() {
  while (albumOrder.length > MAX_ALBUM_ITEMS) {
    const key = albumOrder.pop();
    if (!key) continue;
    removeAlbumEntry(key, { render: false, syncFilters: false });
  }
}

function upsertAlbumEntry(nextEntry, { promote = true, render = true } = {}) {
  if (!nextEntry?.key) return;

  const existing = albumEntries.get(nextEntry.key);
  const existingIndex = albumOrder.indexOf(nextEntry.key);

  const normalizedAlbum = normalizeAlbum(nextEntry.album || existing?.album);
  const ownerUserId =
    typeof nextEntry.ownerUserId === "string" && nextEntry.ownerUserId
      ? nextEntry.ownerUserId
      : existing?.ownerUserId || authUser?.id || "";
  const ownerUsername = normalizeUsername(
    nextEntry.ownerUsername || existing?.ownerUsername || authUser?.username || ""
  );

  registerAlbum(normalizedAlbum);
  if (ownerUserId) registerOwner(ownerUserId, ownerUsername || ownerUserId);

  const merged = {
    ...existing,
    ...nextEntry,
    album: normalizedAlbum,
    ownerUserId,
    ownerUsername,
    isPublic: parseBooleanFlag(nextEntry.isPublic, existing?.isPublic ?? false),
    createdAt: nextEntry.createdAt || existing?.createdAt || new Date().toISOString()
  };

  if (
    existing?.isLocalPreview &&
    typeof existing.displayUrl === "string" &&
    existing.displayUrl.startsWith("blob:") &&
    merged.displayUrl &&
    merged.displayUrl !== existing.displayUrl
  ) {
    URL.revokeObjectURL(existing.displayUrl);
  }

  albumEntries.set(nextEntry.key, merged);

  if (existingIndex !== -1) {
    albumOrder.splice(existingIndex, 1);
  }

  if (promote || existingIndex === -1) {
    albumOrder.unshift(nextEntry.key);
  } else {
    albumOrder.splice(existingIndex, 0, nextEntry.key);
  }

  trimAlbumEntries();

  if (render) {
    syncAlbumFilterOptions();
    syncOwnerFilterOptions();
    renderAlbum();
  }
}

function renderAlbum() {
  albumGridEl.innerHTML = "";

  const visibleEntries = albumOrder
    .map((key) => albumEntries.get(key))
    .filter((item) => {
      if (!item?.displayUrl) return false;
      if (selectedOwnerFilter && item.ownerUserId !== selectedOwnerFilter) return false;
      if (selectedAlbumFilter && item.album !== selectedAlbumFilter) return false;
      if (publicOnlyFilter && !item.isPublic) return false;
      return true;
    });

  if (visibleEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "album-empty";

    if (albumOrder.length === 0) {
      empty.textContent = "No photos yet. Capture or upload one.";
    } else {
      const ownerLabel = selectedOwnerFilter ? " for selected user" : "";
      const albumLabel = selectedAlbumFilter ? ` in album \"${selectedAlbumFilter}\"` : "";
      const publicLabel = publicOnlyFilter ? " (public only)" : "";
      empty.textContent = `No visible photos${ownerLabel}${albumLabel}${publicLabel}.`;
    }

    albumGridEl.appendChild(empty);
    return;
  }

  visibleEntries.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "album-item";
    card.addEventListener("click", () => {
      openPhotoPreview(item.displayUrl, item.key);
    });

    const img = document.createElement("img");
    img.addEventListener("error", () => {
      removeAlbumEntry(item.key);
    });
    img.src = item.displayUrl;
    img.alt = item.key || "Captured photo";
    card.appendChild(img);

    const meta = document.createElement("span");
    meta.className = "album-meta";
    const time = formatAlbumTime(item.createdAt);
    const ownerLabel = item.ownerUsername || "user";
    const info = [ownerLabel, item.album || "general"];
    if (item.isPublic) info.push("public");
    if (time) info.push(time);
    meta.textContent = info.join(" · ");
    card.appendChild(meta);

    albumGridEl.appendChild(card);
  });
}

function openPhotoPreview(url, key = "Photo preview") {
  if (!url) return;
  previewImageEl.src = url;
  previewImageEl.alt = key;
  previewModalEl.hidden = false;
}

function setCameraControlsEnabled(enabled) {
  const authenticated = Boolean(enabled && authUser);
  const canCapture = authenticated && Boolean(stream);

  captureButton.disabled = !canCapture;
  flipButton.disabled = !canCapture || !hasMultipleCameras;
  uploadFilesButton.disabled = !authenticated;

  albumInput.disabled = !authenticated;
  publicToggleInput.disabled = !authenticated;
}

function stopCameraStream() {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

async function refreshCameraCount() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    hasMultipleCameras = true;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameraCount = devices.filter((device) => device.kind === "videoinput").length;
    hasMultipleCameras = cameraCount > 1;
  } catch {
    hasMultipleCameras = true;
  }
}

async function startCamera(requestedFacingMode = currentFacingMode) {
  stopCameraStream();

  const candidateModes = Array.from(
    new Set([requestedFacingMode, requestedFacingMode === "environment" ? "user" : "environment"])
  );

  for (const facingMode of candidateModes) {
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      stream = nextStream;
      currentFacingMode = facingMode;
      video.srcObject = stream;
      await video.play();

      await refreshCameraCount();
      setCameraControlsEnabled(true);
      setStatus(`Camera ready (${cameraLabel(currentFacingMode)}).`);
      return true;
    } catch (error) {
      console.error(error);
    }
  }

  setCameraControlsEnabled(true);
  setStatus("Unable to access camera. You can still upload from device.", true);
  return false;
}

async function flipCamera() {
  if (!authUser || !stream) return;

  const previousFacingMode = currentFacingMode;
  const nextFacingMode = currentFacingMode === "environment" ? "user" : "environment";
  setStatus(`Switching to ${cameraLabel(nextFacingMode)} camera...`);
  setCameraControlsEnabled(false);

  const started = await startCamera(nextFacingMode);
  if (!started) return;

  if (currentFacingMode === previousFacingMode) {
    setStatus(`Could not switch cameras. Staying on ${cameraLabel(previousFacingMode)} camera.`, true);
    return;
  }

  setStatus(`Using ${cameraLabel(currentFacingMode)} camera.`);
}

function parseErrorBody(body, fallback) {
  if (body && typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }
  return fallback;
}

async function login(username, password) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("Username is required.");
  }
  if (!isValidUsername(normalizedUsername)) {
    throw new Error(USERNAME_RULES_ERROR);
  }
  if (!password) {
    throw new Error("Password is required.");
  }

  const res = await fetch("/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Username": normalizedUsername,
      "X-Password": password
    },
    body: JSON.stringify({ username: normalizedUsername, password })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, `Login failed (${res.status}).`));
  }

  const payload = await res.json();
  authToken = payload.token;
  authUser = payload.user;

  localStorage.setItem(TOKEN_KEY, authToken);
  localStorage.setItem(USERNAME_KEY, authUser.username);

  setSessionUi();

  if (Array.isArray(payload.visibleUsers)) {
    payload.visibleUsers.forEach((owner) => registerOwner(owner.id, owner.username));
  }
}

async function fetchMe() {
  if (!authToken) return null;

  const res = await fetch("/api/me", {
    headers: authHeaders(false)
  });

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
    }
    return null;
  }

  const payload = await res.json();
  authUser = payload.user;
  localStorage.setItem(USERNAME_KEY, authUser.username);

  if (Array.isArray(payload.visibleUsers)) {
    payload.visibleUsers.forEach((owner) => registerOwner(owner.id, owner.username));
  }

  setSessionUi();
  syncOwnerFilterOptions();
  return payload;
}

async function loadRecentUploads() {
  if (!authToken || !authUser) return;

  const url = new URL("/api/photos", window.location.origin);
  url.searchParams.set("limit", "240");

  const res = await fetch(`${url.pathname}${url.search}`, {
    headers: authHeaders(false)
  });

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      setStatus("Session expired. Please sign in again.", true);
    }
    return;
  }

  const payload = await res.json();
  const photos = Array.isArray(payload?.photos) ? payload.photos : [];
  const albums = Array.isArray(payload?.albums) ? payload.albums : [];
  const owners = Array.isArray(payload?.owners) ? payload.owners : [];

  albums.forEach(registerAlbum);
  owners.forEach((owner) => registerOwner(owner.id, owner.username));

  photos
    .slice()
    .reverse()
    .forEach((photo) => {
      if (!photo?.key) return;

      const existing = albumEntries.get(photo.key);
      const ownerUserId = typeof photo.userId === "string" ? photo.userId : existing?.ownerUserId || "";
      const ownerUsername =
        normalizeUsername(photo.ownerUsername || photo.uploaderName || "") ||
        normalizeUsername(existing?.ownerUsername || "") ||
        knownOwners.get(ownerUserId) ||
        "";

      if (ownerUserId) registerOwner(ownerUserId, ownerUsername || ownerUserId);

      upsertAlbumEntry(
        {
          key: photo.key,
          createdAt: photo.createdAt,
          displayUrl: photo.viewUrl || photo.publicUrl || existing?.displayUrl || "",
          viewUrl: photo.viewUrl || existing?.viewUrl || null,
          publicUrl: photo.publicUrl || existing?.publicUrl || null,
          album: photo.album || existing?.album || "general",
          isPublic: parseBooleanFlag(photo.isPublic, existing?.isPublic ?? false),
          ownerUserId,
          ownerUsername,
          isLocalPreview: !(photo.viewUrl || photo.publicUrl) && Boolean(existing?.isLocalPreview)
        },
        { promote: !existing, render: false }
      );
    });

  syncAlbumFilterOptions();
  syncOwnerFilterOptions();
  renderAlbum();
}

function captureBlob() {
  return new Promise((resolve, reject) => {
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      reject(new Error("Camera stream is not ready yet."));
      return;
    }

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not capture image."));
          return;
        }

        resolve({ blob, width, height });
      },
      "image/jpeg",
      0.92
    );
  });
}

async function readImageDimensions(file) {
  if (!(file instanceof Blob)) {
    return { width: null, height: null };
  }

  if (typeof createImageBitmap !== "function") {
    return { width: null, height: null };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null
    };
  } catch {
    return { width: null, height: null };
  }
}

async function getUploadUrl(contentType, fileSize, uploadOptions) {
  const normalizedContentType = normalizeImageContentType(contentType);
  const normalizedFileSize = normalizeFileSize(fileSize);

  const res = await fetch("/api/upload-url", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "X-Content-Type": normalizedContentType,
      "X-File-Size": String(normalizedFileSize),
      "X-Album": uploadOptions.album,
      "X-Is-Public": uploadOptions.isPublic ? "true" : "false"
    },
    body: JSON.stringify({
      contentType: normalizedContentType,
      fileSize: normalizedFileSize,
      album: uploadOptions.album,
      isPublic: uploadOptions.isPublic
    })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, "Could not get upload URL."));
  }

  return res.json();
}

async function saveMetadata(payload) {
  const res = await fetch("/api/photos", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, "Could not save metadata."));
  }

  return res.json();
}

async function uploadViaSignedUrl(blob, width, height, capturedAt, uploadOptions) {
  const contentType = normalizeImageContentType(blob.type);
  const uploadInfo = await getUploadUrl(contentType, blob.size, uploadOptions);

  const uploadRes = await fetch(uploadInfo.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType
    },
    body: blob
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed (${uploadRes.status}).`);
  }

  return saveMetadata({
    key: uploadInfo.key,
    contentType,
    sizeBytes: blob.size,
    width,
    height,
    capturedAt,
    publicUrl: uploadInfo.publicUrl,
    album: uploadInfo.album || uploadOptions.album,
    isPublic: parseBooleanFlag(uploadInfo.isPublic, uploadOptions.isPublic)
  });
}

async function uploadViaServer(blob, width, height, capturedAt, uploadOptions) {
  const contentType = normalizeImageContentType(blob.type);

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": contentType,
      "X-Captured-At": capturedAt,
      "X-Image-Width": width ? String(width) : "",
      "X-Image-Height": height ? String(height) : "",
      "X-Album": uploadOptions.album,
      "X-Is-Public": uploadOptions.isPublic ? "true" : "false"
    },
    body: blob
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, `Proxy upload failed (${res.status}).`));
  }

  return res.json();
}

async function uploadSingleBlob(blob, width, height, capturedAt, uploadOptions) {
  let uploadedPhoto = null;

  try {
    uploadedPhoto = await uploadViaServer(blob, width, height, capturedAt, uploadOptions);
  } catch (relayError) {
    const relayMessage = String(relayError?.message || "");
    if (!/too large|413/i.test(relayMessage)) {
      throw relayError;
    }

    setStatus("Server relay size limit reached. Trying direct upload...");
    uploadedPhoto = await uploadViaSignedUrl(blob, width, height, capturedAt, uploadOptions);
  }

  if (uploadedPhoto?.key) {
    const remoteViewUrl = uploadedPhoto.viewUrl || uploadedPhoto.publicUrl || null;
    const localPreviewUrl = remoteViewUrl ? null : URL.createObjectURL(blob);

    upsertAlbumEntry({
      key: uploadedPhoto.key,
      createdAt: uploadedPhoto.createdAt || capturedAt,
      displayUrl: remoteViewUrl || localPreviewUrl || "",
      viewUrl: uploadedPhoto.viewUrl || null,
      publicUrl: uploadedPhoto.publicUrl || null,
      album: uploadedPhoto.album || uploadOptions.album,
      isPublic: parseBooleanFlag(uploadedPhoto.isPublic, uploadOptions.isPublic),
      ownerUserId: uploadedPhoto.userId || authUser?.id || "",
      ownerUsername:
        normalizeUsername(uploadedPhoto.ownerUsername || uploadedPhoto.uploaderName || "") ||
        authUser?.username ||
        "",
      isLocalPreview: !remoteViewUrl
    });
  }

  return uploadedPhoto;
}

function shouldClearSessionForError(message) {
  return /unauthorized|401|session expired/i.test(String(message || ""));
}

async function captureAndUpload() {
  if (!authUser) {
    setStatus("Sign in required.", true);
    return;
  }

  if (!stream) {
    setStatus("Camera is not ready. You can still upload from device.", true);
    return;
  }

  setCameraControlsEnabled(false);

  try {
    const uploadOptions = currentUploadOptions();

    setStatus("Capturing photo...");
    const { blob, width, height } = await captureBlob();
    const capturedAt = new Date().toISOString();

    setStatus(`Uploading to album \"${uploadOptions.album}\"...`);
    await uploadSingleBlob(blob, width, height, capturedAt, uploadOptions);
    await loadRecentUploads();

    setStatus(`Uploaded to ${uploadOptions.album}${uploadOptions.isPublic ? " (public)." : "."}`);
  } catch (error) {
    console.error(error);

    if (shouldClearSessionForError(error?.message)) {
      clearSession();
    }

    setStatus(error.message || "Upload failed.", true);
  } finally {
    if (authUser) setCameraControlsEnabled(true);
  }
}

async function uploadFilesFromDevice(fileList) {
  if (!authUser) {
    setStatus("Sign in required.", true);
    return;
  }

  const files = Array.from(fileList || []).filter((file) => file && String(file.type).startsWith("image/"));
  if (files.length === 0) {
    setStatus("Select one or more image files.", true);
    return;
  }

  setCameraControlsEnabled(false);
  let uploadedCount = 0;

  try {
    const uploadOptions = currentUploadOptions();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setStatus(`Uploading (${index + 1}/${files.length}) ${file.name}`);

      const { width, height } = await readImageDimensions(file);
      const capturedAt =
        Number.isFinite(file.lastModified) && file.lastModified > 0
          ? new Date(file.lastModified).toISOString()
          : new Date().toISOString();

      await uploadSingleBlob(file, width, height, capturedAt, uploadOptions);
      uploadedCount += 1;
    }

    await loadRecentUploads();
    setStatus(`Uploaded ${uploadedCount} photo${uploadedCount === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error(error);

    if (shouldClearSessionForError(error?.message)) {
      clearSession();
    }

    setStatus(error.message || "Upload failed.", true);
  } finally {
    filePickerInput.value = "";
    if (authUser) setCameraControlsEnabled(true);
  }
}

function splitCsvList(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderAdminUsers(users) {
  adminUsersListEl.innerHTML = "";

  if (!Array.isArray(users) || users.length === 0) {
    const empty = document.createElement("p");
    empty.className = "album-empty";
    empty.textContent = "No users configured yet.";
    adminUsersListEl.appendChild(empty);
    return;
  }

  users.forEach((user) => {
    const card = document.createElement("div");
    card.className = "admin-user-card";

    const head = document.createElement("div");
    head.className = "admin-user-head";
    head.textContent = user.username;

    const meta = document.createElement("span");
    meta.className = "admin-user-meta";
    meta.textContent = user.id;
    head.appendChild(meta);
    card.appendChild(head);

    const roleRow = document.createElement("div");
    roleRow.className = "admin-user-row";
    const roleLabel = document.createElement("label");
    roleLabel.textContent = "Role";
    const roleSelect = document.createElement("select");
    roleSelect.innerHTML = '<option value="user">User</option><option value="admin">Admin</option>';
    roleSelect.value = user.role === "admin" ? "admin" : "user";
    roleRow.appendChild(roleLabel);
    roleRow.appendChild(roleSelect);
    card.appendChild(roleRow);

    const activeRow = document.createElement("label");
    activeRow.className = "check-row";
    const activeInput = document.createElement("input");
    activeInput.type = "checkbox";
    activeInput.checked = Boolean(user.active);
    const activeText = document.createElement("span");
    activeText.textContent = "Account active";
    activeRow.appendChild(activeInput);
    activeRow.appendChild(activeText);
    card.appendChild(activeRow);

    const linksRow = document.createElement("div");
    linksRow.className = "admin-user-row";
    const linksLabel = document.createElement("label");
    linksLabel.textContent = "Shared with users (comma usernames)";
    const linksInput = document.createElement("input");
    linksInput.type = "text";
    linksInput.value = Array.isArray(user.linkedUsernames) ? user.linkedUsernames.join(", ") : "";
    linksRow.appendChild(linksLabel);
    linksRow.appendChild(linksInput);
    card.appendChild(linksRow);

    const passwordRow = document.createElement("div");
    passwordRow.className = "admin-user-row";
    const passwordLabel = document.createElement("label");
    passwordLabel.textContent = "Reset password (optional)";
    const passwordResetInput = document.createElement("input");
    passwordResetInput.type = "password";
    passwordResetInput.placeholder = "Leave blank to keep current";
    passwordRow.appendChild(passwordLabel);
    passwordRow.appendChild(passwordResetInput);
    card.appendChild(passwordRow);

    const actions = document.createElement("div");
    actions.className = "admin-user-actions";
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Save User";
    actions.appendChild(saveButton);
    card.appendChild(actions);

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        const payload = {
          role: roleSelect.value,
          active: activeInput.checked,
          linkedUsers: splitCsvList(linksInput.value)
        };

        if (passwordResetInput.value.trim()) {
          payload.password = passwordResetInput.value;
        }

        const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(parseErrorBody(body, `Failed to update user (${res.status}).`));
        }

        const data = await res.json();
        passwordResetInput.value = "";
        renderAdminUsers(Array.isArray(data.users) ? data.users : []);
        setAdminStatus(`Saved ${user.username}.`);

        await fetchMe();
        await loadRecentUploads();
      } catch (error) {
        setAdminStatus(error.message || "Failed to update user.", true);
      } finally {
        saveButton.disabled = false;
      }
    });

    adminUsersListEl.appendChild(card);
  });
}

async function loadAdminUsers() {
  if (!isAdmin() || !authToken) {
    adminUsersListEl.innerHTML = "";
    setAdminStatus("");
    return;
  }

  const res = await fetch("/api/admin/users", {
    headers: authHeaders(false)
  });

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      setStatus("Session expired. Please sign in again.", true);
      return;
    }
    const body = await res.json().catch(() => null);
    setAdminStatus(parseErrorBody(body, `Could not load users (${res.status}).`), true);
    return;
  }

  const data = await res.json();
  renderAdminUsers(Array.isArray(data.users) ? data.users : []);
}

async function restoreSession() {
  if (!authToken) {
    setStatus("Locked. Sign in to start.");
    return;
  }

  setStatus("Restoring session...");
  const me = await fetchMe();
  if (!me?.user) {
    setStatus("Session expired. Please sign in again.", true);
    return;
  }

  await startCamera();
  await loadRecentUploads();
  await loadAdminUsers();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await login(usernameInput.value, passwordInput.value);
    passwordInput.value = "";

    setStatus("Signed in. Starting camera...");
    await startCamera();
    await loadRecentUploads();
    await loadAdminUsers();
  } catch (error) {
    setStatus(error.message || "Sign in failed.", true);
  }
});

logoutButton.addEventListener("click", () => {
  clearSession();
  setStatus("Signed out.");
});

captureButton.addEventListener("click", captureAndUpload);
flipButton.addEventListener("click", flipCamera);

uploadFilesButton.addEventListener("click", () => {
  if (!authUser) {
    setStatus("Sign in required.", true);
    return;
  }
  filePickerInput.click();
});

filePickerInput.addEventListener("change", () => {
  uploadFilesFromDevice(filePickerInput.files);
});

albumInput.addEventListener("blur", () => {
  albumInput.value = normalizeAlbum(albumInput.value);
  localStorage.setItem(ALBUM_KEY, albumInput.value);
});

albumInput.addEventListener("change", () => {
  albumInput.value = normalizeAlbum(albumInput.value);
  localStorage.setItem(ALBUM_KEY, albumInput.value);
  registerAlbum(albumInput.value);
  syncAlbumFilterOptions();
});

publicToggleInput.addEventListener("change", () => {
  localStorage.setItem(PUBLIC_UPLOAD_KEY, publicToggleInput.checked ? "1" : "0");
});

ownerFilterSelect.addEventListener("change", updateFiltersFromUi);
albumFilterSelect.addEventListener("change", updateFiltersFromUi);
publicOnlyFilterInput.addEventListener("change", updateFiltersFromUi);

previewCloseEl.addEventListener("click", closePhotoPreview);
previewBackdropEl.addEventListener("click", closePhotoPreview);
previewImageEl.addEventListener("error", closePhotoPreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePhotoPreview();
});

createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isAdmin()) {
    setAdminStatus("Admin access required.", true);
    return;
  }

  const username = normalizeUsername(newUserUsernameInput.value);
  const password = newUserPasswordInput.value;
  const role = newUserRoleSelect.value === "admin" ? "admin" : "user";

  if (!username) {
    setAdminStatus("Username is required.", true);
    return;
  }
  if (!isValidUsername(username)) {
    setAdminStatus(USERNAME_RULES_ERROR, true);
    return;
  }

  if (password.length < 4) {
    setAdminStatus("Password must be at least 4 characters.", true);
    return;
  }

  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ username, password, role })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(parseErrorBody(body, `Could not create user (${res.status}).`));
    }

    const data = await res.json();
    setAdminStatus(`Created user ${username}.`);

    newUserUsernameInput.value = "";
    newUserPasswordInput.value = "";
    newUserRoleSelect.value = "user";

    renderAdminUsers(Array.isArray(data.users) ? data.users : []);
    await loadAdminUsers();
  } catch (error) {
    setAdminStatus(error.message || "Could not create user.", true);
  }
});

setSessionUi();
setCameraControlsEnabled(false);

usernameInput.value = normalizeUsername(localStorage.getItem(USERNAME_KEY) || "");
albumInput.value = normalizeAlbum(localStorage.getItem(ALBUM_KEY) || "general");
publicToggleInput.checked = parseBooleanFlag(localStorage.getItem(PUBLIC_UPLOAD_KEY), false);
publicOnlyFilterInput.checked = publicOnlyFilter;

registerAlbum("general");
syncAlbumFilterOptions();
syncOwnerFilterOptions();
renderAlbum();

restoreSession().catch((error) => {
  console.error(error);
  setStatus("Could not restore session.", true);
});
