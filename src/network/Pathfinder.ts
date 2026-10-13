import type { RoadGraph, Node } from './RoadGraph.ts';
import { CAR_LEN, GAP } from './RoadGraph.ts';
import { dist } from '../util/geom.ts';

// A* with cost = length × congestion of the outgoing lane
// ponytail: open list with linear search, use a heap if the graph grows large
export function findPath(graph: RoadGraph, start: Node, goal: Node): Node[] | null {
  if (start === goal) return [start];
  const g = new Map<Node, number>([[start, 0]]);
  const f = new Map<Node, number>([[start, dist(start, goal)]]);
  const came = new Map<Node, Node>();
  const open: Node[] = [start];
  const closed = new Set<Node>();

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f.get(open[i])! < f.get(open[bi])!) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur === goal) {
      const path = [cur];
      let n = cur;
      while (came.has(n)) { n = came.get(n)!; path.unshift(n); }
      return path;
    }
    closed.add(cur);
    for (const e of cur.edges) {
      const next = e.a === cur ? e.b : e.a;
      if (closed.has(next)) continue;
      const lane = graph.laneFrom(e, cur);
      const load = lane.cars.length * (CAR_LEN + GAP) / e.length;
      const cost = g.get(cur)! + e.length * (1 + 3 * load);
      if (cost < (g.get(next) ?? Infinity)) {
        g.set(next, cost);
        f.set(next, cost + dist(next, goal));
        came.set(next, cur);
        if (!open.includes(next)) open.push(next);
      }
    }
  }
  return null;
}
