// Zones (docs/design/game-v3.md 2): lots painted along roads, RCI+O demand, buildings growing on lots by demand and traffic access,
// and abandoned under bad traffic. No dice anywhere: the same city grows the same way.
import type { Vec } from '../util/geom.ts';
import { dist, distToSegment } from '../util/geom.ts';
import type { Game } from './Game.ts';
import { fmtMoney } from './Game.ts';
import type { Edge, Node } from '../network/RoadGraph.ts';
import { NODE_R } from '../network/RoadGraph.ts';
import { DOOR_D, buildingAt } from '../entities/Building.ts';
import type { Building } from '../entities/Building.ts';
import { DIFFICULTY, TIER_DEFS, ZONE_NAME, TUNING as T } from './config.ts';
import type { Zone } from './config.ts';
import { unlockAt } from './Campaign.ts';
import { WORLD, inMountain, inWater } from '../world/MapGenerator.ts';

export const ZONE_LIST: Zone[] = ['home', 'shop', 'office', 'industry'];
// A lot: (x, y) the middle of its front edge (where the door goes), angle toward the road (as a building's), w px of frontage, LOT_D deep
export interface Lot { x: number; y: number; angle: number; w: number; zone: Zone; building: Building | null }
// Brush preview: lots to add, to re-zone (their buildings demolished) and to erase; cost < 0 is a refund
export interface ZonePlan {
  path: Vec[]; zone: Zone | null; add: Lot[]; rezone: Lot[]; erase: Lot[]; cost: number; ok: boolean; reason: string; label: string; demolish: number;
}
// Centre, angle along the depth h, w across
interface Rect { x: number; y: number; angle: number; w: number; h: number }

export const lotRect = (l: Lot): Rect => ({ x: l.x - Math.cos(l.angle) * T.LOT_D / 2, y: l.y - Math.sin(l.angle) * T.LOT_D / 2, angle: l.angle, w: l.w, h: T.LOT_D });
const rectOf = (b: Building): Rect => ({ x: b.x, y: b.y, angle: b.angle, w: b.w, h: b.h });
export const corners = (r: Rect): Vec[] => {
  const c = Math.cos(r.angle), s = Math.sin(r.angle), h = r.h / 2, w = r.w / 2;
  return [[h, w], [h, -w], [-h, -w], [-h, w]].map(([x, y]) => ({ x: r.x + x * c - y * s, y: r.y + x * s + y * c }));
};
const inRect = (r: Rect, p: Vec, pad = 0): boolean => {
  const dx = p.x - r.x, dy = p.y - r.y, c = Math.cos(r.angle), s = Math.sin(r.angle);
  return Math.abs(dx * c + dy * s) <= r.h / 2 + pad && Math.abs(dy * c - dx * s) <= r.w / 2 + pad;
};
// Separating axes: true when the rects overlap by more than 1px (side by side is fine)
const overlap = (a: Rect, b: Rect): boolean => {
  const ca = corners(a), cb = corners(b);
  for (const ang of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ux = Math.cos(ang), uy = Math.sin(ang), pa = ca.map(p => p.x * ux + p.y * uy), pb = cb.map(p => p.x * ux + p.y * uy);
    if (Math.max(...pa) - 1 <= Math.min(...pb) || Math.max(...pb) - 1 <= Math.min(...pa)) return false;
  }
  return true;
};

export const lotAt = (g: Game, p: Vec): Lot | null => g.lots.find(l => inRect(lotRect(l), p)) ?? null;

// The access road a door at p fronts: its edge within DRIVE_GAP + 4
// ponytail: scans every road per call (hourly per lot); a spatial grid if big cities stutter on the hour
export function frontage(g: Game, p: Vec, roads = g.accessEdges()): Edge | null {
  let best: Edge | null = null, bd = Infinity;
  for (const e of roads) {
    const d = distToSegment(p, e.a, e.b).d - e.width / 2;
    if (d < bd) { bd = d; best = e; }
  }
  return bd <= T.DRIVE_GAP + 4 ? best : null;
}
// A building's street: the road its door fronts, else the one its driveway joins
const roadOf = (g: Game, b: Building, roads: Edge[]): Edge | null =>
  frontage(g, b.node, roads) ?? b.node.edges.flatMap(d => (d.a === b.node ? d.b : d.a).edges.filter(x => !x.drive))[0] ?? null;
