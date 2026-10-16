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

type Ref = number;
type TripData = Omit<Trip, 'from' | 'to' | 'who' | 'jam'> & { from: Ref; to: Ref; who: Ref };
interface BuildingData {
  kind: Site; x: number; y: number; angle: number; residents: number; stock: number; staffed: number; shopAcc: number; truckAcc: number;
  importAcc?: number; visitAcc?: number; // absent before outside connections
  happy: number; parts: Parts; recent: Building['recent']; pending: TripData[]; parked: TripData[];
}
export interface SaveData {
  v: 1; cfg: GameConfig; time: number; lastHour: number; assignAt: number; money: number; score: number; upkeepDay: number;
  cityLevel: number; tray: Record<Zone, number>; happiness: number; cityParts: Parts; debtDays: number; sadDays: number;
  stats: Game['stats']; ledger: { today: Ledger; yesterday: Ledger }; roadType: RoadType;
  buildings: BuildingData[];
  commuters: (Omit<Commuter, 'home' | 'work'> & { home: Ref; work: Ref })[];
  nodes: { x: number; y: number; b: Ref; control: Control; controlDay: number; phase: number; phaseTimer: number; plan: JunctionPlan | null; delay: number; ring?: RingSize }[];
  edges: { a: Ref; b: Ref; type: RoadType; bridge: boolean; tunnel: boolean; level: number; day: number; drive: boolean; exit?: boolean; heat: number }[];
  reports: (Omit<TripReport, 'from' | 'to'> & { from: Ref; to: Ref })[];
  metrics: Metrics;
}

// JSON has no Infinity (creative money and tray, an idle assignAt); a seed is the one free-text string
const replace = (_: string, v: unknown): unknown => v === Infinity ? 'Infinity' : v;
const revive = (k: string, v: unknown): unknown => v === 'Infinity' && k !== 'seed' ? Infinity : v;

export function serialize(g: Game): string {
  const bi = new Map(g.buildings.map((b, i) => [b, i])), ci = new Map(g.commuters.map((c, i) => [c, i]));
  const ni = new Map(g.graph.nodes.map((n, i) => [n, i]));
  const trip = (t: Trip, queued = t.queued): TripData => {
    const { jam: _, ...rest } = t;
    return { ...rest, queued, from: bi.get(t.from)!, to: bi.get(t.to)!, who: t.who ? ci.get(t.who)! : -1 };
  };
  const data: SaveData = {
    v: 1, cfg: g.cfg, time: g.time, lastHour: g.lastHour, assignAt: g.assignAt, money: g.money, score: g.score, upkeepDay: g.upkeepDay,
    cityLevel: g.cityLevel, tray: g.tray, happiness: g.happiness, cityParts: g.cityParts, debtDays: g.debtDays, sadDays: g.sadDays,
    stats: g.stats, ledger: g.ledger, roadType: g.roadType,
    buildings: g.buildings.map(b => ({
      kind: b.kind, x: b.x, y: b.y, angle: b.angle, residents: b.residents, stock: b.stock, staffed: b.staffed, shopAcc: b.shopAcc,
      truckAcc: b.truckAcc, importAcc: b.importAcc, visitAcc: b.visitAcc, happy: b.happy, parts: b.parts, recent: b.recent, parked: b.parked.map(t => trip(t)),
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
    })),
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
    return b;
  });
  const C = g.commuters = d.commuters.map(c => ({ ...c, home: B[c.home], work: c.work < 0 ? null : B[c.work] }));
  const trip = (t: TripData): Trip => ({ ...t, from: B[t.from], to: B[t.to], who: t.who < 0 ? null : C[t.who], jam: null });
  d.buildings.forEach((x, i) => { B[i].pending = x.pending.map(trip); B[i].parked = x.parked.map(trip); });
  const N = d.nodes.map(({ x, y, b, ...n }) => Object.assign(graph.addNode(x, y, b < 0 ? null : B[b]), n));
  for (const e of d.edges) graph.addEdge(N[e.a], N[e.b], e, e.day).heat = e.heat;
  g.reports = d.reports.map(r => ({ ...r, from: B[r.from], to: B[r.to] }));
  Object.assign(g.metrics, d.metrics);
  const { time, lastHour, assignAt, money, score, upkeepDay, cityLevel, tray, happiness, cityParts, debtDays, sadDays, stats, ledger, roadType } = d;
  Object.assign(g, { time, lastHour, assignAt, money, score, upkeepDay, cityLevel, tray, happiness, cityParts, debtDays, sadDays, stats, roadType });
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
