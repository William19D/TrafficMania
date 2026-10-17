import type { Vec } from '../util/geom.ts';
import { dist, distToSegment } from '../util/geom.ts';
import type { Terrain } from '../world/MapGenerator.ts';
import { WORLD, generateTerrain, inWater, inMountain, segmentCrosses, shoreSplits, findStarterTown } from '../world/MapGenerator.ts';
import type { Control, Node, Edge, EdgeFlags, Lane, RingSize, RoadType } from '../network/RoadGraph.ts';
import type { JunctionPlan } from '../network/Junction.ts';
import { clonePlan, edgeAngle, planFits, planOf } from '../network/Junction.ts';
import { RoadGraph, TILE, ROAD_W, NODE_R, GAP, CAR_LEN, DEFAULT_TYPE, RINGS, clearR, onRing, ringOut, laneFactor, sameType, fitType, roadWidth } from '../network/RoadGraph.ts';
import { cubicPoints, bendControls, autoControls } from '../util/curve.ts';
import { findPath } from '../network/Pathfinder.ts';
import { DOOR_D, DOOR_R, Building, buildingAt } from '../entities/Building.ts';
import type { Commuter, Parts } from '../entities/Building.ts';
import { FAILED, makeTrip, OUTCOMES, SCORE } from '../entities/Trip.ts';
import type { Outcome, Trip, TripReport } from '../entities/Trip.ts';
import { Car, KINDS, randomKind } from '../entities/Car.ts';
import { DEFAULT_CONFIG, DIFFICULTY, ENDLESS_POP, LEVELS, SPECIALS, TIERS, TIER_DEFS, UNLOCKS, ZONES, ZONE_NAME, TUNING as T } from './config.ts';
import type { Feature, GameConfig, Purpose, Site, Special, Tier, Zone } from './config.ts';
import { hashSeed, random, setSeed } from '../util/rng.ts';
import { ICHG, ICHG_KEYS } from './Templates.ts';
import { Metrics } from './Metrics.ts';
import type { Ichg } from './Templates.ts';
import { adoptLots, demandOf, pruneLots, zoneHour } from './Zones.ts';
import type { Lot, ZonePlan } from './Zones.ts';
import { CHALLENGE_MONEY, DEADLINE, GRIDLOCK, GRIDLOCK_MIN, MAPS, closeHour, grade, mapById, milestonePop, offersFor, run0, unlockAt } from './Campaign.ts';
import type { Grade, MapDef, Offer, RunState, Upgrade } from './Campaign.ts';
import { eventsHour, eventsTick, vipArrived } from './Events.ts';
import type { ActiveEvent, EventKind } from './Events.ts';

// zone: the zone brush; place: setting a building down (moving a legacy one)
export type Tool = 'road' | 'light' | 'roundabout' | 'demolish' | 'edit' | 'place' | 'grid' | 'interchange' | 'zone';
// Tools locked until a campaign map unlocks them
export const TOOL_LOCK: Partial<Record<Tool, Feature>> = { roundabout: 'roundabout', grid: 'grid', interchange: 'interchange' };
// Challenge fails: debt, unhappy residents, a day of gridlock, the deadline passed
export type GameOver = '' | 'bankrupt' | 'unhappy' | 'gridlock' | 'deadline';
// Map overlays: congestion heat map, or road noise and factory pollution with each home's happiness
export type Overlay = 'none' | 'heat' | 'noise';
// Sound cues the sim raises (a set: one per kind per frame); the audio drains it, headless nobody does and it stays this small
export type Sfx = 'build' | 'demolish' | 'place' | 'clear';
// Map juice the renderer draws and ages out: a coin pop on income, sparkles where a jam cleared (not saved, the last FX_MAX, FX_LIFE game s)
export interface Fx { kind: 'coin' | 'clear'; x: number; y: number; at: number; n: number }
export const FX_LIFE = 2;
const FX_MAX = 40, JAM_HI = 0.7, JAM_LO = 0.35;
// Game seconds per in-game hour
export const HOUR = T.DAY_SECONDS / 24;
// Match day quest (game-v3 8): this share of fans on time pays the bonus
const MATCH_Q = 0.85, MATCH_BONUS = 2000;
const SHOP_SUM = T.SHOP_CURVE.reduce<number>((n, x) => n + x, 0);
export const OUTCOME_LABEL: Record<Outcome, string> = { smooth: 'smooth run', wait: 'long wait', detour: 'detour', gaveup: 'gave up', noroute: 'no route' };
const outcomes0 = (): Record<Outcome, number> => Object.fromEntries(OUTCOMES.map(o => [o, 0])) as Record<Outcome, number>;
// $ per day by category; build is the net spent on construction (refunds count negative)
// trade: exports, imports and visitors through the highway exits
// interest: on the bank loan
// A notification feed item: its text, where a click jumps (null: nowhere) and when it came
export interface News { text: string; at: Vec | null; day: number; hour: number }
export interface Ledger { taxes: number; business: number; trade: number; upkeep: number; build: number; grants: number; interest: number }
export const ledger0 = (): Ledger => ({ taxes: 0, business: 0, trade: 0, upkeep: 0, build: 0, grants: 0, interest: 0 });
// $24,310 · $1.2M · −$1,200 · ∞
export const fmtMoney = (n: number): string => {
  if (n === Infinity) return '∞';
  const a = Math.abs(n), s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : Math.round(a).toLocaleString('en-US');
  return (n < 0 && s !== '0' ? '−$' : '$') + s;
};
// Game seconds as in-game time: 14 min · 1.5 h
export const fmtMin = (secs: number): string => {
  const m = secs / HOUR * 60;
  return m < 59.5 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
};
// What held a car up at node n: its control, 'none' for a plain junction, 'road' for a queue between junctions
export const jamAt = (n: Node | null): Control | 'road' => !n ? 'road' : onRing(n) ? 'roundabout' : n.control === 'none' && n.edges.length < 3 ? 'road' : n.control;
export interface Snap { node: Node | null; edge: Edge | null; point: Vec }
// Place tool ghost: road = where its driveway would join (null: no access road in reach); warn = what its residents will dislike
export interface PlacePlan { b: Building; ok: boolean; reason: string; warn: string; road: Vec | null; label: string }
export const ZONE_KEYS = (Object.keys(ZONES) as Site[]).filter((z): z is Zone => z !== 'gate');
// Population to reach city level n (level 1 = the start)
export const levelPop = (n: number): number =>
  n <= LEVELS.length ? LEVELS[Math.max(0, n - 1)].pop : LEVELS[LEVELS.length - 1].pop + (n - LEVELS.length) * ENDLESS_POP;
// What campaign map n brings: road tiers, features, zones and building tiers, specials
export const levelUnlocks = (n: number): string[] => [
  ...(Object.keys(TIERS) as Tier[]).filter(t => TIERS[t].level === n).map(t => TIERS[t].label),
  ...Object.values(UNLOCKS).filter(u => u.level === n).map(u => u.label),
  ...ZONE_KEYS.flatMap(z => TIER_DEFS[z].filter(d => d.level === n && (n > 1 || d === TIER_DEFS[z][0])).map(d => d === TIER_DEFS[z][0] ? `${ZONE_NAME[z]} zone` : d.name)),
  ...Object.values(SPECIALS).filter(d => d.level === n).map(d => d.name),
];
export interface PathSeg { a: Vec; b: Vec; bridge: boolean; tunnel: boolean; level: number; type: RoadType }
// cost in $; net: bend and interchange plans, cost minus the full price of the replaced run (bend) or the refunds (interchange);
// note: what the preview label leads with (grid size, interchange name)
export interface PathPlan { points: Vec[]; segs: PathSeg[]; cost: number; ok: boolean; reason: string; type: RoadType; level: number; net?: number; note?: string }
type Crossing = { edge: Edge; point: Vec; t: number; node: Node | null };
// A building's door, a node a driveway joins, or a driveway: a road without access may not touch it
// (a highway exit's gate is no doorway: its own stub is a highway)
const doorway = (n: Node | null, e?: Edge | null): boolean => !!n && (!!n.building && n.building.kind !== 'gate' || n.edges.some(x => x.drive)) || !!e?.drive;
// Roads closer than this (centre to centre) overlap: their bodies cross by more than 2px
const overlapTol = (a: RoadType, b: RoadType): number => (roadWidth(a) + roadWidth(b)) / 2 - 2;
const PERMANENT = 'Challenge: roads and junction controls are permanent after the day they were built';
// The highway stub of an outside connection: free, and it cannot be demolished. Every piece of a split stub keeps Edge.exit;
// the gate test covers a bent stub's end and older saves
export const exitEdge = (e: Edge): boolean => e.exit || e.a.building?.kind === 'gate' || e.b.building?.kind === 'gate';
const EXIT_TYPE: RoadType = { tier: 'highway', lanes: 2, oneWay: false };
// up: an existing stretch the path retypes (drawn over with another type)
interface SegPlan extends PathSeg { sa: Snap; sb: Snap; crossings: Crossing[]; exists: boolean; up?: boolean }
// A crossing road's arm from the junction to the cut point 'at' (edges[i] leaves nodes[i])
interface Arm { edges: Edge[]; nodes: Node[]; at: Vec }
// A template laid on a junction: local (u, v) -> world, the arms to cut, the rebuilt crossing road's type and the ramps' type
interface IchgFrame { map: (p: Vec) => Vec; cuts: Arm[]; deck: RoadType; ramp: RoadType }
export const CONTROL_LABEL: Record<Control, string> = { none: 'None', yield: 'Yield', stop: 'Stop', light: 'Light', roundabout: 'Roundabout' };
const CONTROL_COST: Record<Control, number> = { none: 0, yield: T.SIGN_COST, stop: T.SIGN_COST, light: T.LIGHT_COST, roundabout: T.ROUNDABOUT_COST };
const CONTROL_UPKEEP: Record<Control, number> = { none: 0, yield: T.SIGN_UPKEEP, stop: T.SIGN_UPKEEP, light: T.LIGHT_UPKEEP, roundabout: T.ROUNDABOUT_UPKEEP };
const MAX_LEVEL = 10;
// Tiers from the lowest up
const TIER_RANK = Object.keys(TIERS) as Tier[];
const MOUNTAIN_LEVEL = 6; // viaducts at this level or higher clear mountains

export class Game {
  terrain: Terrain;
  graph = new RoadGraph();
  buildings: Building[] = [];
  commuters: Commuter[] = [];
  cars: Car[] = [];
  // Last 200 finished trips, oldest first; arrived / failed since the start, outcomes since midnight
  reports: TripReport[] = [];
  stats = { arrived: 0, smooth: 0, failed: 0, today: outcomes0() };
  metrics = new Metrics();
  overlay: Overlay = 'none';
  // Purpose toggle (P): a roof dot in the trip purpose's colour on every vehicle
  purposeDots = false;
  // Edit click: the car the camera follows (its card), the building whose card is open
  follow: Car | null = null;
  picked: Building | null = null;
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
  // City level (LEVELS, Endless): counted only, the milestone choices are the reward
  cityLevel = 1;
  // Milestone choices (Campaign.ts): milestones reached, the cards on offer (the modal), the card passed over (offered first next time),
  // upgrades taken and free special tokens held
  milestone = 0;
  offers: Offer[] | null = null;
  spare: Offer | null = null;
  upgrades: Upgrade[] = [];
  tokens: Special[] = [];
  // Achievement counters (Achievements.ts): paint (most lots in one drag), streak (trips since one gave up), amb (fast ambulances),
  // clover, debtfree, loaned (flags); fv bumps on each, so main.ts checks at once
  feats: Record<string, number> = {};
  fv = 0;
  // Zones: the painted lots; demand -1..1 and the buildings each zone has accrued toward its next spawn (hourly); the zone the brush
  // holds (null = Unzone) and its preview while dragging
  lots: Lot[] = [];
  demand: Record<Zone, number> = { home: 0, shop: 0, office: 0, industry: 0 };
  spawnAcc: Record<Zone, number> = { home: 0, shop: 0, office: 0, industry: 0 };
  zone: Zone | null = 'home';
  zonePlan: ZonePlan | null = null;
  // Bank loan balance (soft fail outside Challenge)
  loan = 0;
  // Traffic events (Events.ts): the running ones, the earliest time the next may start, when each kind last started
  events: ActiveEvent[] = [];
  nextEventAt = 4 * HOUR;
  eventLast: Partial<Record<EventKind, number>> = {};
  // Campaign / Challenge: counters, spend and the best grade (Campaign.ts); the grade the HUD has not shown yet; onGrade: a new best
  // (main.ts writes it to the profile)
  run: RunState = run0();
  pendingGrade: Grade | null = null;
  onGrade: ((g: Grade) => void) | null = null;
  // placing = the zone (a moved legacy building's) or special the place tool holds; placeAngle turns a free ghost (R)
  placing: Zone | Special | null = null;
  placeAngle = Math.PI / 2;
  // Building the place tool is moving (placing = its kind, no tray needed); the occupied building a Demolish click armed (a second click
  // removes it)
  moving: Building | null = null;
  armed: Building | null = null;
  // Type for new roads
  roadType: RoadType = { ...DEFAULT_TYPE };
  // Grid tool block size in tiles
  gridSize: 3 | 4 | 6 = 4;
  // Roundabout tool: size of the next ring (RINGS)
  ringSize: RingSize = 0;
  // Road tool: true = new roads curve to meet the roads they join (tangentAt), false = always straight; a drag bends either
  roadCurve = true;
  // Interchange tool: the junction picked and the template shown on it
  ichg: { node: Node; kind: Ichg } | null = null;
  // Highway exits linked at the last spend (the toast when one more links)
  private exitsLinked = 0;
  // Bumped on every build, demolish and driveway: interchange previews are cached against it
  version = 0;
  private ichgCache = new Map<string, PathPlan>();
  // Run selected with the Edit tool (edges in run order), or the junction it inspects (never both)
  selected: Edge[] | null = null;
  inspect: Node | null = null;
  // Edges created by the last commitPath, in build order (reused edges not included)
  lastBuilt: Edge[] = [];
  sfx = new Set<Sfx>();
  fx: Fx[] = [];
  // Bumped on every spend (a build, paint, demolish or refund): main.ts records an undo step when it moves
  edits = 0;
  // Edges jammed (heat over JAM_HI) until they cool under JAM_LO, checked once a game second; the last coin pop's time
  private jammed = new Set<Edge>();
  private jamAt = 0;
  private coinAt = -1;
  gameOver: GameOver = '';
  // City happiness 0..100 (EMA of the residents-weighted home mean) and its weighted parts
  happiness = 60;
  cityParts: Parts = { job: 0, shop: 0, trips: 0.6, pollution: 0, noise: 0 };
  // Midnights in a row in debt / unhappy (Challenge fail counters)
  debtDays = 0;
  sadDays = 0;
  message = '';
  // Bumped on every say(), so a repeated message still counts (the error buzz)
  said = 0;
  // Set while the tutorial runs: no fail checks
  tutorialActive = false;
  // No departures, shopping, freight or return trips (simcheck drives its own trips)
  demandOff = false;
  // World points the renderer highlights while the tutorial runs
  tutorialTargets: Vec[] = [];
  // Notification feed (newest last, the last 40) and how many were ever added (the HUD's unread badge); not saved
  news: News[] = [];
  newsN = 0;
  lastHour: number = T.START_HOUR;
  // Game time of the next commuter assignment (an hour after a building or road change, and daily at 03:00)
  assignAt = 0;
  private msgTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(public cfg: GameConfig = DEFAULT_CONFIG) {
    // the trip/driver stream is seeded apart from the terrain's, so the two never mirror each other
    setSeed(hashSeed('sim:' + cfg.seed));
    this.terrain = generateTerrain(cfg);
    const m = this.goals ? this.map! : null;
    this.money = this.creative ? Infinity : m ? m.money * (this.challenge ? CHALLENGE_MONEY : 1) : DIFFICULTY[cfg.difficulty].money;
    const town = findStarterTown(this.terrain);
    for (const b of town?.buildings ?? []) this.addBuilding(b);
    adoptLots(this);
    if (town && DIFFICULTY[cfg.difficulty].starterRoad) {
      const [a, b] = town.road, g = this.graph;
      // ponytail: free, but built 'yesterday' so it refunds REFUND_LATER like any old road (~$165 on easy's $60k)
      g.addEdge(g.addNode(a.x, a.y), g.addNode(b.x, b.y), { bridge: false, tunnel: false, level: 0, type: DEFAULT_TYPE }, -1);
      this.connect();
      this.upkeepDay = this.upkeepPerDay();
    }
    this.addExits();
    this.demand = demandOf(this);
  }

