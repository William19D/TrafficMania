import type { Vec } from '../util/geom.ts';
import { dist, distToSegment, segmentsCross } from '../util/geom.ts';
import type { Building } from '../entities/Building.ts';
import { DOOR_R } from '../entities/Building.ts';
import type { Car } from '../entities/Car.ts';
import { TIERS, TUNING } from '../core/config.ts';
import type { Tier } from '../core/config.ts';
import type { JunctionPlan, Move } from './Junction.ts';
import { LEFT, approachOf, mainEdges, moveOf, oppositeOf, planOf, turnAt } from './Junction.ts';
export { LIGHT_PERIOD, lightGroup } from './Junction.ts';

export const TILE = 40, ROAD_W = 18, LANE_OFFSET = 4.5, NODE_R = 12, CAR_LEN = 15, CAR_W = 8, GAP = 5;
// Roundabout ring (centre line radius) and where an approach lane meets it
export const RING_R = NODE_R + 5, RING_IN = Math.sqrt(RING_R * RING_R - LANE_OFFSET * LANE_OFFSET);
// Where a car stops before a junction (distance from the node): outside the ring on roundabouts
export const stopDist = (n: Node): number => n.control === 'roundabout' ? RING_R + ROAD_W / 2 + 4 : NODE_R + 3;
// Mid-edge lane change: slide seconds, and how far from both nodes it may start (past the node blends, the slide done
// before the end, room left for cars granted into the lane)
export const LC_S = 0.6, LC_M = 110;

// Road types: tier (config TIERS), lanes PER DIRECTION; a one-way road only has lanes a->b
export const LANE_W = 9;
export interface RoadType { tier: Tier; lanes: 1 | 2 | 3; oneWay: boolean }
export const DEFAULT_TYPE: RoadType = { tier: 'street', lanes: 1, oneWay: false };
// Half the median: how far a two-way road's lanes sit out from the centre line
const halfMedian = (t: RoadType): number => t.oneWay ? 0 : TIERS[t.tier].median / 2;
export const roadWidth = (t: RoadType): number => t.lanes * (t.oneWay ? 1 : 2) * LANE_W + 2 * TIERS[t.tier].shoulder + 2 * halfMedian(t);
// Asphalt multiplier per tile (a two-way 1-lane road = 1)
export const laneFactor = (t: RoadType): number => (t.lanes * (t.oneWay ? 1 : 2)) / 2;
export const sameType = (a: RoadType, b: RoadType): boolean => a.tier === b.tier && a.lanes === b.lanes && a.oneWay === b.oneWay;
// Clamps lanes into the tier's range and drops one-way where the tier has none
export const fitType = (t: RoadType): RoadType => {
  const T = TIERS[t.tier];
  const lanes = Math.max(T.lanes[0], Math.min(T.lanes[T.lanes.length - 1], t.lanes)) as RoadType['lanes'];
  return { tier: t.tier, lanes, oneWay: t.oneWay && T.oneWay };
};

// none: one car at a time in arrival order; yield: the main road (mainEdges) goes, side roads give way; stop: all-way stop
export type Control = 'none' | 'yield' | 'stop' | 'light' | 'roundabout';

export interface Node {
  id: number; x: number; y: number; edges: Edge[]; building: Building | null; control: Control;
  occupants: Set<Car>; queue: Car[]; phase: number; phaseTimer: number;
  controlDay: number; // day the control was built (refund rule)
  plan: JunctionPlan | null; // edited phases / turn bans; null = the default plan (Junction.planOf)
  delay: number; // EMA of the mean stopped seconds of the cars queued at it (heat map)
}

// INVARIANT: cars sorted ascending by s; the last one is the furthest ahead.
// offset: lateral px to the right of travel
export interface Lane { edge: Edge; from: Node; to: Node; cars: Car[]; offset: number }

export interface Edge {
  id: number; a: Node; b: Node; length: number; lanes: Lane[]; type: RoadType; width: number;
  bridge: boolean; tunnel: boolean; level: number;
  day: number; // build day (refund rule); a split keeps it
  drive: boolean; // auto driveway to a building: free, no upkeep, no refund
  heat: number; // congestion EMA 0..1: the larger of density and slowness (1 - speed / top speed) of its cars
}

