// Force layout of the graph view, run in a Web Worker (`graphLayout.worker.ts`): many-body
// repulsion with a Barnes–Hut quadtree (thousands of nodes stay fast), springs along the links,
// and a pull to the center. Velocity Verlet with a cooling `alpha` like d3-force. The worker
// sends positions while it settles (progressive layout) and once more when it rests.

export interface ForceParams {
  /** 0–1 each: pull to the center, repulsion between nodes, length of the links. */
  center: number;
  repel: number;
  linkDistance: number;
}

/** Main thread → worker. */
export type LayoutIn =
  | { type: "init"; count: number; edges: Uint32Array; positions: Float32Array; known: Uint8Array; params: ForceParams; animate: boolean; alpha?: number }
  | { type: "params"; params: ForceParams }
  | { type: "drag"; index: number; x: number; y: number }
  | { type: "release"; index: number }
  | { type: "reheat"; alpha?: number }
  | { type: "stop" };

/** Worker → main thread. `done`: the layout rests (the view stores it). */
export type LayoutOut = { type: "tick"; positions: Float32Array; alpha: number; done: boolean };

const ALPHA_MIN = 0.002;
const VELOCITY_DECAY = 0.42;

/** Physical constants from the 0–1 sliders. */
export function forces(p: ForceParams) {
  return {
    gravity: 0.015 + p.center * 0.11,
    charge: -(8 + p.repel * 84),
    distance: 10 + p.linkDistance * 64,
  };
}

export class ForceSim {
  readonly n: number;
  pos: Float32Array;
  vel: Float32Array;
  fixed: Int8Array;
  alpha = 1;
  alphaDecay: number;
  private edges: Uint32Array;
  private bias: Float32Array;
  private strength: Float32Array;
  private k: ReturnType<typeof forces>;

  constructor(count: number, edges: Uint32Array, positions: Float32Array, params: ForceParams, iterations = 300) {
    this.n = count;
    this.edges = edges;
    this.pos = positions.slice(0, count * 2);
    this.vel = new Float32Array(count * 2);
    this.fixed = new Int8Array(count);
    this.k = forces(params);
    this.alphaDecay = 1 - Math.pow(ALPHA_MIN, 1 / iterations);
    const deg = new Float32Array(count);
    for (let i = 0; i < edges.length; i++) deg[edges[i]]++;
    const m = edges.length / 2;
    this.bias = new Float32Array(m);
    this.strength = new Float32Array(m);
    for (let e = 0; e < m; e++) {
      const a = edges[e * 2];
      const b = edges[e * 2 + 1];
      this.bias[e] = deg[a] / (deg[a] + deg[b]);
      this.strength[e] = 1 / Math.min(deg[a], deg[b]);
    }
  }

  setParams(p: ForceParams) {
    this.k = forces(p);
  }

  get done() {
    return this.alpha < ALPHA_MIN;
  }

