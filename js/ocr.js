// Reads a sudoku grid from a picture.
// 1. find the grid's four corners (largest connected blob of dark lines),
// 2. straighten it with a perspective warp,
// 3. cut out each cell, keep the big ink blob in the middle (small pencil marks are ignored),
// 4. recognise each digit by matching it against digits drawn in many fonts, then against the
//    photo's own confident digits (one puzzle uses one font),
// 5. if the result breaks sudoku rules, swap the least certain reads for their next-best guesses.
// Everything runs locally; nothing is downloaded.
// Image functions work on { w, h, data } grayscale arrays so they also run in Node.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const O = factory(node ? require('./engine.js') : root.SudokuEngine);
  if (node) module.exports = O;
  else root.SudokuOCR = O;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // ---------- grayscale helpers ----------
  function grayFromRGBA(rgba, w, h) {
    const data = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      data[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    }
    return { w, h, data };
  }
  // Blue-vs-red tint of each pixel (128 = neutral). Used to tell black print from pen ink.
  function chromaFromRGBA(rgba, w, h) {
    const data = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 128 + rgba[j + 2] - rgba[j];
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
  // How much a straightened square looks like a sudoku: is each 1/9 step a line that is darker
  // than the middle of the cells beside it, in both directions? Relative, so faint grey lines
  // count too. Returns 0..16 (lines found).
  function gridness(g) {
    const N = g.w, step = N / 9;
    const row = new Float32Array(N), col = new Float32Array(N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const v = g.data[y * N + x]; row[y] += v / N; col[x] += v / N; }
    let found = 0;
    for (const prof of [row, col]) {
      for (let k = 1; k <= 8; k++) {
        const c = Math.round(k * step);
        let line = 255;
        for (let o = -2; o <= 2; o++) line = Math.min(line, prof[Math.min(N - 1, Math.max(0, c + o))]);
        const a = Math.round(c - step / 2), b = Math.min(N - 1, Math.round(c + step / 2));
        const between = Math.min(prof[a], prof[b]);
        if (between - line > Math.max(6, between * 0.06)) found++;
      }
    }
    return found;
  }

  function detectGrid(img) {
    const { img: small, k } = resize(img, 500);
    const { w, h } = small;
    const mask = adaptiveThreshold(small, Math.max(5, Math.round(Math.min(w, h) / 40)), 6);
    const comps = components(mask, w, h, 0, 0, w, h, 50);
    const minSide = Math.min(w, h) * 0.2;
    // The largest outline isn't always the puzzle (the edge of the page against a table, a
    // photo frame...). Straighten each candidate and keep the one that has a sudoku's
    // internal lines; size only breaks ties.
    let best = null;
    for (const c of comps) {
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      if (bw < minSide || bh < minSide) continue;
      const ratio = bw / bh;
      if (ratio < 0.5 || ratio > 2) continue;
      const area = bw * bh;
      if (c.n / area > 0.5) continue; // a solid dark area, not a grid
      const quad = c.corners.map(p => ({ x: (p % w) + 0.5, y: ((p / w) | 0) + 0.5 }));
      const score = gridness(warp(small, quad, 144)) + area / (w * h) * 0.5;
      if (!best || score > best.score) best = { c, score };
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
  // Returns 81 entries: null (empty) or { glyph, core, aspect } where glyph is the digit with any
  // broken-off pieces merged in and core is just its biggest piece (each a {w,h,data 0/1 mask}).
  // chroma (optional): the same straightened view of chromaFromRGBA, to measure each digit's ink colour.
  function extractCells(grid, chroma) {
    const N = grid.w, cs = N / 9;
    const mask = adaptiveThreshold(grid, Math.max(4, Math.round(cs / 4)), 12);
    // Re-threshold a box with Otsu so thin strokes survive blur.
    const glyphFrom = (box, x0, y0, size) => {
      const pad = 1;
      const minX = Math.max(x0, box.minX - pad), maxX = Math.min(x0 + size - 1, box.maxX + pad);
      const minY = Math.max(y0, box.minY - pad), maxY = Math.min(y0 + size - 1, box.maxY + pad);
      const gw = maxX - minX + 1, gh = maxY - minY + 1;
      const hist = new Array(256).fill(0);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) hist[grid.data[y * N + x]]++;
      const t = otsu(hist, gw * gh);
      const data = new Uint8Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        if (grid.data[(y + minY) * N + x + minX] <= t) data[y * gw + x] = 1;
      }
      // Ink measured on the darkest third of the stroke, where colour survives photo compression:
      // how dark it is, and its blue-vs-red tint.
      const px = [];
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        if (data[y * gw + x]) { const q = (y + minY) * N + x + minX; px.push([grid.data[q], chroma ? chroma.data[q] - 128 : 0]); }
      }
      px.sort((a, b) => a[0] - b[0]);
      const core = px.slice(0, Math.max(1, Math.ceil(px.length / 3)));
      const dark = core.reduce((s, p) => s + p[0], 0) / core.length;
      const tint = core.reduce((s, p) => s + p[1], 0) / core.length;
      return { w: gw, h: gh, data, ink: { dark, tint } };
    };
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
        // A digit can break into several pieces (the two loops of an 8, the bar of a 5):
        // grow the box with every piece that lines up with it and isn't a grid line.
        const box = { minX: best.minX, maxX: best.maxX, minY: best.minY, maxY: best.maxY };
        for (let grew = true; grew;) {
          grew = false;
          for (const k of comps) {
            if (k === best) continue;
            const bw = k.maxX - k.minX + 1, bh = k.maxY - k.minY + 1;
            if (bw > size * 0.9 || bh > size * 0.98) continue;
            // thin and long = a piece of grid line, not part of the digit
            if (Math.min(bw, bh) < cs * 0.08 && Math.max(bw, bh) > cs * 0.25) continue;
            if (k.minX >= box.minX && k.maxX <= box.maxX && k.minY >= box.minY && k.maxY <= box.maxY) continue;
            const xOverlap = Math.min(k.maxX, box.maxX) - Math.max(k.minX, box.minX);
            const yGap = Math.max(k.minY - box.maxY, box.minY - k.maxY);
            if (xOverlap < -cs * 0.05 || yGap > cs * 0.12) continue;
            const nb = { minX: Math.min(box.minX, k.minX), maxX: Math.max(box.maxX, k.maxX), minY: Math.min(box.minY, k.minY), maxY: Math.max(box.maxY, k.maxY) };
            if (nb.maxX - nb.minX + 1 > size * 0.9 || nb.maxY - nb.minY + 1 > size * 0.98) continue;
            Object.assign(box, nb); grew = true;
          }
        }
        const core = { minX: best.minX, maxX: best.maxX, minY: best.minY, maxY: best.maxY };
        const glyph = glyphFrom(box, x0, y0, size);
        cells.push({ glyph, core: glyphFrom(core, x0, y0, size), aspect: glyph.w / glyph.h, ink: glyph.ink });
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

  // ---------- digit recognition ----------
  function grayToCanvas(img) {
    const rgba = new Uint8ClampedArray(img.w * img.h * 4);
    for (let i = 0; i < img.data.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = img.data[i]; rgba[i * 4 + 3] = 255; }
    const cv = document.createElement('canvas');
    cv.width = img.w; cv.height = img.h;
    cv.getContext('2d').putImageData(new ImageData(rgba, img.w, img.h), 0, 0);
    return cv;
  }

  // Feature vector of a 0/1 glyph mask: scaled to a fixed height keeping its proportions
  // (so a thin 1 stays thin), centred, area-averaged, lightly blurred, mean-centred and normalised.
  const FS = 24;
  function cropToInk(g) {
    let minX = g.w, minY = g.h, maxX = -1, maxY = -1;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.data[y * g.w + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return g;
    const w = maxX - minX + 1, h = maxY - minY + 1, data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = g.data[(y + minY) * g.w + x + minX];
    return { w, h, data };
  }
  function features(g) {
    g = cropToInk(g);
    const v = new Float32Array(FS * FS);
    const scale = FS / g.h, gw = Math.max(1, Math.min(FS, Math.round(g.w * scale)));
    const off = Math.floor((FS - gw) / 2);
    for (let y = 0; y < FS; y++) for (let x = 0; x < gw; x++) {
      const x0 = Math.floor(x * g.w / gw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * g.w / gw));
      const y0 = Math.floor(y * g.h / FS), y1 = Math.max(y0 + 1, Math.floor((y + 1) * g.h / FS));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += g.data[yy * g.w + xx]; n++; }
      v[y * FS + x + off] = s / n;
    }
    const b = new Float32Array(FS * FS);
    for (let y = 0; y < FS; y++) for (let x = 0; x < FS; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= FS || xx >= FS) continue;
        const wgt = dx || dy ? 1 : 2; s += v[yy * FS + xx] * wgt; n += wgt;
      }
      b[y * FS + x] = s / n;
    }
    let mean = 0; for (const t of b) mean += t; mean /= b.length;
    let norm = 0; for (let i = 0; i < b.length; i++) { b[i] -= mean; norm += b[i] * b[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < b.length; i++) b[i] /= norm;
    return { v: b, aspect: g.w / g.h };
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  // shape similarity, minus a penalty when the width/height ratio differs a lot
  const sim = (f, t) => dot(f.v, t.v) - 0.6 * Math.abs(Math.log(f.aspect / t.aspect));

  // Reference digits drawn in common fonts (browser only; built once).
  const FONTS = ['Arial', 'Helvetica', 'Roboto', 'sans-serif', '"Times New Roman"', 'Georgia', 'serif',
    'Verdana', '"Courier New"', 'monospace', '"Segoe UI"', 'Tahoma', 'Calibri', '"Trebuchet MS"', 'Consolas', 'Cambria'];
  const WEIGHTS = [300, 400, 700];
  // Each font is also drawn heavier and narrower, so condensed/black typefaces that aren't
  // installed on the device still have something close to match against.
  const VARIANTS = [{}, { stroke: 0.07 }, { sx: 0.72, stroke: 0.05 }];
  let templates = null;
  function buildTemplates(fonts) {
    const out = [], seen = new Set(), S = 72, C = S * 2;
    const cv = document.createElement('canvas'); cv.width = C; cv.height = C;
    const x = cv.getContext('2d', { willReadFrequently: true });
    for (const f of fonts || FONTS) for (const wt of WEIGHTS) for (const vr of VARIANTS) for (let d = 1; d <= 9; d++) {
      x.fillStyle = '#fff'; x.fillRect(0, 0, C, C);
      x.save();
      if (vr.sx) { x.translate(S, 0); x.scale(vr.sx, 1); x.translate(-S, 0); }
      x.fillStyle = '#000'; x.font = `${wt} ${S}px ${f}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(d), S, S);
      if (vr.stroke) { x.strokeStyle = '#000'; x.lineJoin = 'round'; x.lineWidth = S * vr.stroke; x.strokeText(String(d), S, S); }
      x.restore();
      const px = x.getImageData(0, 0, C, C).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < C; y++) for (let xx = 0; xx < C; xx++) {
        if (px[(y * C + xx) * 4] < 128) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      if (maxX < 0) continue;
      const w = maxX - minX + 1, h = maxY - minY + 1, data = new Uint8Array(w * h);
      let hash = 7;
      for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
        const on = px[((y + minY) * C + xx + minX) * 4] < 128 ? 1 : 0;
        data[y * w + xx] = on;
        if (on) hash = (hash * 31 + y * w + xx) % 1000000007;
      }
      const key = `${d}:${w}x${h}:${hash}`;
      if (seen.has(key)) continue; // this font fell back to one already drawn
      seen.add(key);
      out.push({ d, ...features({ w, h, data }) });
    }
    return out;
  }

  // Scores for digits 1..9 per glyph (index 0 unused); null for empty cells.
  // A blob that looks like no digit at all (a speck, a smudge) is treated as an empty cell.
  const MIN_MATCH = 0.45;
  function scoreCells(feats, tpls) {
    return feats.map(f => {
      if (!f) return null;
      const sc = new Array(10).fill(-9);
      for (const t of tpls) { const s = sim(f, t); if (s > sc[t.d]) sc[t.d] = s; }
      return Math.max(...sc) < MIN_MATCH ? null : sc;
    });
  }
  const ranked = sc => [1, 2, 3, 4, 5, 6, 7, 8, 9].sort((a, b) => sc[b] - sc[a]);

  // A puzzle is printed in one font: confident reads become extra templates for the rest.
  let OWN_WEIGHT = 0.6;
  function refineWithPhotoFont(feats, scores) {
    for (let round = 0; round < 2; round++) {
      const protos = [];
      feats.forEach((f, i) => {
        if (!f) return;
        const r = ranked(scores[i]);
        if (scores[i][r[0]] - scores[i][r[1]] > 0.08) protos.push({ d: r[0], i, ...f });
      });
      scores = feats.map((f, i) => {
        if (!f) return null;
        const own = new Array(10).fill(-9);
        for (const p of protos) if (p.i !== i) { const s = sim(f, p); if (s > own[p.d]) own[p.d] = s; }
        const k = OWN_WEIGHT;
        return scores[i].map((s, d) => (d === 0 ? s : own[d] > -9 ? (1 - k) * s + k * own[d] : s));
      });
    }
    return scores;
  }

  // Turn scores into digits. A real puzzle has exactly one solution; if the reading doesn't,
  // try the next-best digit in the least certain cells (one, two, then three changes; cheapest
  // wins). Falls back to "at least solvable" when no small change gives a unique solution.
  function resolveWithRules(scores) {
    const cells = [];
    const digits = new Array(81).fill(0);
    scores.forEach((sc, i) => {
      if (!sc) return;
      const r = ranked(sc);
      digits[i] = r[0];
      cells.push({ i, r, margin: sc[r[0]] - sc[r[1]] });
    });
    const solutions = g => E.solve(g, 2).count;
    const changed = new Set();
    const start = E && digits.filter(Boolean).length >= 17 ? solutions(digits) : 1;
    if (start !== 1) {
      const doubtful = cells.slice().sort((a, b) => a.margin - b.margin).slice(0, 12);
      const options = [];
      for (const c of doubtful) for (const alt of c.r.slice(1, 3)) options.push({ i: c.i, d: alt, cost: scores[c.i][c.r[0]] - scores[c.i][alt] });
      let unique = null, solvable = null;
      const tryCombo = combo => {
        const cost = combo.reduce((s, o) => s + o.cost, 0);
        if (unique && cost >= unique.cost) return;
        const g = digits.slice();
        for (const o of combo) g[o.i] = o.d;
        const n = solutions(g);
        if (n === 1) unique = { cost, combo };
        else if (n > 1 && start === 0 && (!solvable || cost < solvable.cost)) solvable = { cost, combo };
      };
      for (let a = 0; a < options.length; a++) {
        tryCombo([options[a]]);
        for (let b = a + 1; b < options.length; b++) {
          if (options[b].i === options[a].i) continue;
          tryCombo([options[a], options[b]]);
          for (let c = b + 1; c < options.length; c++) {
            if (options[c].i === options[a].i || options[c].i === options[b].i) continue;
            tryCombo([options[a], options[b], options[c]]);
          }
        }
      }
      const best = unique || solvable;
      if (best) for (const o of best.combo) { digits[o.i] = o.d; changed.add(o.i); }
    }
    // A uniquely solvable reading is strong evidence; then only near-ties are worth a second look.
    const unsure = new Set(changed);
    const cut = start === 1 ? 0.015 : 0.04;
    for (const c of cells) if (c.margin < cut) unsure.add(c.i);
    return { digits, unsure };
  }

  // Reads all digits from a straightened grid. opts.fonts overrides the reference fonts (for testing).
  // Rotates a square grayscale image by k quarter turns clockwise.
  function rotate(img, k) {
    k = ((k % 4) + 4) % 4;
    if (!k) return img;
    const N = img.w, data = new Uint8ClampedArray(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = img.data[y * N + x];
      if (k === 1) data[x * N + (N - 1 - y)] = v;
      else if (k === 2) data[(N - 1 - y) * N + (N - 1 - x)] = v;
      else data[(N - 1 - x) * N + y] = v;
    }
    return { w: N, h: N, data };
  }

  // Scores every cell of a straightened grid: the digit with and without its merged pieces,
  // keeping whichever looks more like a digit.
  function scoreGrid(grid, chroma) {
    const cells = extractCells(grid, chroma);
    const best = sc => (sc ? Math.max(...sc) : -9);
    const featsA = cells.map(c => (c ? features(c.glyph) : null));
    const featsB = cells.map(c => (c ? features(c.core) : null));
    const scA = scoreCells(featsA, templates), scB = scoreCells(featsB, templates);
    const feats = featsA.map((f, i) => (best(scB[i]) > best(scA[i]) ? featsB[i] : f));
    const scores = scA.map((sc, i) => (best(scB[i]) > best(sc) ? scB[i] : sc));
    scores.forEach((sc, i) => { if (!sc) feats[i] = null; }); // specks count as empty
    const found = scores.filter(Boolean).map(best);
    const quality = found.length ? found.reduce((a, b) => a + b, 0) / found.length : -9;
    return { feats, scores, quality, count: found.length, ink: cells.map(c => (c ? c.ink : 0)) };
  }

  // Reads all digits from a straightened grid. The photo may be sideways or upside down, so all
  // four turns are tried and the one whose digits match best wins. Returns the turn used
  // (quarter turns clockwise) so the caller can show the photo the same way.
  // opts.fonts overrides the reference fonts (for testing).
  async function readDigits(grid, onProgress, opts) {
    opts = opts || {};
    if (opts.fonts) templates = buildTemplates(opts.fonts);
    else if (!templates) templates = buildTemplates();
    let pick = null;
    for (let k = 0; k < 4; k++) {
      const r = scoreGrid(rotate(grid, k), opts.chroma && rotate(opts.chroma, k));
      if (!pick || r.quality > pick.quality) pick = { ...r, rotation: k };
    }
    onProgress && onProgress(1, 1);
    if (!pick.count) return { digits: new Array(81).fill(0), unsure: new Set(), rotation: 0, handwritten: 0 };
    // Printed givens are black; digits added by hand are often in coloured pen. If the digits'
    // ink clearly splits into near-black and coloured, keep only the black ones.
    const handwritten = opts.chroma ? colouredInk(pick.ink, pick.scores) : new Set();
    for (const i of handwritten) { pick.scores[i] = null; pick.feats[i] = null; }
    const res = resolveWithRules(refineWithPhotoFont(pick.feats, pick.scores));
    res.rotation = pick.rotation;
    res.handwritten = handwritten.size;
    return res;
  }

  // Digits written in pen next to the printed ones. Split the digits at the biggest jump in
  // ink tint; if there is a clear jump, the group with the darker strokes is the print and the
  // other group is handwriting. No clear jump (all one ink) -> keep everything.
  function colouredInk(ink, scores) {
    const idx = scores.map((s, i) => (s ? i : -1)).filter(i => i >= 0).sort((a, b) => ink[a].tint - ink[b].tint);
    if (idx.length < 10) return new Set();
    let gap = 0, at = -1;
    for (let k = 1; k < idx.length; k++) {
      const d = ink[idx[k]].tint - ink[idx[k - 1]].tint;
      if (d > gap) { gap = d; at = k; }
    }
    const lo = idx.slice(0, at), hi = idx.slice(at);
    const mean = (a, f) => a.reduce((s, i) => s + ink[i][f], 0) / a.length;
    if (gap < 8 || mean(hi, 'tint') - mean(lo, 'tint') < 15) return new Set();
    const [print, pen] = mean(lo, 'dark') <= mean(hi, 'dark') ? [lo, hi] : [hi, lo];
    if (print.length < 10) return new Set(); // a real puzzle has at least 17 givens
    return new Set(pen);
  }

  return {
    grayFromRGBA, chromaFromRGBA, resize, adaptiveThreshold, detectGrid, warp, extractCells,
    readDigits, rotate, grayToCanvas, features, buildTemplates, setOwnWeight: w => { OWN_WEIGHT = w; },
  };
});