// Congestion along a street: the hottest of the road and the roads meeting it at either end
const heatAt = (e: Edge | null): number => e ? Math.max(e.heat, ...[e.a, e.b].flatMap(n => n.edges.filter(x => !x.drive).map(x => x.heat))) : 0;

// A road through the rect (driveways only where they cross it, not beside it), except the driveways of the buildings in own
const roadOver = (g: Game, r: Rect, own: Building[] = []): boolean => {
  const reach = Math.hypot(r.w, r.h) / 2;
  for (const e of g.graph.edges) {
    if (e.drive && own.some(b => e.a === b.node || e.b === b.node)) continue;
    const pad = e.drive ? 2 : e.width / 2;
    if (e.level || e.tunnel || distToSegment(r, e.a, e.b).d > reach + pad) continue;
    const n = Math.max(1, Math.ceil(e.length / 4));
    for (let i = 0; i <= n; i++) if (inRect(r, { x: e.a.x + (e.b.x - e.a.x) * i / n, y: e.a.y + (e.b.y - e.a.y) * i / n }, pad)) return true;
  }
  return false;
};

// A lot can go there: inside the map on dry land, clear of roads, buildings, the other lots, junctions and road ends (NODE_R + 8)
// and roundabouts
function free(g: Game, l: Lot, lots: Lot[]): boolean {
  const r = lotRect(l), pts = [...corners(r), r];
  if (pts.some(p => p.x < 4 || p.y < 4 || p.x > WORLD.w - 4 || p.y > WORLD.h - 4)) return false;
  if (pts.some(p => inWater(g.terrain, p) || inMountain(g.terrain, p) || g.graph.nearRing(p))) return false;
  if (g.graph.nodes.some(n => !n.building && n.edges.filter(e => !e.drive).length !== 2 && inRect(r, n, NODE_R + 8))) return false;
  if (g.buildings.some(b => overlap(r, rectOf(b))) || lots.some(o => overlap(r, lotRect(o)))) return false;
  return !roadOver(g, r);
}

// Lots whose road went (demolished, bent away) or that a new road runs through go; a lot with a building stays
export function pruneLots(g: Game): void {
  const roads = g.accessEdges();
  g.lots = g.lots.filter(l => l.building || (frontage(g, l, roads) && !roadOver(g, lotRect(l))));
}

// Old saves and the starter town: each building gets one lot of its zone under it, as wide as it is (it stays legacy, tier 0, until cleared)
export function adoptLots(g: Game): void {
  for (const b of g.buildings) {
    if (b.kind === 'gate' || b.lots.length) continue;
    const d = b.door(), l: Lot = { x: d.x, y: d.y, angle: b.angle, w: Math.max(T.LOT_W, b.w + 4), zone: b.kind, building: b };
    b.lots = [l];
    g.lots.push(l);
  }
}

// ---- Brush ----

