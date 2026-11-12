// Fireworks celebration: a full-screen canvas overlay with a "Solved!" banner.
// Usage: Fireworks.celebrate({ time: '4:32', onNew: () => {...} })
(function () {
  'use strict';
  const COLOURS = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb', '#ff9100', '#ffffff'];
  let active = null;

  function celebrate(opts) {
    stop();
    opts = opts || {};
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const wrap = document.createElement('div');
    wrap.className = 'fw-overlay';
    const canvas = document.createElement('canvas');
    canvas.className = 'fw-canvas';
    const card = document.createElement('div');
    card.className = 'fw-card';
    card.innerHTML = `<div class="fw-title">Solved!</div>
      ${opts.time ? `<div class="fw-time">${opts.level ? opts.level + ' · ' : ''}Time ${opts.time}</div>` : ''}
      <div class="fw-row">
        <button class="pbtn" data-fw="close">Close</button>
        ${opts.onNew ? '<button class="pbtn primary" data-fw="new">New puzzle</button>' : ''}
      </div>`;
    wrap.append(canvas, card);
    document.body.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    let W = 0, H = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const rockets = [], sparks = [];
    const start = performance.now();
    const LAUNCH_FOR = 3200;
    let nextLaunch = 0, raf = 0;

    function launch() {
      const x = W * (0.15 + Math.random() * 0.7);
      rockets.push({
        x, y: H, vx: (Math.random() - 0.5) * 1.5,
        vy: -(H * 0.011 + Math.random() * H * 0.004),
        targetY: H * (0.12 + Math.random() * 0.33),
        colour: COLOURS[(Math.random() * COLOURS.length) | 0],
      });
    }
    function explode(r) {
      const n = 55 + ((Math.random() * 30) | 0);
      const speed = Math.min(W, H) * 0.0105;
      const second = COLOURS[(Math.random() * COLOURS.length) | 0];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.2;
        const s = speed * (0.45 + Math.random() * 0.6);
        sparks.push({
          x: r.x, y: r.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
          life: 1, decay: 0.011 + Math.random() * 0.011,
          colour: Math.random() < 0.7 ? r.colour : second,
        });
      }
    }

    function frame(now) {
      const t = now - start;
      if (t < LAUNCH_FOR && now >= nextLaunch) {
        launch();
        if (Math.random() < 0.35) launch();
        nextLaunch = now + 260 + Math.random() * 260;
      }
      // fading trail: erase a little each frame instead of clearing fully
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.x += r.vx; r.y += r.vy; r.vy *= 0.985;
        ctx.fillStyle = r.colour;
        ctx.beginPath(); ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2); ctx.fill();
        if (r.y <= r.targetY || r.vy > -1) { explode(r); rockets.splice(i, 1); }
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.vx *= 0.975; p.vy = p.vy * 0.975 + 0.06;
        p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        if (p.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.colour;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.4 + p.life * 1.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (t < LAUNCH_FOR || rockets.length || sparks.length) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    if (!reduce) raf = requestAnimationFrame(frame);

    function close() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      wrap.remove();
      active = null;
    }
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-fw]');
      if (b && b.dataset.fw === 'new') { close(); opts.onNew(); return; }
      if (b || e.target === wrap || e.target === canvas) close();
    });
    active = { close };
  }

  function stop() { if (active) active.close(); }

  window.Fireworks = { celebrate, stop };
})();
