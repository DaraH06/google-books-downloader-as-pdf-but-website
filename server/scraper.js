const puppeteer = require("puppeteer");

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/* ── image-url filters (ported from extension utils/dom.js) ── */

const PREVIEW_HOST_RE = /googleusercontent\.com|gstatic\.com/i;
const IGNORED_RE =
  /favicon|logo|avatar|profile|button|icon|cleardot|googlesyndication|googlebooks\/images\//i;
const BOOKS_CONTENT_RE = /\/books\/(?:publisher\/)?content\b/i;

function isPreviewImageUrl(url) {
  if (!url || url.startsWith("data:")) return false;
  if (IGNORED_RE.test(url)) return false;
  if (BOOKS_CONTENT_RE.test(url) && /[?&](?:pg=|img=1|imgidx=)/i.test(url))
    return true;
  return PREVIEW_HOST_RE.test(url);
}

const PAGE_NUM_PATTERNS = [
  /[?&]pg=PA(\d+)/i,
  /[?&]pg=PP(\d+)/i,
  /[?&]pg=PR(\d+)/i,
  /[?&]pg=(\d+)/i,
  /[?&]page=(\d+)/i,
  /[?&]imgidx=(\d+)/i,
  /(?:^|[/_-])PA(\d+)(?:[._-]|$)/i,
  /(?:^|[/_-])PP(\d+)(?:[._-]|$)/i,
];

function extractPageNumber(url, fallback) {
  for (const re of PAGE_NUM_PATTERNS) {
    const m = url.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return fallback;
}

/** Check first bytes for known image magic numbers. */
function isImageBuffer(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return true; // PNG
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf.length >= 12 && buf[8] === 0x57)
    return true; // WebP
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  return false;
}

/* ── helpers ── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeBookUrl(raw) {
  const u = new URL(raw);
  if (!u.searchParams.has("pg")) {
    u.searchParams.set("printsec", "frontcover");
  }
  return u.toString();
}

/* ── main scraper ── */

/**
 * Scrape Google Books preview pages.
 * @param {string} url  Google Books URL
 * @param {(data: object) => void} emit  progress callback
 * @returns {Promise<{ title: string, images: { buffer: Buffer, pageNumber: number }[] }>}
 */
async function scrapeBook(url, emit) {
  let browser = null;
  // url → buffer (from network intercept)
  const interceptedBuffers = new Map();
  // all unique preview image URLs seen (ordered)
  const seenUrls = new Set();
  const urlOrder = [];

  try {
    browser = await puppeteer.launch({
      headless: "new",
      // Use system Chromium in production (set via PUPPETEER_EXECUTABLE_PATH in Dockerfile)
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      }),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
        "--disable-extensions",
      ],
    });


    const page = await browser.newPage();
    await page.setUserAgent(MOBILE_UA);
    await page.setViewport({
      width: 412,
      height: 915,
      isMobile: true,
      hasTouch: true,
    });

    /* intercept image responses — save buffer opportunistically */
    page.on("response", async (res) => {
      const resUrl = res.url();
      if (!isPreviewImageUrl(resUrl)) return;

      // Track all seen preview URLs even before we have their buffer
      if (!seenUrls.has(resUrl)) {
        seenUrls.add(resUrl);
        urlOrder.push(resUrl);
        emit({
          stage: "scanning",
          message: `Memindai... ${seenUrls.size} halaman ditemukan`,
        });
      }

      // Try to grab the buffer if we don't have it yet
      if (interceptedBuffers.has(resUrl)) return;
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.startsWith("image/")) return;
        const buf = await res.buffer();
        if (buf.length > 5000 && isImageBuffer(buf)) {
          interceptedBuffers.set(resUrl, buf);
        }
      } catch {
        /* response body already consumed – will re-fetch later */
      }
    });

    emit({ stage: "scanning", message: "Membuka Google Books..." });

    const bookUrl = normalizeBookUrl(url);
    await page.goto(bookUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(2000);

    /* grab title */
    const title = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="og:title"]');
      if (meta?.content) return meta.content;
      for (const sel of ["h1", '[itemprop="name"]']) {
        const el = document.querySelector(sel);
        const t = el?.textContent?.trim();
        if (t) return t.replace(/\s*-\s*Google (?:Books|Buku)\s*$/i, "").trim();
      }
      return document.title
        .replace(/\s*-\s*Google (?:Books|Buku)\s*$/i, "")
        .trim() || "Google Books Preview";
    });

    emit({ stage: "scanning", message: `Memindai: ${title}`, bookTitle: title });

    /* try to open preview if we're on the info page */
    await tryOpenPreview(page);
    await sleep(1500);

    /* Phase 1: scroll down slowly to load all lazy pages */
    emit({ stage: "scanning", message: "Scroll halaman (fase 1)...", bookTitle: title });
    await autoScroll(page, seenUrls, emit, { direction: "down" });

    /* Phase 2: scroll back up (catches any pages missed on the way down) */
    emit({ stage: "scanning", message: "Scroll halaman (fase 2)...", bookTitle: title });
    await autoScroll(page, seenUrls, emit, { direction: "up" });

    /* Phase 3: scroll down again to catch anything new revealed by phase 2 */
    const beforePhase3 = seenUrls.size;
    await autoScroll(page, seenUrls, emit, { direction: "down" });
    if (seenUrls.size > beforePhase3) {
      // Found more on third pass — do one more reverse
      await autoScroll(page, seenUrls, emit, { direction: "up" });
    }

    /* Phase 4: keyboard navigation (Page Down) for page-flip readers */
    emit({ stage: "scanning", message: "Navigasi keyboard...", bookTitle: title });
    await keyboardNavigation(page, seenUrls, emit);

    emit({
      stage: "collecting",
      message: `Mengambil ${seenUrls.size} gambar...`,
      current: 0,
      total: seenUrls.size,
      bookTitle: title,
    });

    /* Phase 5: fetch all image URLs with session cookies to get fresh buffers */
    const images = await fetchAllImages(page, urlOrder, interceptedBuffers, emit, title);

    if (images.length === 0) {
      throw new Error(
        "Tidak ada halaman preview ditemukan. Pastikan buku memiliki preview yang tersedia."
      );
    }

    emit({
      stage: "collecting",
      message: `Berhasil mengumpulkan ${images.length} halaman`,
      current: images.length,
      total: images.length,
      bookTitle: title,
    });

    return { title, images };
  } finally {
    if (browser) await browser.close();
  }
}

