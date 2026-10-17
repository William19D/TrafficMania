// Save games: versioned JSON in localStorage. Terrain comes back from cfg.seed; cars are not saved, their trips wait at the
// origin's door again (as when a road is demolished). Buildings, commuters and nodes are referenced by index (-1 = none).
import { Game, HOUR, ledger0 } from './Game.ts';
import type { Ledger } from './Game.ts';
import { BIOMES, DIFFICULTY, SIZES, TUNING as T } from './config.ts';
import type { GameConfig, Site, Zone } from './config.ts';
import type { Metrics } from './Metrics.ts';
import { Building } from '../entities/Building.ts';
import type { Commuter, Parts } from '../entities/Building.ts';
import type { Trip, TripReport } from '../entities/Trip.ts';
import { RoadGraph } from '../network/RoadGraph.ts';
import type { Control, RingSize, RoadType } from '../network/RoadGraph.ts';
import type { JunctionPlan } from '../network/Junction.ts';
import { adoptLots, demandOf } from './Zones.ts';

type Ref = number;
type TripData = Omit<Trip, 'from' | 'to' | 'who' | 'jam'> & { from: Ref; to: Ref; who: Ref };
interface BuildingData {
  kind: Site; x: number; y: number; angle: number; residents: number; stock: number; staffed: number; shopAcc: number; truckAcc: number;
  importAcc?: number; visitAcc?: number; // absent before outside connections
  happy: number; parts: Parts; recent: Building['recent']; pending: TripData[]; parked: TripData[];
  tier?: number; abandoned?: boolean; access?: number; downH?: number; upH?: number; // absent before zones (a legacy building)
}
export interface SaveData {
  v: 1; cfg: GameConfig; time: number; lastHour: number; assignAt: number; money: number; score: number; upkeepDay: number;
  // tray: before zones (ignored); lots, loan, spawnAcc: absent before them (each building then gets a lot of its own)
  cityLevel: number; tray?: Record<Zone, number>; happiness: number; cityParts: Parts; debtDays: number; sadDays: number;
  lots?: { x: number; y: number; angle: number; w: number; zone: Zone; b: Ref }[]; loan?: number; spawnAcc?: Record<Zone, number>;
  stats: Game['stats']; ledger: { today: Ledger; yesterday: Ledger }; roadType: RoadType;
  buildings: BuildingData[];
  commuters: (Omit<Commuter, 'home' | 'work'> & { home: Ref; work: Ref })[];
  nodes: { x: number; y: number; b: Ref; control: Control; controlDay: number; phase: number; phaseTimer: number; plan: JunctionPlan | null; delay: number; ring?: RingSize }[];
  edges: { a: Ref; b: Ref; type: RoadType; bridge: boolean; tunnel: boolean; level: number; day: number; drive: boolean; exit?: boolean; heat: number; ring?: Ref }[];
  // absent before ring roundabouts (a 'roundabout' node is rebuilt as a ring on load)
  rings?: { x: number; y: number; size: RingSize; day: number; nodes: Ref[] }[];
  reports: (Omit<TripReport, 'from' | 'to'> & { from: Ref; to: Ref })[];
  metrics: Metrics;
}

// JSON has no Infinity (creative money and tray, an idle assignAt); a seed is the one free-text string
const replace = (_: string, v: unknown): unknown => v === Infinity ? 'Infinity' : v;
const revive = (k: string, v: unknown): unknown => v === 'Infinity' && k !== 'seed' ? Infinity : v;

