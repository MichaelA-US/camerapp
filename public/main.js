const loginForm = document.getElementById("login-form");
const nameInput = document.getElementById("photographer-name");
const passcodeInput = document.getElementById("passcode");
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
const albumFilterSelect = document.getElementById("album-filter");
const publicOnlyFilterInput = document.getElementById("public-only-filter");
const previewModalEl = document.getElementById("preview-modal");
const previewBackdropEl = document.getElementById("preview-backdrop");
const previewCloseEl = document.getElementById("preview-close");
const previewImageEl = document.getElementById("preview-image");

const TOKEN_KEY = "onlineCameraToken";
const NAME_KEY = "onlineCameraName";
const ALBUM_KEY = "onlineCameraAlbum";
const PUBLIC_UPLOAD_KEY = "onlineCameraPublicUpload";
const FILTER_ALBUM_KEY = "onlineCameraFilterAlbum";
const FILTER_PUBLIC_KEY = "onlineCameraFilterPublic";
const MAX_ALBUM_ITEMS = 60;

let authToken = localStorage.getItem(TOKEN_KEY) || "";
let photographerName = localStorage.getItem(NAME_KEY) || "";
let stream = null;
let currentFacingMode = "environment";
let hasMultipleCameras = true;
let selectedAlbumFilter = normalizeOptionalAlbum(localStorage.getItem(FILTER_ALBUM_KEY));
let publicOnlyFilter = parseBooleanFlag(localStorage.getItem(FILTER_PUBLIC_KEY), false);

const albumEntries = new Map();
const albumOrder = [];
const knownAlbums = new Set();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`
  };
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

function normalizeOptionalAlbum(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? normalizeAlbum(trimmed) : "";
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

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  authToken = "";
  stopCameraStream();
  setCameraControlsEnabled(false);
  closePhotoPreview();
}

function registerAlbum(value) {
  knownAlbums.add(normalizeAlbum(value));
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

function updateAlbumFiltersFromUi() {
  selectedAlbumFilter = normalizeOptionalAlbum(albumFilterSelect.value);
  publicOnlyFilter = Boolean(publicOnlyFilterInput.checked);
  localStorage.setItem(FILTER_ALBUM_KEY, selectedAlbumFilter);
  localStorage.setItem(FILTER_PUBLIC_KEY, publicOnlyFilter ? "1" : "0");
  renderAlbum();
}

function renderAlbum() {
  albumGridEl.innerHTML = "";

  const visibleEntries = albumOrder
    .map((key) => albumEntries.get(key))
    .filter((item) => {
      if (!item?.displayUrl) return false;
      if (selectedAlbumFilter && item.album !== selectedAlbumFilter) return false;
      if (publicOnlyFilter && !item.isPublic) return false;
      return true;
    });

  if (visibleEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "album-empty";

    if (albumOrder.length === 0) {
      empty.textContent = "No photos yet. Take one or upload from device.";
    } else {
      const albumLabel = selectedAlbumFilter ? ` in album \"${selectedAlbumFilter}\"` : "";
      const publicLabel = publicOnlyFilter ? " (public only)" : "";
      empty.textContent = `No visible photos${albumLabel}${publicLabel}.`;
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
    img.src = item.displayUrl;
    img.alt = item.key || "Captured photo";
    card.appendChild(img);

    const meta = document.createElement("span");
    meta.className = "album-meta";
    const time = formatAlbumTime(item.createdAt);
    const info = [item.album || "general"];
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

function closePhotoPreview() {
  if (previewModalEl.hidden) return;
  previewModalEl.hidden = true;
  previewImageEl.removeAttribute("src");
}

function trimAlbumEntries() {
  while (albumOrder.length > MAX_ALBUM_ITEMS) {
    const key = albumOrder.pop();
    if (!key) continue;

    const entry = albumEntries.get(key);
    if (entry?.isLocalPreview && typeof entry.displayUrl === "string" && entry.displayUrl.startsWith("blob:")) {
      URL.revokeObjectURL(entry.displayUrl);
    }

    albumEntries.delete(key);
  }
}

