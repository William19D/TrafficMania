import type { RoadGraph, Node, Edge } from './RoadGraph.ts';
import { CAR_LEN, GAP } from './RoadGraph.ts';
import { TIERS } from '../core/config.ts';
import { dist } from '../util/geom.ts';

// Heuristic speed: the fastest tier, so the straight-line time never overestimates
const VMAX = Math.max(...Object.values(TIERS).map(t => t.limit));

// A* on travel time: length / tier limit × congestion of the outgoing lanes; 'avoid' is treated as closed
export function findPath(graph: RoadGraph, start: Node, goal: Node, avoid: Edge | null = null): Node[] | null {
  if (start === goal) return [start];
  const g = new Map<Node, number>([[start, 0]]);
  const came = new Map<Node, Node>();
  const closed = new Set<Node>();
  // binary min-heap on f; an entry made stale by a cheaper g found later is skipped when popped (closed)
  const heap: [number, Node][] = [];
  const push = (f: number, n: Node): void => {
    let i = heap.push([f, n]) - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= f) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = (): Node => {
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
  push(dist(start, goal) / VMAX, start);

  while (heap.length) {
    const cur = pop();
    if (closed.has(cur)) continue;
    if (cur === goal) {
      const path = [cur];
      let n = cur;
      while (came.has(n)) { n = came.get(n)!; path.unshift(n); }
      return path;
    }
    closed.add(cur);
    for (const e of cur.edges) {
      const next = e.a === cur ? e.b : e.a;
      if (closed.has(next) || e === avoid) continue;
      const lanes = graph.lanesFrom(e, cur);
      if (!lanes.length) continue;
      const cars = lanes.reduce((n, l) => n + l.cars.length, 0);
      const load = cars * (CAR_LEN + GAP) / (e.length * lanes.length);
      const cost = g.get(cur)! + e.length / TIERS[e.type.tier].limit * (1 + 3 * load);
      if (cost < (g.get(next) ?? Infinity)) {
        g.set(next, cost);
        came.set(next, cur);
        push(cost + dist(next, goal) / VMAX, next);
      }
    }
  }
  return null;
}