  // The map's outside connections (terrain.exits): a gate at the map edge with a free highway stub into the map
  addExits(): void {
    for (const x of this.terrain.exits) {
      const b = this.addBuilding(buildingAt('gate', x.door, x.angle));
      this.graph.addEdge(b.node, this.graph.addNode(x.end.x, x.end.y), { bridge: false, tunnel: false, level: 0, type: EXIT_TYPE, exit: true }, -1);
    }
  }

  // Adds the building with its door node; a home moves in START_OCC full (S6: growth)
  addBuilding(b: Building): Building {
    const d = b.door();
    this.graph.addNode(d.x, d.y, b);
    b.residents ||= Math.round(b.cap * T.START_OCC);
    this.buildings.push(b);
    this.changed();
    return b;
  }

  queueTrip(from: Building, to: Building, purpose: Purpose, back = false, who: Commuter | null = null): Trip {
    const t = makeTrip(purpose, from, to, back, who, this.time);
    from.pending.push(t);
    return t;
  }

  // Clock: in-game hours since Day 1 00:00 (the game starts at START_HOUR)
  get clock(): number { return this.time / HOUR + T.START_HOUR; }
  get hour(): number { return this.clock % 24; }
  // Days since the start: the refund rule's "today"
  get today(): number { return Math.floor(this.clock / 24); }
  get day(): number { return this.today + 1; }
  get running(): boolean { return !this.gameOver && this.speed > 0; }
  get creative(): boolean { return this.cfg.mode === 'creative'; }
  get challenge(): boolean { return this.cfg.mode === 'challenge'; }
  // The campaign map this run is on (any mode), its number, and whether its objectives count (Campaign, Challenge)
  get map(): MapDef | null { return mapById(this.cfg.map); }
  get mapNo(): number { return MAPS.findIndex(m => m.id === this.cfg.map) + 1; }
  get goals(): boolean { return (this.cfg.mode === 'campaign' || this.challenge) && !!this.map; }
  // Tools by map number: Campaign and Challenge have their map's and every earlier one's, Endless the profile's (cfg.unlock), Creative all
  get unlockLevel(): number { return this.creative ? Infinity : this.goals ? this.mapNo : this.cfg.unlock ?? Infinity; }
  // Challenge: the objectives by this day
  get deadline(): number { return DEADLINE + this.mapNo; }
  // A modal is up: game over, a map grade or a milestone choice
  get modal(): boolean { return !!this.gameOver || !!this.pendingGrade || !!this.offers; }
  get loanCap(): number { return T.LOAN_CAP * DIFFICULTY[this.cfg.difficulty].money / 40000 + (this.has('bank') ? 25000 : 0); }
  get loanRate(): number { return T.LOAN_RATE * (this.has('bank') ? 0.5 : 1); }
  has(u: Upgrade): boolean { return this.upgrades.includes(u); }
  feat(k: string, v: number): void { this.feats[k] = v; this.fv++; }
  // At the loan cap and still in debt: nothing grows and zoning is refused until money is back over $0
  get frozen(): boolean { return !this.creative && !this.challenge && this.money < 0 && this.loan >= this.loanCap; }
  get population(): number { return this.buildings.reduce((n, b) => n + b.residents, 0); }

  // City levels count up (not on maps with objectives); the next milestone reached offers its cards (one modal at a time)
  private checkLevel(): void {
    while (!this.goals && this.population >= levelPop(this.cityLevel + 1)) this.cityLevel++;
    if (!this.offers && !this.tutorialActive && this.population >= milestonePop(this, this.milestone + 1)) this.offers = offersFor(this, ++this.milestone);
  }

  // Buildings or roads changed: commuters are re-assigned an in-game hour later (so a road being drawn is not chased)
  changed(): void {
    this.assignAt = Math.min(this.assignAt, this.time + HOUR);
  }

