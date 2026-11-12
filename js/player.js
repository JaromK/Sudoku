// Play screen: a full sudoku player with normal / centre (candidate) / colour entry,
// multi-cell selection, undo/redo, timer, checking, photo import and a step-by-step assistant.
(function () {
  'use strict';
  const E = window.SudokuEngine, S = window.StepSolver, O = window.SudokuOCR, L = window.SudokuLevels;
  const $ = id => document.getElementById(id);
  const name = E.cellName;
  const SETKEY = 'sudokuTrainer.settings';
  const COLOURS = [null, '#c9ccd1', '#f3a6a6', '#f7c58c', '#f2e188', '#a6dd9f', '#9ccdee', '#bcb2f0', '#efb1da', '#9fe1d1'];
  const MODES = ['normal', 'centre', 'colour'];
  // One colour fills the cell; several split it into equal pie slices.
  function colourFill(mask) {
    const cs = E.digitsOf(mask).map(c => COLOURS[c]);
    if (cs.length === 1) return cs[0];
    const step = 100 / cs.length;
    return `conic-gradient(from -45deg, ${cs.map((c, k) => `${c} ${k * step}% ${(k + 1) * step}%`).join(', ')})`;
  }

  const settings = { conflicts: true, sameDigit: true, seen: true, autoClean: true, timer: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETKEY)) || {}); } catch (e) { /* ignore */ }
  function saveSettings() { try { localStorage.setItem(SETKEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  const blank = () => new Array(81).fill(0);
  const st = {
    phase: 'setup', values: blank(), given: new Array(81).fill(false), corner: blank(), centre: blank(), colour: blank(),
    sel: new Set(), cursor: -1, mode: 'normal',
    solution: null, unique: false, solved: false,
    undo: [], redo: [], log: [],
    step: null, view: null, filledNote: false,
    unsure: new Set(), wrong: new Set(),
    elapsed: 0, runningSince: null, paused: false,
  };

  // ---------- timer ----------
  const playVisible = () => !$('play-app').classList.contains('hidden');
  function startTimer() {
    if (st.runningSince == null && st.phase === 'play' && !st.solved && !st.paused && playVisible() && !document.hidden) st.runningSince = Date.now();
  }
  function stopTimer() {
    if (st.runningSince != null) { st.elapsed += Date.now() - st.runningSince; st.runningSince = null; }
  }
  const elapsedNow = () => st.elapsed + (st.runningSince != null ? Date.now() - st.runningSince : 0);
  function fmt(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
  }
  function togglePause(force) {
    if (st.phase !== 'play' || st.solved) return;
    const p = force != null ? force : !st.paused;
    if (p) { stopTimer(); st.paused = true; } else { st.paused = false; startTimer(); }
    render();
  }

  // ---------- undo / redo ----------
  const LAYERS = ['values', 'given', 'corner', 'centre', 'colour'];
  function snap() {
    const s = { log: st.log.slice() };
    for (const k of LAYERS) s[k] = st[k].slice();
    return s;
  }
  function restoreSnap(s) { for (const k of LAYERS) st[k] = s[k]; st.log = s.log; }
  const sameBoard = b => LAYERS.every(k => b[k].every((x, i) => x === st[k][i]));
  // Runs fn; if the board changed, records an undo entry.
  function mutate(fn) {
    const before = snap();
    fn();
    if (sameBoard(before) && before.log.length === st.log.length) return false;
    st.undo.push(before);
    if (st.undo.length > 500) st.undo.shift();
    st.redo = [];
    afterChange();
    return true;
  }
  function afterChange() { clearStep(); st.wrong.clear(); checkSolved(); render(); }
  function doUndo() {
    if (!st.undo.length) return;
    st.redo.push(snap());
    restoreSnap(st.undo.pop());
    afterChange();
  }
  function doRedo() {
    if (!st.redo.length) return;
    st.undo.push(snap());
    restoreSnap(st.redo.pop());
    afterChange();
  }

  // ---------- helpers ----------
  const legal = () => S.legalCands(st.values);
  function workingCands() {
    const l = legal();
    return l.map((m, i) => (st.values[i] ? 0 : (st.centre[i] ? st.centre[i] & m : m)));
  }
  function computeSolution() {
    const givens = st.values.map((v, i) => (st.given[i] ? v : 0));
    if (givens.filter(Boolean).length < 17 || S.conflicts(givens).size) { st.solution = null; st.unique = false; return 0; }
    const r = E.solve(givens, 2);
    st.solution = r.solution;
    st.unique = r.count === 1;
    return r.count;
  }
  const isComplete = () => st.values.every(v => v) && S.conflicts(st.values).size === 0;
  function checkSolved() {
    if (st.phase !== 'play') return;
    const was = st.solved;
    st.solved = isComplete();
    if (st.solved && !was) {
      stopTimer();
      st.sel.clear();
      msg('play-msg', 'ok', `<p><b>Solved!</b> Time: ${fmt(elapsedNow())}. Every row, column and box is complete.</p>`);
      if (!st.autoSolving && window.Fireworks) {
        window.Fireworks.celebrate({ time: fmt(elapsedNow()), level: st.level ? L.LEVELS[st.level].name : '', onNew: openNew });
      }
    }
    if (!st.solved && was) startTimer();
  }
  function msg(id, kind, html) { const f = $(id); f.className = 'msg ' + kind; f.innerHTML = html; }
  function hideMsg(id) { $(id).className = 'msg hidden'; }
  function clearStep() { st.step = null; st.view = null; $('step-box').classList.add('hidden'); }

  // ---------- rendering ----------
  function render() {
    const conf = settings.conflicts ? S.conflicts(st.values) : new Set();
    const deco = st.step && st.view === 'full' ? st.step.deco : st.step && st.view === 'hint' ? st.step.hintDeco : null;
    const focus = st.step && st.view ? st.step.focus : null;
    const one = st.sel.size === 1 ? [...st.sel][0] : -1;
    const selDigit = settings.sameDigit && one >= 0 ? st.values[one] : 0;
    const seen = new Set();
    if (settings.seen && one >= 0) for (const p of E.PEERS[one]) seen.add(p);
    const preview = {};
    if (st.step && st.view === 'full') for (const p of st.step.place) preview[p.cell] = p.d;

    let html = '';
    for (let i = 0; i < 81; i++) {
      const r = E.ROW_OF[i], c = E.COL_OF[i];
      let cls = 'pc';
      if (c === 2 || c === 5) cls += ' br';
      if (r === 2 || r === 5) cls += ' bb';
      if (c === 8) cls += ' c8';
      if (r === 8) cls += ' r8';
      if (seen.has(i)) cls += ' seen';
      if (selDigit && st.values[i] === selDigit) cls += ' same';
      if (deco && deco.cell[i]) cls += deco.cell[i];
      if (st.sel.has(i)) cls += ' sel';
      if (st.phase === 'setup' && st.unsure.has(i)) cls += ' unsure';
      html += `<div class="${cls}">`;
      if (st.colour[i]) html += `<div class="pcol" style="background:${colourFill(st.colour[i])}"></div>`;
      if (st.values[i]) {
        const g = st.phase === 'setup' || st.given[i];
        html += `<div class="pv ${g ? 'given' : 'user'}${conf.has(i) ? ' clash' : ''}${st.wrong.has(i) ? ' wrong' : ''}">${st.values[i]}</div>`;
      } else if (preview[i]) {
        html += `<div class="pv preview">${preview[i]}</div>`;
      } else {
        if (st.centre[i]) {
          const ds = E.digitsOf(st.centre[i]);
          html += `<div class="pcentre n${ds.length}">` + ds.map(d => {
            const x = deco && deco.cand[i + ':' + d];
            return `<span class="${x || (focus === d ? 'focus' : selDigit === d ? 'hl' : '')}">${d}</span>`;
          }).join('') + '</div>';
        }
      }
      html += '</div>';
    }
    $('pboard').innerHTML = html;
    renderPanel();
  }

  function renderPanel() {
    const setup = st.phase === 'setup';
    document.body.classList.toggle('setup-phase', setup);
    if (!setup) showPhotoOverlay(false);
    $('setup-panel').classList.toggle('hidden', !setup);
    $('assistant').classList.toggle('hidden', setup);
    $('given-count').textContent = st.values.filter(Boolean).length;
    const mode = setup ? 'normal' : st.mode;
    document.querySelectorAll('.mode-btn[data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.disabled = setup && b.dataset.mode !== 'normal';
    });
    $('keypad').className = 'keypad mode-' + mode;
    const counts = new Array(10).fill(0);
    for (const v of st.values) counts[v]++;
    document.querySelectorAll('.key-btn').forEach(b => b.classList.toggle('done', mode !== 'colour' && counts[+b.dataset.d] >= 9));
    $('p-undo').disabled = !st.undo.length;
    $('p-redo').disabled = !st.redo.length;
    $('p-restart').disabled = setup;
    $('p-check').disabled = setup;
    $('p-pause').disabled = setup || st.solved;
    $('p-pause').textContent = st.paused ? '▶' : '❚❚';
    $('p-pause').title = st.paused ? 'Resume' : 'Pause';
    $('timer-wrap').classList.toggle('hidden', !settings.timer);
    $('level-tag').textContent = st.level ? L.LEVELS[st.level].name : '';
    $('level-tag').classList.toggle('hidden', !st.level || setup);
    $('pause-cover').classList.toggle('hidden', !st.paused);
    $('log-count').textContent = st.log.length;
    $('log').innerHTML = st.log.map(x => `<li>${x}</li>`).join('');
  }

  // ---------- entering ----------
  const editable = i => st.phase === 'setup' || !st.given[i];

  function enter(d, mode) {
    if (st.paused || !st.sel.size) return;
    if (st.phase === 'setup') {
      const cells = [...st.sel];
      mutate(() => {
        const all = cells.every(i => st.values[i] === d);
        for (const i of cells) { st.values[i] = all ? 0 : d; st.given[i] = !all; st.unsure.delete(i); }
      });
      validateSetup(false);
      return;
    }
    mode = mode || st.mode;
    if (mode === 'colour') {
      const cells = [...st.sel];
      mutate(() => {
        const bit = 1 << d; // a cell can hold several colours: toggle this one
        const all = cells.every(i => st.colour[i] & bit);
        for (const i of cells) st.colour[i] = all ? st.colour[i] & ~bit : st.colour[i] | bit;
      });
      return;
    }
    const cells = [...st.sel].filter(editable);
    if (!cells.length) return;
    mutate(() => {
      if (mode === 'normal') {
        const all = cells.every(i => st.values[i] === d);
        for (const i of cells) {
          if (all) { st.values[i] = 0; continue; }
          st.values[i] = d;
          if (settings.autoClean) for (const p of E.PEERS[i]) { st.centre[p] &= ~(1 << d); st.corner[p] &= ~(1 << d); }
        }
      } else {
        const arr = st.centre;
        const empty = cells.filter(i => !st.values[i]);
        if (!empty.length) return;
        const bit = 1 << d;
        const all = empty.every(i => arr[i] & bit);
        for (const i of empty) arr[i] = all ? arr[i] & ~bit : arr[i] | bit;
      }
    });
  }

  function del() {
    if (st.paused || !st.sel.size) return;
    const all = [...st.sel];
    if (st.phase === 'setup') {
      mutate(() => { for (const i of all) { st.values[i] = 0; st.given[i] = false; st.unsure.delete(i); } });
      validateSetup(false);
      return;
    }
    const cells = all.filter(editable);
    mutate(() => {
      if (st.mode === 'colour') { for (const i of all) st.colour[i] = 0; return; }
      if (cells.some(i => st.values[i])) { for (const i of cells) st.values[i] = 0; return; }
      const layers = ['centre'];
      if (cells.some(i => layers.some(l => st[l][i]))) { for (const i of cells) for (const l of layers) st[l][i] = 0; return; }
      for (const i of all) st.colour[i] = 0;
    });
  }

  function setMode(m) {
    if (st.phase === 'setup') return;
    st.mode = m;
    render();
  }

  // ---------- selection ----------
  function cellAt(e) {
    const r = $('pboard').getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 9), y = Math.floor((e.clientY - r.top) / r.height * 9);
    return x < 0 || y < 0 || x > 8 || y > 8 ? -1 : y * 9 + x;
  }
  let drag = null;
  function initBoardPointer() {
    const board = $('pboard');
    board.addEventListener('pointerdown', e => {
      if (st.paused) return;
      const i = cellAt(e);
      if (i < 0) return;
      e.preventDefault();
      const multi = e.shiftKey || e.ctrlKey || e.metaKey;
      if (multi && st.sel.has(i) && (e.ctrlKey || e.metaKey)) { st.sel.delete(i); drag = { remove: true }; }
      else if (multi) { st.sel.add(i); drag = { remove: false }; }
      else { st.sel = new Set([i]); drag = { remove: false }; }
      st.cursor = i;
      try { board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      render();
    });
    board.addEventListener('pointermove', e => {
      if (!drag) return;
      const i = cellAt(e);
      if (i < 0) return;
      const has = st.sel.has(i);
      if (drag.remove ? !has : has) return;
      if (drag.remove) st.sel.delete(i); else st.sel.add(i);
      st.cursor = i;
      render();
    });
    const end = () => { drag = null; };
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
    board.addEventListener('dblclick', e => {
      const i = cellAt(e);
      if (i < 0) return;
      const all = [...Array(81).keys()];
      if (st.values[i]) st.sel = new Set(all.filter(j => st.values[j] === st.values[i]));
      else if (st.colour[i]) st.sel = new Set(all.filter(j => st.colour[j] & st.colour[i]));
      render();
    });
  }
  function moveCursor(dr, dc, extend) {
    const from = st.cursor >= 0 ? st.cursor : 40;
    const to = ((E.ROW_OF[from] + dr + 9) % 9) * 9 + (E.COL_OF[from] + dc + 9) % 9;
    if (st.cursor < 0) st.sel = new Set([from]);
    else if (extend) st.sel.add(to);
    else st.sel = new Set([to]);
    if (st.cursor >= 0) st.cursor = to; else st.cursor = from;
    render();
  }

  // ---------- setup ----------
  function loadGrid(grid, opts) {
    opts = opts || {};
    stopTimer();
    Object.assign(st, {
      phase: 'setup', values: grid.slice(), given: grid.map(v => v > 0), corner: blank(), centre: blank(), colour: blank(),
      sel: new Set(), cursor: -1, mode: 'normal', solution: null, unique: false, solved: false, undo: [], redo: [], log: [],
      unsure: opts.unsure || new Set(), wrong: new Set(), elapsed: 0, runningSince: null, paused: false,
      level: opts.level || null,
    });
    clearStep();
    hideMsg('play-msg');
    hideMsg('setup-msg');
    $('photo-compare').classList.toggle('hidden', !opts.photo);
    $('p-photo-toggle').classList.toggle('hidden', !opts.photo);
    showPhotoOverlay(false);
    render();
    if (grid.some(Boolean)) validateSetup(false);
  }

  function validateSetup(loud) {
    const n = st.values.filter(Boolean).length;
    if (S.conflicts(st.values).size) { msg('setup-msg', 'bad', '<p>Some digits clash (red): the same digit twice in a row, column or box.</p>'); return false; }
    if (n < 17) {
      if (loud) msg('setup-msg', 'bad', `<p>A sudoku needs at least 17 givens to have a single answer. There are ${n} so far.</p>`);
      else hideMsg('setup-msg');
      return false;
    }
    const count = computeSolution();
    if (count === 0) { msg('setup-msg', 'bad', '<p>This grid has <b>no solution</b>. Probably a digit was read or typed wrong.</p>'); return false; }
    if (count > 1) { msg('setup-msg', 'info', '<p>This grid has <b>more than one solution</b>, so a digit may be missing. You can still start, but the assistant may get stuck.</p>'); return true; }
    msg('setup-msg', 'ok', `<p>Looks good: ${n} givens and exactly one solution.</p>`);
    return true;
  }

  // On phones the straightened photo is shown on top of the board (toggle) instead of below it.
  function showPhotoOverlay(on) {
    const ov = $('photo-overlay');
    if (on) ov.getContext('2d').drawImage($('warp-canvas'), 0, 0);
    ov.classList.toggle('hidden', !on);
    $('p-photo-toggle').textContent = on ? 'Hide photo' : 'Show photo';
  }

  function startPlay() {
    if (!validateSetup(true)) return;
    st.phase = 'play';
    st.given = st.values.map(v => v > 0);
    Object.assign(st, { corner: blank(), centre: blank(), colour: blank(), undo: [], redo: [], log: [],
      unsure: new Set(), wrong: new Set(), elapsed: 0, runningSince: null, paused: false, solved: false, mode: 'normal' });
    clearStep();
    hideMsg('setup-msg');
    msg('play-msg', 'info', '<p>Select a cell and type a digit. Hold <kbd>Shift</kbd> or <kbd>Ctrl</kbd> to add candidates, or pick a mode next to the digits. Stuck? Press <b>Hint</b>.</p>');
    startTimer();
    render();
  }

  function restart() {
    if (st.phase !== 'play') return;
    if (!window.confirm('Restart this puzzle? All your digits, marks and colours will be cleared.')) return;
    mutate(() => {
      for (let i = 0; i < 81; i++) {
        if (!st.given[i]) st.values[i] = 0;
        st.corner[i] = 0; st.centre[i] = 0; st.colour[i] = 0;
      }
      st.log = [];
    });
    st.elapsed = 0; st.runningSince = null; st.paused = false; st.solved = false;
    hideMsg('play-msg');
    startTimer();
    render();
  }

  // ---------- checking ----------
  function boardProblems() {
    if (!st.unique || !st.solution) return null;
    const wrongVals = [], badNotes = [];
    for (let i = 0; i < 81; i++) {
      if (st.values[i] && !st.given[i] && st.values[i] !== st.solution[i]) wrongVals.push(i);
      if (!st.values[i] && st.centre[i] && !(st.centre[i] & (1 << st.solution[i]))) badNotes.push(i);
    }
    return (wrongVals.length || badNotes.length) ? { wrongVals, badNotes } : null;
  }
  function reportProblems(p) {
    let html = '';
    if (p.wrongVals.length) {
      st.wrong = new Set(p.wrongVals);
      html += `<p>${p.wrongVals.length === 1 ? 'A digit is' : p.wrongVals.length + ' digits are'} wrong (red): ${p.wrongVals.map(name).join(', ')}.</p>
               <p><button class="pbtn" id="fix-vals">Clear the wrong digits</button></p>`;
    }
    if (p.badNotes.length) {
      html += `<p>The candidates in ${p.badNotes.map(name).join(', ')} are missing a digit the cell needs.</p>
               <p><button class="pbtn" id="fix-notes">Restore the candidates there</button></p>`;
    }
    render();
    msg('play-msg', 'bad', html);
    const fv = $('fix-vals'), fn = $('fix-notes');
    if (fv) fv.addEventListener('click', () => { mutate(() => { for (const i of p.wrongVals) st.values[i] = 0; }); hideMsg('play-msg'); });
    if (fn) fn.addEventListener('click', () => { const l = legal(); mutate(() => { for (const i of p.badNotes) st.centre[i] = l[i]; }); hideMsg('play-msg'); });
  }
  // Check only tells the player whether they're on the right track; it doesn't point at cells.
  function check() {
    clearStep();
    if (st.solved) { toast('ok', `Solved! Time ${fmt(elapsedNow())}`); return; }
    if (!st.unique) { toast('info', 'This puzzle has more than one solution, so I can\'t check it.'); return; }
    if (boardProblems()) toast('bad', 'Not quite. Something on the board is wrong.');
    else toast('ok', 'Good so far! You\'re on the right track.');
  }
  let toastTimer = 0;
  function toast(kind, text) {
    const t = $('toast');
    t.className = 'toast ' + kind;
    t.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ---------- assistant ----------
  function fillCandidates() {
    const l = legal();
    // Every empty cell gets exactly the digits not already in its row, column or box.
    mutate(() => { for (let i = 0; i < 81; i++) st.centre[i] = st.values[i] ? 0 : l[i]; });
  }
  function clearMarks() { mutate(() => { st.corner.fill(0); st.centre.fill(0); }); }

  function findNext() {
    const step = S.findStep(st.values, workingCands());
    if (step) return step;
    if (!st.solution) return null;
    const wc = workingCands();
    let best = -1;
    for (let i = 0; i < 81; i++) if (!st.values[i] && (best < 0 || E.popcount(wc[i]) < E.popcount(wc[best]))) best = i;
    if (best < 0) return null;
    const d = st.solution[best];
    const deco = { cell: { [best]: ' solve' }, cand: {} };
    return {
      tech: 'Reveal', place: [{ cell: best, d }], elims: [], deco, hintDeco: deco,
      hint: 'This position is beyond every technique I know, so I can reveal a cell.',
      text: `<p>None of the techniques I know (all the way up to what-if contradictions) make progress here. This is an extremely hard puzzle.</p>
             <p>To keep you going, here is one cell from the solution: <b>${name(best)} = ${d}</b>.</p>`,
    };
  }

  function ensureStep() {
    if (st.step) return true;
    if (st.phase !== 'play') return false;
    if (st.solved) { check(); return false; }
    const p = boardProblems();
    if (p) { reportProblems(p); return false; }
    let step = findNext();
    if (!step) { msg('play-msg', 'bad', '<p>I couldn\'t find a next step. Check the board for mistakes.</p>'); return false; }
    st.filledNote = false;
    if (step.needsNotes && st.values.some((v, i) => !v && !st.centre[i])) {
      const l = legal();
      mutate(() => { for (let i = 0; i < 81; i++) if (!st.values[i] && !st.centre[i]) st.centre[i] = l[i]; });
      st.filledNote = true;
      step = findNext();
    }
    st.step = step;
    return true;
  }

  function showStep(view) {
    if (st.paused || !ensureStep()) return;
    st.view = view;
    hideMsg('play-msg');
    const s = st.step;
    const box = $('step-box');
    box.classList.remove('hidden');
    box.querySelector('.tech-badge').textContent = view === 'hint' ? 'Hint' : s.tech;
    box.querySelector('.step-body').innerHTML =
      (st.filledNote ? '<p class="note-fill">This step works with candidates, so I filled them into the centre marks of the empty cells.</p>' : '') +
      (view === 'hint' ? `<p>Try a <b>${s.tech}</b>. ${s.hint}</p>` : s.text);
    render();
  }

  function summary(step) {
    const parts = [];
    if (step.place.length) parts.push(step.place.map(p => `${name(p.cell)} = ${p.d}`).join(', '));
    if (step.elims.length) {
      const by = new Map();
      for (const e of step.elims) { if (!by.has(e.d)) by.set(e.d, []); by.get(e.d).push(name(e.cell)); }
      parts.push([...by].map(([d, cs]) => `removed ${d} from ${cs.join(', ')}`).join('; '));
    }
    return `<b>${step.tech}</b>: ${parts.join('; ')}`;
  }

  function applyStepToBoard(step) {
    const wc = workingCands();
    for (const p of step.place) {
      st.values[p.cell] = p.d;
      for (const q of E.PEERS[p.cell]) { st.centre[q] &= ~(1 << p.d); st.corner[q] &= ~(1 << p.d); }
    }
    for (const e of step.elims) {
      if (!st.centre[e.cell]) st.centre[e.cell] = wc[e.cell];
      st.centre[e.cell] &= ~(1 << e.d);
    }
    st.log.push(summary(step));
  }

  function applyStep() {
    if (st.paused || !ensureStep()) return;
    const step = st.step;
    mutate(() => applyStepToBoard(step));
    if (!st.solved) msg('play-msg', 'ok', `<p>Applied. ${summary(step)}</p>`);
  }

  function solveAll() {
    if (st.paused || st.phase !== 'play') return;
    clearStep();
    if (st.solved) { check(); return; }
    const p = boardProblems();
    if (p) { reportProblems(p); return; }
    msg('play-msg', 'info', '<p>Solving…</p>');
    setTimeout(() => {
      const used = {};
      let n = 0;
      st.autoSolving = true; // no fireworks when the computer finishes the puzzle
      try { mutate(() => {
        const l = legal();
        for (let i = 0; i < 81; i++) if (!st.values[i] && !st.centre[i]) st.centre[i] = l[i];
        while (!isComplete()) {
          const step = findNext();
          if (!step) break;
          applyStepToBoard(step);
          used[step.tech] = (used[step.tech] || 0) + 1;
          if (++n > 1000) break;
        }
      }); } finally { st.autoSolving = false; }
      const list = Object.entries(used).map(([t, c]) => `${t} ×${c}`).join(', ');
      msg('play-msg', st.solved ? 'ok' : 'bad',
        `<p><b>${st.solved ? 'Solved' : 'Stopped'} after ${n} steps.</b> Techniques used: ${list || 'none'}.</p>
         <p>Open "Steps taken" to read them, or press Undo to go back.</p>`);
    }, 30);
  }

  // ---------- dialogs ----------
  function openModal(id) { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); $(id).classList.remove('hidden'); }
  function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
  function openNew() {
    $('paste-row').classList.add('hidden');
    leavePhoto();
    hideMsg('new-msg');
    $('level-status').textContent = '';
    markLevel();
    openModal('dlg-new');
  }

  // ---------- levels ----------
  let generating = false;
  function markLevel(cur) {
    cur = cur || st.level;
    document.querySelectorAll('.level-btn').forEach(b => b.classList.toggle('active', b.dataset.level === cur));
  }
  function newRandom(level) {
    if (generating) return;
    generating = true;
    markLevel(level);
    document.querySelectorAll('.level-btn').forEach(b => { b.disabled = true; });
    $('level-status').textContent = `Creating a ${L.LEVELS[level].name.toLowerCase()} puzzle…`;
    L.generate(level, r => {
      generating = false;
      document.querySelectorAll('.level-btn').forEach(b => { b.disabled = false; });
      $('level-status').textContent = '';
      closeModals();
      loadGrid(r.puzzle, { level });
      startPlay();
    });
  }

  // ---------- photo import ----------
  const crop = { img: null, gray: null, corners: null, scale: 1, drag: -1 };

  async function onPhoto(file) {
    if (!file) return;
    $('ocr-status').textContent = '';
    hideMsg('new-msg');
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { msg('new-msg', 'bad', '<p>Couldn\'t open that image. Try a JPG or PNG.</p>'); return; }
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    crop.img = cv;
    crop.gray = O.grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
    const det = O.detectGrid(crop.gray);
    crop.corners = det.corners;
    $('crop-hint').textContent = det.found
      ? 'I found the grid. Make sure the four handles sit on its outer corners (drag them if not), then press Read digits.'
      : 'I couldn\'t find the grid by myself. Drag the four handles onto the outer corners of the grid, then press Read digits.';
    $('paste-row').classList.add('hidden');
    // Show the photo step on its own so the crop area and buttons aren't pushed off a phone screen.
    $('new-card').classList.add('photo-mode');
    $('crop-panel').classList.remove('hidden');
    drawCrop();
    $('dlg-new').scrollTop = 0;
  }
  function leavePhoto() {
    $('new-card').classList.remove('photo-mode');
    $('crop-panel').classList.add('hidden');
    $('ocr-status').textContent = '';
    hideMsg('new-msg');
  }

  function drawCrop() {
    const cv = $('crop-canvas');
    const maxW = Math.max(200, cv.parentElement.clientWidth || 560);
    crop.scale = Math.min(1, maxW / crop.img.width, (window.innerHeight * 0.5) / crop.img.height);
    cv.width = Math.round(crop.img.width * crop.scale);
    cv.height = Math.round(crop.img.height * crop.scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(crop.img, 0, 0, cv.width, cv.height);
    const pts = crop.corners.map(p => ({ x: p.x * crop.scale, y: p.y * crop.scale }));
    ctx.fillStyle = 'rgba(79,70,229,.10)';
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(79,70,229,.5)';
    ctx.lineWidth = 1;
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    for (let k = 1; k < 9; k++) {
      const t = k / 9;
      const a = lerp(pts[0], pts[1], t), b = lerp(pts[3], pts[2], t), c = lerp(pts[0], pts[3], t), d = lerp(pts[1], pts[2], t);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#4f46e5'; ctx.stroke();
    }
  }
  function cropPoint(e) {
    const cv = $('crop-canvas'), r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width) / crop.scale, y: (e.clientY - r.top) * (cv.height / r.height) / crop.scale };
  }
  function initCropDrag() {
    const cv = $('crop-canvas');
    cv.addEventListener('pointerdown', e => {
      const p = cropPoint(e);
      let best = -1, bd = Infinity;
      crop.corners.forEach((c, k) => { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = k; } });
      const r = cv.getBoundingClientRect();
      if (bd * crop.scale * (r.width / cv.width) < 44) { crop.drag = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    cv.addEventListener('pointermove', e => {
      if (crop.drag < 0) return;
      const p = cropPoint(e);
      crop.corners[crop.drag] = { x: Math.max(0, Math.min(crop.img.width, p.x)), y: Math.max(0, Math.min(crop.img.height, p.y)) };
      drawCrop();
    });
    const end = () => { crop.drag = -1; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  async function readPhoto() {
    const btn = $('p-read'), status = $('ocr-status');
    if (!crop.gray || !crop.corners) return;
    btn.disabled = true;
    try {
      status.textContent = 'Reading digits…';
      await new Promise(r => setTimeout(r, 30)); // let the status show before the heavy work
      const grid = O.warp(crop.gray, crop.corners, 450);
      const res = await O.readDigits(grid);
      $('warp-canvas').getContext('2d').drawImage(O.grayToCanvas(grid), 0, 0);
      status.textContent = '';
      closeModals();
      loadGrid(res.digits, { unsure: res.unsure, photo: true });
      const n = res.digits.filter(Boolean).length;
      // Only repeat the grid check when it found a problem (clash, no solution, several solutions).
      const m = $('setup-msg'), problem = !m.classList.contains('hidden') && !m.classList.contains('ok');
      msg('setup-msg', problem ? 'bad' : res.unsure.size ? 'info' : 'ok',
        `<p>I read <b>${n} digits</b>${res.unsure.size ? `; check the ${res.unsure.size} in orange` : ''}.
         Compare with your photo (<b>Show photo</b>), fix anything that's off, then press <b>Start solving</b>.</p>` + (problem ? m.innerHTML : ''));
    } catch (e) {
      status.textContent = '';
      msg('new-msg', 'bad', `<p>${e.message || 'Reading the photo failed.'} You can still type the puzzle in.</p>`);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- app tabs ----------
  function showApp(which) {
    const play = which === 'play';
    closeModals();
    $('play-app').classList.toggle('hidden', !play);
    $('learn-app').classList.toggle('hidden', play);
    document.body.classList.toggle('play-mode', play);
    document.querySelectorAll('.app-tab').forEach(t => t.classList.toggle('active', t.dataset.app === which));
    if (play) startTimer(); else stopTimer();
    if (play) render();
  }

  // ---------- keyboard ----------
  function onKey(e) {
    if (!playVisible()) return;
    if (document.querySelector('.modal:not(.hidden)')) { if (e.key === 'Escape') closeModals(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'z') { e.shiftKey ? doRedo() : doUndo(); e.preventDefault(); return; }
    if (ctrl && k === 'y') { doRedo(); e.preventDefault(); return; }
    if (ctrl && k === 'a') { st.sel = new Set([...Array(81).keys()]); render(); e.preventDefault(); return; }
    const m = /^(Digit|Numpad)([0-9])$/.exec(e.code);
    if (m) {
      e.preventDefault();
      const d = +m[2];
      if (d === 0) { del(); return; }
      enter(d, e.shiftKey || ctrl ? 'centre' : null);
      return;
    }
    if (ctrl || e.altKey) return;
    switch (e.key) {
      case 'Backspace': case 'Delete': del(); e.preventDefault(); break;
      case 'ArrowUp': moveCursor(-1, 0, e.shiftKey); e.preventDefault(); break;
      case 'ArrowDown': moveCursor(1, 0, e.shiftKey); e.preventDefault(); break;
      case 'ArrowLeft': moveCursor(0, -1, e.shiftKey); e.preventDefault(); break;
      case 'ArrowRight': moveCursor(0, 1, e.shiftKey); e.preventDefault(); break;
      case 'Escape': st.sel.clear(); render(); break;
      case ' ': if (st.phase === 'play') setMode(MODES[(MODES.indexOf(st.mode) + 1) % MODES.length]); e.preventDefault(); break;
      default:
        if (k === 'z') setMode('normal');
        else if (k === 'c') setMode('centre');
        else if (k === 'v') setMode('colour');
    }
  }

  // ---------- wiring ----------
  function buildKeypad() {
    const pad = $('digits');
    for (let d = 1; d <= 9; d++) {
      const b = document.createElement('button');
      b.className = 'key-btn';
      b.dataset.d = d;
      b.innerHTML = `<span class="dg">${d}</span><span class="sw" style="background:${COLOURS[d]}"></span>`;
      b.addEventListener('click', () => enter(d, null));
      pad.appendChild(b);
    }
    // Keep the board selection when pressing panel buttons.
    document.querySelector('.play-controls').addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
  }

  function init() {
    buildKeypad();
    initBoardPointer();
    initCropDrag();
    document.querySelectorAll('.mode-btn[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('p-delete').addEventListener('click', del);
    $('p-undo').addEventListener('click', doUndo);
    $('p-redo').addEventListener('click', doRedo);
    $('p-restart').addEventListener('click', restart);
    $('p-check').addEventListener('click', check);
    $('p-pause').addEventListener('click', () => togglePause());
    $('p-resume').addEventListener('click', () => togglePause(false));
    $('p-start').addEventListener('click', startPlay);
    $('p-clear-board').addEventListener('click', () => loadGrid(blank()));
    $('p-fill').addEventListener('click', fillCandidates);
    $('p-clearmarks').addEventListener('click', clearMarks);
    $('p-hint').addEventListener('click', () => showStep('hint'));
    $('p-step').addEventListener('click', () => showStep('full'));
    $('p-apply').addEventListener('click', applyStep);
    $('p-solve').addEventListener('click', solveAll);
    $('p-new').addEventListener('click', openNew);
    $('p-settings').addEventListener('click', () => {
      document.querySelectorAll('[data-set]').forEach(c => { c.checked = !!settings[c.dataset.set]; });
      openModal('dlg-settings');
    });
    document.querySelectorAll('[data-set]').forEach(c => c.addEventListener('change', () => {
      settings[c.dataset.set] = c.checked;
      saveSettings();
      render();
    }));
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModals(); }));

    // new puzzle options
    for (const id of ['photo-input', 'camera-input']) {
      $(id).addEventListener('change', e => { onPhoto(e.target.files[0]); e.target.value = ''; });
    }
    $('p-photo-back').addEventListener('click', leavePhoto);
    $('p-photo-toggle').addEventListener('click', () => showPhotoOverlay($('photo-overlay').classList.contains('hidden')));
    $('photo-overlay').addEventListener('click', () => showPhotoOverlay(false));
    $('p-read').addEventListener('click', readPhoto);
    $('opt-type').addEventListener('click', () => {
      closeModals();
      loadGrid(blank());
      st.sel = new Set([0]); st.cursor = 0;
      render();
    });
    $('opt-paste').addEventListener('click', () => { $('crop-panel').classList.add('hidden'); $('paste-row').classList.remove('hidden'); $('paste-input').focus(); $('paste-row').scrollIntoView({ block: 'nearest' }); });
    $('paste-load').addEventListener('click', () => {
      const raw = $('paste-input').value.replace(/\s/g, '').replace(/[^0-9.]/g, '');
      if (raw.length !== 81) { msg('new-msg', 'bad', `<p>I need exactly 81 characters (digits, with 0 or . for blanks). Got ${raw.length}.</p>`); return; }
      closeModals();
      loadGrid(E.parse(raw.replace(/0/g, '.')));
      if (st.unique) startPlay();
    });
    $('paste-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('paste-load').click(); });
    document.querySelectorAll('.level-btn').forEach(b => b.addEventListener('click', () => newRandom(b.dataset.level)));

    document.querySelectorAll('.app-tab').forEach(t => t.addEventListener('click', () => showApp(t.dataset.app)));
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopTimer(); else startTimer(); });
    window.addEventListener('resize', () => { if (crop.img && !$('crop-panel').classList.contains('hidden')) drawCrop(); });
    setInterval(() => { $('timer').textContent = fmt(elapsedNow()); }, 500);

    // Every visit starts on the Play screen with a fresh Medium puzzle.
    const first = L.generateSync('medium');
    loadGrid(first.puzzle, { level: 'medium' });
    startPlay();
    showApp('play');
  }

  init();
})();
