// Difficulty levels: grade a puzzle by the hardest technique the step solver needs,
// and generate puzzles that land in a chosen level.
// Works in the browser (window.SudokuLevels) and in Node (module.exports).
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const L = factory(node ? require('./engine.js') : root.SudokuEngine, node ? require('./stepsolver.js') : root.StepSolver);
  if (node) module.exports = L;
  else root.SudokuLevels = L;
})(typeof self !== 'undefined' ? self : this, function (E, S) {
  'use strict';

  // Step levels (see stepsolver.js): 1-2 singles in a box/line, 3 naked single, 4 locked candidates,
  // 5-7 pairs/triples, 8-9 X-Wing/Y-Wing/turbot, 10+ Swordfish, XYZ/W-Wing, colouring, what-if.
  const LEVELS = {
    easy:   { name: 'Easy',   min: 0,  max: 2,  clues: 38 },
    medium: { name: 'Medium', min: 3,  max: 4,  clues: 30 },
    hard:   { name: 'Hard',   min: 5,  max: 9,  clues: 0 },
    expert: { name: 'Expert', min: 10, max: 99, clues: 0 },
  };

  function grade(puzzle) {
    const v = puzzle.slice(), c = S.legalCands(v);
    let max = 0;
    for (let n = 0; n < 600 && v.some(x => !x); n++) {
      const step = S.findStep(v, c);
      if (!step) return 99;
      max = Math.max(max, step.level || 0);
      S.applyStep(v, c, step);
    }
    return max;
  }

  // Add solution digits back (easier, never harder) while staying inside the level.
  function topUp(puzzle, solution, lv) {
    const p = puzzle.slice();
    let clues = p.filter(Boolean).length;
    for (const i of E.shuffle([...Array(81).keys()])) {
      if (clues >= lv.clues) break;
      if (p[i]) continue;
      p[i] = solution[i];
      if (grade(p) < lv.min) { p[i] = 0; continue; }
      clues++;
    }
    return p;
  }

  // Calls done({ puzzle, solution, level, grade }) when finished. Works in small chunks so the page stays responsive.
  function generate(levelId, done, budgetMs) {
    const lv = LEVELS[levelId] || LEVELS.medium;
    const deadline = Date.now() + (budgetMs || 6000);
    let best = null;
    function attempt() {
      const sliceEnd = Date.now() + 60;
      while (Date.now() < sliceEnd) {
        const r = E.generatePuzzle();
        const g = grade(r.puzzle);
        if (g >= lv.min && g <= lv.max) {
          done({ puzzle: topUp(r.puzzle, r.solution, lv), solution: r.solution, level: levelId, grade: g });
          return;
        }
        const miss = g < lv.min ? lv.min - g : g - lv.max;
        if (!best || miss < best.miss) best = { r, g, miss };
      }
      if (Date.now() < deadline) { setTimeout(attempt, 0); return; }
      // Out of time: use the closest puzzle found.
      done({ puzzle: topUp(best.r.puzzle, best.r.solution, lv), solution: best.r.solution, level: levelId, grade: best.g });
    }
    setTimeout(attempt, 0);
  }

  // Blocking version for page start-up, so the first board shown is already the right level.
  function generateSync(levelId, budgetMs) {
    const lv = LEVELS[levelId] || LEVELS.medium;
    const deadline = Date.now() + (budgetMs || 3000);
    let best = null;
    do {
      const r = E.generatePuzzle();
      const g = grade(r.puzzle);
      const miss = g < lv.min ? lv.min - g : g > lv.max ? g - lv.max : 0;
      if (!best || miss < best.miss) best = { r, g, miss };
      if (!miss) break;
    } while (Date.now() < deadline);
    return { puzzle: topUp(best.r.puzzle, best.r.solution, lv), solution: best.r.solution, level: levelId, grade: best.g };
  }

  return { LEVELS, grade, generate, generateSync };
});
