const authGateEl = document.getElementById("auth-gate");
const appShellEl = document.getElementById("app-shell");
const unlockFormEl = document.getElementById("unlock-form");
const unlockPasswordInput = document.getElementById("unlock-password");
const unlockButton = document.getElementById("unlock-button");
const unlockStatusEl = document.getElementById("unlock-status");

const profileNameInput = document.getElementById("profile-name");
const profileHintEl = document.getElementById("profile-hint");
const albumInput = document.getElementById("album-name");
const captureButton = document.getElementById("capture");
const recordVideoButton = document.getElementById("record-video");
const flipButton = document.getElementById("flip-camera");
const uploadFilesButton = document.getElementById("upload-files");
const refreshGalleryButton = document.getElementById("refresh-gallery");
const filePickerInput = document.getElementById("file-picker");

const cameraWrap = document.getElementById("camera-wrap");
const video = document.getElementById("preview");
const canvas = document.getElementById("capture-canvas");
const recordingPillEl = document.getElementById("recording-pill");
const recordingTimeEl = document.getElementById("recording-time");
const focusRingEl = document.getElementById("focus-ring");
const zoomControlsEl = document.getElementById("zoom-controls");
const zoomOutButton = document.getElementById("zoom-out");
const zoomSliderInput = document.getElementById("zoom-slider");
const zoomInButton = document.getElementById("zoom-in");
const zoomValueEl = document.getElementById("zoom-value");
const cameraHintEl = document.getElementById("camera-hint");
const statusEl = document.getElementById("status");

const albumGridEl = document.getElementById("album-grid");
const albumFilterSelect = document.getElementById("album-filter");

const previewModalEl = document.getElementById("preview-modal");
const previewBackdropEl = document.getElementById("preview-backdrop");
const previewCloseEl = document.getElementById("preview-close");
const previewImageEl = document.getElementById("preview-image");
const previewVideoEl = document.getElementById("preview-video");

const NAME_KEY = "onlineCameraProfileName";
const ALBUM_KEY = "onlineCameraAlbum";
const FILTER_ALBUM_KEY = "onlineCameraFilterAlbum";
const DEFAULT_NAME = "camera";
const DEFAULT_ALBUM = "general";
const MAX_ALBUM_ITEMS = 120;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@+\- ]{0,39}$/;
const USERNAME_RULES_ERROR =
  "Names use 1-40 characters with letters, numbers, spaces, dot, underscore, dash, @, or +.";

let stream = null;
let currentFacingMode = "environment";
let hasMultipleCameras = true;
let selectedAlbumFilter = normalizeOptionalAlbum(localStorage.getItem(FILTER_ALBUM_KEY));
let activeVideoTrack = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingMimeType = "";
let recordingStartedAt = 0;
let recordingTimerId = 0;
let recordingAudioStream = null;
let recordingUploadOptions = null;
let recordingFinalizePromise = null;
let zoomCapabilities = {
  supported: false,
  min: 1,
  max: 1,
  step: 0.1,
  value: 1
};
let focusCapabilities = {
  canFocusPoint: false,
  canRefocus: false,
  preferredMode: ""
};
let focusRingTimeoutId = 0;
let queuedZoomValue = null;
let zoomUpdateInFlight = false;
let pinchStartDistance = 0;
let pinchStartZoom = 1;
let recentPinchAt = 0;

const albumEntries = new Map();
const albumOrder = [];
const knownAlbums = new Set();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setUnlockStatus(message, isError = false) {
  unlockStatusEl.textContent = message;
  unlockStatusEl.classList.toggle("error", isError);
}

function applyAuthenticationState(nextAuthenticated) {
  const unlocked = Boolean(nextAuthenticated);
  authGateEl.hidden = unlocked;
  appShellEl.hidden = !unlocked;
  document.body.classList.toggle("is-locked", !unlocked);

  if (!unlocked) {
    closePhotoPreview();
    stopCameraStream();
    setCameraControlsEnabled(false);
    window.setTimeout(() => {
      if (!authGateEl.hidden) {
        unlockPasswordInput.focus();
      }
    }, 0);
  }
}

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
}

function isValidUsername(value) {
  return USERNAME_PATTERN.test(value);
}

function normalizeAlbum(value) {
  if (typeof value !== "string") return DEFAULT_ALBUM;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 50);
  return normalized || DEFAULT_ALBUM;
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

function mediaTypeFromContentType(value) {
  const normalized = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
  return normalized.startsWith("video/") ? "video" : "image";
}

