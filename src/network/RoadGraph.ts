import type { Vec } from '../util/geom.ts';
import { dist, distToSegment, segmentsCross } from '../util/geom.ts';
import type { Building } from '../entities/Building.ts';
import { DOOR_R } from '../entities/Building.ts';
import type { Car } from '../entities/Car.ts';
import { TIERS, TUNING } from '../core/config.ts';
import type { Tier } from '../core/config.ts';
import type { JunctionPlan, Move } from './Junction.ts';
import { LEFT, approachOf, edgeAngle, mainEdges, moveOf, oppositeOf, planOf, turnAt } from './Junction.ts';
export { LIGHT_PERIOD, lightGroup } from './Junction.ts';

export const TILE = 40, ROAD_W = 18, LANE_OFFSET = 4.5, NODE_R = 12, CAR_LEN = 15, CAR_W = 8, GAP = 5;
// Roundabout sizes: ring centre line radius, cars admitted at once, cost / upkeep multiplier
export type RingSize = 0 | 1 | 2;
export const RINGS: readonly { label: string; r: number; cap: number; cost: number }[] = [
  { label: 'Small', r: NODE_R + 5, cap: 3, cost: 1 },
  { label: 'Medium', r: NODE_R + 14, cap: 5, cost: 1.6 },
  { label: 'Large', r: NODE_R + 24, cap: 8, cost: 2.4 },
];
export const ringR = (n: Node): number => RINGS[n.ring].r;
// where an approach lane meets the ring
export const ringIn = (n: Node): number => Math.sqrt(ringR(n) ** 2 - LANE_OFFSET * LANE_OFFSET);
// Where a car stops before a junction (distance from the node): outside the ring on roundabouts
export const ringStop = (r: RingSize): number => RINGS[r].r + ROAD_W / 2 + 4;
export const stopDist = (n: Node): number => n.control === 'roundabout' ? ringStop(n.ring) : NODE_R + 3;
// How far from n a car is out of its box: off the ring on roundabouts
export const boxR = (n: Node): number => n.control === 'roundabout' ? ringIn(n) : NODE_R;
// Mid-edge lane change: slide seconds, and how far from both nodes it may start (past the node blends, the slide done
// before the end, room left for cars granted into the lane)
export const LC_S = 0.6, LC_M = 110;
// Max braking px/s/s. Merge: a driveway car takes a gap of MERGE_GAP s before road traffic reaches the junction; a car at the front
// of its lane for MERGE_S (a driveway, a yield side road, a permissive left) makes the traffic it gives way to let it in
export const BRAKE = 180, MERGE_GAP = 1, MERGE_S = 1;

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
  ring: RingSize; // roundabout size (kept when the control changes)
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
  exit: boolean; // a piece of a highway exit's stub (a split keeps it): free, no upkeep, no refund, never demolished
  heat: number; // congestion EMA 0..1: the larger of density and slowness (1 - speed / top speed) of its cars
}

export interface EdgeFlags { bridge: boolean; tunnel: boolean; level: number; type: RoadType; drive?: boolean; exit?: boolean }

export class RoadGraph {
  nodes: Node[] = [];
  edges: Edge[] = [];
  // Edges ignored by snapping / crossings / edgeBetween; only set while planning a bend
  hidden: Set<Edge> = new Set();
  private nextId = 1;

  addNode(x: number, y: number, building: Building | null = null): Node {
    const n: Node = { id: this.nextId++, x, y, edges: [], building, control: 'none', occupants: new Set(), queue: [], phase: 0, phaseTimer: 0, controlDay: 0, plan: null, ring: 0, delay: 0 };
    if (building) building.node = n;
    this.nodes.push(n);
    return n;
  }

