import type { Kind } from '../entities/Car.ts';
import { KINDS } from '../entities/Car.ts';
import { shade } from './BuildingArt.ts';
import { profile } from '../core/Profile.ts';
import { PAINTS } from '../core/Achievements.ts';

// Vehicle models, flat top-down, local frame +x forward, centred. Cached per kind, paint and pixel scale; the renderer
// draws one rotated drawImage per vehicle (tail lights and indicators baked in) plus the live extras (VIP pennant, ambulance bar, purpose dot) on top.
export const VW: Record<Kind, number> = { car: 8, truck: 8.5, moto: 4, ambulance: 8 };
// Sprite frame: VPAD px round the body lengthwise, VH px tall (room for the side mirrors and the shadow's blur)
export const VPAD = 2, VH = 14;
// Paint by weight, like a real car park: mostly white, black and silver, a rare yellow taxi. Trucks wear fleet liveries
type Palette = [string, number][];
export const CAR_PAINT: Palette = [
  ['#F1F1EC', 20], ['#24272C', 16], ['#B8BDC3', 14], ['#6C737B', 12], ['#C6352B', 9], ['#2E6BB3', 8], ['#1E3454', 6],
  ['#3D7A4D', 4], ['#CDBA95', 4], ['#6B4A35', 3], ['#E07A28', 2], ['#F2C12E', 2],
];
// Car paint sets the profile unlocks (Achievements.ts); Classic is CAR_PAINT
const SETS: Palette[] = [CAR_PAINT,
  [['#F4C7D3', 1], ['#BFE3D6', 1], ['#C9D7F2', 1], ['#F8E3A8', 1], ['#D9C8F0', 1], ['#F6F2EA', 1]],
  [['#E9DCB4', 2], ['#C4503A', 2], ['#2F6F6A', 2], ['#E2A43A', 1], ['#5B7FA6', 1], ['#7E4A36', 1]],
  [['#FF3EA5', 1], ['#22E4D8', 1], ['#B4F53A', 1], ['#FFE13B', 1], ['#8E5CFF', 1], ['#FF8A1F', 1]],
  [['#D4A93C', 6], ['#E8C766', 3], ['#F1F1EC', 1], ['#24272C', 1]],
];
export const TRUCK_LIVERY: Palette = [
  ['#F4F4F0', 30], ['#C93A30', 14], ['#2F64A8', 14], ['#8A9097', 12], ['#3A8650', 10], ['#E58A2A', 10], ['#EDC339', 6],
];
// Palette index for a paint roll in [0, 1)
export function pick(p: Palette, u: number): number {
  let r = 0;
  for (const c of p) r += c[1];
  r *= u;
  for (let i = 0; i < p.length; i++) if ((r -= p[i]![1]) < 0) return i;
  return p.length - 1;
}

const KI: Record<Kind, number> = { car: 0, truck: 1, moto: 2, ambulance: 3 };
export const GLASS = '#2C3949';
const LAMP = '#FFF4C8';
// A sprite: its rect on an atlas page. Every model at one pixel scale shares pages, so the renderer's draws batch on the GPU
export interface Cell { c: HTMLCanvasElement; x: number; y: number; w: number; h: number }
const sprites = new Map<number, Cell>();
const pages = new Map<number, { c: HTMLCanvasElement; n: number; cols: number; rows: number }>();
const MAX_L = Math.max(...Object.values(KINDS).map(k => k.len));

// ponytail: pages of 256 cells (1 px gutters), a new page when one fills; never freed
function frame(kind: Kind, s: number, draw: (c: CanvasRenderingContext2D, h: number, w: number) => void): Cell {
  const L = KINDS[kind].len, cw = Math.ceil((MAX_L + 2 * VPAD) * s) + 2, ch = Math.ceil(VH * s) + 2;
  let pg = pages.get(s);
  if (!pg || pg.n === pg.cols * pg.rows) {
    const cols = Math.max(1, Math.floor(2048 / cw)), rows = Math.ceil(256 / cols), c = document.createElement('canvas');
    c.width = cols * cw;
    c.height = rows * ch;
    pages.set(s, pg = { c, n: 0, cols, rows });
  }
  const cell = { c: pg.c, x: (pg.n % pg.cols) * cw + 1, y: Math.floor(pg.n / pg.cols) * ch + 1, w: Math.ceil((L + 2 * VPAD) * s), h: ch - 2 };
  pg.n++;
  const ctx = pg.c.getContext('2d')!;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cell.x, cell.y, cell.w, cell.h);
  ctx.clip();
  ctx.setTransform(s, 0, 0, s, cell.x + (L / 2 + VPAD) * s, cell.y + VH / 2 * s);
  ctx.lineCap = ctx.lineJoin = 'round';
  draw(ctx, L / 2, VW[kind] / 2);
  ctx.restore();
  return cell;
}

