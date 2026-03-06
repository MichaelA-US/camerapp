const loginForm = document.getElementById("login-form");
const passcodeInput = document.getElementById("passcode");
const captureButton = document.getElementById("capture");
const video = document.getElementById("preview");
const canvas = document.getElementById("capture-canvas");
const statusEl = document.getElementById("status");
const recentUploadsEl = document.getElementById("recent-uploads");

const TOKEN_KEY = "onlineCameraToken";
let authToken = localStorage.getItem(TOKEN_KEY) || "";
let stream = null;

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
      setStatus("Session expired. Enter passcode again.", true);
      captureButton.disabled = true;
    }
    return;
  }

  const { photos } = await res.json();
  recentUploadsEl.innerHTML = "";
  photos.slice(0, 10).forEach((photo) => {
    const item = document.createElement("li");
    const date = new Date(photo.createdAt).toLocaleString();
    item.textContent = `${date} - ${photo.key}`;
    if (photo.publicUrl) {
      const link = document.createElement("a");
      link.href = photo.publicUrl;
      link.textContent = "view";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(" (", link, ")");
    }
    recentUploadsEl.appendChild(item);
  });
}

async function startCamera() {
  if (stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    setStatus("Camera ready. Photos upload directly to cloud.");
    captureButton.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus("Unable to access camera. Allow camera permission in Safari.", true);
  }
}

async function login(passcode) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Login failed." }));
    throw new Error(body.error || "Login failed.");
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
  const res = await fetch("/api/upload-url", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ contentType, fileSize })
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
}

function isLikelyCorsBlock(error) {
  if (!error) return false;
  const message = String(error.message || "");
  return (
    error instanceof TypeError ||
    /load failed|failed to fetch|preflight|cors/i.test(message) ||
    /upload failed \(403\)/i.test(message)
  );
}

async function uploadViaSignedUrl(blob, width, height) {
  const uploadInfo = await getUploadUrl(blob.type, blob.size);
  const uploadRes = await fetch(uploadInfo.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": blob.type
    },
    body: blob
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed (${uploadRes.status}).`);
  }

  await saveMetadata({
    key: uploadInfo.key,
    contentType: blob.type,
    sizeBytes: blob.size,
    width,
    height,
    capturedAt: new Date().toISOString(),
    publicUrl: uploadInfo.publicUrl
  });
}

async function uploadViaServer(blob, width, height) {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": blob.type,
      "X-Captured-At": new Date().toISOString(),
      "X-Image-Width": String(width),
      "X-Image-Height": String(height)
    },
    body: blob
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Proxy upload failed." }));
    throw new Error(body.error || `Proxy upload failed (${res.status}).`);
  }
}

async function captureAndUpload() {
  captureButton.disabled = true;
  try {
    setStatus("Capturing photo...");
    const { blob, width, height } = await captureBlob();
    setStatus("Preparing upload...");
    try {
      await uploadViaSignedUrl(blob, width, height);
      setStatus("Uploaded successfully.");
    } catch (directError) {
      if (!isLikelyCorsBlock(directError)) throw directError;
      console.warn("Direct upload blocked; retrying through server relay.", directError);
      setStatus("Direct upload blocked. Retrying through server...");
      await uploadViaServer(blob, width, height);
      setStatus("Uploaded successfully (server relay).");
    }

    await loadRecentUploads();
  } catch (error) {
    console.error(error);
    if (error.message.includes("Unauthorized")) {
      localStorage.removeItem(TOKEN_KEY);
      authToken = "";
    }
    setStatus(error.message || "Upload failed.", true);
  } finally {
    if (authToken) captureButton.disabled = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await login(passcodeInput.value.trim());
    passcodeInput.value = "";
    setStatus("Logged in. Starting camera...");
    await startCamera();
    await loadRecentUploads();
  } catch (error) {
    setStatus(error.message, true);
  }
});

captureButton.addEventListener("click", captureAndUpload);

if (authToken) {
  setStatus("Restoring session...");
  startCamera()
    .then(loadRecentUploads)
    .catch(() => {
      setStatus("Session found, but camera failed to start.", true);
    });
}
