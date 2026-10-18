import type { Vec } from '../util/geom.ts';
import type { Edge } from '../network/RoadGraph.ts';
import type { Terrain } from '../world/MapGenerator.ts';
import { WORLD } from '../world/MapGenerator.ts';

// Ambient life over the static ground: boats, pedestrians, cloud shadows and birds. Everything is a pure function of the clock
// (no state, nothing saved), culled to the view and capped.
export interface View { x0: number; y0: number; x1: number; y1: number }
const inView = (v: View, x: number, y: number, m: number): boolean => x > v.x0 - m && x < v.x1 + m && y > v.y0 - m && y < v.y1 + m;

// Point and heading at distance d along a polyline (wrapped: closed loops go round, open ones restart)
function along(pts: Vec[], closed: boolean, d: number): { p: Vec; a: number } {
  const n = closed ? pts.length : pts.length - 1;
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y);
  d = ((d % total) + total) % total;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= L || i === n - 1) { const u = Math.min(1, d / (L || 1)); return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, a: Math.atan2(b.y - a.y, b.x - a.x) }; }
    d -= L;
  }
  return { p: pts[0], a: 0 };
}

const HULLS = ['#FFFFFF', '#F4F1EA', '#FFFFFF'], CABINS = ['#D9534F', '#2F6FED', '#F0A030', '#3E9E7A'];

// A boat on every lake (round a loop inside it) and on every river (downstream, then again from the top), with a wake
export function boats(ctx: CanvasRenderingContext2D, t: Terrain, now: number, v: View): void {
  const tracks: [Vec[], boolean, number][] = [];
  t.lakes.forEach((l, i) => {
    const c = { x: l.reduce((s, p) => s + p.x, 0) / l.length, y: l.reduce((s, p) => s + p.y, 0) / l.length };
    tracks.push([l.map(p => ({ x: c.x + (p.x - c.x) * 0.55, y: c.y + (p.y - c.y) * 0.55 })), true, 9 + i * 3]);
  });
  t.rivers.forEach((r, i) => tracks.push([r.points, false, 14 + i * 4]));
  tracks.forEach(([pts, closed, spd], i) => {
    const { p, a } = along(pts, closed, now * spd + i * 400);
    if (!inView(v, p.x, p.y, 30)) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);
    // wake: two pale lines opening behind the stern, and a churn
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-4, -1.2); ctx.lineTo(-22, -6);
    ctx.moveTo(-4, 1.2); ctx.lineTo(-22, 6);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.beginPath(); ctx.ellipse(-6, 0, 3.5, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(30,50,90,.18)';
    hull(ctx, 1, 1.2);
    ctx.fillStyle = HULLS[i % HULLS.length];
    hull(ctx, 0, 0);
    ctx.strokeStyle = '#8A94A3';
    ctx.lineWidth = 0.4;
    ctx.stroke();
    ctx.fillStyle = CABINS[i % CABINS.length];
    ctx.fillRect(-2.6, -1.4, 3.4, 2.8);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.fillRect(-2.6, -1.4, 3.4, 0.9);
    ctx.restore();
  });
}

function hull(ctx: CanvasRenderingContext2D, dx: number, dy: number): void {
  ctx.beginPath();
  ctx.moveTo(-4.5 + dx, -2 + dy);
  ctx.lineTo(2.5 + dx, -2 + dy);
  ctx.quadraticCurveTo(6 + dx, dy, 2.5 + dx, 2 + dy);
  ctx.lineTo(-4.5 + dx, 2 + dy);
  ctx.closePath();
  ctx.fill();
}

const SHIRTS = ['#D9534F', '#2F6FED', '#F0A030', '#3E9E7A', '#8E7CC3', '#F2F2F2', '#3A3A3A', '#E57FB0'];
const SKIN = ['#F1C9A5', '#D9A47C', '#A8754F', '#6E4A32'];

