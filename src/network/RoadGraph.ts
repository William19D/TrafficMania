import type { Vec } from '../util/geom.ts';
import { dist, distToSegment, segmentsCross } from '../util/geom.ts';
import type { Building } from '../entities/Building.ts';
import { DOOR_R } from '../entities/Building.ts';
import type { Car } from '../entities/Car.ts';
import { TIERS, TUNING } from '../core/config.ts';
import type { Tier } from '../core/config.ts';
import type { JunctionPlan, Move } from './Junction.ts';
import { ANY, LEFT, approachOf, edgeAngle, laneMasks, mainEdges, moveOf, oppositeOf, planOf, turnAt } from './Junction.ts';
export { LIGHT_PERIOD, lightGroup } from './Junction.ts';

export const TILE = 40, ROAD_W = 18, LANE_OFFSET = 4.5, NODE_R = 12, CAR_LEN = 15, CAR_W = 8, GAP = 5;
// Where a car stops before a junction (distance from the node)
export const stopDist = (_n: Node): number => NODE_R + 3;
// Mid-edge lane change: slide seconds, and how far from both nodes it may start (past the node blends, the slide done
// before the end, room left for cars granted into the lane)
export const LC_S = 0.6, LC_M = 110;
// Max braking px/s/s. Merge: a driveway car takes a gap of MERGE_GAP s before road traffic reaches the junction; a car at the front
// of its lane for MERGE_S (a driveway, a yield side road, a permissive left) makes the traffic it gives way to let it in
export const BRAKE = 180, MERGE_GAP = 1, MERGE_S = 1;
// px out from a light at which an ambulance turns it green
export const AMB_R = 60;

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

// Roundabout sizes (docs/design/game-v3.md 1): ring lane radius, chords round it, ring speed limit px/s, most arms, most lanes per
// direction on an arm, cost / upkeep multiplier
export type RingSize = 0 | 1 | 2;
export const RINGS: readonly { label: string; r: number; n: number; v: number; arms: number; lanes: number; cost: number }[] = [
  { label: 'Small', r: 22, n: 7, v: 45, arms: 4, lanes: 1, cost: 1 },
  { label: 'Medium', r: 34, n: 11, v: 58, arms: 5, lanes: 2, cost: 1.6 },
  { label: 'Large', r: 50, n: 16, v: 70, arms: 6, lanes: 3, cost: 2.4 },
];
// The ring road: one lane and a shoulder each side (12px)
const RING_TYPE: RoadType = { tier: 'avenue', lanes: 1, oneWay: true };
export const RING_W = roadWidth(RING_TYPE);
// Outer edge of the ring road; no other junction, split or driveway join within clearR
export const ringOut = (s: RingSize): number => RINGS[s].r + RING_W / 2;
export const clearR = (s: RingSize): number => ringOut(s) + 2 * NODE_R;
export const onRing = (n: Node): boolean => n.edges.some(e => !!e.ring);

// none: one car at a time in arrival order; yield: the main road (mainEdges) goes, side roads give way; stop: all-way stop
export type Control = 'none' | 'yield' | 'stop' | 'light' | 'roundabout';

export interface Node {
  id: number; x: number; y: number; edges: Edge[]; building: Building | null; control: Control;
  occupants: Set<Car>; queue: Car[]; phase: number; phaseTimer: number;
  controlDay: number; // day the control was built (refund rule)
  plan: JunctionPlan | null; // edited phases / lane connections; null = the default plan (Junction.planOf)
  ring: RingSize; // a ring's hub: its size (old saves: a 'roundabout' node's)
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
  ring: Ring | null; // a roundabout's ring road: free, part of the control
}

// A roundabout: one-way ring edges joining its nodes counter-clockwise on screen (nodes[i] -> nodes[i + 1]); the cars entering from an
// arm merge into gaps in the ring traffic. Its hub stands in for it off the graph (the junction panel, the control price): control
// 'roundabout', ring = its size, controlDay, at the centre.
export interface Ring { hub: Node; nodes: Node[] }

export interface EdgeFlags { bridge: boolean; tunnel: boolean; level: number; type: RoadType; drive?: boolean; exit?: boolean; ring?: Ring | null }