// Soft drop shadow of the body (the renderer offsets it down-right in world space)
export function vshadow(kind: Kind, s: number): Cell {
  const key = -1 - (KI[kind] * 16 + Math.log2(s));
  let c = sprites.get(key);
  if (!c) sprites.set(key, c = frame(kind, s, (x, h, w) => {
    // the shape is drawn far off the cell and only its blurred shadow lands on it (shadow offsets ignore the transform)
    x.shadowColor = 'rgba(20,30,50,.38)';
    x.shadowBlur = 1.6 * s;
    x.shadowOffsetX = 1000 * s;
    x.beginPath();
    x.roundRect(-h - 1000, -w, 2 * h, 2 * w, kind === 'moto' ? w : 2);
    x.fill();
  }));
  return c;
}

// Body colour of a vehicle, for the far-zoom shapes
export function paintOf(kind: Kind, paint: number): string {
  const p = kind === 'truck' ? TRUCK_LIVERY : SETS[Math.max(0, PAINTS.indexOf(profile().cosmetics.paint))]!;
  return p[pick(p, paint)]![0];
}

// Far-zoom shapes of a vehicle, local frame, as [x0, y0, x1, y1, part]: 0 body (paint), 1 darker body (truck cab), 2 glass, 3 roof
// (lighter paint); ambulances wear white
type Shape = [number, number, number, number, number];
const shapes = new Map<Kind, Shape[]>();
export function farShapes(kind: Kind): Shape[] {
  let s = shapes.get(kind);
  if (!s) shapes.set(kind, s = farShapes0(kind));
  return s;
}
function farShapes0(kind: Kind): Shape[] {
  const h = KINDS[kind].len / 2, w = VW[kind] / 2;
  if (kind === 'moto') return [[-h + 0.5, -1.5, h - 0.5, 1.5, 0]];
  if (kind === 'truck') return [[-h, -w, h - 7, w, 0], [h - 6, -w + 0.4, h, w - 0.4, 1], [h - 2.4, -w + 1, h - 1.1, w - 1, 2]];
  if (kind === 'ambulance') return [[-h, -w, h, w, 0], [h - 5.6, -w + 0.9, h - 3.7, w - 0.9, 2]];
  return [[-h, -w, h, w, 0], [-h + 2.1, -w + 0.8, h - 3.7, w - 0.8, 2], [-h + 4, -w + 1.3, h - 6, w - 1.3, 3]];
}

// paint: the car's roll in [0, 1), set at spawn; brake: the tail lights lit; blink: the indicator lit, 1 right / -1 left / 0 off
export function vehicle(kind: Kind, paint: number, s: number, brake = false, blink = 0): Cell {
  const set = kind === 'truck' ? 0 : Math.max(0, PAINTS.indexOf(profile().cosmetics.paint)), p = kind === 'truck' ? TRUCK_LIVERY : SETS[set]!;
  const i = pick(p, paint), key = (((set * 4 + KI[kind]) * 16 + i) * 16 + Math.log2(s)) * 6 + +brake * 3 + blink + 1;
  let c = sprites.get(key);
  if (!c) sprites.set(key, c = frame(kind, s, (x, h, w) => {
    draw(x, kind, p[i]![0], h, w);
    x.fillStyle = brake ? '#FF2A2A' : '#8C2A2A';
    if (kind === 'moto') x.fillRect(-h - 0.4, -0.6, 1.2, 1.2);
    else { x.fillRect(-h - 0.4, -w + 0.6, 1.3, 1.6); x.fillRect(-h - 0.4, w - 2.2, 1.3, 1.6); }
    if (!blink) return;
    const sy = blink > 0 ? w - 1.5 : -w - 0.5;
    x.fillStyle = '#FFB020';
    x.fillRect(-h - 1, sy, 2, 2);
    x.fillRect(h - 1, sy, 2, 2);
  }));
  return c;
}

