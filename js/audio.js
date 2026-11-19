// SKYSHOT — synthesized sound effects. No audio files, so nothing to license or load.
(function (global) {
  'use strict';

  let ctx = null;
  let master = null;
  let muted = false;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function tone(freq, dur, type, vol, slideTo) {
    if (muted || !ensure()) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.5, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  const Sfx = {
    unlock() { ensure(); },
    setMuted(v) { muted = !!v; },
    isMuted() { return muted; },
    hit(combo) {
      const step = Math.min(combo, 12);
      tone(520 + step * 45, 0.09, 'triangle', 0.5);
      tone(1040 + step * 90, 0.06, 'sine', 0.18);
    },
    gold() {
      tone(880, 0.08, 'square', 0.25);
      setTimeout(() => tone(1320, 0.14, 'triangle', 0.35), 60);
    },
    miss() { tone(180, 0.12, 'sawtooth', 0.18, 90); },
    escape() { tone(300, 0.15, 'sine', 0.15, 160); },
    tick() { tone(1200, 0.03, 'square', 0.08); },
    start() {
      tone(440, 0.1, 'triangle', 0.35);
      setTimeout(() => tone(660, 0.1, 'triangle', 0.35), 110);
      setTimeout(() => tone(990, 0.18, 'triangle', 0.4), 220);
    },
    end() {
      tone(990, 0.12, 'triangle', 0.35);
      setTimeout(() => tone(740, 0.12, 'triangle', 0.35), 130);
      setTimeout(() => tone(495, 0.3, 'triangle', 0.4), 260);
    },
    click() { tone(700, 0.04, 'square', 0.12); },
  };

  global.SkySfx = Sfx;
})(window);
