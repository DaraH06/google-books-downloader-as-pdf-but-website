/* ── elements ── */
const form = document.getElementById("scrape-form");
const urlInput = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");
const btnText = submitBtn.querySelector(".btn-text");
const btnLoader = submitBtn.querySelector(".btn-loader");

const progressSection = document.getElementById("progress-section");
const bookTitle = document.getElementById("book-title");
const stageBadge = document.getElementById("stage-badge");
const statusMessage = document.getElementById("status-message");
const progressFill = document.getElementById("progress-fill");
const progressCount = document.getElementById("progress-count");
const progressPercent = document.getElementById("progress-percent");

const downloadSection = document.getElementById("download-section");
const resultInfo = document.getElementById("result-info");
const downloadLink = document.getElementById("download-link");

const errorSection = document.getElementById("error-section");
const errorMessage = document.getElementById("error-message");

const newBtn = document.getElementById("new-btn");
const retryBtn = document.getElementById("retry-btn");

let eventSource = null;

/* ── stage labels ── */
const STAGE_LABELS = {
  queued: "Antrian",
  scanning: "Memindai",
  collecting: "Mengumpulkan",
  generating: "Membuat PDF",
  complete: "Selesai",
  error: "Gagal",
};

/* ── form submit ── */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  setBusy(true);
  hideAll();

  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    showProgress();
    connectSSE(data.jobId);
  } catch (err) {
    showError(err.message);
    setBusy(false);
  }
});

/* ── SSE ── */
function connectSSE(jobId) {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/jobs/${jobId}/events`);

  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    updateProgress(data);

    if (data.stage === "complete") {
      eventSource.close();
      eventSource = null;
      showDownload(jobId, data);
      setBusy(false);
    }

    if (data.stage === "error") {
      eventSource.close();
      eventSource = null;
      showError(data.message || data.error);
      setBusy(false);
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    showError("Koneksi ke server terputus.");
    setBusy(false);
  };
}

/* ── progress rendering ── */
function updateProgress(data) {
  bookTitle.textContent = data.bookTitle || "—";
  stageBadge.textContent = STAGE_LABELS[data.stage] || data.stage;
  stageBadge.className = "stage-badge";
  statusMessage.textContent = data.message || "...";

  const total = data.total || 0;
  const current = data.current || 0;
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  progressFill.style.width = `${pct}%`;
  progressCount.textContent = total > 0 ? `${current} / ${total}` : "—";
  progressPercent.textContent = total > 0 ? `${pct}%` : "";
}

function showDownload(jobId, data) {
  hideAll();
  resultInfo.textContent = `${data.bookTitle || "—"} • ${data.total} halaman`;
  downloadLink.href = `/api/download/${jobId}`;
  downloadLink.download = data.filename || "book.pdf";
  downloadSection.classList.remove("hidden");
}

/* ── helpers ── */
function showProgress() {
  hideAll();
  progressSection.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressCount.textContent = "—";
  progressPercent.textContent = "";
}

function showError(msg) {
  hideAll();
  errorMessage.textContent = msg;
  errorSection.classList.remove("hidden");
}

function hideAll() {
  progressSection.classList.add("hidden");
  downloadSection.classList.add("hidden");
  errorSection.classList.add("hidden");
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  urlInput.disabled = busy;
  btnText.classList.toggle("hidden", busy);
  btnLoader.classList.toggle("hidden", !busy);
}

function reset() {
  hideAll();
  urlInput.disabled = false;
  urlInput.value = "";
  urlInput.focus();
  setBusy(false);
}

newBtn.addEventListener("click", reset);
retryBtn.addEventListener("click", reset);
