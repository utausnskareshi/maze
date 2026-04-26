// Maze generation: recursive backtracking + loops + holes + key/door.
(function (global) {
  'use strict';

  /** Mulberry32 — small, deterministic PRNG. */
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Linear interpolation; clamps t to [0, 1]. */
  function lerp(a, b, t) {
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return a + (b - a) * t;
  }

  /**
   * Convert a difficulty (1..100) into game parameters.
   * Returns { width, height, ballRadiusFactor, loopExtra, holeCount,
   *           hasKey, fogRadius (0 = none) }.
   */
  function difficultyToParams(d) {
    const t = (d - 1) / 99;
    const size = Math.round(lerp(6, 40, t));
    return {
      difficulty: d,
      width: size,
      height: size,
      // Ball radius as a fraction of cell size (radius, not diameter).
      ballRadiusFactor: lerp(0.30, 0.175, t),
      // Number of extra walls removed (creates loops / fake routes).
      loopExtra: Math.floor(lerp(0, size * size * 0.15, t)),
      // Trap holes: appear from difficulty 50 and scale up.
      holeCount: d >= 50 ? Math.floor((d - 50) / 8) + 1 : 0,
      // Key/door requirement: difficulty 70 and above.
      hasKey: d >= 70,
      // Fog of war: kicks in at 60. Lower radius = harder.
      // 0 means no fog.
      fogRadius: d >= 60 ? lerp(6, 2.2, (d - 60) / 40) : 0,
    };
  }

  class Maze {
    constructor(params, seed) {
      this.width = params.width;
      this.height = params.height;
      this.params = params;
      this.seed = seed;
      this.rng = mulberry32(seed);

      // Each cell tracks its 4 walls.
      this.cells = [];
      for (let y = 0; y < this.height; y++) {
        const row = [];
        for (let x = 0; x < this.width; x++) {
          row.push({
            walls: { N: true, E: true, S: true, W: true },
            visited: false,
          });
        }
        this.cells.push(row);
      }

      this._carve();
      if (params.loopExtra > 0) this._carveLoops(params.loopExtra);

      // Start: top-left, Goal: bottom-right.
      this.start = { x: 0, y: 0 };
      this.goal = { x: this.width - 1, y: this.height - 1 };

      // Holes: random cells that aren't start, goal, or directly adjacent.
      this.holes = [];
      if (params.holeCount > 0) {
        this._placeHoles(params.holeCount);
      }

      // Key: placed somewhere far from start/goal/holes.
      this.key = null;
      if (params.hasKey) {
        this.key = this._placeKey();
      }
    }

    _carve() {
      const stack = [{ x: 0, y: 0 }];
      this.cells[0][0].visited = true;
      const dirs = [
        ['N', 0, -1],
        ['E', 1, 0],
        ['S', 0, 1],
        ['W', -1, 0],
      ];
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const candidates = [];
        for (const [dir, dx, dy] of dirs) {
          const nx = top.x + dx;
          const ny = top.y + dy;
          if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
          if (this.cells[ny][nx].visited) continue;
          candidates.push([dir, nx, ny]);
        }
        if (candidates.length === 0) {
          stack.pop();
          continue;
        }
        const choice = candidates[Math.floor(this.rng() * candidates.length)];
        this._removeWall(top.x, top.y, choice[0]);
        this.cells[choice[2]][choice[1]].visited = true;
        stack.push({ x: choice[1], y: choice[2] });
      }
    }

    _removeWall(x, y, dir) {
      const opp = { N: 'S', S: 'N', E: 'W', W: 'E' }[dir];
      this.cells[y][x].walls[dir] = false;
      let nx = x, ny = y;
      if (dir === 'N') ny -= 1;
      else if (dir === 'S') ny += 1;
      else if (dir === 'E') nx += 1;
      else if (dir === 'W') nx -= 1;
      if (nx >= 0 && ny >= 0 && nx < this.width && ny < this.height) {
        this.cells[ny][nx].walls[opp] = false;
      }
    }

    _carveLoops(count) {
      let attempts = 0;
      let removed = 0;
      while (removed < count && attempts < count * 5) {
        attempts++;
        const x = Math.floor(this.rng() * this.width);
        const y = Math.floor(this.rng() * this.height);
        const c = this.cells[y][x];
        const present = [];
        if (y > 0 && c.walls.N) present.push('N');
        if (x < this.width - 1 && c.walls.E) present.push('E');
        if (y < this.height - 1 && c.walls.S) present.push('S');
        if (x > 0 && c.walls.W) present.push('W');
        if (present.length === 0) continue;
        const dir = present[Math.floor(this.rng() * present.length)];
        this._removeWall(x, y, dir);
        removed++;
      }
    }

    _placeHoles(count) {
      const blocked = new Set();
      const key = (x, y) => x + ',' + y;
      blocked.add(key(0, 0));
      blocked.add(key(1, 0));
      blocked.add(key(0, 1));
      blocked.add(key(this.goal.x, this.goal.y));
      blocked.add(key(this.goal.x - 1, this.goal.y));
      blocked.add(key(this.goal.x, this.goal.y - 1));

      let placed = 0;
      let tries = 0;
      while (placed < count && tries < count * 30) {
        tries++;
        const x = Math.floor(this.rng() * this.width);
        const y = Math.floor(this.rng() * this.height);
        if (blocked.has(key(x, y))) continue;
        this.holes.push({ x: x, y: y });
        blocked.add(key(x, y));
        // Avoid clustering by blocking neighbours too.
        blocked.add(key(x + 1, y));
        blocked.add(key(x - 1, y));
        blocked.add(key(x, y + 1));
        blocked.add(key(x, y - 1));
        placed++;
      }
    }

    _placeKey() {
      // BFS from start to compute distances; place key where distance is large
      // and no hole sits there.
      const dist = [];
      for (let y = 0; y < this.height; y++) {
        const row = [];
        for (let x = 0; x < this.width; x++) row.push(-1);
        dist.push(row);
      }
      const queue = [[0, 0]];
      dist[0][0] = 0;
      let maxCell = { x: 0, y: 0, d: 0 };
      const holeSet = new Set(this.holes.map((h) => h.x + ',' + h.y));
      const goalKey = this.goal.x + ',' + this.goal.y;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift();
        const c = this.cells[cy][cx];
        const cd = dist[cy][cx];
        const cellKey = cx + ',' + cy;
        if (cd > maxCell.d && !holeSet.has(cellKey) && cellKey !== goalKey && !(cx === 0 && cy === 0)) {
          maxCell = { x: cx, y: cy, d: cd };
        }
        if (!c.walls.N && cy > 0 && dist[cy - 1][cx] === -1) {
          dist[cy - 1][cx] = cd + 1;
          queue.push([cx, cy - 1]);
        }
        if (!c.walls.E && cx < this.width - 1 && dist[cy][cx + 1] === -1) {
          dist[cy][cx + 1] = cd + 1;
          queue.push([cx + 1, cy]);
        }
        if (!c.walls.S && cy < this.height - 1 && dist[cy + 1][cx] === -1) {
          dist[cy + 1][cx] = cd + 1;
          queue.push([cx, cy + 1]);
        }
        if (!c.walls.W && cx > 0 && dist[cy][cx - 1] === -1) {
          dist[cy][cx - 1] = cd + 1;
          queue.push([cx - 1, cy]);
        }
      }
      return { x: maxCell.x, y: maxCell.y, taken: false };
    }
  }

  global.MazeGen = {
    Maze: Maze,
    difficultyToParams: difficultyToParams,
    mulberry32: mulberry32,
  };
})(window);
