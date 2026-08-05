const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { scrapeBook } = require("./scraper");
const { buildPdf } = require("./pdf-builder");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ── in-memory job store ── */

const jobs = new Map();
const MAX_CONCURRENT = 2;
let activeJobs = 0;

// Purge jobs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      job.pdfBuffer = null; // free memory
      jobs.delete(id);
    }
  }
}, 5 * 60_000);

/* ── URL validation (ported from extension) ── */

function isGoogleBooksUrl(url) {
  try {
    const parsed = new URL(url);
    if (/^books\.google\.[a-z.]+$/i.test(parsed.hostname)) return true;
    if (
      /\.google\.[a-z.]+$/i.test(parsed.hostname) &&
      /\/books(?:\/|$|\?)/i.test(parsed.pathname)
    )
      return true;
    return false;
  } catch {
    return false;
  }
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/* ── routes ── */

// Create a new scraping job
app.post("/api/jobs", (req, res) => {
  const { url } = req.body;
  if (!url || !isGoogleBooksUrl(url)) {
    return res.status(400).json({ error: "URL Google Books tidak valid." });
  }
  if (activeJobs >= MAX_CONCURRENT) {
    return res
      .status(429)
      .json({ error: "Server sedang sibuk. Coba lagi dalam beberapa menit." });
  }

  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id,
    url,
    createdAt: Date.now(),
    progress: {
      stage: "queued",
      message: "Menunggu...",
      current: 0,
      total: 0,
    },
    pdfBuffer: null,
    filename: null,
    /** @type {Set<(data: object) => void>} */
    listeners: new Set(),
  };
  jobs.set(id, job);

  processJob(job); // fire-and-forget

  res.json({ jobId: id });
});

// SSE progress stream
app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send current state immediately
  res.write(`data: ${JSON.stringify(job.progress)}\n\n`);

  const listener = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client disconnected */
    }
  };
  job.listeners.add(listener);

  req.on("close", () => job.listeners.delete(listener));
});

// PDF download
app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.pdfBuffer) {
    return res.status(404).json({ error: "PDF tidak tersedia." });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(job.filename)}"`
  );
  res.setHeader("Content-Length", job.pdfBuffer.length);
  res.send(job.pdfBuffer);
});

/* ── job processor ── */

async function processJob(job) {
  activeJobs++;

  const emit = (data) => {
    Object.assign(job.progress, data);
    for (const fn of job.listeners) fn(job.progress);
  };

  try {
    const result = await scrapeBook(job.url, emit);

    emit({
      stage: "generating",
      message: "Membuat PDF...",
      current: 0,
      total: result.images.length,
      bookTitle: result.title,
    });

    const pdfBuffer = await buildPdf(result.images, (current, total) => {
      emit({
        stage: "generating",
        message: `Menyusun halaman ${current}/${total}`,
        current,
        total,
      });
    });

    job.pdfBuffer = pdfBuffer;
    job.filename =
      (sanitizeFilename(result.title) || "Google Books Preview") + ".pdf";

    emit({
      stage: "complete",
      message: "Selesai!",
      filename: job.filename,
      bookTitle: result.title,
      total: result.images.length,
      current: result.images.length,
    });
  } catch (err) {
    emit({
      stage: "error",
      message: err.message || String(err),
      error: err.message || String(err),
    });
  } finally {
    activeJobs--;
  }
}

/* ── start ── */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server berjalan di http://localhost:${PORT}`);
});
