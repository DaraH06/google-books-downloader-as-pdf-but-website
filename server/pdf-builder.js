const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");

/**
 * Build a single PDF from an array of image buffers.
 * Converts non-JPEG/PNG images (e.g. WebP) to PNG via sharp.
 * Skips buffers that can't be decoded as images.
 *
 * @param {{ buffer: Buffer }[]} images
 * @param {(current: number, total: number) => void} [onProgress]
 * @returns {Promise<Buffer>}
 */
async function buildPdf(images, onProgress) {
  const doc = await PDFDocument.create();
  let added = 0;

  for (let i = 0; i < images.length; i++) {
    try {
      let buf = images[i].buffer;
      const mime = detectMime(buf);

      // pdf-lib only handles JPEG and PNG; convert anything else
      if (mime === "jpeg") {
        const img = await doc.embedJpg(buf);
        addPage(doc, img);
      } else if (mime === "png") {
        const img = await doc.embedPng(buf);
        addPage(doc, img);
      } else {
        // WebP, AVIF, or unknown → convert to PNG via sharp
        buf = await sharp(buf).png().toBuffer();
        const img = await doc.embedPng(buf);
        addPage(doc, img);
      }

      added++;
    } catch {
      // Skip undecodable buffers (HTML error pages, tiny icons, etc.)
    }

    onProgress?.(i + 1, images.length);
  }

  if (added === 0) throw new Error("Tidak ada gambar yang berhasil diproses.");

  return Buffer.from(await doc.save());
}

function addPage(doc, img) {
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
}

function detectMime(buf) {
  if (buf.length < 4) return "unknown";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "png";
  // RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "webp";
  return "unknown";
}

module.exports = { buildPdf };
