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
const key = (n: Node, e: Edge | null): number => e ? e.id * 2 + +(e.b === n) : -1;

export function findPath(graph: RoadGraph, start: Node, goal: Node, avoid: Edge | null = null, free = false, via: Edge | null = null, mask = ANY): Node[] | null {
  if (start === goal) return [start];
  const g = new Map<number, number>();
  const closed = new Set<number>();
  // binary min-heap on f; an entry made stale by a cheaper g found later is skipped when popped (closed)
  const heap: [number, State][] = [];
  const push = (f: number, n: State): void => {
    let i = heap.push([f, n]) - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= f) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = (): State => {
    const top = heap[0][1], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  push(dist(start, goal) / VMAX, { n: start, e: via, g: 0, prev: null });

  while (heap.length) {
    const cur = pop(), k = key(cur.n, cur.e);
    if (closed.has(k)) continue;
    if (cur.n === goal) {
      const path: Node[] = [];
      for (let s: State | null = cur; s; s = s.prev) path.unshift(s.n);
      return path;
    }
    closed.add(k);
    for (const e of cur.n.edges) {
      const next = e.a === cur.n ? e.b : e.a, nk = key(next, e);
      if (closed.has(nk) || e === avoid || graph.shut.has(e) || (e === cur.e && cur.prev) || (cur.e && banned(cur.n, cur.e, e))
        || (cur.e && !cur.prev && !(mask >> moveOf(cur.n, cur.e, e) & 1))) continue;
      const lanes = graph.lanesFrom(e, cur.n);
      if (!lanes.length) continue;
      const cars = free ? 0 : lanes.reduce((n, l) => n + l.cars.length, 0);
      const load = cars * (CAR_LEN + GAP) / (e.length * lanes.length);
      const cost = cur.g + e.length / TIERS[e.type.tier].limit / (graph.slow.get(e) ?? 1) * (1 + 3 * load);
      if (cost < (g.get(nk) ?? Infinity)) {
        g.set(nk, cost);
        push(cost + dist(next, goal) / VMAX, { n: next, e, g: cost, prev: cur });
      }
    }
  }
  return null;
}
