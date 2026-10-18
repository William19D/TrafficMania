import type { Edge, Node } from '../network/RoadGraph.ts';
import type { Building } from '../entities/Building.ts';
import type { Lot } from '../core/Zones.ts';
import { mulberry32 } from '../util/rng.ts';

// FNV-1a over numbers (to 1/8 px) and whole strings
function fnv(): { n: (v: number) => void; s: (s: string) => void; h: () => number } {
  let h = 2166136261;
  const n = (v: number): void => { h = Math.imul(h ^ Math.round(v * 8), 16777619); };
  return { n, s: str => { n(str.length); for (let i = 0; i < str.length; i++) n(str.charCodeAt(i)); }, h: () => h >>> 0 };
}

// Signature of everything the cached road layer draws: geometry, tiers, lanes, flags, controls, ring sizes and junction plans' signs,
// lane connections and legacy bans (the lane arrows). Signal colours are drawn live.
export function netKey(edges: Edge[], nodes: Node[]): number {
  const { n: mix, s: word, h } = fnv();
  for (const e of edges) {
    mix(e.id); mix(e.a.x); mix(e.a.y); mix(e.b.x); mix(e.b.y); word(e.type.tier); mix(e.type.lanes); mix(e.level);
    mix(+e.type.oneWay | +e.bridge << 1 | +e.tunnel << 2 | +e.drive << 3);
  }
  for (const n of nodes) {
    mix(n.id); word(n.control); mix(n.ring); mix(+!!n.building);
    const p = n.plan;
    if (!p) continue;
    for (const s of p.signs ?? []) mix(s ?? 3);
    for (const m of p.lanes ?? []) { mix(m ? m.length : -1); for (const x of m ?? []) mix(x); }
    for (const b of p.ban) mix(+b[0] | +b[1] << 1 | +b[2] << 2);
  }
  return h();
}

// Signature of the cached lots and buildings: placement, model, abandoned, empty (a faded home, no lit windows), road access
export function sceneKey(buildings: Building[], lots: Lot[]): number {
  const { n, s, h } = fnv();
  for (const l of lots) { n(l.x); n(l.y); n(l.angle * 1e3); n(l.w); s(l.zone); n(+!!l.building); }
  for (const b of buildings) {
    n(b.x); n(b.y); n(b.angle * 1e3); s(b.art); n(b.w); n(b.h);
    n(+b.abandoned | +(b.kind === 'home' && b.residents < 1) << 1 | (b.node ? +b.connected : 2) << 2);
  }
  return h();
}

// Asphalt: a 64px tile of the fill colour with faint dark and light specks. Opaque, so overlapping strokes at a junction match.
const tiles = new Map<string, HTMLCanvasElement>();
export function grain(fill: string): HTMLCanvasElement {
  let c = tiles.get(fill);
  if (c) return c;
  tiles.set(fill, c = document.createElement('canvas'));
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!, rng = mulberry32(7);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 520; i++) {
    const dark = rng() < 0.75, a = 0.03 + rng() * (dark ? 0.08 : 0.25);
    ctx.fillStyle = dark ? `rgba(70,70,64,${a})` : `rgba(255,255,255,${a})`;
    const s = rng() < 0.85 ? 1 : 2;
    ctx.fillRect(Math.floor(rng() * 64), Math.floor(rng() * 64), s, s);
  }
  return c;
}
