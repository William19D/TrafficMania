// Traffic events (game-v3 8): short timed events with a warning, an effect on the roads and a quest reward. Rolled on the hour
// (eventsHour), run every tick (eventsTick); the graph's shut / slow / wet are rebuilt from them each tick.
import type { Game } from './Game.ts';
import { HOUR, fmtMoney } from './Game.ts';
import { DIFFICULTY } from './config.ts';
import type { Building } from '../entities/Building.ts';
import type { Edge } from '../network/RoadGraph.ts';
import type { Vec } from '../util/geom.ts';
import { findPath } from '../network/Pathfinder.ts';
import { random } from '../util/rng.ts';

export type EventKind = 'roadworks' | 'accident' | 'rain' | 'vip';
// at: the effect starts (after the warning); end: it stops; base: [smooth, arrived] trips when it started (null while warning);
// n / ok: VIP cars arrived / arrived fast, an accident's queue cleared (ok = 1)
export interface ActiveEvent {
  kind: EventKind; at: number; end: number; edge: Edge | null; to: Building | null; from: Building | null;
  base: [number, number] | null; n: number; ok: number;
}
// warn / dur in hours, reward in $ (x the difficulty's tax), every: days between two of this kind
export const EVENTS: Record<EventKind, { name: string; warn: number; dur: number; reward: number; every: number; quest: string }> = {
  roadworks: { name: 'Roadworks', warn: 1, dur: 6, reward: 1500, every: 0, quest: 'The road closes both ways. Keep 70% of trips smooth while it is shut' },
  accident: { name: 'Accident', warn: 0, dur: 2, reward: 800, every: 0, quest: 'Traffic crawls past the wreck. Get the queue under 3 cars before it clears' },
  rain: { name: 'Rain', warn: 1, dur: 4, reward: 1000, every: 2, quest: 'Everyone drives slower. Keep 70% of trips smooth through the storm' },
  vip: { name: 'VIP convoy', warn: 1, dur: 3, reward: 3000, every: 3, quest: 'Three cars head in from the highway. All must arrive within 1.5x the free-flow time' },
};
export const EVENT_P = 0.06, EVENT_GAP = 4, SMOOTH_Q = 0.7, VIP_X = 1.5, RAIN_V = 0.8, WRECK_V = 0.35;

const stopped = (e: Edge): number => e.lanes.reduce((n, l) => n + l.cars.reduce((k, c) => k + +(c.speed < 1), 0), 0);
// closing e leaves a way round in every direction it is driven
const detour = (g: Game, e: Edge): boolean =>
  [[e.a, e.b], [e.b, e.a]].every(([p, q]) => !g.graph.lanesFrom(e, p).length || !!findPath(g.graph, p, q, e, true));

// Where an event happens (its road's middle, its target), null for rain
export const where = (ev: ActiveEvent): Vec | null => ev.edge ? { x: (ev.edge.a.x + ev.edge.b.x) / 2, y: (ev.edge.a.y + ev.edge.b.y) / 2 } : ev.to;
export const eventsOn = (g: Game): boolean => !g.tutorialActive && !g.demandOff && (!g.creative || g.cfg.events === 'on');

export function startEvent(g: Game, kind: EventKind, edge: Edge | null = null, to: Building | null = null, from: Building | null = null): ActiveEvent {
  const d = EVENTS[kind], at = g.time + d.warn * HOUR;
  const ev: ActiveEvent = { kind, at, end: at + d.dur * HOUR, edge, to, from, base: null, n: 0, ok: 0 };
  g.events.push(ev);
  g.eventLast[kind] = g.time;
  g.note(d.warn ? `${d.name} in 1 hour: ${d.quest.split('. ')[0].toLowerCase()}` : `${d.name}! ${d.quest.split('. ')[0]}`, where(ev));
  return ev;
}