export class RoadGraph {
  nodes: Node[] = [];
  edges: Edge[] = [];
  // Edges ignored by snapping / crossings / edgeBetween; only set while planning a bend
  hidden: Set<Edge> = new Set();
  rings: Ring[] = [];
  private nextId = 1;

  // A node off the graph (a ring's hub)
  node(x: number, y: number, building: Building | null = null): Node {
    return { id: this.nextId++, x, y, edges: [], building, control: 'none', occupants: new Set(), queue: [], phase: 0, phaseTimer: 0, controlDay: 0, plan: null, ring: 0, delay: 0 };
  }

  addNode(x: number, y: number, building: Building | null = null): Node {
    const n = this.node(x, y, building);
    if (building) building.node = n;
    this.nodes.push(n);
    return n;
  }

  addEdge(a: Node, b: Node, flags: EdgeFlags, day = 0): Edge {
    const e = {
      id: this.nextId++, a, b, length: dist(a, b),
      bridge: flags.bridge, tunnel: flags.tunnel, level: flags.level, day, drive: !!flags.drive, exit: !!flags.exit, heat: 0, ring: flags.ring ?? null,
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
    const flags: EdgeFlags = { bridge: e.bridge, tunnel: e.tunnel, level: e.level, type: e.type, drive: e.drive, exit: e.exit, ring: e.ring };
    const n = this.addNode(p.x, p.y);
    this.unlink(e);
    const e1 = this.addEdge(a, n, flags, e.day);
    const e2 = this.addEdge(n, b, flags, e.day);
    e1.heat = e2.heat = e.heat;
    if (e.ring) e.ring.nodes.splice(e.ring.nodes.indexOf(a) + 1, 0, n);
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
    // merged lanes: no car overlaps the one ahead
    for (const l of e.lanes) lost.push(...this.respace(l));
    return lost;
  }

  // Pushes l's cars back so none overlaps the one ahead (s sorted already); detaches and returns the ones pushed off its start
  respace(l: Lane): Car[] {
    const lost: Car[] = [];
    let ahead: Car | null = null;
    for (let k = l.cars.length - 1; k >= 0; k--) {
      const c = l.cars[k];
      c.s = Math.min(c.s, l.edge.length, ahead ? ahead.s - (c.len + ahead.len) / 2 : Infinity);
      if (c.s < 0) lost.push(c);
      else ahead = c;
    }
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
      // a ring's nodes: the turn that counts is the one past the roundabout
      if ((!n.building && n.edges.length === 2 && n.control === 'none') || onRing(n)) continue;
      if (this.drivewayJunction(n) && !this.edgeBetween(p, n)?.drive && !this.edgeBetween(n, q)?.drive) continue;
      return turnAt(p, n, q);
    }
    return 0;
  }

  // Lane arrows: the moves (bits 1 << Move) lane l may make at the node it leads into; ANY without arrows there
  arrows(l: Lane): number {
    const p = l.to.plan, m = p && laneMasks(p, l.to, l.edge);
    return m ? m[this.lanesFrom(l.edge, l.from).indexOf(l)] : ANY;
  }
  // Lanes of e from 'from' whose arrows allow going on to q at its far end; null when that node has no arrows for e
  arrowLanes(e: Edge, from: Node, q: Node | undefined): Lane[] | null {
    const n = e.a === from ? e.b : e.a, out = q && this.edgeBetween(n, q);
    if (!out || !n.plan || !laneMasks(n.plan, n, e)) return null;
    const mv = moveOf(n, e, out);
    return this.lanesFrom(e, from).filter(l => this.arrows(l) >> mv & 1);
  }