// The network path from the access road at 'from' (within BRUSH_R) to the one nearest 'to' (else along the first road), up to BRUSH_MAX
// px: segments along the road centres with each road's width. Null when no road is under the press.
function brushPath(g: Game, from: Vec, to: Vec): { a: Vec; b: Vec; w: number }[] | null {
  const roads = g.accessEdges();
  const near = (p: Vec, r: number) => {
    let best: { e: Edge; point: Vec; t: number; d: number } | null = null;
    for (const e of roads) { const h = distToSegment(p, e.a, e.b); if (h.d <= r && (!best || h.d < best.d)) best = { e, ...h }; }
    return best;
  };
  const h0 = near(from, T.BRUSH_R);
  if (!h0) return null;
  const e0 = h0.e, h1 = near(to, 3 * T.BRUSH_R) ?? { e: e0, ...distToSegment(to, e0.a, e0.b) };
  if (h1.e === e0) return [{ a: h0.point, b: h1.point, w: e0.width }];
  // Dijkstra from both ends of e0 over the access roads
  const ok = new Set(roads), d = new Map<Node, number>(), via = new Map<Node, Edge>(), open: Node[] = [e0.a, e0.b];
  d.set(e0.a, dist(h0.point, e0.a));
  d.set(e0.b, dist(h0.point, e0.b));
  while (open.length) {
    let i = 0;
    for (let k = 1; k < open.length; k++) if (d.get(open[k])! < d.get(open[i])!) i = k;
    const n = open.splice(i, 1)[0], dn = d.get(n)!;
    if (dn > T.BRUSH_MAX) break;
    for (const e of n.edges) {
      const o = e.a === n ? e.b : e.a, nd = dn + e.length;
      if (!ok.has(e) || e === e0 || nd >= (d.get(o) ?? Infinity)) continue;
      if (!d.has(o)) open.push(o);
      d.set(o, nd);
      via.set(o, e);
    }
  }
  const m = [h1.e.a, h1.e.b].filter(n => d.has(n) && d.get(n)! <= T.BRUSH_MAX).sort((p, q) => d.get(p)! + dist(p, h1.point) - d.get(q)! - dist(q, h1.point))[0];
  if (!m) return [{ a: h0.point, b: distToSegment(to, e0.a, e0.b).point, w: e0.width }];
  const segs: { a: Vec; b: Vec; w: number }[] = [{ a: m, b: h1.point, w: h1.e.width }];
  let n = m;
  for (let e = via.get(n); e; e = via.get(n)) {
    const o = e.a === n ? e.b : e.a;
    segs.unshift({ a: o, b: n, w: e.width });
    n = o;
  }
  segs.unshift({ a: h0.point, b: n, w: e0.width });
  return segs.filter(s => dist(s.a, s.b) > 0.5);
}

// Lots LOT_W apart along the path (centred on it), on side 1 (left of travel), -1 or both, their front DRIVE_GAP past the road's edge
function cut(segs: { a: Vec; b: Vec; w: number }[], sides: (1 | -1)[], zone: Zone): Lot[] {
  const len = segs.reduce((n, s) => n + dist(s.a, s.b), 0), count = Math.floor(len / T.LOT_W), out: Lot[] = [];
  let at = (len - count * T.LOT_W) / 2 + T.LOT_W / 2, i = 0, s0 = 0;
  for (let k = 0; k < count; k++, at += T.LOT_W) {
    while (i < segs.length - 1 && s0 + dist(segs[i].a, segs[i].b) < at) s0 += dist(segs[i].a, segs[i++].b);
    const { a, b, w } = segs[i], L = dist(a, b), tx = (b.x - a.x) / L, ty = (b.y - a.y) / L, u = Math.min(L, at - s0);
    for (const k2 of sides) {
      const nx = -ty * k2, ny = tx * k2, off = w / 2 + T.DRIVE_GAP;
      out.push({ x: a.x + tx * u + nx * off, y: a.y + ty * u + ny * off, angle: Math.atan2(-ny, -nx), w: T.LOT_W, zone, building: null });
    }
  }
  return out;
}