export function serialize(g: Game): string {
  const bi = new Map(g.buildings.map((b, i) => [b, i])), ci = new Map(g.commuters.map((c, i) => [c, i]));
  const ni = new Map(g.graph.nodes.map((n, i) => [n, i])), ri = new Map(g.graph.rings.map((r, i) => [r, i]));
  const trip = (t: Trip, queued = t.queued): TripData => {
    const { jam: _, ...rest } = t;
    return { ...rest, queued, from: bi.get(t.from)!, to: bi.get(t.to)!, who: t.who ? ci.get(t.who)! : -1 };
  };
  const data: SaveData = {
    v: 1, cfg: g.cfg, time: g.time, lastHour: g.lastHour, assignAt: g.assignAt, money: g.money, score: g.score, upkeepDay: g.upkeepDay,
    cityLevel: g.cityLevel, happiness: g.happiness, cityParts: g.cityParts, debtDays: g.debtDays, sadDays: g.sadDays,
    stats: g.stats, ledger: g.ledger, roadType: g.roadType, loan: g.loan, spawnAcc: g.spawnAcc,
    lots: g.lots.map(l => ({ x: l.x, y: l.y, angle: l.angle, w: l.w, zone: l.zone, b: l.building ? bi.get(l.building)! : -1 })),
    buildings: g.buildings.map(b => ({
      kind: b.kind, x: b.x, y: b.y, angle: b.angle, residents: b.residents, stock: b.stock, staffed: b.staffed, shopAcc: b.shopAcc,
      truckAcc: b.truckAcc, importAcc: b.importAcc, visitAcc: b.visitAcc, happy: b.happy, parts: b.parts, recent: b.recent, parked: b.parked.map(t => trip(t)),
      tier: b.tier, abandoned: b.abandoned, access: b.access, downH: b.downH, upH: b.upH,
      // a car on the road waits at its origin's door again
      pending: [...b.pending.map(t => trip(t)), ...g.cars.filter(c => c.trip.from === b).map(c => trip(c.trip, g.time))],
    })),
    commuters: g.commuters.map(c => ({ ...c, home: bi.get(c.home)!, work: c.work ? bi.get(c.work)! : -1 })),
    nodes: g.graph.nodes.map(n => ({
      x: n.x, y: n.y, b: n.building ? bi.get(n.building)! : -1, control: n.control, controlDay: n.controlDay, phase: n.phase,
      phaseTimer: n.phaseTimer, plan: n.plan, delay: n.delay, ring: n.ring,
    })),
    edges: g.graph.edges.map(e => ({
      a: ni.get(e.a)!, b: ni.get(e.b)!, type: e.type, bridge: e.bridge, tunnel: e.tunnel, level: e.level, day: e.day, drive: e.drive, exit: e.exit, heat: e.heat,
      ring: e.ring ? ri.get(e.ring) : undefined,
    })),
    rings: g.graph.rings.map(r => ({ x: r.hub.x, y: r.hub.y, size: r.hub.ring, day: r.hub.controlDay, nodes: r.nodes.map(v => ni.get(v)!) })),
    reports: g.reports.map(r => ({ ...r, from: bi.get(r.from)!, to: bi.get(r.to)! })),
    metrics: g.metrics,
  };
  return JSON.stringify(data, replace);
}

