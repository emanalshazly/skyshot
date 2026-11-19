// SKYSHOT — offline leaderboard store.
// Everything lives in localStorage, so the booth works with no network at all.
// Scores are bucketed by the booth machine's local calendar day.

(function (global) {
  'use strict';

  const KEY_PREFIX = 'skyshot.scores.';
  const ALLTIME_KEY = 'skyshot.alltime';
  const CHANNEL_NAME = 'skyshot-leaderboard';
  const MAX_PER_DAY = 500;

  function dayKey(date) {
    const d = date || new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function safeRead(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function safeWrite(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  let channel = null;
  try {
    if ('BroadcastChannel' in global) channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) {
    channel = null;
  }

  // Public screen at a family event: swap obvious rude initials for a neutral tag.
  const BLOCKED = new Set(['ASS', 'FUK', 'FUC', 'FCK', 'SHT', 'SEX', 'DIK', 'DIC', 'COK', 'CUM', 'TIT', 'FAG', 'NIG', 'KKK', 'WTF', 'STFU', 'PIS', 'POO', 'GAY', 'JEW', 'NAZ', 'HOE', 'XXX', 'KYS']);
  function cleanName(raw) {
    const n = String(raw || '---').toUpperCase().replace(/[^A-Z0-9?\-]/g, '').slice(0, 3).padEnd(3, '-');
    return BLOCKED.has(n) ? 'C9?' : n;
  }

  function byScore(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return a.at - b.at; // earlier run wins a full tie
  }

  const Store = {
    dayKey,

    today() {
      const list = safeRead(KEY_PREFIX + dayKey(), []);
      return Array.isArray(list) ? list.slice().sort(byScore) : [];
    },

    top(n) {
      return this.today().slice(0, n);
    },

    allTimeBest() {
      return safeRead(ALLTIME_KEY, null);
    },

    // Where a score would land today (1-based), before saving it.
    rankFor(score, accuracy) {
      const probe = { score, accuracy: accuracy || 0, at: Date.now() };
      const list = this.today();
      let rank = 1;
      for (const e of list) {
        if (byScore(e, probe) < 0) rank++;
      }
      return rank;
    },

    add(entry) {
      const clean = {
        name: cleanName(entry.name),
        score: Math.max(0, Math.round(Number(entry.score) || 0)),
        accuracy: Math.max(0, Math.min(100, Math.round(Number(entry.accuracy) || 0))),
        reaction: Math.max(0, Math.round(Number(entry.reaction) || 0)),
        combo: Math.max(0, Math.round(Number(entry.combo) || 0)),
        at: Date.now(),
      };
      // All-time best is written first, so any listener woken by the score write sees both.
      const best = this.allTimeBest();
      if (!best || byScore(clean, best) < 0) safeWrite(ALLTIME_KEY, clean);

      const key = KEY_PREFIX + dayKey();
      const list = safeRead(key, []);
      const next = Array.isArray(list) ? list : [];
      next.push(clean);
      next.sort(byScore);
      if (next.length > MAX_PER_DAY) next.length = MAX_PER_DAY;
      safeWrite(key, next);

      this.notify();
      return clean;
    },

    clearToday() {
      try { global.localStorage.removeItem(KEY_PREFIX + dayKey()); } catch (e) { /* ignore */ }
      this.notify();
    },

    exportCSV() {
      const rows = [['date', 'rank', 'name', 'score', 'accuracy_pct', 'avg_reaction_ms', 'best_combo', 'timestamp']];
      const keys = [];
      try {
        for (let i = 0; i < global.localStorage.length; i++) {
          const k = global.localStorage.key(i);
          if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
        }
      } catch (e) { /* ignore */ }
      keys.sort();
      for (const k of keys) {
        const date = k.slice(KEY_PREFIX.length);
        const list = (safeRead(k, []) || []).slice().sort(byScore);
        list.forEach((e, i) => rows.push([date, i + 1, e.name, e.score, e.accuracy, e.reaction, e.combo, new Date(e.at).toISOString()]));
      }
      return rows.map(r => r.join(',')).join('\n');
    },

    notify() {
      if (channel) {
        try { channel.postMessage({ type: 'update', at: Date.now() }); } catch (e) { /* ignore */ }
      }
    },

    // Fires on updates from this tab's channel, other tabs, or other windows.
    subscribe(fn) {
      if (channel) channel.addEventListener('message', fn);
      global.addEventListener('storage', (ev) => {
        if (!ev.key || ev.key.startsWith(KEY_PREFIX) || ev.key === ALLTIME_KEY) fn();
      });
    },
  };

  global.SkyStore = Store;
})(window);