function normalizeFileSize(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function canRecordVideo() {
  return typeof MediaRecorder === "function";
}

function pickRecorderMimeType() {
  if (!canRecordVideo() || typeof MediaRecorder.isTypeSupported !== "function") return "";

  const candidates = [
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function formatAlbumTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function cameraLabel(facingMode) {
  return facingMode === "user" ? "front" : "rear";
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function formatZoomValue(value) {
  return `${Number(value || 1).toFixed(1)}x`;
}

function roundZoomValue(value) {
  if (!zoomCapabilities.supported) return 1;
  const { min, max, step } = zoomCapabilities;
  const safeStep = step > 0 ? step : 0.1;
  const rounded = Math.round((value - min) / safeStep) * safeStep + min;
  return Number(clampNumber(rounded, min, max).toFixed(3));
}

function touchDistance(touches) {
  if (!touches || touches.length < 2) return 0;
  const [first, second] = touches;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function getSupportedCameraConstraints() {
  return navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
}

function getTrackCapabilities() {
  if (!activeVideoTrack || typeof activeVideoTrack.getCapabilities !== "function") return {};
  try {
    return activeVideoTrack.getCapabilities() ?? {};
  } catch {
    return {};
  }
}

function getTrackSettings() {
  if (!activeVideoTrack || typeof activeVideoTrack.getSettings !== "function") return {};
  try {
    return activeVideoTrack.getSettings() ?? {};
  } catch {
    return {};
  }
}

function clearFocusRingTimer() {
  if (!focusRingTimeoutId) return;
  window.clearTimeout(focusRingTimeoutId);
  focusRingTimeoutId = 0;
}

function hideFocusRing() {
  clearFocusRingTimer();
  focusRingEl.hidden = true;
}

function showFocusRing(x, y) {
  focusRingEl.style.left = `${x}px`;
  focusRingEl.style.top = `${y}px`;
  focusRingEl.hidden = true;
  void focusRingEl.offsetWidth;
  focusRingEl.hidden = false;
  clearFocusRingTimer();
  focusRingTimeoutId = window.setTimeout(() => {
    focusRingEl.hidden = true;
  }, 720);
}

function selectPreferredFocusMode(capabilities) {
  const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  if (focusModes.includes("continuous")) return "continuous";
  if (focusModes.includes("single-shot")) return "single-shot";
  if (focusModes.includes("manual")) return "manual";
  if (focusModes.includes("auto")) return "auto";
  return "";
}

function updateCameraHint() {
  if (zoomCapabilities.supported && focusCapabilities.canRefocus) {
    cameraHintEl.textContent = "Tap to refocus. Pinch to zoom. Record video when your browser supports it.";
    return;
  }

  if (zoomCapabilities.supported) {
    cameraHintEl.textContent = "Use the zoom controls or pinch the preview. Video recording depends on browser support.";
    return;
  }

  if (focusCapabilities.canRefocus) {
    cameraHintEl.textContent = "Tap the preview to refocus. Video recording depends on browser support.";
    return;
  }

  cameraHintEl.textContent = "Extra camera controls and video recording depend on the browser and device you are using.";
}

function syncZoomUi(previewValue = zoomCapabilities.value) {
  const zoomVisible = zoomCapabilities.supported;
  zoomControlsEl.hidden = !zoomVisible;
  zoomValueEl.textContent = formatZoomValue(previewValue);

  if (!zoomVisible) {
    zoomSliderInput.disabled = true;
    zoomOutButton.disabled = true;
    zoomInButton.disabled = true;
    return;
  }

  zoomSliderInput.disabled = false;
  zoomSliderInput.min = String(zoomCapabilities.min);
  zoomSliderInput.max = String(zoomCapabilities.max);
  zoomSliderInput.step = String(zoomCapabilities.step);
  zoomSliderInput.value = String(previewValue);
  zoomOutButton.disabled = previewValue <= zoomCapabilities.min + zoomCapabilities.step / 3;
  zoomInButton.disabled = previewValue >= zoomCapabilities.max - zoomCapabilities.step / 3;
}

function clearCameraEnhancements() {
  activeVideoTrack = null;
  zoomCapabilities = {
    supported: false,
    min: 1,
    max: 1,
    step: 0.1,
    value: 1
  };
  focusCapabilities = {
    canFocusPoint: false,
    canRefocus: false,
    preferredMode: ""
  };
  queuedZoomValue = null;
  zoomUpdateInFlight = false;
  pinchStartDistance = 0;
  pinchStartZoom = 1;
  recentPinchAt = 0;
  hideFocusRing();
  syncZoomUi(1);
  updateCameraHint();
}

function refreshCameraFeatureState() {
  const supportedConstraints = getSupportedCameraConstraints();
  const capabilities = getTrackCapabilities();
  const settings = getTrackSettings();

  const zoomRange = capabilities.zoom;
  const zoomSupported =
    Boolean(supportedConstraints.zoom) &&
    zoomRange &&
    typeof zoomRange.min === "number" &&
    typeof zoomRange.max === "number" &&
    zoomRange.max > zoomRange.min;
  const zoomValue = typeof settings.zoom === "number" ? settings.zoom : zoomSupported ? zoomRange.min : 1;
  const zoomStep =
    zoomSupported && typeof zoomRange.step === "number" && zoomRange.step > 0
      ? zoomRange.step
      : 0.1;

  zoomCapabilities = {
    supported: zoomSupported,
    min: zoomSupported ? zoomRange.min : 1,
    max: zoomSupported ? zoomRange.max : 1,
    step: zoomStep,
    value: zoomSupported ? Number(clampNumber(zoomValue, zoomRange.min, zoomRange.max).toFixed(3)) : 1
  };

  const preferredMode = selectPreferredFocusMode(capabilities);
  focusCapabilities = {
    canFocusPoint: Boolean(supportedConstraints.pointsOfInterest),
    canRefocus: Boolean(preferredMode || supportedConstraints.pointsOfInterest),
    preferredMode
  };

  syncZoomUi(zoomCapabilities.value);
  updateCameraHint();
}

async function applyCameraAdvancedConstraints(partialConstraints) {
  if (!activeVideoTrack || typeof activeVideoTrack.applyConstraints !== "function") {
    return false;
  }

  const advanced = { ...partialConstraints };

  if (
    zoomCapabilities.supported &&
    typeof zoomCapabilities.value === "number" &&
    !hasOwn(advanced, "zoom")
  ) {
    advanced.zoom = zoomCapabilities.value;
  }

  if (focusCapabilities.preferredMode && !hasOwn(advanced, "focusMode")) {
    advanced.focusMode = focusCapabilities.preferredMode;
  }

  try {
    await activeVideoTrack.applyConstraints({ advanced: [advanced] });
    refreshCameraFeatureState();
    return true;
  } catch (error) {
    console.warn("Camera constraint update failed:", error);
    return false;
  }
}

async function initializeCameraEnhancements() {
  activeVideoTrack = stream?.getVideoTracks?.()[0] ?? null;
  refreshCameraFeatureState();

  if (focusCapabilities.preferredMode) {
    await applyCameraAdvancedConstraints({ focusMode: focusCapabilities.preferredMode });
  }
}

function registerAlbum(value) {
  knownAlbums.add(normalizeAlbum(value));
}

function syncAlbumFilterOptions() {
  const currentValue = selectedAlbumFilter;
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

  if (currentValue && knownAlbums.has(currentValue)) {
    albumFilterSelect.value = currentValue;
  } else {
    selectedAlbumFilter = "";
    albumFilterSelect.value = "";
  }
}

function effectiveUploaderName() {
  const normalized = normalizeUsername(profileNameInput.value);
  if (normalized && isValidUsername(normalized)) return normalized;
  return DEFAULT_NAME;
}

function syncProfileHint() {
  const normalized = normalizeUsername(profileNameInput.value);
  if (!normalized) {
    profileHintEl.textContent = "Name is optional. Leave it blank and uploads are labeled as camera.";
    return;
  }

  if (!isValidUsername(normalized)) {
    profileHintEl.textContent = USERNAME_RULES_ERROR;
    return;
  }

  profileHintEl.textContent = `Uploads are labeled as ${normalized}. Everyone sees the same shared gallery.`;
}

function persistProfileName() {
  const rawValue = profileNameInput.value;
  const normalized = normalizeUsername(rawValue);

  if (!rawValue.trim()) {
    profileNameInput.value = "";
    localStorage.removeItem(NAME_KEY);
    syncProfileHint();
    return;
  }

  if (!normalized || !isValidUsername(normalized)) {
    setStatus(USERNAME_RULES_ERROR, true);
    profileNameInput.value = normalizeUsername(localStorage.getItem(NAME_KEY) || "");
    syncProfileHint();
    return;
  }

  profileNameInput.value = normalized;
  localStorage.setItem(NAME_KEY, normalized);
  syncProfileHint();
}

function currentUploadOptions() {
  const album = normalizeAlbum(albumInput.value);
  const username = effectiveUploaderName();

  albumInput.value = album;
  localStorage.setItem(ALBUM_KEY, album);
  registerAlbum(album);

  return {
    album,
    username
  };
}

function updateAlbumFilter() {
  selectedAlbumFilter = normalizeOptionalAlbum(albumFilterSelect.value);
  localStorage.setItem(FILTER_ALBUM_KEY, selectedAlbumFilter);
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

  if (syncFilters) syncAlbumFilterOptions();
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
  const normalizedAlbum = normalizeAlbum(nextEntry.album || existing?.album || DEFAULT_ALBUM);
  const ownerUsername = normalizeUsername(nextEntry.ownerUsername || existing?.ownerUsername || DEFAULT_NAME) || DEFAULT_NAME;

  registerAlbum(normalizedAlbum);

  const merged = {
    ...existing,
    ...nextEntry,
    album: normalizedAlbum,
    ownerUsername,
    mediaType: nextEntry.mediaType || existing?.mediaType || "image",
    durationSeconds:
      typeof nextEntry.durationSeconds === "number"
        ? nextEntry.durationSeconds
        : typeof existing?.durationSeconds === "number"
          ? existing.durationSeconds
          : null,
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

function renderAlbum() {
  albumGridEl.innerHTML = "";

  const visibleEntries = albumOrder
    .map((key) => albumEntries.get(key))
    .filter((item) => {
      if (!item?.displayUrl) return false;
      if (selectedAlbumFilter && item.album !== selectedAlbumFilter) return false;
      return true;
    });

  if (visibleEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "album-empty";
    empty.textContent = selectedAlbumFilter
      ? `No media in ${selectedAlbumFilter} yet.`
      : "No media yet. Take a photo, record a video, or upload from your device.";
    albumGridEl.appendChild(empty);
    return;
  }

  visibleEntries.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "album-item";
    card.addEventListener("click", () => {
      openPhotoPreview(item.displayUrl, item.key, item.mediaType);
    });

    if (item.mediaType === "video") {
      const media = document.createElement("video");
      media.src = item.displayUrl;
      media.muted = true;
      media.playsInline = true;
      media.preload = "metadata";
      media.disablePictureInPicture = true;
      media.addEventListener("error", () => {
        removeAlbumEntry(item.key);
      });
      card.appendChild(media);

      const badge = document.createElement("span");
      badge.className = "album-badge";
      badge.textContent =
        typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds)
          ? formatDuration(item.durationSeconds)
          : "Video";
      card.appendChild(badge);
    } else {
      const img = document.createElement("img");
      img.src = item.displayUrl;
      img.alt = item.key || "Captured media";
      img.addEventListener("error", () => {
        removeAlbumEntry(item.key);
      });
      card.appendChild(img);
    }

    const meta = document.createElement("div");
    meta.className = "album-meta";

    const owner = document.createElement("span");
    owner.className = "album-owner";
    owner.textContent = item.ownerUsername || DEFAULT_NAME;
    meta.appendChild(owner);

    const details = document.createElement("span");
    details.className = "album-details";
    const parts = [item.album || DEFAULT_ALBUM];
    if (item.mediaType === "video") parts.unshift("video");
    const time = formatAlbumTime(item.createdAt);
    if (time) parts.push(time);
    details.textContent = parts.join(" · ");
    meta.appendChild(details);

    card.appendChild(meta);
    albumGridEl.appendChild(card);
  });
}

function openPhotoPreview(url, key = "Media preview", mediaType = "image") {
  if (!url) return;

  if (mediaType === "video") {
    previewImageEl.hidden = true;
    previewImageEl.removeAttribute("src");
    previewVideoEl.hidden = false;
    previewVideoEl.src = url;
    previewVideoEl.setAttribute("aria-label", key);
    previewVideoEl.load();
  } else {
    previewVideoEl.pause();
    previewVideoEl.hidden = true;
    previewVideoEl.removeAttribute("src");
    previewVideoEl.load();
    previewImageEl.hidden = false;
    previewImageEl.src = url;
    previewImageEl.alt = key;
  }

  previewModalEl.hidden = false;
}

function closePhotoPreview() {
  if (previewModalEl.hidden) return;
  previewModalEl.hidden = true;
  previewImageEl.removeAttribute("src");
  previewImageEl.hidden = true;
  previewVideoEl.pause();
  previewVideoEl.hidden = true;
  previewVideoEl.removeAttribute("src");
  previewVideoEl.load();
}

function setCameraControlsEnabled(enabled) {
  const interactive = Boolean(enabled);
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");

  captureButton.disabled = !interactive || !stream || recording;
  recordVideoButton.disabled = !interactive || !stream || !canRecordVideo();
  flipButton.disabled = !interactive || !stream || !hasMultipleCameras || recording;
  uploadFilesButton.disabled = !interactive;
  refreshGalleryButton.disabled = !interactive;
  profileNameInput.disabled = !interactive;
  albumInput.disabled = !interactive;
  if (zoomCapabilities.supported) {
    syncZoomUi(zoomCapabilities.value);
    zoomSliderInput.disabled = !interactive;
    zoomOutButton.disabled =
      !interactive || zoomCapabilities.value <= zoomCapabilities.min + zoomCapabilities.step / 3;
    zoomInButton.disabled =
      !interactive || zoomCapabilities.value >= zoomCapabilities.max - zoomCapabilities.step / 3;
  } else {
    zoomSliderInput.disabled = true;
    zoomOutButton.disabled = true;
    zoomInButton.disabled = true;
  }
}

function stopRecordingTimer() {
  if (!recordingTimerId) return;
  window.clearInterval(recordingTimerId);
  recordingTimerId = 0;
}

function updateRecordingUi() {
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");
  recordVideoButton.classList.toggle("is-recording", recording);
  recordVideoButton.textContent = recording ? "Stop Recording" : "Record Video";
  recordingPillEl.hidden = !recording;

  if (!recording) {
    recordingTimeEl.textContent = "00:00";
    return;
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
  recordingTimeEl.textContent = formatDuration(elapsedSeconds);
}

function releaseRecordingAudioStream() {
  if (!recordingAudioStream) return;
  recordingAudioStream.getTracks().forEach((track) => track.stop());
  recordingAudioStream = null;
}

function stopCameraStream() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }

  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  clearCameraEnhancements();
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
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraControlsEnabled(true);
    setStatus("Camera access is not available here. Upload from your device instead.", true);
    return false;
  }

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

      await initializeCameraEnhancements();
      await refreshCameraCount();
      setCameraControlsEnabled(true);
      setStatus(`Camera ready on the ${cameraLabel(currentFacingMode)} camera.`);
      return true;
    } catch (error) {
      console.error(error);
    }
  }

  setCameraControlsEnabled(true);
  setStatus("Could not access the camera. You can still upload from your device.", true);
  return false;
}

