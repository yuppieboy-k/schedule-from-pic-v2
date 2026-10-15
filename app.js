/* =========================================================
   Schedule from Pic — Application State Machine & Controller
   - Camera & Gallery input with drag/drop and clipboard paste
   - Live camera viewfinder modal
   - Gemini Vision AI extraction with real-time progress
   - Event review & editing before saving
   - Open in Default Calendar (.ics) & Google/Outlook links
   - Automatic photo deletion upon calendar creation
   - Dedicated Settings page with API key connection tester
   ========================================================= */

import { extractWithGemini, downscaleImage, testGeminiKey, GEMINI_MODELS } from "./gemini.js";
import { openInDefaultCalendar, downloadICS, googleCalendarURL, outlookCalendarURL } from "./export.js";

/* ---------- App State ---------- */
const state = {
  imageFile: null,            // File or Blob
  imageDataUrl: null,         // Downscaled Base64 image
  previewUrl: null,           // Object URL for preview
  event: null,                // Extracted & normalized event object
  abortController: null,      // For in-flight extraction cancellation
  liveStream: null,           // MediaStream for live camera
  cameraFacing: "environment",// "environment" (rear) or "user" (selfie)
  autoDeletePhoto: true,      // Automatically purge photo once calendar entry is created
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  deferredInstallPrompt: null,
};

/* ---------- Settings Management ---------- */
const SETTINGS_KEY = "schedule-from-pic:settings:v2";
const LEGACY_KEY   = "schedule-from-pic:settings:v1";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);

    // Check legacy v1 key migration
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      return {
        geminiApiKey: parsed.gemini || "",
        geminiModel: "gemini-2.5-flash",
        autoDeletePhoto: true,
      };
    }
  } catch (err) {
    console.warn("Failed to load settings:", err);
  }
  return {
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash",
    autoDeletePhoto: true,
  };
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (err) {
    console.warn("Failed to save settings:", err);
  }
}

function initSettings() {
  const s = loadSettings();
  state.geminiApiKey = s.geminiApiKey || "";
  state.geminiModel = s.geminiModel || "gemini-2.5-flash";
  state.autoDeletePhoto = s.autoDeletePhoto !== false;

  // Sync checkboxes
  const toggleHome = document.getElementById("toggle-auto-delete-home");
  const toggleSettings = document.getElementById("toggle-auto-delete-settings");
  if (toggleHome) toggleHome.checked = state.autoDeletePhoto;
  if (toggleSettings) toggleSettings.checked = state.autoDeletePhoto;

  updateApiStatusIndicator();
}

function updateApiStatusIndicator() {
  const statusPill = document.getElementById("header-api-status");
  const banner = document.getElementById("banner-api-key");
  const hasKey = Boolean(state.geminiApiKey.trim());

  if (statusPill) {
    const textEl = statusPill.querySelector(".status-text");
    if (hasKey) {
      statusPill.classList.remove("needs-key");
      if (textEl) textEl.textContent = "Gemini Ready";
    } else {
      statusPill.classList.add("needs-key");
      if (textEl) textEl.textContent = "Add API Key";
    }
  }

  if (banner) {
    banner.hidden = hasKey;
  }
}

/* ---------- Screen Navigation ---------- */
const SCREENS = ["home", "preview", "extracting", "review"];

function showScreen(name) {
  for (const s of SCREENS) {
    const el = document.querySelector(`.screen[data-screen="${s}"]`);
    if (!el) continue;
    if (s === name) {
      el.hidden = false;
      el.style.animation = "none";
      void el.offsetHeight; // trigger reflow
      el.style.animation = "";
    } else {
      el.hidden = true;
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Toast Notifications ---------- */
let toastTimeout = null;
function showToast(message, durationMs = 2600) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("is-visible"));

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => { el.hidden = true; }, 250);
  }, durationMs);
}

/* ---------- Photo Handling (Take & Select) ---------- */
async function handleFileChosen(fileOrBlob) {
  if (!fileOrBlob) return;
  if (!fileOrBlob.type.startsWith("image/")) {
    showToast("Please select a valid image file");
    return;
  }

  state.imageFile = fileOrBlob;

  // Revoke previous preview object URL to prevent memory accumulation
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }

  state.previewUrl = URL.createObjectURL(fileOrBlob);

  const previewImg = document.getElementById("preview-image");
  if (previewImg) {
    previewImg.src = state.previewUrl;
  }

  const thumbImg = document.getElementById("extracting-preview-thumbnail");
  if (thumbImg) {
    thumbImg.src = state.previewUrl;
  }

  const autoDeleteBadge = document.getElementById("preview-auto-delete-badge");
  if (autoDeleteBadge) {
    autoDeleteBadge.hidden = !state.autoDeletePhoto;
  }

  showScreen("preview");
}