// Brush from the press point to the cursor: zone null = Unzone. A drag that starts on a lot of the held zone (or Unzone) erases lots
// along the path; otherwise it paints the free spots, re-zones lots of another zone it covers (their buildings are demolished), and skips
// lots of the held zone. oneSide: only the side the cursor is on. Null when no road is under the press.
export function planZone(g: Game, from: Vec, to: Vec, zone: Zone | null, oneSide = false): ZonePlan | null {
  const segs = brushPath(g, from, to);
  if (!segs?.length) return null;
  const last = segs[segs.length - 1], L = dist(last.a, last.b) || 1;
  const side: 1 | -1 = (to.x - last.b.x) * -(last.b.y - last.a.y) / L + (to.y - last.b.y) * (last.b.x - last.a.x) / L >= 0 ? 1 : -1;
  const cand = cut(segs, oneSide ? [side] : [1, -1], zone ?? 'home'), start = lotAt(g, from);
  const plan: ZonePlan = { path: [segs[0].a, ...segs.map(s => s.b)], zone, add: [], rezone: [], erase: [], cost: 0, ok: false, reason: '', label: '', demolish: 0 };
  const covered = (c: Lot): Lot[] => g.lots.filter(l => overlap(lotRect(c), lotRect(l)));
  if (!zone || start?.zone === zone) {
    plan.erase = [...new Set(cand.flatMap(covered))].filter(l => !zone || l.zone === zone);
    plan.cost = -plan.erase.reduce((n, l) => n + (l.building || g.creative || g.has('zoning') ? 0 : T.ZONE_COST[l.zone]), 0);
  } else {
    for (const c of cand) {
      const on = covered(c);
      if (on.some(l => l.zone !== zone)) plan.rezone.push(...on.filter(l => l.zone !== zone && !plan.rezone.includes(l)));
      else if (!on.length && free(g, c, plan.add)) plan.add.push(c);
    }
    plan.cost = g.creative || g.has('zoning') ? 0 : (plan.add.length + plan.rezone.length) * T.ZONE_COST[zone];
  }
  const doomed = [...plan.rezone, ...plan.erase].filter(l => l.building);
  plan.demolish = doomed.length;
  const n = plan.add.length + plan.rezone.length + plan.erase.length;
  plan.reason = !n ? 'No room for lots here' : plan.cost > 0 && g.frozen ? 'The bank froze the city: earn money to grow again' : plan.cost > g.money ? 'Not enough money' : '';
  plan.ok = !plan.reason;
  const wreck = plan.demolish ? ` · demolishes ${plan.demolish} building${plan.demolish > 1 ? 's' : ''}` : '';
  if (plan.erase.length) plan.label = `−${plan.erase.length} lot${plan.erase.length > 1 ? 's' : ''}${plan.cost ? ` · +${fmtMoney(-plan.cost)}` : ''}${wreck}`;
  else if (zone) {
    const d0 = demandOf(g)[zone], d1 = demandOf(g, { [zone]: plan.add.length + plan.rezone.length })[zone];
    plan.label = `+${plan.add.length} lot${plan.add.length === 1 ? '' : 's'}${plan.rezone.length ? ` · ${plan.rezone.length} re-zoned` : ''} · ${fmtMoney(plan.cost)}`
      + ` · ${ZONE_NAME[zone]} demand ${d0.toFixed(1)} → ${d1.toFixed(1)}${wreck}`;
  }
  return plan;
}

export function commitZone(g: Game, plan: ZonePlan): boolean {
  if (!plan.ok) { g.say(plan.reason); return false; }
  for (const l of [...plan.rezone, ...plan.erase]) if (l.building) g.demolishBuilding(l.building);
  for (const l of plan.rezone) l.zone = plan.zone!;
  const gone = new Set(plan.erase);
  g.lots = [...g.lots.filter(l => !gone.has(l)), ...plan.add];
  g.spend(plan.cost, false);
  if (plan.add.length > (g.feats.paint ?? 0)) g.feat('paint', plan.add.length);
  return true;
}

// ---- Demand, access, growth ----

