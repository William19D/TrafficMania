import type { Vec } from '../util/geom.ts';
import { dist, distToSegment, segmentsCross } from '../util/geom.ts';
import type { City } from '../entities/City.ts';
import { CITY_R } from '../entities/City.ts';
import type { Car } from '../entities/Car.ts';

export const TILE = 40, ROAD_W = 18, LANE_OFFSET = 4.5, NODE_R = 12, CAR_LEN = 12, CAR_W = 7, GAP = 5, LIGHT_PERIOD = 5;

export type Control = 'none' | 'light' | 'roundabout';

export interface Node {
  id: number; x: number; y: number; edges: Edge[]; city: City | null; control: Control;
  occupants: Set<Car>; queue: Car[]; phase: number; phaseTimer: number;
}

// INVARIANT: cars sorted ascending by s; the last one is the furthest ahead.
export interface Lane { edge: Edge; from: Node; to: Node; cars: Car[] }

export interface Edge {
  id: number; a: Node; b: Node; length: number; lanes: [Lane, Lane];
  bridge: boolean; tunnel: boolean; level: number; refund: { bridges: number; tunnels: number };
}

export interface EdgeFlags { bridge: boolean; tunnel: boolean; level: number }

// Traffic light phase group: opposite approaches share a group
export function lightGroup(n: Node, e: Edge): number {
  const o = e.a === n ? e.b : e.a;
  const angle = Math.atan2(o.y - n.y, o.x - n.x);
  return ((Math.round(angle / (Math.PI / 2)) % 2) + 2) % 2;
}

export class RoadGraph {
  nodes: Node[] = [];
  edges: Edge[] = [];
  private nextId = 1;

  addNode(x: number, y: number, city: City | null = null): Node {
    const n: Node = { id: this.nextId++, x, y, edges: [], city, control: 'none', occupants: new Set(), queue: [], phase: 0, phaseTimer: 0 };
    if (city) city.node = n;
    this.nodes.push(n);
    return n;
  }

  addEdge(a: Node, b: Node, flags: EdgeFlags, refund?: { bridges: number; tunnels: number }): Edge {
    const e = {
      id: this.nextId++, a, b, length: dist(a, b),
      bridge: flags.bridge, tunnel: flags.tunnel, level: flags.level,
      refund: refund ?? { bridges: flags.bridge ? 1 : 0, tunnels: flags.tunnel ? 1 : 0 },
    } as Edge;
    e.lanes = [{ edge: e, from: a, to: b, cars: [] }, { edge: e, from: b, to: a, cars: [] }];
    a.edges.push(e);
    b.edges.push(e);
    this.edges.push(e);
    return e;
  }

  // Unlinks the edge without deleting nodes
  private unlink(e: Edge): void {
    this.edges = this.edges.filter(x => x !== e);
    e.a.edges = e.a.edges.filter(x => x !== e);
    e.b.edges = e.b.edges.filter(x => x !== e);
  }

  private dropIfOrphan(n: Node): void {
    if (n.edges.length === 0 && !n.city) this.nodes = this.nodes.filter(x => x !== n);
  }

  removeEdge(e: Edge): Car[] {
    this.unlink(e);
    this.dropIfOrphan(e.a);
    this.dropIfOrphan(e.b);
    return [...e.lanes[0].cars, ...e.lanes[1].cars];
  }

  splitEdge(e: Edge, p: Vec): Node {
    const { a, b } = e;
    const flags: EdgeFlags = { bridge: e.bridge, tunnel: e.tunnel, level: e.level };
    const n = this.addNode(p.x, p.y);
    this.unlink(e);
    const e1 = this.addEdge(a, n, flags, e.refund);
    const e2 = this.addEdge(n, b, flags, { bridges: 0, tunnels: 0 });
    // Distributes the cars keeping ascending order (iterated from lowest to highest s)
    const move = (cars: Car[], first: Lane, second: Lane, cut: number) => {
      for (const c of cars) {
        if (c.s < cut) {
          // Now heading to the new node: release turn/queue of the old destination
          const old = second.to;
          if (c.granted === old) { old.occupants.delete(c); c.granted = null; }
          c.queued = false;
          first.cars.push(c); c.lane = first;
        }
        else { c.s -= cut; second.cars.push(c); c.lane = second; }
        c.path = null;
      }
    };
    move(e.lanes[0].cars, e1.lanes[0], e2.lanes[0], e1.length);  // a->b: a->N then N->b
    move(e.lanes[1].cars, e2.lanes[1], e1.lanes[1], e2.length);  // b->a: b->N then N->a
    e.lanes[0].cars = [];
    e.lanes[1].cars = [];
    return n;
  }