  // Lane for the turn after this edge: rightmost / leftmost (lanesFrom is ascending by offset), straight: the most room at its start.
  // q: the node after e's far end; where that junction has lane arrows, the roomiest lane they allow for the move onto q
  pickLane(e: Edge, from: Node, turn = 0, q?: Node): Lane | null {
    const ok = this.arrowLanes(e, from, q), ls = ok?.length ? ok : this.lanesFrom(e, from);
    if (turn && !ok?.length) return ls[turn > 0 ? ls.length - 1 : 0] ?? null;
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

  // Render position of a car along its lane. At plain nodes the lateral offset blends halfway toward the next / from the previous lane.
  carPos(c: Car): { x: number; y: number; angle: number } {
    const lane = c.lane, remaining = lane.edge.length - c.s;
    const next = c.path?.[1];
    // U-turn back down the same edge (dead end / one-way ahead): half circle in the last and first NODE_R
    if (next === lane.from && c.exit?.edge === lane.edge && remaining < NODE_R) return this.uturnPos(lane, c.exit.offset, NODE_R - remaining);
    if (c.prev === lane.to && c.s < NODE_R) return this.uturnPos({ ...lane, from: lane.to, to: lane.from, offset: c.prevOffset }, lane.offset, NODE_R + c.s);
    // Junction or bend: a Bezier arc over the last / first NODE_R or so of the two lanes (exit is stale for a tick after a hand-off)
    const nl = c.exit;
    if (nl && next === nl.to && next !== lane.from) {
      const q = this.arcPos(lane.from, lane.to, nl.to, lane.offset, nl.offset, -remaining);
      if (q) return q;
    }
    if (c.prev && c.prev !== lane.to) {
      const q = this.arcPos(c.prev, lane.from, lane.to, c.prevOffset, lane.offset, c.s);
      if (q) return q;
    }
    const B = 2 * NODE_R;
    let off = lane.offset;
    if (nl && next === nl.to && remaining < B) off += (nl.offset - lane.offset) * 0.5 * (1 - remaining / B);
    if (c.prev && c.s < B) off += (c.prevOffset - lane.offset) * 0.5 * (1 - c.s / B);
    if (!c.lc) return this.lanePos(lane, c.s, off);
    // mid-edge lane change: smoothstep slide from the old lane, nose turned along the sideways speed
    const u = c.lc / LC_S, q = this.lanePos(lane, c.s, off + c.lcOff * u * u * (3 - 2 * u));
    return { ...q, angle: q.angle + Math.atan2(-c.lcOff * 6 * u * (1 - u) / LC_S, Math.max(c.speed, 40)) };
  }

  // Cubic Bezier across node n from lane a->n (offset oi) onto n->b (offset oo); x = signed distance past n, the arc spans |x| <= r
  // (NODE_R on single-lane roads; half a ring's chord).
  // Its ends sit where the straight lane's halfway offset blend is, tangent to the lanes, so the hand-off is seamless.
  // A left turn at a junction bows LANE_OFFSET toward the inside of the turn, so two opposite lefts pass each other side by side.
  // ponytail: ignores the next-node blends that only reach the ends on edges under ~3 NODE_R; a glitch there is cosmetic
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
    const dz = (p0: number, p1: number, p2: number, p3: number) => 3 * (m * m * (p1 - p0) + 2 * m * t * (p2 - p1) + t * t * (p3 - p2));
    // the bow: 16 t^2 m^2 (flat at both ends, so the heading stays continuous) along the inside of the turn
    let wx = 0, wy = 0;
    if (n.edges.length > 2 && !onRing(n) && turnAt(a, n, b) < 0) {
      const ux = Math.cos(Q.angle) - Math.cos(P.angle), uy = Math.sin(Q.angle) - Math.sin(P.angle), k = LANE_OFFSET / (Math.hypot(ux, uy) || 1);
      wx = ux * k; wy = uy * k;
    }
    const w = 16 * t * t * m * m, dw = 32 * t * m * (m - t);
    return { x: bz(P.x, x1, x2, Q.x) + wx * w, y: bz(P.y, y1, y2, Q.y) + wy * w, angle: Math.atan2(dz(P.y, y1, y2, Q.y) + wy * dw, dz(P.x, x1, x2, Q.x) + wx * dw) };
  }