  tick() {
    const { n, pos, vel, alpha } = this;
    this.links(alpha);
    this.manyBody(alpha);
    const g = this.k.gravity * alpha;
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) {
        vel[i * 2] = vel[i * 2 + 1] = 0;
        continue;
      }
      vel[i * 2] = (vel[i * 2] - pos[i * 2] * g) * (1 - VELOCITY_DECAY);
      vel[i * 2 + 1] = (vel[i * 2 + 1] - pos[i * 2 + 1] * g) * (1 - VELOCITY_DECAY);
      pos[i * 2] += vel[i * 2];
      pos[i * 2 + 1] += vel[i * 2 + 1];
    }
    this.alpha += (0 - this.alpha) * this.alphaDecay;
  }

  private links(alpha: number) {
    const { pos, vel, edges } = this;
    const dist = this.k.distance;
    for (let e = 0; e < this.bias.length; e++) {
      const a = edges[e * 2];
      const b = edges[e * 2 + 1];
      let dx = pos[b * 2] + vel[b * 2] - pos[a * 2] - vel[a * 2] || 1e-6;
      let dy = pos[b * 2 + 1] + vel[b * 2 + 1] - pos[a * 2 + 1] - vel[a * 2 + 1] || 1e-6;
      const l = Math.sqrt(dx * dx + dy * dy);
      const f = ((l - dist) / l) * alpha * this.strength[e];
      dx *= f;
      dy *= f;
      const bb = this.bias[e];
      vel[b * 2] -= dx * bb;
      vel[b * 2 + 1] -= dy * bb;
      vel[a * 2] += dx * (1 - bb);
      vel[a * 2 + 1] += dy * (1 - bb);
    }
  }

  /** Barnes–Hut: a quadtree in flat arrays, rebuilt each tick. */
  private manyBody(alpha: number) {
    const { n, pos, vel } = this;
    if (n < 2) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
    const tree = new QuadTree(n * 2 + 8);
    tree.reset(x0, y0, size, pos);
    for (let i = 0; i < n; i++) tree.insert(i, pos[i * 2], pos[i * 2 + 1], pos);
    tree.accumulate();
    const strength = this.k.charge * alpha;
    const theta2 = 0.81;
    const distMin2 = 1;
    const distMax2 = 4e6;
    const stack = new Int32Array(256);
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) continue;
      const px = pos[i * 2];
      const py = pos[i * 2 + 1];
      let fx = 0;
      let fy = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp) {
        const q = stack[--sp];
        const w = tree.weight[q];
        if (!w) continue;
        const dx = tree.cx[q] - px;
        const dy = tree.cy[q] - py;
        let l2 = dx * dx + dy * dy;
        const s = tree.size[q];
        const leaf = tree.child[q * 4] < 0 && tree.child[q * 4 + 1] < 0 && tree.child[q * 4 + 2] < 0 && tree.child[q * 4 + 3] < 0;
        if (leaf || (s * s) / theta2 < l2) {
          if (l2 >= distMax2) continue;
          if (leaf) {
            // Points in this leaf other than the node itself.
            for (let p = tree.point[q]; p >= 0; p = tree.next[p]) {
              if (p === i) continue;
              let ddx = pos[p * 2] - px;
              let ddy = pos[p * 2 + 1] - py;
              if (ddx === 0 && ddy === 0) {
                ddx = (Math.random() - 0.5) * 1e-3;
                ddy = (Math.random() - 0.5) * 1e-3;
              }
              let d2 = ddx * ddx + ddy * ddy;
              if (d2 < distMin2) d2 = Math.sqrt(distMin2 * d2);
              const f = strength / d2;
              fx += ddx * f;
              fy += ddy * f;
            }
          } else {
            if (l2 < distMin2) l2 = Math.sqrt(distMin2 * l2);
            const f = (strength * w) / l2;
            fx += dx * f;
            fy += dy * f;
          }
          continue;
        }
        for (let c = 0; c < 4; c++) {
          const ch = tree.child[q * 4 + c];
          if (ch >= 0 && sp < stack.length) stack[sp++] = ch;
        }
      }
      vel[i * 2] += fx;
      vel[i * 2 + 1] += fy;
    }
  }
}