function draw(c: CanvasRenderingContext2D, kind: Kind, col: string, h: number, w: number): void {
  const rect = (x: number, y: number, rw: number, rh: number, r: number, fill: string, out: string | null = null, lw = 0.5): void => {
    c.beginPath();
    c.roundRect(x, y, rw, rh, r);
    c.fillStyle = fill;
    c.fill();
    if (out) { c.strokeStyle = out; c.lineWidth = lw; c.stroke(); }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, stroke: string, lw: number): void => {
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.strokeStyle = stroke;
    c.lineWidth = lw;
    c.stroke();
  };
  const edge = shade(col, -0.55), dark = '#2B2B2B';
  const mirrors = (x: number, fill: string): void => { for (const k of [-1, 1]) rect(x, k > 0 ? w - 0.2 : -w - 0.9, 1.1, 1.1, 0.4, fill); };
  const heads = (x: number, y: number): void => { for (const k of [-1, 1]) rect(x, k * y - 0.75, 0.9, 1.5, 0.3, LAMP); };

  if (kind === 'moto') {
    rect(h - 2.4, -0.7, 2.4, 1.4, 0.6, dark);
    rect(-h, -0.7, 2.4, 1.4, 0.6, dark);
    c.beginPath();
    c.ellipse(0.2, 0, 3.6, 1.5, 0, 0, Math.PI * 2);
    c.fillStyle = col;
    c.fill();
    c.strokeStyle = edge;
    c.lineWidth = 0.5;
    c.stroke();
    line(2.4, -2.5, 2.4, 2.5, '#3A3A3A', 0.7);
    // rider: shoulders, arms to the bars, helmet with a visor glint
    c.beginPath();
    c.ellipse(-0.8, 0, 1.6, 2.3, 0, 0, Math.PI * 2);
    c.fillStyle = '#454B57';
    c.fill();
    line(-0.4, -1.8, 2.3, -2.2, '#454B57', 0.8);
    line(-0.4, 1.8, 2.3, 2.2, '#454B57', 0.8);
    c.beginPath();
    c.arc(0.4, 0, 1.45, 0, Math.PI * 2);
    c.fillStyle = shade(col, -0.25);
    c.fill();
    rect(0.9, -0.9, 0.7, 1.8, 0.3, 'rgba(255,255,255,.55)');
    rect(h - 0.6, -0.5, 0.6, 1, 0.3, LAMP);
    return;
  }
  if (kind === 'truck') {
    // liveried box trailer with ribs, a coupling, then a darker cab with its windshield
    const tl = 2 * h - 7;
    rect(-h, -w, tl, 2 * w, 1, col, edge);
    c.beginPath();
    for (let x = -h + 2; x < -h + tl - 1; x += 2.3) { c.moveTo(x, -w + 0.8); c.lineTo(x, w - 0.8); }
    c.strokeStyle = shade(col, -0.18);
    c.lineWidth = 0.4;
    c.stroke();
    rect(-h + 1, -w + 1, tl - 2, 1.1, 0.4, shade(col, 0.2));
    rect(h - 7.2, -1, 1.4, 2, 0.3, '#555555');
    const cab = shade(col, -0.32);
    rect(h - 6, -w + 0.4, 6, 2 * w - 0.8, 1.8, cab, edge);
    rect(h - 5.4, -w + 1.4, 2.6, 2 * w - 2.8, 0.8, shade(cab, 0.15));
    rect(h - 2.4, -w + 1, 1.3, 2 * w - 2, 0.5, GLASS);
    mirrors(h - 2.9, cab);
    heads(h - 0.9, w - 1.4);
    return;
  }
  const amb = kind === 'ambulance';
  rect(-h, -w, 2 * h, 2 * w, 2.6, amb ? '#F7F7F5' : col, amb ? '#9A9A96' : edge, 0.6);
  if (amb) {
    // boxy rear with a purpose stripe and a red cross
    rect(-h + 0.8, -w + 0.9, 2 * h - 6.8, 2 * w - 1.8, 1, '#FFFFFF', '#D2D2CE', 0.4);
    rect(-h + 1, -0.6, 2 * h - 7.2, 1.2, 0, col);
    rect(-h + 3.2, -2.2, 1.2, 4.4, 0.2, '#E5484D');
    rect(-h + 1.6, -0.6, 4.4, 1.2, 0.2, '#E5484D');
  } else {
    // hood highlight, glazed cabin (rear window, side glass, windshield) and a lighter roof panel
    rect(h - 4, -w + 1.6, 3.2, 2 * w - 3.2, 1.2, shade(col, 0.12));
    rect(-h + 2.1, -w + 0.8, 2 * h - 7.5, 2 * w - 1.6, 1.2, GLASS);
    rect(-h + 4, -w + 1.3, 2 * h - 10, 2 * w - 2.6, 1.1, shade(col, 0.2));
  }
  rect(h - 5.6, -w + 0.9, 1.9, 2 * w - 1.8, 0.8, GLASS);
  mirrors(h - 5.2, amb ? '#C8C8C4' : shade(col, -0.35));
  heads(h - 0.95, w - 1.3);
}
