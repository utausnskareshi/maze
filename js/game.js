// Main game module: state machine, rendering, menu wiring.
(function (global) {
  'use strict';

  // ---- Constants ----
  const TILT_GAIN = 1800;          // px/s^2 per unit of sin(tilt)
  const COUNTDOWN_MS = 3000;
  const FALL_RESET_MS = 800;
  const GHOST_SAMPLE_MS = 40;

  // ---- DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const menuEl = $('#menu');
  const gameEl = $('#game');
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const overlays = {
    permission: $('#overlay-permission'),
    calibrate: $('#overlay-calibrate'),
    countdown: $('#overlay-countdown'),
    win: $('#overlay-win'),
    falling: $('#overlay-falling'),
  };
  const hudTime = $('#hud-time');
  const hudDiff = $('#hud-diff');
  const hudKey = $('#hud-key');
  const tiltDot = document.querySelector('.tilt-dot');
  const countNumEl = $('#count-num');
  const touchPad = $('#touch-pad');
  const touchPadKnob = $('#touch-pad-knob');

  // ---- State ----
  let state = 'menu';   // menu | permission | calibrate | countdown | playing | fallReset | won
  let maze = null;
  let ball = null;
  let sensor = new MazeSensor.Sensor();
  let audioFx = new MazeAudio.GameAudio();
  let settings = MazeStorage.getSettings();
  let mode = 'normal';      // 'normal' or 'daily'
  let currentDifficulty = 20;
  let currentSeed = 0;
  let hasKeyCollected = false;
  let trail = [];
  let recording = [];
  let ghost = null;
  let ghostFinalTime = null;
  let startTimeMs = 0;
  let elapsedMs = 0;
  let countdownEnd = 0;
  let countdownNum = 4;
  let lastFrameTs = 0;
  let rafId = null;
  const layout = { cellSize: 0, wallThickness: 0, offsetX: 0, offsetY: 0, sizeW: 0, sizeH: 0 };

  // Hooks
  let installEvent = null; // populated by pwa.js

  // -----------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------
  function init() {
    setupMenu();
    fitCanvas();
    window.addEventListener('resize', () => {
      fitCanvas();
      if (maze) fitLayout(true);
    });
    // Keyboard fallback always available.
    MazeSensor.attachKeyboard(sensor);
    MazeSensor.attachVirtualJoystick(sensor, touchPad, touchPadKnob);

    // Shake-to-restart.
    sensor.onShake(() => {
      if (state === 'playing') {
        restartCurrent();
      }
    });

    // Game over button wiring.
    $('#btn-back').addEventListener('click', backToMenu);
    $('#btn-restart').addEventListener('click', () => {
      if (state === 'playing' || state === 'fallReset') restartCurrent();
    });
    $('#btn-request-permission').addEventListener('click', onRequestPermission);
    $('#btn-skip-permission').addEventListener('click', onSkipPermission);
    $('#btn-calibrate').addEventListener('click', onCalibrateConfirm);
    $('#btn-retry-same').addEventListener('click', () => startGame({ retry: true }));
    $('#btn-new-maze').addEventListener('click', () => startGame({ retry: false }));
    $('#btn-back-menu').addEventListener('click', backToMenu);

    // Begin render loop.
    rafId = requestAnimationFrame(loop);
  }

  // -----------------------------------------------------------
  // Menu wiring
  // -----------------------------------------------------------
  function setupMenu() {
    // Tabs
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tabpanel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.querySelector(`.tabpanel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
        if (tab.dataset.tab === 'scores') refreshScores();
      });
    });

    const diffSlider = $('#difficulty');
    const diffVal = $('#diff-value');
    const diffDetail = $('#diff-detail');

    function updateDiffDetail() {
      const d = parseInt(diffSlider.value, 10);
      currentDifficulty = d;
      diffVal.textContent = d;
      const p = MazeGen.difficultyToParams(d);
      const features = [];
      features.push(`迷路 ${p.width}×${p.height}`);
      features.push(`ボール直径 ${(p.ballRadiusFactor * 2 * 100).toFixed(0)}%`);
      if (p.loopExtra > 0) features.push(`ループ通路 ${p.loopExtra}本`);
      if (p.holeCount > 0) features.push(`<span class="hl danger">トラップ穴 ${p.holeCount}</span>`);
      if (p.fogRadius > 0) features.push(`<span class="hl danger">視界制限</span>`);
      if (p.hasKey) features.push(`<span class="hl gold">鍵が必要</span>`);
      diffDetail.innerHTML = features.join(' / ');
    }
    diffSlider.addEventListener('input', updateDiffDetail);
    updateDiffDetail();

    // Settings checkboxes
    const sndEl = $('#opt-sound');
    const vibEl = $('#opt-vibration');
    const trEl = $('#opt-trail');
    sndEl.checked = settings.sound;
    vibEl.checked = settings.vibration;
    trEl.checked = settings.trail;
    sndEl.addEventListener('change', () => {
      settings.sound = sndEl.checked;
      audioFx.setMuted(!settings.sound);
      MazeStorage.setSettings({ sound: settings.sound });
    });
    vibEl.addEventListener('change', () => {
      settings.vibration = vibEl.checked;
      MazeStorage.setSettings({ vibration: settings.vibration });
    });
    trEl.addEventListener('change', () => {
      settings.trail = trEl.checked;
      MazeStorage.setSettings({ trail: settings.trail });
    });
    audioFx.setMuted(!settings.sound);

    // Buttons
    $('#btn-play').addEventListener('click', () => {
      audioFx.unlock();
      mode = 'normal';
      currentSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
      enterGame();
    });
    $('#btn-daily').addEventListener('click', () => {
      audioFx.unlock();
      mode = 'daily';
      currentSeed = MazeStorage.todaySeed();
      enterGame();
    });
    $('#btn-clear-scores').addEventListener('click', () => {
      if (confirm('全てのハイスコアをリセットしますか？')) {
        MazeStorage.clearHighScores();
        refreshScores();
      }
    });

    // Install button (Android)
    const installBtn = $('#btn-install');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (installEvent) {
          installEvent.prompt();
          await installEvent.userChoice.catch(() => {});
          installEvent = null;
          $('#install-card-android').hidden = true;
        }
      });
    }

    refreshScores();
  }

  function refreshScores() {
    const list = $('#scores-list');
    const all = MazeStorage.getAllHighScores();
    const keys = Object.keys(all)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    if (keys.length === 0) {
      list.innerHTML = '<div class="scores-empty">記録なし — まずは1回プレイしてみよう。</div>';
    } else {
      list.innerHTML = keys
        .map((k) => `<div class="score-item"><span class="lv">Lv.${k}</span><span class="t">${(all[k] / 1000).toFixed(2)}s</span></div>`)
        .join('');
    }
    const dailyEl = $('#daily-list');
    const daily = MazeStorage.getAllDailyBest();
    const dKeys = Object.keys(daily)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    if (dKeys.length === 0) {
      dailyEl.innerHTML = '<div class="scores-empty">本日の記録なし</div>';
    } else {
      dailyEl.innerHTML = dKeys
        .map((k) => `<div class="score-item"><span class="lv">Lv.${k}</span><span class="t">${(daily[k].time / 1000).toFixed(2)}s</span></div>`)
        .join('');
    }
  }

  // -----------------------------------------------------------
  // Screen transitions
  // -----------------------------------------------------------
  function enterGame() {
    menuEl.hidden = true;
    gameEl.hidden = false;
    fitCanvas();
    hideAllOverlays();

    // Permission flow.
    const needsIOSPermission =
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
    if (needsIOSPermission && !sensor.permissionGranted) {
      state = 'permission';
      overlays.permission.hidden = false;
    } else {
      sensor.attachIfAvailable();
      state = 'calibrate';
      overlays.calibrate.hidden = false;
    }
  }

  function backToMenu() {
    hideAllOverlays();
    state = 'menu';
    maze = null;
    ball = null;
    trail = [];
    recording = [];
    ghost = null;
    hasKeyCollected = false;
    hudKey.hidden = true;
    touchPad.hidden = true;
    gameEl.hidden = true;
    menuEl.hidden = false;
    refreshScores();
  }

  function hideAllOverlays() {
    Object.keys(overlays).forEach((k) => (overlays[k].hidden = true));
  }

  async function onRequestPermission() {
    const granted = await sensor.requestPermission();
    if (granted) {
      overlays.permission.hidden = true;
      state = 'calibrate';
      overlays.calibrate.hidden = false;
    } else {
      // Fall back to keyboard / joystick.
      onSkipPermission();
    }
  }

  function onSkipPermission() {
    sensor.usingFallback = true;
    overlays.permission.hidden = true;
    state = 'calibrate';
    overlays.calibrate.hidden = false;
  }

  function onCalibrateConfirm() {
    sensor.calibrate();
    overlays.calibrate.hidden = true;
    startGame({ retry: false });
  }

  // -----------------------------------------------------------
  // Game start
  // -----------------------------------------------------------
  function startGame(opts) {
    hideAllOverlays();
    if (!opts || !opts.retry) {
      // Fresh maze.
      if (mode === 'normal') {
        currentSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
      } else {
        currentSeed = MazeStorage.todaySeed();
      }
    }
    const params = MazeGen.difficultyToParams(currentDifficulty);
    maze = new MazeGen.Maze(params, currentSeed);
    fitLayout(false);

    // Spawn ball at the start cell.
    ball = {
      x: 0.5 * layout.cellSize,
      y: 0.5 * layout.cellSize,
      r: layout.cellSize * params.ballRadiusFactor,
      vx: 0,
      vy: 0,
    };
    trail = [];
    recording = [];
    hasKeyCollected = false;
    elapsedMs = 0;
    hudKey.hidden = !params.hasKey;

    // Touchpad visible only when sensor is in fallback mode.
    touchPad.hidden = !sensor.usingFallback;

    // Ghost selection.
    ghost = null;
    ghostFinalTime = null;
    if (mode === 'daily') {
      const best = MazeStorage.getDailyBest(currentDifficulty);
      if (best && best.recording) {
        ghost = scaleRecording(best.recording, params.ballRadiusFactor); // dummy, kept for symmetry
        ghostFinalTime = best.time;
      }
    } else {
      const lg = MazeStorage.getLastGhost(currentDifficulty, currentSeed);
      if (lg) {
        ghost = lg.recording.slice();
        ghostFinalTime = lg.time;
      }
    }

    // HUD
    hudDiff.textContent = 'Lv.' + currentDifficulty + (mode === 'daily' ? ' 📅' : '');
    hudTime.textContent = '0.00';

    // Countdown.
    state = 'countdown';
    countdownNum = 4;
    countdownEnd = performance.now() + COUNTDOWN_MS;
    overlays.countdown.hidden = false;
  }

  function scaleRecording(rec, _factor) {
    // Recordings are stored in maze-local px scaled to the cellSize at the time
    // of recording. We re-scale to current layout in case cellSize differs.
    return rec.slice();
  }

  function restartCurrent() {
    startGame({ retry: true });
  }

  // -----------------------------------------------------------
  // Layout
  // -----------------------------------------------------------
  function fitCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fitLayout(rescale) {
    if (!maze) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const padTop = 70;
    const padBottom = sensor.usingFallback ? 200 : 30;
    const padLR = 10;
    const availW = w - padLR * 2;
    const availH = h - padTop - padBottom;
    const oldCs = layout.cellSize;
    const cs = Math.max(8, Math.floor(Math.min(availW / maze.width, availH / maze.height)));
    layout.cellSize = cs;
    layout.wallThickness = Math.max(2, Math.floor(cs * 0.12));
    layout.sizeW = cs * maze.width;
    layout.sizeH = cs * maze.height;
    layout.offsetX = (w - layout.sizeW) / 2;
    layout.offsetY = padTop + (availH - layout.sizeH) / 2;

    if (rescale && oldCs > 0 && ball) {
      const k = layout.cellSize / oldCs;
      ball.x *= k;
      ball.y *= k;
      ball.vx *= k;
      ball.vy *= k;
      ball.r = cs * maze.params.ballRadiusFactor;
      for (const p of trail) { p.x *= k; p.y *= k; }
      for (const p of recording) { p.x *= k; p.y *= k; }
      if (ghost) for (const p of ghost) { p.x *= k; p.y *= k; }
    }
  }

  // -----------------------------------------------------------
  // Game loop
  // -----------------------------------------------------------
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!lastFrameTs) lastFrameTs = ts;
    let dt = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;
    if (dt > 0.05) dt = 0.05;

    if (state === 'calibrate') {
      const tilt = sensor.getRawTiltNormalized();
      if (tiltDot) {
        tiltDot.style.transform = `translate(calc(-50% + ${tilt.x * 40}px), calc(-50% + ${tilt.y * 40}px))`;
      }
    } else if (state === 'countdown') {
      const remain = countdownEnd - performance.now();
      const num = Math.max(0, Math.ceil(remain / 1000));
      if (num !== countdownNum) {
        countdownNum = num;
        if (num > 0) {
          countNumEl.textContent = String(num);
          countNumEl.style.animation = 'none';
          // re-trigger animation
          // eslint-disable-next-line no-unused-expressions
          countNumEl.offsetHeight;
          countNumEl.style.animation = '';
          audioFx.countdown();
        } else {
          countNumEl.textContent = 'GO!';
          audioFx.countdownGo();
        }
      }
      if (remain <= -200) {
        overlays.countdown.hidden = true;
        state = 'playing';
        startTimeMs = performance.now();
        lastFrameTs = ts;
      }
    } else if (state === 'playing') {
      const gravity = sensor.getGravity(TILT_GAIN);
      const result = MazePhysics.step(ball, maze, gravity, dt, layout, hasKeyCollected);

      if (result.wallHitImpulse > 30) {
        audioFx.wallHit(result.wallHitImpulse);
        if (settings.vibration && navigator.vibrate) {
          const v = Math.min(40, Math.floor(result.wallHitImpulse / 25));
          if (v > 5) navigator.vibrate(v);
        }
      }
      if (result.keyTaken) {
        hasKeyCollected = true;
        hudKey.hidden = true;
        audioFx.keyPickup();
        if (settings.vibration && navigator.vibrate) navigator.vibrate(40);
      }
      if (result.fellInHole) {
        audioFx.holeFall();
        if (settings.vibration && navigator.vibrate) navigator.vibrate([60, 40, 60]);
        handleFall();
      } else if (result.reachedGoal) {
        if (settings.vibration && navigator.vibrate) navigator.vibrate([20, 30, 20, 30, 100]);
        audioFx.goal();
        handleWin();
      }

      elapsedMs = performance.now() - startTimeMs;
      hudTime.textContent = (elapsedMs / 1000).toFixed(2);

      // Trail
      if (settings.trail) {
        trail.push({ x: ball.x, y: ball.y });
        if (trail.length > 50) trail.shift();
      } else if (trail.length) {
        trail.length = 0;
      }
      // Recording
      if (recording.length === 0 || elapsedMs - recording[recording.length - 1].t > GHOST_SAMPLE_MS) {
        recording.push({ t: elapsedMs, x: ball.x, y: ball.y });
      }
    } else if (state === 'fallReset') {
      // Timer keeps running while falling so attempts cost real time.
      elapsedMs = performance.now() - startTimeMs;
      hudTime.textContent = (elapsedMs / 1000).toFixed(2);
    }

    render();
  }

  // -----------------------------------------------------------
  // Win / Fall
  // -----------------------------------------------------------
  function handleFall() {
    if (state !== 'playing') return;
    state = 'fallReset';
    overlays.falling.hidden = false;
    ball.x = 0.5 * layout.cellSize;
    ball.y = 0.5 * layout.cellSize;
    ball.vx = 0;
    ball.vy = 0;
    trail = [];
    setTimeout(() => {
      overlays.falling.hidden = true;
      if (state === 'fallReset') {
        state = 'playing';
      }
    }, FALL_RESET_MS);
  }

  function handleWin() {
    if (state !== 'playing') return;
    state = 'won';
    const finalTime = elapsedMs;

    const isNewBest = MazeStorage.setHighScore(currentDifficulty, finalTime);
    MazeStorage.setLastGhost(currentDifficulty, currentSeed, recording, finalTime);

    let isNewDailyBest = false;
    if (mode === 'daily') {
      isNewDailyBest = MazeStorage.setDailyBest(currentDifficulty, finalTime, recording);
    }

    $('#win-time').innerHTML = (finalTime / 1000).toFixed(2) + '<span>秒</span>';
    const recordEl = $('#win-record');
    const lines = [];
    if (isNewDailyBest) lines.push('🎉 デイリーベスト更新！');
    if (isNewBest) lines.push('🌟 自己ベスト更新！');
    if (lines.length === 0) {
      const best = MazeStorage.getHighScore(currentDifficulty);
      if (best != null) lines.push(`自己ベスト: ${(best / 1000).toFixed(2)}秒`);
    }
    if (mode === 'daily') {
      const day = MazeStorage.getDailyBest(currentDifficulty);
      if (day) lines.push(`本日ベスト: ${(day.time / 1000).toFixed(2)}秒`);
    }
    recordEl.innerHTML = lines.join('<br>');

    overlays.win.hidden = false;
  }

  // -----------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------
  function render() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = '#050715';
    ctx.fillRect(0, 0, w, h);

    if (!maze) return;

    ctx.save();
    ctx.translate(layout.offsetX, layout.offsetY);

    drawFloor();
    drawHoles();
    drawGoal();
    drawKey();
    drawWalls();
    drawTrail();
    drawGhost();
    drawBall();

    ctx.restore();

    // Fog of war (applied in screen space).
    if (maze.params.fogRadius > 0 && (state === 'playing' || state === 'countdown' || state === 'fallReset')) {
      drawFog();
    }
  }

  function drawFloor() {
    const cs = layout.cellSize;
    ctx.fillStyle = '#1a223e';
    ctx.fillRect(0, 0, layout.sizeW, layout.sizeH);

    // Light grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= maze.width; x++) {
      ctx.moveTo(x * cs, 0);
      ctx.lineTo(x * cs, layout.sizeH);
    }
    for (let y = 0; y <= maze.height; y++) {
      ctx.moveTo(0, y * cs);
      ctx.lineTo(layout.sizeW, y * cs);
    }
    ctx.stroke();

    // Start marker
    ctx.fillStyle = 'rgba(92, 200, 255, 0.18)';
    ctx.fillRect(0, 0, cs, cs);
  }

  function drawWalls() {
    const cs = layout.cellSize;
    const wt = layout.wallThickness;
    ctx.fillStyle = '#5e74e0';
    ctx.shadowColor = 'rgba(94, 116, 224, 0.5)';
    ctx.shadowBlur = 6;

    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.cells[y][x];
        if (c.walls.N) ctx.fillRect(x * cs - wt / 2, y * cs - wt / 2, cs + wt, wt);
        if (c.walls.W) ctx.fillRect(x * cs - wt / 2, y * cs - wt / 2, wt, cs + wt);
        if (y === maze.height - 1 && c.walls.S) ctx.fillRect(x * cs - wt / 2, (y + 1) * cs - wt / 2, cs + wt, wt);
        if (x === maze.width - 1 && c.walls.E) ctx.fillRect((x + 1) * cs - wt / 2, y * cs - wt / 2, wt, cs + wt);
      }
    }
    ctx.shadowBlur = 0;
  }

  function drawHoles() {
    const cs = layout.cellSize;
    for (const h of maze.holes) {
      const cx = (h.x + 0.5) * cs;
      const cy = (h.y + 0.5) * cs;
      const r = cs * 0.35;
      const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
      grad.addColorStop(0, '#000');
      grad.addColorStop(0.7, '#0a0c1d');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawKey() {
    if (!maze.params.hasKey || !maze.key || maze.key.taken) return;
    const cs = layout.cellSize;
    const cx = (maze.key.x + 0.5) * cs;
    const cy = (maze.key.y + 0.5) * cs;
    const r = cs * 0.22;
    const t = performance.now() / 1000;
    const pulse = 1 + 0.1 * Math.sin(t * 4);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.7);
    ctx.scale(pulse, pulse);
    ctx.shadowColor = 'rgba(255, 211, 77, 0.8)';
    ctx.shadowBlur = 14;
    // Key shape: a small star
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.45;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawGoal() {
    const cs = layout.cellSize;
    const cx = (maze.goal.x + 0.5) * cs;
    const cy = (maze.goal.y + 0.5) * cs;
    const r = cs * 0.30;

    const locked = maze.params.hasKey && !hasKeyCollected;
    const colour = locked ? '#ff5d6c' : '#34e08f';

    // Pulsing aura
    const t = performance.now() / 1000;
    const aura = 1 + 0.15 * Math.sin(t * 3);
    ctx.save();
    ctx.shadowColor = colour;
    ctx.shadowBlur = 18;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(cx, cy, r * aura, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Inner ring
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawTrail() {
    if (!settings.trail || trail.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      const alpha = i / trail.length;
      ctx.strokeStyle = `rgba(255, 211, 77, ${alpha * 0.6})`;
      ctx.lineWidth = ball.r * (0.4 + alpha * 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function drawGhost() {
    if (!ghost || ghost.length === 0) return;
    if (state !== 'playing' && state !== 'countdown' && state !== 'fallReset') return;
    const t = state === 'playing' ? elapsedMs : 0;
    const pos = sampleGhost(t);
    if (!pos) return;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.shadowColor = 'rgba(255,255,255,0.4)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, ball.r * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function sampleGhost(timeMs) {
    if (!ghost || ghost.length === 0) return null;
    if (timeMs <= ghost[0].t) return ghost[0];
    if (timeMs >= ghost[ghost.length - 1].t) return null; // ghost finished
    let lo = 0;
    let hi = ghost.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (ghost[mid].t <= timeMs) lo = mid;
      else hi = mid;
    }
    const a = ghost[lo];
    const b = ghost[hi];
    const k = (timeMs - a.t) / (b.t - a.t || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  function drawBall() {
    if (!ball) return;
    const grad = ctx.createRadialGradient(
      ball.x - ball.r * 0.4, ball.y - ball.r * 0.4, ball.r * 0.1,
      ball.x, ball.y, ball.r
    );
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.4, '#ffe480');
    grad.addColorStop(1, '#c79a14');
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(255, 211, 77, 0.6)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawFog() {
    if (!ball) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const cs = layout.cellSize;
    const r = maze.params.fogRadius * cs;

    const cx = layout.offsetX + ball.x;
    const cy = layout.offsetY + ball.y;

    const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    grad.addColorStop(0, 'rgba(5,7,21,0)');
    grad.addColorStop(0.65, 'rgba(5,7,21,0.0)');
    grad.addColorStop(1, 'rgba(5,7,21,0.95)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Outer hard area
    ctx.fillStyle = '#050715';
    // top
    ctx.fillRect(0, 0, w, Math.max(0, cy - r));
    // bottom
    ctx.fillRect(0, cy + r, w, Math.max(0, h - (cy + r)));
    // left
    ctx.fillRect(0, 0, Math.max(0, cx - r), h);
    // right
    ctx.fillRect(cx + r, 0, Math.max(0, w - (cx + r)), h);
  }

  // -----------------------------------------------------------
  // Public API
  // -----------------------------------------------------------
  global.MazeGame = {
    init: init,
    setInstallEvent: function (e) {
      installEvent = e;
      const card = document.getElementById('install-card-android');
      if (card) card.hidden = !e;
    },
  };

  // Auto-init when DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
