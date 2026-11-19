// SKYSHOT — a 45-second flick-and-click aim trainer built for event booths.
// One canvas, one animation loop, and every input handler is attached once at boot.
// Each round builds a fresh state object, so nothing from the last player carries over.

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const CFG = {
    roundSeconds: clampNum(params.get('round'), 5, 300, 45),
    countdownSeconds: 3,
    resultsIdleSeconds: clampNum(params.get('idle'), 3, 120, 25),        // initials picker auto-saves after this
    returnToAttractSeconds: clampNum(params.get('return'), 2, 120, 9),   // after saving, back to the attract screen
    inputGuardMs: 1200,          // ignore stray clicks right after a screen change
    leaderboardSize: 10,
    testMode: params.get('test') === '1',
  };

  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  const Store = window.SkyStore;
  const Sfx = window.SkySfx;

  // ---------- canvas ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1, UNIT = 1; // UNIT scales sizes with screen
  let skyLayer = null;                 // pre-rendered background

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    UNIT = Math.min(W, H) / 900;
    buildSky();
  }

  // Deterministic pseudo-random for the background, so it looks the same every load.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildSky() {
    skyLayer = document.createElement('canvas');
    skyLayer.width = canvas.width;
    skyLayer.height = canvas.height;
    const s = skyLayer.getContext('2d');
    s.setTransform(DPR, 0, 0, DPR, 0, 0);

    const g = s.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#060b1f');
    g.addColorStop(0.45, '#0d2350');
    g.addColorStop(0.78, '#1d5f9e');
    g.addColorStop(1, '#5fb7e5');
    s.fillStyle = g;
    s.fillRect(0, 0, W, H);

    const rnd = mulberry32(9);
    for (let i = 0; i < 160; i++) {
      const x = rnd() * W, y = rnd() * H * 0.6;
      const a = 0.15 + rnd() * 0.6 * (1 - y / (H * 0.6));
      s.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      const r = rnd() < 0.08 ? 1.6 : 0.9;
      s.fillRect(x, y, r, r);
    }

    // soft horizon glow
    const hg = s.createRadialGradient(W * 0.5, H * 1.05, 10, W * 0.5, H * 1.05, Math.max(W, H) * 0.7);
    hg.addColorStop(0, 'rgba(160,230,255,0.35)');
    hg.addColorStop(1, 'rgba(160,230,255,0)');
    s.fillStyle = hg;
    s.fillRect(0, 0, W, H);
  }

  // Cloud bands drift at different speeds for depth.
  const clouds = [];
  function seedClouds() {
    clouds.length = 0;
    const rnd = mulberry32(42);
    for (let i = 0; i < 9; i++) {
      const depth = 0.3 + rnd() * 0.7;
      const puffs = [];
      const n = 5 + Math.floor(rnd() * 5);
      for (let p = 0; p < n; p++) puffs.push({ dx: p * 38 + rnd() * 20, dy: rnd() * 18 - 9, r: 24 + rnd() * 30 });
      clouds.push({ x: rnd(), y: 0.55 + rnd() * 0.45, depth, puffs });
    }
  }

  function drawClouds(time) {
    for (const c of clouds) {
      const span = W + 600 * UNIT;
      const x = ((c.x * span + time * 12 * c.depth) % span) - 300 * UNIT;
      const y = c.y * H;
      ctx.fillStyle = `rgba(220,240,255,${(0.05 + 0.09 * c.depth).toFixed(3)})`;
      ctx.beginPath();
      for (const p of c.puffs) {
        const r = p.r * UNIT * (0.7 + c.depth);
        ctx.moveTo(x + p.dx * UNIT + r, y + p.dy * UNIT);
        ctx.arc(x + p.dx * UNIT, y + p.dy * UNIT, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // ---------- pools ----------
  const MAX_PARTICLES = 320;
  const particles = new Array(MAX_PARTICLES).fill(null).map(() => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, color: '#fff', size: 2 }));
  const MAX_FLOATERS = 40;
  const floaters = new Array(MAX_FLOATERS).fill(null).map(() => ({ alive: false, x: 0, y: 0, text: '', life: 0, color: '#fff' }));

  function clearPools() {
    for (const p of particles) p.alive = false;
    for (const f of floaters) f.alive = false;
  }

  function burst(x, y, color, count) {
    let made = 0;
    for (const p of particles) {
      if (made >= count) break;
      if (p.alive) continue;
      const a = Math.random() * Math.PI * 2;
      const sp = (120 + Math.random() * 380) * UNIT;
      p.alive = true; p.x = x; p.y = y;
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = 0; p.max = 0.35 + Math.random() * 0.4;
      p.color = color; p.size = (1.5 + Math.random() * 3) * UNIT;
      made++;
    }
  }

  function floatText(x, y, text, color) {
    for (const f of floaters) {
      if (f.alive) continue;
      f.alive = true; f.x = x; f.y = y; f.text = text; f.life = 0; f.color = color;
      return;
    }
  }

  // ---------- state ----------
  let state = null;
  let screenChangedAt = 0;
  const pointer = { x: -100, y: -100, seen: false };

  function freshRoundState() {
    return {
      mode: 'countdown',
      t: 0,                // seconds into the current mode
      playT: 0,            // seconds of actual play
      targets: [],
      nextSpawn: 0.25,
      nextId: 1,
      score: 0,
      shots: 0,
      hits: 0,
      escapes: 0,
      combo: 0,
      bestCombo: 0,
      reactionSum: 0,
      lastTick: CFG.countdownSeconds + 1,
      // results
      result: null,
      initials: [0, 0, 0],
      initialsCol: 0,
      saved: false,
      savedRank: 0,
      savedAt: 0,
    };
  }

  function toAttract() {
    state = { mode: 'attract', t: 0, demo: [] };
    clearPools();
    screenChangedAt = performance.now();
    refreshBoard();
  }

  function startRound() {
    state = freshRoundState();
    clearPools();
    screenChangedAt = performance.now();
    Sfx.start();
  }

  // ---------- difficulty ----------
  function difficulty(progress) {
    const p = Math.max(0, Math.min(1, progress));
    const ease = p * p * (3 - 2 * p);
    return {
      spawnEvery: lerp(0.85, 0.40, ease),
      maxAlive: Math.round(lerp(2, 5, ease)),
      radius: lerp(46, 25, ease) * UNIT,
      life: lerp(2.2, 1.15, ease),
      moveChance: lerp(0.0, 0.5, ease),
      speed: lerp(90, 270, ease) * UNIT,
      goldChance: 0.06,
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function spawnTarget(d) {
    const margin = 70 * UNIT;
    const topSafe = 90 * UNIT; // keep clear of the HUD
    let x = 0, y = 0, ok = false;
    for (let tries = 0; tries < 12 && !ok; tries++) {
      x = margin + Math.random() * (W - margin * 2);
      y = topSafe + margin + Math.random() * (H - topSafe - margin * 2);
      ok = true;
      for (const t of state.targets) {
        if (Math.hypot(t.x - x, t.y - y) < (t.r + d.radius) * 2.2) { ok = false; break; }
      }
      // force a flick: avoid spawning right under the cursor
      if (ok && pointer.seen && Math.hypot(pointer.x - x, pointer.y - y) < 140 * UNIT) ok = false;
    }
    const gold = Math.random() < d.goldChance;
    const moving = !gold && Math.random() < d.moveChance;
    const ang = Math.random() * Math.PI * 2;
    state.targets.push({
      id: state.nextId++,
      x, y,
      r: gold ? d.radius * 0.8 : d.radius,
      life: gold ? d.life * 0.75 : d.life,
      age: 0,
      gold,
      vx: moving ? Math.cos(ang) * d.speed : 0,
      vy: moving ? Math.sin(ang) * d.speed : 0,
      pop: 0,
    });
  }

  // ---------- scoring ----------
  function multiplier(combo) {
    return Math.min(4, 1 + Math.floor(combo / 5) * 0.5);
  }

  function registerHit(t) {
    state.hits++;
    state.combo++;
    state.bestCombo = Math.max(state.bestCombo, state.combo);
    state.reactionSum += t.age;
    const speedBonus = Math.round(100 * Math.max(0, 1 - t.age / t.life));
    const base = 100 + speedBonus;
    const pts = Math.round(base * multiplier(state.combo) * (t.gold ? 3 : 1));
    state.score += pts;
    const color = t.gold ? '#ffd65a' : '#7fe7ff';
    burst(t.x, t.y, color, t.gold ? 40 : 22);
    floatText(t.x, t.y - t.r, '+' + pts, color);
    if (t.gold) Sfx.gold(); else Sfx.hit(state.combo);
  }

  function registerMiss(x, y) {
    if (state.combo >= 5) floatText(x, y, 'COMBO LOST', '#ff7a8a');
    state.combo = 0;
    burst(x, y, 'rgba(255,255,255,0.5)', 5);
    Sfx.miss();
  }

  function finishRound() {
    const accuracy = state.shots ? Math.round((state.hits / state.shots) * 100) : 0;
    const reaction = state.hits ? Math.round((state.reactionSum / state.hits) * 1000) : 0;
    const rank = Store.rankFor(state.score, accuracy);
    state.result = { score: state.score, accuracy, reaction, combo: state.bestCombo, hits: state.hits, shots: state.shots, rank };
    state.mode = 'results';
    state.t = 0;
    state.targets.length = 0;
    clearPools(); // no stray "+points" text drifting over the results screen
    screenChangedAt = performance.now();
    Sfx.end();
    // A run that does not make today's top list is still logged for the CSV export.
    if (rank > CFG.leaderboardSize) saveResult('---');
  }

  function saveResult(name) {
    if (state.saved) return;
    const r = state.result;
    const stored = Store.add({ name, score: r.score, accuracy: r.accuracy, reaction: r.reaction, combo: r.combo });
    state.saved = true;
    state.savedName = stored.name; // shows the filtered name if initials were swapped
    state.savedRank = Store.rankFor(r.score + 0.5, r.accuracy); // position just saved
    state.savedRank = Math.max(1, state.savedRank);
    state.savedAt = state.t;
    refreshBoard();
  }

  // ---------- leaderboard cache (avoid parsing localStorage every frame) ----------
  let boardCache = [];
  let bestCache = null;
  function refreshBoard() {
    boardCache = Store.top(CFG.leaderboardSize);
    bestCache = Store.allTimeBest();
  }
  Store.subscribe(refreshBoard);

  // ---------- input ----------
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let uiButtons = []; // rebuilt every frame for the screens that have buttons

  function guardActive() {
    return performance.now() - screenChangedAt < CFG.inputGuardMs;
  }

  function onPointerDown(ev) {
    Sfx.unlock();
    pointer.x = ev.clientX; pointer.y = ev.clientY; pointer.seen = true;
    if (!state) return;

    if (state.mode === 'attract') {
      if (guardActive()) return;
      startRound();
      return;
    }

    if (state.mode === 'play') {
      state.shots++;
      let best = null, bestD = Infinity;
      for (const t of state.targets) {
        const d = Math.hypot(t.x - ev.clientX, t.y - ev.clientY);
        if (d <= t.r * 1.08 && d < bestD) { best = t; bestD = d; }
      }
      if (best) {
        registerHit(best);
        state.targets.splice(state.targets.indexOf(best), 1);
      } else {
        registerMiss(ev.clientX, ev.clientY);
      }
      return;
    }

    if (state.mode === 'results') {
      if (guardActive()) return;
      for (const b of uiButtons) {
        if (ev.clientX >= b.x && ev.clientX <= b.x + b.w && ev.clientY >= b.y && ev.clientY <= b.y + b.h) {
          Sfx.click();
          b.action();
          return;
        }
      }
    }
  }

  function onPointerMove(ev) {
    pointer.x = ev.clientX; pointer.y = ev.clientY; pointer.seen = true;
  }

  let clearArmedAt = 0;
  function onKeyDown(ev) {
    const k = ev.key;

    // ---- staff controls ----
    if (ev.ctrlKey && ev.shiftKey && (k === 'E' || k === 'e')) { ev.preventDefault(); downloadCSV(); return; }
    if (ev.ctrlKey && ev.shiftKey && (k === 'X' || k === 'x')) {
      ev.preventDefault();
      const now = performance.now();
      if (now - clearArmedAt < 3000) { Store.clearToday(); refreshBoard(); toast('Today\'s leaderboard cleared'); clearArmedAt = 0; }
      else { clearArmedAt = now; toast('Press Ctrl+Shift+X again within 3s to clear today'); }
      return;
    }
    if (k === 'f' || k === 'F') { toggleFullscreen(); return; }
    if (k === 'm' || k === 'M') { Sfx.setMuted(!Sfx.isMuted()); toast(Sfx.isMuted() ? 'Sound off' : 'Sound on'); return; }
    if (k === 'l' || k === 'L') { window.open('leaderboard.html', 'skyshot-board'); return; }
    if (k === 'Escape' && state && state.mode !== 'attract') { toAttract(); return; }

    // ---- player keys (optional: arrow keys work on the initials picker) ----
    if (!state) return;
    if (state.mode === 'attract' && (k === ' ' || k === 'Enter') && !guardActive()) { startRound(); return; }
    if (state.mode === 'results' && !state.saved && state.result.rank <= CFG.leaderboardSize && !guardActive()) {
      if (k === 'ArrowUp') cycleLetter(state.initialsCol, -1);
      else if (k === 'ArrowDown') cycleLetter(state.initialsCol, 1);
      else if (k === 'ArrowLeft') state.initialsCol = Math.max(0, state.initialsCol - 1);
      else if (k === 'ArrowRight') state.initialsCol = Math.min(2, state.initialsCol + 1);
      else if (k === 'Enter') saveInitials();
      state.t = Math.min(state.t, 1.5); // any input restarts the idle timer
    } else if (state.mode === 'results' && state.saved && (k === ' ' || k === 'Enter') && !guardActive()) {
      startRound();
    }
  }

  function cycleLetter(col, dir) {
    state.initials[col] = (state.initials[col] + dir + LETTERS.length) % LETTERS.length;
    state.initialsCol = col;
    state.t = Math.min(state.t, 1.5);
  }

  function initialsString() {
    return state.initials.map(i => LETTERS[i]).join('');
  }

  function saveInitials() {
    saveResult(initialsString());
    screenChangedAt = performance.now();
  }

  function downloadCSV() {
    const blob = new Blob([Store.exportCSV()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `skyshot-scores-${Store.dayKey()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Scores exported');
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }

  let toastText = '', toastUntil = 0;
  function toast(t) { toastText = t; toastUntil = performance.now() + 2200; }

  // ---------- update ----------
  function update(dt) {
    state.t += dt;

    if (state.mode === 'attract') {
      if (state.demo.length < 3 && Math.random() < dt * 1.2) {
        const side = Math.random() < 0.5 ? 0 : 1; // keep demo orbs beside the leaderboard panel
        state.demo.push({ x: side ? W * (0.76 + Math.random() * 0.18) : W * (0.06 + Math.random() * 0.18), y: H * 0.5 + Math.random() * H * 0.38, r: (26 + Math.random() * 16) * UNIT, age: 0, life: 2.4 });
      }
      for (let i = state.demo.length - 1; i >= 0; i--) {
        state.demo[i].age += dt;
        if (state.demo[i].age > state.demo[i].life) state.demo.splice(i, 1);
      }
    } else if (state.mode === 'countdown') {
      const left = Math.ceil(CFG.countdownSeconds - state.t);
      if (left < state.lastTick && left > 0) { state.lastTick = left; Sfx.tick(); }
      if (state.t >= CFG.countdownSeconds) { state.mode = 'play'; state.t = 0; }
    } else if (state.mode === 'play') {
      state.playT += dt;
      const d = difficulty(state.playT / CFG.roundSeconds);
      state.nextSpawn -= dt;
      if (state.nextSpawn <= 0 && state.targets.length < d.maxAlive) {
        spawnTarget(d);
        state.nextSpawn = d.spawnEvery * (0.75 + Math.random() * 0.5);
      }
      const topSafe = 90 * UNIT;
      for (let i = state.targets.length - 1; i >= 0; i--) {
        const t = state.targets[i];
        t.age += dt;
        t.pop = Math.min(1, t.pop + dt * 8);
        if (t.vx || t.vy) {
          t.x += t.vx * dt; t.y += t.vy * dt;
          if (t.x < t.r || t.x > W - t.r) { t.vx *= -1; t.x = Math.max(t.r, Math.min(W - t.r, t.x)); }
          if (t.y < topSafe + t.r || t.y > H - t.r) { t.vy *= -1; t.y = Math.max(topSafe + t.r, Math.min(H - t.r, t.y)); }
        }
        if (t.age >= t.life) {
          state.targets.splice(i, 1);
          state.escapes++;
          if (state.combo >= 5) floatText(t.x, t.y, 'COMBO LOST', '#ff7a8a');
          state.combo = 0;
          Sfx.escape();
        }
      }
      const left = Math.ceil(CFG.roundSeconds - state.playT);
      if (left <= 5 && left < state.lastTick && left > 0) { state.lastTick = left; Sfx.tick(); }
      if (state.playT >= CFG.roundSeconds) finishRound();
    } else if (state.mode === 'results') {
      const qualifies = state.result.rank <= CFG.leaderboardSize;
      if (qualifies && !state.saved && state.t >= CFG.resultsIdleSeconds) saveInitials();
      if (state.saved && state.t - state.savedAt >= CFG.returnToAttractSeconds) toAttract();
    }

    for (const p of particles) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.max) { p.alive = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.92; p.vy = p.vy * 0.92 + 260 * UNIT * dt;
    }
    for (const f of floaters) {
      if (!f.alive) continue;
      f.life += dt;
      f.y -= 60 * UNIT * dt;
      if (f.life > 0.9) f.alive = false;
    }
  }

  // ---------- render ----------
  const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
  function font(px, weight) { return `${weight || 700} ${Math.round(px * UNIT)}px ${FONT}`; }

  function render(time) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(skyLayer, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawClouds(time);

    uiButtons = [];
    if (state.mode === 'attract') renderAttract(time);
    else if (state.mode === 'countdown') { renderHUD(); renderCountdown(); }
    else if (state.mode === 'play') { renderTargets(); renderHUD(); }
    else if (state.mode === 'results') renderResults(time);

    renderParticles();
    renderCrosshair();
    renderToast();
  }

  function orb(x, y, r, lifeFrac, gold, alpha) {
    const a = alpha == null ? 1 : alpha;
    const core = gold ? '255,214,90' : '127,231,255';
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.6);
    glow.addColorStop(0, `rgba(${core},${0.35 * a})`);
    glow.addColorStop(1, `rgba(${core},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = `rgba(8,20,48,${0.75 * a})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();

    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.strokeStyle = `rgba(${core},${0.95 * a})`;
    ctx.beginPath(); ctx.arc(x, y, r * 0.86, 0, Math.PI * 2); ctx.stroke();

    // remaining-life arc
    ctx.lineWidth = Math.max(2, r * 0.1);
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * a})`;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - lifeFrac));
    ctx.stroke();

    ctx.fillStyle = `rgba(${core},${a})`;
    ctx.beginPath(); ctx.arc(x, y, r * 0.28, 0, Math.PI * 2); ctx.fill();

    if (gold) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(performance.now() / 600);
      ctx.strokeStyle = `rgba(255,240,180,${0.9 * a})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath(); ctx.moveTo(r * 1.25, 0); ctx.lineTo(r * 1.5, 0); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function renderTargets() {
    for (const t of state.targets) {
      const s = easeOutBack(t.pop);
      const frac = t.age / t.life;
      const fade = frac > 0.8 ? 1 - (frac - 0.8) / 0.2 * 0.6 : 1;
      orb(t.x, t.y, t.r * s, frac, t.gold, fade);
    }
  }

  function easeOutBack(x) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  function panel(x, y, w, h, r) {
    ctx.fillStyle = 'rgba(6,14,36,0.62)';
    ctx.strokeStyle = 'rgba(127,231,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r || 14 * UNIT);
    ctx.fill(); ctx.stroke();
  }

  function renderHUD() {
    const pad = 24 * UNIT;
    const h = 64 * UNIT;
    panel(pad, pad * 0.6, W - pad * 2, h);
    const cy = pad * 0.6 + h / 2;
    ctx.textBaseline = 'middle';

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = font(34, 800);
    ctx.fillText(String(state.score).padStart(6, '0'), pad * 2, cy);

    const timeLeft = state.mode === 'play' ? Math.max(0, CFG.roundSeconds - state.playT) : CFG.roundSeconds;
    ctx.textAlign = 'center';
    ctx.fillStyle = timeLeft <= 5 && state.mode === 'play' ? '#ff7a8a' : '#ffffff';
    ctx.font = font(38, 800);
    ctx.fillText(timeLeft.toFixed(1) + 's', W / 2, cy);

    ctx.textAlign = 'right';
    const m = multiplier(state.combo);
    ctx.fillStyle = m > 1 ? '#ffd65a' : 'rgba(255,255,255,0.75)';
    ctx.font = font(24, 800);
    const acc = state.shots ? Math.round(state.hits / state.shots * 100) : 100;
    ctx.fillText(`COMBO ${state.combo}  ×${m.toFixed(1)}   ACC ${acc}%`, W - pad * 2, cy);

    // timer bar
    const frac = timeLeft / CFG.roundSeconds;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(pad, pad * 0.6 + h + 6 * UNIT, W - pad * 2, 4 * UNIT);
    ctx.fillStyle = timeLeft <= 5 ? '#ff7a8a' : '#7fe7ff';
    ctx.fillRect(pad, pad * 0.6 + h + 6 * UNIT, (W - pad * 2) * frac, 4 * UNIT);
  }

  function renderCountdown() {
    const left = Math.ceil(CFG.countdownSeconds - state.t);
    const phase = 1 - ((CFG.countdownSeconds - state.t) % 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 1 - phase * 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.font = font(220 * (1 + phase * 0.25), 900);
    ctx.fillText(String(Math.max(1, left)), W / 2, H / 2);
    ctx.globalAlpha = 1;
    ctx.font = font(26, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('Click the orbs before they fade. Gold ones are worth triple.', W / 2, H / 2 + 170 * UNIT);
  }

  function renderAttract(time) {
    for (const d of state.demo) orb(d.x, d.y, d.r * easeOutBack(Math.min(1, d.age * 6)), d.age / d.life, false, 0.55);

    const bob = Math.sin(time * 1.6) * 6 * UNIT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(127,231,255,0.8)';
    ctx.shadowBlur = 30 * UNIT;
    ctx.font = font(150, 900);
    ctx.fillText('SKYSHOT', W / 2, H * 0.24 + bob);
    ctx.shadowBlur = 0;

    ctx.font = font(30, 600);
    ctx.fillStyle = '#7fe7ff';
    ctx.fillText('FLICK  •  CLICK  •  CLIMB', W / 2, H * 0.24 + 100 * UNIT);

    const pulse = 0.55 + 0.45 * Math.sin(time * 4);
    ctx.globalAlpha = pulse;
    ctx.font = font(40, 800);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('CLICK ANYWHERE TO PLAY', W / 2, H * 0.24 + 175 * UNIT);
    ctx.globalAlpha = 1;
    ctx.font = font(20, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(`${CFG.roundSeconds} SECONDS  •  MOUSE ONLY  •  NO TUTORIAL NEEDED`, W / 2, H * 0.24 + 220 * UNIT);

    renderBoardPanel(W / 2 - 260 * UNIT, H * 0.24 + 260 * UNIT, 520 * UNIT, 5);
  }

  function renderBoardPanel(x, y, w, rows) {
    const rowH = 38 * UNIT;
    const h = 64 * UNIT + rows * rowH;
    if (y + h > H - 10 * UNIT) return; // small screens: skip rather than overflow
    panel(x, y, w, h);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = font(22, 800);
    ctx.fillStyle = '#7fe7ff';
    ctx.fillText("TODAY'S TOP PILOTS", x + w / 2, y + 30 * UNIT);
    const list = boardCache.slice(0, rows);
    for (let i = 0; i < rows; i++) {
      const ry = y + 64 * UNIT + i * rowH + rowH / 2 - 6 * UNIT;
      const e = list[i];
      ctx.font = font(24, 700);
      ctx.fillStyle = i === 0 ? '#ffd65a' : '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}.`, x + 30 * UNIT, ry);
      ctx.fillText(e ? e.name : '---', x + 90 * UNIT, ry);
      ctx.textAlign = 'right';
      ctx.fillText(e ? String(e.score) : '—', x + w - 30 * UNIT, ry);
    }
  }

  function button(x, y, w, h, label, action, opts) {
    const o = opts || {};
    const hover = pointer.x >= x && pointer.x <= x + w && pointer.y >= y && pointer.y <= y + h;
    ctx.fillStyle = o.primary ? (hover ? '#9ff0ff' : '#7fe7ff') : (hover ? 'rgba(127,231,255,0.25)' : 'rgba(127,231,255,0.12)');
    ctx.strokeStyle = '#7fe7ff';
    ctx.lineWidth = o.active ? 3 : 1.5;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 12 * UNIT); ctx.fill(); ctx.stroke();
    ctx.fillStyle = o.primary ? '#06122e' : '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = font(o.size || 28, 800);
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    uiButtons.push({ x, y, w, h, action });
  }

  function renderResults(time) {
    const r = state.result;
    const qualifies = r.rank <= CFG.leaderboardSize;
    const cx = W / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    ctx.font = font(30, 700);
    ctx.fillStyle = '#7fe7ff';
    ctx.fillText(qualifies ? (r.rank === 1 ? "NEW #1 TODAY!" : `TODAY'S TOP ${CFG.leaderboardSize}! RANK #${r.rank}`) : 'ROUND OVER', cx, H * 0.12);

    ctx.font = font(130, 900);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(127,231,255,0.7)'; ctx.shadowBlur = 24 * UNIT;
    ctx.fillText(String(r.score), cx, H * 0.24);
    ctx.shadowBlur = 0;

    const stats = [
      ['ACCURACY', r.accuracy + '%'],
      ['AVG REACTION', r.reaction ? r.reaction + ' ms' : '—'],
      ['BEST COMBO', String(r.combo)],
      ['ORBS HIT', String(r.hits)],
    ];
    const colW = Math.min(220 * UNIT, W / 4.4);
    stats.forEach((s, i) => {
      const x = cx + (i - 1.5) * colW;
      ctx.font = font(18, 700); ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(s[0], x, H * 0.36);
      ctx.font = font(36, 800); ctx.fillStyle = '#ffffff';
      ctx.fillText(s[1], x, H * 0.36 + 40 * UNIT);
    });

    const by = H * 0.52;
    if (qualifies && !state.saved) {
      ctx.font = font(24, 700); ctx.fillStyle = '#ffffff';
      ctx.fillText('ENTER YOUR INITIALS', cx, by);
      const boxW = 96 * UNIT, gap = 26 * UNIT, arrowH = 54 * UNIT, letterH = 96 * UNIT;
      const startX = cx - (boxW * 3 + gap * 2) / 2;
      for (let c = 0; c < 3; c++) {
        const x = startX + c * (boxW + gap);
        const col = c;
        button(x, by + 30 * UNIT, boxW, arrowH, '▲', () => cycleLetter(col, -1), { size: 26 });
        // letter box
        ctx.fillStyle = 'rgba(6,14,36,0.75)';
        ctx.strokeStyle = state.initialsCol === c ? '#ffd65a' : 'rgba(127,231,255,0.5)';
        ctx.lineWidth = state.initialsCol === c ? 3 : 1.5;
        ctx.beginPath(); ctx.roundRect(x, by + 30 * UNIT + arrowH + 8 * UNIT, boxW, letterH, 12 * UNIT); ctx.fill(); ctx.stroke();
        ctx.font = font(64, 900); ctx.fillStyle = '#ffffff';
        ctx.fillText(LETTERS[state.initials[c]], x + boxW / 2, by + 30 * UNIT + arrowH + 8 * UNIT + letterH / 2 + 2);
        button(x, by + 30 * UNIT + arrowH + letterH + 16 * UNIT, boxW, arrowH, '▼', () => cycleLetter(col, 1), { size: 26 });
      }
      const saveY = by + 30 * UNIT + arrowH * 2 + letterH + 34 * UNIT;
      button(cx - 150 * UNIT, saveY, 300 * UNIT, 66 * UNIT, 'SAVE SCORE', saveInitials, { primary: true, size: 30 });
      const left = Math.max(0, Math.ceil(CFG.resultsIdleSeconds - state.t));
      ctx.font = font(16, 600); ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`auto-saves in ${left}s`, cx, saveY + 90 * UNIT);
    } else {
      if (state.saved && qualifies) {
        ctx.font = font(30, 800); ctx.fillStyle = '#ffd65a';
        ctx.fillText(`${state.savedName}  saved at #${Math.min(state.savedRank, r.rank)} today`, cx, by);
      } else {
        ctx.font = font(24, 700); ctx.fillStyle = 'rgba(255,255,255,0.8)';
        const need = boardCache[CFG.leaderboardSize - 1];
        ctx.fillText(need ? `Top ${CFG.leaderboardSize} needs ${need.score + 1}. One more run?` : 'Nice run!', cx, by);
      }
      button(cx - 170 * UNIT, by + 50 * UNIT, 340 * UNIT, 74 * UNIT, 'PLAY AGAIN', startRound, { primary: true, size: 32 });
      const left = Math.max(0, Math.ceil(CFG.returnToAttractSeconds - (state.t - state.savedAt)));
      ctx.font = font(16, 600); ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`next player in ${left}s`, cx, by + 150 * UNIT);
    }
  }

  function renderParticles() {
    for (const p of particles) {
      if (!p.alive) continue;
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of floaters) {
      if (!f.alive) continue;
      ctx.globalAlpha = 1 - f.life / 0.9;
      ctx.font = font(26, 900);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  function renderCrosshair() {
    if (!pointer.seen) return;
    const x = pointer.x, y = pointer.y, r = 14 * UNIT;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(x - r * 0.4, y);
    ctx.moveTo(x + r * 0.4, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y - r * 0.4);
    ctx.moveTo(x, y + r * 0.4); ctx.lineTo(x, y + r);
    ctx.stroke();
    ctx.fillStyle = '#7fe7ff';
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }

  function renderToast() {
    if (performance.now() > toastUntil) return;
    ctx.font = font(18, 700);
    const w = ctx.measureText(toastText).width + 40 * UNIT;
    panel(W / 2 - w / 2, H - 70 * UNIT, w, 44 * UNIT, 10 * UNIT);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(toastText, W / 2, H - 48 * UNIT);
  }

  // ---------- loop ----------
  const frameTimes = new Float32Array(600);
  let frameIdx = 0, frameCount = 0;
  let last = performance.now();
  const bootAt = last;

  function loop(now) {
    const raw = (now - last) / 1000;
    last = now;
    frameTimes[frameIdx] = raw * 1000;
    frameIdx = (frameIdx + 1) % frameTimes.length;
    frameCount++;
    const dt = Math.min(raw, 1 / 20); // clamp: a hitch never teleports targets
    update(dt);
    render((now - bootAt) / 1000);
    requestAnimationFrame(loop);
  }

  // ---------- boot ----------
  window.addEventListener('resize', resize);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  resize();
  seedClouds();
  toAttract();
  requestAnimationFrame(loop);

  // Read-only hooks for the automated soak test (tests/soak_test.py). Only exposed with ?test=1.
  if (CFG.testMode) {
    window.__SKYSHOT__ = {
      mode: () => state.mode,
      snapshot: () => ({
        mode: state.mode,
        score: state.score || 0,
        shots: state.shots || 0,
        hits: state.hits || 0,
        combo: state.combo || 0,
        targets: (state.targets || []).map(t => ({ x: t.x, y: t.y, r: t.r })),
        liveParticles: particles.filter(p => p.alive).length,
        liveFloaters: floaters.filter(f => f.alive).length,
        result: state.result || null,
        saved: !!state.saved,
      }),
      frameStats: () => {
        const n = Math.min(frameCount, frameTimes.length);
        const arr = Array.from(frameTimes.slice(0, n)).sort((a, b) => a - b);
        const pick = (q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] || 0;
        return { samples: n, p50: pick(0.5), p95: pick(0.95), max: arr[arr.length - 1] || 0 };
      },
      config: () => ({ ...CFG }),
    };
  }
})();