  // Left turn from lane l (offset l.offset) onto the opposite lane (offset oo), NODE_R before l.to; p = 0..2*NODE_R
  private uturnPos(l: Lane, oo: number, p: number): { x: number; y: number; angle: number } {
    const t = Math.PI * Math.min(1, p / (2 * NODE_R)), r = (l.offset + oo) / 2;
    const q = this.lanePos(l, l.edge.length - NODE_R + r * Math.sin(t), (l.offset - oo) / 2 + r * Math.cos(t));
    return { ...q, angle: q.angle - t };
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

  // via: the edge a car arrives by; the road's own traffic passes a driveway junction like a bend (only held for a merge), ring
  // traffic passes an arm's node
  needsControl(n: Node, via?: Edge | null): boolean {
    return (n.edges.length >= 3 || n.control !== 'none') && !(via && !via.drive && this.drivewayJunction(n)) && !via?.ring;
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

  // A road car in m's way at driveway junction n: in the box, or reaching it before it could stop (with its gap and reaction) plus
  // 'margin' px (the merge gap).
  // Looks back over driveway junctions and bends up to 150px, since a home-lined road is cut into ~40px links.
  private roadNear(n: Node, m: Car, margin: (c: Car) => number): boolean {
    const reach = (c: Car, d: number): boolean => d < stopDist(n) + c.speed * c.speed / (2 * BRAKE) + margin(c);
    const near = (l: Lane, d: number): boolean => {
      const c = l.cars[l.cars.length - 1];
      if (c) return reach(c, d + l.edge.length - c.s);
      const p = l.from, back = p.edges.filter(x => !x.drive && x !== l.edge);
      d += l.edge.length;
      // a car granted onto l at its far end (one leaving its driveway there) is about to be on it
      for (const o of p.occupants) if (o.granted === p && o.exit === l && reach(o, d)) return true;
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
  // A driveway or ring entry only needs room past the node: the road does not keep its box clear.
  // Two lanes never feed one exit lane at once: a car granted into it from another lane enters first (else they meet in the box).
  private fits(n: Node, c: Car): boolean {
    const l = c.exit;
    if (!l) return false;
    const f = l.cars[0];
    let room = (f ? f.s - f.len / 2 : Infinity) - (this.drivewayJunction(n) || onRing(n) ? 0 : CAR_LEN / 2 + stopDist(n));
    for (const o of n.occupants) {
      if (o.granted !== n || o.exit !== l) continue;
      if (o.lane !== c.lane) return false;
      room -= o.len + GAP;
    }
    return room >= c.len + GAP;
  }

  // Ring traffic at arm node n for entering car m: a car still to pass n on the ring (one leaving there never meets m) reaching it
  // before it could stop plus MERGE_GAP s past m's own time to the node, or the rear of one just past it. No courtesy merge: held
  // ring traffic would gridlock the ring.
  private ringNear(n: Node, m: Car): boolean {
    const f = this.ringLane(n, false).cars[0], te = (m.lane.edge.length - m.s) / Math.max(m.speed, 20);
    if (f && f.s - f.len / 2 < NODE_R) return true;
    const reach = (c: Car, d: number): boolean => d < NODE_R + c.speed * c.speed / (2 * BRAKE) + c.speed * (MERGE_GAP + te) + CAR_LEN;
    for (let l = this.ringLane(n, true), d = 0; d < 250; l = this.ringLane(l.from, true)) {
      for (let i = l.cars.length - 1; i >= 0; i--) if (this.passes(l.cars[i], n)) return reach(l.cars[i], d + l.edge.length - l.cars[i].s);
      d += l.edge.length;
      if (l.from === n) break;
      // a car granted in at l's start is about to be on the ring
      for (const o of l.from.occupants) if (o.granted === l.from && this.passes(o, n)) return reach(o, d + o.lane.edge.length - o.s);
    }
    return false;
  }

  // The ring lane into (or out of) ring node v
  private ringLane(v: Node, into: boolean): Lane {
    return v.edges.find(e => e.ring && (into ? e.b : e.a) === v)!.lanes[0];
  }

  // Ring car c keeps on the ring past n; an unknown route counts as yes
  private passes(c: Car, n: Node): boolean {
    const p = c.path, i = p ? p.indexOf(n) : 0;
    return !p || (i >= 0 && i + 1 < p.length && !!this.edgeBetween(n, p[i + 1])?.ring);
  }

  // Room for c in the road it leaves the ring by, after the ring cars heading there: a blocked exit holds cars at the entry, not on
  // the ring. ponytail: cars granted at other entries don't count; a jam there only stalls the ring until REROUTE_S
  private exitRoom(n: Node, c: Car): boolean {
    const p = c.path, r = this.ringOf(n);
    if (!p || !r) return true;
    let j = 0;
    while (j + 1 < p.length && this.edgeBetween(p[j], p[j + 1])?.ring) j++;
    const x = p[j], q = p[j + 1], e = q && this.edgeBetween(x, q);
    if (!j || !e) return true;
    let need = c.len + GAP;
    for (const v of r.nodes) for (const o of this.ringLane(v, true).cars) {
      const i = o.path?.indexOf(x) ?? -1;
      if (i >= 0 && o.path![i + 1] === q) need += o.len + GAP;
    }
    return this.lanesFrom(e, x).some(l => (l.cars[0] ? l.cars[0].s - l.cars[0].len / 2 : Infinity) >= need);
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
      // Ambulance (game-v3 3): its whole lane goes first (a stable sort keeps the cars ahead of it in order); a light turns green for it
      // when it is AMB_R out, a yield treats it as the main road, a stop lets it roll
      const amb = n.queue.filter(c => c.kind === 'ambulance' && c.exit), ambL = new Set(amb.map(c => c.lane));
      if (ambL.size) n.queue.sort((p, q) => +ambL.has(q.lane) - +ambL.has(p.lane));
      if (n.control === 'light') {
        const ph = plan!.phases;
        n.phaseTimer += dt;
        if (n.phase >= ph.length) n.phase = 0;
        if (n.phaseTimer >= ph[n.phase].seconds) { n.phaseTimer = 0; n.phase = (n.phase + 1) % ph.length; }
        const a = amb.find(c => c.lane.edge.length - c.s < AMB_R), x = a && [approachOf(plan!, n, a.lane.edge), moveOf(n, a.lane.edge, a.exit!.edge)] as const;
        const green = x ? ph.findIndex(p => p.sig[x[0]][x[1]] === 2) : -1, go = green >= 0 ? green : x ? ph.findIndex(p => p.sig[x[0]][x[1]] > 0) : -1;
        if (go >= 0 && !(ph[n.phase].sig[x![0]][x![1]] > 0)) { n.phase = go; n.phaseTimer = 0; }
      }
      if (!n.queue.length) continue;
      // Arrival order; lights and the main road of a yield junction admit every car their signal lets go, a plain junction every car
      // whose path crosses none in the box, the rest 1 (a ring entry: into a gap). A car that can't go holds back the cars queued behind
      // it in its lane.
      const dj = this.drivewayJunction(n), rv = onRing(n), plain = n.control === 'none' && !dj && !rv;
      const cap = n.control === 'light' || n.control === 'yield' || plain ? Infinity : 1;
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
      const side = n.queue.some(c => !main.includes(c.lane.edge) && !ambL.has(c.lane) && starving(c));
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
          if (main.includes(c.lane.edge) || ambL.has(c.lane)) return !side && (x![1] === LEFT ? left(c, x![0]) : !lefty(oppositeOf(plan!, x![0])));
          return !n.occupants.size && (starving(c) || !n.queue.some(o => o !== c && main.includes(o.lane.edge)));
        }
        if (rv) return !this.ringNear(n, c) && this.exitRoom(n, c);
        // stop: only from a standstill at the line
        if (n.control === 'stop') return ambL.has(c.lane) || (c.speed < 1 && c.lane.edge.length - c.s - stopDist(n) < GAP + 3);
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

  ringOf(n: Node): Ring | null {
    return n.edges.find(e => e.ring)?.ring ?? this.rings.find(r => r.hub === n) ?? null;
  }
  // The ring drawn under p (pad px of slack round its outer edge)
  ringAt(p: Vec, pad = 0): Ring | null {
    return this.rings.find(r => dist(p, r.hub) <= ringOut(r.hub.ring) + pad) ?? null;
  }
  // The ring whose clear radius p is inside
  nearRing(p: Vec): Ring | null {
    return this.rings.find(r => dist(p, r.hub) < clearR(r.hub.ring)) ?? null;
  }

  // Replaces junction n with a ring of this size (Game.ringRoom checks the fit): each arm, followed through its bends, is cut where it
  // crosses the ring, its inner piece removed, and the cut points joined round by ring edges of about one chord (RINGS n), so the
  // arms sit exactly on ring nodes. Null (and nothing changed) when an arm meets a junction, door or dead end inside the ring.
  buildRing(n: Node, size: RingSize, day: number): { ring: Ring; cars: Car[] } | null {
    const R = RINGS[size].r, other = (e: Edge, v: Node) => e.a === v ? e.b : e.a;
    const plain = (v: Node) => !v.building && v.control === 'none' && v.edges.length === 2;
    const arms: { inner: Edge[]; e: Edge; at: Node; o: Node }[] = [];
    for (const e0 of n.edges) {
      let at = n, e = e0;
      const inner: Edge[] = [];
      while (dist(other(e, at), n) < R && plain(other(e, at))) {
        inner.push(e);
        at = other(e, at);
        e = at.edges[0] === e ? at.edges[1] : at.edges[0];
      }
      if (dist(other(e, at), n) < R) return null;
      arms.push({ inner, e, at, o: other(e, at) });
    }
    const cars: Car[] = [], cuts: Node[] = [];
    for (const { inner, e, at, o } of arms) {
      // where at->o crosses the circle: |at + t (o - at) - n| = R
      const dx = o.x - at.x, dy = o.y - at.y, fx = at.x - n.x, fy = at.y - n.y, A = dx * dx + dy * dy, B = fx * dx + fy * dy;
      const t = (-B + Math.sqrt(Math.max(0, B * B - A * (fx * fx + fy * fy - R * R)))) / A, p = { x: at.x + dx * t, y: at.y + dy * t };
      const v = dist(p, o) < 1 ? o : this.splitEdge(e, p);
      inner.push(v === o ? e : this.edgeBetween(at, v)!);
      for (const x of inner) cars.push(...this.removeEdge(x));
      cuts.push(v);
    }
    // counter-clockwise on screen = falling angle; each arc between two arms split into whole chords
    const ang = (v: Vec) => Math.atan2(v.y - n.y, v.x - n.x), step = 2 * Math.PI / RINGS[size].n, nodes: Node[] = [];
    cuts.sort((p, q) => ang(q) - ang(p));
    cuts.forEach((v, i) => {
      nodes.push(v);
      let arc = ang(v) - ang(cuts[(i + 1) % cuts.length]);
      if (arc <= 1e-9) arc += 2 * Math.PI;
      const k = Math.max(1, Math.round(arc / step));
      for (let j = 1; j < k; j++) { const a = ang(v) - arc * j / k; nodes.push(this.addNode(n.x + Math.cos(a) * R, n.y + Math.sin(a) * R)); }
    });
    const hub = this.node(n.x, n.y), ring: Ring = { hub, nodes };
    Object.assign(hub, { control: 'roundabout', ring: size, controlDay: day });
    nodes.forEach((v, i) => this.addEdge(v, nodes[(i + 1) % nodes.length], { bridge: false, tunnel: false, level: 0, type: RING_TYPE, ring }, day));
    this.rings.push(ring);
    return { ring, cars };
  }

  // Takes the ring out: a plain node at its centre joined to each arm by a spoke of the arm's type (keeping a one-way arm's direction).
  // Returns that node and the cars taken off the ring.
  removeRing(r: Ring): { node: Node; cars: Car[] } {
    const c = this.addNode(r.hub.x, r.hub.y), cars: Car[] = [];
    for (const v of r.nodes) for (const a of v.edges.filter(e => !e.ring)) {
      const out = a.type.oneWay && a.a === v;
      this.addEdge(out ? c : v, out ? v : c, { bridge: a.bridge, tunnel: a.tunnel, level: a.level, type: a.type }, a.day);
    }
    for (const v of r.nodes) for (const e of [...v.edges]) if (e.ring) cars.push(...this.removeEdge(e));
    this.rings = this.rings.filter(x => x !== r);
    this.dropIfOrphan(c);
    return { node: c, cars };
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