async function flipCamera() {
  if (!stream) return;

  const previousFacingMode = currentFacingMode;
  const nextFacingMode = currentFacingMode === "environment" ? "user" : "environment";
  setStatus(`Switching to the ${cameraLabel(nextFacingMode)} camera...`);
  setCameraControlsEnabled(false);

  const started = await startCamera(nextFacingMode);
  if (!started) return;

  if (currentFacingMode === previousFacingMode) {
    setStatus(`Still on the ${cameraLabel(previousFacingMode)} camera.`, true);
    return;
  }

  setStatus(`Now using the ${cameraLabel(currentFacingMode)} camera.`);
}

function parseErrorBody(body, fallback) {
  if (body && typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }
  return fallback;
}

async function apiFetch(resource, options = {}) {
  const response = await fetch(resource, {
    credentials: "same-origin",
    ...options
  });

  if (response.status === 401) {
    applyAuthenticationState(false);
    setUnlockStatus("Enter the shared password to keep using the camera and gallery.", true);
  }

  return response;
}

async function loadSessionState() {
  const res = await apiFetch("/api/session");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, "Could not verify access."));
  }

  return res.json();
}

async function unlockApp(password) {
  const res = await apiFetch("/api/unlock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, "Could not unlock the app."));
  }

  return res.json();
}

