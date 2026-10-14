import type { Vec } from '../util/geom.ts';
import { dist, distToSegment } from '../util/geom.ts';
import type { Terrain } from '../world/MapGenerator.ts';
import { generateTerrain, inWater, inMountain, segmentCrosses, findStarterTown } from '../world/MapGenerator.ts';
import type { Node, Edge, EdgeFlags, RoadType } from '../network/RoadGraph.ts';
import { RoadGraph, TILE, ROAD_W, NODE_R, GAP, DEFAULT_TYPE, laneFactor, sameType, fitType, roadWidth } from '../network/RoadGraph.ts';
import { cubicPoints, bendControls } from '../util/curve.ts';
import { findPath } from '../network/Pathfinder.ts';
import { DOOR_D, DOOR_R } from '../entities/Building.ts';
import type { Building } from '../entities/Building.ts';
import { Car, KINDS, randomKind } from '../entities/Car.ts';
import { DEFAULT_CONFIG, DIFFICULTY, TIERS, TUNING as T } from './config.ts';
import type { GameConfig, Purpose, Tier } from './config.ts';
import { hashSeed, random, setSeed } from '../util/rng.ts';

export type Tool = 'road' | 'light' | 'roundabout' | 'demolish' | 'edit';
export const DAY_SECONDS = 15; // one week = 7 days
// $ per day by category; build is the net spent on construction (refunds count negative)
export interface Ledger { taxes: number; business: number; upkeep: number; build: number; grants: number }
const ledger0 = (): Ledger => ({ taxes: 0, business: 0, upkeep: 0, build: 0, grants: 0 });
export const income = (l: Ledger): number => l.taxes + l.business + l.grants;
// $24,310 · $1.2M · −$1,200 · ∞
export const fmtMoney = (n: number): string => {
  if (n === Infinity) return '∞';
  const a = Math.abs(n), s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : Math.round(a).toLocaleString('en-US');
  return (n < 0 && s !== '0' ? '−$' : '$') + s;
};
export interface Snap { node: Node | null; edge: Edge | null; point: Vec }
export interface PathSeg { a: Vec; b: Vec; bridge: boolean; tunnel: boolean; level: number; type: RoadType }
// cost in $; net: bend plans only, cost minus the full price of the replaced run
export interface PathPlan { points: Vec[]; segs: PathSeg[]; cost: number; ok: boolean; reason: string; type: RoadType; level: number; net?: number }
type Crossing = { edge: Edge; point: Vec; t: number; node: Node | null };
interface SegPlan extends PathSeg { sa: Snap; sb: Snap; crossings: Crossing[]; exists: boolean }
const CONTROL_COST = { light: T.LIGHT_COST, roundabout: T.ROUNDABOUT_COST };
const CONTROL_UPKEEP = { light: T.LIGHT_UPKEEP, roundabout: T.ROUNDABOUT_UPKEEP };
const MAX_LEVEL = 10;
const MOUNTAIN_LEVEL = 6; // viaducts at this level or higher clear mountains

export class Game {
  terrain: Terrain;
  graph = new RoadGraph();
  buildings: Building[] = [];
  cars: Car[] = [];
  // Infinity in creative mode
  money: number;
  ledger = { today: ledger0(), yesterday: ledger0() };
  // Upkeep of the current network per day, refreshed on every spend and at midnight
  upkeepDay = 0;
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
  message = '';
  // While true: slower demand (later steps: no fail checks)
  tutorialActive = false;
  // No placeholder demand and no return trips (simcheck drives its own trips)
  demandOff = false;
  // World points the renderer highlights while tutorialActive
  tutorialTargets: Vec[] = [];
  // Last successful commitPath: edges created and plan level (read by the tutorial)
  lastBuild: { segs: number; level: number } | null = null;
  private lastDay = 0;
  private msgTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(public cfg: GameConfig = DEFAULT_CONFIG) {
    // the trip/driver stream is seeded apart from the terrain's, so the two never mirror each other
    setSeed(hashSeed('sim:' + cfg.seed));
    this.terrain = generateTerrain(cfg);
    this.money = cfg.mode === 'creative' ? Infinity : DIFFICULTY[cfg.difficulty].money;
    const town = findStarterTown(this.terrain);
    for (const b of town?.buildings ?? []) this.addBuilding(b);
    if (town && DIFFICULTY[cfg.difficulty].starterRoad) {
      const [a, b] = town.road, g = this.graph;
      // ponytail: free, but built 'yesterday' so it refunds REFUND_LATER like any old road (~$165 on easy's $60k)
      g.addEdge(g.addNode(a.x, a.y), g.addNode(b.x, b.y), { bridge: false, tunnel: false, level: 0, type: DEFAULT_TYPE }, -1);
      this.connect();
      this.upkeepDay = this.upkeepPerDay();
    }
  }

