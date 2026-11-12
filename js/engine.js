// Sudoku logic engine: generation, candidate tracking, basic solving and
// pattern finders for X-Wing, Swordfish, Y-Wing and XYZ-Wing.
// Works in the browser (window.SudokuEngine) and in Node (module.exports).
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.SudokuEngine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALL = 0x3fe; // bits 1..9
  const ROW_OF = [], COL_OF = [], BOX_OF = [];
  for (let i = 0; i < 81; i++) {
    ROW_OF.push((i / 9) | 0);
    COL_OF.push(i % 9);
    BOX_OF.push(((i / 27) | 0) * 3 + (((i % 9) / 3) | 0));
  }
  const ROWS = [], COLS = [], BOXES = [];
  for (let k = 0; k < 9; k++) { ROWS.push([]); COLS.push([]); BOXES.push([]); }
  for (let i = 0; i < 81; i++) {
    ROWS[ROW_OF[i]].push(i);
    COLS[COL_OF[i]].push(i);
    BOXES[BOX_OF[i]].push(i);
  }
  const UNITS = [...ROWS, ...COLS, ...BOXES];
  const sees = (a, b) => a !== b &&
    (ROW_OF[a] === ROW_OF[b] || COL_OF[a] === COL_OF[b] || BOX_OF[a] === BOX_OF[b]);
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const p = [];
    for (let j = 0; j < 81; j++) if (sees(i, j)) p.push(j);
    PEERS.push(p);
  }

  function popcount(m) { let c = 0; while (m) { m &= m - 1; c++; } return c; }
  function digitsOf(m) { const out = []; for (let d = 1; d <= 9; d++) if (m & (1 << d)) out.push(d); return out; }
  function bitsOf(m) { const out = []; for (let k = 0; k < 9; k++) if (m & (1 << k)) out.push(k); return out; }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function combos(arr, k) {
    const out = [];
    const pick = (start, acc) => {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let i = start; i < arr.length; i++) { acc.push(arr[i]); pick(i + 1, acc); acc.pop(); }
    };
    pick(0, []);
    return out;
  }
  const cellName = i => `r${ROW_OF[i] + 1}c${COL_OF[i] + 1}`;

  // ---------- brute-force solver (for uniqueness + generation) ----------
  function solve(grid, limit, randomize) {
    const g = grid.slice();
    const rm = new Int32Array(9), cm = new Int32Array(9), bm = new Int32Array(9);
    for (let i = 0; i < 81; i++) {
      const v = g[i];
      if (!v) continue;
      const b = 1 << v;
      if ((rm[ROW_OF[i]] | cm[COL_OF[i]] | bm[BOX_OF[i]]) & b) return { count: 0, solution: null };
      rm[ROW_OF[i]] |= b; cm[COL_OF[i]] |= b; bm[BOX_OF[i]] |= b;
    }
    const empties = [];
    for (let i = 0; i < 81; i++) if (!g[i]) empties.push(i);
    let count = 0, first = null;
    (function rec() {
      let best = -1, bestMask = 0, bestCount = 10;
      for (const i of empties) {
        if (g[i]) continue;
        const m = ALL & ~(rm[ROW_OF[i]] | cm[COL_OF[i]] | bm[BOX_OF[i]]);
        const c = popcount(m);
        if (c < bestCount) { bestCount = c; best = i; bestMask = m; if (c <= 1) break; }
      }
      if (best < 0) { count++; if (!first) first = g.slice(); return; }
      if (bestCount === 0) return;
      const ds = digitsOf(bestMask);
      if (randomize) shuffle(ds);
      const r = ROW_OF[best], c = COL_OF[best], x = BOX_OF[best];
      for (const d of ds) {
        const b = 1 << d;
        g[best] = d; rm[r] |= b; cm[c] |= b; bm[x] |= b;
        rec();
        g[best] = 0; rm[r] &= ~b; cm[c] &= ~b; bm[x] &= ~b;
        if (count >= limit) return;
      }
    })();
    return { count, solution: first };
  }

  function generatePuzzle() {
    const full = solve(new Array(81).fill(0), 1, true).solution;
    const g = full.slice();
    for (const i of shuffle([...Array(81).keys()])) {
      const v = g[i];
      g[i] = 0;
      if (solve(g, 2, false).count !== 1) g[i] = v;
    }
    return { puzzle: g, solution: full };
  }

  // ---------- candidate state ----------
  function makeState(grid) {
    const values = grid.slice();
    const given = grid.map(v => v > 0);
    const cands = new Array(81).fill(0);
    for (let i = 0; i < 81; i++) {
      if (values[i]) continue;
      let m = ALL;
      for (const p of PEERS[i]) if (values[p]) m &= ~(1 << values[p]);
      cands[i] = m;
    }
    return { values, given, cands };
  }
  function cloneState(s) {
    return { values: s.values.slice(), given: s.given.slice(), cands: s.cands.slice() };
  }
  function place(s, i, d) {
    s.values[i] = d;
    s.cands[i] = 0;
    const b = ~(1 << d);
    for (const p of PEERS[i]) s.cands[p] &= b;
  }
  const isSolved = s => s.values.every(v => v > 0);

  // ---------- basic techniques (applied before the advanced ones) ----------
  function nakedSingle(s) {
    let changed = false;
    for (let i = 0; i < 81; i++) {
      if (!s.values[i] && popcount(s.cands[i]) === 1) { place(s, i, digitsOf(s.cands[i])[0]); changed = true; }
    }
    return changed;
  }
  function hiddenSingle(s) {
    for (const u of UNITS) {
      for (let d = 1; d <= 9; d++) {
        const b = 1 << d;
        let n = 0, pos = -1;
        for (const i of u) if (s.cands[i] & b) { n++; pos = i; }
        if (n === 1) { place(s, pos, d); return true; }
      }
    }
    return false;
  }
  function lockedCandidates(s) {
    let changed = false;
    const strip = (cells, b) => { for (const i of cells) if (s.cands[i] & b) { s.cands[i] &= ~b; changed = true; } };
    for (let d = 1; d <= 9; d++) {
      const b = 1 << d;
      // pointing: candidates in a box confined to one row / column
      for (let x = 0; x < 9; x++) {
        const cells = BOXES[x].filter(i => s.cands[i] & b);
        if (cells.length < 2) continue;
        if (cells.every(i => ROW_OF[i] === ROW_OF[cells[0]])) strip(ROWS[ROW_OF[cells[0]]].filter(i => BOX_OF[i] !== x), b);
        if (cells.every(i => COL_OF[i] === COL_OF[cells[0]])) strip(COLS[COL_OF[cells[0]]].filter(i => BOX_OF[i] !== x), b);
      }
      // claiming: candidates in a row / column confined to one box
      for (const line of [...ROWS, ...COLS]) {
        const cells = line.filter(i => s.cands[i] & b);
        if (cells.length < 2) continue;
        if (cells.every(i => BOX_OF[i] === BOX_OF[cells[0]])) strip(BOXES[BOX_OF[cells[0]]].filter(i => !line.includes(i)), b);
      }
    }
    return changed;
  }
  function nakedSubset(s, k) {
    let changed = false;
    for (const u of UNITS) {
      const open = u.filter(i => !s.values[i]);
      if (open.length <= k) continue;
      for (const combo of combos(open, k)) {
        let union = 0;
        for (const i of combo) union |= s.cands[i];
        if (popcount(union) !== k) continue;
        for (const i of open) {
          if (!combo.includes(i) && (s.cands[i] & union)) { s.cands[i] &= ~union; changed = true; }
        }
      }
    }
    return changed;
  }
  function hiddenSubset(s, k) {
    let changed = false;
    for (const u of UNITS) {
      const missing = [];
      for (let d = 1; d <= 9; d++) if (!u.some(i => s.values[i] === d)) missing.push(d);
      if (missing.length <= k) continue;
      for (const combo of combos(missing, k)) {
        let mask = 0;
        for (const d of combo) mask |= 1 << d;
        const cells = u.filter(i => s.cands[i] & mask);
        if (cells.length !== k) continue;
        for (const i of cells) {
          if (s.cands[i] & ~mask) { s.cands[i] &= mask; changed = true; }
        }
      }
    }
    return changed;
  }
  function applyBasics(s) {
    const steps = [nakedSingle, hiddenSingle, lockedCandidates,
      x => nakedSubset(x, 2), x => hiddenSubset(x, 2),
      x => nakedSubset(x, 3), x => hiddenSubset(x, 3)];
    outer: for (;;) {
      for (const step of steps) if (step(s)) continue outer;
      return s;
    }
  }

  // ---------- advanced pattern finders ----------
  // Fish (X-Wing size 2, Swordfish size 3)
  function findFish(s, size) {
    const res = [];
    for (let d = 1; d <= 9; d++) {
      const b = 1 << d;
      for (const orient of ['row', 'col']) {
        const lines = orient === 'row' ? ROWS : COLS;
        const crossLines = orient === 'row' ? COLS : ROWS;
        const cross = orient === 'row' ? COL_OF : ROW_OF;
        const own = orient === 'row' ? ROW_OF : COL_OF;
        const candLines = [];
        for (let li = 0; li < 9; li++) {
          const cells = lines[li].filter(i => s.cands[i] & b);
          if (cells.length >= 2 && cells.length <= size) {
            let mask = 0;
            for (const i of cells) mask |= 1 << cross[i];
            candLines.push({ li, mask, cells });
          }
        }
        for (const combo of combos(candLines, size)) {
          let mask = 0;
          for (const c of combo) mask |= c.mask;
          if (popcount(mask) !== size) continue;
          const base = combo.map(c => c.li);
          const cover = bitsOf(mask);
          const elims = [];
          for (const ci of cover) {
            for (const i of crossLines[ci]) {
              if ((s.cands[i] & b) && !base.includes(own[i])) elims.push({ cell: i, digit: d });
            }
          }
          if (elims.length) {
            res.push({ type: size === 2 ? 'xwing' : 'swordfish', digit: d, orient, base, cover,
              cells: combo.flatMap(c => c.cells), elims });
          }
        }
      }
    }
    return res;
  }

  function findYWing(s) {
    const res = [];
    for (let P = 0; P < 81; P++) {
      const cp = s.cands[P];
      if (s.values[P] || popcount(cp) !== 2) continue;
      const wings = PEERS[P].filter(i => !s.values[i] && popcount(s.cands[i]) === 2 && popcount(s.cands[i] & cp) === 1);
      for (const [A, B] of combos(wings, 2)) {
        const ca = s.cands[A], cb = s.cands[B];
        if ((ca & cp) === (cb & cp)) continue;
        const za = ca & ~cp, zb = cb & ~cp;
        if (za !== zb) continue;
        const z = digitsOf(za)[0];
        const elims = [];
        for (let i = 0; i < 81; i++) {
          if (i !== A && i !== B && (s.cands[i] & za) && sees(i, A) && sees(i, B)) elims.push({ cell: i, digit: z });
        }
        if (elims.length) {
          res.push({ type: 'ywing', pivot: P, pincers: [A, B], z,
            pivotDigits: digitsOf(cp), cells: [P, A, B], elims });
        }
      }
    }
    return res;
  }

  function findXYZWing(s) {
    const res = [];
    for (let P = 0; P < 81; P++) {
      const cp = s.cands[P];
      if (s.values[P] || popcount(cp) !== 3) continue;
      const wings = PEERS[P].filter(i => !s.values[i] && popcount(s.cands[i]) === 2 && (s.cands[i] & ~cp) === 0);
      for (const [A, B] of combos(wings, 2)) {
        const ca = s.cands[A], cb = s.cands[B];
        if (ca === cb) continue;
        const common = ca & cb;
        const z = digitsOf(common)[0];
        const elims = [];
        for (let i = 0; i < 81; i++) {
          if (i !== A && i !== B && i !== P && (s.cands[i] & common) && sees(i, P) && sees(i, A) && sees(i, B)) {
            elims.push({ cell: i, digit: z });
          }
        }
        if (elims.length) {
          res.push({ type: 'xyzwing', pivot: P, pincers: [A, B], z,
            pivotDigits: digitsOf(cp), cells: [P, A, B], elims });
        }
      }
    }
    return res;
  }

  const FINDERS = {
    xwing: s => findFish(s, 2),
    swordfish: s => findFish(s, 3),
    ywing: findYWing,
    xyzwing: findXYZWing,
  };

  // ---------- validity-preserving shuffles ----------
  function randomTransform(grid) {
    const digitMap = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])];
    const perm = () => shuffle([0, 1, 2]).flatMap(band => shuffle([0, 1, 2]).map(k => band * 3 + k));
    const rp = perm(), cp = perm();
    const transpose = Math.random() < 0.5;
    const out = new Array(81);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const src = transpose ? cp[c] * 9 + rp[r] : rp[r] * 9 + cp[c];
        out[r * 9 + c] = digitMap[grid[src]];
      }
    }
    return out;
  }

  const parse = str => [...str].map(ch => (ch >= '1' && ch <= '9' ? +ch : 0));
  const stringify = g => g.map(v => v || '.').join('');

  return {
    ROW_OF, COL_OF, BOX_OF, ROWS, COLS, BOXES, PEERS, sees, popcount, digitsOf, cellName,
    solve, generatePuzzle, makeState, cloneState, applyBasics, isSolved,
    findFish, findYWing, findXYZWing, FINDERS, randomTransform, parse, stringify, shuffle,
  };
});
