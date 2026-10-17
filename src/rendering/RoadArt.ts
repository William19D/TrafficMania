import type { Edge, Node } from '../network/RoadGraph.ts';
import { mulberry32 } from '../util/rng.ts';

// Signature of everything the cached road layer draws: geometry, tiers, lanes, flags, controls and ring sizes (FNV-1a over the
// numbers). Lane arrows and signal colours are drawn live, so junction plans stay out of it, but for their priority signs.
export function netKey(edges: Edge[], nodes: Node[]): number {
  let h = 2166136261;
  const mix = (v: number): void => { h = Math.imul(h ^ Math.round(v * 8), 16777619); };
  const word = (s: string): void => mix(s.charCodeAt(0) * 16 + s.length);
  for (const e of edges) {
    mix(e.id); mix(e.a.x); mix(e.a.y); mix(e.b.x); mix(e.b.y); word(e.type.tier); mix(e.type.lanes); mix(e.level);
    mix(+e.type.oneWay | +e.bridge << 1 | +e.tunnel << 2 | +e.drive << 3);
  }
  for (const n of nodes) { mix(n.id); word(n.control); mix(n.ring); mix(+!!n.building); for (const s of n.plan?.signs ?? []) mix(s ?? 3); }
  return h >>> 0;
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