  addEdge(a: Node, b: Node, flags: EdgeFlags, day = 0): Edge {
    const e = {
      id: this.nextId++, a, b, length: dist(a, b),
      bridge: flags.bridge, tunnel: flags.tunnel, level: flags.level, day, drive: !!flags.drive, exit: !!flags.exit, heat: 0,
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

  dropIfOrphan(n: Node): void {
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
    const flags: EdgeFlags = { bridge: e.bridge, tunnel: e.tunnel, level: e.level, type: e.type, drive: e.drive, exit: e.exit };
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
      const p = path[j - 1] ?? from!, q = path[j + 1]!;
      if (!n.building && n.edges.length === 2 && n.control === 'none') continue;
      if (this.drivewayJunction(n) && !this.edgeBetween(p, n)?.drive && !this.edgeBetween(n, q)?.drive) continue;
      return turnAt(p, n, q);
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
    const ti = lane.to.control === 'roundabout' ? ringIn(lane.to) : 0, fi = lane.from.control === 'roundabout' ? ringIn(lane.from) : 0;
    if (remaining < ti && next) return this.ringPos(lane.to, lane.from, next, ti - remaining);
    if (c.s < fi && c.prev) return this.ringPos(lane.from, c.prev, lane.to, fi + c.s);
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
    if (ti && remaining < ti + B) off += (LANE_OFFSET - lane.offset) * (1 - (remaining - ti) / B);
    if (fi && c.s < fi + B) off += (LANE_OFFSET - lane.offset) * (1 - (c.s - fi) / B);
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

  // Counter-clockwise (on screen) around n from the 'from' approach to the 'to' exit; p = straight-line progress 0..2*ringIn
  private ringPos(n: Node, from: Node, to: Node, p: number): { x: number; y: number; angle: number } {
    const R = ringR(n), d = Math.asin(LANE_OFFSET / R);
    const a = Math.atan2(from.y - n.y, from.x - n.x) - d;
    const b = Math.atan2(to.y - n.y, to.x - n.x) + d;
    let arc = (a - b) % (Math.PI * 2);
    if (arc <= 0) arc += Math.PI * 2;
    const ang = a - arc * (p / (2 * ringIn(n)));
    return { x: n.x + Math.cos(ang) * R, y: n.y + Math.sin(ang) * R, angle: ang - Math.PI / 2 };
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
      // a roundabout is hit anywhere on its ring
      const d = dist(p, n) - (n.control === 'roundabout' ? ringR(n) - NODE_R : 0);
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

  // via: the edge a car arrives by; the road's own traffic passes a driveway junction like a bend (only held for a merge)
  needsControl(n: Node, via?: Edge | null): boolean {
    return (n.edges.length >= 3 || n.control !== 'none') && !(via && !via.drive && this.drivewayJunction(n));
  }

  // A plain node where driveways meet one road (two road arms): driveway cars merge (update), the road does not stop for it
  drivewayJunction(n: Node): boolean {
    return n.control === 'none' && !n.building && n.edges.length >= 3 && n.edges.filter(e => !e.drive).length === 2;
  }

  // The merge of driveway car m at n meets road edge e's lanes into n (into) or out of it: a right turn only meets the traffic
  // coming toward its exit lane (that lane's own room is fits()'s). A car clearing the box has entered its exit lane already.
  private meets(m: Car, n: Node, e: Edge, into: boolean): boolean {
    const cl = m.clearing === n, from = cl ? m.prev : m.lane.from, exit = cl ? m.lane : m.exit;
    const right = !!from && !!exit && turnAt(from, n, exit.to) > 0;
    return into ? !(right && e === exit!.edge) : !right;
  }

  // Road traffic arriving by 'via' keeps clear of driveway junction n: a merging car in its way is in the box, or has waited MERGE_S.
  // The traffic heading into its exit lane always (a slow queue never leaves it a gap otherwise), the oncoming traffic a left turn
  // crosses only once that lane has room.
  held(n: Node, via: Edge): boolean {
    for (const m of n.occupants) if (this.meets(m, n, via, true)) return true;
    return n.queue.some(m => m.wait > MERGE_S && this.meets(m, n, via, true) && (via !== m.exit?.edge || this.fits(n, m)));
  }

  // A road car in m's way at driveway junction n: in the box, or reaching it before it could stop plus 'margin' px (the merge gap).
  // Looks back over driveway junctions and bends up to 150px, since a home-lined road is cut into ~40px links.
  private roadNear(n: Node, m: Car, margin: (c: Car) => number): boolean {
    const near = (l: Lane, d: number): boolean => {
      const c = l.cars[l.cars.length - 1];
      if (c) return d + l.edge.length - c.s < stopDist(n) + c.speed * c.speed / (2 * BRAKE) + margin(c);
      const p = l.from, back = p.edges.filter(x => !x.drive && x !== l.edge);
      d += l.edge.length;
      return d < 150 && !p.building && p.control === 'none' && back.length === 1 && back[0].lanes.some(x => x.to === p && near(x, d));
    };
    for (const e of n.edges) {
      if (e.drive) continue;
      for (const l of e.lanes) {
        if (!this.meets(m, n, e, l.to === n)) continue;
        // the rear of a road car just past the node
        if (l.from === n && l.cars[0] && l.cars[0].s - l.cars[0].len / 2 < NODE_R) return true;
        if (l.to === n && near(l, 0)) return true;
      }
    }
    return false;
  }

  // The paths of two cars across plain junction n cross, or end on one road. Each arm takes cars in just right of its centre line and
  // out just left of it, so two paths cross when their ends interleave around the node; a U-turn sweeps the whole box.
  private crosses(n: Node, a: Car, b: Car): boolean {
    const ma = this.moveAt(n, a), mb = this.moveAt(n, b);
    if (!ma || !mb || ma[0] === ma[1] || mb[0] === mb[1] || ma[1] === mb[1]) return true;
    if (ma[0] === mb[0]) return false;
    const T = 2 * Math.PI, at = (e: Edge, d: number) => edgeAngle(n, e) + d, p = at(ma[0], -0.01), span = (at(ma[1], 0.01) - p + 2 * T) % T;
    const inside = (x: number) => (x - p + 2 * T) % T < span;
    return inside(at(mb[0], -0.01)) !== inside(at(mb[1], 0.01));
  }

  // In and out edge of a car queued at, granted into or clearing n
  private moveAt(n: Node, c: Car): [Edge, Edge] | null {
    if (c.clearing === n) { const e = c.prev && this.edgeBetween(c.prev, n); return e ? [e, c.lane.edge] : null; }
    return c.exit ? [c.lane.edge, c.exit.edge] : null;
  }

  private grant(n: Node, c: Car): void {
    c.granted = n;
    n.occupants.add(c);
  }

  // Don't block the box: the exit lane needs the car's length of room past the junction, after the cars already granted into it.
  // A driveway car only needs room past the node: the road does not keep a driveway junction's box clear.
  private fits(n: Node, c: Car): boolean {
    const l = c.exit;
    if (!l) return false;
    const f = l.cars[0];
    let room = (f ? f.s - f.len / 2 : Infinity) - (this.drivewayJunction(n) ? 0 : CAR_LEN / 2 + stopDist(n));
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
      // Arrival order; lights and the main road of a yield junction admit every car their signal lets go, a plain junction every car
      // whose path crosses none in the box, the roundabout up to its size's cap (RINGS), the rest 1. A car that can't go holds back the cars queued behind
      // it in its lane.
      const dj = this.drivewayJunction(n), plain = n.control === 'none' && !dj;
      const cap = n.control === 'light' || n.control === 'yield' || plain ? Infinity : n.control === 'roundabout' ? RINGS[n.ring].cap : 1;
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
      // Starved: at the front of its lane for MERGE_S with room to go. A starved side road (yield) or permissive left (yield's main road,
      // or a light showing it yield) stops the traffic it gives way to, so it never waits until it gives up.
      const main = n.control === 'yield' ? mainEdges(n) : [];
      const starving = (c: Car): boolean => c.wait > MERGE_S && c.lane.cars[c.lane.cars.length - 1] === c && this.fits(n, c);
      const side = n.queue.some(c => !main.includes(c.lane.edge) && starving(c));
      const lefty = (a: number): boolean => a >= 0 && n.queue.some(c => {
        const y = mv.get(c);
        return !!y && y[0] === a && y[1] === LEFT && (n.control !== 'light' || plan!.phases[n.phase].sig[a][LEFT] === 1) && starving(c);
      });
      const left = (c: Car, a: number): boolean => !opposed(a) || (starving(c) && !busy(n.occupants, oppositeOf(plan!, a), m => m !== LEFT));
      const may = (c: Car): boolean => {
        const x = mv.get(c);
        if (plan && (!x || plan.ban[x[0]][x[1]])) return false;
        if (n.control === 'light') {
          const s = plan!.phases[n.phase].sig[x![0]][x![1]];
          return x![1] === LEFT ? s === 2 || (s === 1 && left(c, x![0])) : s > 0 && !lefty(oppositeOf(plan!, x![0]));
        }
        if (n.control === 'yield') {
          // a side road goes into an empty box with no main-road car waiting
          if (main.includes(c.lane.edge)) return !side && (x![1] === LEFT ? left(c, x![0]) : !lefty(oppositeOf(plan!, x![0])));
          return !n.occupants.size && (starving(c) || !n.queue.some(o => o !== c && main.includes(o.lane.edge)));
        }
        // stop: only from a standstill at the line
        if (n.control === 'stop') return c.speed < 1 && c.lane.edge.length - c.s - stopDist(n) < GAP + 3;
        // driveway: into a gap in the road's traffic; after MERGE_S the road keeps clear (held) and only cars that can't stop count
        if (dj) return !this.roadNear(n, c, o => c.wait < MERGE_S ? o.speed * MERGE_GAP + CAR_LEN : 0);
        // plain: never past an earlier car it crosses that only waits for the box (first come, first served)
        if (plain) return ![...n.occupants, ...ready].some(o => this.crosses(n, c, o));
        return true;
      };
      const held = new Set<Lane>(), ready: Car[] = [];
      n.queue = n.queue.filter(c => {
        const free = !held.has(c.lane) && this.fits(n, c);
        if (!free || n.occupants.size >= cap || !may(c)) {
          if (free) ready.push(c);
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