function upsertAlbumEntry(nextEntry, { promote = true, render = true } = {}) {
  if (!nextEntry?.key) return;

  const existing = albumEntries.get(nextEntry.key);
  const existingIndex = albumOrder.indexOf(nextEntry.key);
  const normalizedAlbum = normalizeAlbum(nextEntry.album || existing?.album);

  registerAlbum(normalizedAlbum);

  const merged = {
    ...existing,
    ...nextEntry,
    album: normalizedAlbum,
    isPublic: parseBooleanFlag(nextEntry.isPublic, existing?.isPublic ?? false),
    uploaderName: normalizeName(nextEntry.uploaderName || existing?.uploaderName || ""),
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
    renderAlbum();
  }
}

function setCameraControlsEnabled(enabled) {
  const canCapture = enabled && Boolean(stream);
  captureButton.disabled = !canCapture;
  flipButton.disabled = !canCapture || !hasMultipleCameras;
  uploadFilesButton.disabled = !enabled;
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

async function loadRecentUploads() {
  if (!authToken) return;

  const url = new URL("/api/photos", window.location.origin);
  url.searchParams.set("limit", "200");

  const res = await fetch(`${url.pathname}${url.search}`, {
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  });

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      setStatus("Session expired. Enter passcode again.", true);
    }
    return;
  }

  const payload = await res.json();
  const photos = Array.isArray(payload?.photos) ? payload.photos : [];
  const albums = Array.isArray(payload?.albums) ? payload.albums : [];

  albums.forEach(registerAlbum);

  photos
    .slice()
    .reverse()
    .forEach((photo) => {
      if (!photo?.key) return;

      const existing = albumEntries.get(photo.key);
      upsertAlbumEntry(
        {
          key: photo.key,
          createdAt: photo.createdAt,
          displayUrl: photo.publicUrl || existing?.displayUrl || "",
          publicUrl: photo.publicUrl || existing?.publicUrl || null,
          album: photo.album || existing?.album || "general",
          isPublic: parseBooleanFlag(photo.isPublic, existing?.isPublic ?? false),
          uploaderName: photo.uploaderName || existing?.uploaderName || "",
          isLocalPreview: !photo.publicUrl && Boolean(existing?.isLocalPreview)
        },
        { promote: !existing, render: false }
      );
    });

  syncAlbumFilterOptions();
  renderAlbum();
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
      setCameraControlsEnabled(Boolean(authToken));
      setStatus(`Camera ready (${cameraLabel(currentFacingMode)}). Photos upload directly to cloud.`);
      return true;
    } catch (error) {
      console.error(error);
    }
  }

  setCameraControlsEnabled(Boolean(authToken));
  setStatus("Unable to access camera. You can still upload photos from device.", true);
  return false;
}