function uploaderHeaders(uploadOptions) {
  return uploadOptions?.username ? { "X-Username": uploadOptions.username } : {};
}

async function setZoomLevel(nextValue) {
  if (!zoomCapabilities.supported) return;

  queuedZoomValue = roundZoomValue(nextValue);
  syncZoomUi(queuedZoomValue);

  if (zoomUpdateInFlight) return;
  zoomUpdateInFlight = true;

  try {
    while (queuedZoomValue !== null) {
      const targetZoom = queuedZoomValue;
      queuedZoomValue = null;

      const updated = await applyCameraAdvancedConstraints({ zoom: targetZoom });
      if (!updated) break;

      zoomCapabilities.value = typeof getTrackSettings().zoom === "number" ? getTrackSettings().zoom : targetZoom;
      syncZoomUi(zoomCapabilities.value);
    }
  } finally {
    zoomUpdateInFlight = false;
    syncZoomUi(zoomCapabilities.value);
  }
}

function mapClientPointToVideo(clientX, clientY) {
  const rect = cameraWrap.getBoundingClientRect();
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!rect.width || !rect.height || !videoWidth || !videoHeight) return null;

  const displayX = clampNumber(clientX - rect.left, 0, rect.width);
  const displayY = clampNumber(clientY - rect.top, 0, rect.height);

  const videoAspect = videoWidth / videoHeight;
  const boxAspect = rect.width / rect.height;

  let renderedWidth = rect.width;
  let renderedHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (videoAspect > boxAspect) {
    renderedHeight = rect.height;
    renderedWidth = rect.height * videoAspect;
    offsetX = (renderedWidth - rect.width) / 2;
  } else {
    renderedWidth = rect.width;
    renderedHeight = rect.width / videoAspect;
    offsetY = (renderedHeight - rect.height) / 2;
  }

  const x = clampNumber((displayX + offsetX) / renderedWidth, 0, 1);
  const y = clampNumber((displayY + offsetY) / renderedHeight, 0, 1);

  return {
    displayX,
    displayY,
    x,
    y
  };
}

