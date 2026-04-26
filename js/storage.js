// localStorage wrapper for high scores, ghost data, settings.
(function (global) {
  'use strict';

  const KEY = 'mazeBallPWA.v1';

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      return Object.assign(defaults(), parsed);
    } catch (e) {
      return defaults();
    }
  }

  function defaults() {
    return {
      highScores: {},   // { difficulty: timeMs }
      daily: {},        // { 'YYYY-MM-DD': { difficulty: { time, recording } } }
      settings: { sound: true, vibration: true, trail: true },
      lastGhost: null,  // { difficulty, seed, recording, time }
    };
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Storage save failed:', e);
    }
  }

  const Storage = {
    _data: load(),

    getSettings() {
      return Object.assign({}, this._data.settings);
    },
    setSettings(patch) {
      this._data.settings = Object.assign({}, this._data.settings, patch);
      save(this._data);
    },

    getHighScore(difficulty) {
      const v = this._data.highScores[String(difficulty)];
      return typeof v === 'number' ? v : null;
    },
    setHighScore(difficulty, timeMs) {
      const cur = this.getHighScore(difficulty);
      if (cur === null || timeMs < cur) {
        this._data.highScores[String(difficulty)] = timeMs;
        save(this._data);
        return true;
      }
      return false;
    },
    getAllHighScores() {
      return Object.assign({}, this._data.highScores);
    },
    clearHighScores() {
      this._data.highScores = {};
      this._data.daily = {};
      this._data.lastGhost = null;
      save(this._data);
    },

    /**
     * Save the recording for the same maze (seed + difficulty) so that
     * the next "retry-same-maze" attempt can show the ghost.
     */
    setLastGhost(difficulty, seed, recording, time) {
      this._data.lastGhost = {
        difficulty: difficulty,
        seed: seed,
        recording: recording,
        time: time,
      };
      save(this._data);
    },
    getLastGhost(difficulty, seed) {
      const g = this._data.lastGhost;
      if (!g) return null;
      if (g.difficulty !== difficulty) return null;
      if (g.seed !== seed) return null;
      return g;
    },

    todayKey() {
      const d = new Date();
      const yy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return yy + '-' + mm + '-' + dd;
    },
    /** Daily seed independent of timezone variance for reproducibility */
    todaySeed() {
      const d = new Date();
      return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    },
    getDailyBest(difficulty) {
      const day = this._data.daily[this.todayKey()];
      if (!day) return null;
      const entry = day[String(difficulty)];
      return entry || null;
    },
    setDailyBest(difficulty, timeMs, recording) {
      const k = this.todayKey();
      const day = this._data.daily[k] || (this._data.daily[k] = {});
      const cur = day[String(difficulty)];
      if (!cur || timeMs < cur.time) {
        day[String(difficulty)] = { time: timeMs, recording: recording };
        // garbage-collect older daily entries
        const keys = Object.keys(this._data.daily).sort();
        while (keys.length > 7) {
          delete this._data.daily[keys.shift()];
        }
        save(this._data);
        return true;
      }
      return false;
    },
    getAllDailyBest() {
      return Object.assign({}, this._data.daily[this.todayKey()] || {});
    },
  };

  global.MazeStorage = Storage;
})(window);