  update(dt: number): void {
    if (!this.running) return;
    this.time += dt;

    // every hour passed (a time jump runs each one): demand and happiness, then that hour's taxes and upkeep, then midnight
    for (const hr = Math.floor(this.clock); this.lastHour < hr;) {
      const h = ++this.lastHour % 24;
      this.metrics.add({
        day: Math.floor(this.lastHour / 24) + 1, hour: h, money: this.money, pop: this.population, happy: this.happiness,
        waiting: this.cars.reduce((n, c) => n + +(c.speed < 1), 0) + this.buildings.reduce((n, b) => n + b.pending.length, 0),
      });
      this.hourly(h);
      eventsHour(this, h);
      this.runHour(h);
      this.payHour();
      this.bank();
      if (!h) this.midnight();
    }
    this.checkLevel();
    eventsTick(this);
    if (this.time >= this.assignAt) this.assign();
    if (!this.demandOff) this.departures();

    for (const b of this.buildings) this.trySpawnCar(b, dt);

    this.graph.update(dt);
    this.juice();

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const r = car.update(dt, this.graph);
      if (r === 'ok') continue;
      if (r === 'stuck' || r === 'lost') { this.dropCars([car], true); continue; }
      if (r === 'arrived') {
        this.score++;
        this.stats.arrived++;
        const t = car.trip, secs = this.time - t.departed;
        if (!t.back) this.business(t);
        if (t.purpose === 'emergency' && !t.back && secs <= T.FAST_X * t.ideal) { this.cheer(t.to); this.feat('amb', (this.feats.amb ?? 0) + 1); }
        if (!t.back) this.count(t, secs);
        if (t.vip) vipArrived(this, secs, t.ideal);
        const o = this.outcome(t, secs);
        this.report(t, o, secs);
        if (car === this.follow) this.say(`Arrived: ${OUTCOME_LABEL[o]}, ${fmtMin(secs)}`);
        if (t.back) { if (t.who) t.who.at = 'home'; }
        else if (!this.demandOff && t.to.kind !== 'gate') this.park(t);
      }
      this.graph.detachCar(car);
      this.cars.splice(i, 1);
    }
    // the followed car arrived, or its trip went back to the door
    if (this.follow && !this.cars.includes(this.follow)) this.follow = null;
  }

  // Business income on arrival: a worker at a workplace, a customer at a shop (half when it has no goods), a truck of goods;
  // trade: an export reaching a highway exit, an import or a visitor from one (a commuter from outside pays as a worker)
  // A terminal's export pays 1.5x, a fan FAN_PAY before kickoff, an ambulance nothing
  private business(t: Trip): void {
    if (t.purpose === 'emergency' || t.from.kind === 'gate' && t.to.kind === 'gate') return;
    const out = t.to.kind === 'gate', trade = out || (t.from.kind === 'gate' && t.purpose !== 'commute');
    const x = t.to.special === 'stadium' && t.purpose === 'visit' ? (this.hour < T.KICKOFF ? T.FAN_PAY : 0)
      : out ? T.TAX_EXPORT * (t.from.special === 'terminal' ? 1.5 : 1) : trade ? (t.purpose === 'freight' ? T.TAX_IMPORT : T.TAX_VISIT)
      : t.purpose === 'commute' ? T.TAX_COMMUTE : t.purpose === 'freight' ? T.TAX_FREIGHT : T.TAX_SHOP * (t.to.stock > 0 ? 1 : 0.5);
    const pay = x * DIFFICULTY[this.cfg.difficulty].tax;
    this.money += pay;
    if (trade) { this.ledger.today.trade += pay; this.metrics.trade(); }
    else this.ledger.today.business += pay;
    // ponytail: one pop per quarter game second, the rest of the income is silent
    if (pay > 0 && this.time - this.coinAt > 0.25) { this.coinAt = this.time; this.pop({ kind: 'coin', x: t.to.x, y: t.to.y, at: this.time, n: pay }); }
  }

  private pop(f: Fx): void {
    this.fx.push(f);
    if (this.fx.length > FX_MAX) this.fx.shift();
  }

  // Ages out the map juice; once a game second, a jammed road that cooled sparkles and chimes
  private juice(): void {
    while (this.fx.length && this.time - this.fx[0].at > FX_LIFE) this.fx.shift();
    if (this.time < this.jamAt) return;
    this.jamAt = this.time + 1;
    for (const e of this.jammed) if (!this.graph.edges.includes(e)) this.jammed.delete(e);
    for (const e of this.graph.edges) {
      if (e.drive || e.ring) continue;
      if (e.heat > JAM_HI) this.jammed.add(e);
      else if (e.heat < JAM_LO && this.jammed.delete(e)) {
        this.pop({ kind: 'clear', x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2, at: this.time, n: 0 });
        this.sfx.add('clear');
      }
    }
  }

  // Residential taxes per day at the current population and happiness
  taxPerDay(): number {
    return T.TAX_RES * this.population * (0.5 + 0.5 * this.happiness / 100) * DIFFICULTY[this.cfg.difficulty].tax;
  }

  // One hour of taxes and upkeep
  private payHour(): void {
    const tax = this.taxPerDay() / 24, up = this.upkeepDay / 24;
    this.money += tax - up;
    this.ledger.today.taxes += tax;
    this.ledger.today.upkeep += up;
  }

  // Interest on the loan; below $0 the bank lends LOAN_STEP up to loanCap (never in creative or Challenge)
  private bank(): void {
    if (this.creative || this.challenge) return;
    const i = this.loan * this.loanRate / 24;
    this.money -= i;
    this.ledger.today.interest += i;
    if (this.money >= 0 || this.loan >= this.loanCap) return;
    const x = Math.min(T.LOAN_STEP, this.loanCap - this.loan);
    this.loan += x;
    this.money += x;
    this.feat('loaned', 1);
    this.note(`Bank loan: +${fmtMoney(x)} at ${this.loanRate * 100}%/day`);
  }

  // Pays back LOAN_STEP (or what is left) of the loan; false (with the reason said) when it cannot
  repay(): boolean {
    const x = Math.min(T.LOAN_STEP, this.loan);
    const why = !x ? 'No loan to repay' : this.money < x ? `Repaying takes ${fmtMoney(x)}` : '';
    if (why) { this.say(why); return false; }
    this.loan -= x;
    this.money -= x;
    if (!this.loan) this.feat('debtfree', 1);
    this.note(this.loan ? `Repaid ${fmtMoney(x)}: ${fmtMoney(this.loan)} left` : 'Loan repaid');
    return true;
  }

  // Rolls the ledger and the day's outcomes, then the Challenge fail checks (never elsewhere or during the tutorial):
  // in debt at debtDays midnights in a row = bankrupt; from day FAIL_FROM_DAY, unhappy at FAIL_DAYS midnights in a row = the residents left
  private midnight(): void {
    const o = this.stats.today, ended = OUTCOMES.reduce((n, k) => n + o[k], 0);
    if (this.challenge && !this.tutorialActive && !this.gameOver) {
      if (ended >= GRIDLOCK_MIN && o.gaveup > GRIDLOCK * ended) this.gameOver = 'gridlock';
      else if (!this.run.done && this.goals && this.lastHour / 24 + 1 > this.deadline) this.gameOver = 'deadline';
    }
    this.upkeepDay = this.upkeepPerDay();
    this.ledger = { today: ledger0(), yesterday: this.ledger.today };
    this.stats.today = outcomes0();
    if (!this.challenge || this.tutorialActive) { this.debtDays = this.sadDays = 0; return; }
    const d = DIFFICULTY[this.cfg.difficulty], day = this.lastHour / 24 + 1;
    this.debtDays = this.money < 0 ? this.debtDays + 1 : 0;
    this.sadDays = day >= T.FAIL_FROM_DAY && this.happiness < d.failHappy ? this.sadDays + 1 : 0;
    if (this.gameOver) return;
    if (this.debtDays >= d.debtDays) this.gameOver = 'bankrupt';
    else if (this.sadDays >= T.FAIL_DAYS) this.gameOver = 'unhappy';
  }

  // A trip arrived (outbound leg): the campaign counters, the match's fans on time, the last ambulances
  private count(t: Trip, secs: number): void {
    const r = this.run, c = r.cur;
    c.arrived++;
    if (t.to.kind === 'gate' && t.purpose === 'freight') c.exports++;
    if (t.from.kind === 'gate' && t.to.kind !== 'gate' && t.purpose === 'visit') c.visitors++;
    if (t.to.special === 'stadium' && t.purpose === 'visit' && this.hour < T.KICKOFF) r.fans[1]++;
    if (t.purpose === 'emergency') r.amb = [...r.amb, +(secs <= T.FAST_X * t.ideal)].slice(-10);
  }

  // Hour h began: the last one's counters roll, a match's share is kept at its end, and the objectives are checked. The first time they
  // all hold the map is graded (the HUD's Map complete); every midnight after that grades again and keeps the best
  private runHour(h: number): void {
    const r = this.run;
    closeHour(r, (h + 23) % 24);
    if (h === T.MATCH_END && r.fans[0]) {
      const share = r.fans[1] / r.fans[0], x = MATCH_BONUS * DIFFICULTY[this.cfg.difficulty].tax;
      if (share >= MATCH_Q) { this.money += x; this.ledger.today.grants += x; this.note(`Match day: ${Math.round(share * 100)}% of fans on time, +${fmtMoney(x)}`); }
      r.match = Math.max(r.match, share);
      r.fans = [0, 0];
    }
    if (!this.goals || this.gameOver || this.tutorialActive) return;
    const m = this.map!, g = grade(this, m);
    if (r.done ? !h && g.stars > r.stars : g.stars > 0) {
      if (!r.done) this.pendingGrade = g;
      else this.note(`New best on ${m.name}: ${'★'.repeat(g.stars)}`);
      r.done = true;
      r.stars = Math.max(r.stars, g.stars);
      r.efficiency = Math.max(r.efficiency, g.efficiency);
      this.onGrade?.(g);
    }
  }

  // The nearest Challenge fail: midnights left before it if nothing changes (1 = the next one), null when none looms
  get alarm(): { kind: Exclude<GameOver, ''>; days: number } | null {
    if (!this.challenge || this.tutorialActive || this.gameOver) return null;
    const d = DIFFICULTY[this.cfg.difficulty];
    const debt = this.money < 0 ? d.debtDays - this.debtDays : Infinity;
    // the first midnight that counts is the next one, or the one into day FAIL_FROM_DAY
    const sad = this.happiness < d.failHappy ? Math.max(1, T.FAIL_FROM_DAY - this.day) + T.FAIL_DAYS - 1 - this.sadDays : Infinity;
    if (debt === Infinity && sad === Infinity) return null;
    return debt <= sad ? { kind: 'bankrupt', days: debt } : { kind: 'unhappy', days: sad };
  }

  // On the hour: workplaces count their staff, homes accrue shopping trips along SHOP_CURVE, staffed factories accrue
  // trucks during TRUCK_HOURS; each whole trip goes to a gravity-picked reachable shop. With a highway exit in reach (linked):
  // some trucks export through it, factories import raw materials and short shops goods from it, visitors come to shops and
  // offices along SHOP_CURVE, and commuters from outside take OUTSIDE_JOBS of the slots no resident holds, arriving in the morning.
  private hourly(h: number): void {
    if (h === 3) this.assign();
    if (this.demandOff) return;
    const comp = this.components(), mult = DIFFICULTY[this.cfg.difficulty].trips, [t0, t1] = T.TRUCK_HOURS, trucking = h >= t0 && h < t1;
    const reach = new Set(this.buildings.filter(b => b.kind === 'gate').map(b => comp.get(b.node)));
    // the exit a trip from or to b uses, gravity-picked (no roll without one, so a town with no linked exit keeps its stream)
    const exit = (b: Building): Building | null => reach.has(comp.get(b.node)) ? this.pick(b, comp, x => +(x.kind === 'gate')) : null;
    // with a freight terminal in reach, a factory's exports and imports go through it instead (the terminal's own trucks run to the exit)
    const port = (b: Building): Building | null =>
      (this.buildings.some(x => x.special === 'terminal' && comp.get(x.node) === comp.get(b.node)) ? this.pick(b, comp, x => +(x.special === 'terminal')) : null) ?? exit(b);
    const span = T.COMMUTE_MAX - T.COMMUTE_MIN, morning = h >= T.COMMUTE_MIN && h < T.COMMUTE_MAX, held = new Map<Building, number>();
    if (morning) for (const c of this.commuters) if (c.work) held.set(c.work, (held.get(c.work) ?? 0) + 1);
    this.grow(comp);
    zoneHour(this, comp);
    this.specialsHour(h, comp, exit);
    // a map's through traffic: exit to exit (a linked one to another it reaches), spread over the day
    const gates = this.buildings.filter(b => b.kind === 'gate' && reach.has(comp.get(b.node)));
    for (this.run.thru += (this.map?.mods?.through ?? 0) / 24; this.run.thru >= 1 && gates.length > 1; this.run.thru--) {
      const a = gates[Math.floor(random() * gates.length)], b = this.pick(a, comp, x => +(x.kind === 'gate'));
      if (b) this.queueTrip(a, b, 'visit');
    }
    this.run.thru = Math.min(this.run.thru, 1);
    for (const b of this.buildings) {
      if (b.abandoned) continue;
      if (b.jobs) b.staffed = Math.min(1, b.parked.filter(t => t.purpose === 'commute').length * T.PEOPLE_PER_CAR / b.jobs);
      if (b.kind === 'home') {
        b.shopAcc += b.residents / T.PEOPLE_PER_CAR * T.SHOP_RATE * T.SHOP_CURVE[h] / SHOP_SUM * mult;
        for (; b.shopAcc >= 1; b.shopAcc--) {
          const to = this.pick(b, comp, s => s.kind === 'shop' ? s.jobs * s.def.draw : 0);
          if (to) this.queueTrip(b, to, 'shop');
        }
        continue;
      }
      const linked = b.kind !== 'gate' && reach.has(comp.get(b.node)), factory = b.kind === 'industry' && !b.special;
      if (b.def.trucks && trucking) this.trucks(b, comp, mult, linked ? (factory ? port : exit) : null);
      if (!linked) continue;
      if (factory && trucking) b.importAcc += T.IMPORTS_PER_DAY * b.staffed * mult / (t1 - t0);
      if (b.kind === 'shop' && trucking && b.stock <= T.IMPORT_STOCK) b.importAcc += T.IMPORT_SHOP;
      for (; b.importAcc >= 1; b.importAcc--) { const from = port(b); if (from) this.queueTrip(from, b, 'freight'); }
      if (b.def.visits) b.visitAcc += b.def.visits * (this.map?.mods?.visitX ?? 1) * T.SHOP_CURVE[h] / SHOP_SUM * mult;
      for (; b.visitAcc >= 1; b.visitAcc--) { const from = exit(b); if (from) this.queueTrip(from, b, 'visit'); }
      // the i-th commuter from outside arrives in hour COMMUTE_MIN + i mod span
      const n = morning ? Math.floor((Math.floor(b.jobs / T.PEOPLE_PER_CAR) - (held.get(b) ?? 0)) * T.OUTSIDE_JOBS) : 0;
      for (let i = h - T.COMMUTE_MIN; i >= 0 && i < n; i += span) {
        const from = exit(b);
        if (from) this.queueTrip(from, b, 'commute').leave = this.time + T.WORK_HOURS * HOUR;
      }
    }
  }

  // A factory's (or a terminal's) trucks this hour (its tier's trucks a day x staffed): goods to a reachable shop, the emptier the
  // likelier; with an exit (a factory: or a terminal) linked, its tier's export share of them (all, with no shop to reach) go there
  private trucks(b: Building, comp: Map<Node, number>, mult: number, exit: ((b: Building) => Building | null) | null): void {
    const [t0, t1] = T.TRUCK_HOURS;
    b.truckAcc += b.def.trucks * b.staffed * mult / (t1 - t0);
    for (; b.truckAcc >= 1; b.truckAcc--) {
      const shop = this.pick(b, comp, s => s.kind === 'shop' && !s.abandoned ? 1 + Math.max(0, T.STOCK_START - s.stock) : 0), out = exit?.(b);
      const to = out && (!shop || random() < b.def.export) ? out : shop;
      if (to) this.queueTrip(b, to, 'freight');
    }
  }

  // Specials on the hour. Hospital: emergency calls (one per EMERGENCY_POP residents a day, shared among the hospitals), each an
  // ambulance out to a home picked by residents. Stadium: on match days (every MATCH_DAYS) the feed warns at noon, then the fans set off
  // the two hours before KICKOFF (FANS_OUT of them from linked exits, the rest from homes) and stay until MATCH_END plus up to an hour.
  // ponytail: G5's match-day event adds the countdown ring and the on-time bonus
  private specialsHour(h: number, comp: Map<Node, number>, exit: (b: Building) => Building | null): void {
    const hosp = this.buildings.filter(b => b.special === 'hospital' && b.connected);
    for (const b of hosp) {
      b.visitAcc += this.population / T.EMERGENCY_POP / 24 / hosp.length;
      for (; b.visitAcc >= 1; b.visitAcc--) { const to = this.pick(b, comp, x => x.kind === 'home' ? x.residents : 0); if (to) this.queueTrip(b, to, 'emergency'); }
    }
    const st = this.buildings.find(b => b.special === 'stadium' && b.connected);
    if (!st || this.day % T.MATCH_DAYS) return;
    const fans = Math.round(Math.min(T.FANS_MAX, T.FANS + this.population / T.FANS_POP));
    if (h === 12) this.note(`Match day: ${fans} fans head to the Stadium from ${T.KICKOFF - 2}:00, kickoff ${T.KICKOFF}:00`);
    if (h !== T.KICKOFF - 2 && h !== T.KICKOFF - 1) return;
    for (let i = 0; i < fans / 2; i++) {
      const from = (i % 5 < 5 * T.FANS_OUT ? exit(st) : null) ?? this.pick(st, comp, x => x.kind === 'home' ? x.residents : 0);
      if (!from) continue;
      this.queueTrip(from, st, 'visit').leave = this.time + (T.MATCH_END - h + (i % 4) / 4) * HOUR;
      this.run.fans[0]++;
    }
  }

  // Homes: happiness (rateHome), then residents move in or out by its band, each hour 1/24 of the daily share of capacity (moving in
  // faster with better traffic access: x 0.5 + access); under GROW_LO households leave until the home stands empty. A home over capacity
  // (simcheck) only shrinks. Then the city's happiness.
  private grow(comp: Map<Node, number>): void {
    const gm = DIFFICULTY[this.cfg.difficulty].growth, keys = Object.keys(this.cityParts) as (keyof Parts)[];
    const sum: Parts = { job: 0, shop: 0, trips: 0, pollution: 0, noise: 0 };
    let w = 0, happy = 0;
    for (const b of this.buildings) {
      if (b.kind !== 'home') continue;
      b.happy = this.rateHome(b, comp);
      const rate = b.happy >= T.GROW_HI ? T.GROW_FAST * gm : b.happy >= T.GROW_LO ? (b.connected ? T.GROW_SLOW * gm : 0) : -T.SHRINK, cap = b.cap;
      const d = (rate > 0 ? rate * (0.5 + b.access) : rate) * cap / 24;
      b.residents = d > 0 ? Math.max(b.residents, Math.min(cap, b.residents + d)) : Math.max(0, b.residents + d);
      w += b.residents;
      happy += b.residents * b.happy;
      for (const k of keys) sum[k] += b.residents * b.parts[k];
    }
    if (!w) return;
    this.happiness += (happy / w - this.happiness) / T.HAPPY_TAU;
    for (const k of keys) sum[k] /= w;
    this.cityParts = sum;
  }

  // A home's happiness 0..100 from its parts (kept in b.parts), each 0..1:
  // job: share of its commuters with a workplace (0 with none); shop: share of its last 24h shopping trips that arrived (none made:
  // 1 when a shop is reachable); trips: mean SCORE of its last 24h trips (0.6 with none, 0 with no job and no shop to go to);
  // without a road job = shop = trips = 0, so the home empties;
  // pollution: staffed factories, each fading out at its tier's reach; noise: the loudest road within NOISE_R by tier, louder with traffic,
  // or a noisy workplace (a logistics park), x the home's tier noiseX; a fast ambulance's cheer adds CHEER points for a day.
  // ponytail: scans every commuter, factory and road per home each hour; a spatial grid if big cities stutter on the hour
  rateHome(b: Building, comp = this.components()): number {
    const cut = this.time - T.DAY_SECONDS;
    while (b.recent.length && b.recent[0].at <= cut) b.recent.shift();
    const p = b.parts, mine = this.commuters.filter(c => c.home === b), shops = b.recent.filter(r => r.shop);
    p.job = b.connected && mine.length ? mine.filter(c => c.work).length / mine.length : 0;
    p.shop = !b.connected ? 0 : shops.length ? shops.filter(r => r.score > 0).length / shops.length
      : +this.buildings.some(s => s.kind === 'shop' && !s.abandoned && comp.get(s.node) === comp.get(b.node));
    p.trips = b.recent.length && b.connected ? b.recent.reduce((n, r) => n + r.score, 0) / b.recent.length : p.job || p.shop ? 0.6 : 0;
    p.pollution = Math.min(1, this.buildings.reduce((n, o) => n + (o.def.pollution ? o.staffed * Math.max(0, 1 - dist(o, b) / o.def.pollution) : 0), 0));
    p.noise = 0;
    for (const o of this.buildings) if (o.def.noise) p.noise = Math.max(p.noise, o.def.noise * o.staffed * Math.max(0, 1 - dist(o, b) / T.NOISE_R));
    for (const e of this.graph.edges) {
      if (e.drive || e.tunnel) continue;
      const d = distToSegment(b, e.a, e.b).d;
      if (d >= T.NOISE_R) continue;
      const density = e.lanes.reduce((n, l) => n + l.cars.length, 0) * (CAR_LEN + GAP) / (e.length * e.lanes.length);
      p.noise = Math.max(p.noise, TIERS[e.type.tier].noise * (this.has('walls') ? 0.5 : 1) * (1 - d / T.NOISE_R) * (0.5 + 0.5 * Math.min(1, 3 * density)));
    }
    p.noise = Math.min(1, p.noise * b.def.noiseX);
    const q = T.W_JOB * p.job + T.W_SHOP * p.shop + T.W_TRIPS * p.trips - T.W_POLL * p.pollution - T.W_NOISE * p.noise + (b.cheer > this.time ? T.CHEER / 100 : 0);
    return 100 * Math.max(0, Math.min(1, q));
  }

  // Undirected road components by node; a door without a road is a component of its own.
  // ponytail: undirected, so a one-way trap still counts as reachable; findPath at departure is the final judge (noroute)
  components(): Map<Node, number> {
    const comp = new Map<Node, number>();
    let id = 0;
    for (const n of this.graph.nodes) {
      if (comp.has(n)) continue;
      comp.set(n, ++id);
      for (const stack = [n]; stack.length;) {
        const m = stack.pop()!;
        for (const e of m.edges) {
          const o = e.a === m ? e.b : e.a;
          if (!comp.has(o)) { comp.set(o, id); stack.push(o); }
        }
      }
    }
    return comp;
  }

  // Highway exits a building of the town reaches by road: trade and visitors only flow through these
  // ponytail: the renderer and HUD call it per frame (a graph walk); cache it against version if big networks stutter
  linkedExits(comp = this.components()): Building[] {
    const town = new Set(this.buildings.filter(b => b.kind !== 'gate').map(b => comp.get(b.node)));
    return this.buildings.filter(b => b.kind === 'gate' && town.has(comp.get(b.node)));
  }

  // Gravity model: a building in from's component, picked with weight cap(b) x exp(-distance / GRAVITY_D)
  // ponytail: straight-line distance; network distance if far-but-straight picks show up in the reports
  private pick(from: Building, comp: Map<Node, number>, cap: (b: Building) => number): Building | null {
    const c = comp.get(from.node);
    let sum = 0;
    const ws = this.buildings.map(b => {
      const w = b !== from && comp.get(b.node) === c ? cap(b) * Math.exp(-dist(from, b) / T.GRAVITY_D) : 0;
      sum += w;
      return w;
    });
    if (!sum) return null;
    let r = random() * sum;
    return this.buildings.find((_, i) => ws[i] > 0 && (r -= ws[i]) < 0) ?? null;
  }

  // Each home keeps floor(residents x EMPLOY_RATE / PEOPLE_PER_CAR) commuters, each leaving at an hour ~ N(COMMUTE_MEAN, COMMUTE_SD).
  // A commuter cut off from its workplace loses it; one without a job gets a reachable workplace with a free slot (jobs / PEOPLE_PER_CAR).
  assign(): void {
    this.assignAt = Infinity;
    const comp = this.components(), count = new Map<Building, number>(), extra = new Map<Building, number>();
    for (const c of this.commuters) count.set(c.home, (count.get(c.home) ?? 0) + 1);
    for (const h of this.buildings) {
      if (h.kind !== 'home') continue;
      const n = Math.floor(h.residents * T.EMPLOY_RATE / T.PEOPLE_PER_CAR) - (count.get(h) ?? 0);
      if (n < 0) extra.set(h, -n);
      for (let i = 0; i < n; i++) {
        const z = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
        const depart = Math.max(T.COMMUTE_MIN, Math.min(T.COMMUTE_MAX, T.COMMUTE_MEAN + (this.map?.mods?.commuteSd ?? T.COMMUTE_SD) * z));
        this.commuters.push({ home: h, work: null, depart, next: this.time + ((depart - this.hour + 24) % 24) * HOUR, at: 'home' });
      }
    }
    // fewer residents (S6/S7): commuters at home move out first; one on the road finishes its day
    this.commuters = this.commuters.filter(c => {
      const x = extra.get(c.home) ?? 0;
      if (!x || c.at !== 'home') return true;
      extra.set(c.home, x - 1);
      return false;
    });
    const free = new Map<Building, number>();
    for (const b of this.buildings) if (b.jobs) free.set(b, Math.floor(b.jobs / T.PEOPLE_PER_CAR));
    for (const c of this.commuters) {
      if (c.work && comp.get(c.work.node) !== comp.get(c.home.node)) c.work = null;
      if (c.work) free.set(c.work, free.get(c.work)! - 1);
    }
    for (const c of this.commuters) {
      if (c.work) continue;
      c.work = this.pick(c.home, comp, b => Math.max(0, free.get(b) ?? 0));
      if (c.work) free.set(c.work, free.get(c.work)! - 1);
    }
  }

  // Commuters at home leave at their hour (a day they are still out is skipped); parked trips start their return leg when due
  private departures(): void {
    for (const c of this.commuters) {
      if (this.time < c.next) continue;
      const dep = c.next;
      while (c.next <= this.time) c.next += T.DAY_SECONDS;
      if (c.at !== 'home' || !c.work) continue;
      c.at = 'driving';
      this.queueTrip(c.home, c.work, 'commute', false, c).leave = dep + T.WORK_HOURS * HOUR;
    }
    for (const b of this.buildings) {
      for (let i = 0; i < b.parked.length; i++) {
        const t = b.parked[i];
        if (this.time < t.leave) continue;
        b.parked.splice(i--, 1);
        if (t.who) t.who.at = 'driving';
        this.queueTrip(b, t.from, t.purpose, true, t.who);
      }
    }
  }

  // Arrived: a shopper (or a visitor) buys one item and stays SHOP_STAY hours, a truck unloads and turns back at once,
  // a commuter stays for its shift (leave was set when it left home, or the exit), a fan for the match, an ambulance CALL_STAY
  private park(t: Trip): void {
    const b = t.to;
    if ((t.purpose === 'shop' || t.purpose === 'visit') && b.special !== 'stadium') { if (b.kind === 'shop') b.stock = Math.max(0, b.stock - 1); t.leave = this.time + T.SHOP_STAY * HOUR; }
    if (t.purpose === 'emergency') t.leave = this.time + T.CALL_STAY * HOUR;
    if (t.purpose === 'freight' && b.kind === 'shop') b.stock += T.STOCK_PER_TRUCK;
    if (t.who) t.who.at = 'away';
    b.parked.push(t);
  }

  // Waited at the door over an hour or stopped for WAIT_SHARE of the drive = wait; drove DETOUR_X the free-flow length = detour;
  // otherwise smooth within SMOOTH_X of the free-flow time, else wait
  private outcome(t: Trip, secs: number): Outcome {
    if (t.stopped > T.WAIT_SHARE * secs || t.departed - t.queued > HOUR) return 'wait';
    if (t.driven > T.DETOUR_X * t.idealLen) return 'detour';
    return secs <= T.SMOOTH_X * t.ideal ? 'smooth' : 'wait';
  }

  private report(t: Trip, outcome: Outcome, seconds: number): void {
    this.stats.today[outcome]++;
    this.run.cur.trips++;
    if (outcome === 'smooth') this.run.cur.smooth++;
    if (outcome === 'smooth') this.stats.smooth++;
    const shop = t.purpose === 'shop' && !t.back;
    for (const b of new Set([t.from, t.to])) if (b.kind !== 'gate') b.recent.push({ at: this.time, score: SCORE[outcome], shop });
    if (outcome === 'gaveup' || outcome === 'noroute') this.metrics.fail();
    else this.metrics.arrive(seconds / HOUR * 60);
    this.feats.streak = FAILED.includes(outcome) ? 0 : (this.feats.streak ?? 0) + 1;
    if (this.stats.arrived === 1) this.fv++;
    const j = t.jam;
    this.reports.push({
      purpose: t.purpose, back: t.back, from: t.from, to: t.to, outcome, seconds, day: this.day, hour: this.hour,
      ratio: t.ideal ? seconds / t.ideal : 1, stretch: t.idealLen ? t.driven / t.idealLen : 1, door: t.departed ? t.departed - t.queued : 0,
      jam: j && { x: j.x, y: j.y }, jamAt: jamAt(j), jamS: t.jamS, stopped: t.stopped,
    });
    if (this.reports.length > 200) this.reports.shift();
  }

  // A trip that never arrives; its commuter is home again
  private fail(t: Trip, outcome: Outcome): void {
    if (t.who) t.who.at = 'home';
    this.stats.failed++;
    this.report(t, outcome, t.departed ? this.time - t.departed : 0);
  }

  // Trips waiting SPAWN_FAIL hours give up. Then, below MAX_CARS, the first pending trip whose first lane has room goes out;
  // a trip with no route is reported and dropped. The free-flow route (empty roads) at departure is the trip's ideal.
  private trySpawnCar(b: Building, dt: number): void {
    b.retryTimer -= dt;
    if (b.retryTimer > 0 || !b.pending.length) return;
    b.retryTimer = 0.4;
    for (let i = 0; i < b.pending.length; i++) {
      if (this.time - b.pending[i].queued > T.SPAWN_FAIL * HOUR) this.fail(b.pending.splice(i--, 1)[0], 'gaveup');
    }
    if (!b.connected || this.cars.length >= T.MAX_CARS) return;
    const rk = randomKind();
    // a door on one road (its driveway) with no lane out that has room spawns nothing: skip the pathfinding
    const one = b.node.edges.length === 1 ? b.node.edges[0] : null, min = Math.min(KINDS[rk].len, KINDS.truck.len);
    if (one && !this.graph.lanesFrom(one, b.node).some(l => { const f = l.cars[0]; return !f || f.s >= (f.len + min) / 2 + GAP * 2; })) return;
    for (let i = 0; i < b.pending.length; i++) {
      const trip = b.pending[i], kind = trip.purpose === 'freight' ? 'truck' : trip.purpose === 'emergency' ? 'ambulance' : rk, len = KINDS[kind].len;
      const path = findPath(this.graph, b.node, trip.to.node);
      if (!path || path.length < 2) { this.fail(b.pending.splice(i--, 1)[0], 'noroute'); continue; }
      const e = this.graph.edgeBetween(b.node, path[1]);
      if (!e) continue;
      const lane = this.graph.pickLane(e, b.node, this.graph.turn(path, 1), path[2]);
      const f = lane?.cars[0];
      if (!lane || (f && f.s < (f.len + len) / 2 + GAP * 2)) continue;
      b.pending.splice(i, 1);
      const ideal = findPath(this.graph, b.node, trip.to.node, null, true) ?? path;
      trip.idealLen = trip.driven = trip.stopped = trip.jamS = 0;
      trip.jam = null;
      // free flow: the drive at the limits, plus pulling out of the door and each junction's turn or grant
      trip.ideal = T.START_S;
      for (let j = 1; j < ideal.length; j++) {
        const x = this.graph.edgeBetween(ideal[j - 1], ideal[j])!;
        trip.idealLen += x.length;
        trip.ideal += x.length / TIERS[x.type.tier].limit / KINDS[kind].v + (j < ideal.length - 1 && this.graph.needsControl(ideal[j]) ? T.JUNCTION_S : 0);
      }
      trip.departed = this.time;
      const car = new Car(lane, trip, kind);
      car.path = path.slice(1);
      lane.cars.unshift(car);
      this.cars.push(car);
      return;
    }
  }

  // Unlocks by campaign map number (unlockLevel)
  unlocked(level: number): boolean {
    return this.unlockLevel >= level;
  }

  // 'Unlocks on map 3, Cedar Crossing: Roundabouts'
  lockText(level: number, label: string): string {
    return `Unlocks on ${unlockAt(level)}: ${label}`;
  }

  tierUnlocked(t: Tier): boolean {
    return this.unlocked(TIERS[t].level);
  }

  // '' when unlocked, else the toast (lockText)
  lockOf(f: Feature): string {
    const u = UNLOCKS[f];
    // ponytail: the tutorial edits a light phase on map 1; the junction editor is the only lock it lifts
    return this.unlocked(u.level) || (f === 'junction' && this.tutorialActive) ? '' : this.lockText(u.level, u.label);
  }

  private lockedMsg(t: RoadType): string {
    if (!this.tierUnlocked(t.tier)) return this.lockText(TIERS[t.tier].level, TIERS[t.tier].label);
    return t.oneWay ? this.lockOf('oneway') : '';
  }

  // Lanes and one-way are clamped to the tier (fitType)
  setRoadType(t: RoadType): void {
    const locked = this.lockedMsg(fitType(t));
    if (locked) { this.say(locked); return; }
    this.roadType = fitType(t);
  }

  setLevel(n: number): void {
    const l = Math.max(0, Math.min(MAX_LEVEL, Math.round(n)));
    const locked = l >= MOUNTAIN_LEVEL ? this.lockOf('high') : l > 0 ? this.lockOf('viaduct') : '';
    if (locked) { this.say(locked); return; }
    this.level = l;
  }

  // Direction a road leaving p toward 'toward' should start with, to continue smoothly from the
  // road it snaps to; null for a free point or when no existing direction fits.
  tangentAt(p: Vec, toward: Vec): Vec | null {
    const dx = toward.x - p.x, dy = toward.y - p.y, d = Math.hypot(dx, dy);
    if (!d) return null;
    const s = this.snapEnd(p);
    const cands: Vec[] = [];
    const push = (x: number, y: number) => { const l = Math.hypot(x, y); if (l) cands.push({ x: x / l, y: y / l }); };
    // a road leaves a ring straight out from its centre
    const r = s.node ? this.graph.ringOf(s.node) : s.edge?.ring;
    if (r) push(s.point.x - r.hub.x, s.point.y - r.hub.y);
    else if (s.node) {
      const n = s.node;
      for (const e of n.edges) {
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
        if (dist(hit.point, end) <= NODE_R && this.graph.nodeLevelOk(end, level)) return { node: end, edge: null, point: { x: end.x, y: end.y } };
      }
      return { node: null, edge: hit.edge, point: hit.point };
    }
    return { node: null, edge: null, point: { x: p.x, y: p.y } };
  }

  // Snap for the end of a path: on 'level' first, else a node (not a ramp joint) or a road of another level, where a ramp starts or ends
  snapEnd(p: Vec, level = this.level): Snap {
    const s = this.snap(p, level), g = this.graph;
    if (s.node || s.edge) return s;
    const n = g.nearestNode(p, NODE_R + 4);
    if (n && !Number.isNaN(g.levelOf(n))) return { node: n, edge: null, point: { x: n.x, y: n.y } };
    const hit = g.nearestEdge(p, ROAD_W);
    return hit ? this.snap(hit.point, hit.edge.level) : s;
  }

  // Level of a snapped point: its node's or road's, else 'level' (a free point)
  levelAt(s: Snap, level = this.level): number {
    return s.node ? this.graph.levelOf(s.node, level) : s.edge ? s.edge.level : level;
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

  // Pays (negative: gets back) construction money and refreshes the daily upkeep; lots whose road went go too; toasts a newly linked exit.
  // net: counts toward the campaign's network spend (zoning does not)
  spend(cost: number, net = true): void {
    this.money -= cost;
    this.edits++;
    if (net) this.run.spent += cost;
    if (cost) this.sfx.add(cost > 0 ? 'build' : 'demolish');
    this.ledger.today.build += cost;
    this.upkeepDay = this.upkeepPerDay();
    this.changed();
    this.syncPlans();
    pruneLots(this);
    this.version++;
    const x = this.linkedExits(), n = x.length;
    if (n > this.exitsLinked) this.note('Highway exit linked: exports, imports and visitors can come and go', x[n - 1]);
    this.exitsLinked = n;
  }

  // An edited junction plan whose roads changed (an arm added, removed or turned past 15 degrees) goes back to the default
  private syncPlans(): void {
    for (const n of this.graph.nodes) if (n.plan && !planFits(n, n.plan)) { n.plan = null; this.say('Junction plan reset: its roads changed'); }
    if (this.inspect && !this.graph.nodes.includes(this.inspect) && !this.graph.rings.some(r => r.hub === this.inspect)) this.inspect = null;
    if (this.ichg && !this.graph.nodes.includes(this.ichg.node)) this.ichg = null;
  }

  // Build price of a road from a to b: per tile and lane at the tier's rate, x the viaduct factor, or x the bridge / tunnel factor on the
  // share of its length over water / through a mountain. Geometry only, so a split road keeps its total.
  // ponytail: money stays a float (no rounding), so splits and same-day refunds add up exactly; the HUD rounds
  price(a: Vec, b: Vec, f: EdgeFlags): number {
    const base = dist(a, b) / TILE * laneFactor(f.type) * TIERS[f.type.tier].cost * (this.has('crew') ? 0.8 : 1);
    if (f.level > 0) return base * (T.VIADUCT_X + T.VIADUCT_LEVEL_X * f.level);
    if (!f.bridge && !f.tunnel) return base;
    const s = segmentCrosses(this.terrain, a, b);
    return base * (1 + (f.bridge ? (T.BRIDGE_X - 1) * s.water : 0) + (f.tunnel ? (T.TUNNEL_X - 1) * s.mountain : 0));
  }

  // A driveway is free as it stands, but priced in full when 'type' (a retype) is asked for; a ring road is part of its roundabout
  private edgePrice(e: Edge, type?: RoadType): number {
    return e.ring ? 0 : !type && (e.drive || exitEdge(e)) ? 0 : this.price(e.a, e.b, { ...e, type: type ?? e.type });
  }

  // A road from a to b runs through a footprint grown by pad (by default up to DOOR_D - 2, so a road along the front still reaches a door)
  // ponytail: samples every 4px, like segmentCrosses
  private hitsBuilding(a: Vec, b: Vec, type: RoadType, pad = Math.min(roadWidth(type) / 2, DOOR_D - 2), list = this.buildings): boolean {
    const n = Math.max(1, Math.ceil(dist(a, b) / 4));
    for (const bd of list) {
      if (distToSegment(bd, a, b).d > (bd.w + bd.h) / 2 + pad) continue;
      for (let i = 0; i <= n; i++) if (bd.contains({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }, pad)) return true;
    }
    return false;
  }

  // Free driveway from each building without a road to the nearest ground road with access within ACCESS_R of its door:
  // a straight stub that crosses no road, water, mountain or footprint.
  // ponytail: runs only after a road is built or bent, so a demolished driveway stays gone until the next road goes down
  connect(): void {
    const g = this.graph;
    for (const b of this.buildings) {
      if (b.connected) continue;
      const door = b.node;
      // never inside a roundabout's clear radius: the nearest point along the road outside it (2px steps)
      const clear = (h: { e: Edge; d: number; point: Vec; t: number }): typeof h | null => {
        if (!g.nearRing(h.point)) return h;
        let best: typeof h | null = null;
        for (const k of [-1, 1]) for (let t = h.t; t >= 0 && t <= 1; t += k * 2 / h.e.length) {
          const point = { x: h.e.a.x + (h.e.b.x - h.e.a.x) * t, y: h.e.a.y + (h.e.b.y - h.e.a.y) * t };
          if (g.nearRing(point)) continue;
          if (!best || dist(door, point) < best.d) best = { e: h.e, d: dist(door, point), point, t };
          break;
        }
        return best;
      };
      const hits = this.accessEdges().map(e => clear({ e, ...distToSegment(door, e.a, e.b) })).filter((h): h is NonNullable<typeof h> => !!h && h.d <= T.ACCESS_R).sort((p, q) => p.d - q.d);
      hit: for (const h of hits) {
        // a road node within DRIVE_SNAP is joined rather than split beside: a stretch shorter than a truck between two junctions
        // locks both (don't block the box). ponytail: that stub runs at an angle, the place ghost still previews it square to the road
        const snap = [h.e.a, h.e.b].filter(n => !n.building && !g.nearRing(n) && dist(h.point, n) <= T.DRIVE_SNAP).sort((p, q) => dist(h.point, p) - dist(h.point, q))[0];
        // never split beside a door: that cuts a zero-length stub off a road ending there
        const byDoor = [h.e.a, h.e.b].some(n => n.building && dist(h.point, n) <= NODE_R);
        if (!snap && byDoor) continue;
        for (const end of snap ? (byDoor ? [snap] : [snap, null]) : [null]) {
          const p = end ?? h.point, terr = segmentCrosses(this.terrain, door, p);
          if (terr.water || terr.mountain || this.hitsBuilding(door, p, DEFAULT_TYPE)) continue;
          if (g.crossings(door, p, new Set(end ? [end] : []), new Set([h.e]), 0).length) continue;
          g.addEdge(door, end ?? g.splitEdge(h.e, h.point), { bridge: false, tunnel: false, level: 0, type: DEFAULT_TYPE, drive: true }, this.today);
          break hit;
        }
      }
    }
    this.syncPlans();
    this.version++;
  }

  // Roads a driveway may join: ground, not a bridge or tunnel, not a driveway or ring, an access tier
  accessEdges(): Edge[] {
    return this.graph.edges.filter(e => e.level === 0 && !e.tunnel && !e.bridge && !e.drive && !e.ring && TIERS[e.type.tier].access);
  }

  private refundX(day: number): number {
    return day === this.today ? T.REFUND_SAME_DAY : T.REFUND_LATER;
  }

  // Challenge: roads and controls built before today stay (said when refused)
  permanent(day: number): boolean {
    if (!this.challenge || day >= this.today) return false;
    this.say(PERMANENT);
    return true;
  }

  refundOf(e: Edge): number {
    return this.edgePrice(e) * this.refundX(e.day);
  }

  controlPrice(kind: Control, ring: RingSize = this.ringSize): number {
    return CONTROL_COST[kind] * (kind === 'roundabout' ? RINGS[ring].cost : 1);
  }

  // less a ring's fresh spokes (RoadGraph.spokesOf), which its removal lays
  controlRefund(n: Node): number {
    const r = n.control === 'roundabout' ? this.graph.ringOf(n) : null;
    const spokes = r ? this.graph.spokesOf(r, this.today).filter(x => x.fresh).reduce((m, { v, a, s }) => m + this.price(r.hub, v, { ...a, type: s.type }), 0) : 0;
    return this.controlPrice(n.control, n.ring) * this.refundX(n.controlDay) - spokes;
  }

  upkeepPerDay(): number {
    let sum = 0;
    for (const e of this.graph.edges) sum += this.edgePrice(e) * T.UPKEEP_RATE;
    for (const n of [...this.graph.nodes, ...this.graph.rings.map(r => r.hub)]) sum += CONTROL_UPKEEP[n.control] * (n.control === 'roundabout' ? RINGS[n.ring].cost : 1);
    for (const b of this.buildings) if (b.special) sum += SPECIALS[b.special].upkeep;
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

  // Road tool, click to click: curve = bend to meet the roads at either end (tangentAt), else one straight segment
  planRoad(a: Vec, c: Vec, curve = this.roadCurve): PathPlan {
    const ta = curve ? this.tangentAt(a, c) : null, tb = curve ? this.tangentAt(c, a) : null;
    return { ...this.planPath(!ta && !tb ? [a, c] : cubicPoints(a, ...autoControls(a, c, ta, tb), c)), note: curve ? 'Curve' : 'Straight' };
  }

  // Curved / freehand road through several anchors. The ends snap on 'level' first, else onto a node or road of another level (snapEnd);
  // intermediate anchors snap to nodes only (of 'level'), so a path can pass through a junction, or the door of a building without a road.
  // Ends on two levels make a ramp: segment i of n sits at 'level' clamped to within i levels of the start and n-1-i of the end, one
  // level per segment (a ramp is resampled to a joint per tile, and needs |end - start| + 1 segments). Doors take ground roads only.
  // ends: fixed end levels, snapped only there; snapMid false: the anchors between stay where they are (templates, whose ramps run
  // alongside the road they join). One-way roads travel in the order of 'points'.
  planPath(points: Vec[], level = this.level, type = this.roadType, ends?: [number, number], snapMid = true): PathPlan {
    const plan: PathPlan = { points: [], segs: [], cost: 0, ok: false, reason: 'Too short', type: { ...type }, level };
    if (points.length < 2) return plan;
    const end = (p: Vec, k: 0 | 1): Snap => ends ? this.snap(p, ends[k]) : this.snapEnd(p, level);
    const la = ends?.[0] ?? this.levelAt(end(points[0], 0), level), lb = ends?.[1] ?? this.levelAt(end(points[points.length - 1], 1), level);
    if (la !== level || lb !== level) points = points.flatMap((p, i) => {
      const q = points[i + 1], n = q ? Math.max(1, Math.floor(dist(p, q) / TILE)) : 1;
      return Array.from({ length: n }, (_, k) => q ? { x: p.x + (q.x - p.x) * k / n, y: p.y + (q.y - p.y) * k / n } : p);
    });
    else if (!level && snapMid) points = points.flatMap((p, i) => i ? [...shoreSplits(this.terrain, points[i - 1], p, TILE / 2), p] : [p]);
    const mid = (p: Vec): Snap => {
      if (!snapMid) return { node: null, edge: null, point: { x: p.x, y: p.y } };
      const n = this.graph.nearestNode(p, NODE_R + 4, level);
      if (!n && this.graph.nearestEdge(p, NODE_R, level)) return this.snap(p, level);
      return n ? { node: n, edge: null, point: { x: n.x, y: n.y } } : { node: null, edge: null, point: { x: p.x, y: p.y } };
    };
    const lastIdx = points.length - 1;
    let list: Snap[] = [];
    points.forEach((p, i) => {
      const s = i === 0 ? end(p, 0) : i === lastIdx ? end(p, 1) : mid(p);
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
      const tail = list[list.length - 1];
      if (!tail.node && !tail.edge && dist(tail.point, list[list.length - 2].point) < TILE / 2) {
        list.pop();
        list[list.length - 1] = end(list[list.length - 1].point, 1);
      }
    }
    // a path drawn along a road follows it: its free ends there go onto the road and the road's joints it passes become anchors, so
    // that stretch is the road itself (retyped if the type differs), never a second road on top of it
    if (snapMid && la === level && lb === level) list = this.followRoads(list, level, type);
    plan.points = list.map(s => s.point);
    if (list.length < 2) return plan;
    if (this.badGround(list[0]) || this.badGround(list[list.length - 1])) { plan.reason = 'Invalid terrain'; return plan; }
    const n = list.length - 1;
    if (Math.abs(la - lb) > n - 1) { plan.reason = 'Too steep: make the ramp longer'; return plan; }

    let total = 0, built = 0, blocked = false, hit = false, door = false, over = false, fixed = false;
    const acc = TIERS[type.tier].access;
    let noAccess = !acc && list.some(s => doorway(s.node, s.edge));
    for (let i = 1; i <= n; i++) {
      const a = list[i - 1], b = list[i], L = Math.max(la - i + 1, lb - n + i, Math.min(la + i - 1, lb + n - i, level));
      const r = this.planSeg(a, b, L, type);
      const seg: SegPlan = { a: a.point, b: b.point, ...r.flags, sa: a, sb: b, crossings: r.crossings, exists: r.exists };
      plan.segs.push(seg);
      noAccess ||= !acc && r.crossings.some(c => doorway(c.node, c.edge));
      door ||= L > 0 && !!(a.node?.building || b.node?.building);
      if (r.exists) {
        // drawn over with another type: that stretch is retyped, the price change paid or refunded as the Edit tool does
        const e = a.node && b.node ? this.graph.edgeBetween(a.node, b.node) : a.edge ?? b.edge, len = dist(a.point, b.point);
        if (!e || e.ring || e.level !== L || len < 1 || sameType(e.type, type)) continue;
        const d = this.change((this.edgePrice(e, type) - this.edgePrice(e)) * len / dist(e.a, e.b), e.day);
        seg.up = true;
        plan.cost += d;
        total += len;
        built++;
        fixed ||= d < 0 && this.challenge && e.day < this.today;
        continue;
      }
      over ||= snapMid && this.alongside(a, b, L, type).length > 0;
      total += dist(a.point, b.point);
      plan.cost += this.price(a.point, b.point, r.flags);
      blocked ||= r.blocked;
      hit ||= this.hitsBuilding(a.point, b.point, type);
      built++;
    }
    if (!built) { plan.reason = 'Already exists'; return plan; }
    if (total < TILE / 2) return plan; // 'Too short'
    const ring = this.ringBlock(list, plan.segs as SegPlan[], type);
    if (ring) { plan.reason = ring; return plan; }
    if (over) { plan.reason = 'Overlaps a road: start and end on it to change its type'; return plan; }
    if (fixed) { plan.reason = PERMANENT; return plan; }
    if (blocked) { plan.reason = 'Too low for the mountain'; return plan; }
    const tunnel = (plan.segs as SegPlan[]).some(g => g.tunnel && !g.exists) ? this.lockOf('tunnel') : '';
    if (tunnel) { plan.reason = tunnel; return plan; }
    if (door) { plan.reason = 'Buildings need a ground road'; return plan; }
    if (noAccess) { plan.reason = 'Highways give no building access'; return plan; }
    if (hit) { plan.reason = 'Blocked by a building'; return plan; }
    plan.reason = this.lockedMsg(type) || this.afford(plan.cost);
    plan.ok = !plan.reason;
    return plan;
  }

  // Same-level roads that run along a..b rather than cross or leave it: within 15 degrees, the two road bodies overlapping over NODE_R or
  // more of it. A road a..b starts or ends on is left out when it runs on past both ends (a curve leaving a road's middle tangent to it).
  // ponytail: scans every edge per segment; a spatial index if long freehand paths over big networks ever stutter
  private alongside(a: Snap, b: Snap, level: number, type: RoadType): Edge[] {
    const L = dist(a.point, b.point), o = a.point;
    if (L < NODE_R) return [];
    const ux = (b.point.x - o.x) / L, uy = (b.point.y - o.y) / L, t = (v: Vec): number => (v.x - o.x) * ux + (v.y - o.y) * uy;
    return this.graph.edges.filter(e => {
      const el = dist(e.a, e.b);
      if (e.level !== level || this.graph.hidden.has(e) || el < 1 || Math.abs((e.b.x - e.a.x) * uy - (e.b.y - e.a.y) * ux) / el > 0.26) return false;
      const tp = t(e.a), tq = t(e.b), t0 = Math.max(0, Math.min(tp, tq)), t1 = Math.min(L, Math.max(tp, tq)), tol = overlapTol(type, e.type);
      if (t1 - t0 < NODE_R || [t0, t1].some(x => distToSegment({ x: o.x + ux * x, y: o.y + uy * x }, e.a, e.b).d >= tol)) return false;
      const touch = a.edge === e || b.edge === e || [a.node, b.node].some(n => n && (n === e.a || n === e.b));
      return !touch || [tp, tq].some(x => x > NODE_R && x < L - NODE_R);
    });
  }

  // planPath's anchors along the roads they run over (alongside): a free anchor within a road's body goes onto that road, and the road's
  // nodes between two anchors become anchors, so each stretch over a road is that road's own edge (planSeg's 'exists')
  private followRoads(list: Snap[], level: number, type: RoadType): Snap[] {
    const out = [list[0]];
    for (let i = 1; i < list.length; i++) {
      let a = out[out.length - 1], b = list[i];
      const es = this.alongside(a, b, level, type);
      if (es.length) {
        const onto = (s: Snap): Snap => {
          const e = !s.node && !s.edge && es.find(x => distToSegment(s.point, x.a, x.b).d < overlapTol(type, x.type));
          return e ? this.snap(distToSegment(s.point, e.a, e.b).point, level) : s;
        };
        a = out[out.length - 1] = onto(a);
        b = onto(b);
        const L = dist(a.point, b.point), t = (v: Vec): number => ((v.x - a.point.x) * (b.point.x - a.point.x) + (v.y - a.point.y) * (b.point.y - a.point.y)) / (L || 1);
        const mid = new Set(es.flatMap(e => [e.a, e.b]).filter(v => v !== a.node && v !== b.node && t(v) > 1 && t(v) < L - 1
          && distToSegment(v, a.point, b.point).d < Math.min(...es.filter(e => e.a === v || e.b === v).map(e => overlapTol(type, e.type)))));
        out.push(...[...mid].sort((p, q) => t(p) - t(q)).map(v => ({ node: v, edge: null, point: { x: v.x, y: v.y } })));
      }
      out.push(b);
    }
    return out;
  }

  // Why a path may not touch a roundabout ('' = fine): it joins a ring only at its ends, from outside, on a free spot, as one more arm
  // the ring takes (ringRoom's rules); nothing else crosses the ring or splits, joins or ends a road within its clear radius
  private ringBlock(list: Snap[], segs: SegPlan[], type: RoadType): string {
    const g = this.graph, last = list.length - 1;
    for (const [i, s] of list.entries()) {
      const r = s.node ? g.ringOf(s.node) : s.edge?.ring;
      if (!r) {
        const near = g.nearRing(s.point);
        if (near && (s.node || s.edge || dist(s.point, near.hub) < ringOut(near.hub.ring) + ROAD_W / 2)) return 'Too close to the roundabout';
        continue;
      }
      if (i && i < last) return 'Roads can\'t cross a roundabout';
      const S = RINGS[r.hub.ring], label = S.label.toLowerCase(), q = list[i ? i - 1 : 1].point;
      if (dist(q, r.hub) <= S.r) return 'Roads join a roundabout from outside';
      if (s.node?.edges.some(e => !e.ring && !g.hidden.has(e))) return 'That spot on the roundabout already has a road';
      const arms = r.nodes.filter(v => v.edges.some(e => !e.ring && !g.hidden.has(e)));
      if (arms.length >= S.arms) return `Too many roads for a ${label} roundabout (${S.arms} at most)`;
      if (type.lanes > S.lanes) return `Too many lanes for a ${label} roundabout`;
      const a = Math.atan2(s.point.y - r.hub.y, s.point.x - r.hub.x);
      if (arms.some(v => Math.abs(Math.atan2(Math.sin(Math.atan2(v.y - r.hub.y, v.x - r.hub.x) - a), Math.cos(Math.atan2(v.y - r.hub.y, v.x - r.hub.x) - a))) < 2 * Math.PI / (S.arms + 1) - 0.01)) return 'Arms too close together';
    }
    for (const c of segs.flatMap(x => x.crossings)) {
      if (c.edge.ring) return 'Roads can\'t cross a roundabout';
      if (g.nearRing(c.point)) return 'Too close to the roundabout';
    }
    return '';
  }

  // link: give buildings near the new road their driveways (commitBend does it itself once its cars are moved)
  commitPath(plan: PathPlan, link = true, cost = plan.cost): void {
    if (!plan.ok) { if (plan.reason !== 'Too short') this.say(plan.reason); return; }
    this.lastBuilt = [];
    let node: Node | null = null;
    for (const seg of plan.segs as SegPlan[]) {
      // the end snap's edge may have been split by an earlier segment; re-snap if so
      const reSnap = (s: Snap): Snap => s.edge && !this.graph.edges.includes(s.edge) ? this.snap(s.point, seg.level) : s;
      // resolve (split) an edge end too, so the next segment leaves the road from a real node
      if (seg.exists && !seg.up) { node = this.resolve(reSnap(seg.sb)); continue; }
      const start: Node = node ?? this.resolve(reSnap(seg.sa)), end = reSnap(seg.sb);
      if (seg.up) {
        // a one-way result runs the way the path was drawn
        node = this.resolve(end);
        const e = this.graph.edgeBetween(start, node);
        if (e) { e.drive = false; this.dropCars(this.graph.setEdgeType(e, seg.type, !seg.type.oneWay || e.a === start)); }
        continue;
      }
      // crossings are recomputed on the live graph, since earlier segments may have split edges
      const live = this.planSeg({ node: start, edge: null, point: { x: start.x, y: start.y } }, end, seg.level, seg.type).crossings;
      node = this.buildSeg(start, end, { bridge: seg.bridge, tunnel: seg.tunnel, level: seg.level, type: seg.type }, live);
    }
    if (link) this.connect();
    // a later segment (or a driveway) may have split an edge built by an earlier one
    this.lastBuilt = this.lastBuilt.filter(e => this.graph.edges.includes(e));
    this.spend(cost);
  }

  demolishAt(p: Vec): void {
    const b = this.buildingUnder(p);
    if (b) { this.tryDemolish(b); return; }
    this.armed = null;
    const r = this.graph.ringAt(p, 4);
    if (r) { if (!this.permanent(r.hub.controlDay)) this.setControl(r.hub, 'none'); return; }
    const n = this.graph.nearestNode(p, NODE_R + 4);
    if (n && n.control !== 'none') { if (!this.permanent(n.controlDay)) this.setControl(n, 'none'); return; }
    // prefer a road on the current level where several are stacked
    const hit = this.graph.nearestEdge(p, ROAD_W, this.level) ?? this.graph.nearestEdge(p, ROAD_W);
    if (!hit) return;
    if (exitEdge(hit.edge)) { this.say('The highway to the outside stays: build onto it instead'); return; }
    if (this.permanent(hit.edge.day)) return;
    const e = hit.edge, back = this.refundOf(e);
    this.dropCars(this.graph.removeEdge(e));
    this.spend(-back);
  }

  // Takes the cars off the road and puts their trips back in their origin's queue, so demolishing or retyping a busy road
  // is not a free way to clear traffic. retry (stuck or lost): counts a retry, and past MAX_RETRIES the trip gives up.
  private dropCars(cars: Car[], retry = false): void {
    for (const car of cars) {
      this.graph.detachCar(car);
      const i = this.cars.indexOf(car);
      if (i >= 0) this.cars.splice(i, 1);
      const t = car.trip;
      if (retry && ++t.retries > T.MAX_RETRIES) { this.fail(t, 'gaveup'); continue; }
      t.queued = this.time;
      car.origin.pending.push(t);
    }
  }

  // ---- Edit tool ----

  runAt(p: Vec): Edge[] | null {
    const hit = this.graph.nearestEdge(p, ROAD_W, this.level) ?? this.graph.nearestEdge(p, ROAD_W);
    return hit ? this.graph.runOf(hit.edge).edges : null;
  }

  // A junction (3+ roads, not a door) near p; a roundabout's hub anywhere on it
  junctionAt(p: Vec): Node | null {
    const r = this.graph.ringAt(p, 4);
    if (r) return r.hub;
    const n = this.graph.nearestNode(p, NODE_R + 6);
    return n && !n.building && n.edges.length >= 3 ? this.graph.ringOf(n)?.hub ?? n : null;
  }

  // The car drawn nearest p within r
  carAt(p: Vec, r = 10): Car | null {
    let best: Car | null = null, bd = r;
    for (const c of this.cars) {
      const d = dist(p, this.graph.carPos(c));
      if (d < bd) { best = c; bd = d; }
    }
    return best;
  }

  // a highway exit's gate never counts: it stands off the map and cannot be moved or demolished
  buildingUnder(p: Vec): Building | null {
    return this.buildings.find(b => b.kind !== 'gate' && b.contains(p, 2)) ?? null;
  }

  // Residents or workers a demolish would turn out ('' for none): an occupied building takes a second click
  occupants(b: Building): string {
    const r = Math.round(b.residents), w = this.commuters.filter(c => c.work === b).length * T.PEOPLE_PER_CAR;
    return r ? `${r} resident${r > 1 ? 's' : ''} move out` : w ? `${w} workers lose their jobs` : '';
  }

  // Demolish click on a building: an empty one goes at once, an occupied one arms on the first click and goes on the second. Free;
  // its lots stay zoned, so the zone grows a new one there. A special refunds SPECIAL_REFUND of its price.
  tryDemolish(b: Building): boolean {
    const who = this.occupants(b);
    if (who && this.armed !== b) { this.armed = b; this.say(`Click again to demolish: ${who}`); return false; }
    this.demolishBuilding(b);
    const back = this.specialRefund(b);
    if (back) this.spend(-back);
    this.say(`${b.label} demolished${b.lots.length ? ': the lot stays zoned' : back ? ` · +${fmtMoney(back)}` : ''}`);
    return true;
  }

  specialRefund(b: Building): number {
    return b.special && !this.creative ? SPECIALS[b.special].cost * T.SPECIAL_REFUND : 0;
  }

  // Moves b's footprint to (x, y, angle) at its current size: its door node and driveway follow, cars on their way to it find the new door
  rehome(b: Building, x: number, y: number, angle: number): void {
    this.unhook(b);
    Object.assign(b, { x, y, angle });
    const d = b.door();
    this.graph.addNode(d.x, d.y, b);
    this.connect();
    for (const c of this.cars) if (c.trip.to === b) c.path = null;
    this.changed();
  }

  // A fast ambulance at home h: homes within CHEER_R are CHEER points happier for a day
  private cheer(h: Building): void {
    for (const o of this.buildings) if (o.kind === 'home' && dist(o, h) <= T.CHEER_R) o.cheer = this.time + T.DAY_SECONDS;
  }

  // Lets go of b's door: its driveways go (their cars back to their origin's door), the door node stays as a plain joint
  // only when a road runs through it
  private unhook(b: Building): void {
    const n = b.node;
    for (const e of n.edges.filter(e => e.drive)) this.dropCars(this.graph.removeEdge(e));
    n.building = null;
    this.graph.dropIfOrphan(n);
  }

  // Removes b and every reference to it; its lots stay, empty. Its commuters move out, workers lose the job;
  // a car on its way to b (not a return leg) heads to another place of its purpose, any other trip from or to b ends and its
  // commuter is home again. Its reports go too, so a save never points at it.
  demolishBuilding(b: Building): void {
    this.unhook(b);
    this.buildings = this.buildings.filter(x => x !== b);
    for (const l of b.lots) l.building = null;
    this.commuters = this.commuters.filter(c => c.home !== b);
    for (const c of this.commuters) if (c.work === b) c.work = null;
    const gone = (t: Trip): boolean => t.from === b || t.to === b;
    const home = (t: Trip): void => { if (t.who) t.who.at = 'home'; };
    const comp = this.components();
    for (const car of this.cars.filter(c => gone(c.trip))) {
      const t = car.trip, to = t.to === b && !t.back ? this.pick(t.from, comp, x => t.purpose === 'commute' || x.kind === 'shop' ? x.jobs : 0) : null;
      if (to) { t.to = to; if (t.who) t.who.work = to; car.path = null; continue; }
      this.graph.detachCar(car);
      this.cars.splice(this.cars.indexOf(car), 1);
      home(t);
    }
    for (const o of [b, ...this.buildings]) for (const list of [o.pending, o.parked]) {
      for (let i = 0; i < list.length; i++) if (o === b || gone(list[i])) home(list.splice(i--, 1)[0]);
    }
    this.reports = this.reports.filter(r => r.from !== b && r.to !== b);
    if (this.picked === b) this.picked = null;
    if (this.armed === b) this.armed = null;
    this.sfx.add('demolish');
    this.spend(0);
  }

  // Picks b up with the place tool: the ghost follows the cursor and a click sets it down (MOVE_COST outside creative); Esc puts it back.
  // A building on lots stays on them
  startMove(b: Building): void {
    if (b.kind === 'gate') return;
    if (b.lots.length) { this.say('Buildings stay on their lots: demolish one and its lot grows a new one'); return; }
    this.placing = b.special ?? b.kind;
    this.setTool('place');
    this.moving = b;
  }

  // Edit click, first hit wins: a car (followed, with its card), a junction (its panel), a building (its card), a road run (selected)
  select(p: Vec | null): void {
    this.armed = null;
    this.follow = p ? this.carAt(p) : null;
    this.inspect = p && !this.follow ? this.junctionAt(p) : null;
    this.picked = p && !this.follow && !this.inspect ? this.buildingUnder(p) : null;
    this.selected = p && !this.follow && !this.inspect && !this.picked ? this.runAt(p) : null;
  }

  // Switching away from Edit drops the selection at once, so a click right after the switch cannot retype it
  setTool(t: Tool): void {
    const f = TOOL_LOCK[t], locked = f ? this.lockOf(f) : '';
    if (locked) { this.say(locked); return; }
    if (t === 'place' && !this.placing) this.placing = 'home';
    this.tool = t;
    if (t !== 'edit') { this.selected = null; this.inspect = null; this.follow = null; this.picked = null; }
    if (t !== 'place') this.placing = this.moving = null;
    if (t !== 'demolish') this.armed = null;
    if (t !== 'interchange') this.ichg = null;
    if (t !== 'zone') this.zonePlan = null;
  }

  // The zone brush holding z (null = Unzone)
  setZone(z: Zone | null): void {
    const lv = z ? TIER_DEFS[z][0].level : 1;
    if (!this.unlocked(lv)) { this.say(this.lockText(lv, `${ZONE_NAME[z!]} zone`)); return; }
    this.zone = z;
    this.setTool('zone');
  }

  // ---- Place tool (moves, and buildings set down by scripts) ----

  startPlacing(kind: Zone | Special = 'home'): void {
    this.moving = null;
    this.placing = kind;
    this.setTool('place');
  }

  // Ghost of the held building at p. Near an access road (SNAP_R) it faces the road with its door DRIVE_GAP past the road's edge;
  // elsewhere it stands free, turned by placeAngle. It must lie inside the map on dry land, clear of roads (by a 4px margin) and
  // of other buildings. Moving one: MOVE_COST outside creative, and its own footprint and driveways are out of the way.
  planPlace(p: Vec, kind = this.placing): PlacePlan | null {
    if (!kind) return null;
    const hit = this.accessEdges().map(e => ({ e, ...distToSegment(p, e.a, e.b) })).filter(h => h.d <= T.SNAP_R).sort((x, y) => x.d - y.d)[0];
    let b: Building, road: Vec | null = null;
    if (hit) {
      const { e, point: q } = hit;
      let nx = -(e.b.y - e.a.y) / e.length, ny = (e.b.x - e.a.x) / e.length;
      if (nx * (p.x - q.x) + ny * (p.y - q.y) < 0) { nx = -nx; ny = -ny; }
      const d = e.width / 2 + T.DRIVE_GAP;
      b = buildingAt(kind, { x: q.x + nx * d, y: q.y + ny * d }, Math.atan2(-ny, -nx));
      road = q;
    } else b = Object.assign(buildingAt(kind, p, this.placeAngle), { x: p.x, y: p.y });
    const pts = b.outline(), m = 4, mv = this.moving;
    // ponytail: overlap by sampled outline points both ways; fine for near-square footprints, SAT if long thin ones arrive
    const sp = b.special ? SPECIALS[b.special] : null;
    const reason = (mv ? this.afford(this.moveCost) : sp ? this.specialWhy(b) || this.afford(this.specialCost(b.special!)) : '')
      || (pts.some(q => q.x < m || q.y < m || q.x > WORLD.w - m || q.y > WORLD.h - m) ? 'Outside the map'
      : pts.some(q => inWater(this.terrain, q, m) || inMountain(this.terrain, q, m)) ? 'Blocked by water or a mountain'
      : this.graph.edges.some(e => !(mv && e.drive && (e.a === mv.node || e.b === mv.node)) && this.hitsBuilding(e.a, e.b, e.type, e.width / 2 + m, [b])) ? 'Overlaps a road'
      : this.buildings.some(o => o !== mv && (pts.some(q => o.contains(q, m)) || o.outline().some(q => b.contains(q, m)))) ? 'Overlaps a building'
      : '');
    const factories = this.buildings.filter(o => o.def.pollution && dist(o, b) < o.def.pollution).length;
    const homes = b.def.pollution ? this.buildings.filter(o => o.kind === 'home' && dist(o, b) < b.def.pollution).length : 0;
    const noisy = () => this.graph.edges.some(e => !e.tunnel && TIERS[e.type.tier].noise >= T.NOISY && distToSegment(b, e.a, e.b).d < T.NOISE_R);
    const warn = !road ? 'No road yet: connect its door'
      : b.kind === 'home' && factories ? 'Factory nearby: residents will be less happy'
      : b.kind === 'home' && noisy() ? 'Noisy road: residents will be less happy'
      : homes ? `Pollutes ${homes} home${homes > 1 ? 's' : ''} nearby`
      : '';
    const label = mv ? `Move here${this.moveCost ? ` · ${fmtMoney(this.moveCost)}` : ''}`
      : sp ? `${sp.name} · +${this.tripsPerDay(b)} trips/day · ${this.tokens.includes(b.special!) ? 'free' : fmtMoney(this.specialCost(b.special!))} · upkeep ${fmtMoney(sp.upkeep)}/day` : b.label;
    return { b, ok: !reason, reason, warn, road, label };
  }

  // Build price of special s: nothing in creative or with a milestone token
  // ponytail: a token-built special still refunds SPECIAL_REFUND when demolished (a small cash-out); flag the building if it matters
  specialCost(s: Special): number {
    return this.creative || this.tokens.includes(s) ? 0 : SPECIALS[s].cost;
  }

  // How many of special s may stand: plazas 2, a stadium 1, a hospital per HOSPITAL_POP residents (at least 1), a terminal per linked exit
  specialLimit(s: Special): number {
    return s === 'plaza' ? 2 : s === 'stadium' ? 1 : s === 'hospital' ? Math.max(1, Math.floor(this.population / T.HOSPITAL_POP)) : this.linkedExits().length;
  }

  // Why special b (the ghost, or the one being moved) cannot go where it stands: locked, at its limit, a terminal away from the exits
  specialWhy(b: Building): string {
    const s = b.special!, d = SPECIALS[s], n = this.buildings.filter(o => o.special === s && o !== this.moving).length;
    if (!this.unlocked(d.level)) return this.lockText(d.level, d.name);
    if (n >= this.specialLimit(s)) return s === 'terminal' ? (n ? 'One terminal per linked highway exit' : 'Link a highway exit to the town first')
      : s === 'hospital' ? `One hospital per ${T.HOSPITAL_POP.toLocaleString('en-US')} residents` : s === 'plaza' ? 'At most 2 mall plazas' : 'One stadium per city';
    if (s === 'terminal' && !this.buildings.some(o => o.kind === 'gate' && dist(o, b) <= T.TERMINAL_R)) return `Build it within ${T.TERMINAL_R} px of a highway exit`;
    return '';
  }

  // Rough car trips a day to and from b, both legs: its commuters, shoppers, visitors and trucks; a stadium's fans, a hospital's calls
  tripsPerDay(b: Building): number {
    const d = b.def, pop = this.population;
    const n = d.residents * (T.EMPLOY_RATE + T.SHOP_RATE) / T.PEOPLE_PER_CAR + d.jobs / T.PEOPLE_PER_CAR + d.visits + d.trucks
      + (b.special === 'stadium' ? Math.min(T.FANS_MAX, T.FANS + pop / T.FANS_POP) / T.MATCH_DAYS : b.special === 'hospital' ? pop / T.EMERGENCY_POP : 0);
    return Math.round(2 * n);
  }

  get moveCost(): number { return this.creative ? 0 : T.MOVE_COST; }

  // Places the held building at p with its free driveway (the tool keeps holding the zone). A moved building keeps its households,
  // jobs and trips: cars on their way to it find the new door.
  placeBuilding(p: Vec): boolean {
    const plan = this.planPlace(p);
    if (!plan) return false;
    if (!plan.ok) { this.say(plan.reason); return false; }
    const mv = this.moving;
    if (mv) {
      this.rehome(mv, plan.b.x, plan.b.y, plan.b.angle);
      this.spend(this.moveCost);
      this.sfx.add('place');
      this.setTool('edit');
      this.picked = mv;
      this.say(`${mv.label} moved${this.moveCost ? ` · ${fmtMoney(this.moveCost)}` : ''}`);
      return true;
    }
    const b = plan.b;
    if (b.kind === 'home') b.residents = b.cap * T.PLACED_OCC;
    this.addBuilding(b);
    this.connect();
    pruneLots(this);
    this.sfx.add('place');
    // a special is paid for, and its card opens
    if (b.special) {
      this.spend(this.specialCost(b.special));
      const tk = this.tokens.indexOf(b.special);
      if (tk >= 0 && !this.creative) this.tokens.splice(tk, 1);
      this.setTool('edit');
      this.picked = b;
      this.say(`${b.label} built: ${SPECIALS[b.special].tip}`);
    }
    return true;
  }
  typeOf(run: Edge[]): RoadType {
    return run[0].type;
  }

  // True when the run's first edge points away from its first node (one-way runs then travel first -> last)
  runForward(run: Edge[]): boolean {
    const r = this.graph.runOf(run[0]);
    return r.edges[0].a === r.nodes[0];
  }

  // Full build price of the run (as 'type')
  private runPrice(run: Edge[], type?: RoadType): number {
    return run.reduce((n, e) => n + this.edgePrice(e, type), 0);
  }

  // A price change on a road built on 'day': a rise is paid in full, a drop comes back under the refund rule
  private change(d: number, day: number): number {
    return d < 0 ? d * this.refundX(day) : d;
  }

  // $ to pay (negative = refund) for the run as fitType(type). Same type on every edge (a flip) is free.
  retypeDelta(run: Edge[], type: RoadType): number {
    type = fitType(type);
    if (run.every(e => sameType(e.type, type))) return 0;
    return run.reduce((n, e) => n + this.change(this.edgePrice(e, type) - this.edgePrice(e), e.day), 0);
  }

  // Retypes the run as fitType(type), upgrades and downgrades across tiers included.
  // Keeps the run's current travel direction (for one-way results) unless reverse.
  retype(run: Edge[], type: RoadType, reverse = false): boolean {
    type = fitType(type);
    if (!reverse && run.every(e => sameType(e.type, type))) return true;
    const { edges, nodes } = this.graph.runOf(run[0]);
    const why = this.lockedMsg(type)
      || (!TIERS[type.tier].access && nodes.some(n => doorway(n)) ? 'Highways give no building access' : '');
    if (why) { this.say(why); return false; }
    const d = this.retypeDelta(run, type);
    if (d > this.money) { this.say('Not enough money'); return false; }
    if (d < 0 && this.permanent(Math.min(...edges.map(e => e.day)))) return false;
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
  // Affordability counts the run's full price as credit; plan.net = cost - credit, a refund under the old road's refund rule.
  planBend(run: Edge[], handle: Vec): PathPlan {
    const g = this.graph, r = g.runOf(run[0]);
    const A = r.nodes[0], B = r.nodes[r.nodes.length - 1];
    const type = this.typeOf(run);
    // closed loop: nothing to bend between (and the shared node would be dropped as an orphan)
    if (A === B) return this.planPath([A], run[0].level, type);
    const pts = cubicPoints(A, ...bendControls(A, B, handle), B);
    // a one-way run travelling last -> first is rebuilt in that order
    if (type.oneWay && !this.runForward(run)) pts.reverse();
    const credit = this.runPrice(r.edges), day = Math.min(...r.edges.map(e => e.day));
    g.hidden = new Set(r.edges);
    this.money += credit;
    try {
      // a ramp or overpass keeps its top level; its ends keep theirs
      const plan = this.planPath(pts, Math.max(...r.edges.map(e => e.level)), type);
      plan.net = this.change(plan.cost - credit, day);
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
    const day = Math.min(...r.edges.map(e => e.day));
    for (const e of r.edges) for (const car of g.removeEdge(e)) g.detachCar(car);
    // one payment once the new road stands, so syncPlans never sees the junctions with the run missing
    this.commitPath(plan, false, plan.net);
    // lastBuilt runs in plan order: A -> B, or B -> A for a reversed one-way run
    const built = this.lastBuilt;
    // the bent road keeps its oldest build day, so a bend never buys a same-day refund
    for (const e of built) e.day = day;
    const len = built.reduce((n, e) => n + e.length, 0), touched = new Set<Lane>();
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
      touched.add(lane);
    }
    // a shorter road or fewer lanes: cars pushed back off each other, the ones that no longer fit go back to their origins
    for (const l of touched) this.dropCars(this.graph.respace(l));
    this.connect();
    const live = built.filter(e => g.edges.includes(e));
    this.selected = live.length ? live : null;
    return true;
  }

  // ---- Grid tool ----

  // Street grid from corner a, its first side to b (any angle), as deep as c reaches across that side; blocks of about gridSize tiles,
  // both sides split evenly. Lines along the side first, then across; each runs through every crossing point, so a later line snaps
  // onto the nodes of the earlier ones.
  gridLines(a: Vec, b: Vec, c: Vec | null): { lines: Vec[][]; nu: number; nv: number } {
    const w = dist(a, b), bs = this.gridSize * TILE;
    if (w < TILE) return { lines: [], nu: 0, nv: 0 };
    const ux = (b.x - a.x) / w, uy = (b.y - a.y) / w, d = c ? (c.y - a.y) * ux - (c.x - a.x) * uy : 0;
    const nu = Math.max(1, Math.round(w / bs)), nv = Math.round(Math.abs(d) / bs);
    const at = (i: number, j: number): Vec => {
      const s = w * i / nu, t = nv ? d * j / nv : 0;
      return { x: a.x + ux * s - uy * t, y: a.y + uy * s + ux * t };
    };
    const run = <T>(k: number, f: (m: number) => T): T[] => Array.from({ length: k + 1 }, (_, m) => f(m));
    return { lines: [...run(nv, j => run(nu, i => at(i, j))), ...(nv ? run(nu, i => run(nv, j => at(i, j))) : [])], nu, nv };
  }

  // The whole grid as one plan (each line planned on the graph as it stands; lines that already exist are left out), all or nothing
  planGrid(a: Vec, b: Vec, c: Vec | null): PathPlan {
    const { lines, nu, nv } = this.gridLines(a, b, c), type = this.roadType;
    const plan: PathPlan = {
      points: [c ?? b], segs: [], cost: 0, ok: false, reason: lines.length ? '' : 'Too short', type: { ...type }, level: 0,
      note: c ? `${nu} × ${nv} block${nu * nv === 1 ? '' : 's'}` : 'First side',
    };
    for (const l of lines) {
      const p = this.planPath(l, 0, type, [0, 0]);
      if (p.reason === 'Already exists') continue;
      plan.segs.push(...p.segs);
      plan.cost += p.cost;
      if (!p.ok && p.reason !== 'Not enough money') plan.reason ||= p.reason;
    }
    plan.reason ||= this.lockOf('grid') || this.afford(plan.cost);
    plan.ok = !plan.reason;
    return plan;
  }

  commitGrid(a: Vec, b: Vec, c: Vec): boolean {
    const plan = this.planGrid(a, b, c);
    if (!plan.ok) { if (plan.reason !== 'Too short') this.say(plan.reason); return false; }
    // ponytail: checked as a whole above; live, a line only differs by snapping onto the lines laid before it
    for (const l of this.gridLines(a, b, c).lines) {
      const p = this.planPath(l, 0, this.roadType, [0, 0]);
      if (p.ok) this.commitPath(p, false);
    }
    this.connect();
    return true;
  }

  // ---- Interchange tool ----

  // The arm from n along e out to distance len: straight (within 6px of its first direction), two-way, on the ground, through plain
  // joints only; or why not
  private arm(n: Node, e: Edge, len: number): Arm | string {
    const o0 = e.a === n ? e.b : e.a, ux = (o0.x - n.x) / e.length, uy = (o0.y - n.y) / e.length, edges: Edge[] = [], nodes: Node[] = [];
    for (let at = n, cur = e; ;) {
      if (cur.level || cur.tunnel) return 'Interchanges go on ground junctions';
      if (cur.type.oneWay) return 'Interchanges need two-way roads';
      if (cur.type.tier === 'dirt') return 'Upgrade the dirt roads first';
      const o = cur.a === at ? cur.b : cur.a;
      if (Math.abs((o.x - n.x) * uy - (o.y - n.y) * ux) > 6) break;
      edges.push(cur);
      nodes.push(at);
      if (dist(o, n) >= len) return { edges, nodes, at: distToSegment({ x: n.x + ux * len, y: n.y + uy * len }, cur.a, cur.b).point };
      if (o.building || o.edges.length !== 2 || o.control !== 'none') break;
      at = o;
      cur = o.edges[0] === cur ? o.edges[1] : o.edges[0];
    }
    return `Needs straight roads ${Math.ceil(len / TILE)} tiles out from the junction, with no other junction`;
  }

  // Lays the template on n: the main road (highest tier; a trumpet's through road) is u, the crossing road (stem) v, picked so the frame
  // turns like the screen's. Each quadrant maps onto its own pair of arms, so roads up to 20 degrees off square still line up.
  private ichgFrame(n: Node, kind: Ichg): IchgFrame | string {
    const t = ICHG[kind], es = [...n.edges];
    if (es.length !== t.arms) return `${t.label} needs a junction of ${t.arms} roads`;
    const dir = (e: Edge): Vec => { const o = e.a === n ? e.b : e.a; return { x: (o.x - n.x) / e.length, y: (o.y - n.y) / e.length }; };
    const dot = (e: Edge, f: Edge): number => dir(e).x * dir(f).x + dir(e).y * dir(f).y;
    const tilt = Math.sin(Math.PI / 9), line = -Math.cos(Math.PI / 9), tier = (e: Edge): number => TIER_RANK.indexOf(e.type.tier);
    let main: Edge[], cross: Edge[];
    if (t.arms === 4) {
      es.sort((p, q) => Math.atan2(dir(p).y, dir(p).x) - Math.atan2(dir(q).y, dir(q).x));
      const ax = [[es[0], es[2]], [es[1], es[3]]];
      if (ax.some(([p, q]) => dot(p, q) > line) || Math.abs(dot(es[0], es[1])) > tilt) return 'The roads must cross at right angles (within 20°)';
      const top = (x: Edge[]) => Math.max(...x.map(e => tier(e) * 4 + e.type.lanes));
      [main, cross] = top(ax[1]) > top(ax[0]) ? [ax[1], ax[0]] : [ax[0], ax[1]];
      if (kind === 'clover' && Math.max(...main.map(tier)) < TIER_RANK.indexOf('boulevard')) return 'A cloverleaf needs a boulevard or highway';
    } else {
      const k = [0, 1, 2].find(i => dot(es[(i + 1) % 3], es[(i + 2) % 3]) <= line);
      if (k === undefined || Math.abs(dot(es[k], es[(k + 1) % 3])) > tilt) return 'Needs a straight road with a side road at right angles (within 20°)';
      main = [es[(k + 1) % 3], es[(k + 2) % 3]];
      cross = [es[k]];
    }
    const cuts: Arm[] = [];
    for (const e of main) { const a = this.arm(n, e, t.reach); if (typeof a === 'string') return a; }
    for (const e of cross) { const a = this.arm(n, e, t.cut); if (typeof a === 'string') return a; cuts.push(a); }
    const vp = dir(cross[0]), vm = cross[1] ? dir(cross[1]) : { x: -vp.x, y: -vp.y };
    const [pu, mu] = dir(main[0]).x * vp.y - dir(main[0]).y * vp.x > 0 ? [main[0], main[1]] : [main[1], main[0]];
    const up = dir(pu), um = dir(mu);
    const map = (p: Vec): Vec => {
      const u = p.x >= 0 ? up : um, v = p.y >= 0 ? vp : vm, a = Math.abs(p.x), b = Math.abs(p.y);
      return { x: n.x + u.x * a + v.x * b, y: n.y + u.y * a + v.y * b };
    };
    // ramps: one lane one-way, at most an avenue and never above either road, so the roads keep the right of way where ramps join
    const low = TIER_RANK[Math.min(TIER_RANK.indexOf('avenue'), ...[...main, ...cross].map(tier))];
    return { map, cuts, deck: { ...cross[0].type }, ramp: fitType({ tier: low, lanes: 1, oneWay: true }) };
  }

  // Refund for cutting an arm out: its edges, the last one only up to the cut point
  private cutRefund(c: Arm): number {
    const last = c.edges[c.edges.length - 1];
    return c.edges.slice(0, -1).reduce((n, e) => n + this.refundOf(e), 0)
      + this.price(c.nodes[c.nodes.length - 1], c.at, last) * this.refundX(last.day);
  }

  // Preview of a template on n: the crossing road's inner span hidden and every path planned on the graph as it stands. cost = roads and
  // controls; net = cost minus the refunds of the span and of n's control. Cached until the graph, money or city level changes.
  planInterchange(n: Node, kind: Ichg): PathPlan {
    const key = `${n.id}|${kind}|${this.version}|${Math.floor(this.money)}|${this.cityLevel}`, hit = this.ichgCache.get(key);
    if (hit) return hit;
    if (this.ichgCache.size > 30) this.ichgCache.clear();
    const t = ICHG[kind], f = this.lockOf('interchange') || this.ichgFrame(n, kind);
    const plan: PathPlan = { points: [{ x: n.x, y: n.y }], segs: [], cost: 0, ok: false, reason: '', type: { ...this.roadType }, level: 2, note: t.label };
    if (typeof f === 'string') plan.reason = f;
    else {
      const g = this.graph, credit = this.controlRefund(n) + f.cuts.reduce((x, c) => x + this.cutRefund(c), 0);
      g.hidden = new Set(f.cuts.flatMap(c => c.edges));
      try {
        for (const p of t.paths) {
          const pp = this.planPath(p.pts.map(f.map), p.level, p.ramp ? f.ramp : f.deck, p.ends, false);
          plan.segs.push(...pp.segs);
          plan.cost += pp.cost;
          if (!pp.ok && pp.reason !== 'Not enough money') plan.reason ||= pp.reason;
          if ((pp.segs as SegPlan[]).some(s => s.crossings.length)) plan.reason ||= 'Nearby roads are in the way';
        }
      } finally {
        g.hidden = new Set();
      }
      plan.cost += t.controls.reduce((x, c) => x + CONTROL_COST[c.kind], 0);
      plan.net = plan.cost - credit;
      plan.reason ||= this.afford(plan.net);
    }
    plan.ok = !plan.reason;
    this.ichgCache.set(key, plan);
    return plan;
  }

  // Interchange tool click: a junction of 3 or 4 roads opens the picker on the first template that fits; elsewhere the picker closes
  pickInterchange(p: Vec): void {
    const n = this.junctionAt(p);
    this.ichg = null;
    if (!n) return;
    if (n.control === 'roundabout') { this.say('Take the roundabout out first'); return; }
    const kinds = ICHG_KEYS.filter(k => ICHG[k].arms === n.edges.length);
    if (!kinds.length) { this.say('Interchanges go on a junction of 3 or 4 roads'); return; }
    this.ichg = { node: n, kind: kinds.find(k => this.planInterchange(n, k).ok) ?? kinds[0] };
  }

  // The interchange preview: the picked one, else the first template for the junction under p
  ichgAt(p: Vec | null): PathPlan | null {
    const n = this.ichg?.node ?? (p ? this.junctionAt(p) : null);
    const kind = this.ichg?.kind ?? ICHG_KEYS.find(k => n && ICHG[k].arms === n.edges.length);
    return n && kind ? this.planInterchange(n, kind) : null;
  }

  // Builds the picked template: the junction's control goes (refunded), the crossing road's span is cut out (refunded, its cars sent
  // home), every path is planned and built on the live graph in order, then the controls go on
  buildInterchange(): boolean {
    const ic = this.ichg;
    if (!ic) return false;
    const plan = this.planInterchange(ic.node, ic.kind), f = this.ichgFrame(ic.node, ic.kind);
    if (!plan.ok || typeof f === 'string') { this.say(plan.reason); return false; }
    const g = this.graph, n = ic.node, t = ICHG[ic.kind];
    n.plan = null;
    this.setControl(n, 'none');
    let back = 0;
    for (const c of f.cuts) {
      const last = c.edges[c.edges.length - 1], near = c.nodes[c.nodes.length - 1], far = last.a === near ? last.b : last.a;
      back += this.cutRefund(c);
      const m = dist(c.at, far) < 1 ? null : g.splitEdge(last, c.at);
      for (const e of [...c.edges.slice(0, -1), m ? g.edgeBetween(near, m)! : last]) this.dropCars(g.removeEdge(e));
    }
    this.spend(-back);
    for (const p of t.paths) {
      const pp = this.planPath(p.pts.map(f.map), p.level, p.ramp ? f.ramp : f.deck, p.ends, false);
      // ponytail: the preview checked every path; a live failure (a bug) leaves what was built so far
      if (!pp.ok) { this.say(pp.reason); break; }
      this.commitPath(pp, false);
    }
    for (const c of t.controls) {
      const m = g.nearestNode(f.map(c.p), 4, c.level);
      if (m) this.setControl(m, c.kind);
    }
    this.connect();
    this.ichg = null;
    if (ic.kind === 'clover') this.feat('clover', 1);
    this.say(`${t.label} built`);
    return true;
  }

  placeControl(p: Vec, kind: Control): void {
    const r = this.graph.ringAt(p, 4), n = r?.hub ?? this.graph.nearestNode(p, NODE_R + 6);
    if (!n || n.building || (!r && n.edges.length < 3)) { this.say('Place on an intersection'); return; }
    this.setControl(n, kind, kind === 'roundabout' ? this.ringSize : undefined);
  }

  // Why a ring of this size does not fit at junction n, or round ring hub n for a resize ('' = it fits): at most RINGS arms of at most
  // RINGS lanes each way, on the ground, no two closer than a full turn / (arms + 1); every arm's next junction, door or dead end
  // (followed through its bends and driveway joins) outside the clear radius, and no other road or building under the ring
  ringRoom(n: Node, size: RingSize): string {
    const g = this.graph, S = RINGS[size], r = g.ringOf(n), label = S.label.toLowerCase(), R = clearR(size);
    const arms = r ? r.nodes.flatMap(v => v.edges.filter(e => !e.ring).map(e => ({ v, e }))) : n.edges.map(e => ({ v: n, e }));
    if (arms.length > S.arms) return `Too many roads for a ${label} roundabout (${S.arms} at most)`;
    if (arms.some(({ e }) => e.level || e.bridge || e.tunnel)) return 'Roundabouts go on ground junctions';
    if (arms.some(({ e }) => e.type.lanes > S.lanes)) return `Too many lanes for a ${label} roundabout`;
    const ang = arms.map(({ v, e }) => r ? Math.atan2(v.y - n.y, v.x - n.x) : edgeAngle(n, e)).sort((a, b) => a - b);
    const T2 = 2 * Math.PI;
    if (ang.some((a, i) => ((ang[(i + 1) % ang.length] - a + T2) % T2 || T2) < T2 / (S.arms + 1) - 0.01)) return 'Arms too close together';
    const walked = new Set<Edge>(r ? r.nodes.flatMap(v => v.edges) : []), seen = new Set<Node>(r ? r.nodes : [n]);
    for (const { v, e } of arms) {
      for (let at = v, cur = e, k = 0; k < 100; k++) {
        walked.add(cur);
        const o = cur.a === at ? cur.b : cur.a;
        if (o.building || o.control !== 'none' || o.edges.filter(x => !x.drive).length !== 2 || seen.has(o)) {
          if (dist(o, n) < R) return 'Too close to the next junction';
          break;
        }
        seen.add(o);
        at = o;
        cur = o.edges.find(x => !x.drive && x !== cur)!;
      }
    }
    const reach = ringOut(size) + ROAD_W / 2;
    if (g.edges.some(e => !walked.has(e) && !e.drive && !e.level && !e.tunnel && distToSegment(n, e.a, e.b).d < reach + e.width / 2)) return 'Too close to another road';
    if (this.buildings.some(b => b.kind !== 'gate' && b.contains(n, ringOut(size)))) return 'Blocked by a building';
    return '';
  }

  // Switching sells the old control under the refund rule; 'none' just sells it. A roundabout (n: its hub or one of its nodes) keeps its
  // size unless one is given (the tool's for a new one); a resize is a switch. A ring is built round the junction or taken out (back to
  // one node joining the arms), the cars on the pieces that go back to their origins, and the open panel follows. Driveways joining
  // inside the new ring's clear radius are laid again outside it.
  setControl(n: Node, kind: Control, ring?: RingSize): boolean {
    const g = this.graph, r = g.ringOf(n);
    if (r) n = r.hub;
    const size = ring ?? (r ? n.ring : this.ringSize);
    if (n.control === kind && (kind !== 'roundabout' || n.ring === size)) return true;
    const locked = kind === 'roundabout' ? this.lockOf('roundabout') : '';
    if (locked) { this.say(locked); return false; }
    const tight = kind === 'roundabout' ? this.ringRoom(n, size) : '';
    if (tight) { this.say(tight); return false; }
    const cost = this.controlPrice(kind, size) - this.controlRefund(n);
    if (cost > this.money) { this.say('Not enough money'); return false; }
    let m = n;
    if (r) { const x = g.removeRing(r, this.today); this.dropCars(x.cars); m = x.node; }
    if (kind === 'roundabout') {
      const drives = g.edges.filter(e => e.drive && [e.a, e.b].some(v => !v.building && dist(v, m) < clearR(size)));
      for (const e of drives) this.dropCars(g.removeEdge(e));
      // ponytail: ringRoom passed, so every arm reaches the circle and the build cannot fail
      const b = g.buildRing(m, size, this.today)!;
      this.dropCars(b.cars);
      m = b.ring.hub;
      if (drives.length) this.connect();
    } else {
      m.control = kind;
      m.controlDay = this.today;
      m.phase = 0;
      m.phaseTimer = 0;
    }
    if (this.inspect === n) this.inspect = m;
    this.spend(cost);
    return true;
  }

  // Edits a copy of the junction's plan (phases, protected lefts, lane connections); free. A connection change reroutes every car not already
  // granted through the junction.
  editPlan(n: Node, edit: (p: JunctionPlan) => void): void {
    const locked = this.lockOf('junction');
    if (locked) { this.say(locked); return; }
    const old = planOf(n), p = clonePlan(old);
    edit(p);
    n.plan = p;
    if (n.phase >= p.phases.length) { n.phase = 0; n.phaseTimer = 0; }
    if (JSON.stringify([p.ban, p.lanes]) !== JSON.stringify([old.ban, old.lanes])) for (const c of this.cars) if (c.granted !== n) c.path = null;
  }

  // A message worth keeping: said (unless quiet) and added to the notification feed (at: where a click jumps the camera)
  note(text: string, at: Vec | null = null, quiet = false): void {
    if (!quiet) this.say(text);
    this.news = [...this.news, { text, at: at && { x: at.x, y: at.y }, day: this.day, hour: Math.floor(this.hour) }].slice(-40);
    this.newsN++;
  }

  say(text: string): void {
    this.message = text;
    this.said++;
    clearTimeout(this.msgTimeout);
    // ponytail: real time (2.5 s), so the message clears even while the game is paused
    this.msgTimeout = setTimeout(() => { this.message = ''; }, 2500);
  }
}