async function requestCameraFocus(point) {
  if (!focusCapabilities.canRefocus || !point) return;

  if (focusCapabilities.canFocusPoint) {
    const focused = await applyCameraAdvancedConstraints({
      pointsOfInterest: [{ x: point.x, y: point.y }]
    });
    if (focused) return;
  }

  if (focusCapabilities.preferredMode) {
    await applyCameraAdvancedConstraints({ focusMode: focusCapabilities.preferredMode });
  }
}

async function handleCameraTap(event) {
  if (!stream) return;
  if (event.target.closest(".camera-zoom")) return;
  if (Date.now() - recentPinchAt < 260) return;

  const point = mapClientPointToVideo(event.clientX, event.clientY);
  if (!point) return;

  showFocusRing(point.displayX, point.displayY);
  await requestCameraFocus(point);
}

async function handleZoomWheel(event) {
  if (!zoomCapabilities.supported) return;
  if (event.target.closest(".camera-zoom")) return;

  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  const step = Math.max(zoomCapabilities.step, 0.1);
  await setZoomLevel(zoomCapabilities.value + direction * step * 2);
}

function handleCameraTouchStart(event) {
  if (!zoomCapabilities.supported || event.touches.length !== 2) return;
  pinchStartDistance = touchDistance(event.touches);
  pinchStartZoom = zoomCapabilities.value;
}

async function handleCameraTouchMove(event) {
  if (!zoomCapabilities.supported || event.touches.length !== 2 || !pinchStartDistance) return;

  event.preventDefault();
  const ratio = touchDistance(event.touches) / pinchStartDistance;
  await setZoomLevel(pinchStartZoom * ratio);
}

function handleCameraTouchEnd(event) {
  const wasPinching = pinchStartDistance > 0;
  if (event.touches.length < 2) {
    pinchStartDistance = 0;
    pinchStartZoom = zoomCapabilities.value;
    if (wasPinching) {
      recentPinchAt = Date.now();
    }
  }
}

async function readVideoMetadata(file) {
  if (!(file instanceof Blob)) {
    return { width: null, height: null, durationSeconds: null };
  }

  const objectUrl = URL.createObjectURL(file);

  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.playsInline = true;
    probe.muted = true;

    const cleanup = () => {
      probe.removeAttribute("src");
      probe.load();
      URL.revokeObjectURL(objectUrl);
    };

    probe.onloadedmetadata = () => {
      const duration =
        Number.isFinite(probe.duration) && probe.duration > 0 ? Number(probe.duration.toFixed(3)) : null;
      const width = Number.isFinite(probe.videoWidth) && probe.videoWidth > 0 ? probe.videoWidth : null;
      const height = Number.isFinite(probe.videoHeight) && probe.videoHeight > 0 ? probe.videoHeight : null;
      cleanup();
      resolve({ width, height, durationSeconds: duration });
    };

    probe.onerror = () => {
      cleanup();
      resolve({ width: null, height: null, durationSeconds: null });
    };

    probe.src = objectUrl;
  });
}

async function readMediaMetadata(file) {
  if (mediaTypeFromContentType(file?.type) === "video") {
    return readVideoMetadata(file);
  }

  const image = await readImageDimensions(file);
  return {
    ...image,
    durationSeconds: null
  };
}

async function requestRecordingAudio() {
  if (!navigator.mediaDevices?.getUserMedia) return null;

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });
  } catch (error) {
    console.warn("Recording without microphone:", error);
    return null;
  }
}