/* ---------- Live Camera Viewfinder Modal ---------- */
async function openLiveCamera() {
  const dialog = document.getElementById("camera-dialog");
  const video = document.getElementById("camera-video");
  if (!dialog || !video) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("Live camera not supported by this browser. Using native camera.");
    document.getElementById("file-camera")?.click();
    return;
  }

  try {
    stopLiveCameraStream();
    const constraints = {
      video: {
        facingMode: state.cameraFacing,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    state.liveStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.liveStream;
    await video.play();
    dialog.showModal();
  } catch (err) {
    console.warn("Camera stream failed:", err);
    showToast("Camera access was not granted. Opening file camera instead.");
    document.getElementById("file-camera")?.click();
  }
}

function stopLiveCameraStream() {
  if (state.liveStream) {
    state.liveStream.getTracks().forEach((track) => track.stop());
    state.liveStream = null;
  }
  const video = document.getElementById("camera-video");
  if (video) video.srcObject = null;
}

function closeLiveCamera() {
  stopLiveCameraStream();
  const dialog = document.getElementById("camera-dialog");
  if (dialog && dialog.open) {
    dialog.close();
  }
}

async function snapLivePhoto() {
  const video = document.getElementById("camera-video");
  if (!video || !video.videoWidth) return;

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  closeLiveCamera();

  canvas.toBlob((blob) => {
    if (blob) {
      handleFileChosen(blob);
    }
  }, "image/jpeg", 0.92);
}

function flipCamera() {
  state.cameraFacing = state.cameraFacing === "environment" ? "user" : "environment";
  openLiveCamera();
}

/* ---------- Gemini Vision Extraction ---------- */
async function startExtraction() {
  if (!state.imageFile) {
    showToast("Please capture or select a photo first");
    return;
  }

  if (!state.geminiApiKey.trim()) {
    showToast("Please enter your free Gemini API key first");
    openSettings();
    return;
  }

  showScreen("extracting");
  setExtractingStatus("Optimizing image resolution…");
  state.abortController = new AbortController();

  try {
    state.imageDataUrl = await downscaleImage(state.imageFile);

    const result = await extractWithGemini(state.imageDataUrl, {
      apiKey: state.geminiApiKey,
      model: state.geminiModel,
      onStatus: (msg) => setExtractingStatus(msg),
      signal: state.abortController.signal,
    });

    state.event = result.event;
    populateReviewForm(state.event);
    showScreen("review");
    showToast("✨ Event extracted successfully!");
  } catch (err) {
    if (err.name === "AbortError") {
      showScreen("preview");
      return;
    }
    console.error("Extraction error:", err);
    showScreen("preview");
    showToast(err.message || "Failed to extract event details", 4500);
  }
}

function setExtractingStatus(msg) {
  const el = document.getElementById("extracting-status");
  if (el) el.textContent = msg;
}

function cancelExtraction() {
  state.abortController?.abort();
  showScreen("preview");
}

/* ---------- Review Form & Real-time Update ---------- */
function populateReviewForm(event) {
  const form = document.getElementById("event-form");
  if (!form) return;

  form.elements.title.value = event.title || "";
  form.elements.allDay.checked = Boolean(event.allDay);
  form.elements.startDateTime.value = toLocalInputString(event.startDateTime);
  form.elements.endDateTime.value = toLocalInputString(event.endDateTime);
  form.elements.location.value = event.location || "";
  form.elements.description.value = event.description || "";

  // Raw text container
  const rawTextEl = document.getElementById("raw-text");
  if (rawTextEl) rawTextEl.textContent = event.rawText || "(No raw text provided)";

  // Confidence indicators
  for (const badge of form.querySelectorAll(".conf-badge")) {
    const field = badge.dataset.conf;
    const level = event.confidence?.[field];
    if (level) {
      badge.setAttribute("data-level", level);
      badge.hidden = false;
    } else {
      badge.removeAttribute("data-level");
      badge.hidden = true;
    }
  }

  toggleAllDayUI(event.allDay);
  updateCalendarLinks();
}

function readReviewForm() {
  const form = document.getElementById("event-form");
  const allDay = form.elements.allDay.checked;
  const title = form.elements.title.value.trim();
  const startRaw = form.elements.startDateTime.value;
  const endRaw = form.elements.endDateTime.value;

  const startIso = fromLocalInputString(startRaw);
  let endIso = fromLocalInputString(endRaw);

  if (startIso && !endIso) {
    const startMs = new Date(startIso).getTime();
    endIso = new Date(startMs + 60 * 60 * 1000).toISOString();
  }

  return {
    title,
    allDay,
    startDateTime: startIso,
    endDateTime: endIso,
    location: form.elements.location.value.trim(),
    description: form.elements.description.value.trim(),
  };
}

function updateCalendarLinks() {
  const event = readReviewForm();
  if (!event.title || !event.startDateTime) return;

  // Google Calendar link
  const googleBtn = document.getElementById("export-google-btn");
  if (googleBtn) {
    try {
      googleBtn.href = googleCalendarURL(event);
    } catch {
      googleBtn.href = "#";
    }
  }

  // Outlook Calendar link
  const outlookBtn = document.getElementById("export-outlook-btn");
  if (outlookBtn) {
    try {
      outlookBtn.href = outlookCalendarURL(event);
    } catch {
      outlookBtn.href = "#";
    }
  }

  // Maps Link
  const mapsLink = document.getElementById("maps-link");
  if (mapsLink) {
    if (event.location) {
      mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`;
      mapsLink.hidden = false;
    } else {
      mapsLink.hidden = true;
    }
  }
}

function toggleAllDayUI(isAllDay) {
  // datetime-local vs date formatting if desired
  const startInput = document.getElementById("input-start");
  const endInput = document.getElementById("input-end");
  if (!startInput || !endInput) return;

  if (isAllDay) {
    startInput.type = "date";
    endInput.type = "date";
    if (startInput.value.includes("T")) startInput.value = startInput.value.split("T")[0];
    if (endInput.value.includes("T")) endInput.value = endInput.value.split("T")[0];
  } else {
    startInput.type = "datetime-local";
    endInput.type = "datetime-local";
    if (state.event?.startDateTime) startInput.value = toLocalInputString(state.event.startDateTime);
    if (state.event?.endDateTime) endInput.value = toLocalInputString(state.event.endDateTime);
  }
}

function toLocalInputString(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputString(val) {
  if (!val) return null;
  // If date-only (e.g. 2026-10-15)
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    const d = new Date(`${val}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ---------- Calendar Entry Creation & Auto-Delete Lifecycle ---------- */

/**
 * Triggered whenever the user launches or creates the calendar entry:
 * - "Open in Default Calendar (.ics)"
 * - "Google Calendar"
 * - "Outlook Calendar"
 * - "Download .ics"
 *
 * If `state.autoDeletePhoto` is enabled, this function completely deletes
 * the photo from memory, canvas, object URLs, and preview buffers.
 */
function handlePostCalendarCreation() {
  if (!state.autoDeletePhoto) return;

  // Wipe image state and revoke Object URL
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }
  state.imageFile = null;
  state.imageDataUrl = null;

  // Clear preview images from DOM
  const previewImg = document.getElementById("preview-image");
  if (previewImg) {
    previewImg.src = "";
    previewImg.removeAttribute("src");
  }

  const thumbImg = document.getElementById("extracting-preview-thumbnail");
  if (thumbImg) {
    thumbImg.src = "";
    thumbImg.removeAttribute("src");
  }

  // Update status notification bar
  const statusBar = document.getElementById("auto-delete-status-bar");
  const statusText = document.getElementById("auto-delete-status-text");
  if (statusBar && statusText) {
    statusBar.classList.add("purged");
    statusText.textContent = "✓ Photo automatically deleted from app memory & cache";
  }

  showToast("🗑️ Photo auto-deleted from app memory");
}

async function saveToDefaultCalendar() {
  const event = readReviewForm();
  if (!event.title) {
    showToast("Event title is required");
    document.getElementById("input-title")?.focus();
    return;
  }
  if (!event.startDateTime) {
    showToast("Event start date/time is required");
    document.getElementById("input-start")?.focus();
    return;
  }

  state.event = event;

  try {
    const res = await openInDefaultCalendar(event);
    if (!res.aborted) {
      showToast("Opening in your calendar app to review and confirm…");
      handlePostCalendarCreation();
    }
  } catch (err) {
    console.error("Default calendar open failed:", err);
    downloadICS(event);
    showToast("Calendar file downloaded — open to review & save");
    handlePostCalendarCreation();
  }
}

function triggerDownloadIcs() {
  const event = readReviewForm();
  if (!event.title || !event.startDateTime) {
    showToast("Title and start time are required");
    return;
  }
  downloadICS(event);
  showToast(".ics file downloaded — open to review & save");
  handlePostCalendarCreation();
}

async function copyEventJson() {
  const event = readReviewForm();
  try {
    await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
    showToast("Event JSON copied to clipboard");
  } catch {
    showToast("Clipboard access denied by browser");
  }
}

function startOver() {
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }
  state.imageFile = null;
  state.imageDataUrl = null;
  state.event = null;

  const previewImg = document.getElementById("preview-image");
  if (previewImg) previewImg.src = "";

  const thumbImg = document.getElementById("extracting-preview-thumbnail");
  if (thumbImg) thumbImg.src = "";

  const statusBar = document.getElementById("auto-delete-status-bar");
  const statusText = document.getElementById("auto-delete-status-text");
  if (statusBar && statusText) {
    statusBar.classList.remove("purged");
    statusText.textContent = "Photo will be automatically deleted from memory upon opening calendar";
  }

  showScreen("home");
}

/* ---------- Settings Drawer Controller ---------- */
function openSettings() {
  const drawer = document.getElementById("settings-drawer");
  if (!drawer) return;

  const inputKey = document.getElementById("input-gemini-key");
  const selectModel = document.getElementById("select-gemini-model");
  const toggleAutoDel = document.getElementById("toggle-auto-delete-settings");

  if (inputKey) inputKey.value = state.geminiApiKey;
  if (selectModel) selectModel.value = state.geminiModel;
  if (toggleAutoDel) toggleAutoDel.checked = state.autoDeletePhoto;

  // Clear any previous test badges
  const testBadge = document.getElementById("test-result-badge");
  if (testBadge) testBadge.hidden = true;

  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  const drawer = document.getElementById("settings-drawer");
  if (!drawer) return;

  const inputKey = document.getElementById("input-gemini-key");
  const selectModel = document.getElementById("select-gemini-model");
  const toggleAutoDel = document.getElementById("toggle-auto-delete-settings");

  state.geminiApiKey = (inputKey?.value || "").trim();
  state.geminiModel = selectModel?.value || "gemini-2.5-flash";
  state.autoDeletePhoto = Boolean(toggleAutoDel?.checked);

  // Sync home screen toggle
  const toggleHome = document.getElementById("toggle-auto-delete-home");
  if (toggleHome) toggleHome.checked = state.autoDeletePhoto;

  saveSettings({
    geminiApiKey: state.geminiApiKey,
    geminiModel: state.geminiModel,
    autoDeletePhoto: state.autoDeletePhoto,
  });

  updateApiStatusIndicator();

  drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
}

async function testApiKeyConnection() {
  const inputKey = document.getElementById("input-gemini-key");
  const keyToTest = (inputKey?.value || "").trim();

  const spinner = document.getElementById("test-key-spinner");
  const btnText = document.getElementById("test-key-btn-text");
  const resultBadge = document.getElementById("test-result-badge");

  if (!keyToTest) {
    if (resultBadge) {
      resultBadge.className = "test-result-badge error";
      resultBadge.textContent = "Please enter an API key to test";
      resultBadge.hidden = false;
    }
    return;
  }

  if (spinner) spinner.hidden = false;
  if (btnText) btnText.textContent = "Testing...";
  if (resultBadge) resultBadge.hidden = true;

  try {
    const res = await testGeminiKey(keyToTest);
    if (res.ok) {
      resultBadge.className = "test-result-badge success";
      resultBadge.textContent = "✓ Connected to Google Gemini successfully!";
      resultBadge.hidden = false;

      // Update stored key
      state.geminiApiKey = keyToTest;
      saveSettings({
        geminiApiKey: state.geminiApiKey,
        geminiModel: state.geminiModel,
        autoDeletePhoto: state.autoDeletePhoto,
      });
      updateApiStatusIndicator();
    } else {
      resultBadge.className = "test-result-badge error";
      resultBadge.textContent = `✗ ${res.error}`;
      resultBadge.hidden = false;
    }
  } catch (err) {
    resultBadge.className = "test-result-badge error";
    resultBadge.textContent = `✗ Connection error: ${err.message}`;
    resultBadge.hidden = false;
  } finally {
    if (spinner) spinner.hidden = true;
    if (btnText) btnText.textContent = "Test Key Connection";
  }
}

function togglePasswordVisibility() {
  const input = document.getElementById("input-gemini-key");
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
}

function clearAllData() {
  if (!confirm("This will permanently remove your Gemini API key and reset all preferences. Continue?")) {
    return;
  }
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(LEGACY_KEY);
  state.geminiApiKey = "";
  state.autoDeletePhoto = true;
  state.geminiModel = "gemini-2.5-flash";

  showToast("All settings and keys cleared");
  closeSettings();
  setTimeout(() => location.reload(), 400);
}

/* ---------- Global Event Wiring ---------- */
function bindEvents() {
  // File inputs
  const fileCamera = document.getElementById("file-camera");
  const fileLibrary = document.getElementById("file-library");

  fileCamera?.addEventListener("change", (e) => {
    handleFileChosen(e.target.files?.[0]);
    e.target.value = "";
  });

  fileLibrary?.addEventListener("change", (e) => {
    handleFileChosen(e.target.files?.[0]);
    e.target.value = "";
  });

  // Drag & Drop
  const dropzone = document.getElementById("dropzone");
  if (dropzone) {
    dropzone.addEventListener("click", () => fileLibrary?.click());
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("is-dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileChosen(file);
    });
  }

  // Clipboard Paste (⌘V / Ctrl+V)
  window.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          handleFileChosen(file);
          showToast("Image pasted from clipboard");
          break;
        }
      }
    }
  });

  // Auto-delete toggle on Home screen
  const toggleHome = document.getElementById("toggle-auto-delete-home");
  toggleHome?.addEventListener("change", (e) => {
    state.autoDeletePhoto = Boolean(e.target.checked);
    const toggleSettings = document.getElementById("toggle-auto-delete-settings");
    if (toggleSettings) toggleSettings.checked = state.autoDeletePhoto;
    saveSettings({
      geminiApiKey: state.geminiApiKey,
      geminiModel: state.geminiModel,
      autoDeletePhoto: state.autoDeletePhoto,
    });
  });

  // Auto-delete toggle in Settings drawer
  const toggleSettings = document.getElementById("toggle-auto-delete-settings");
  toggleSettings?.addEventListener("change", (e) => {
    state.autoDeletePhoto = Boolean(e.target.checked);
    if (toggleHome) toggleHome.checked = state.autoDeletePhoto;
    saveSettings({
      geminiApiKey: state.geminiApiKey,
      geminiModel: state.geminiModel,
      autoDeletePhoto: state.autoDeletePhoto,
    });
  });

  // Review form real-time updates
  const eventForm = document.getElementById("event-form");
  if (eventForm) {
    eventForm.addEventListener("input", updateCalendarLinks);
    eventForm.elements.allDay?.addEventListener("change", (e) => {
      toggleAllDayUI(e.target.checked);
      updateCalendarLinks();
    });
  }

  // Google & Outlook web links auto-delete hook
  document.getElementById("export-google-btn")?.addEventListener("click", () => {
    handlePostCalendarCreation();
  });
  document.getElementById("export-outlook-btn")?.addEventListener("click", () => {
    handlePostCalendarCreation();
  });

  // Action delegation
  document.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    switch (action) {
      case "take-photo":
        fileCamera?.click();
        break;
      case "choose-photo":
        fileLibrary?.click();
        break;
      case "open-live-camera":
        openLiveCamera();
        break;
      case "close-live-camera":
        closeLiveCamera();
        break;
      case "snap-photo":
        snapLivePhoto();
        break;
      case "flip-camera":
        flipCamera();
        break;
      case "extract":
      case "re-extract":
        startExtraction();
        break;
      case "cancel-extract":
        cancelExtraction();
        break;
      case "back-home":
        startOver();
        break;
      case "back-preview":
        showScreen("preview");
        break;
      case "save-default-calendar":
        saveToDefaultCalendar();
        break;
      case "download-ics":
        triggerDownloadIcs();
        break;
      case "copy-json":
        copyEventJson();
        break;
      case "start-over":
        startOver();
        break;
      case "open-settings":
        openSettings();
        break;
      case "close-settings":
        closeSettings();
        break;
      case "test-api-key":
        testApiKeyConnection();
        break;
      case "clear-all":
        clearAllData();
        break;
    }
  });

  // Password toggle
  document.getElementById("btn-toggle-key-visibility")?.addEventListener("click", togglePasswordVisibility);

  // PWA Install Prompt
  const installBtn = document.getElementById("install-btn");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  installBtn?.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    const { outcome } = await state.deferredInstallPrompt.userChoice;
    if (outcome === "accepted") {
      installBtn.hidden = true;
    }
    state.deferredInstallPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    if (installBtn) installBtn.hidden = true;
    showToast("Schedule from Pic installed!");
  });

  // Service Worker registration
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("ServiceWorker registration failed:", err);
    });
  }
}

/* ---------- App Initialization ---------- */
initSettings();
bindEvents();
showScreen("home");