// On the hour: from day 2, 07:00-21:00, at most one start per EVENT_GAP hours and 1 active (2 from 2,000 people), EVENT_P a roll
// (x1.5 in Challenge); the first eligible kind in a random order starts
export function eventsHour(g: Game, h: number): void {
  if (!eventsOn(g) || g.day < 2 || h < 7 || h > 21 || g.time < g.nextEventAt) return;
  if (g.events.length >= (g.population >= 2000 ? 2 : 1) || random() >= EVENT_P * (g.challenge ? 1.5 : 1)) return;
  const busy = new Set(g.events.map(e => e.edge)), roads = g.graph.edges.filter(e => !e.drive && !e.exit && !e.ring && !busy.has(e));
  const due = (k: EventKind): boolean => g.time - (g.eventLast[k] ?? -Infinity) >= EVENTS[k].every * 24 * HOUR;
  const pickOf = <T>(xs: T[]): T | null => xs.length ? xs[Math.floor(random() * xs.length)] : null;
  const kinds = (Object.keys(EVENTS) as EventKind[]).map(k => [random(), k] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  for (const k of kinds) {
    let ev: ActiveEvent | null = null;
    if (k === 'roadworks' && h >= 8 && h <= 15) {
      const e = pickOf(roads.filter(e => e.length >= 60 && e.heat > 0.3 && detour(g, e)));
      if (e) ev = startEvent(g, k, e);
    } else if (k === 'accident') {
      const e = pickOf(roads.filter(e => e.heat > 0.6 && stopped(e) >= 6));
      if (e) ev = startEvent(g, k, e);
    } else if (k === 'rain' && due(k)) ev = startEvent(g, k);
    else if (k === 'vip' && due(k) && g.population >= 1000) {
      const comp = g.components(), linked = g.linkedExits(comp);
      const to = pickOf(g.buildings.filter(b => b.connected && (b.special === 'stadium' || b.kind === 'office' && b.tier >= 2)
        && linked.some(x => comp.get(x.node) === comp.get(b.node))));
      if (to) ev = startEvent(g, k, null, to, pickOf(linked.filter(x => comp.get(x.node) === comp.get(to.node))));
    }
    if (ev) { g.nextEventAt = g.time + EVENT_GAP * HOUR; return; }
  }
}

const pay = (g: Game, x: number, why: string): void => {
  const m = x * DIFFICULTY[g.cfg.difficulty].tax;
  g.money += m;
  g.ledger.today.grants += m;
  g.note(`${why}: +${fmtMoney(m)}`);
};
const smooth = (g: Game, ev: ActiveEvent): number => {
  const a = g.stats.arrived - ev.base![1];
  return a ? (g.stats.smooth - ev.base![0]) / a : 1;
};

// Every tick: warnings turn live, quests are checked, events end (or are called off when their road is gone); then the graph's
// closures, slow edges and rain follow the live events
export function eventsTick(g: Game): void {
  const t = g.time, onRoad = (ev: ActiveEvent): boolean => ev.kind === 'roadworks' || ev.kind === 'accident';
  const edges = g.events.some(onRoad) ? new Set(g.graph.edges) : null;
  g.events = g.events.filter(ev => {
    const d = EVENTS[ev.kind];
    if (onRoad(ev) && !edges!.has(ev.edge!) || ev.kind === 'vip' && !(ev.to && g.buildings.includes(ev.to))) { g.note(`${d.name} called off`); return false; }
    if (!ev.base && t >= ev.at) {
      ev.base = [g.stats.smooth, g.stats.arrived];
      if (ev.kind === 'vip') for (let i = 0; i < 3; i++) if (ev.from) g.queueTrip(ev.from, ev.to!, 'visit').vip = true;
      if (ev.kind === 'roadworks') g.say('Roadworks: the road is closed');
    }
    if (!ev.base) return true;
    if (ev.kind === 'accident' && !ev.ok && t > ev.at + HOUR / 4 && stopped(ev.edge!) < 3) { ev.ok = 1; pay(g, d.reward, 'Accident queue cleared'); }
    if (ev.kind === 'vip' && ev.n >= 3) ev.end = t;
    if (t < ev.end) return true;
    if (ev.kind === 'vip') ev.ok >= 3 ? pay(g, d.reward, 'VIP convoy on time') : g.note(`VIP convoy: ${ev.ok} of 3 on time, no reward`);
    else if (ev.kind !== 'accident') {
      const s = smooth(g, ev);
      s >= SMOOTH_Q ? pay(g, d.reward, `${d.name} over, ${Math.round(s * 100)}% smooth`) : g.note(`${d.name} over: ${Math.round(s * 100)}% smooth, no reward`);
    } else if (!ev.ok) g.say('Accident cleared');
    return false;
  });
  const gr = g.graph;
  gr.shut.clear();
  gr.slow.clear();
  gr.wet = 1;
  for (const ev of g.events) {
    if (!ev.base) continue;
    if (ev.kind === 'roadworks') gr.shut.add(ev.edge!);
    else if (ev.kind === 'accident') gr.slow.set(ev.edge!, WRECK_V);
    else if (ev.kind === 'rain') gr.wet = RAIN_V;
  }
}

// A VIP car arrived after secs (ideal: its free-flow time)
export function vipArrived(g: Game, secs: number, ideal: number): void {
  const ev = g.events.find(e => e.kind === 'vip' && e.base);
  if (!ev) return;
  ev.n++;
  ev.ok += +(secs <= VIP_X * ideal);
}
