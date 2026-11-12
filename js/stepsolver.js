// Human-style step solver: finds the single simplest next move on a board
// and explains it. Techniques are tried from easiest to hardest.
// Works in the browser (window.StepSolver) and in Node (module.exports).
(function (root, factory) {
  const E = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.SudokuEngine;
  const S = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = S;
  else root.StepSolver = S;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const { ROW_OF, COL_OF, BOX_OF, ROWS, COLS, BOXES, PEERS, popcount, digitsOf, cellName: name } = E;
  const UNITS = [...ROWS, ...COLS, ...BOXES];
  const ALL = 0x3fe;
  const unitName = u => u < 9 ? `row ${u + 1}` : u < 18 ? `column ${u - 8}` : `box ${u - 17}`;
  const unitKind = u => u < 9 ? 'row' : u < 18 ? 'column' : 'box';
  const b = x => `<b>${x}</b>`;
  const set = ds => `{${ds.join(',')}}`;
  const key = (i, d) => i + ':' + d;
  function list(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
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

  // Candidates allowed by the placed digits alone.
  function legalCands(values) {
    const out = new Array(81).fill(0);
    for (let i = 0; i < 81; i++) {
      if (values[i]) continue;
      let m = ALL;
      for (const p of PEERS[i]) if (values[p]) m &= ~(1 << values[p]);
      out[i] = m;
    }
    return out;
  }

  // Cells that break the rules (same digit twice in a unit).
  function conflicts(values) {
    const bad = new Set();
    for (let i = 0; i < 81; i++) {
      if (!values[i]) continue;
      for (const p of PEERS[i]) if (values[p] === values[i]) { bad.add(i); bad.add(p); }
    }
    return bad;
  }

  // ---------- deco helpers ----------
  const newDeco = () => ({ cell: {}, cand: {} });
  function addCell(deco, i, cls) { deco.cell[i] = (deco.cell[i] || '') + ' ' + cls; }
  function addCand(deco, i, d, cls) { deco.cand[key(i, d)] = cls; }
  function decoUnit(deco, u) { for (const i of UNITS[u]) addCell(deco, i, 'unit'); }

  // ---------- singles ----------
  function fullHouse(s) {
    for (const order of [BOXES, ROWS, COLS]) {
      for (const cells of order) {
        const empty = cells.filter(i => !s.values[i]);
        if (empty.length !== 1) continue;
        const i = empty[0];
        let used = 0;
        for (const c of cells) if (s.values[c]) used |= 1 << s.values[c];
        const d = digitsOf(ALL & ~used)[0];
        if (!d) continue;
        const u = UNITS.indexOf(cells);
        const deco = newDeco();
        decoUnit(deco, u);
        addCell(deco, i, 'solve');
        return {
          tech: 'Full house', level: 1, place: [{ cell: i, d }], elims: [], deco,
          hint: `One ${unitKind(u)} has only a single empty cell left.`,
          hintDeco: (() => { const h = newDeco(); decoUnit(h, u); return h; })(),
          text: `<p>${cap(unitName(u))} has only one empty cell: ${name(i)}.</p>
                 <p>The only digit the ${unitKind(u)} is still missing is ${b(d)}, so <b>${name(i)} = ${d}</b>.</p>`,
        };
      }
    }
    return null;
  }

  function hiddenSingle(s, legal, units, label) {
    for (const u of units) {
      const cells = UNITS[u];
      for (let d = 1; d <= 9; d++) {
        if (cells.some(i => s.values[i] === d)) continue;
        const bit = 1 << d;
        const spots = cells.filter(i => s.cands[i] & bit);
        if (spots.length !== 1) continue;
        const i = spots[0];
        const deco = newDeco();
        decoUnit(deco, u);
        addCell(deco, i, 'solve');
        addCand(deco, i, d, 'key');
        const legalSpots = cells.filter(c => legal[c] & bit);
        let why;
        if (legalSpots.length === 1) {
          // Explain with the placed digits that block the other cells.
          const blockers = new Set();
          for (const c of cells) {
            if (s.values[c] || c === i) continue;
            const p = PEERS[c].find(p => s.values[p] === d && !cells.includes(p));
            if (p != null) blockers.add(p);
          }
          for (const p of blockers) addCell(deco, p, 'source');
          for (const c of cells) if (!s.values[c] && c !== i) addCell(deco, c, 'blocked');
          why = `<p>Every other empty cell in ${unitName(u)} already sees a ${d} ` +
            `(the ${d}${blockers.size > 1 ? 's' : ''} at ${list([...blockers].map(name))}).</p>`;
        } else {
          for (const c of cells) if (!s.values[c] && c !== i) addCell(deco, c, 'blocked');
          why = `<p>Looking at the pencil marks, no other cell in ${unitName(u)} still has ${d} as a candidate.</p>`;
        }
        return {
          tech: label, level: u >= 18 ? 1 : 2, place: [{ cell: i, d }], elims: [], deco,
          hint: `Look at digit ${b(d)} in ${unitName(u)}. Where can it go?`,
          hintDeco: (() => { const h = newDeco(); decoUnit(h, u); return h; })(), focus: d,
          text: `<p>Where can ${b(d)} go in ${unitName(u)}?</p>${why}
                 <p>So the ${d} has only one place left: <b>${name(i)} = ${d}</b>.</p>`,
        };
      }
    }
    return null;
  }

  function nakedSingle(s, legal) {
    for (let i = 0; i < 81; i++) {
      if (s.values[i] || popcount(s.cands[i]) !== 1) continue;
      const d = digitsOf(s.cands[i])[0];
      const deco = newDeco();
      for (const p of PEERS[i]) if (s.values[p]) addCell(deco, p, 'source');
      addCell(deco, i, 'solve');
      addCand(deco, i, d, 'key');
      const fromValues = popcount(legal[i]) === 1;
      const seen = digitsOf(ALL & ~legal[i]);
      return {
        tech: 'Naked single', level: 3, place: [{ cell: i, d }], elims: [], deco,
        hint: `Some cell has only one possible digit left. Check ${name(i).slice(0, 2)}.`,
        hintDeco: (() => { const h = newDeco(); for (const c of ROWS[ROW_OF[i]]) addCell(h, c, 'unit'); return h; })(),
        text: fromValues
          ? `<p>Look at ${name(i)}. Its row, column and box together already contain ${list(seen)}.</p>
             <p>The only digit left is ${b(d)}, so <b>${name(i)} = ${d}</b>.</p>`
          : `<p>${name(i)} has only one candidate left in its pencil marks: ${b(d)}.</p>
             <p>So <b>${name(i)} = ${d}</b>.</p>`,
      };
    }
    return null;
  }

  // ---------- locked candidates ----------
  function lockedCandidates(s) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      // pointing: inside a box, the digit is confined to one row/column
      for (let x = 0; x < 9; x++) {
        const cells = BOXES[x].filter(i => s.cands[i] & bit);
        if (cells.length < 2) continue;
        for (const [same, lines, lineIdx, lw] of [[ROW_OF, ROWS, 0, 'row'], [COL_OF, COLS, 9, 'column']]) {
          if (!cells.every(i => same[i] === same[cells[0]])) continue;
          const li = same[cells[0]];
          const elims = lines[li].filter(i => BOX_OF[i] !== x && (s.cands[i] & bit)).map(cell => ({ cell, d }));
          if (!elims.length) continue;
          const deco = newDeco();
          decoUnit(deco, 18 + x);
          for (const i of lines[li]) if (BOX_OF[i] !== x) addCell(deco, i, 'line');
          for (const i of cells) addCand(deco, i, d, 'key');
          for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, d, 'elim'); }
          return {
            tech: 'Pointing (locked candidates)', level: 4, place: [], elims, deco, focus: d,
            hint: `Look at digit ${b(d)} in box ${x + 1}.`,
            hintDeco: (() => { const h = newDeco(); decoUnit(h, 18 + x); return h; })(),
            text: `<p>In box ${x + 1}, the ${b(d)} can only go in ${list(cells.map(name))}, and they are all in ${lw} ${li + 1}.</p>
                   <p>So box ${x + 1}'s ${d} will be somewhere in ${lw} ${li + 1}. That means no other cell of ${lw} ${li + 1} can be a ${d}.</p>
                   <p><b>Remove ${d} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
          };
        }
      }
      // claiming: inside a row/column, the digit is confined to one box
      for (let u = 0; u < 18; u++) {
        const line = UNITS[u];
        const cells = line.filter(i => s.cands[i] & bit);
        if (cells.length < 2 || !cells.every(i => BOX_OF[i] === BOX_OF[cells[0]])) continue;
        const x = BOX_OF[cells[0]];
        const elims = BOXES[x].filter(i => !line.includes(i) && (s.cands[i] & bit)).map(cell => ({ cell, d }));
        if (!elims.length) continue;
        const deco = newDeco();
        decoUnit(deco, u);
        for (const i of BOXES[x]) if (!line.includes(i)) addCell(deco, i, 'line');
        for (const i of cells) addCand(deco, i, d, 'key');
        for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, d, 'elim'); }
        return {
          tech: 'Claiming (locked candidates)', level: 4, place: [], elims, deco, focus: d,
          hint: `Look at digit ${b(d)} in ${unitName(u)}.`,
          hintDeco: (() => { const h = newDeco(); decoUnit(h, u); return h; })(),
          text: `<p>In ${unitName(u)}, the ${b(d)} can only go in ${list(cells.map(name))}, and they are all inside box ${x + 1}.</p>
                 <p>So ${unitName(u)}'s ${d} is inside box ${x + 1}, and box ${x + 1} can't have another ${d} anywhere else.</p>
                 <p><b>Remove ${d} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
        };
      }
    }
    return null;
  }

  // ---------- subsets ----------
  const SUBSET_NAME = { 2: 'pair', 3: 'triple', 4: 'quad' };
  const NUM_WORD = { 2: 'two', 3: 'three', 4: 'four' };

  function nakedSubset(s, k) {
    for (const u of [...Array(27).keys()].sort((a, c) => (a >= 18 ? -1 : 0) - (c >= 18 ? -1 : 0))) {
      const open = UNITS[u].filter(i => !s.values[i]);
      if (open.length <= k) continue;
      const small = open.filter(i => { const n = popcount(s.cands[i]); return n >= 2 && n <= k; });
      for (const combo of combos(small, k)) {
        let union = 0;
        for (const i of combo) union |= s.cands[i];
        if (popcount(union) !== k) continue;
        const ds = digitsOf(union);
        const elims = [];
        for (const i of open) {
          if (combo.includes(i)) continue;
          for (const d of ds) if (s.cands[i] & (1 << d)) elims.push({ cell: i, d });
        }
        if (!elims.length) continue;
        const deco = newDeco();
        decoUnit(deco, u);
        for (const i of combo) { addCell(deco, i, 'pattern'); for (const d of digitsOf(s.cands[i])) addCand(deco, i, d, 'key'); }
        for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, e.d, 'elim'); }
        const nm = SUBSET_NAME[k];
        return {
          tech: `Naked ${nm}`, level: k === 2 ? 5 : k === 3 ? 6 : 9, place: [], elims, deco,
          hint: `In ${unitName(u)}, look for ${NUM_WORD[k]} cells that only use the same ${NUM_WORD[k]} digits.`,
          hintDeco: (() => { const h = newDeco(); decoUnit(h, u); return h; })(),
          text: `<p>In ${unitName(u)}, these ${NUM_WORD[k]} cells only have candidates from ${set(ds)}:</p>
                 <p>${combo.map(i => `${name(i)} ${set(digitsOf(s.cands[i]))}`).join(', ')}.</p>
                 <p>${cap(NUM_WORD[k])} cells, ${NUM_WORD[k]} digits: these cells will use up ${list(ds)} between them. No other cell in ${unitName(u)} can have them.</p>
                 <p><b>Remove ${elimSummary(elims)}.</b></p>`,
        };
      }
    }
    return null;
  }

  function hiddenSubset(s, k) {
    for (const u of [...Array(27).keys()].sort((a, c) => (a >= 18 ? -1 : 0) - (c >= 18 ? -1 : 0))) {
      const cells = UNITS[u];
      const open = cells.filter(i => !s.values[i]);
      if (open.length <= k) continue;
      const digits = [];
      for (let d = 1; d <= 9; d++) {
        if (cells.some(i => s.values[i] === d)) continue;
        const n = open.filter(i => s.cands[i] & (1 << d)).length;
        if (n >= 2 && n <= k) digits.push(d);
      }
      for (const combo of combos(digits, k)) {
        let mask = 0;
        for (const d of combo) mask |= 1 << d;
        const spots = open.filter(i => s.cands[i] & mask);
        if (spots.length !== k) continue;
        const elims = [];
        for (const i of spots) for (const d of digitsOf(s.cands[i] & ~mask)) elims.push({ cell: i, d });
        if (!elims.length) continue;
        const deco = newDeco();
        decoUnit(deco, u);
        for (const i of spots) {
          addCell(deco, i, 'pattern');
          for (const d of combo) if (s.cands[i] & (1 << d)) addCand(deco, i, d, 'key');
        }
        for (const e of elims) addCand(deco, e.cell, e.d, 'elim');
        const nm = SUBSET_NAME[k];
        return {
          tech: `Hidden ${nm}`, level: k === 2 ? 5 : k === 3 ? 7 : 9, place: [], elims, deco,
          hint: `In ${unitName(u)}, look at where ${NUM_WORD[k]} of the missing digits can go.`,
          hintDeco: (() => { const h = newDeco(); decoUnit(h, u); return h; })(),
          text: `<p>In ${unitName(u)}, the digits ${list(combo.map(d => b(d)))} can only go in ${NUM_WORD[k]} cells: ${list(spots.map(name))}.</p>
                 <p>${cap(NUM_WORD[k])} digits need ${NUM_WORD[k]} cells, so these cells must hold exactly ${list(combo)}. They can't be anything else.</p>
                 <p><b>Remove the other candidates from them: ${elimSummary(elims)}.</b></p>`,
        };
      }
    }
    return null;
  }

  // ---------- advanced: reuse the engine's pattern finders ----------
  function fish(s, size) {
    const inst = E.findFish(s, size)[0];
    if (!inst) return null;
    const d = inst.digit, isRow = inst.orient === 'row';
    const lw = isRow ? 'row' : 'column', cw = isRow ? 'column' : 'row';
    const lines = isRow ? ROWS : COLS, cross = isRow ? COLS : ROWS, own = isRow ? ROW_OF : COL_OF;
    const deco = newDeco();
    for (const li of inst.base) for (const i of lines[li]) addCell(deco, i, 'unit');
    for (const ci of inst.cover) for (const i of cross[ci]) if (!inst.base.includes(own[i])) addCell(deco, i, 'line');
    for (const i of inst.cells) { addCell(deco, i, 'pattern'); addCand(deco, i, d, 'key'); }
    const elims = inst.elims.map(e => ({ cell: e.cell, d }));
    for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, d, 'elim'); }
    const base = inst.base.map(x => x + 1), cover = inst.cover.map(x => x + 1);
    const title = size === 2 ? 'X-Wing' : size === 3 ? 'Swordfish' : 'Jellyfish';
    return {
      tech: title, level: size === 2 ? 8 : size === 3 ? 10 : 11, place: [], elims, deco, focus: d,
      hint: `Look at digit ${b(d)} in the ${lw}s. Can you find a ${title}?`,
      hintDeco: newDeco(),
      text: `<p>Focus on digit ${b(d)}. In ${lw}s ${list(base)}, the ${d} can only go in ${cw}s ${list(cover)}.</p>
             <p>Each of those ${size} ${lw}s needs its own ${d}, in different ${cw}s, so together they fill ${cw}s ${list(cover)} with a ${d} each.${size < 4 ? ` (This is the <i>${title}</i> pattern. There's a lesson for it under Learn techniques.)` : ''}</p>
             <p>So the rest of ${cw}s ${list(cover)} can't have a ${d}. <b>Remove ${d} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
    };
  }

  function wing(s, xyz) {
    const inst = (xyz ? E.findXYZWing : E.findYWing)(s)[0];
    if (!inst) return null;
    const P = inst.pivot, [A, B] = inst.pincers, z = inst.z;
    const deco = newDeco();
    addCell(deco, P, 'pivot');
    for (const d of inst.pivotDigits) addCand(deco, P, d, xyz && d === z ? 'z' : 'key');
    for (const c of [A, B]) {
      addCell(deco, c, 'pincer');
      for (const d of digitsOf(s.cands[c])) addCand(deco, c, d, d === z ? 'z' : 'key');
    }
    const elims = inst.elims.map(e => ({ cell: e.cell, d: z }));
    for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, z, 'elim'); }
    const title = xyz ? 'XYZ-Wing' : 'Y-Wing';
    const pd = inst.pivotDigits;
    return {
      tech: title, level: xyz ? 10 : 8, place: [], elims, deco,
      hint: `Look at ${name(P)} ${set(pd)}. It can be the pivot of a ${title}.`,
      hintDeco: (() => { const h = newDeco(); addCell(h, P, 'pivot'); return h; })(),
      text: `<p>The pivot ${name(P)} ${set(pd)} sees two pincers: ${name(A)} ${set(digitsOf(s.cands[A]))} and ${name(B)} ${set(digitsOf(s.cands[B]))}.</p>
             <p>${xyz
               ? `Whatever the pivot turns out to be, one of these three cells will be ${b(z)}.`
               : `If the pivot is one digit, one pincer becomes ${b(z)}; if it's the other digit, the other pincer becomes ${b(z)}.`}
             (This is the <i>${title}</i> pattern. There's a lesson for it under Learn techniques.)</p>
             <p>So any cell that sees ${xyz ? 'all three' : 'both pincers'} can't be ${z}. <b>Remove ${z} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
    };
  }

  // ---------- single-digit chains ----------
  // Strong link: a unit where digit d has exactly two spots.
  function strongLinks(s, d) {
    const bit = 1 << d, out = [];
    for (let u = 0; u < 27; u++) {
      const spots = UNITS[u].filter(i => s.cands[i] & bit);
      if (spots.length === 2) out.push({ u, a: spots[0], b: spots[1] });
    }
    return out;
  }
  const seesBoth = (i, a, b) => i !== a && i !== b && E.sees(i, a) && E.sees(i, b);

  // Skyscraper / 2-String Kite / Turbot fish: two strong links joined by a weak link.
  function turbot(s, wanted) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      const links = strongLinks(s, d);
      for (let x = 0; x < links.length; x++) {
        for (let y = x + 1; y < links.length; y++) {
          const L1 = links[x], L2 = links[y];
          const k1 = unitKind(L1.u), k2 = unitKind(L2.u);
          let kind;
          if (k1 !== 'box' && k1 === k2) kind = 'Skyscraper';
          else if (k1 !== 'box' && k2 !== 'box') kind = '2-String Kite';
          else kind = 'Turbot fish';
          if (kind !== wanted) continue;
          for (const [a1, a2] of [[L1.a, L1.b], [L1.b, L1.a]]) {
            for (const [b1, b2] of [[L2.a, L2.b], [L2.b, L2.a]]) {
              if (new Set([a1, a2, b1, b2]).size !== 4) continue;
              if (!E.sees(a2, b2)) continue;
              // For a kite the joining cells must share a box (otherwise it's covered elsewhere).
              if (kind === '2-String Kite' && BOX_OF[a2] !== BOX_OF[b2]) continue;
              if (E.sees(a1, b1)) continue; // would be a plain locked set / contradiction case
              const elims = [];
              for (let i = 0; i < 81; i++) if ((s.cands[i] & bit) && seesBoth(i, a1, b1)) elims.push({ cell: i, d });
              if (!elims.length) continue;
              const deco = newDeco();
              decoUnit(deco, L1.u); decoUnit(deco, L2.u);
              for (const c of [a1, a2, b1, b2]) { addCell(deco, c, 'pattern'); addCand(deco, c, d, 'key'); }
              addCand(deco, a1, d, 'z'); addCand(deco, b1, d, 'z');
              for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, d, 'elim'); }
              return {
                tech: kind, level: 9, place: [], elims, deco, focus: d,
                hint: `Look at digit ${b(d)}: find two ${kind === 'Skyscraper' ? 'parallel lines' : 'units'} where it has exactly two spots each.`,
                hintDeco: newDeco(),
                text: `<p>Focus on digit ${b(d)}. In ${unitName(L1.u)} it can only be at ${name(a1)} or ${name(a2)}; in ${unitName(L2.u)} only at ${name(b1)} or ${name(b2)}.</p>
                       <p>${name(a2)} and ${name(b2)} see each other, so at most one of them is ${d}. If ${name(a2)} isn't ${d}, then ${name(a1)} is. If ${name(b2)} isn't ${d}, then ${name(b1)} is.
                       So <b>at least one of ${name(a1)} and ${name(b1)}</b> (orange) is a ${d}.</p>
                       <p>Any cell that sees both of them can't be ${d}. <b>Remove ${d} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
              };
            }
          }
        }
      }
    }
    return null;
  }

  // W-Wing: two identical bivalue cells {x,y} bridged by a strong link on x.
  function wWing(s) {
    const biv = [];
    for (let i = 0; i < 81; i++) if (!s.values[i] && popcount(s.cands[i]) === 2) biv.push(i);
    for (const [P, Q] of combos(biv, 2)) {
      if (s.cands[P] !== s.cands[Q] || E.sees(P, Q)) continue;
      const [p1, p2] = digitsOf(s.cands[P]);
      for (const [x, y] of [[p1, p2], [p2, p1]]) {
        const ybit = 1 << y;
        const elims = [];
        for (let i = 0; i < 81; i++) if ((s.cands[i] & ybit) && seesBoth(i, P, Q)) elims.push({ cell: i, d: y });
        if (!elims.length) continue;
        for (const L of strongLinks(s, x)) {
          for (const [a, c] of [[L.a, L.b], [L.b, L.a]]) {
            if ([a, c].includes(P) || [a, c].includes(Q)) continue;
            if (!E.sees(a, P) || !E.sees(c, Q)) continue;
            const deco = newDeco();
            decoUnit(deco, L.u);
            for (const t of [P, Q]) { addCell(deco, t, 'pincer'); addCand(deco, t, x, 'key'); addCand(deco, t, y, 'z'); }
            for (const t of [a, c]) { addCell(deco, t, 'pattern'); addCand(deco, t, x, 'key'); }
            for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, y, 'elim'); }
            return {
              tech: 'W-Wing', level: 10, place: [], elims, deco,
              hint: `Two cells, ${name(P)} and ${name(Q)}, have the same two candidates ${set([p1, p2])}.`,
              hintDeco: (() => { const h = newDeco(); addCell(h, P, 'pincer'); addCell(h, Q, 'pincer'); return h; })(),
              text: `<p>${name(P)} and ${name(Q)} both hold ${set([p1, p2])}. In ${unitName(L.u)} the ${b(x)} can only be at ${name(a)} or ${name(c)}.</p>
                     <p>If neither ${name(P)} nor ${name(Q)} were ${y}, both would be ${x}. Then ${name(a)} (sees ${name(P)}) and ${name(c)} (sees ${name(Q)}) couldn't be ${x}, and ${unitName(L.u)} would have no ${x} at all.</p>
                     <p>So <b>at least one of them is ${y}</b>, and any cell seeing both can't be ${y}. <b>Remove ${y} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
            };
          }
        }
      }
    }
    return null;
  }

  // Simple coloring: chains of strong links for one digit, two alternating colors.
  function simpleColoring(s) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      const links = strongLinks(s, d);
      const adj = new Map();
      for (const L of links) {
        if (!adj.has(L.a)) adj.set(L.a, new Set());
        if (!adj.has(L.b)) adj.set(L.b, new Set());
        adj.get(L.a).add(L.b); adj.get(L.b).add(L.a);
      }
      const color = new Map();
      for (const start of adj.keys()) {
        if (color.has(start)) continue;
        const comp = [start];
        color.set(start, 0);
        for (let k = 0; k < comp.length; k++) {
          for (const n of adj.get(comp[k])) if (!color.has(n)) { color.set(n, 1 - color.get(comp[k])); comp.push(n); }
        }
        if (comp.length < 4) continue;
        const A = comp.filter(i => color.get(i) === 0), B = comp.filter(i => color.get(i) === 1);
        const paint = deco => {
          for (const i of A) { addCell(deco, i, 'colorA'); addCand(deco, i, d, 'key'); }
          for (const i of B) { addCell(deco, i, 'colorB'); addCand(deco, i, d, 'z'); }
        };
        // Rule 1: two cells of one color see each other -> that color is false.
        for (const [grp, other, gname, oname] of [[A, B, 'green', 'orange'], [B, A, 'orange', 'green']]) {
          const clash = combos(grp, 2).find(([p, q]) => E.sees(p, q));
          if (!clash) continue;
          const elims = grp.map(cell => ({ cell, d }));
          const deco = newDeco(); paint(deco);
          for (const e of elims) addCand(deco, e.cell, d, 'elim');
          return {
            tech: 'Simple coloring', level: 11, place: [], elims, deco, focus: d,
            hint: `Follow digit ${b(d)} through the places where it has exactly two spots in a unit.`,
            hintDeco: newDeco(),
            text: `<p>Follow digit ${b(d)} along units where it has exactly two spots. Each link means "one of these two is ${d}", so we can paint the chain in two alternating colors: one color is all ${d}, the other has none.</p>
                   <p>Two ${gname} cells, ${name(clash[0])} and ${name(clash[1])}, see each other, so they can't both be ${d}. That means ${gname} is the false color and all ${oname} cells are ${d}.</p>
                   <p><b>Remove ${d} from every ${gname} cell: ${list(elims.map(e => name(e.cell)))}.</b></p>`,
          };
        }
        // Rule 2: an uncolored cell sees both colors.
        const elims = [];
        for (let i = 0; i < 81; i++) {
          if (!(s.cands[i] & bit) || color.has(i)) continue;
          if (A.some(a => E.sees(i, a)) && B.some(c => E.sees(i, c))) elims.push({ cell: i, d });
        }
        if (!elims.length) continue;
        const deco = newDeco(); paint(deco);
        for (const e of elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, d, 'elim'); }
        return {
          tech: 'Simple coloring', level: 11, place: [], elims, deco, focus: d,
          hint: `Follow digit ${b(d)} through the places where it has exactly two spots in a unit.`,
          hintDeco: newDeco(),
          text: `<p>Follow digit ${b(d)} along units where it has exactly two spots. Each link means "one of these two is ${d}", so the chain splits into two alternating colors (green and orange): one color is all ${d}s, the other has none.</p>
                 <p>We don't know which color is true, but a cell that sees a green <b>and</b> an orange cell sees a ${d} either way.</p>
                 <p><b>Remove ${d} from ${list(elims.map(e => name(e.cell)))}.</b></p>`,
        };
      }
    }
    return null;
  }

  // ---------- last resort: try a candidate, follow singles, find a contradiction ----------
  function propagate(values, cands) {
    const v = values.slice(), c = cands.slice(), trail = [];
    const put = (i, d, why) => {
      v[i] = d; c[i] = 0; trail.push({ cell: i, d, why });
      for (const p of PEERS[i]) {
        if (v[p] === d) return `${name(p)} and ${name(i)} would both be ${d}`;
        c[p] &= ~(1 << d);
      }
      return null;
    };
    for (let guard = 0; guard < 81; guard++) {
      for (let i = 0; i < 81; i++) if (!v[i] && !c[i]) return { trail, why: `${name(i)} would have no candidates left` };
      for (let u = 0; u < 27; u++) {
        for (let d = 1; d <= 9; d++) {
          if (UNITS[u].some(i => v[i] === d)) continue;
          if (!UNITS[u].some(i => c[i] & (1 << d))) return { trail, why: `${unitName(u)} would have no place for a ${d}` };
        }
      }
      let moved = false;
      for (let i = 0; i < 81 && !moved; i++) {
        if (!v[i] && popcount(c[i]) === 1) {
          const err = put(i, digitsOf(c[i])[0], 'only candidate');
          if (err) return { trail, why: err };
          moved = true;
        }
      }
      for (let u = 0; u < 27 && !moved; u++) {
        for (let d = 1; d <= 9 && !moved; d++) {
          const spots = UNITS[u].filter(i => c[i] & (1 << d));
          if (spots.length === 1 && !UNITS[u].some(i => v[i] === d)) {
            const err = put(spots[0], d, `only place in ${unitName(u)}`);
            if (err) return { trail, why: err };
            moved = true;
          }
        }
      }
      if (!moved) return null;
    }
    return null;
  }

  // Deeper propagation: also uses locked candidates and pairs/triples (engine basics).
  function propagateDeep(values, cands) {
    const st = { values: values.slice(), given: values.map(v => v > 0), cands: cands.slice() };
    E.applyBasics(st);
    for (let i = 0; i < 81; i++) {
      if (!st.values[i] && !st.cands[i]) return { trail: [], why: `${name(i)} would have no candidates left`, deep: true };
      if (st.values[i] && PEERS[i].some(p => st.values[p] === st.values[i])) return { trail: [], why: `${name(i)} would clash with another ${st.values[i]}`, deep: true };
    }
    for (let u = 0; u < 27; u++) {
      for (let d = 1; d <= 9; d++) {
        if (UNITS[u].some(i => st.values[i] === d)) continue;
        if (!UNITS[u].some(i => st.cands[i] & (1 << d))) return { trail: [], why: `${unitName(u)} would have no place for a ${d}`, deep: true };
      }
    }
    return null;
  }

  function contradiction(s, deep) {
    let best = null;
    const order = [...Array(81).keys()].filter(i => !s.values[i]).sort((a, c) => popcount(s.cands[a]) - popcount(s.cands[c]));
    for (const i of order) {
      for (const d of digitsOf(s.cands[i])) {
        const v = s.values.slice(), c = s.cands.slice();
        v[i] = d; c[i] = 0;
        for (const p of PEERS[i]) c[p] &= ~(1 << d);
        const r = deep ? propagateDeep(v, c) : propagate(v, c);
        if (r && (!best || r.trail.length < best.trail.length)) best = { cell: i, d, ...r };
        if (deep && best) break;
      }
      if (best && (deep || best.trail.length <= 3)) break;
    }
    if (!best) return null;
    const { cell, d, trail } = best;
    let why = best.why;
    if (deep) why = `following all the simple techniques from there (singles, locked candidates, pairs and triples), ${why}`;
    const deco = newDeco();
    addCell(deco, cell, 'pivot');
    addCand(deco, cell, d, 'elim');
    for (const t of trail) addCell(deco, t.cell, 'pattern');
    const shown = trail.slice(0, 12);
    const chain = shown.length
      ? `<p>Then, one forced move after another:</p><ol class="chain">${shown.map(t => `<li>${name(t.cell)} = ${t.d} (${t.why})</li>`).join('')}</ol>` +
        (trail.length > shown.length ? `<p>…and ${trail.length - shown.length} more forced moves.</p>` : '')
      : '';
    return {
      tech: 'Contradiction (what-if)', level: 12, place: [], elims: [{ cell, d }], deco,
      hint: `No pattern works here. Try asking "what if ${name(cell)} were ${d}?"`,
      hintDeco: (() => { const h = newDeco(); addCell(h, cell, 'pivot'); return h; })(),
      text: `<p>None of the simpler patterns apply, so we test a candidate: <b>what if ${name(cell)} were ${d}?</b></p>${chain}
             <p>That leads to a dead end: ${why}.</p>
             <p>So ${name(cell)} can't be ${d}. <b>Remove ${d} from ${name(cell)}.</b></p>`,
    };
  }

  function elimSummary(elims) {
    const byCell = new Map();
    for (const e of elims) { if (!byCell.has(e.cell)) byCell.set(e.cell, []); byCell.get(e.cell).push(e.d); }
    return list([...byCell].map(([c, ds]) => `${ds.join(',')} from ${name(c)}`));
  }
  function cap(t) { return t[0].toUpperCase() + t.slice(1); }

  // Technique list, simplest first.
  const TECHNIQUES = [
    { id: 'full', name: 'Full house', run: s => fullHouse(s) },
    { id: 'hbox', name: 'Hidden single (box)', run: (s, l) => hiddenSingle(s, l, [18, 19, 20, 21, 22, 23, 24, 25, 26], 'Hidden single') },
    { id: 'hline', name: 'Hidden single (row/column)', run: (s, l) => hiddenSingle(s, l, [...Array(18).keys()], 'Hidden single') },
    { id: 'naked1', name: 'Naked single', run: (s, l) => nakedSingle(s, l) },
    { id: 'locked', name: 'Locked candidates', run: s => lockedCandidates(s), notes: true },
    { id: 'npair', name: 'Naked pair', run: s => nakedSubset(s, 2), notes: true },
    { id: 'hpair', name: 'Hidden pair', run: s => hiddenSubset(s, 2), notes: true },
    { id: 'ntriple', name: 'Naked triple', run: s => nakedSubset(s, 3), notes: true },
    { id: 'htriple', name: 'Hidden triple', run: s => hiddenSubset(s, 3), notes: true },
    { id: 'xwing', name: 'X-Wing', run: s => fish(s, 2), notes: true },
    { id: 'skyscraper', name: 'Skyscraper', run: s => turbot(s, 'Skyscraper'), notes: true },
    { id: 'kite', name: '2-String Kite', run: s => turbot(s, '2-String Kite'), notes: true },
    { id: 'ywing', name: 'Y-Wing', run: s => wing(s, false), notes: true },
    { id: 'nquad', name: 'Naked quad', run: s => nakedSubset(s, 4), notes: true },
    { id: 'hquad', name: 'Hidden quad', run: s => hiddenSubset(s, 4), notes: true },
    { id: 'swordfish', name: 'Swordfish', run: s => fish(s, 3), notes: true },
    { id: 'xyzwing', name: 'XYZ-Wing', run: s => wing(s, true), notes: true },
    { id: 'turbot', name: 'Turbot fish', run: s => turbot(s, 'Turbot fish'), notes: true },
    { id: 'wwing', name: 'W-Wing', run: s => wWing(s), notes: true },
    { id: 'coloring', name: 'Simple coloring', run: s => simpleColoring(s), notes: true },
    { id: 'jellyfish', name: 'Jellyfish', run: s => fish(s, 4), notes: true },
    { id: 'contradiction', name: 'Contradiction (what-if)', run: s => contradiction(s, false), notes: true },
    { id: 'contradiction2', name: 'Deep contradiction (what-if)', run: s => contradiction(s, true), notes: true },
  ];

  // values: 81 digits (0 = empty). cands: 81 bitmasks of working candidates.
  function findStep(values, cands) {
    const s = { values, cands: cands.map((m, i) => (values[i] ? 0 : m)) };
    const legal = legalCands(values);
    for (const t of TECHNIQUES) {
      const step = t.run(s, legal);
      if (step) { step.needsNotes = !!t.notes; step.techId = t.id; return step; }
    }
    return null;
  }

  // Applies a step to plain arrays (used for "solve all" and tests).
  function applyStep(values, cands, step) {
    for (const p of step.place) {
      values[p.cell] = p.d;
      cands[p.cell] = 0;
      for (const q of PEERS[p.cell]) cands[q] &= ~(1 << p.d);
    }
    for (const e of step.elims) cands[e.cell] &= ~(1 << e.d);
  }

  return { findStep, applyStep, legalCands, conflicts, TECHNIQUES, unitName };
});