async function flipCamera() {
  if (!authToken || !stream) return;

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

async function login(passcode) {
  const normalizedName = normalizeName(nameInput.value);
  if (!normalizedName) {
    throw new Error("Name is required.");
  }

  const res = await fetch("/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Passcode": passcode,
      "X-Uploader-Name": normalizedName
    },
    body: JSON.stringify({ passcode, name: normalizedName })
  });

  if (!res.ok) {
    let errorMessage = `Login failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) errorMessage = body.error;
    } catch {
      try {
        const text = await res.text();
        if (text) errorMessage = `${errorMessage} ${text}`;
      } catch {
        // ignore parse errors
      }
    }
    throw new Error(errorMessage);
  }

  const payload = await res.json();
  authToken = payload.token;
  localStorage.setItem(TOKEN_KEY, authToken);
  photographerName = normalizeName(payload.name || normalizedName);
  localStorage.setItem(NAME_KEY, photographerName);
  nameInput.value = photographerName;
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

        resolve({
          blob,
          width,
          height
        });
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
    const body = await res.json().catch(() => ({ error: "Could not get upload URL." }));
    throw new Error(body.error || "Could not get upload URL.");
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
    const body = await res.json().catch(() => ({ error: "Could not save metadata." }));
    throw new Error(body.error || "Could not save metadata.");
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
    const body = await res.json().catch(() => ({ error: "Proxy upload failed." }));
    throw new Error(body.error || `Proxy upload failed (${res.status}).`);
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
    const localPreviewUrl = uploadedPhoto.publicUrl ? null : URL.createObjectURL(blob);
    upsertAlbumEntry({
      key: uploadedPhoto.key,
      createdAt: uploadedPhoto.createdAt || capturedAt,
      displayUrl: uploadedPhoto.publicUrl || localPreviewUrl || "",
      publicUrl: uploadedPhoto.publicUrl || null,
      album: uploadedPhoto.album || uploadOptions.album,
      isPublic: parseBooleanFlag(uploadedPhoto.isPublic, uploadOptions.isPublic),
      uploaderName: uploadedPhoto.uploaderName || photographerName,
      isLocalPreview: !uploadedPhoto.publicUrl
    });
  }

  return uploadedPhoto;
}

function shouldClearSessionForError(message) {
  return /unauthorized|401|session expired/i.test(String(message || ""));
}

async function captureAndUpload() {
  if (!authToken) {
    setStatus("Login required.", true);
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
    if (authToken) setCameraControlsEnabled(true);
  }
}

async function uploadFilesFromDevice(fileList) {
  if (!authToken) {
    setStatus("Login required.", true);
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
      const progress = `(${index + 1}/${files.length})`;
      setStatus(`Uploading ${progress} ${file.name}`);

      const { width, height } = await readImageDimensions(file);
      const capturedAt =
        Number.isFinite(file.lastModified) && file.lastModified > 0
          ? new Date(file.lastModified).toISOString()
          : new Date().toISOString();

      await uploadSingleBlob(file, width, height, capturedAt, uploadOptions);
      uploadedCount += 1;
    }

    await loadRecentUploads();
    setStatus(`Uploaded ${uploadedCount} photo${uploadedCount === 1 ? "" : "s"} to ${uploadOptions.album}.`);
  } catch (error) {
    console.error(error);

    if (shouldClearSessionForError(error?.message)) {
      clearSession();
    }

    setStatus(error.message || "Upload failed.", true);
  } finally {
    filePickerInput.value = "";
    if (authToken) setCameraControlsEnabled(true);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await login(passcodeInput.value);
    passcodeInput.value = "";

    setStatus("Logged in. Starting camera...");
    await startCamera();
    await loadRecentUploads();
  } catch (error) {
    setStatus(error.message, true);
  }
});

captureButton.addEventListener("click", captureAndUpload);
flipButton.addEventListener("click", flipCamera);
uploadFilesButton.addEventListener("click", () => {
  if (!authToken) {
    setStatus("Login required.", true);
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

albumFilterSelect.addEventListener("change", updateAlbumFiltersFromUi);
publicOnlyFilterInput.addEventListener("change", updateAlbumFiltersFromUi);

previewCloseEl.addEventListener("click", closePhotoPreview);
previewBackdropEl.addEventListener("click", closePhotoPreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePhotoPreview();
});

setCameraControlsEnabled(false);
registerAlbum("general");

nameInput.value = photographerName;
albumInput.value = normalizeAlbum(localStorage.getItem(ALBUM_KEY) || "general");
publicToggleInput.checked = parseBooleanFlag(localStorage.getItem(PUBLIC_UPLOAD_KEY), false);
publicOnlyFilterInput.checked = publicOnlyFilter;

syncAlbumFilterOptions();
renderAlbum();

if (authToken) {
  setStatus("Restoring session...");
  startCamera()
    .then(() => loadRecentUploads())
    .catch(() => {
      setStatus("Session found, but camera failed to start.", true);
    });
}