/* ── try opening the preview reader if we're on the info page ── */

async function tryOpenPreview(page) {
  try {
    const clicked = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('a[href*="printsec"]'),
        ...document.querySelectorAll('a[href*="pg="]'),
        ...document.querySelectorAll("button"),
      ];
      for (const el of candidates) {
        const text = (el.textContent || "").toLowerCase();
        if (
          text.includes("preview") ||
          text.includes("pratinjau") ||
          text.includes("read") ||
          text.includes("baca") ||
          text.includes("sample")
        ) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      await page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 })
        .catch(() => {});
    }
  } catch {
    /* already in reader */
  }
}

/* ── auto-scroll with better idle detection ── */

async function autoScroll(page, seenUrls, emit, { direction = "down" } = {}) {
  const SCROLL_STEP = 300;    // smaller step = more pages per viewport
  const SCROLL_DELAY = 500;   // longer delay = more time for lazy images
  const MAX_ITERATIONS = 600;
  const IDLE_LIMIT = 25;      // allow longer stretches with no new images

  let lastCount = seenUrls.size;
  let idleCount = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (direction === "down") {
      await page.evaluate((step) => window.scrollBy(0, step), SCROLL_STEP);
    } else {
      await page.evaluate((step) => window.scrollBy(0, -step), SCROLL_STEP);
    }
    await sleep(SCROLL_DELAY);

    const currentCount = seenUrls.size;
    if (currentCount === lastCount) {
      idleCount++;
    } else {
      idleCount = 0;
      lastCount = currentCount;
    }

    if (i % 10 === 0) {
      emit({
        stage: "scanning",
        message: `Memindai... ${currentCount} halaman ditemukan`,
      });
    }

    if (idleCount >= IDLE_LIMIT) break;
  }
}

/* ── keyboard page navigation for page-flip style readers ── */

async function keyboardNavigation(page, seenUrls, emit) {
  let lastCount = seenUrls.size;
  let idleCount = 0;
  const IDLE_LIMIT = 10;

  // Try pressing Right arrow to flip pages
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("ArrowRight");
    await sleep(500);

    const currentCount = seenUrls.size;
    if (currentCount === lastCount) {
      idleCount++;
    } else {
      idleCount = 0;
      lastCount = currentCount;
    }

    if (i % 5 === 0) {
      emit({
        stage: "scanning",
        message: `Navigasi keyboard... ${currentCount} halaman`,
      });
    }

    if (idleCount >= IDLE_LIMIT) break;
  }
}

/* ── fetch all collected URLs with session cookies for fresh buffers ── */

async function fetchAllImages(page, urlOrder, interceptedBuffers, emit, title) {
  const results = [];
  const total = urlOrder.length;

  for (let i = 0; i < urlOrder.length; i++) {
    const imgUrl = urlOrder[i];

    // Prefer buffer from intercepted response (already validated)
    let buf = interceptedBuffers.get(imgUrl);

    if (!buf || !isImageBuffer(buf)) {
      // Re-fetch using page context (includes session cookies)
      buf = await fetchWithPageCookies(page, imgUrl);
    }

    if (buf && isImageBuffer(buf)) {
      results.push({
        buffer: buf,
        pageNumber: extractPageNumber(imgUrl, i),
      });
    }
    // Skip silently if still not valid — don't break the whole job

    emit({
      stage: "collecting",
      message: `Mengambil gambar ${i + 1}/${total}`,
      current: i + 1,
      total,
      bookTitle: title,
    });
  }

  // Sort by page number
  return results.sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Fetch an image URL using the page's session (cookies, headers).
 * Falls back to a direct fetch from Node.js if the page fetch fails.
 */
async function fetchWithPageCookies(page, imgUrl) {
  try {
    const bytes = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        return Array.from(new Uint8Array(ab));
      } catch {
        return null;
      }
    }, imgUrl);

    if (bytes && bytes.length > 5000) {
      return Buffer.from(bytes);
    }
  } catch {
    /* page context unavailable */
  }
  return null;
}

module.exports = { scrapeBook };