// RCI+O demand, each -1..1 (docs 2): homes at least 0.5 under 100 residents; extra: lots about to be zoned, counted at their tier-1
// capacity (the brush preview)
export function demandOf(g: Game, extra: Partial<Record<Zone, number>> = {}): Record<Zone, number> {
  const linked = g.linkedExits().length, add = (z: Zone): number => (extra[z] ?? 0) * (TIER_DEFS[z][0].residents + TIER_DEFS[z][0].jobs);
  let res = add('home'), jobs = add('shop') + add('office') + add('industry'), shop = add('shop'), ind = add('industry'), visits = 0;
  for (const b of g.buildings) {
    if (b.kind === 'gate' || b.abandoned) continue;
    res += b.residents;
    jobs += b.jobs;
    if (b.kind === 'shop') shop += b.jobs;
    if (b.kind === 'industry') ind += b.jobs;
    if (linked) visits += b.def.visits;
  }
  const c = (x: number): number => Math.max(-1, Math.min(1, x));
  const workers = res * T.EMPLOY_RATE, unemp = workers - jobs, shopNeed = res / 12 + visits / 4, indNeed = shop * 0.6 + 10 * linked;
  return {
    home: Math.max(res < 100 ? 0.5 : -1, c(-unemp / Math.max(60, workers) + 0.2)),
    shop: c((shopNeed - shop) / Math.max(10, shopNeed)),
    industry: c((indNeed - ind) / Math.max(15, indNeed)),
    office: c((unemp - Math.max(0, shopNeed - shop) - Math.max(0, indNeed - ind)) / Math.max(60, workers)),
  };
}

interface Access { a: number; trips: number; heat: number; reach: number }
const mean = (b: Building): number | null => b.recent.length ? b.recent.reduce((n, r) => n + r.score, 0) / b.recent.length : null;

// A = A_TRIPS trips + A_HEAT (1 - heat) + A_REACH reach. trips: the mean SCORE of its last 24h trips, else that of the buildings with
// trips within NEAR_R, else 0.7; heat: its street's (heatAt); reach: a home's workplace and shop in reach (half each), a workplace's staff
// (an empty workplace lot: a home in reach)
function access(g: Game, p: Vec, zone: Zone, b: Building | null, road: Edge | null, kinds: Set<string> | undefined): Access {
  let trips = b ? mean(b) : null;
  if (trips === null) {
    const near = g.buildings.map(o => o.kind !== 'gate' && dist(o, p) < T.NEAR_R ? mean(o) : null).filter((x): x is number => x !== null);
    trips = near.length ? near.reduce((n, x) => n + x, 0) / near.length : 0.7;
  }
  const heat = heatAt(road), has = (k: string): number => +!!kinds?.has(k);
  const reach = zone === 'home' ? 0.5 * has('job') + 0.5 * has('shop') : b && !b.abandoned ? b.staffed : has('home');
  return { a: T.A_TRIPS * trips + T.A_HEAT * (1 - heat) + T.A_REACH * reach, trips, heat, reach };
}

// The weakest part of a building's access (or of a home's happiness), and where to fix it: the longest stop of its recent trips, or its street
function causeOf(g: Game, b: Building, x: Access, road: Edge | null): Building['cause'] {
  const mine = g.reports.filter(r => r.from === b || r.to === b), worst = mine.reduce<typeof mine[0] | null>((w, r) => r.jam && (!w || r.jamS > w.jamS) ? r : w, null);
  const at = worst?.jam ?? null, street = road ? { x: (road.a.x + road.b.x) / 2, y: (road.a.y + road.b.y) / 2 } : null;
  const ratio = mine.length ? mine.reduce((n, r) => n + r.ratio, 0) / mine.length : 0;
  const trips = mine.some(r => r.outcome === 'gaveup') ? 'Drivers give up on the way' : ratio > 1.2 ? `Trips take ${ratio.toFixed(1)}x longer than on empty roads` : 'Trips go badly';
  const reach = b.kind === 'home' ? (x.reach < 0.5 || !b.parts.job ? 'No job within reach' : 'No shop within reach') : 'Not enough workers';
  if (b.kind === 'home' && !b.abandoned && x.a >= T.DOWN_A) {
    const p = b.parts;
    if (p.noise > 0.4) return { text: 'Noise from a busy road', at: street };
    if (p.pollution > 0.3) return { text: 'Pollution from factories nearby', at: null };
    if (p.job < 0.5) return { text: 'No job within reach', at: null };
    if (p.shop < 0.5) return { text: 'No shop within reach', at: null };
    return { text: trips, at };
  }
  const parts: [number, Building['cause']][] = [
    [T.A_TRIPS * (1 - x.trips), { text: trips, at }],
    [T.A_HEAT * x.heat, { text: 'Jam on its street', at: street }],
    [T.A_REACH * (1 - x.reach), { text: reach, at: null }],
  ];
  return parts.sort((p, q) => q[0] - p[0])[0][1];
}