async function finalizeRecordedVideo() {
  const uploadOptions = recordingUploadOptions;
  const mimeType = recordingMimeType || pickRecorderMimeType() || "video/mp4";
  const blob = new Blob(recordingChunks, { type: mimeType });

  mediaRecorder = null;
  recordingChunks = [];
  recordingMimeType = "";
  recordingStartedAt = 0;
  stopRecordingTimer();
  releaseRecordingAudioStream();
  updateRecordingUi();

  if (!uploadOptions || blob.size === 0) {
    setCameraControlsEnabled(true);
    setStatus("Recording did not produce a playable video.", true);
    return;
  }

  try {
    const metadata = await readVideoMetadata(blob);
    setStatus(`Saving video to ${uploadOptions.album}...`);
    await uploadSingleBlob(blob, metadata.width, metadata.height, new Date().toISOString(), uploadOptions, {
      mediaType: "video",
      durationSeconds: metadata.durationSeconds
    });
    await loadRecentUploads();

    const durationLabel =
      typeof metadata.durationSeconds === "number" ? ` (${formatDuration(metadata.durationSeconds)})` : "";
    setStatus(`Video saved to ${uploadOptions.album}${durationLabel}.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Video upload failed.", true);
  } finally {
    recordingUploadOptions = null;
    recordingFinalizePromise = null;
    setCameraControlsEnabled(true);
  }
}

async function startVideoRecording() {
  if (!stream) {
    setStatus("Camera is not ready yet.", true);
    return;
  }

  if (!canRecordVideo()) {
    setStatus("This browser does not support in-app video recording.", true);
    return;
  }

  const uploadOptions = currentUploadOptions();
  const audioStream = await requestRecordingAudio();
  const tracks = [...stream.getVideoTracks()];
  if (audioStream) {
    tracks.push(...audioStream.getAudioTracks());
  }

  const recorderStream = new MediaStream(tracks);
  const mimeType = pickRecorderMimeType();
  let recorder;

  try {
    recorder = mimeType ? new MediaRecorder(recorderStream, { mimeType }) : new MediaRecorder(recorderStream);
  } catch (error) {
    releaseRecordingAudioStream();
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }
    throw error;
  }

  recordingAudioStream = audioStream;
  recordingUploadOptions = uploadOptions;
  recordingChunks = [];
  recordingMimeType = recorder.mimeType || mimeType || "video/mp4";
  recordingStartedAt = Date.now();
  mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      recordingChunks.push(event.data);
    }
  });

  recordingFinalizePromise = new Promise((resolve) => {
    recorder.addEventListener(
      "stop",
      async () => {
        await finalizeRecordedVideo();
        resolve();
      },
      { once: true }
    );
  });

  recorder.start(1000);
  stopRecordingTimer();
  recordingTimerId = window.setInterval(updateRecordingUi, 1000);
  updateRecordingUi();
  setCameraControlsEnabled(true);

  const audioLabel = audioStream ? "" : " without microphone";
  setStatus(`Recording video${audioLabel}...`);
}

async function stopVideoRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  setStatus("Finishing video...");
  mediaRecorder.stop();
  if (recordingFinalizePromise) {
    await recordingFinalizePromise;
  }
}

async function toggleVideoRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    await stopVideoRecording();
    return;
  }

  try {
    await startVideoRecording();
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not start recording.", true);
    releaseRecordingAudioStream();
    mediaRecorder = null;
    recordingChunks = [];
    recordingMimeType = "";
    recordingUploadOptions = null;
    recordingFinalizePromise = null;
    stopRecordingTimer();
    updateRecordingUi();
    setCameraControlsEnabled(true);
  }
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

async function loadRecentUploads() {
  const url = new URL("/api/photos", window.location.origin);
  url.searchParams.set("limit", "240");

  const res = await apiFetch(`${url.pathname}${url.search}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, `Could not load recent photos (${res.status}).`));
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
          displayUrl: photo.viewUrl || photo.publicUrl || existing?.displayUrl || "",
          viewUrl: photo.viewUrl || existing?.viewUrl || null,
          publicUrl: photo.publicUrl || existing?.publicUrl || null,
          album: photo.album || existing?.album || DEFAULT_ALBUM,
          mediaType: photo.mediaType || existing?.mediaType || mediaTypeFromContentType(photo.contentType),
          durationSeconds:
            typeof photo.durationSeconds === "number"
              ? photo.durationSeconds
              : typeof existing?.durationSeconds === "number"
                ? existing.durationSeconds
                : null,
          ownerUsername:
            normalizeUsername(photo.ownerUsername || photo.uploaderName || "") ||
            normalizeUsername(existing?.ownerUsername || "") ||
            DEFAULT_NAME,
          isLocalPreview: !(photo.viewUrl || photo.publicUrl) && Boolean(existing?.isLocalPreview)
        },
        { promote: !existing, render: false }
      );
    });

  syncAlbumFilterOptions();
  renderAlbum();
}

async function getUploadUrl(contentType, fileSize, uploadOptions) {
  const normalizedContentType = normalizeImageContentType(contentType);
  const normalizedFileSize = normalizeFileSize(fileSize);

  const res = await apiFetch("/api/upload-url", {
    method: "POST",
    headers: {
      ...uploaderHeaders(uploadOptions),
      "Content-Type": "application/json",
      "X-Content-Type": normalizedContentType,
      "X-File-Size": String(normalizedFileSize),
      "X-Album": uploadOptions.album
    },
    body: JSON.stringify({
      username: uploadOptions.username,
      contentType: normalizedContentType,
      fileSize: normalizedFileSize,
      album: uploadOptions.album
    })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, "Could not get upload URL."));
  }

  return res.json();
}

async function saveMetadata(payload, uploadOptions) {
  const res = await apiFetch("/api/photos", {
    method: "POST",
    headers: {
      ...uploaderHeaders(uploadOptions),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      username: uploadOptions.username
    })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, "Could not save metadata."));
  }

  return res.json();
}

