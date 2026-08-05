# google-books-downloader-as-pdf-but-website

Website untuk mengonversi halaman preview Google Books menjadi satu file PDF.

Cukup paste URL Google Books → website akan membuka buku menggunakan mobile User-Agent, scroll otomatis untuk memuat semua halaman preview, lalu menyusunnya menjadi satu PDF yang bisa didownload.

## Cara Pakai

```bash
npm install
npm start
# Buka http://localhost:3000
```

## Tech Stack

- **Server**: Node.js + Express
- **Scraper**: Puppeteer (headless Chromium, mobile User-Agent)
- **PDF**: pdf-lib + sharp (WebP → PNG conversion)
- **Frontend**: Vanilla HTML/CSS/JS (glassmorphism dark theme)

## Fitur

- Paste URL Google Books → langsung download PDF
- Menggunakan mobile User-Agent agar Google Books menampilkan lebih banyak halaman preview
- Real-time progress via Server-Sent Events (SSE)
- Multi-pass scrolling untuk menangkap semua halaman lazy-loaded
- Re-fetch gambar dengan session cookies agar tidak ada halaman rusak
