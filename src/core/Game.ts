import type { Vec } from '../util/geom.ts';
import { dist, distToSegment } from '../util/geom.ts';
import type { Terrain } from '../world/MapGenerator.ts';
import { generateTerrain, CITY_COLORS, inWater, inMountain, segmentCrosses, randomName, findCitySpot } from '../world/MapGenerator.ts';
import type { Node, Edge, EdgeFlags, RoadType } from '../network/RoadGraph.ts';
import { RoadGraph, TILE, ROAD_W, NODE_R, CAR_LEN, GAP, DEFAULT_TYPE, laneFactor, sameType } from '../network/RoadGraph.ts';
import { cubicPoints, bendControls } from '../util/curve.ts';
import { findPath } from '../network/Pathfinder.ts';
import { City, OVERCROWD_SECONDS, CITY_R } from '../entities/City.ts';
import { Car } from '../entities/Car.ts';

export type Tool = 'road' | 'light' | 'roundabout' | 'demolish' | 'edit';
export interface Inventory { asphalt: number; bridges: number; tunnels: number; lights: number; roundabouts: number }
export type Reward = Partial<Inventory>;
export const DAY_SECONDS = 15; // one week = 7 days
export interface Snap { node: Node | null; edge: Edge | null; point: Vec }
export interface BuildPlan {
  a: Snap; b: Snap; cost: Inventory; ok: boolean; reason: string;
  crossings: { edge: Edge; point: Vec; t: number; node: Node | null }[];
  flags: EdgeFlags;
}
export interface PathSeg { a: Vec; b: Vec; bridge: boolean; tunnel: boolean; level: number; type: RoadType }
// net: bend plans only, asphalt cost minus the refund of the replaced run
export interface PathPlan { points: Vec[]; segs: PathSeg[]; cost: Inventory; ok: boolean; reason: string; type: RoadType; level: number; net?: number }
type Crossing = { edge: Edge; point: Vec; t: number; node: Node | null };
interface SegPlan extends PathSeg {
  sa: Snap; sb: Snap; crossings: Crossing[]; exists: boolean; refund: { bridges: number; tunnels: number };
}

const REWARDS: Reward[] = [
  { asphalt: 25, bridges: 1 },
  { asphalt: 20, tunnels: 1, lights: 1 },
  { asphalt: 30 },
  { asphalt: 15, roundabouts: 1, bridges: 1 },
  { asphalt: 20, lights: 1 },
  { asphalt: 10, tunnels: 1, bridges: 1 },
];
const CITY_SPAWN_SECONDS = 45;
const MAX_LEVEL = 10;
const MOUNTAIN_LEVEL = 6; // viaducts at this level or higher clear mountains
const MAX_CITIES = 14;