  // Adds the building with its door node; demand timers are staggered so the town does not pulse
  addBuilding(b: Building): Building {
    const d = b.door();
    this.graph.addNode(d.x, d.y, b);
    b.demandTimer = random() * T.HOME_TRIP_S[1];
    this.buildings.push(b);
    return b;
  }

  queueTrip(from: Building, to: Building, purpose: Purpose, back = false): void {
    from.pending.push({ purpose, from, to, back });
  }

  get day(): number { return (Math.floor(this.time / DAY_SECONDS) % 7) + 1; }
  get week(): number { return Math.floor(this.time / (DAY_SECONDS * 7)) + 1; }
  // Days since the start: the refund rule's "today"
  get today(): number { return Math.floor(this.time / DAY_SECONDS); }
  get running(): boolean { return !this.gameOver && this.speed > 0; }

  update(dt: number): void {
    if (!this.running) return;
    this.time += dt;

    if (this.today > this.lastDay) {
      // ponytail: upkeep is paid in one lump at midnight; hourly once S5's clock exists
      this.lastDay = this.today;
      this.upkeepDay = this.upkeepPerDay();
      this.money -= this.upkeepDay;
      this.ledger.today.upkeep += this.upkeepDay;
      this.ledger = { today: ledger0(), yesterday: this.ledger.today };
    }

    for (const b of this.buildings) {
      this.demand(b, dt);
      this.trySpawnCar(b, dt);
    }

    this.graph.update(dt);

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const r = car.update(dt, this.graph);
      if (r === 'ok') continue;
      if (r === 'stuck' || r === 'lost') { this.dropCars([car]); continue; }
      if (r === 'arrived') {
        this.score++;
        // ponytail: flat pay per arrival until S7's taxes and business income
        const pay = T.ARRIVAL_PAY * DIFFICULTY[this.cfg.difficulty].tax;
        this.money += pay;
        this.ledger.today.business += pay;
        const t = car.trip;
        if (!t.back && !this.demandOff) this.queueTrip(t.to, t.from, t.purpose, true);
      }
      this.graph.detachCar(car);
      this.cars.splice(i, 1);
    }
  }

  // Placeholder demand until S5: a home queues a commute (70%) or a shopping trip, a factory a freight run, to a random
  // connected destination; the car comes back on arrival (Game.update)
  private demand(b: Building, dt: number): void {
    if (this.demandOff || !b.connected || (b.kind !== 'home' && b.kind !== 'industry') || (b.demandTimer -= dt) > 0) return;
    const [lo, hi] = b.kind === 'home' ? T.HOME_TRIP_S : T.FACTORY_TRIP_S;
    b.demandTimer = (lo + random() * (hi - lo)) * (this.tutorialActive ? 1.5 : 1) / DIFFICULTY[this.cfg.difficulty].trips;
    const purpose: Purpose = b.kind === 'industry' ? 'freight' : random() < 0.7 ? 'commute' : 'shop';
    const to = this.buildings.filter(o => o !== b && o.connected && (purpose === 'commute' ? o.kind !== 'home' : o.kind === 'shop'));
    if (to.length && b.pending.length < T.MAX_PENDING) this.queueTrip(b, to[Math.floor(random() * to.length)], purpose);
  }

  // First pending trip whose first lane has room goes out; a trip with no route is dropped (S5 reports it)
  private trySpawnCar(b: Building, dt: number): void {
    b.retryTimer -= dt;
    if (b.retryTimer > 0 || !b.pending.length || !b.connected) return;
    b.retryTimer = 0.4;
    const rk = randomKind();
    for (let i = 0; i < b.pending.length; i++) {
      const trip = b.pending[i], kind = trip.purpose === 'freight' ? 'truck' : rk, len = KINDS[kind].len;
      const path = findPath(this.graph, b.node, trip.to.node);
      if (!path || path.length < 2) { b.pending.splice(i--, 1); continue; }
      const e = this.graph.edgeBetween(b.node, path[1]);
      if (!e) continue;
      const lane = this.graph.pickLane(e, b.node, this.graph.turn(path, 1));
      const f = lane?.cars[0];
      if (!lane || (f && f.s < (f.len + len) / 2 + GAP * 2)) continue;
      b.pending.splice(i, 1);
      const car = new Car(lane, trip, kind);
      car.path = path.slice(1);
      lane.cars.unshift(car);
      this.cars.push(car);
      return;
    }
  }

  // Unlock hook for tools and tiers; ponytail: everything is unlocked until S6 compares TIERS[t].level with the city level
  tierUnlocked(_t: Tier): boolean {
    return true;
  }

  private lockedMsg(t: Tier): string {
    return this.tierUnlocked(t) ? '' : `Unlocks at level ${TIERS[t].level}`;
  }

  // Lanes and one-way are clamped to the tier (fitType)
  setRoadType(t: RoadType): void {
    const locked = this.lockedMsg(t.tier);
    if (locked) { this.say(locked); return; }
    this.roadType = fitType(t);
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
        if (!n.building && e.level !== this.level) continue;
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
    flags.bridge = level > 0 || terr.water > 0;
    flags.tunnel = level === 0 && terr.mountain > 0;
    return { flags, crossings, exists, blocked: level > 0 && level < MOUNTAIN_LEVEL && terr.mountain > 0 };
  }

  private badGround(s: Snap): boolean {
    return !s.node && !s.edge && (inWater(this.terrain, s.point) || inMountain(this.terrain, s.point));
  }

  private afford(cost: number): string {
    return cost > this.money ? 'Not enough money' : '';
  }

  // Pays (negative: gets back) construction money and refreshes the daily upkeep
  private spend(cost: number): void {
    this.money -= cost;
    this.ledger.today.build += cost;
    this.upkeepDay = this.upkeepPerDay();
  }

  // Build price of a road from a to b: per tile and lane at the tier's rate, x the viaduct factor, or x the bridge / tunnel factor on the
  // share of its length over water / through a mountain. Geometry only, so a split road keeps its total.
  // ponytail: money stays a float (no rounding), so splits and same-day refunds add up exactly; the HUD rounds
  price(a: Vec, b: Vec, f: EdgeFlags): number {
    const base = dist(a, b) / TILE * laneFactor(f.type) * TIERS[f.type.tier].cost;
    if (f.level > 0) return base * (T.VIADUCT_X + T.VIADUCT_LEVEL_X * f.level);
    if (!f.bridge && !f.tunnel) return base;
    const s = segmentCrosses(this.terrain, a, b);
    return base * (1 + (f.bridge ? (T.BRIDGE_X - 1) * s.water : 0) + (f.tunnel ? (T.TUNNEL_X - 1) * s.mountain : 0));
  }

  // A driveway is free as it stands, but priced in full when 'type' (a retype) is asked for
  private edgePrice(e: Edge, type?: RoadType): number {
    return !type && e.drive ? 0 : this.price(e.a, e.b, { ...e, type: type ?? e.type });
  }

  // A road from a to b runs through a footprint (grown by up to DOOR_D - 2, so a road along the front still reaches a door)
  // ponytail: samples every 4px, like segmentCrosses
  private hitsBuilding(a: Vec, b: Vec, type: RoadType): boolean {
    const pad = Math.min(roadWidth(type) / 2, DOOR_D - 2), n = Math.max(1, Math.ceil(dist(a, b) / 4));
    for (const bd of this.buildings) {
      if (distToSegment(bd, a, b).d > (bd.w + bd.h) / 2 + pad) continue;
      for (let i = 0; i <= n; i++) if (bd.contains({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }, pad)) return true;
    }
    return false;
  }

  // Free driveway from each building without a road to the nearest ground road with access within ACCESS_R of its door:
  // a straight stub that crosses no road, water, mountain or footprint.
  // ponytail: runs only after a road is built or bent, so a demolished driveway stays gone until the next road goes down
  private connect(): void {
    const g = this.graph;
    for (const b of this.buildings) {
      if (b.connected) continue;
      const door = b.node;
      const hits = g.edges.filter(e => e.level === 0 && !e.tunnel && !e.bridge && !e.drive && TIERS[e.type.tier].access)
        .map(e => ({ e, ...distToSegment(door, e.a, e.b) })).filter(h => h.d <= T.ACCESS_R).sort((p, q) => p.d - q.d);
      for (const h of hits) {
        const end = dist(h.point, h.e.a) <= NODE_R ? h.e.a : dist(h.point, h.e.b) <= NODE_R ? h.e.b : null;
        if (end?.building) continue;
        const p = end ?? h.point, terr = segmentCrosses(this.terrain, door, p);
        if (terr.water || terr.mountain || this.hitsBuilding(door, p, DEFAULT_TYPE)) continue;
        if (g.crossings(door, p, new Set(end ? [end] : []), new Set([h.e]), 0).length) continue;
        g.addEdge(door, end ?? g.splitEdge(h.e, h.point), { bridge: false, tunnel: false, level: 0, type: DEFAULT_TYPE, drive: true }, this.today);
        break;
      }
    }
  }

  private refundX(day: number): number {
    return day === this.today ? T.REFUND_SAME_DAY : T.REFUND_LATER;
  }

  refundOf(e: Edge): number {
    return this.edgePrice(e) * this.refundX(e.day);
  }

  controlPrice(kind: 'light' | 'roundabout'): number {
    return CONTROL_COST[kind];
  }

  controlRefund(n: Node): number {
    return n.control === 'none' ? 0 : CONTROL_COST[n.control] * this.refundX(n.controlDay);
  }

  upkeepPerDay(): number {
    let sum = 0;
    for (const e of this.graph.edges) sum += this.edgePrice(e) * T.UPKEEP_RATE;
    for (const n of this.graph.nodes) if (n.control !== 'none') sum += CONTROL_UPKEEP[n.control];
    return sum * DIFFICULTY[this.cfg.difficulty].upkeep;
  }

  private resolve(s: Snap): Node {
    return s.node ?? (s.edge ? this.graph.splitEdge(s.edge, s.point) : this.graph.addNode(s.point.x, s.point.y));
  }

  // Builds one segment from an existing node and returns its end node
  private buildSeg(start: Node, end: Snap, flags: EdgeFlags, crossings: Crossing[]): Node {
    const g = this.graph;
    const chain: Node[] = [start];
    for (const c of crossings) chain.push(c.node ?? g.splitEdge(c.edge, c.point));
    chain.push(this.resolve(end));
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i - 1], n = chain[i];
      // ponytail: skip degenerate segments (same node or already connected) instead of duplicating edges
      if (p === n || g.edgeBetween(p, n)) continue;
      this.lastBuilt.push(g.addEdge(p, n, { ...flags }, this.today));
    }
    return chain[chain.length - 1];
  }

  // Curved / freehand road through several anchors. First and last points use the full snap;
  // intermediate anchors snap to nodes only, so a path can pass through a junction, or the door of a building without a road.
  // One-way roads travel in the order of 'points'.
  planPath(points: Vec[], level = this.level, type = this.roadType): PathPlan {
    const plan: PathPlan = { points: [], segs: [], cost: 0, ok: false, reason: 'Too short', type: { ...type }, level };
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
      const door = prev && this.buildings.find(b => !b.connected && b.node !== prev.node && b.node !== s.node && distToSegment(b.node, prev.point, s.point).d < DOOR_R)?.node;
      if (door) list.push({ node: door, edge: null, point: { x: door.x, y: door.y } });
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

    let total = 0, built = 0, blocked = false, hit = false;
    const noAccess = !TIERS[type.tier].access && list.some(s => s.node?.building);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const r = this.planSeg(a, b, level, type);
      const seg: SegPlan = { a: a.point, b: b.point, ...r.flags, sa: a, sb: b, crossings: r.crossings, exists: r.exists };
      plan.segs.push(seg);
      if (r.exists) continue;
      total += dist(a.point, b.point);
      plan.cost += this.price(a.point, b.point, r.flags);
      blocked ||= r.blocked;
      hit ||= this.hitsBuilding(a.point, b.point, type);
      built++;
    }
    if (!built) { plan.reason = 'Already exists'; return plan; }
    if (total < TILE / 2) return plan; // 'Too short'
    if (blocked) { plan.reason = 'Too low for the mountain'; return plan; }
    if (noAccess) { plan.reason = 'Highways give no building access'; return plan; }
    if (hit) { plan.reason = 'Blocked by a building'; return plan; }
    plan.reason = this.lockedMsg(type.tier) || this.afford(plan.cost);
    plan.ok = !plan.reason;
    return plan;
  }

  // link: give buildings near the new road their driveways (commitBend does it itself once its cars are moved)
  commitPath(plan: PathPlan, link = true): void {
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
      node = this.buildSeg(start, end, { bridge: seg.bridge, tunnel: seg.tunnel, level: seg.level, type: seg.type }, live);
    }
    if (link) this.connect();
    // a later segment (or a driveway) may have split an edge built by an earlier one
    this.lastBuilt = this.lastBuilt.filter(e => this.graph.edges.includes(e));
    this.spend(plan.cost);
    // ponytail: net edge delta (a split of an existing road adds one too), fine for the tutorial check
    this.lastBuild = { segs: this.graph.edges.length - before, level: plan.segs[0]?.level ?? this.level };
  }

  demolishAt(p: Vec): void {
    const n = this.graph.nearestNode(p, NODE_R + 4);
    if (n && n.control !== 'none') {
      const back = this.controlRefund(n);
      n.control = 'none';
      this.spend(-back);
      return;
    }
    // prefer a road on the current level where several are stacked
    const hit = this.graph.nearestEdge(p, ROAD_W, this.level) ?? this.graph.nearestEdge(p, ROAD_W);
    if (!hit) return;
    const e = hit.edge, back = this.refundOf(e);
    this.dropCars(this.graph.removeEdge(e));
    this.spend(-back);
  }

  // Takes the cars off the road and puts their trips back in their origin's queue,
  // so demolishing or retyping a busy road is not a free way to clear traffic
  private dropCars(cars: Car[]): void {
    for (const car of cars) {
      this.graph.detachCar(car);
      const i = this.cars.indexOf(car);
      if (i >= 0) this.cars.splice(i, 1);
      car.origin.pending.push(car.trip);
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

  // Full build price of the run (as 'type'). Editing credits the old road in full.
  // ponytail: so a downgrade refunds the whole difference, even on an old road
  private runPrice(run: Edge[], type?: RoadType): number {
    return run.reduce((n, e) => n + this.edgePrice(e, type), 0);
  }

  // $ to pay (negative = refund) for the run as fitType(type). Same type on every edge (a flip) is free.
  retypeDelta(run: Edge[], type: RoadType): number {
    type = fitType(type);
    if (run.every(e => sameType(e.type, type))) return 0;
    return this.runPrice(run, type) - this.runPrice(run);
  }

  // Retypes the run as fitType(type), upgrades and downgrades across tiers included.
  // Keeps the run's current travel direction (for one-way results) unless reverse.
  retype(run: Edge[], type: RoadType, reverse = false): boolean {
    type = fitType(type);
    if (!reverse && run.every(e => sameType(e.type, type))) return true;
    const { edges, nodes } = this.graph.runOf(run[0]);
    const why = this.lockedMsg(type.tier)
      || (!TIERS[type.tier].access && (nodes[0].building || nodes[nodes.length - 1].building) ? 'Highways give no building access' : '');
    if (why) { this.say(why); return false; }
    const d = this.retypeDelta(run, type);
    if (d > this.money) { this.say('Not enough money'); return false; }
    const dir = this.runForward(run) !== reverse;
    edges.forEach((e, i) => {
      // a retyped driveway becomes a road you paid for
      if (!sameType(e.type, type)) e.drive = false;
      this.dropCars(this.graph.setEdgeType(e, type, (e.a === nodes[i]) === dir));
    });
    this.spend(d);
    this.say('Road updated');
    return true;
  }

  flip(run: Edge[]): void {
    this.retype(run, this.typeOf(run), true);
  }

  // Rebuilds the run as a curve from its first to its last node through 'handle'.
  // Affordability counts the run's full price as credit; plan.net = cost - credit.
  planBend(run: Edge[], handle: Vec): PathPlan {
    const g = this.graph, r = g.runOf(run[0]);
    const A = r.nodes[0], B = r.nodes[r.nodes.length - 1];
    const type = this.typeOf(run);
    // closed loop: nothing to bend between (and the shared node would be dropped as an orphan)
    if (A === B) return this.planPath([A], run[0].level, type);
    const pts = cubicPoints(A, ...bendControls(A, B, handle), B);
    // a one-way run travelling last -> first is rebuilt in that order
    if (type.oneWay && !this.runForward(run)) pts.reverse();
    const credit = this.runPrice(r.edges);
    g.hidden = new Set(r.edges);
    this.money += credit;
    try {
      const plan = this.planPath(pts, run[0].level, type);
      plan.net = plan.cost - credit;
      return plan;
    } finally {
      g.hidden = new Set();
      this.money -= credit;
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
    const credit = this.runPrice(r.edges), day = Math.min(...r.edges.map(e => e.day));
    for (const e of r.edges) for (const car of g.removeEdge(e)) g.detachCar(car);
    this.spend(-credit);
    this.commitPath(plan, false);
    // lastBuilt runs in plan order: A -> B, or B -> A for a reversed one-way run
    const built = this.lastBuilt;
    // the bent road keeps its oldest build day, so a bend never buys a same-day refund
    for (const e of built) e.day = day;
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
    this.connect();
    const live = built.filter(e => g.edges.includes(e));
    this.selected = live.length ? live : null;
    return true;
  }

  placeControl(p: Vec, kind: 'light' | 'roundabout'): void {
    const n = this.graph.nearestNode(p, NODE_R + 6);
    if (!n || n.building || n.edges.length < 3) { this.say('Place on an intersection'); return; }
    if (n.control === kind) return;
    // switching sells the old control under the refund rule
    const cost = CONTROL_COST[kind] - this.controlRefund(n);
    if (cost > this.money) { this.say('Not enough money'); return; }
    n.control = kind;
    n.controlDay = this.today;
    this.spend(cost);
  }

  say(text: string): void {
    this.message = text;
    clearTimeout(this.msgTimeout);
    // ponytail: real time (2.5 s), so the message clears even while the game is paused
    this.msgTimeout = setTimeout(() => { this.message = ''; }, 2500);
  }
}
