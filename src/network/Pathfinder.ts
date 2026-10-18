import type { RoadGraph, Node, Edge } from './RoadGraph.ts';
import { CAR_LEN, GAP } from './RoadGraph.ts';
import { TIERS } from '../core/config.ts';
import { dist } from '../util/geom.ts';
import { ANY, banned, moveOf } from './Junction.ts';

// Heuristic speed: the fastest tier, so the straight-line time never overestimates
const VMAX = Math.max(...Object.values(TIERS).map(t => t.limit));

// A* on travel time: length / tier limit (/ an event's slow factor) × congestion of the outgoing lanes (free: empty roads); 'avoid' and
// edges shut by an event are treated as closed.
// States are (node, edge it was entered by), so a turn ban depends on the approach and a detour may come back through a junction;
// via: the edge the start was entered by; mask: the moves allowed at the start (a car's lane arrows). No U-turns past the start.
interface State { n: Node; e: Edge | null; g: number; prev: State | null }
// State key + 1 (0: the start entered by no edge)
const key = (n: Node, e: Edge | null): number => e ? e.id * 2 + +(e.b === n) + 1 : 0;
// Reused across searches: best g and closed flags per state key, valid only where stamped with this search's generation
let gen = 0, gAt = new Float64Array(1024), gGen = new Uint32Array(1024), shut = new Uint32Array(1024);
const fit = (k: number): void => {
  if (k < gGen.length) return;
  const n = Math.max(k + 1, gGen.length * 2), g2 = new Float64Array(n), s2 = new Uint32Array(n), c2 = new Uint32Array(n);
  g2.set(gAt); s2.set(gGen); c2.set(shut);
  gAt = g2; gGen = s2; shut = c2;
};
// binary min-heap on f (parallel arrays); an entry made stale by a cheaper g found later is skipped when popped (closed)
const hf: number[] = [], hs: State[] = [];
const push = (f: number, st: State): void => {
  let i = hf.length;
  hf.push(f); hs.push(st);
  while (i) {
    const p = (i - 1) >> 1;
    if (hf[p] <= f) break;
    hf[i] = hf[p]; hs[i] = hs[p];
    i = p;
  }
  hf[i] = f; hs[i] = st;
};
const pop = (): State => {
  const top = hs[0], f = hf.pop()!, st = hs.pop()!, n = hf.length;
  if (n) {
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i, mf = f;
      if (l < n && hf[l] < mf) { m = l; mf = hf[l]; }
      if (r < n && hf[r] < mf) m = r;
      if (m === i) break;
      hf[i] = hf[m]; hs[i] = hs[m];
      i = m;
    }
    hf[i] = f; hs[i] = st;
  }
  return top;
};

export function findPath(graph: RoadGraph, start: Node, goal: Node, avoid: Edge | null = null, free = false, via: Edge | null = null, mask = ANY): Node[] | null {
  if (start === goal) return [start];
  if (++gen === 0xffffffff) { gen = 1; gGen.fill(0); shut.fill(0); }
  hf.length = hs.length = 0;
  push(dist(start, goal) / VMAX, { n: start, e: via, g: 0, prev: null });

  while (hf.length) {
    const cur = pop(), k = key(cur.n, cur.e);
    fit(k);
    if (shut[k] === gen) continue;
    if (cur.n === goal) {
      const path: Node[] = [];
      for (let s: State | null = cur; s; s = s.prev) path.push(s.n);
      hf.length = hs.length = 0;
      return path.reverse();
    }
    shut[k] = gen;
    for (const e of cur.n.edges) {
      const next = e.a === cur.n ? e.b : e.a, nk = key(next, e);
      fit(nk);
      if (shut[nk] === gen || e === avoid || graph.shut.has(e) || (e === cur.e && cur.prev) || (cur.e && banned(cur.n, cur.e, e))
        || (cur.e && !cur.prev && !(mask >> moveOf(cur.n, cur.e, e) & 1))) continue;
      const lanes = graph.lanesFrom(e, cur.n);
      if (!lanes.length) continue;
      let cars = 0;
      if (!free) for (const l of lanes) cars += l.cars.length;
      const load = cars * (CAR_LEN + GAP) / (e.length * lanes.length);
      const cost = cur.g + e.length / TIERS[e.type.tier].limit / ((graph.slow.size ? graph.slow.get(e) : undefined) ?? 1) * (1 + 3 * load);
      if (cost < (gGen[nk] === gen ? gAt[nk] : Infinity)) {
        gAt[nk] = cost; gGen[nk] = gen;
        push(cost + dist(next, goal) / VMAX, { n: next, e, g: cost, prev: cur });
      }
    }
  }
  return null;
}
