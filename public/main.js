const loginForm = document.getElementById("login-form");
const passcodeInput = document.getElementById("passcode");
const captureButton = document.getElementById("capture");
const flipButton = document.getElementById("flip-camera");
const video = document.getElementById("preview");
const canvas = document.getElementById("capture-canvas");
const statusEl = document.getElementById("status");
const albumGridEl = document.getElementById("album-grid");
const previewModalEl = document.getElementById("preview-modal");
const previewBackdropEl = document.getElementById("preview-backdrop");
const previewCloseEl = document.getElementById("preview-close");
const previewImageEl = document.getElementById("preview-image");

const TOKEN_KEY = "onlineCameraToken";
const MAX_ALBUM_ITEMS = 40;
let authToken = localStorage.getItem(TOKEN_KEY) || "";
let stream = null;
let currentFacingMode = "environment";
let hasMultipleCameras = true;
const albumEntries = new Map();
const albumOrder = [];

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

function normalizeImageContentType(value) {
  const normalized = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
  return normalized || "image/jpeg";
}

function normalizeFileSize(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function cameraLabel(facingMode) {
  return facingMode === "user" ? "front" : "rear";
}

function formatAlbumTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderAlbum() {
  albumGridEl.innerHTML = "";
  let renderedCount = 0;

  if (albumOrder.length === 0) {
    const empty = document.createElement("p");
    empty.className = "album-empty";
    empty.textContent = "No photos yet. Take one and it will appear here.";
    albumGridEl.appendChild(empty);
    return;
  }

  albumOrder.forEach((key) => {
    const item = albumEntries.get(key);
    if (!item?.displayUrl) return;

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
    meta.textContent = time || "Photo";
    card.appendChild(meta);

    albumGridEl.appendChild(card);
    renderedCount += 1;
  });

  if (renderedCount === 0) {
    const empty = document.createElement("p");
    empty.className = "album-empty";
    empty.textContent = "No preview available for older photos yet.";
    albumGridEl.appendChild(empty);
  }
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
  const merged = {
    ...existing,
    ...nextEntry,
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
  if (render) renderAlbum();
}

function setCameraControlsEnabled(enabled) {
  captureButton.disabled = !enabled;
  flipButton.disabled = !enabled || !hasMultipleCameras;
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
  const res = await fetch("/api/photos", {
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  });

  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      authToken = "";
      stopCameraStream();
      setCameraControlsEnabled(false);
      closePhotoPreview();
      setStatus("Session expired. Enter passcode again.", true);
    }
    return;
  }

  const { photos } = await res.json();
  photos
    .slice(0, 30)
    .reverse()
    .forEach((photo) => {
      const existing = albumEntries.get(photo.key);
      upsertAlbumEntry(
        {
          key: photo.key,
          createdAt: photo.createdAt,
          displayUrl: photo.publicUrl || existing?.displayUrl || "",
          publicUrl: photo.publicUrl || existing?.publicUrl || null,
          isLocalPreview: !photo.publicUrl && Boolean(existing?.isLocalPreview)
        },
        { promote: !existing, render: false }
      );
    });
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

  setCameraControlsEnabled(false);
  setStatus("Unable to access camera. Allow camera permission in Safari.", true);
  return false;
}

async function flipCamera() {
  if (!authToken) return;

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
  const res = await fetch("/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Passcode": passcode
    },
    body: JSON.stringify({ passcode })
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

async function getUploadUrl(contentType, fileSize) {
  const normalizedContentType = normalizeImageContentType(contentType);
  const normalizedFileSize = normalizeFileSize(fileSize);
  const res = await fetch("/api/upload-url", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "X-Content-Type": normalizedContentType,
      "X-File-Size": String(normalizedFileSize)
    },
    body: JSON.stringify({ contentType: normalizedContentType, fileSize: normalizedFileSize })
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

async function uploadViaSignedUrl(blob, width, height, capturedAt) {
  const contentType = normalizeImageContentType(blob.type);
  const uploadInfo = await getUploadUrl(contentType, blob.size);
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
    publicUrl: uploadInfo.publicUrl
  });
}

async function uploadViaServer(blob, width, height, capturedAt) {
  const contentType = normalizeImageContentType(blob.type);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": contentType,
      "X-Captured-At": capturedAt,
      "X-Image-Width": String(width),
      "X-Image-Height": String(height)
    },
    body: blob
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Proxy upload failed." }));
    throw new Error(body.error || `Proxy upload failed (${res.status}).`);
  }
  return res.json();
}

async function captureAndUpload() {
  setCameraControlsEnabled(false);
  try {
    setStatus("Capturing photo...");
    const { blob, width, height } = await captureBlob();
    const capturedAt = new Date().toISOString();
    setStatus("Preparing upload...");
    let uploadedPhoto = null;
    try {
      uploadedPhoto = await uploadViaServer(blob, width, height, capturedAt);
      setStatus("Uploaded successfully (server relay).");
    } catch (relayError) {
      const relayMessage = String(relayError?.message || "");
      if (!/too large|413/i.test(relayMessage)) {
        throw relayError;
      }

      // For large files, try direct signed upload as a fallback path.
      setStatus("Server relay size limit reached. Trying direct upload...");
      uploadedPhoto = await uploadViaSignedUrl(blob, width, height, capturedAt);
      setStatus("Uploaded successfully (direct upload).");
    }

    if (uploadedPhoto?.key) {
      const localPreviewUrl = uploadedPhoto.publicUrl ? null : URL.createObjectURL(blob);
      upsertAlbumEntry({
        key: uploadedPhoto.key,
        createdAt: uploadedPhoto.createdAt || capturedAt,
        displayUrl: uploadedPhoto.publicUrl || localPreviewUrl || "",
        publicUrl: uploadedPhoto.publicUrl || null,
        isLocalPreview: !uploadedPhoto.publicUrl
      });
    }

    await loadRecentUploads();
  } catch (error) {
    console.error(error);
    if (error.message.includes("Unauthorized")) {
      localStorage.removeItem(TOKEN_KEY);
      authToken = "";
      stopCameraStream();
      setCameraControlsEnabled(false);
    }
    setStatus(error.message || "Upload failed.", true);
  } finally {
    if (authToken && stream) setCameraControlsEnabled(true);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await login(passcodeInput.value);
    passcodeInput.value = "";
    setStatus("Logged in. Starting camera...");
    const started = await startCamera();
    if (started) await loadRecentUploads();
  } catch (error) {
    setStatus(error.message, true);
  }
});

captureButton.addEventListener("click", captureAndUpload);
flipButton.addEventListener("click", flipCamera);
previewCloseEl.addEventListener("click", closePhotoPreview);
previewBackdropEl.addEventListener("click", closePhotoPreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePhotoPreview();
});

setCameraControlsEnabled(false);
renderAlbum();

if (authToken) {
  setStatus("Restoring session...");
  startCamera()
    .then((started) => {
      if (started) return loadRecentUploads();
      return null;
    })
    .catch(() => {
      setStatus("Session found, but camera failed to start.", true);
    });
}