/** Quadtree cells in typed arrays: bounds, children, center of mass and the points of a leaf. */
class QuadTree {
  x: Float64Array;
  y: Float64Array;
  size: Float64Array;
  child: Int32Array;
  cx: Float64Array;
  cy: Float64Array;
  weight: Float64Array;
  point: Int32Array;
  next: Int32Array;
  count = 0;
  constructor(cap: number) {
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.size = new Float64Array(cap);
    this.child = new Int32Array(cap * 4);
    this.cx = new Float64Array(cap);
    this.cy = new Float64Array(cap);
    this.weight = new Float64Array(cap);
    this.point = new Int32Array(cap);
    this.next = new Int32Array(Math.max(1, cap));
  }
  private grow() {
    const cap = this.x.length * 2;
    const g = <T extends Float64Array | Int32Array>(a: T, n: number): T => {
      const b = new (a.constructor as { new (n: number): T })(n);
      b.set(a);
      return b;
    };
    this.x = g(this.x, cap);
    this.y = g(this.y, cap);
    this.size = g(this.size, cap);
    this.child = g(this.child, cap * 4);
    this.cx = g(this.cx, cap);
    this.cy = g(this.cy, cap);
    this.weight = g(this.weight, cap);
    this.point = g(this.point, cap);
  }
  private cell(x: number, y: number, size: number) {
    if (this.count >= this.x.length) this.grow();
    const q = this.count++;
    this.x[q] = x;
    this.y[q] = y;
    this.size[q] = size;
    this.child.fill(-1, q * 4, q * 4 + 4);
    this.point[q] = -1;
    this.weight[q] = 0;
    return q;
  }
  private pos: Float32Array = new Float32Array(0);
  reset(x: number, y: number, size: number, pos: Float32Array) {
    this.pos = pos;
    this.count = 0;
    this.cell(x, y, size);
  }
  insert(i: number, px: number, py: number, pos: Float32Array) {
    if (i >= this.next.length) {
      const b = new Int32Array(i * 2 + 2);
      b.set(this.next);
      this.next = b;
    }
    let q = 0;
    for (let depth = 0; ; depth++) {
      const leaf = this.child[q * 4] < 0 && this.child[q * 4 + 1] < 0 && this.child[q * 4 + 2] < 0 && this.child[q * 4 + 3] < 0;
      if (leaf) {
        // An empty leaf, a leaf at the depth limit or one with points at the same spot takes it.
        const p = this.point[q];
        if (p < 0 || depth > 24 || (pos[p * 2] === px && pos[p * 2 + 1] === py)) {
          this.next[i] = p;
          this.point[q] = i;
          return;
        }
        // Split: move the leaf's points one level down.
        this.point[q] = -1;
        for (let r = p; r >= 0; ) {
          const nx = this.next[r];
          this.place(q, r, pos[r * 2], pos[r * 2 + 1]);
          r = nx;
        }
      }
      q = this.childFor(q, px, py);
    }
  }
  private childFor(q: number, px: number, py: number) {
    const h = this.size[q] / 2;
    const right = px >= this.x[q] + h ? 1 : 0;
    const bottom = py >= this.y[q] + h ? 1 : 0;
    const c = bottom * 2 + right;
    let ch = this.child[q * 4 + c];
    if (ch < 0) {
      ch = this.cell(this.x[q] + right * h, this.y[q] + bottom * h, h);
      this.child[q * 4 + c] = ch;
    }
    return ch;
  }
  private place(q: number, r: number, px: number, py: number) {
    const ch = this.childFor(q, px, py);
    this.next[r] = this.point[ch];
    this.point[ch] = r;
  }
  /** Center of mass and weight of every cell, children before parents (they come later). */
  accumulate() {
    for (let q = this.count - 1; q >= 0; q--) {
      let w = 0;
      let sx = 0;
      let sy = 0;
      for (let p = this.point[q]; p >= 0; p = this.next[p]) {
        w++;
        sx += this.pos[p * 2];
        sy += this.pos[p * 2 + 1];
      }
      for (let c = 0; c < 4; c++) {
        const ch = this.child[q * 4 + c];
        if (ch >= 0 && this.weight[ch]) {
          w += this.weight[ch];
          sx += this.cx[ch] * this.weight[ch];
          sy += this.cy[ch] * this.weight[ch];
        }
      }
      this.weight[q] = w;
      if (w) {
        this.cx[q] = sx / w;
        this.cy[q] = sy / w;
      }
    }
  }
}

/**
 * Starting positions: the known ones (layout cache) stay; a new node goes next to a placed
 * neighbor, the rest on a sunflower spiral, so the first frame already looks like a graph.
 */
