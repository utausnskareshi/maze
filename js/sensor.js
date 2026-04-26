// Tilt sensor handling: orientation, motion (shake), iOS permission, calibration,
// and a keyboard / virtual-joystick fallback for desktop or denied permission.
(function (global) {
  'use strict';

  const SHAKE_THRESHOLD = 25; // m/s^2 (above gravity baseline)
  const SHAKE_COOLDOWN_MS = 800;

  class Sensor {
    constructor() {
      this.beta = 0;          // front/back tilt (deg)
      this.gamma = 0;         // left/right tilt (deg)
      this.calibBeta = 0;
      this.calibGamma = 0;
      this.permissionGranted = false;
      this.usingFallback = false;
      this._listenersAttached = false;

      // Keyboard / joystick state:
      this.keyTilt = { x: 0, y: 0 };

      this._lastShakeTime = 0;
      this._onShake = null;

      this._orientHandler = (e) => {
        if (typeof e.beta === 'number') this.beta = e.beta;
        if (typeof e.gamma === 'number') this.gamma = e.gamma;
      };
      this._motionHandler = (e) => {
        const a = e.accelerationIncludingGravity || e.acceleration;
        if (!a) return;
        const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
        // accelerationIncludingGravity baseline is ~9.8; bare acceleration ~0.
        const baseline = e.accelerationIncludingGravity ? 9.8 : 0;
        const delta = Math.abs(mag - baseline);
        if (delta > SHAKE_THRESHOLD) {
          const now = performance.now();
          if (now - this._lastShakeTime > SHAKE_COOLDOWN_MS) {
            this._lastShakeTime = now;
            if (this._onShake) this._onShake();
          }
        }
      };
    }

    /**
     * Request iOS 13+ permission. Returns a Promise<boolean>.
     * On non-iOS browsers, just attaches listeners and resolves true.
     */
    async requestPermission() {
      const orientNeedsPerm =
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function';
      const motionNeedsPerm =
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function';

      try {
        if (orientNeedsPerm) {
          const r = await DeviceOrientationEvent.requestPermission();
          if (r !== 'granted') return false;
        }
        if (motionNeedsPerm) {
          const r = await DeviceMotionEvent.requestPermission();
          if (r !== 'granted') {
            // Continue with orientation only.
          }
        }
      } catch (e) {
        return false;
      }

      this._attachListeners();
      this.permissionGranted = true;
      return true;
    }

    /** Attach without explicit permission (Android, desktop). */
    attachIfAvailable() {
      // If iOS would need permission and hasn't granted, skip — we wait for
      // requestPermission() instead.
      const needsPerm =
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function';
      if (needsPerm && !this.permissionGranted) return false;

      this._attachListeners();
      return true;
    }

    _attachListeners() {
      if (this._listenersAttached) return;
      window.addEventListener('deviceorientation', this._orientHandler, true);
      window.addEventListener('devicemotion', this._motionHandler, true);
      this._listenersAttached = true;
    }

    detach() {
      if (!this._listenersAttached) return;
      window.removeEventListener('deviceorientation', this._orientHandler, true);
      window.removeEventListener('devicemotion', this._motionHandler, true);
      this._listenersAttached = false;
    }

    /** Set the current pose as the calibration zero. */
    calibrate() {
      this.calibBeta = this.beta;
      this.calibGamma = this.gamma;
    }

    onShake(cb) {
      this._onShake = cb;
    }

    /**
     * Returns gravity-style 2D acceleration vector in px/s^2.
     * tiltGain controls how strongly tilt is converted to acceleration.
     */
    getGravity(tiltGain) {
      // Fallback path: keyboard / joystick.
      if (this.usingFallback) {
        return {
          x: this.keyTilt.x * tiltGain,
          y: this.keyTilt.y * tiltGain,
        };
      }

      // Adjust for portrait orientation; clamp to ±45 degrees so the ball
      // doesn't go absurdly fast.
      let dGamma = this.gamma - this.calibGamma;
      let dBeta = this.beta - this.calibBeta;
      const limit = 35;
      if (dGamma > limit) dGamma = limit;
      else if (dGamma < -limit) dGamma = -limit;
      if (dBeta > limit) dBeta = limit;
      else if (dBeta < -limit) dBeta = -limit;

      const gx = Math.sin((dGamma * Math.PI) / 180);
      const gy = Math.sin((dBeta * Math.PI) / 180);

      return { x: gx * tiltGain, y: gy * tiltGain };
    }

    /** For the calibration UI: returns -1..1 normalized tilt (raw, no calib). */
    getRawTiltNormalized() {
      return {
        x: Math.max(-1, Math.min(1, (this.gamma - this.calibGamma) / 35)),
        y: Math.max(-1, Math.min(1, (this.beta - this.calibBeta) / 35)),
      };
    }
  }

  // --- Keyboard fallback ---
  function attachKeyboard(sensor) {
    const keys = { up: false, down: false, left: false, right: false };
    function onKey(e, down) {
      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': keys.up = down; break;
        case 'ArrowDown': case 's': case 'S': keys.down = down; break;
        case 'ArrowLeft': case 'a': case 'A': keys.left = down; break;
        case 'ArrowRight': case 'd': case 'D': keys.right = down; break;
        default: return;
      }
      sensor.keyTilt.x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      sensor.keyTilt.y = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
      e.preventDefault();
    }
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
  }

  /**
   * Virtual joystick attached to a DOM element. Drag knob within the pad
   * to set tilt; release to zero.
   */
  function attachVirtualJoystick(sensor, pad, knob) {
    let dragging = false;

    function getRadius() {
      // Read live: the pad may be hidden at attach time (offsetWidth == 0).
      const w = pad.offsetWidth;
      // Fallback to CSS-declared width if hidden when first interacted with.
      return (w > 0 ? w : 140) / 2;
    }

    function onStart(e) {
      dragging = true;
      e.preventDefault();
      onMove(e);
    }
    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const rect = pad.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const t = e.touches ? e.touches[0] : e;
      let dx = t.clientX - cx;
      let dy = t.clientY - cy;
      const r = Math.max(20, getRadius() - 25);
      const d = Math.hypot(dx, dy);
      if (d > r) {
        dx = (dx / d) * r;
        dy = (dy / d) * r;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      sensor.keyTilt.x = dx / r;
      sensor.keyTilt.y = dy / r;
    }
    function onEnd(e) {
      if (!dragging) return;
      dragging = false;
      e.preventDefault();
      knob.style.transform = '';
      sensor.keyTilt.x = 0;
      sensor.keyTilt.y = 0;
    }

    pad.addEventListener('touchstart', onStart, { passive: false });
    pad.addEventListener('touchmove', onMove, { passive: false });
    pad.addEventListener('touchend', onEnd, { passive: false });
    pad.addEventListener('touchcancel', onEnd, { passive: false });
    pad.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  global.MazeSensor = {
    Sensor: Sensor,
    attachKeyboard: attachKeyboard,
    attachVirtualJoystick: attachVirtualJoystick,
  };
})(window);