export interface EdgeFlags { bridge: boolean; tunnel: boolean; level: number; type: RoadType; drive?: boolean }

export class RoadGraph {
  nodes: Node[] = [];
  edges: Edge[] = [];
  // Edges ignored by snapping / crossings / edgeBetween; only set while planning a bend
  hidden: Set<Edge> = new Set();
  private nextId = 1;

  addNode(x: number, y: number, building: Building | null = null): Node {
    const n: Node = { id: this.nextId++, x, y, edges: [], building, control: 'none', occupants: new Set(), queue: [], phase: 0, phaseTimer: 0, controlDay: 0, plan: null, delay: 0 };
    if (building) building.node = n;
    this.nodes.push(n);
    return n;
  }

  addEdge(a: Node, b: Node, flags: EdgeFlags, day = 0): Edge {
    const e = {
      id: this.nextId++, a, b, length: dist(a, b),
      bridge: flags.bridge, tunnel: flags.tunnel, level: flags.level, day, drive: !!flags.drive, heat: 0,
    } as Edge;
    this.buildLanes(e, flags.type);
    a.edges.push(e);
    b.edges.push(e);
    this.edges.push(e);
    return e;
  }

  // Two-way: lane k sits (k + 0.5) lanes (plus half the median) right of the centre line; one-way: lanes centred on the axis
  private buildLanes(e: Edge, t: RoadType): void {
    e.type = { ...t };
    e.width = roadWidth(t);
    e.lanes = [];
    const lane = (from: Node, to: Node, offset: number): Lane => ({ edge: e, from, to, cars: [], offset });
    const m = halfMedian(t);
    for (let k = 0; k < t.lanes; k++) {
      if (t.oneWay) e.lanes.push(lane(e.a, e.b, (k - (t.lanes - 1) / 2) * LANE_W));
      else e.lanes.push(lane(e.a, e.b, (k + 0.5) * LANE_W + m), lane(e.b, e.a, (k + 0.5) * LANE_W + m));
    }
  }

  // Unlinks the edge without deleting nodes
  private unlink(e: Edge): void {
    this.edges = this.edges.filter(x => x !== e);
    e.a.edges = e.a.edges.filter(x => x !== e);
    e.b.edges = e.b.edges.filter(x => x !== e);
  }

  private dropIfOrphan(n: Node): void {
    if (n.edges.length === 0 && !n.building) this.nodes = this.nodes.filter(x => x !== n);
  }

  removeEdge(e: Edge): Car[] {
    this.unlink(e);
    this.dropIfOrphan(e.a);
    this.dropIfOrphan(e.b);
    return e.lanes.flatMap(l => l.cars);
  }