// Grows a tier-1 building of the lot's zone on it (a home moves in PLACED_OCC full)
export function grow(g: Game, l: Lot): Building {
  const b = buildingAt(l.zone, l, l.angle, 1);
  b.lots = [l];
  l.building = b;
  if (l.zone === 'home') b.residents = b.cap * T.PLACED_OCC;
  return g.addBuilding(b);
}

// ---- Tiers (game-v3 3) ----

// Along the frontage of a lot facing angle a
const tangent = (a: number): Vec => ({ x: -Math.sin(a), y: Math.cos(a) });
// b's lots in frontage order
const chain = (b: Building): Lot[] => {
  const t = tangent(b.lots[0].angle);
  return [...b.lots].sort((p, q) => (p.x - q.x) * t.x + (p.y - q.y) * t.y);
};
// The lot right next to l along its frontage on side k (same angle, front edges in line, sides touching), else null
function beside(g: Game, l: Lot, k: 1 | -1): Lot | null {
  const t = tangent(l.angle);
  return g.lots.find(o => {
    if (o === l || Math.abs(Math.sin(o.angle - l.angle)) > 0.05 || Math.cos(o.angle - l.angle) < 0) return false;
    const dx = o.x - l.x, dy = o.y - l.y;
    return Math.abs(dx * Math.cos(l.angle) + dy * Math.sin(l.angle)) < 2 && Math.abs(dx * t.x + dy * t.y - k * (l.w + o.w) / 2) < 2;
  }) ?? null;
}
// Door point and angle of a building standing on these lots (in frontage order): the middle of their front
const front = (lots: Lot[]): { p: Vec; angle: number } => {
  const a = lots[0], z = lots[lots.length - 1], t = tangent(a.angle);
  return { p: { x: (a.x - t.x * a.w / 2 + z.x + t.x * z.w / 2) / 2, y: (a.y - t.y * a.w / 2 + z.y + t.y * z.w / 2) / 2 }, angle: a.angle };
};

// The lots b grows onto for its next tier (n lots in all): its own plus the next ones along the same frontage and side, each empty or
// under a tier-1 building of its zone (which merges in), the far side first; the footprint must stay clear of other buildings and roads.
// Null when they are not free.
function nextLots(g: Game, b: Building, n: number): Lot[] | null {
  const own = chain(b), need = n - own.length;
  const ok = (l: Lot | null): l is Lot => !!l && l.zone === b.kind && (!l.building || (l.building.tier === 1 && !l.building.special));
  const run = (k: 1 | -1): Lot[] => {
    const out: Lot[] = [];
    for (let l = k > 0 ? own[own.length - 1] : own[0], o = beside(g, l, k); out.length < need && ok(o); l = o, o = beside(g, l, k)) out.push(o);
    return out;
  };
  const up = run(1), down = run(-1), test = buildingAt(b.kind, { x: 0, y: 0 }, 0, b.tier + 1);
  for (let k = Math.min(need, up.length); k >= 0; k--) {
    if (need - k > down.length) continue;
    const lots = [...down.slice(0, need - k).reverse(), ...own, ...up.slice(0, k)], f = front(lots), d = test.h / 2 + DOOR_D;
    const r: Rect = { x: f.p.x - Math.cos(f.angle) * d, y: f.p.y - Math.sin(f.angle) * d, angle: f.angle, w: test.w, h: test.h };
    const merged = [b, ...lots.map(l => l.building).filter((x): x is Building => !!x)];
    if (g.buildings.some(o => !merged.includes(o) && overlap(r, rectOf(o))) || roadOver(g, r, merged)) continue;
    return lots;
  }
  return null;
}

