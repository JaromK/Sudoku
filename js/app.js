(function () {
  'use strict';
  const E = window.SudokuEngine;
  const BANK = window.PUZZLE_BANK;
  const $ = id => document.getElementById(id);
  const name = E.cellName;
  const key = (cell, d) => cell + ':' + d;

  function list(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }
  const b = x => `<b>${x}</b>`;
  const set = ds => `{${ds.join(',')}}`;

  // ---------- decoration helpers ----------
  function newDeco() { return { cell: {}, cand: {} }; }
  function addCell(deco, i, cls) { deco.cell[i] = (deco.cell[i] || '') + ' ' + cls; }
  function addCand(deco, i, d, cls) { deco.cand[key(i, d)] = cls; }

  // ---------- technique definitions ----------
  function fishSteps(inst, size) {
    const d = inst.digit;
    const isRow = inst.orient === 'row';
    const lineWord = isRow ? 'row' : 'column';
    const crossWord = isRow ? 'column' : 'row';
    const lines = isRow ? E.ROWS : E.COLS;
    const crossLines = isRow ? E.COLS : E.ROWS;
    const own = isRow ? E.ROW_OF : E.COL_OF;
    const coverNames = inst.cover.map(c => c + 1);
    const baseNames = inst.base.map(c => c + 1);
    const steps = [];

    steps.push({
      text: `<p>Fish patterns are about a single digit. Focus on digit ${b(d)}: every cell that can still be a ${d} is highlighted in yellow.</p>
             <p>We're looking for ${size} ${lineWord}s where ${d} has very few possible spots.</p>`,
      deco: newDeco(), focus: d,
    });

    const deco = newDeco();
    inst.base.forEach((li, k) => {
      for (const i of lines[li]) addCell(deco, i, 'line-base');
      const spots = inst.cells.filter(i => own[i] === li);
      for (const i of spots) { addCell(deco, i, 'base'); addCand(deco, i, d, 'key'); }
      const snap = JSON.parse(JSON.stringify(deco));
      const intro = k === 0 ? `In ${lineWord} ${li + 1}` : `${lineWord[0].toUpperCase() + lineWord.slice(1)} ${li + 1}`;
      const extra = k === 0
        ? ''
        : ` Its spots are also inside ${crossWord}s ${list(coverNames)}.`;
      steps.push({
        text: `<p>${intro}, the ${d} can only go in ${spots.length} places: ${list(spots.map(name))}.${extra}</p>` +
          (k === inst.base.length - 1
            ? `<p>That's ${size} ${lineWord}s (${list(baseNames)}) whose ${d}s all fall inside just ${size} ${crossWord}s (${list(coverNames)}).</p>`
            : ''),
        deco: snap, focus: d,
      });
    });

    for (const ci of inst.cover) for (const i of crossLines[ci]) if (!inst.base.includes(own[i])) addCell(deco, i, 'line-cover');
    const logic = size === 2
      ? `<p>${lineWord[0].toUpperCase() + lineWord.slice(1)} ${baseNames[0]} must place its ${d} in ${crossWord} ${coverNames[0]} or ${coverNames[1]}. So must ${lineWord} ${baseNames[1]}, and they can't both pick the same ${crossWord}.</p>
         <p>So the two ${d}s land on opposite corners of the rectangle: one in ${crossWord} ${coverNames[0]} and one in ${crossWord} ${coverNames[1]}. We don't know which diagonal yet, but either way <b>both ${crossWord}s already get their ${d}</b> from these two ${lineWord}s.</p>`
      : `<p>Each of these ${size} ${lineWord}s needs its own ${d}, and they must all be in different ${crossWord}s. The only ${crossWord}s they can use are ${list(coverNames)}.</p>
         <p>So the three ${d}s fill ${crossWord}s ${list(coverNames)}, one in each. <b>All three ${crossWord}s get their ${d}</b> from these ${lineWord}s.</p>`;
    steps.push({ text: logic, deco: JSON.parse(JSON.stringify(deco)), focus: d });

    for (const e of inst.elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, d, 'elim'); }
    steps.push({
      text: `<p>So nowhere else in ${crossWord}s ${list(coverNames)} can hold a ${d}.</p>
             <p><b>Eliminate ${d} from ${list(inst.elims.map(e => name(e.cell)))}.</b></p>`,
      deco, focus: d, final: true,
    });
    return steps;
  }

  function wingSteps(inst, state, xyz) {
    const P = inst.pivot, [A, B] = inst.pincers, z = inst.z;
    const pd = inst.pivotDigits;
    const dA = E.digitsOf(state.cands[A]), dB = E.digitsOf(state.cands[B]);
    const xA = dA.find(d => d !== z), xB = dB.find(d => d !== z);
    const steps = [];
    const deco = newDeco();

    addCell(deco, P, 'pivot');
    for (const d of pd) addCand(deco, P, d, xyz && d === z ? 'z' : 'key');
    steps.push({
      text: xyz
        ? `<p>Start with a cell that has exactly <b>three</b> candidates. This is the <b>pivot</b>: ${name(P)} ${set(pd)}.</p>`
        : `<p>Start with a cell that has exactly <b>two</b> candidates. This is the <b>pivot</b>: ${name(P)} ${set(pd)}.</p>`,
      deco: JSON.parse(JSON.stringify(deco)),
    });

    for (const [c, ds] of [[A, dA], [B, dB]]) {
      addCell(deco, c, 'pincer');
      for (const d of ds) addCand(deco, c, d, d === z ? 'z' : 'key');
    }
    steps.push({
      text: `<p>The pivot sees two cells with two candidates each. These are the <b>pincers</b>:</p>
             <p>${name(A)} ${set(dA)} and ${name(B)} ${set(dB)}.</p>
             <p>${xyz ? 'Each pincer uses only digits from the pivot' : 'Each pincer shares one digit with the pivot'}, and both pincers share ${b(z)} (in orange).</p>`,
      deco: JSON.parse(JSON.stringify(deco)),
    });

    steps.push({
      text: xyz
        ? `<p>Go through each possible value of the pivot:</p>
           <p>• Pivot = ${xA} → ${name(A)} loses ${xA} → ${name(A)} = ${b(z)}.<br>
              • Pivot = ${xB} → ${name(B)} loses ${xB} → ${name(B)} = ${b(z)}.<br>
              • Pivot = ${z} → the pivot itself is ${b(z)}.</p>
           <p>In every case one of these <b>three</b> cells is a ${z}.</p>`
        : `<p>The pivot is either ${pd[0]} or ${pd[1]}:</p>
           <p>• Pivot = ${xA} → ${name(A)} loses ${xA} → ${name(A)} = ${b(z)}.<br>
              • Pivot = ${xB} → ${name(B)} loses ${xB} → ${name(B)} = ${b(z)}.</p>
           <p>Either way, one of the two pincers is a ${z}.</p>`,
      deco: JSON.parse(JSON.stringify(deco)),
    });

    for (const e of inst.elims) { addCell(deco, e.cell, 'target'); addCand(deco, e.cell, z, 'elim'); }
    steps.push({
      text: (xyz
        ? `<p>So any cell that sees <b>all three</b> cells (pivot and both pincers) can't be ${z}. Such cells sit in the pivot's box, lined up with the pincers.</p>`
        : `<p>So any cell that sees <b>both pincers</b> can't be ${z}, because it would clash with whichever pincer turns out to be ${z}.</p>`) +
        `<p><b>Eliminate ${z} from ${list(inst.elims.map(e => name(e.cell)))}.</b></p>`,
      deco, final: true,
    });
    return steps;
  }

  const TECHS = {
    xwing: {
      title: 'X-Wing', family: 'Fish', size: 2,
      tagline: 'Two rows, two columns, one digit: a rectangle that clears whole columns.',
      concept: `<p>Pick a digit. Find two rows where it fits in <b>exactly two</b> cells, and those cells are in the <b>same two columns</b>.
        The four cells form a rectangle. The digit has to be on one of its two diagonals.</p>
        <p>Either way, each of the two columns gets its copy of the digit from those two rows. So you can remove the digit from every <b>other</b> cell in those columns.
        The same works with rows and columns swapped.</p>`,
      tips: ['Work one digit at a time. Use the digit highlighter.',
        'Look for rows (or columns) where the digit appears exactly twice.',
        'Two of them lined up in the same columns form an X-Wing.',
        'Eliminations are in the <i>other</i> direction: base rows clear the columns, base columns clear the rows.'],
      steps: inst => fishSteps(inst, 2),
      hint1: inst => ({ text: `Look at digit <b>${inst.digit}</b> in the ${inst.orient === 'row' ? 'rows' : 'columns'}.`, focus: inst.digit }),
      fish: true,
    },
    swordfish: {
      title: 'Swordfish', family: 'Fish', size: 3,
      tagline: 'X-Wing extended to three rows and three columns.',
      concept: `<p>Same idea as the X-Wing, with three lines. Find three rows where a digit has only <b>2 or 3</b> spots each, and all those spots are inside the <b>same three columns</b>.</p>
        <p>The three rows need three copies of the digit in three different columns, so they fill all three columns.
        Remove the digit from the rest of those columns. A row doesn't need a spot in every column; a "2-2-2" swordfish is common and easy to miss.</p>`,
      tips: ['Again, one digit at a time.',
        'List the rows where the digit has 2–3 spots, and note which columns they use.',
        'Look for three rows whose columns together add up to only three different columns.',
        'If you can\'t find it in rows, try columns. Many swordfish only show up one way.'],
      steps: inst => fishSteps(inst, 3),
      hint1: inst => ({ text: `Look at digit <b>${inst.digit}</b> in the ${inst.orient === 'row' ? 'rows' : 'columns'}.`, focus: inst.digit }),
      fish: true,
    },
    ywing: {
      title: 'Y-Wing', family: 'Wings', aka: 'also called XY-Wing',
      tagline: 'Three two-candidate cells that close in on one digit.',
      concept: `<p>Find a <b>pivot</b> cell with two candidates {A,B}. It needs two <b>pincers</b> it can see: one with {A,C} and one with {B,C}.</p>
        <p>If the pivot is A, the first pincer must be C. If the pivot is B, the second pincer must be C. Either way <b>one of the pincers is C</b>,
        so any cell that sees both pincers can't be C.</p>`,
      tips: ['Only cells with exactly two candidates can take part. Turn on "Highlight bivalue cells".',
        'Pick a bivalue cell as the pivot and look for two bivalue cells it can see that each share one of its digits.',
        'The pincers must share the same third digit C.',
        'Eliminate C where the pincers\' rows, columns or boxes cross.'],
      steps: (inst, s) => wingSteps(inst, s, false),
      hint1: inst => ({ text: `The pivot is at <b>${name(inst.pivot)}</b>. Which two cells could act as its pincers?`, pivot: inst.pivot }),
    },
    xyzwing: {
      title: 'XYZ-Wing', family: 'Wings',
      tagline: 'A Y-Wing with a three-candidate pivot.',
      concept: `<p>The pivot has <b>three</b> candidates {X,Y,Z}. It sees two pincers {X,Z} and {Y,Z}.</p>
        <p>Now the pivot itself might be Z, so Z is in one of <b>all three</b> cells. You can only remove Z from cells that see the pivot <b>and</b> both pincers.
        That usually means one or two cells in the pivot's box, in line with the pincer outside the box.</p>`,
      tips: ['Look for a cell with exactly three candidates.',
        'Find two bivalue cells it sees, each using two of its three digits, with one digit (Z) in common.',
        'Usually one pincer is in the pivot\'s box and the other is in the pivot\'s row or column.',
        'Check the cells in the pivot\'s box that share a line with the outside pincer.'],
      steps: (inst, s) => wingSteps(inst, s, true),
      hint1: inst => ({ text: `The pivot is the three-candidate cell <b>${name(inst.pivot)}</b>.`, pivot: inst.pivot }),
    },
  };
  const ORDER = ['xwing', 'swordfish', 'ywing', 'xyzwing'];

  // ---------- puzzle loading ----------
  function loadPuzzle(tech, idx, transform) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const i = idx != null ? idx : Math.floor(Math.random() * BANK[tech].length);
      let grid = E.parse(BANK[tech][i]);
      if (transform) grid = E.randomTransform(grid);
      const state = E.applyBasics(E.makeState(grid));
      const insts = E.FINDERS[tech](state).sort((a, c) => c.elims.length - a.elims.length);
      if (insts.length) return { state, insts, idx: i };
      idx = null;
    }
    throw new Error('No puzzle found for ' + tech);
  }

  // ---------- board rendering ----------
  function renderBoard(wrap, s, opts) {
    opts = opts || {};
    const deco = opts.deco || newDeco();
    let html = '<div class="labels-col">';
    for (let c = 1; c <= 9; c++) html += `<span>${c}</span>`;
    html += '</div><div class="labels-row">';
    for (let r = 1; r <= 9; r++) html += `<span>${r}</span>`;
    html += `</div><div class="board${opts.onCand ? ' clickable' : ''}">`;
    for (let i = 0; i < 81; i++) {
      const r = E.ROW_OF[i], c = E.COL_OF[i];
      let cls = 'cell';
      if (c % 3 === 2) cls += c === 8 ? ' c8' : ' br';
      if (r % 3 === 2) cls += r === 8 ? ' r8' : ' bb';
      if (opts.bival && !s.values[i] && E.popcount(s.cands[i]) === opts.bival) cls += ' bival';
      if (deco.cell[i]) cls += deco.cell[i];
      html += `<div class="${cls}">`;
      if (s.values[i]) {
        html += `<div class="val ${s.given[i] ? 'given' : 'derived'}">${s.values[i]}</div>`;
      } else {
        html += '<div class="cands">';
        for (let d = 1; d <= 9; d++) {
          if (s.cands[i] & (1 << d)) {
            let cc = 'cand has';
            const extra = deco.cand[key(i, d)];
            if (extra) cc += ' ' + extra;
            else if (opts.focus === d) cc += ' focus';
            html += `<span class="${cc}" data-i="${i}" data-d="${d}">${d}</span>`;
          } else html += '<span class="cand"></span>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    wrap.innerHTML = html;
    const board = wrap.querySelector('.board');
    if (opts.onCand) {
      board.addEventListener('click', e => {
        const t = e.target.closest('.cand.has');
        if (t) opts.onCand(+t.dataset.i, +t.dataset.d);
      });
    }
  }

  // ---------- progress ----------
  const PKEY = 'sudokuAdvTrainer.progress';
  let progress = {};
  try { progress = JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { progress = {}; }
  function saveProgress() { try { localStorage.setItem(PKEY, JSON.stringify(progress)); } catch (e) { /* ignore */ } }

  // ---------- app state ----------
  let tech = ORDER[0];
  let mode = 'learn';
  const learn = {};
  const prac = {};

  function renderNav() {
    const nav = $('tech-nav');
    nav.innerHTML = ORDER.map(k => {
      const t = TECHS[k];
      const p = progress[k] || 0;
      return `<button class="tech-btn${k === tech ? ' active' : ''}" data-k="${k}">
        <div class="fam">${t.family}</div>
        <div class="nm">${t.title}</div>
        <div class="prog">${p ? `✓ ${p} solved` : '&nbsp;'}</div></button>`;
    }).join('');
    nav.querySelectorAll('.tech-btn').forEach(btn => btn.addEventListener('click', () => selectTech(btn.dataset.k)));
  }

  function selectTech(k) {
    tech = k;
    const t = TECHS[k];
    $('tech-title').innerHTML = t.title + (t.aka ? ` <small style="font-weight:400;color:var(--muted);font-size:.9rem">(${t.aka})</small>` : '');
    $('tech-tagline').textContent = t.tagline;
    $('concept').innerHTML = t.concept;
    $('tips').innerHTML = t.tips.map(x => `<li>${x}</li>`).join('');
    renderNav();
    startLearn(0, false);
    newPractice();
    setMode(mode);
  }

  function setMode(m) {
    mode = m;
    $('tab-learn').classList.toggle('active', m === 'learn');
    $('tab-practice').classList.toggle('active', m === 'practice');
    $('learn-view').classList.toggle('hidden', m !== 'learn');
    $('practice-view').classList.toggle('hidden', m !== 'practice');
  }

  // ---------- learn ----------
  function legendHtml(t) {
    const items = t.fish
      ? [['#fde047', 'the digit we focus on'], ['#bfdbfe', 'pattern cells'], ['#4ade80', 'pattern candidates'], ['#fef3c7', 'lines being cleared'], ['#ef4444', 'eliminated']]
      : [['#ddd6fe', 'pivot'], ['#fde68a', 'pincers'], ['#fb923c', 'the shared digit'], ['#fee2e2', 'cells affected'], ['#ef4444', 'eliminated']];
    return items.map(([c, l]) => `<span><span class="sw" style="background:${c}"></span>${l}</span>`).join('');
  }

  function startLearn(idx, transform) {
    const { state, insts } = loadPuzzle(tech, idx, transform);
    learn.state = state;
    learn.steps = TECHS[tech].steps(insts[0], state);
    learn.step = 0;
    $('learn-legend').innerHTML = legendHtml(TECHS[tech]);
    renderLearn();
  }

  function renderLearn() {
    const st = learn.steps[learn.step];
    renderBoard($('learn-board-wrap'), learn.state, { deco: st.deco, focus: st.focus });
    $('step-count').textContent = `Step ${learn.step + 1} of ${learn.steps.length}`;
    $('step-text').innerHTML = st.text;
    $('step-prev').disabled = learn.step === 0;
    $('step-next').disabled = learn.step === learn.steps.length - 1;
  }

  // ---------- practice ----------
  function newPractice() {
    let p;
    do { p = loadPuzzle(tech, null, true); } while (BANK[tech].length > 1 && p.idx === prac.lastIdx && prac.tech === tech);
    Object.assign(prac, {
      tech, lastIdx: p.idx, state: p.state, insts: p.insts, marked: new Set(), wrong: new Set(),
      hint: 0, hintDeco: null, done: false, revealed: false, focus: null,
      union: new Set(p.insts.flatMap(x => x.elims.map(e => key(e.cell, e.digit))))
    });
    const t = TECHS[tech];
    $('task').innerHTML = `<p><b>Find a ${t.title}</b> and click every candidate it eliminates. Click again to unmark. Then press <b>Check</b>.</p>` +
      (p.insts.length > 1 ? `<p style="color:var(--muted);font-size:.9rem">There's more than one ${t.title} on this board. Finding any one of them counts.</p>` : '');
    $('bival-label').textContent = tech === 'xyzwing' ? 'Highlight 2-candidate (green) and 3-candidate (blue) cells' : 'Highlight bivalue cells';
    hideFeedback();
    renderPractice();
  }

  function practiceDeco() {
    const deco = prac.hintDeco ? JSON.parse(JSON.stringify(prac.hintDeco)) : newDeco();
    for (const k of prac.marked) deco.cand[k] = prac.wrong.has(k) ? 'wrong' : 'marked';
    return deco;
  }

  function renderPractice() {
    const showBival = $('bival-toggle').checked;
    const deco = practiceDeco();
    if (showBival && tech === 'xyzwing') {
      for (let i = 0; i < 81; i++) {
        const n = E.popcount(prac.state.cands[i]);
        if (!prac.state.values[i] && (n === 2 || n === 3)) addCell(deco, i, n === 2 ? 'bival' : 'trival');
      }
    }
    renderBoard($('practice-board-wrap'), prac.state, {
      deco, focus: prac.focus,
      bival: showBival && tech !== 'xyzwing' ? 2 : 0,
      onCand: prac.done ? null : onPracticeCand,
    });
    document.querySelectorAll('.digit-btn').forEach(btn => btn.classList.toggle('active', +btn.dataset.d === prac.focus));
    ['btn-check', 'btn-hint', 'btn-reveal', 'btn-clear'].forEach(id => { $(id).disabled = prac.done; });
    const p = progress[tech] || 0;
    $('stats').textContent = p ? `You've solved ${p} ${TECHS[tech].title} puzzle${p > 1 ? 's' : ''}.` : '';
  }

  function onPracticeCand(i, d) {
    const k = key(i, d);
    if (prac.marked.has(k)) prac.marked.delete(k); else prac.marked.add(k);
    prac.wrong.delete(k);
    renderPractice();
  }

  function feedback(kind, html) {
    const f = $('feedback');
    f.className = 'feedback ' + kind;
    f.innerHTML = html;
  }
  function hideFeedback() { $('feedback').className = 'feedback hidden'; }

  function setFocus(d) {
    prac.focus = prac.focus === d ? null : d;
    renderPractice();
  }

  function check() {
    const t = TECHS[tech];
    if (!prac.marked.size) { feedback('info', '<p>Click the candidates you think the pattern removes, then press Check.</p>'); return; }
    const wrong = [...prac.marked].filter(k => !prac.union.has(k));
    if (wrong.length) {
      prac.wrong = new Set(wrong);
      renderPractice();
      feedback('bad', `<p>${wrong.length === 1 ? 'One mark' : wrong.length + ' marks'} (dark red) can't be removed by a ${t.title} here. Unmark ${wrong.length === 1 ? 'it' : 'them'} and look again.</p>`);
      return;
    }
    const complete = prac.insts.find(x => x.elims.every(e => prac.marked.has(key(e.cell, e.digit))));
    if (!complete) {
      feedback('info', '<p>Everything you marked is correct, but the pattern removes more candidates. Keep going.</p>');
      return;
    }
    succeed(complete, false);
  }

  function succeed(inst, revealed) {
    const t = TECHS[tech];
    const steps = t.steps(inst, prac.state);
    const fin = steps[steps.length - 1];
    prac.hintDeco = fin.deco;
    prac.marked = new Set();
    prac.done = true;
    prac.focus = fin.focus || null;
    if (!revealed && prac.hint < 3) {
      progress[tech] = (progress[tech] || 0) + 1;
      saveProgress();
      renderNav();
    }
    renderPractice();
    feedback(revealed ? 'info' : 'ok',
      `<p><b>${revealed ? 'Here it is.' : (prac.hint ? 'Correct!' : 'Correct, and with no hints!')}</b></p>` +
      steps.slice(1).map(s => s.text).join('') +
      `<p><button class="btn primary" id="btn-next-inline">Next puzzle &rarr;</button></p>`);
    $('btn-next-inline').addEventListener('click', newPractice);
  }

  function hint() {
    const inst = prac.insts[0];
    const t = TECHS[tech];
    const steps = t.steps(inst, prac.state);
    prac.hint = Math.min(prac.hint + 1, 2);
    if (prac.hint === 1) {
      const h = t.hint1(inst);
      if (h.focus) prac.focus = h.focus;
      const deco = newDeco();
      if (h.pivot != null) addCell(deco, h.pivot, 'pivot');
      prac.hintDeco = deco;
      feedback('info', `<p><b>Hint 1:</b> ${h.text}</p>`);
    } else {
      const pattern = steps[steps.length - 2];
      prac.hintDeco = pattern.deco;
      if (pattern.focus) prac.focus = pattern.focus;
      feedback('info', `<p><b>Hint 2:</b> here's the pattern.</p>${pattern.text}<p>Which candidates does it remove?</p>`);
    }
    renderPractice();
  }

  function reveal() {
    prac.hint = 3;
    succeed(prac.insts[0], true);
  }

  // ---------- wiring ----------
  function init() {
    $('tab-learn').addEventListener('click', () => setMode('learn'));
    $('tab-practice').addEventListener('click', () => setMode('practice'));
    $('step-prev').addEventListener('click', () => { if (learn.step > 0) { learn.step--; renderLearn(); } });
    $('step-next').addEventListener('click', () => { if (learn.step < learn.steps.length - 1) { learn.step++; renderLearn(); } });
    $('learn-another').addEventListener('click', () => startLearn(null, true));
    $('learn-go-practice').addEventListener('click', () => setMode('practice'));
    $('btn-check').addEventListener('click', check);
    $('btn-hint').addEventListener('click', hint);
    $('btn-reveal').addEventListener('click', reveal);
    $('btn-clear').addEventListener('click', () => { prac.marked.clear(); prac.wrong.clear(); hideFeedback(); renderPractice(); });
    $('btn-new').addEventListener('click', newPractice);
    $('bival-toggle').addEventListener('change', renderPractice);

    const row = $('digit-row');
    for (let d = 1; d <= 9; d++) {
      const btn = document.createElement('button');
      btn.className = 'digit-btn';
      btn.dataset.d = d;
      btn.textContent = d;
      btn.addEventListener('click', () => setFocus(d));
      row.appendChild(btn);
    }

    document.addEventListener('keydown', e => {
      if ($('learn-app').classList.contains('hidden') || e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (mode === 'learn') {
        if (e.key === 'ArrowRight') $('step-next').click();
        if (e.key === 'ArrowLeft') $('step-prev').click();
        return;
      }
      if (e.key >= '1' && e.key <= '9') setFocus(+e.key);
      if (e.key === '0' || e.key === 'Escape') { prac.focus = null; renderPractice(); }
    });

    selectTech(ORDER[0]);
    window.__trainer = { prac, learn }; // for debugging from the console
  }

  init();
})();