  splitEdge(e: Edge, p: Vec): Node {
    const { a, b } = e;
    const flags: EdgeFlags = { bridge: e.bridge, tunnel: e.tunnel, level: e.level, type: e.type, drive: e.drive };
    const n = this.addNode(p.x, p.y);
    this.unlink(e);
    const e1 = this.addEdge(a, n, flags, e.day);
    const e2 = this.addEdge(n, b, flags, e.day);
    e1.heat = e2.heat = e.heat;
    // Distributes the cars keeping ascending order (iterated from lowest to highest s)
    const move = (old: Lane) => {
      const k = this.lanesFrom(e, old.from).indexOf(old);
      const fwd = old.from === a;
      const first = this.lanesFrom(fwd ? e1 : e2, old.from)[k];
      const second = this.lanesFrom(fwd ? e2 : e1, n)[k];
      const cut = fwd ? e1.length : e2.length;
      for (const c of old.cars) {
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
      old.cars = [];
    };
    for (const l of e.lanes) move(l);
    return n;
  }

  // Re-types one edge in place; forward=false makes b->a the travel direction (swaps a/b).
  // Cars keep their direction and s; cars whose direction no longer exists are detached and returned.
  setEdgeType(e: Edge, type: RoadType, forward: boolean): Car[] {
    const old = e.lanes;
    if (!forward) [e.a, e.b] = [e.b, e.a];
    this.buildLanes(e, type);
    const lost: Car[] = [];
    for (const l of old) {
      const k = old.filter(x => x.from === l.from).indexOf(l);
      for (const c of l.cars) {
        const nl = this.lanesFrom(e, l.from)[k] ?? this.pickLane(e, l.from);
        if (!nl) { lost.push(c); continue; }
        c.lane = nl;
        nl.cars.push(c);
      }
    }
    for (const l of e.lanes) l.cars.sort((p, q) => p.s - q.s);
    for (const c of lost) this.detachCar(c);
    return lost;
  }

  // Maximal chain of edges through e between doors / junctions / controlled nodes / dead ends.
  // edges[i] joins nodes[i] and nodes[i+1].
  runOf(e: Edge): { edges: Edge[]; nodes: Node[] } {
    const inner = (n: Node) => !n.building && n.edges.length === 2 && n.control === 'none';
    const other = (x: Edge, n: Node) => x.a === n ? x.b : x.a;
    const step = (x: Edge, n: Node) => n.edges[0] === x ? n.edges[1] : n.edges[0];
    let n = e.a, cur = e;
    while (inner(n) && step(cur, n) !== e) { cur = step(cur, n); n = other(cur, n); }
    const edges = [cur], nodes = [n, other(cur, n)];
    for (let m = nodes[1]; inner(m) && step(cur, m) !== edges[0];) {
      cur = step(cur, m);
      m = other(cur, m);
      edges.push(cur);
      nodes.push(m);
    }
    return { edges, nodes };
  }

  edgeBetween(a: Node, b: Node): Edge | null {
    return a.edges.find(e => !this.hidden.has(e) && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) ?? null;
  }

  // Lanes travelling away from 'from'; [] when the road is one-way against
  lanesFrom(e: Edge, from: Node): Lane[] {
    return e.lanes.filter(l => l.from === from);
  }

  // Turn at the first junction from path[j] on (inner nodes of a bent road don't count): 1 right, -1 left or U-turn, 0 straight / none
  // from: the node before path[0], for j = 0
  turn(path: Node[], j: number, from?: Node): number {
    for (; j < path.length - 1; j++) {
      const n = path[j]!;
      if (!n.building && n.edges.length === 2 && n.control === 'none') continue;
      return turnAt(path[j - 1] ?? from!, n, path[j + 1]!);
    }
    return 0;
  }

  // Lane for the turn after this edge: rightmost / leftmost (lanesFrom is ascending by offset), straight: the most room at its start
  pickLane(e: Edge, from: Node, turn = 0): Lane | null {
    const ls = this.lanesFrom(e, from);
    if (turn) return ls[turn > 0 ? ls.length - 1 : 0] ?? null;
    let best: Lane | null = null, room = -1;
    for (const l of ls) {
      const r = l.cars[0]?.s ?? Infinity;
      if (r > room) { best = l; room = r; }
    }
    return best;
  }

  lanePos(lane: Pick<Lane, 'from' | 'to' | 'offset'>, s: number, offset = lane.offset): { x: number; y: number; angle: number } {
    const dx = lane.to.x - lane.from.x, dy = lane.to.y - lane.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    return {
      x: lane.from.x + ux * s - uy * offset,
      y: lane.from.y + uy * s + ux * offset,
      angle: Math.atan2(uy, ux),
    };
  }

  // Render position of a car: on the roundabout ring while crossing one, else along its lane.
  // At plain nodes the lateral offset blends halfway toward the next / from the previous lane.
  carPos(c: Car): { x: number; y: number; angle: number } {
    const lane = c.lane, remaining = lane.edge.length - c.s;
    const next = c.path?.[1];
    if (lane.to.control === 'roundabout' && remaining < RING_IN && next) return this.ringPos(lane.to, lane.from, next, RING_IN - remaining);
    if (lane.from.control === 'roundabout' && c.s < RING_IN && c.prev) return this.ringPos(lane.from, c.prev, lane.to, RING_IN + c.s);
    // U-turn back down the same edge (dead end / one-way ahead): half circle in the last and first NODE_R
    if (next === lane.from && c.exit?.edge === lane.edge && remaining < NODE_R && lane.to.control !== 'roundabout') return this.uturnPos(lane, c.exit.offset, NODE_R - remaining);
    if (c.prev === lane.to && c.s < NODE_R && lane.from.control !== 'roundabout') return this.uturnPos({ ...lane, from: lane.to, to: lane.from, offset: c.prevOffset }, lane.offset, NODE_R + c.s);
    // Plain junction: a Bezier arc over the last / first NODE_R or so of the two lanes (exit is stale for a tick after a hand-off)
    const nl = c.exit;
    if (nl && next === nl.to && next !== lane.from && lane.to.control !== 'roundabout') {
      const q = this.arcPos(lane.from, lane.to, nl.to, lane.offset, nl.offset, -remaining);
      if (q) return q;
    }
    if (c.prev && c.prev !== lane.to && lane.from.control !== 'roundabout') {
      const q = this.arcPos(c.prev, lane.from, lane.to, c.prevOffset, lane.offset, c.s);
      if (q) return q;
    }
    const B = 2 * NODE_R;
    let off = lane.offset;
    if (nl && next === nl.to && remaining < B && lane.to.control !== 'roundabout') off += (nl.offset - lane.offset) * 0.5 * (1 - remaining / B);
    if (c.prev && c.s < B && lane.from.control !== 'roundabout') off += (c.prevOffset - lane.offset) * 0.5 * (1 - c.s / B);
    // roundabouts: the ring is a single lane at LANE_OFFSET, so outer lanes slide inward before entering / after leaving it
    if (lane.to.control === 'roundabout' && remaining < RING_IN + B) off += (LANE_OFFSET - lane.offset) * (1 - (remaining - RING_IN) / B);
    if (lane.from.control === 'roundabout' && c.s < RING_IN + B) off += (LANE_OFFSET - lane.offset) * (1 - (c.s - RING_IN) / B);
    if (!c.lc) return this.lanePos(lane, c.s, off);
    // mid-edge lane change: smoothstep slide from the old lane, nose turned along the sideways speed
    const u = c.lc / LC_S, q = this.lanePos(lane, c.s, off + c.lcOff * u * u * (3 - 2 * u));
    return { ...q, angle: q.angle + Math.atan2(-c.lcOff * 6 * u * (1 - u) / LC_S, Math.max(c.speed, 40)) };
  }

  // Cubic Bezier across node n from lane a->n (offset oi) onto n->b (offset oo); x = signed distance past n, the arc spans |x| <= r
  // (NODE_R on single-lane roads).
  // Its ends sit where the straight lane's halfway offset blend is, tangent to the lanes, so the hand-off is seamless.
  // ponytail: ignores the roundabout / next-node blends that only reach the ends on edges under ~3 NODE_R; a glitch there is cosmetic
  private arcPos(a: Node, n: Node, b: Node, oi: number, oo: number, x: number): { x: number; y: number; angle: number } | null {
    // outer lanes of wide roads start the arc earlier, or a turn from one onto an inner lane is a hook
    const la = dist(a, n), r = Math.min(NODE_R + Math.max(Math.abs(oi), Math.abs(oo)) - LANE_OFFSET, 2 * NODE_R, la / 2, dist(n, b) / 2);
    if (x < -r || x > r) return null;
    const f = 0.5 - r / (4 * NODE_R);
    const P = this.lanePos({ from: a, to: n, offset: 0 }, la - r, oi + (oo - oi) * f);
    const Q = this.lanePos({ from: n, to: b, offset: 0 }, r, oo + (oi - oo) * f);
    const t = (x + r) / (2 * r), m = 1 - t, d = Math.hypot(Q.x - P.x, Q.y - P.y) * 0.4;
    const x1 = P.x + Math.cos(P.angle) * d, y1 = P.y + Math.sin(P.angle) * d, x2 = Q.x - Math.cos(Q.angle) * d, y2 = Q.y - Math.sin(Q.angle) * d;
    const bz = (p0: number, p1: number, p2: number, p3: number) => m * m * m * p0 + 3 * m * t * (m * p1 + t * p2) + t * t * t * p3;
    const dz = (p0: number, p1: number, p2: number, p3: number) => m * m * (p1 - p0) + 2 * m * t * (p2 - p1) + t * t * (p3 - p2);
    return { x: bz(P.x, x1, x2, Q.x), y: bz(P.y, y1, y2, Q.y), angle: Math.atan2(dz(P.y, y1, y2, Q.y), dz(P.x, x1, x2, Q.x)) };
  }

  // Left turn from lane l (offset l.offset) onto the opposite lane (offset oo), NODE_R before l.to; p = 0..2*NODE_R
  private uturnPos(l: Lane, oo: number, p: number): { x: number; y: number; angle: number } {
    const t = Math.PI * Math.min(1, p / (2 * NODE_R)), r = (l.offset + oo) / 2;
    const q = this.lanePos(l, l.edge.length - NODE_R + r * Math.sin(t), (l.offset - oo) / 2 + r * Math.cos(t));
    return { ...q, angle: q.angle - t };
  }

  // Counter-clockwise (on screen) around n from the 'from' approach to the 'to' exit; p = straight-line progress 0..2*RING_IN
  private ringPos(n: Node, from: Node, to: Node, p: number): { x: number; y: number; angle: number } {
    const d = Math.asin(LANE_OFFSET / RING_R);
    const a = Math.atan2(from.y - n.y, from.x - n.x) - d;
    const b = Math.atan2(to.y - n.y, to.x - n.x) + d;
    let arc = (a - b) % (Math.PI * 2);
    if (arc <= 0) arc += Math.PI * 2;
    const ang = a - arc * (p / (2 * RING_IN));
    return { x: n.x + Math.cos(ang) * RING_R, y: n.y + Math.sin(ang) * RING_R, angle: ang - Math.PI / 2 };
  }

  // A node takes a road of this level when all its roads are on it (a ramp joint, on two levels, takes none); doors take ground roads
  nodeLevelOk(n: Node, level: number): boolean {
    return n.building ? level === 0 : n.edges.every(e => this.hidden.has(e) || e.level === level);
  }

  // Level of a node's roads: NaN for a ramp joint (two levels), 'bare' for a node without roads; doors are ground
  levelOf(n: Node, bare = NaN): number {
    if (n.building) return 0;
    const ls = new Set(n.edges.filter(e => !this.hidden.has(e)).map(e => e.level));
    return ls.size === 1 ? [...ls][0] : ls.size ? NaN : bare;
  }

  nearestNode(p: Vec, r: number, level?: number): Node | null {
    let best: Node | null = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (level !== undefined && !this.nodeLevelOk(n, level)) continue;
      if (!n.building && n.edges.length && n.edges.every(e => this.hidden.has(e))) continue;
      const d = dist(p, n);
      if (d <= (n.building ? DOOR_R : r) && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  nearestEdge(p: Vec, r: number, level?: number): { edge: Edge; point: Vec; t: number } | null {
    let best: { edge: Edge; point: Vec; t: number } | null = null, bestD = Infinity;
    for (const e of this.edges) {
      if ((level !== undefined && e.level !== level) || this.hidden.has(e)) continue;
      const h = distToSegment(p, e.a, e.b);
      // ponytail: wider roads widen the hit radius; default roads keep r exactly
      if (h.d <= r + Math.max(0, (e.width - ROAD_W) / 2) && h.d < bestD) { best = { edge: e, point: h.point, t: h.t }; bestD = h.d; }
    }
    return best;
  }

  crossings(a: Vec, b: Vec, excludeNodes: Set<Node>, excludeEdges: Set<Edge>, level: number): { edge: Edge; point: Vec; t: number; node: Node | null }[] {
    const out: { edge: Edge; point: Vec; t: number; node: Node | null }[] = [];
    for (const e of this.edges) {
      if (e.level !== level || excludeEdges.has(e) || this.hidden.has(e) || excludeNodes.has(e.a) || excludeNodes.has(e.b)) continue;
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

  // Don't block the box: the exit lane needs the car's length of room past the junction, after the cars already granted into it
  private fits(n: Node, c: Car): boolean {
    const l = c.exit;
    if (!l) return false;
    const f = l.cars[0];
    let room = (f ? f.s - f.len / 2 : Infinity) - CAR_LEN / 2 - stopDist(n);
    for (const o of n.occupants) if (o.granted === n && o.exit === l) room -= o.len + GAP;
    return room >= c.len + GAP;
  }

  update(dt: number): void {
    const k = Math.min(1, dt / TUNING.HEAT_TAU);
    for (const e of this.edges) {
      let n = 0, slow = 0;
      for (const l of e.lanes) for (const c of l.cars) { n++; slow += 1 - Math.min(1, c.speed / c.top(e)); }
      const x = n ? Math.max(n * (CAR_LEN + GAP) / (e.length * e.lanes.length), slow / n) : 0;
      e.heat += (Math.min(1, x) - e.heat) * k;
    }
    for (const n of this.nodes) {
      n.queue = n.queue.filter(c => c.lane.to === n);
      n.delay += ((n.queue.length ? n.queue.reduce((s, c) => s + c.wait, 0) / n.queue.length : 0) - n.delay) * k;
      const plan = n.control === 'light' || n.control === 'yield' || n.plan ? planOf(n) : null;
      if (n.control === 'light') {
        const ph = plan!.phases;
        n.phaseTimer += dt;
        if (n.phase >= ph.length) n.phase = 0;
        if (n.phaseTimer >= ph[n.phase].seconds) { n.phaseTimer = 0; n.phase = (n.phase + 1) % ph.length; }
      }
      if (!n.queue.length) continue;
      // Arrival order; lights and the main road of a yield junction admit every car their signal lets go, the roundabout up to 3,
      // the rest 1. A car that can't go holds back the cars queued behind it in its lane.
      const cap = n.control === 'light' || n.control === 'yield' ? Infinity : n.control === 'roundabout' ? 3 : 1;
      // Ambulance: its whole lane goes first (stable sort keeps the cars ahead of it in order) and runs red into an empty box
      const amb = new Set(n.queue.filter(c => c.kind === 'ambulance').map(c => c.lane));
      if (amb.size) n.queue.sort((p, q) => +amb.has(q.lane) - +amb.has(p.lane));
      // Approach and movement of every car queued at or granted into n (plan nodes only)
      const mv = new Map<Car, [number, Move]>();
      if (plan) for (const c of [...n.queue, ...n.occupants]) if (c.exit && c.lane.to === n) mv.set(c, [approachOf(plan, n, c.lane.edge), moveOf(n, c.lane.edge, c.exit.edge)]);
      const busy = (cars: Iterable<Car>, a: number, ok: (m: Move) => boolean): boolean => {
        for (const c of cars) { const x = mv.get(c); if (x && x[0] === a && ok(x[1])) return true; }
        return false;
      };
      // A left that only yields waits while the opposite approach has a straight or right car queued or in the box
      const opposed = (a: number): boolean => {
        const o = oppositeOf(plan!, a);
        return o >= 0 && (busy(n.queue, o, m => m !== LEFT) || busy(n.occupants, o, m => m !== LEFT));
      };
      const main = n.control === 'yield' ? mainEdges(n) : [];
      const may = (c: Car): boolean => {
        const x = mv.get(c);
        if (plan && (!x || plan.ban[x[0]][x[1]])) return false;
        if (n.control === 'light') {
          if (amb.has(c.lane) && !n.occupants.size) return true;
          const s = plan!.phases[n.phase].sig[x![0]][x![1]];
          return s === 2 || (s === 1 && (x![1] !== LEFT || !opposed(x![0])));
        }
        if (n.control === 'yield') {
          if (main.includes(c.lane.edge)) return x![1] !== LEFT || !opposed(x![0]);
          // a side road goes into an empty box with no main-road car waiting
          return !n.occupants.size && ![...n.queue].some(o => o !== c && main.includes(o.lane.edge));
        }
        // stop: only from a standstill at the line
        if (n.control === 'stop') return c.speed < 1 && c.lane.edge.length - c.s - stopDist(n) < GAP + 3;
        return true;
      };
      const held = new Set<Lane>();
      n.queue = n.queue.filter(c => {
        if (held.has(c.lane) || n.occupants.size >= cap || !may(c) || !this.fits(n, c)) {
          held.add(c.lane);
          return true;
        }
        this.grant(n, c);
        return false;
      });
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