// Puts b on these lots (frontage order) at its current tier's footprint, its door at the middle of their front
function seat(g: Game, b: Building, lots: Lot[]): void {
  for (const l of b.lots) if (!lots.includes(l)) l.building = null;
  b.lots = lots;
  for (const l of lots) l.building = b;
  const f = front(lots), at = buildingAt(b.kind, f.p, f.angle, b.tier);
  g.rehome(b, at.x, at.y, f.angle);
}

// Why b does not count toward its next tier this hour ('' = it does): the top tier, a locked one, low access, no demand, not full or
// happy enough (homes), short-staffed (workplaces). Legacy buildings, specials and abandoned ones never upgrade.
export function upgradeBlock(g: Game, b: Building): string {
  if (!b.tier || !b.lots.length || b.special || b.abandoned || b.kind === 'gate') return 'Never';
  const next = TIER_DEFS[b.kind][b.tier];
  if (!next) return 'Top tier';
  if (!g.unlocked(next.level)) return `${next.name} unlocks on ${unlockAt(next.level)}`;
  if (b.access < T.UP_A) return `Traffic access under ${Math.round(T.UP_A * 100)}%`;
  if (g.demand[b.kind] <= T.UP_D) return `Low ${ZONE_NAME[b.kind]} demand`;
  if (b.kind === 'home') return b.residents < T.UP_FULL * b.cap ? `Under ${Math.round(T.UP_FULL * 100)}% full` : b.happy < T.UP_HAPPY ? `Under ${T.UP_HAPPY}% happy` : '';
  return b.staffed < T.UP_STAFF ? `Under ${Math.round(T.UP_STAFF * 100)}% staffed` : '';
}

// One tier up onto lots (from nextLots): the tier-1 buildings on them go, their residents moving in
function upgrade(g: Game, b: Building, lots: Lot[]): void {
  let moved = 0;
  for (const l of lots) if (l.building && l.building !== b) { moved += l.building.residents; g.demolishBuilding(l.building); }
  g.sfx.delete('demolish');
  b.tier++;
  seat(g, b, lots);
  b.residents = Math.min(b.cap, b.residents + moved);
  b.upH = 0;
  g.sfx.add('place');
}

// One tier down: it keeps the first lots of its frontage the lower tier needs (the rest go back to empty) and the residents that fit;
// workers over its jobs lose them
function downgrade(g: Game, b: Building): void {
  const from = b.label;
  b.tier--;
  seat(g, b, chain(b).slice(0, TIER_DEFS[b.kind as Zone][b.tier - 1].lots));
  b.residents = Math.min(b.residents, b.cap);
  let slots = Math.floor(b.jobs / T.PEOPLE_PER_CAR);
  for (const c of g.commuters) if (c.work === b && --slots < 0) c.work = null;
  g.say(`${from} shrank to ${b.label}: ${b.cause?.text ?? 'bad traffic'}`);
}