export class Game {
  terrain: Terrain;
  graph = new RoadGraph();
  cities: City[] = [];
  cars: Car[] = [];
  inventory: Inventory = { asphalt: 60, bridges: 2, tunnels: 1, lights: 1, roundabouts: 1 };
  score = 0;
  time = 0;
  speed: 0 | 1 | 2 | 4 = 1;
  tool: Tool = 'road';
  // Elevation for new roads: 0 = ground, 1..10 = viaducts
  level = 0;
  // Type for new roads
  roadType: RoadType = { ...DEFAULT_TYPE };
  // Run selected with the Edit tool (edges in run order)
  selected: Edge[] | null = null;
  // Edges created by the last commitPath, in build order (reused edges not included)
  lastBuilt: Edge[] = [];
  gameOver = false;
  pendingReward: Reward[] | null = null;
  message = '';
  // While true: no game over, no city spawning, slower demand.
  tutorialActive = false;
  // World points the renderer highlights while tutorialActive
  tutorialTargets: Vec[] = [];
  // Last successful commitPath: edges created and plan level (read by the tutorial)
  lastBuild: { segs: number; level: number } | null = null;
  private lastWeek = 1;
  private cityTimer = 0;
  private msgTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.terrain = generateTerrain();
    for (let i = 0; i < 3; i++) this.spawnCity();
  }

  get day(): number { return (Math.floor(this.time / DAY_SECONDS) % 7) + 1; }
  get week(): number { return Math.floor(this.time / (DAY_SECONDS * 7)) + 1; }
  get running(): boolean { return !this.gameOver && !this.pendingReward && this.speed > 0; }

  private get demandInterval(): number { return Math.max(2.5, 7 - this.week * 0.5) * (this.tutorialActive ? 1.5 : 1); }

  private spawnCity(): void {
    const spot = findCitySpot(this.terrain, this.cities, this.graph.edges);
    if (!spot) return;
    const used = new Set(this.cities.map(c => c.color));
    const free = CITY_COLORS.filter(c => !used.has(c));
    const pool = free.length ? free : CITY_COLORS;
    const color = pool[Math.floor(Math.random() * pool.length)];
    const names = new Set(this.cities.map(c => c.name));
    let name = randomName();
    for (let i = 0; i < 10 && names.has(name); i++) name = randomName();
    const city = new City(name, color, spot.x, spot.y, this.demandInterval);
    this.graph.addNode(spot.x, spot.y, city);
    this.cities.push(city);
  }

  update(dt: number): void {
    if (!this.running) return;
    this.time += dt;

    const week = this.week;
    if (week > this.lastWeek) {
      this.lastWeek = week;
      const i = Math.floor(Math.random() * REWARDS.length);
      let j = Math.floor(Math.random() * (REWARDS.length - 1));
      if (j >= i) j++;
      this.pendingReward = [REWARDS[i], REWARDS[j]];
    }

    if (!this.tutorialActive) this.cityTimer += dt;
    if (this.cityTimer >= CITY_SPAWN_SECONDS) {
      this.cityTimer = 0;
      if (this.cities.length < MAX_CITIES) this.spawnCity();
    }

    const interval = this.demandInterval;
    for (const city of this.cities) {
      const collapsed = city.tick(dt, this.cities, interval);
      if (this.tutorialActive) city.overTimer = Math.min(city.overTimer, OVERCROWD_SECONDS * 0.9);
      else if (collapsed) { this.gameOver = true; return; }
      this.trySpawnCar(city, dt);
    }

    this.graph.update(dt);

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const r = car.update(dt, this.graph);
      if (r === 'ok') continue;
      if (r === 'stuck' || r === 'lost') { this.dropCars([car]); continue; }
      if (r === 'arrived') this.score++;
      this.graph.detachCar(car);
      this.cars.splice(i, 1);
    }
  }

  private trySpawnCar(city: City, dt: number): void {
    city.retryTimer -= dt;
    if (city.retryTimer > 0 || !city.pending.length) return;
    city.retryTimer = 0.4;
    for (let i = 0; i < city.pending.length; i++) {
      const dest = city.pending[i];
      const path = findPath(this.graph, city.node, dest.node);
      if (!path || path.length < 2) continue;
      const e = this.graph.edgeBetween(city.node, path[1]);
      if (!e) continue;
      const lane = this.graph.pickLane(e, city.node, this.graph.turn(path, 1));
      if (!lane || (lane.cars[0]?.s ?? Infinity) < CAR_LEN + GAP * 2) continue;
      city.pending.splice(i, 1);
      const car = new Car(lane, dest, city);
      car.path = path.slice(1);
      lane.cars.unshift(car);
      this.cars.push(car);
      return;
    }
  }

  setRoadType(t: RoadType): void {
    this.roadType = { ...t };
  }

  setLevel(n: number): void {
    this.level = Math.max(0, Math.min(MAX_LEVEL, Math.round(n)));
  }

  // Direction a road leaving p toward 'toward' should start with, to continue smoothly from the
  // road it snaps to; null for a free point or when no existing direction fits.
  tangentAt(p: Vec, toward: Vec): Vec | null {
    const dx = toward.x - p.x, dy = toward.y - p.y, d = Math.hypot(dx, dy);
    if (!d) return null;
    const s = this.snap(p);
    const cands: Vec[] = [];
    const push = (x: number, y: number) => { const l = Math.hypot(x, y); if (l) cands.push({ x: x / l, y: y / l }); };
    if (s.node) {
      const n = s.node;
      for (const e of n.edges) {
        if (!n.city && e.level !== this.level) continue;
        const o = e.a === n ? e.b : e.a;
        push(n.x - o.x, n.y - o.y);
      }
    } else if (s.edge) {
      const e = s.edge;
      push(e.b.x - e.a.x, e.b.y - e.a.y);
      push(e.a.x - e.b.x, e.a.y - e.b.y);
    }
    let best: Vec | null = null, bestDot = 0.2;
    for (const c of cands) {
      const dot = (c.x * dx + c.y * dy) / d;
      if (dot > bestDot) { best = c; bestDot = dot; }
    }
    return best;
  }

  private snap(p: Vec, level = this.level): Snap {
    const n = this.graph.nearestNode(p, NODE_R + 4, level);
    if (n) return { node: n, edge: null, point: { x: n.x, y: n.y } };
    const hit = this.graph.nearestEdge(p, ROAD_W, level);
    if (hit) {
      for (const end of [hit.edge.a, hit.edge.b]) {
        if (dist(hit.point, end) <= NODE_R) return { node: end, edge: null, point: { x: end.x, y: end.y } };
      }
      return { node: null, edge: hit.edge, point: hit.point };
    }
    return { node: null, edge: null, point: { x: p.x, y: p.y } };
  }

  // Per-segment analysis shared by planBuild and planPath.
  // 'blocked' = the segment touches a mountain at a level that cannot clear it.
  private planSeg(a: Snap, b: Snap, level = this.level, type = this.roadType): { flags: EdgeFlags; crossings: Crossing[]; exists: boolean; blocked: boolean } {
    const flags: EdgeFlags = { bridge: false, tunnel: false, level, type };
    const crossings: Crossing[] = [];
    const touches = (e: Edge | null, n: Node | null): boolean => !!e && !!n && (e.a === n || e.b === n);
    const exists = !!(a.node && a.node === b.node) || !!(a.edge && a.edge === b.edge) ||
      !!(a.node && b.node && this.graph.edgeBetween(a.node, b.node)) || touches(a.edge, b.node) || touches(b.edge, a.node);
    if (exists) return { flags, crossings, exists, blocked: false };

    const exNodes = new Set<Node>();
    if (a.node) exNodes.add(a.node);
    if (b.node) exNodes.add(b.node);
    const exEdges = new Set<Edge>();
    if (a.edge) exEdges.add(a.edge);
    if (b.edge) exEdges.add(b.edge);
    let prev: Vec | null = null;
    for (const c of this.graph.crossings(a.point, b.point, exNodes, exEdges, level)) {
      const near = (s: Snap): boolean => !!(s.node || s.edge) && dist(c.point, s.point) < NODE_R;
      if (near(a) || near(b)) continue;
      if (prev && dist(c.point, prev) < NODE_R) continue;
      crossings.push(c);
      prev = c.point;
    }
    const terr = segmentCrosses(this.terrain, a.point, b.point);
    // ground: water -> bridge, mountain -> tunnel; elevated: always a viaduct, never a tunnel
    flags.bridge = level > 0 || terr.water;
    flags.tunnel = level === 0 && terr.mountain;
    return { flags, crossings, exists, blocked: level > 0 && level < MOUNTAIN_LEVEL && terr.mountain };
  }

  private badGround(s: Snap): boolean {
    return !s.node && !s.edge && (inWater(this.terrain, s.point) || inMountain(this.terrain, s.point));
  }

  private afford(cost: Inventory): string {
    const inv = this.inventory;
    if (inv.asphalt < cost.asphalt) return 'Not enough asphalt';
    if (inv.bridges < cost.bridges) return 'Not enough bridges';
    if (inv.tunnels < cost.tunnels) return 'Not enough tunnels';
    return '';
  }

  private resolve(s: Snap): Node {
    return s.node ?? (s.edge ? this.graph.splitEdge(s.edge, s.point) : this.graph.addNode(s.point.x, s.point.y));
  }

  // Builds one segment from an existing node and returns its end node. The refund goes on its first edge.
  private buildSeg(start: Node, end: Snap, flags: EdgeFlags, crossings: Crossing[], refund: { bridges: number; tunnels: number }): Node {
    const g = this.graph;
    const chain: Node[] = [start];
    for (const c of crossings) chain.push(c.node ?? g.splitEdge(c.edge, c.point));
    chain.push(this.resolve(end));
    let first = true;
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i - 1], n = chain[i];
      // ponytail: skip degenerate segments (same node or already connected) instead of duplicating edges
      if (p === n || g.edgeBetween(p, n)) continue;
      this.lastBuilt.push(g.addEdge(p, n, { ...flags }, first ? refund : { bridges: 0, tunnels: 0 }));
      first = false;
    }
    return chain[chain.length - 1];
  }

  private spend(cost: Inventory): void {
    this.inventory.asphalt -= cost.asphalt;
    this.inventory.bridges -= cost.bridges;
    this.inventory.tunnels -= cost.tunnels;
  }

  planBuild(from: Vec, to: Vec): BuildPlan {
    const a = this.snap(from);
    const b = this.snap(to);
    const cost: Inventory = { asphalt: 0, bridges: 0, tunnels: 0, lights: 0, roundabouts: 0 };
    const plan: BuildPlan = { a, b, cost, ok: false, reason: '', crossings: [], flags: { bridge: false, tunnel: false, level: this.level, type: this.roadType } };
    const len = dist(a.point, b.point);
    if (this.badGround(a) || this.badGround(b)) { plan.reason = 'Invalid terrain'; return plan; }
    if ((a.node && a.node === b.node) || len < TILE / 2) { plan.reason = 'Too short'; return plan; }
    const seg = this.planSeg(a, b);
    if (seg.exists) { plan.reason = 'Already exists'; return plan; }
    if (seg.blocked) { plan.reason = 'Too low for the mountain'; return plan; }
    plan.crossings = seg.crossings;
    plan.flags = seg.flags;
    cost.asphalt = Math.ceil(len / TILE * laneFactor(seg.flags.type));
    cost.bridges = seg.flags.bridge ? 1 : 0;
    cost.tunnels = seg.flags.tunnel ? 1 : 0;
    plan.reason = this.afford(cost);
    plan.ok = !plan.reason;
    return plan;
  }

  commitBuild(plan: BuildPlan): void {
    if (!plan.ok) { this.say(plan.reason); return; }
    this.lastBuilt = [];
    this.buildSeg(this.resolve(plan.a), plan.b, plan.flags, plan.crossings, { bridges: plan.cost.bridges, tunnels: plan.cost.tunnels });
    this.spend(plan.cost);
  }

  // Curved / freehand road through several anchors. First and last points use the full snap;
  // intermediate anchors snap to nodes only, so a path can pass through a city or junction.
  // One-way roads travel in the order of 'points'.
  planPath(points: Vec[], level = this.level, type = this.roadType): PathPlan {
    const cost: Inventory = { asphalt: 0, bridges: 0, tunnels: 0, lights: 0, roundabouts: 0 };
    const plan: PathPlan = { points: [], segs: [], cost, ok: false, reason: 'Too short', type: { ...type }, level };
    if (points.length < 2) return plan;
    const mid = (p: Vec): Snap => {
      const n = this.graph.nearestNode(p, NODE_R + 4, level);
      if (!n && this.graph.nearestEdge(p, NODE_R, level)) return this.snap(p, level);
      return n ? { node: n, edge: null, point: { x: n.x, y: n.y } } : { node: null, edge: null, point: { x: p.x, y: p.y } };
    };
    const lastIdx = points.length - 1;
    const list: Snap[] = [];
    points.forEach((p, i) => {
      const s = i === 0 || i === lastIdx ? this.snap(p, level) : mid(p);
      const prev = list[list.length - 1];
      // collapse consecutive anchors on the same node / spot (the final snap wins)
      if (prev && ((s.node && s.node === prev.node) || dist(s.point, prev.point) < 1)) {
        if (i === lastIdx && list.length > 1) list[list.length - 1] = s;
        return;
      }
      const city = prev && this.cities.find(c => c.node !== prev.node && c.node !== s.node && distToSegment(c, prev.point, s.point).d < CITY_R);
      if (city) list.push({ node: city.node, edge: null, point: { x: city.x, y: city.y } });
      list.push(s);
    });
    // drop a trailing stub shorter than TILE/2 unless it ends on a snapped node/edge
    if (list.length > 2) {
      const end = list[list.length - 1];
      if (!end.node && !end.edge && dist(end.point, list[list.length - 2].point) < TILE / 2) {
        list.pop();
        list[list.length - 1] = this.snap(list[list.length - 1].point, level);
      }
    }
    plan.points = list.map(s => s.point);
    if (list.length < 2) return plan;
    if (this.badGround(list[0]) || this.badGround(list[list.length - 1])) { plan.reason = 'Invalid terrain'; return plan; }

    let total = 0, built = 0, prevWater = false, prevMountain = false, blocked = false;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const r = this.planSeg(a, b, level, type);
      const seg: SegPlan = { a: a.point, b: b.point, ...r.flags, sa: a, sb: b, crossings: r.crossings, exists: r.exists, refund: { bridges: 0, tunnels: 0 } };
      plan.segs.push(seg);
      if (r.exists) { prevWater = prevMountain = false; continue; }
      total += dist(a.point, b.point);
      blocked ||= r.blocked;
      if (level > 0) {
        // the whole elevated placement costs one bridge, refunded by its first edge
        if (!built) seg.refund.bridges = 1;
      } else {
        // one bridge / tunnel per maximal run of water / mountain segments, refunded by the run's first edge
        if (seg.bridge && !prevWater) seg.refund.bridges = 1;
        if (seg.tunnel && !prevMountain) seg.refund.tunnels = 1;
      }
      built++;
      cost.bridges += seg.refund.bridges;
      cost.tunnels += seg.refund.tunnels;
      prevWater = seg.bridge;
      prevMountain = seg.tunnel;
    }
    if (!built) { plan.reason = 'Already exists'; return plan; }
    if (total < TILE / 2) return plan; // 'Too short'
    if (blocked) { plan.reason = 'Too low for the mountain'; return plan; }
    cost.asphalt = Math.ceil(total / TILE * laneFactor(type));
    plan.reason = this.afford(cost);
    plan.ok = !plan.reason;
    return plan;
  }

  commitPath(plan: PathPlan): void {
    if (!plan.ok) { if (plan.reason !== 'Too short') this.say(plan.reason); return; }
    const before = this.graph.edges.length;
    this.lastBuilt = [];
    let node: Node | null = null;
    for (const seg of plan.segs as SegPlan[]) {
      // the end snap's edge may have been split by an earlier segment; re-snap if so
      const end = seg.sb.edge && !this.graph.edges.includes(seg.sb.edge) ? this.snap(seg.sb.point, seg.level) : seg.sb;
      // resolve (split) an edge end too, so the next segment leaves the road from a real node
      if (seg.exists) { node = this.resolve(end); continue; }
      const start: Node = node ?? this.resolve(seg.sa);
      // crossings are recomputed on the live graph, since earlier segments may have split edges
      const live = this.planSeg({ node: start, edge: null, point: { x: start.x, y: start.y } }, end, seg.level, seg.type).crossings;
      node = this.buildSeg(start, end, { bridge: seg.bridge, tunnel: seg.tunnel, level: seg.level, type: seg.type }, live, seg.refund);
    }
    // a later segment may have split an edge built by an earlier one
    this.lastBuilt = this.lastBuilt.filter(e => this.graph.edges.includes(e));
    this.spend(plan.cost);
    // ponytail: net edge delta (a split of an existing road adds one too), fine for the tutorial check
    this.lastBuild = { segs: this.graph.edges.length - before, level: plan.segs[0]?.level ?? this.level };
  }

  demolishAt(p: Vec): void {
    const n = this.graph.nearestNode(p, NODE_R + 4);
    if (n && n.control !== 'none') {
      if (n.control === 'light') this.inventory.lights++;
      else this.inventory.roundabouts++;
      n.control = 'none';
      return;
    }
    // prefer a road on the current level where several are stacked
    const hit = this.graph.nearestEdge(p, ROAD_W, this.level) ?? this.graph.nearestEdge(p, ROAD_W);
    if (!hit) return;
    const e = hit.edge;
    this.refundEdge(e);
    this.dropCars(this.graph.removeEdge(e));
  }

  // floor, not round: a curve's short edges must not refund more than ceil(total / TILE) paid
  private asphaltOf(e: Edge): number {
    return Math.floor(e.length / TILE * laneFactor(e.type));
  }

  private refundEdge(e: Edge): void {
    this.inventory.asphalt += this.asphaltOf(e);
    this.inventory.bridges += e.refund.bridges;
    this.inventory.tunnels += e.refund.tunnels;
  }

  // Takes the cars off the road and puts their trips back in their origin's queue,
  // so demolishing or retyping a busy road is not a free way to clear traffic
  private dropCars(cars: Car[]): void {
    for (const car of cars) {
      this.graph.detachCar(car);
      const i = this.cars.indexOf(car);
      if (i >= 0) this.cars.splice(i, 1);
      car.origin.pending.push(car.dest);
    }
  }

  // ---- Edit tool ----

  runAt(p: Vec): Edge[] | null {
    const hit = this.graph.nearestEdge(p, ROAD_W, this.level) ?? this.graph.nearestEdge(p, ROAD_W);
    return hit ? this.graph.runOf(hit.edge).edges : null;
  }

  select(p: Vec | null): void {
    this.selected = p ? this.runAt(p) : null;
  }

  // Switching away from Edit drops the selection at once, so a click right after the switch cannot retype it
  setTool(t: Tool): void {
    this.tool = t;
    if (t !== 'edit') this.selected = null;
  }

  typeOf(run: Edge[]): RoadType {
    return run[0].type;
  }

  // True when the run's first edge points away from its first node (one-way runs then travel first -> last)
  runForward(run: Edge[]): boolean {
    const r = this.graph.runOf(run[0]);
    return r.edges[0].a === r.nodes[0];
  }

  private runRefund(run: Edge[]): number {
    return run.reduce((n, e) => n + this.asphaltOf(e), 0);
  }

  // Asphalt to pay (negative = refund). Same type on every edge (a flip) is free.
  retypeDelta(run: Edge[], type: RoadType): number {
    if (run.every(e => sameType(e.type, type))) return 0;
    const len = run.reduce((n, e) => n + e.length, 0);
    return Math.ceil(len / TILE * laneFactor(type)) - this.runRefund(run);
  }

  // Keeps the run's current travel direction (for one-way results) unless reverse.
  retype(run: Edge[], type: RoadType, reverse = false): boolean {
    if (!reverse && run.every(e => sameType(e.type, type))) return true;
    const d = this.retypeDelta(run, type);
    if (d > this.inventory.asphalt) { this.say('Not enough asphalt'); return false; }
    this.inventory.asphalt -= d;
    const dir = this.runForward(run) !== reverse;
    const { edges, nodes } = this.graph.runOf(run[0]);
    edges.forEach((e, i) => this.dropCars(this.graph.setEdgeType(e, type, (e.a === nodes[i]) === dir)));
    this.say('Road updated');
    return true;
  }

  flip(run: Edge[]): void {
    this.retype(run, this.typeOf(run), true);
  }

  // Rebuilds the run as a curve from its first to its last node through 'handle'.
  // Affordability counts the run's refund; plan.net = cost - refund.
  planBend(run: Edge[], handle: Vec): PathPlan {
    const g = this.graph, r = g.runOf(run[0]);
    const A = r.nodes[0], B = r.nodes[r.nodes.length - 1];
    const type = this.typeOf(run);
    // closed loop: nothing to bend between (and the shared node would be dropped as an orphan)
    if (A === B) return this.planPath([A], run[0].level, type);
    const pts = cubicPoints(A, ...bendControls(A, B, handle), B);
    // a one-way run travelling last -> first is rebuilt in that order
    if (type.oneWay && !this.runForward(run)) pts.reverse();
    const refund = this.runRefund(r.edges);
    const bridges = r.edges.reduce((n, e) => n + e.refund.bridges, 0);
    const tunnels = r.edges.reduce((n, e) => n + e.refund.tunnels, 0);
    const inv = this.inventory;
    g.hidden = new Set(r.edges);
    inv.asphalt += refund; inv.bridges += bridges; inv.tunnels += tunnels;
    try {
      const plan = this.planPath(pts, run[0].level, type);
      plan.net = plan.cost.asphalt - refund;
      return plan;
    } finally {
      g.hidden = new Set();
      inv.asphalt -= refund; inv.bridges -= bridges; inv.tunnels -= tunnels;
    }
  }

  commitBend(run: Edge[], plan: PathPlan): boolean {
    if (!plan.ok) { if (plan.reason !== 'Too short') this.say(plan.reason); return false; }
    const g = this.graph, r = g.runOf(run[0]);
    const rev = this.typeOf(run).oneWay && !this.runForward(run);
    const total = r.edges.reduce((n, e) => n + e.length, 0);
    const moved: { car: Car; forward: boolean; frac: number }[] = [];
    let acc = 0;
    r.edges.forEach((e, i) => {
      for (const l of e.lanes) for (const car of l.cars) {
        const forward = l.from === r.nodes[i];
        moved.push({ car, forward, frac: (acc + (forward ? car.s : e.length - car.s)) / total });
      }
      acc += e.length;
    });
    for (const e of r.edges) {
      this.refundEdge(e);
      for (const car of g.removeEdge(e)) g.detachCar(car);
    }
    this.commitPath(plan);
    // lastBuilt runs in plan order: A -> B, or B -> A for a reversed one-way run
    const built = this.lastBuilt;
    const len = built.reduce((n, e) => n + e.length, 0);
    for (const m of moved) {
      const fwd = m.forward !== rev;
      let d = (rev ? 1 - m.frac : m.frac) * len, i = 0;
      while (i < built.length - 1 && d > built[i].length) d -= built[i++].length;
      const e = built[i];
      const lane = e ? g.pickLane(e, fwd ? e.a : e.b) : null;
      if (!lane) { this.dropCars([m.car]); continue; }
      const c = m.car;
      c.s = Math.max(0, Math.min(e.length, fwd ? d : e.length - d));
      c.lane = lane;
      c.path = null; c.queued = false; c.granted = null; c.clearing = null; c.prev = null;
      const at = lane.cars.findIndex(o => o.s > c.s);
      lane.cars.splice(at < 0 ? lane.cars.length : at, 0, c);
    }
    this.selected = built.length ? [...built] : null;
    return true;
  }

  placeControl(p: Vec, kind: 'light' | 'roundabout'): void {
    const n = this.graph.nearestNode(p, NODE_R + 6);
    if (!n || n.city || n.edges.length < 3) { this.say('Place on an intersection'); return; }
    if (n.control === kind) return;
    const key = kind === 'light' ? 'lights' : 'roundabouts';
    if (this.inventory[key] <= 0) { this.say('No ' + (kind === 'light' ? 'traffic lights' : 'roundabouts') + ' left'); return; }
    if (n.control === 'light') this.inventory.lights++;
    else if (n.control === 'roundabout') this.inventory.roundabouts++;
    n.control = kind;
    this.inventory[key]--;
  }

  applyReward(i: number): void {
    const r = this.pendingReward?.[i];
    if (r) for (const k of Object.keys(r) as (keyof Inventory)[]) this.inventory[k] += r[k] ?? 0;
    this.pendingReward = null;
  }

  say(text: string): void {
    this.message = text;
    clearTimeout(this.msgTimeout);
    // ponytail: real time (2.5 s), so the message clears even while the game is paused
    this.msgTimeout = setTimeout(() => { this.message = ''; }, 2500);
  }
}