// Throws on JSON that is not a save of this version
export function deserialize(json: string): Game {
  const d = JSON.parse(json, revive) as SaveData;
  if (d?.v !== 1) throw new Error('Unknown save version');
  const g = new Game(d.cfg), graph = g.graph = new RoadGraph();
  const B = g.buildings = d.buildings.map(x => {
    const b = new Building(x.kind, x.x, x.y, x.angle);
    Object.assign(b, { residents: x.residents, stock: x.stock, staffed: x.staffed, shopAcc: x.shopAcc, truckAcc: x.truckAcc, happy: x.happy, parts: x.parts, recent: x.recent });
    b.importAcc = x.importAcc ?? 0;
    b.visitAcc = x.visitAcc ?? 0;
    Object.assign(b, { tier: x.tier ?? 0, abandoned: x.abandoned ?? false, access: x.access ?? 0.7, downH: x.downH ?? 0, upH: x.upH ?? 0 });
    return b;
  });
  g.lots = (d.lots ?? []).map(({ b, ...l }) => {
    const lot = { ...l, building: b < 0 ? null : B[b] };
    lot.building?.lots.push(lot);
    return lot;
  });
  const C = g.commuters = d.commuters.map(c => ({ ...c, home: B[c.home], work: c.work < 0 ? null : B[c.work] }));
  const trip = (t: TripData): Trip => ({ ...t, from: B[t.from], to: B[t.to], who: t.who < 0 ? null : C[t.who], jam: null });
  d.buildings.forEach((x, i) => { B[i].pending = x.pending.map(trip); B[i].parked = x.parked.map(trip); });
  const N = d.nodes.map(({ x, y, b, ...n }) => Object.assign(graph.addNode(x, y, b < 0 ? null : B[b]), n));
  const R = (d.rings ?? []).map(x => {
    const hub = Object.assign(graph.node(x.x, x.y), { control: 'roundabout', ring: x.size, controlDay: x.day } as const), r = { hub, nodes: x.nodes.map(i => N[i]) };
    graph.rings.push(r);
    return r;
  });
  for (const e of d.edges) graph.addEdge(N[e.a], N[e.b], { ...e, ring: e.ring === undefined ? null : R[e.ring] }, e.day).heat = e.heat;
  // an older save's roundabout is one node: rebuilt as a ring of its size, a smaller one where an arm is too short, else a plain junction
  for (const n of graph.nodes.filter(x => x.control === 'roundabout')) {
    n.control = 'none';
    n.plan = null;
    for (let s = n.ring; s >= 0 && !graph.buildRing(n, s as RingSize, n.controlDay); s--);
  }
  g.reports = d.reports.map(r => ({ ...r, from: B[r.from], to: B[r.to] }));
  Object.assign(g.metrics, d.metrics);
  const { time, lastHour, assignAt, money, score, upkeepDay, cityLevel, happiness, cityParts, debtDays, sadDays, stats, ledger, roadType } = d;
  Object.assign(g, { time, lastHour, assignAt, money, score, upkeepDay, cityLevel, happiness, cityParts, debtDays, sadDays, stats, roadType });
  g.loan = d.loan ?? 0;
  if (d.spawnAcc) g.spawnAcc = d.spawnAcc;
  if (!d.lots) adoptLots(g);
  g.demand = demandOf(g);
  g.ledger = { today: { ...ledger0(), ...ledger.today }, yesterday: { ...ledger0(), ...ledger.yesterday } };
  // ponytail: the exits of an older save go down over whatever the player built there
  if (d.buildings.some(x => x.importAcc === undefined)) g.addExits();
  return g;
}

// ---- localStorage: the autosave (every midnight and on quitting to the menu) and three slots ----
export const AUTO = 'tm_save_auto';
export const SLOTS = ['tm_save_1', 'tm_save_2', 'tm_save_3'];
export interface SaveInfo { day: number; pop: number; level: number; cfg: GameConfig }

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };

// false when storage is full or blocked
export function store(key: string, g: Game): boolean {
  try { localStorage.setItem(key, serialize(g)); return true; } catch { return false; }
}

export function load(key: string): Game | null {
  const s = read(key);
  try { return s ? deserialize(s) : null; } catch { return null; }
}

// Slot summary; null = empty, 'bad' = unreadable or from another version
export function peek(key: string): SaveInfo | 'bad' | null {
  const s = read(key);
  if (!s) return null;
  try {
    const d = JSON.parse(s, revive) as SaveData;
    const c = d.cfg;
    if (d.v !== 1 || !(c.biome in BIOMES && c.difficulty in DIFFICULTY && c.size in SIZES && (c.mode === 'career' || c.mode === 'creative'))) return 'bad';
    return { day: Math.floor((d.time / HOUR + T.START_HOUR) / 24) + 1, pop: d.buildings.reduce((n, b) => n + b.residents, 0), level: d.cityLevel, cfg: d.cfg };
  } catch { return 'bad'; }
}
