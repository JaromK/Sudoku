// Reads a sudoku grid from a picture.
// 1. find the grid's four corners (largest connected blob of dark lines),
// 2. straighten it with a perspective warp,
// 3. cut out each cell, keep the big ink blob in the middle (small pencil marks are ignored),
// 4. read the digit with Tesseract (loaded from a CDN only when needed).
// Image functions work on { w, h, data } grayscale arrays so they also run in Node.
(function (root, factory) {
  const O = factory();
  if (typeof module === 'object' && module.exports) module.exports = O;
  else root.SudokuOCR = O;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // ---------- grayscale helpers ----------
  function grayFromRGBA(rgba, w, h) {
    const data = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      data[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    }
    return { w, h, data };
  }

  function resize(img, maxDim) {
    const k = Math.min(1, maxDim / Math.max(img.w, img.h));
    if (k === 1) return { img, k };
    const w = Math.max(1, Math.round(img.w * k)), h = Math.max(1, Math.round(img.h * k));
    const data = new Uint8ClampedArray(w * h);
    // box filter downscale
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y / k), y1 = Math.min(img.h, Math.floor((y + 1) / k));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x / k), x1 = Math.min(img.w, Math.floor((x + 1) / k));
        let sum = 0, n = 0;
        for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) { sum += img.data[yy * img.w + xx]; n++; }
        data[y * w + x] = sum / n;
      }
    }
    return { img: { w, h, data }, k };
  }

  // Dark-pixel mask: pixel is ink if it is clearly darker than its neighbourhood.
  function adaptiveThreshold(img, radius, C) {
    const { w, h, data } = img;
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += data[y * w + x];
        integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row;
      }
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
        const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        if (data[y * w + x] < mean - C) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  // Connected components (8-neighbour) of a 0/1 mask inside a rectangle.
  function components(mask, w, h, rx, ry, rw, rh, minPixels) {
    const seen = new Uint8Array(w * h);
    const out = [];
    const stack = [];
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const p = y * w + x;
        if (!mask[p] || seen[p]) continue;
        let n = 0, minX = x, maxX = x, minY = y, maxY = y;
        let tl = Infinity, br = -Infinity, tr = -Infinity, bl = Infinity;
        let tlP = p, brP = p, trP = p, blP = p;
        const pixels = [];
        stack.push(p); seen[p] = 1;
        while (stack.length) {
          const q = stack.pop();
          const qx = q % w, qy = (q / w) | 0;
          n++; pixels.push(q);
          if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
          if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
          const s = qx + qy, d = qx - qy;
          if (s < tl) { tl = s; tlP = q; } if (s > br) { br = s; brP = q; }
          if (d > tr) { tr = d; trP = q; } if (d < bl) { bl = d; blP = q; }
          for (let dy = -1; dy <= 1; dy++) {
            const ny = qy + dy;
            if (ny < ry || ny >= ry + rh) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = qx + dx;
              if (nx < rx || nx >= rx + rw) continue;
              const np = ny * w + nx;
              if (mask[np] && !seen[np]) { seen[np] = 1; stack.push(np); }
            }
          }
        }
        if (n >= minPixels) out.push({ n, minX, maxX, minY, maxY, pixels, corners: [tlP, trP, brP, blP] });
      }
    }
    return out;
  }

  // Returns the grid's corners [tl, tr, br, bl] as {x,y} in the image's coordinates.
  function detectGrid(img) {
    const { img: small, k } = resize(img, 500);
    const { w, h } = small;
    const mask = adaptiveThreshold(small, Math.max(5, Math.round(Math.min(w, h) / 40)), 6);
    const comps = components(mask, w, h, 0, 0, w, h, 50);
    const minSide = Math.min(w, h) * 0.25;
    let best = null;
    for (const c of comps) {
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      if (bw < minSide || bh < minSide) continue;
      const ratio = bw / bh;
      if (ratio < 0.6 || ratio > 1.65) continue;
      const area = bw * bh;
      if (c.n / area > 0.5) continue; // a solid dark area, not a grid
      if (!best || area > best.area) best = { c, area };
    }
    if (!best) {
      const m = 0.04;
      return { found: false, corners: [
        { x: img.w * m, y: img.h * m }, { x: img.w * (1 - m), y: img.h * m },
        { x: img.w * (1 - m), y: img.h * (1 - m) }, { x: img.w * m, y: img.h * (1 - m) }] };
    }
    const corners = best.c.corners.map(p => ({ x: ((p % w) + 0.5) / k, y: (((p / w) | 0) + 0.5) / k }));
    return { found: true, corners };
  }

  // ---------- perspective warp ----------
  function solveLinear(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }
  // Homography mapping square (0..N) to the quad.
  function homography(N, quad) {
    const src = [[0, 0], [N, 0], [N, N], [0, N]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], { x: u, y: v } = quad[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return solveLinear(A, b);
  }
  function warp(img, quad, N) {
    const H = homography(N, quad);
    const data = new Uint8ClampedArray(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const X = x + 0.5, Y = y + 0.5;
        const den = H[6] * X + H[7] * Y + 1;
        const u = (H[0] * X + H[1] * Y + H[2]) / den - 0.5;
        const v = (H[3] * X + H[4] * Y + H[5]) / den - 0.5;
        const x0 = Math.floor(u), y0 = Math.floor(v);
        if (x0 < 0 || y0 < 0 || x0 >= img.w - 1 || y0 >= img.h - 1) { data[y * N + x] = 255; continue; }
        const fx = u - x0, fy = v - y0, p = y0 * img.w + x0;
        const a = img.data[p], b2 = img.data[p + 1], c = img.data[p + img.w], d = img.data[p + img.w + 1];
        data[y * N + x] = (a * (1 - fx) + b2 * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
    return { w: N, h: N, data };
  }

  // ---------- cell extraction ----------
  // Returns 81 entries: null (empty) or { glyph: {w,h,data 0/1 mask}, aspect }.
  function extractCells(grid) {
    const N = grid.w, cs = N / 9;
    const mask = adaptiveThreshold(grid, Math.max(4, Math.round(cs / 4)), 12);
    const cells = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const m = Math.round(cs * 0.1);
        const x0 = Math.round(c * cs) + m, y0 = Math.round(r * cs) + m;
        const size = Math.round(cs) - 2 * m;
        const comps = components(mask, N, N, x0, y0, size, size, Math.max(8, cs * cs * 0.008));
        let best = null;
        const cx = x0 + size / 2, cy = y0 + size / 2;
        for (const k of comps) {
          const bw = k.maxX - k.minX + 1, bh = k.maxY - k.minY + 1;
          if (bh < cs * 0.32 || bh > size * 0.98) continue;          // too small (pencil mark) or a line
          if (bw > size * 0.9) continue;                              // horizontal line remnant
          if (bw / bh > 1.3) continue;                                // digits are taller than wide
          // must sit around the middle of the cell
          const mx = (k.minX + k.maxX) / 2, my = (k.minY + k.maxY) / 2;
          if (Math.abs(mx - cx) > size * 0.3 || Math.abs(my - cy) > size * 0.3) continue;
          if (!best || k.n > best.n) best = k;
        }
        if (!best) { cells.push(null); continue; }
        // Re-threshold the digit's box with Otsu so thin strokes survive blur.
        const pad = 2;
        const minX = Math.max(x0, best.minX - pad), maxX = Math.min(x0 + size - 1, best.maxX + pad);
        const minY = Math.max(y0, best.minY - pad), maxY = Math.min(y0 + size - 1, best.maxY + pad);
        const gw = maxX - minX + 1, gh = maxY - minY + 1;
        const hist = new Array(256).fill(0);
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) hist[grid.data[y * N + x]]++;
        const t = otsu(hist, gw * gh);
        const data = new Uint8Array(gw * gh);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          if (grid.data[(y + minY) * N + x + minX] <= t) data[y * gw + x] = 1;
        }
        cells.push({ glyph: { w: gw, h: gh, data }, aspect: gw / gh });
      }
    }
    return cells;
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    return t;
  }

  // Draws a glyph as black-on-white, centred with padding, into RGBA (for Tesseract).
  function glyphToRGBA(glyph, H) {
    H = H || 40;
    const pad = Math.round(H * 0.6);
    const scale = H / glyph.h;
    const gw = Math.max(1, Math.round(glyph.w * scale));
    const W = gw + 2 * pad, HH = H + 2 * pad;
    const out = new Uint8ClampedArray(W * HH * 4).fill(255);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < gw; x++) {
        const sx = Math.min(glyph.w - 1, Math.floor(x / scale)), sy = Math.min(glyph.h - 1, Math.floor(y / scale));
        if (glyph.data[sy * glyph.w + sx]) {
          const p = ((y + pad) * W + x + pad) * 4;
          out[p] = out[p + 1] = out[p + 2] = 0;
        }
      }
    }
    return { w: W, h: HH, rgba: out };
  }

  // ---------- browser-only parts ----------
  let tessPromise = null;
  function loadTesseract() {
    if (tessPromise) return tessPromise;
    tessPromise = new Promise((resolve, reject) => {
      if (self.Tesseract) return resolve(self.Tesseract);
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = () => resolve(self.Tesseract);
      s.onerror = () => { tessPromise = null; reject(new Error('Could not load the text-recognition library (are you online?)')); };
      document.head.appendChild(s);
    });
    return tessPromise;
  }

  let workerPromise = null;
  async function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      const T = await loadTesseract();
      const worker = await T.createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: '123456789', tessedit_pageseg_mode: '10' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
    return workerPromise;
  }

  function rgbaToCanvas({ w, h, rgba }) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return cv;
  }
  function grayToCanvas(img) {
    const rgba = new Uint8ClampedArray(img.w * img.h * 4);
    for (let i = 0; i < img.data.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = img.data[i]; rgba[i * 4 + 3] = 255; }
    return rgbaToCanvas({ w: img.w, h: img.h, rgba });
  }

  // Small fixed-size bitmap of a glyph, for comparing glyphs of the same font.
  const PROTO = 16;
  function normGlyph(g) {
    const v = new Float32Array(PROTO * PROTO);
    for (let y = 0; y < PROTO; y++) for (let x = 0; x < PROTO; x++) {
      const x0 = Math.floor(x * g.w / PROTO), x1 = Math.max(x0 + 1, Math.floor((x + 1) * g.w / PROTO));
      const y0 = Math.floor(y * g.h / PROTO), y1 = Math.max(y0 + 1, Math.floor((y + 1) * g.h / PROTO));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += g.data[yy * g.w + xx]; n++; }
      v[y * PROTO + x] = s / n;
    }
    let mean = 0; for (const t of v) mean += t; mean /= v.length;
    let norm = 0; for (let i = 0; i < v.length; i++) { v[i] -= mean; norm += v[i] * v[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
  const similarity = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  // Classifies the extracted cells. recognize(rgbaGlyph, psm) -> Promise<{text, confidence}>.
  async function classify(cells, recognize, onProgress) {
    const todo = cells.map((c, i) => (c ? i : -1)).filter(i => i >= 0);
    const digits = new Array(81).fill(0), conf = new Array(81).fill(0), unsure = new Set();
    let done = 0;
    for (const i of todo) {
      const c = cells[i];
      const rgba = glyphToRGBA(c.glyph, 40);
      let best = { d: 0, conf: 0 };
      for (const psm of ['10', '13', '8']) {
        const r = await recognize(rgba, psm);
        const txt = (r.text || '').replace(/[^1-9]/g, '');
        if (txt.length === 1) { best = { d: +txt, conf: r.confidence || 0 }; if (best.conf >= 60) break; }
      }
      digits[i] = best.d; conf[i] = best.conf;
      onProgress && onProgress(++done, todo.length);
    }
    // Same-font templates from the confident reads; use them to settle doubtful cells.
    const vecs = {};
    for (const i of todo) vecs[i] = normGlyph(cells[i].glyph);
    const protos = {};
    for (const i of todo) if (digits[i] && conf[i] >= 75) (protos[digits[i]] = protos[digits[i]] || []).push(i);
    for (const i of todo) {
      if (digits[i] && conf[i] >= 75) continue;
      let bestD = 0, bestS = -1;
      for (const d in protos) for (const j of protos[d]) {
        if (j === i) continue;
        const sim = similarity(vecs[i], vecs[j]);
        if (sim > bestS) { bestS = sim; bestD = +d; }
      }
      if (bestS > 0.85 && (bestD === digits[i] || !digits[i] || conf[i] < 50)) { digits[i] = bestD; conf[i] = 75; continue; }
      if (!digits[i] && cells[i].aspect < 0.45) { digits[i] = 1; }
      unsure.add(i);
    }
    return { digits, unsure };
  }

  // Reads all digits in the browser. onProgress(doneCount, total).
  async function readDigits(grid, onProgress) {
    const cells = extractCells(grid);
    if (!cells.some(Boolean)) return { digits: new Array(81).fill(0), unsure: new Set() };
    const worker = await getWorker();
    let curPsm = '10';
    return classify(cells, async (rgba, psm) => {
      if (psm !== curPsm) { await worker.setParameters({ tessedit_pageseg_mode: psm }); curPsm = psm; }
      const { data } = await worker.recognize(rgbaToCanvas(rgba));
      return data;
    }, onProgress);
  }

  return {
    grayFromRGBA, resize, adaptiveThreshold, detectGrid, warp, extractCells, glyphToRGBA,
    readDigits, classify, grayToCanvas, getWorker,
  };
});