// On the hour: each building's access, its abandon / clear / recover countdowns; then each zone's demand spawns buildings on the empty lots
// with the best access (ties to the one nearest the town's centre). Lots off the town's roads, or under SPAWN_A, never spawn.
// Unconnected buildings keep no countdown (their people move out by the happiness rule). Specials only get their access.
// Upgrades: UPGRADE_H hours in a row with nothing in the way (upgradeBlock) grow a building a tier as soon as the next lots are free.
// Downgrades: a building above tier 1 drops a tier after DOWN_H bad hours (and counts again) instead of being abandoned.
export function zoneHour(g: Game, comp: Map<Node, number>): void {
  const cut = g.time - T.DAY_SECONDS, roads = g.accessEdges(), kinds = new Map<number, Set<string>>();
  for (const b of g.buildings) {
    while (b.recent.length && b.recent[0].at <= cut) b.recent.shift();
    if (b.abandoned) continue;
    const k = kinds.get(comp.get(b.node)!) ?? new Set<string>();
    k.add(b.kind === 'gate' ? 'gate' : b.kind === 'home' ? 'home' : 'job');
    if (b.kind === 'shop') k.add('shop');
    kinds.set(comp.get(b.node)!, k);
  }
  for (const b of [...g.buildings]) {
    if (b.kind === 'gate') continue;
    const road = roadOf(g, b, roads), x = access(g, b.node, b.kind, b, road, kinds.get(comp.get(b.node)!));
    b.access = x.a;
    if (!b.connected || b.special) { b.downH = b.upH = 0; b.cause = null; continue; }
    const bad = x.a < T.DOWN_A || (b.kind === 'home' && !b.abandoned && b.happy < T.GROW_LO);
    b.downH = bad ? b.downH + 1 : 0;
    b.cause = b.downH ? causeOf(g, b, x, road) : null;
    if (b.abandoned) {
      b.upH = x.a >= T.RECOVER_A ? b.upH + 1 : 0;
      if (b.upH >= T.RECOVER_H) {
        b.abandoned = false;
        b.upH = b.downH = 0;
        if (b.kind === 'home') b.residents = b.cap * T.PLACED_OCC;
        g.changed();
      } else if (b.downH >= T.DOWN_H) g.demolishBuilding(b);
    } else if (b.downH >= T.DOWN_H && b.tier > 1) {
      downgrade(g, b);
      b.downH = b.upH = 0;
    } else if (b.downH >= T.DOWN_H) {
      g.say(`${b.label} abandoned: ${b.cause!.text}`);
      b.abandoned = true;
      b.residents = b.staffed = b.downH = 0;
      for (const c of g.commuters) if (c.work === b) c.work = null;
      g.commuters = g.commuters.filter(c => c.home !== b || c.at !== 'home');
      g.changed();
    }
  }
  g.demand = demandOf(g);
  if (g.frozen) return;
  for (const b of [...g.buildings]) {
    if (b.abandoned || !g.buildings.includes(b)) continue;
    b.upH = upgradeBlock(g, b) ? 0 : Math.min(T.UPGRADE_H, b.upH + 1);
    const lots = b.upH >= T.UPGRADE_H ? nextLots(g, b, TIER_DEFS[b.kind as Zone][b.tier].lots) : null;
    if (lots) upgrade(g, b, lots);
  }
  const town = g.buildings.filter(b => b.kind !== 'gate'), cx = town.reduce((n, b) => n + b.x, 0) / (town.length || 1), cy = town.reduce((n, b) => n + b.y, 0) / (town.length || 1);
  let grew = false;
  for (const z of ZONE_LIST) {
    g.spawnAcc[z] += Math.max(0, g.demand[z]) * T.SPAWN_RATE * DIFFICULTY[g.cfg.difficulty].growth * (g.has('zoning') ? 1.25 : 1);
    while (g.spawnAcc[z] >= 1) {
      let best: Lot | null = null, ba: number = T.SPAWN_A, bd = Infinity;
      for (const l of g.lots) {
        if (l.zone !== z || l.building) continue;
        const road = frontage(g, l, roads), k = road && kinds.get(comp.get(road.a)!);
        if (!k) continue;
        const a = access(g, l, z, null, road, k).a, d = Math.hypot(l.x - cx, l.y - cy);
        if (a > ba + 1e-9 || (a > ba - 1e-9 && d < bd)) { best = l; ba = a; bd = d; }
      }
      if (!best) { g.spawnAcc[z] = Math.min(g.spawnAcc[z], 1); break; }
      grow(g, best);
      grew = true;
      g.spawnAcc[z]--;
    }
  }
  if (grew) g.connect();
}