  edgeBetween(a: Node, b: Node): Edge | null {
    return a.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a)) ?? null;
  }

  laneFrom(e: Edge, from: Node): Lane {
    return e.a === from ? e.lanes[0] : e.lanes[1];
  }

  lanePos(lane: Lane, s: number): { x: number; y: number; angle: number } {
    const dx = lane.to.x - lane.from.x, dy = lane.to.y - lane.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    return {
      x: lane.from.x + ux * s - uy * LANE_OFFSET,
      y: lane.from.y + uy * s + ux * LANE_OFFSET,
      angle: Math.atan2(uy, ux),
    };
  }

  // A node can take a road of this level: cities and bare nodes always, otherwise it needs an edge of that level.
  nodeLevelOk(n: Node, level: number): boolean {
    return !!n.city || n.edges.length === 0 || n.edges.some(e => e.level === level);
  }

  nearestNode(p: Vec, r: number, level?: number): Node | null {
    let best: Node | null = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (level !== undefined && !this.nodeLevelOk(n, level)) continue;
      const d = dist(p, n);
      if (d <= (n.city ? CITY_R : r) && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  nearestEdge(p: Vec, r: number, level?: number): { edge: Edge; point: Vec; t: number } | null {
    let best: { edge: Edge; point: Vec; t: number } | null = null, bestD = Infinity;
    for (const e of this.edges) {
      if (level !== undefined && e.level !== level) continue;
      const h = distToSegment(p, e.a, e.b);
      if (h.d <= r && h.d < bestD) { best = { edge: e, point: h.point, t: h.t }; bestD = h.d; }
    }
    return best;
  }

  crossings(a: Vec, b: Vec, excludeNodes: Set<Node>, excludeEdges: Set<Edge>, level: number): { edge: Edge; point: Vec; t: number; node: Node | null }[] {
    const out: { edge: Edge; point: Vec; t: number; node: Node | null }[] = [];
    for (const e of this.edges) {
      if (e.level !== level || excludeEdges.has(e) || excludeNodes.has(e.a) || excludeNodes.has(e.b)) continue;
      const x = segmentsCross(a, b, e.a, e.b);
      if (!x) continue;
      const point = { x: a.x + (b.x - a.x) * x.t, y: a.y + (b.y - a.y) * x.t };
      const node = dist(point, e.a) < NODE_R ? e.a : dist(point, e.b) < NODE_R ? e.b : null;
      out.push({ edge: e, point, t: x.t, node });
    }
    return out.sort((p, q) => p.t - q.t);
  }

  needsControl(n: Node): boolean {
    return n.edges.length >= 3 || n.control !== 'none';
  }

  private grant(n: Node, c: Car): void {
    c.granted = n;
    n.occupants.add(c);
  }

  update(dt: number): void {
    for (const n of this.nodes) {
      n.queue = n.queue.filter(c => c.lane.to === n);
      if (n.control === 'light') {
        n.phaseTimer += dt;
        if (n.phaseTimer >= LIGHT_PERIOD) { n.phaseTimer = 0; n.phase ^= 1; }
        n.queue = n.queue.filter(c => {
          if (lightGroup(n, c.lane.edge) !== n.phase) return true;
          this.grant(n, c);
          return false;
        });
      } else {
        // FIFO: arrival order; the roundabout admits up to 3 cars at once
        const cap = n.control === 'roundabout' ? 3 : 1;
        while (n.queue.length && n.occupants.size < cap) this.grant(n, n.queue.shift()!);
      }
    }
  }

  detachCar(c: Car): void {
    const i = c.lane.cars.indexOf(c);
    if (i >= 0) c.lane.cars.splice(i, 1);
    c.granted?.occupants.delete(c);
    c.clearing?.occupants.delete(c);
    const q = c.lane.to.queue, j = q.indexOf(c);
    if (j >= 0) q.splice(j, 1);
  }
}