async function uploadViaSignedUrl(blob, width, height, capturedAt, uploadOptions, mediaOptions = {}) {
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

  return saveMetadata(
    {
      key: uploadInfo.key,
      contentType,
      sizeBytes: blob.size,
      width,
      height,
      durationSeconds:
        typeof mediaOptions.durationSeconds === "number" ? mediaOptions.durationSeconds : null,
      capturedAt,
      publicUrl: uploadInfo.publicUrl,
      album: uploadInfo.album || uploadOptions.album
    },
    uploadOptions
  );
}

async function uploadViaServer(blob, width, height, capturedAt, uploadOptions, mediaOptions = {}) {
  const contentType = normalizeImageContentType(blob.type);

  const res = await apiFetch("/api/upload", {
    method: "POST",
    headers: {
      ...uploaderHeaders(uploadOptions),
      "Content-Type": contentType,
      "X-Captured-At": capturedAt,
      "X-Image-Width": width ? String(width) : "",
      "X-Image-Height": height ? String(height) : "",
      "X-Media-Duration":
        typeof mediaOptions.durationSeconds === "number" ? String(mediaOptions.durationSeconds) : "",
      "X-Album": uploadOptions.album
    },
    body: blob
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(parseErrorBody(body, `Upload failed (${res.status}).`));
  }

  return res.json();
}

async function uploadSingleBlob(blob, width, height, capturedAt, uploadOptions, mediaOptions = {}) {
  let uploadedPhoto = null;
  const preferDirectUpload = mediaOptions.mediaType === "video";

  if (preferDirectUpload) {
    try {
      uploadedPhoto = await uploadViaSignedUrl(blob, width, height, capturedAt, uploadOptions, mediaOptions);
    } catch (directError) {
      console.warn("Direct video upload failed, falling back to relay:", directError);
      setStatus("Direct video upload failed, trying the app server...");
      uploadedPhoto = await uploadViaServer(blob, width, height, capturedAt, uploadOptions, mediaOptions);
    }
  } else {
    try {
      uploadedPhoto = await uploadViaServer(blob, width, height, capturedAt, uploadOptions, mediaOptions);
    } catch (relayError) {
      const relayMessage = String(relayError?.message || "");
      if (!/too large|413/i.test(relayMessage)) {
        throw relayError;
      }

      setStatus("The file is large, trying direct upload...");
      uploadedPhoto = await uploadViaSignedUrl(blob, width, height, capturedAt, uploadOptions, mediaOptions);
    }
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
      mediaType:
        uploadedPhoto.mediaType || mediaOptions.mediaType || mediaTypeFromContentType(uploadedPhoto.contentType),
      durationSeconds:
        typeof uploadedPhoto.durationSeconds === "number"
          ? uploadedPhoto.durationSeconds
          : typeof mediaOptions.durationSeconds === "number"
            ? mediaOptions.durationSeconds
            : null,
      ownerUsername:
        normalizeUsername(uploadedPhoto.ownerUsername || uploadedPhoto.uploaderName || "") ||
        uploadOptions.username,
      isLocalPreview: !remoteViewUrl
    });
  }

  return uploadedPhoto;
}