// Pedestrians pacing the sidewalks, busiest on the roads that serve buildings (a driveway joins one of their ends) and by day;
// each walks to the end of its block and back. Hidden in the small hours.
// ponytail: walkers ignore cars and each other and turn round at the block's end; a sidewalk graph if they ever need to go somewhere
export function pedestrians(ctx: CanvasRenderingContext2D, edges: Edge[], hour: number, now: number, v: View, cap = 140): void {
  if (hour < 5 || hour > 23.5) return;
  const busy = hour > 7 && hour < 21 ? 1 : 0.35;
  // batched: every shadow in one fill, then one fill per shirt and skin tone
  const shadow = new Path2D(), shirts = SHIRTS.map(() => new Path2D()), skins = SKIN.map(() => new Path2D());
  let drawn = 0;
  for (const e of edges) {
    if (drawn >= cap) break;
    const { a, b } = e;
    if (Math.max(a.x, b.x) < v.x0 - 10 || Math.min(a.x, b.x) > v.x1 + 10 || Math.max(a.y, b.y) < v.y0 - 10 || Math.min(a.y, b.y) > v.y1 + 10) continue;
    const L = e.length, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, h = Math.imul(e.id, 2654435761) >>> 0;
    const near = a.edges.some(x => x.drive) || b.edges.some(x => x.drive), n = Math.round(L / 70 * (near ? 1.2 : 0.35) * busy + (h % 100) / 100);
    for (let k = 0; k < n && drawn < cap; k++) {
      const hk = Math.imul(h ^ (k * 40503), 2246822519) >>> 0, side = k % 2 ? 1 : -1, spd = 5 + (hk % 5);
      const d = (now * spd + (hk % 997)) % (2 * L), s = Math.min(L - 3, Math.max(3, d < L ? d : 2 * L - d)), off = side * (e.width / 2 + 2.5) - (e.ring ? (e.type.lanes - 1) * 4.5 : 0); // a ring's road lies inside its chords' axis
      const x = a.x + ux * s - uy * off, y = a.y + uy * s + ux * off, step = Math.sin(now * spd * 1.6 + k) * 0.5;
      // a negative skin index (hk >> 4 is signed) has always drawn the head in the shirt colour
      const r = Math.atan2(uy, ux) + Math.PI / 2, sh = shirts[hk % SHIRTS.length], si = (hk >> 4) % SKIN.length, sk = si < 0 ? sh : skins[si];
      shadow.moveTo(x + 2.7, y + 0.9); shadow.ellipse(x + 0.8, y + 0.9, 1.9, 1.5, 0, 0, Math.PI * 2);
      sh.moveTo(x + 1.4 * Math.cos(r), y + 1.4 * Math.sin(r)); sh.ellipse(x, y, 1.4, 1.85 + step * 0.25, r, 0, Math.PI * 2);
      sk.moveTo(x + 0.85, y); sk.arc(x, y, 0.85, 0, Math.PI * 2);
      drawn++;
    }
  }
  if (!drawn) return;
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fill(shadow);
  shirts.forEach((p, i) => { ctx.fillStyle = SHIRTS[i]; ctx.fill(p); });
  skins.forEach((p, i) => { ctx.fillStyle = SKIN[i]; ctx.fill(p); });
}

// Soft cloud shadow, drawn once: overlapping radial pools on a small canvas, stretched over the world
let cloud: HTMLCanvasElement | null = null;
function cloudSprite(): HTMLCanvasElement {
  if (cloud) return cloud;
  cloud = document.createElement('canvas');
  cloud.width = 160;
  cloud.height = 100;
  const c = cloud.getContext('2d')!;
  for (const [x, y, r] of [[50, 55, 38], [85, 45, 42], [118, 58, 32], [70, 68, 30], [100, 70, 28]]) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(40,55,80,.08)');
    g.addColorStop(1, 'rgba(40,55,80,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 160, 100);
  }
  return cloud;
}

// Cloud shadows drifting east over everything on the ground
export function cloudShadows(ctx: CanvasRenderingContext2D, now: number, v: View): void {
  const img = cloudSprite(), W = WORLD.w + 900;
  for (let i = 0; i < 6; i++) {
    const w = 380 + (i % 3) * 90, h = w * 0.62, x = ((i * 733 + now * (7 + i)) % W) - 450, y = ((i * 0.37 + 0.08) % 1) * WORLD.h - h / 2;
    if (x + w < v.x0 || x > v.x1 || y + h < v.y0 || y > v.y1) continue;
    ctx.drawImage(img, x, y, w, h);
  }
}

// Small flocks crossing the map in loose Vs, wings beating, with faint shadows on the ground below
export function birds(ctx: CanvasRenderingContext2D, now: number, v: View): void {
  const span = WORLD.w + WORLD.h + 400, shadow = new Path2D(), body = new Path2D();
  ctx.lineCap = 'round';
  for (let f = 0; f < 3; f++) {
    const dir = f % 2 ? Math.PI * 0.85 : -Math.PI * 0.1, d = (now * 22 + f * 900) % span - 200;
    const ox = f % 2 ? WORLD.w + 100 : -100, oy = WORLD.h * (0.25 + f * 0.25);
    const hx = Math.cos(dir), hy = Math.sin(dir), cx = ox + hx * d, cy = oy + hy * d + Math.sin(now * 0.3 + f) * 30;
    if (!inView(v, cx, cy, 60)) continue;
    for (let i = 0; i < 5 + f; i++) {
      const row = Math.ceil(i / 2), sd = i % 2 ? 1 : -1, back = row * 7, lat = row * 6 * sd;
      const x = cx - hx * back - hy * lat, y = cy - hy * back + hx * lat, flap = Math.sin(now * 9 + i * 1.3), w = 2.6 * (0.55 + 0.45 * Math.abs(flap));
      for (const [p, dx, dy] of [[shadow, 10, 14], [body, 0, 0]] as const) {
        p.moveTo(x + dx - hx * 1.2 - hy * w, y + dy - hy * 1.2 + hx * w);
        p.lineTo(x + dx + hx * 0.6, y + dy + hy * 0.6);
        p.lineTo(x + dx - hx * 1.2 + hy * w, y + dy - hy * 1.2 - hx * w);
      }
    }
  }
  // batched: every shadow in one stroke, every bird in another
  ctx.strokeStyle = 'rgba(0,0,0,.12)';
  ctx.lineWidth = 0.8;
  ctx.stroke(shadow);
  ctx.strokeStyle = '#4A4D52';
  ctx.lineWidth = 0.75;
  ctx.stroke(body);
}
