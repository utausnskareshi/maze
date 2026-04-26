// Ball physics + collision against maze walls.
(function (global) {
  'use strict';

  const FRICTION_PER_SEC = 0.85; // velocity *= FRICTION_PER_SEC^dt
  const RESTITUTION = 0.32;
  const MAX_SPEED = 1800; // pixels per second

  /**
   * Step ball by dt seconds. Resolves collisions against walls
   * and reports the impact magnitude (for vibration/sound feedback).
   *
   * @returns {{ wallHitImpulse: number, fellInHole: boolean,
   *            keyTaken: boolean, reachedGoal: boolean }}
   */
  function step(ball, maze, gravity, dt, layout, hasKey) {
    const cs = layout.cellSize;
    const wt = layout.wallThickness;
    const wt2 = wt / 2;

    // Apply gravity (acceleration in px/s^2).
    ball.vx += gravity.x * dt;
    ball.vy += gravity.y * dt;

    // Friction (per-second exponential decay).
    const f = Math.pow(FRICTION_PER_SEC, dt);
    ball.vx *= f;
    ball.vy *= f;

    // Clamp speed.
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > MAX_SPEED) {
      ball.vx = (ball.vx / sp) * MAX_SPEED;
      ball.vy = (ball.vy / sp) * MAX_SPEED;
    }

    // Sub-step to avoid tunnelling through walls at high speed.
    const moveDist = Math.hypot(ball.vx, ball.vy) * dt;
    const safeStep = Math.min(ball.r, wt) * 0.7;
    const subSteps = Math.max(1, Math.ceil(moveDist / safeStep));
    const subDt = dt / subSteps;

    let maxImpulse = 0;

    for (let s = 0; s < subSteps; s++) {
      ball.x += ball.vx * subDt;
      ball.y += ball.vy * subDt;

      // Determine cells overlapped (with margin).
      const minCx = Math.max(0, Math.floor((ball.x - ball.r) / cs) - 1);
      const maxCx = Math.min(maze.width - 1, Math.floor((ball.x + ball.r) / cs) + 1);
      const minCy = Math.max(0, Math.floor((ball.y - ball.r) / cs) - 1);
      const maxCy = Math.min(maze.height - 1, Math.floor((ball.y + ball.r) / cs) + 1);

      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const cell = maze.cells[cy][cx];
          // North wall (owned).
          if (cell.walls.N) {
            const aabb = makeAABB(cx * cs - wt2, cy * cs - wt2, (cx + 1) * cs + wt2, cy * cs + wt2);
            const i = resolve(ball, aabb);
            if (i > maxImpulse) maxImpulse = i;
          }
          // West wall (owned).
          if (cell.walls.W) {
            const aabb = makeAABB(cx * cs - wt2, cy * cs - wt2, cx * cs + wt2, (cy + 1) * cs + wt2);
            const i = resolve(ball, aabb);
            if (i > maxImpulse) maxImpulse = i;
          }
          // South wall: only the outer boundary (others handled by N of cell below).
          if (cy === maze.height - 1 && cell.walls.S) {
            const aabb = makeAABB(cx * cs - wt2, (cy + 1) * cs - wt2, (cx + 1) * cs + wt2, (cy + 1) * cs + wt2);
            const i = resolve(ball, aabb);
            if (i > maxImpulse) maxImpulse = i;
          }
          // East wall: outer boundary only.
          if (cx === maze.width - 1 && cell.walls.E) {
            const aabb = makeAABB((cx + 1) * cs - wt2, cy * cs - wt2, (cx + 1) * cs + wt2, (cy + 1) * cs + wt2);
            const i = resolve(ball, aabb);
            if (i > maxImpulse) maxImpulse = i;
          }
          // NOTE: There used to be a "door" — a virtual barrier around the
          // goal cell active until the key was taken. That made layouts
          // unsolvable when the key sat on the far side of the goal: the
          // door blocked the only path to the key. Now the goal cell is
          // always passable; goal *triggering* is gated by key possession
          // (see "Goal detection" below).
        }
      }
    }

    // Hole detection: ball center inside a hole cell + close enough to centre.
    const cellCx = Math.floor(ball.x / cs);
    const cellCy = Math.floor(ball.y / cs);
    let fellInHole = false;
    if (cellCx >= 0 && cellCx < maze.width && cellCy >= 0 && cellCy < maze.height) {
      for (const h of maze.holes) {
        if (h.x === cellCx && h.y === cellCy) {
          const hx = (h.x + 0.5) * cs;
          const hy = (h.y + 0.5) * cs;
          const distance = Math.hypot(ball.x - hx, ball.y - hy);
          // Hole radius slightly larger than ball so falling feels fair.
          if (distance < cs * 0.30) {
            fellInHole = true;
          }
          break;
        }
      }
    }

    // Key pickup.
    let keyTaken = false;
    if (maze.params.hasKey && maze.key && !maze.key.taken) {
      const kx = (maze.key.x + 0.5) * cs;
      const ky = (maze.key.y + 0.5) * cs;
      if (Math.hypot(ball.x - kx, ball.y - ky) < ball.r + cs * 0.15) {
        maze.key.taken = true;
        keyTaken = true;
      }
    }

    // Goal detection.
    let reachedGoal = false;
    {
      const gx = (maze.goal.x + 0.5) * cs;
      const gy = (maze.goal.y + 0.5) * cs;
      const allowed = !maze.params.hasKey || (maze.key && maze.key.taken);
      if (allowed && Math.hypot(ball.x - gx, ball.y - gy) < cs * 0.32) {
        reachedGoal = true;
      }
    }

    return {
      wallHitImpulse: maxImpulse,
      fellInHole: fellInHole,
      keyTaken: keyTaken,
      reachedGoal: reachedGoal,
    };
  }

  function makeAABB(x1, y1, x2, y2) {
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  function resolve(ball, aabb) {
    const cx = Math.max(aabb.x1, Math.min(ball.x, aabb.x2));
    const cy = Math.max(aabb.y1, Math.min(ball.y, aabb.y2));
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= ball.r * ball.r) return 0;

    const dist = Math.sqrt(d2);
    let nx, ny;
    if (dist < 1e-6) {
      // Ball center inside the box: push out along smallest axis.
      const left = ball.x - aabb.x1;
      const right = aabb.x2 - ball.x;
      const top = ball.y - aabb.y1;
      const bot = aabb.y2 - ball.y;
      const m = Math.min(left, right, top, bot);
      if (m === left) { nx = -1; ny = 0; ball.x = aabb.x1 - ball.r - 0.01; }
      else if (m === right) { nx = 1; ny = 0; ball.x = aabb.x2 + ball.r + 0.01; }
      else if (m === top) { nx = 0; ny = -1; ball.y = aabb.y1 - ball.r - 0.01; }
      else { nx = 0; ny = 1; ball.y = aabb.y2 + ball.r + 0.01; }
    } else {
      nx = dx / dist;
      ny = dy / dist;
      const overlap = ball.r - dist + 0.01;
      ball.x += nx * overlap;
      ball.y += ny * overlap;
    }

    const vDotN = ball.vx * nx + ball.vy * ny;
    if (vDotN < 0) {
      ball.vx -= (1 + RESTITUTION) * vDotN * nx;
      ball.vy -= (1 + RESTITUTION) * vDotN * ny;
      return Math.abs(vDotN);
    }
    return 0;
  }

  global.MazePhysics = { step: step };
})(window);
