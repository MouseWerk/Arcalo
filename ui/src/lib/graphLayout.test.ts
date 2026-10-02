import { describe, expect, it } from "vitest";
import { createLayoutWorker, ForceSim, seedPositions, type LayoutOut } from "./graphLayout";

const params = { center: 0.5, repel: 0.5, linkDistance: 0.5 };

/** A ring of `n` nodes with a few chords. */
function ring(n: number) {
  const e: number[] = [];
  for (let i = 0; i < n; i++) e.push(i, (i + 1) % n);
  for (let i = 0; i < n; i += 7) e.push(i, (i + n / 2) % n);
  return Uint32Array.from(e);
}

/** A worker driven by hand: `flush` runs the scheduled slices. */
function harness(clock = { t: 0 }) {
  const out: LayoutOut[] = [];
  let queue: (() => void)[] = [];
  const handle = createLayoutWorker(
    (m) => out.push(m),
    (f) => queue.push(f),
    () => (clock.t += 1),
  );
  const flush = (max = 1000) => {
    for (let i = 0; i < max && queue.length; i++) {
      const q = queue;
      queue = [];
      q.forEach((f) => f());
    }
  };
  return { out, handle, flush, pending: () => queue.length };
}

describe("force layout", () => {
  it("settles: linked nodes end up closer than unlinked ones", () => {
    const n = 60;
    const edges = ring(n);
    const pos = seedPositions(n, edges, new Float32Array(n * 2), new Uint8Array(n));
    const sim = new ForceSim(n, edges, pos, params);
    let ticks = 0;
    while (!sim.done && ticks < 1000) {
      sim.tick();
      ticks++;
    }
    expect(sim.done).toBe(true);
    const d = (a: number, b: number) => Math.hypot(sim.pos[a * 2] - sim.pos[b * 2], sim.pos[a * 2 + 1] - sim.pos[b * 2 + 1]);
    let linked = 0;
    for (let i = 0; i < n; i++) linked += d(i, (i + 1) % n);
    let far = 0;
    for (let i = 0; i < n; i++) far += d(i, (i + 17) % n);
    expect(linked / n).toBeLessThan(far / n);
    expect([...sim.pos].every(Number.isFinite)).toBe(true);
  });

  it("keeps cached positions and puts new nodes next to a neighbor", () => {
    const pos = new Float32Array([100, 100, 0, 0, 0, 0]);
    const seeded = seedPositions(3, Uint32Array.from([0, 1]), pos, Uint8Array.from([1, 0, 0]));
    expect([seeded[0], seeded[1]]).toEqual([100, 100]);
    expect(Math.hypot(seeded[2] - 100, seeded[3] - 100)).toBeLessThan(20);
  });

  it("handles thousands of nodes", () => {
    const n = 3000;
    const edges = ring(n);
    const sim = new ForceSim(n, edges, seedPositions(n, edges, new Float32Array(n * 2), new Uint8Array(n)), params);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) sim.tick();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect([...sim.pos].every(Number.isFinite)).toBe(true);
  });
});

describe("layout worker messages", () => {
  const init = (animate: boolean, extra = {}) => ({
    type: "init" as const,
    count: 20,
    edges: ring(20),
    positions: new Float32Array(40),
    known: new Uint8Array(20),
    params,
    animate,
    ...extra,
  });

  it("sends the seeded positions at once, then progress, then done", () => {
    const h = harness();
    h.handle(init(true));
    expect(h.out).toHaveLength(1);
    expect(h.out[0].positions).toHaveLength(40);
    expect(h.out[0].done).toBe(false);
    h.flush();
    expect(h.out.length).toBeGreaterThan(2);
    expect(h.out.at(-1)!.done).toBe(true);
    expect(h.out.filter((m) => m.done)).toHaveLength(1);
  });

  it("without animation only the resting layout follows the first frame", () => {
    const h = harness();
    h.handle(init(false));
    h.flush();
    expect(h.out.map((m) => m.done)).toEqual([false, true]);
  });

  it("a cached layout with a low alpha rests quickly", () => {
    const h = harness();
    h.handle(init(true, { alpha: 0.001 }));
    expect(h.out).toHaveLength(1);
    expect(h.out[0].done).toBe(true);
    expect(h.pending()).toBe(0);
  });

  it("drag pins the node and wakes the layout; stop ends it", () => {
    const h = harness();
    h.handle(init(false));
    h.flush();
    h.out.length = 0;
    h.handle({ type: "drag", index: 3, x: 500, y: -500 });
    h.flush(3);
    expect(h.out.length).toBeGreaterThan(0);
    const last = h.out.at(-1)!;
    expect([last.positions[6], last.positions[7]]).toEqual([500, -500]);
    h.handle({ type: "release", index: 3 });
    h.handle({ type: "stop" });
    const before = h.out.length;
    h.flush();
    expect(h.out.length).toBe(before);
  });

  it("new forces reheat the layout", () => {
    const h = harness();
    h.handle(init(false));
    h.flush();
    h.out.length = 0;
    h.handle({ type: "params", params: { center: 1, repel: 0, linkDistance: 0 } });
    h.flush();
    expect(h.out.at(-1)!.done).toBe(true);
  });
});