export function seedPositions(count: number, edges: ArrayLike<number>, positions: Float32Array, known: Uint8Array): Float32Array {
  const pos = positions.slice(0, count * 2);
  const placed = known.slice(0, count);
  const adj: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < edges.length; i += 2) {
    adj[edges[i]].push(edges[i + 1]);
    adj[edges[i + 1]].push(edges[i]);
  }
  // Hubs first, so their neighbors find them.
  const order = [...Array(count).keys()].sort((a, b) => adj[b].length - adj[a].length);
  const spread = 10 * Math.sqrt(count + 1);
  let k = 0;
  for (const i of order) {
    if (placed[i]) continue;
    const near = adj[i].find((j) => placed[j]);
    if (near != null) {
      const a = (i * 2.399963) % (Math.PI * 2);
      pos[i * 2] = pos[near * 2] + Math.cos(a) * 14;
      pos[i * 2 + 1] = pos[near * 2 + 1] + Math.sin(a) * 14;
    } else {
      const r = spread * Math.sqrt((k + 0.5) / (count + 1));
      const a = k * 2.399963;
      pos[i * 2] = Math.cos(a) * r;
      pos[i * 2 + 1] = Math.sin(a) * r;
      k++;
    }
    placed[i] = 1;
  }
  return pos;
}

/** How long the worker computes before it sends positions (progressive layout). */
const FRAME_MS = 24;

/**
 * The worker's state machine, apart from the worker so it can be tested: `post` sends a
 * message, `schedule` runs the next slice (setTimeout in the worker).
 */
export function createLayoutWorker(post: (m: LayoutOut, transfer?: Transferable[]) => void, schedule: (f: () => void) => void, now: () => number = () => performance.now()) {
  let sim: ForceSim | null = null;
  let animate = true;
  let animateSetting = true;
  let running = false;
  let gen = 0;

  const send = (done: boolean) => {
    if (!sim) return;
    const copy = sim.pos.slice();
    post({ type: "tick", positions: copy, alpha: sim.alpha, done }, [copy.buffer]);
  };
  const run = (g: number) => {
    if (!sim || g !== gen) return;
    const start = now();
    // Without animation the layout is computed in one go and sent when it rests; slices still
    // yield so new messages (drag, stop) get through.
    const budget = animate ? FRAME_MS : 200;
    do sim.tick();
    while (!sim.done && now() - start < budget);
    if (sim.done) {
      running = false;
      send(true);
      return;
    }
    if (animate) send(false);
    schedule(() => run(g));
  };
  const start = () => {
    if (running) return;
    running = true;
    const g = gen;
    schedule(() => run(g));
  };

  return (m: LayoutIn) => {
    switch (m.type) {
      case "init": {
        gen++;
        running = false;
        animate = animateSetting = m.animate;
        const seeded = seedPositions(m.count, m.edges, m.positions, m.known);
        sim = new ForceSim(m.count, m.edges, seeded, m.params);
        sim.alpha = m.alpha ?? 1;
        send(sim.done);
        if (!sim.done) start();
        break;
      }
      case "params":
        if (!sim) return;
        sim.setParams(m.params);
        sim.alpha = Math.max(sim.alpha, 0.5);
        start();
        break;
      case "drag":
        if (!sim || m.index >= sim.n) return;
        sim.fixed[m.index] = 1;
        sim.pos[m.index * 2] = m.x;
        sim.pos[m.index * 2 + 1] = m.y;
        sim.alpha = Math.max(sim.alpha, 0.25);
        // While dragging the neighbors follow, also without animation.
        animate = true;
        start();
        break;
      case "release":
        if (sim && m.index < sim.n) sim.fixed[m.index] = 0;
        animate = animateSetting;
        break;
      case "reheat":
        if (!sim) return;
        sim.alpha = Math.max(sim.alpha, m.alpha ?? 0.6);
        start();
        break;
      case "stop":
        gen++;
        running = false;
        sim = null;
        break;
    }
  };
}