async function captureAndUpload() {
  if (!stream) {
    setStatus("Camera is not ready. Upload from your device instead.", true);
    return;
  }

  setCameraControlsEnabled(false);

  try {
    const uploadOptions = currentUploadOptions();
    setStatus("Capturing photo...");

    const { blob, width, height } = await captureBlob();
    const capturedAt = new Date().toISOString();

    setStatus(`Saving to ${uploadOptions.album}...`);
    await uploadSingleBlob(blob, width, height, capturedAt, uploadOptions, { mediaType: "image" });
    await loadRecentUploads();

    setStatus(`Added to ${uploadOptions.album}.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Upload failed.", true);
  } finally {
    setCameraControlsEnabled(true);
  }
}

async function uploadFilesFromDevice(fileList) {
  const files = Array.from(fileList || []).filter((file) => {
    const mediaType = mediaTypeFromContentType(file?.type);
    return file && (mediaType === "image" || mediaType === "video");
  });
  if (files.length === 0) {
    setStatus("Select one or more image or video files.", true);
    return;
  }

  setCameraControlsEnabled(false);
  let uploadedCount = 0;

  try {
    const uploadOptions = currentUploadOptions();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setStatus(`Uploading ${index + 1} of ${files.length}: ${file.name}`);

      const mediaType = mediaTypeFromContentType(file.type);
      const { width, height, durationSeconds } = await readMediaMetadata(file);
      const capturedAt =
        Number.isFinite(file.lastModified) && file.lastModified > 0
          ? new Date(file.lastModified).toISOString()
          : new Date().toISOString();

      await uploadSingleBlob(file, width, height, capturedAt, uploadOptions, {
        mediaType,
        durationSeconds
      });
      uploadedCount += 1;
    }

    await loadRecentUploads();
    setStatus(`Uploaded ${uploadedCount} item${uploadedCount === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Upload failed.", true);
  } finally {
    filePickerInput.value = "";
    setCameraControlsEnabled(true);
  }
}

async function refreshGallery() {
  refreshGalleryButton.disabled = true;
  try {
    await loadRecentUploads();
    setStatus("Gallery updated.");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not refresh the gallery.", true);
  } finally {
    refreshGalleryButton.disabled = false;
  }
}

async function initializeApp() {
  setCameraControlsEnabled(false);
  setStatus("Starting camera...");

  try {
    await startCamera();
  } catch (error) {
    console.error(error);
    setStatus("Could not start the camera. Upload from your device instead.", true);
    setCameraControlsEnabled(true);
  }

  try {
    await loadRecentUploads();
  } catch (error) {
    console.error(error);
    if (!statusEl.classList.contains("error")) {
      setStatus(error.message || "Could not load recent photos.", true);
    }
  }
}

async function handleUnlockSubmit(event) {
  event.preventDefault();

  const password = unlockPasswordInput.value;
  if (!password) {
    setUnlockStatus("Enter the shared password first.", true);
    unlockPasswordInput.focus();
    return;
  }

  unlockButton.disabled = true;
  unlockPasswordInput.disabled = true;
  setUnlockStatus("Unlocking...");

  try {
    await unlockApp(password);
    unlockPasswordInput.value = "";
    setUnlockStatus("");
    applyAuthenticationState(true);
    await initializeApp();
  } catch (error) {
    console.error(error);
    applyAuthenticationState(false);
    setUnlockStatus(error.message || "Could not unlock the app.", true);
    unlockPasswordInput.select();
  } finally {
    unlockButton.disabled = false;
    unlockPasswordInput.disabled = false;
  }
}

async function initializeProtectedApp() {
  applyAuthenticationState(false);
  setUnlockStatus("Checking access...");

  try {
    const session = await loadSessionState();
    if (!session?.authEnabled) {
      setUnlockStatus("This app is locked until APP_PASSWORD is configured on the server.", true);
      return;
    }

    if (!session.authenticated) {
      setUnlockStatus("Enter the shared password to open the camera and gallery.");
      unlockPasswordInput.focus();
      return;
    }

    setUnlockStatus("");
    applyAuthenticationState(true);
    await initializeApp();
  } catch (error) {
    console.error(error);
    setUnlockStatus(error.message || "Could not verify access.", true);
  }
}

captureButton.addEventListener("click", captureAndUpload);
recordVideoButton.addEventListener("click", () => {
  toggleVideoRecording().catch((error) => {
    console.error(error);
    setStatus(error.message || "Could not record video.", true);
  });
});
flipButton.addEventListener("click", flipCamera);
zoomOutButton.addEventListener("click", async () => {
  if (!zoomCapabilities.supported) return;
  await setZoomLevel(zoomCapabilities.value - Math.max(zoomCapabilities.step, 0.1));
});
zoomInButton.addEventListener("click", async () => {
  if (!zoomCapabilities.supported) return;
  await setZoomLevel(zoomCapabilities.value + Math.max(zoomCapabilities.step, 0.1));
});
zoomSliderInput.addEventListener("input", async () => {
  if (!zoomCapabilities.supported) return;
  await setZoomLevel(Number(zoomSliderInput.value));
});
cameraWrap.addEventListener("click", (event) => {
  handleCameraTap(event).catch((error) => {
    console.error(error);
  });
});
cameraWrap.addEventListener("wheel", (event) => {
  handleZoomWheel(event).catch((error) => {
    console.error(error);
  });
}, { passive: false });
cameraWrap.addEventListener("touchstart", handleCameraTouchStart, { passive: true });
cameraWrap.addEventListener("touchmove", (event) => {
  handleCameraTouchMove(event).catch((error) => {
    console.error(error);
  });
}, { passive: false });
cameraWrap.addEventListener("touchend", handleCameraTouchEnd, { passive: true });
cameraWrap.addEventListener("touchcancel", handleCameraTouchEnd, { passive: true });

uploadFilesButton.addEventListener("click", () => {
  filePickerInput.click();
});

refreshGalleryButton.addEventListener("click", refreshGallery);

filePickerInput.addEventListener("change", () => {
  uploadFilesFromDevice(filePickerInput.files);
});

profileNameInput.addEventListener("input", syncProfileHint);
profileNameInput.addEventListener("blur", persistProfileName);
profileNameInput.addEventListener("change", persistProfileName);

albumInput.addEventListener("blur", () => {
  albumInput.value = normalizeAlbum(albumInput.value);
  localStorage.setItem(ALBUM_KEY, albumInput.value);
  registerAlbum(albumInput.value);
  syncAlbumFilterOptions();
});

albumInput.addEventListener("change", () => {
  albumInput.value = normalizeAlbum(albumInput.value);
  localStorage.setItem(ALBUM_KEY, albumInput.value);
  registerAlbum(albumInput.value);
  syncAlbumFilterOptions();
});

albumFilterSelect.addEventListener("change", updateAlbumFilter);

previewCloseEl.addEventListener("click", closePhotoPreview);
previewBackdropEl.addEventListener("click", closePhotoPreview);
previewImageEl.addEventListener("error", closePhotoPreview);
unlockFormEl.addEventListener("submit", (event) => {
  handleUnlockSubmit(event).catch((error) => {
    console.error(error);
    setUnlockStatus(error.message || "Could not unlock the app.", true);
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePhotoPreview();
});

profileNameInput.value = normalizeUsername(localStorage.getItem(NAME_KEY) || "");
albumInput.value = normalizeAlbum(localStorage.getItem(ALBUM_KEY) || DEFAULT_ALBUM);

registerAlbum(DEFAULT_ALBUM);
syncProfileHint();
clearCameraEnhancements();
updateRecordingUi();
recordVideoButton.hidden = !canRecordVideo();
previewImageEl.hidden = true;
previewVideoEl.hidden = true;
syncAlbumFilterOptions();
renderAlbum();

initializeProtectedApp().catch((error) => {
  console.error(error);
  setUnlockStatus("Something went wrong while starting the app.", true);
});
