// Lightweight WebAudio sound effects (no external assets).
(function (global) {
  'use strict';

  class GameAudio {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.muted = false;
    }

    _ensure() {
      if (this.ctx) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.4;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.ctx = null;
      }
    }

    /** Must be called from a user gesture on iOS to unlock audio. */
    unlock() {
      this._ensure();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }

    setMuted(m) {
      this.muted = !!m;
    }

    _beep(freq, dur, type, vol) {
      if (this.muted) return;
      this._ensure();
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    wallHit(intensity) {
      // Pitch & volume scale with impact intensity.
      const v = Math.min(1, intensity / 600);
      if (v < 0.05) return;
      const freq = 90 + v * 240;
      this._beep(freq, 0.06, 'square', 0.05 + v * 0.18);
    }

    keyPickup() {
      this._beep(880, 0.10, 'sine', 0.30);
      setTimeout(() => this._beep(1320, 0.16, 'sine', 0.26), 80);
    }

    holeFall() {
      if (this.muted) return;
      this._ensure();
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, t0);
      osc.frequency.exponentialRampToValueAtTime(80, t0 + 0.45);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + 0.55);
    }

    countdown() {
      this._beep(660, 0.10, 'square', 0.18);
    }

    countdownGo() {
      this._beep(990, 0.18, 'square', 0.22);
    }

    goal() {
      // Major arpeggio C-E-G-C.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        setTimeout(() => this._beep(f, 0.18, 'triangle', 0.28), i * 90);
      });
    }
  }

  global.MazeAudio = { GameAudio: GameAudio };
})(window);
