// Day/night: a multiply tint over the world following the in-game clock, and the glow sprites drawn on top of it at night
// (street lamps, headlights, lit windows). night 0..1 scales every glow.
export interface Daylight { r: number; g: number; b: number; night: number }

// hour, tint rgb, night: blue night, warm dawn, plain day, warm dusk
const KEYS: [number, number, number, number, number][] = [
  [0, 116, 130, 188, 1], [4.5, 116, 130, 188, 1], [6, 255, 238, 220, 0.25], [7.5, 255, 255, 255, 0],
  [17, 255, 255, 255, 0], [18.6, 250, 212, 182, 0.4], [20.2, 116, 130, 188, 1], [24, 116, 130, 188, 1],
];
export function daylight(hour: number): Daylight {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (KEYS[i + 1][0] < h) i++;
  const a = KEYS[i], b = KEYS[i + 1], f = (h - a[0]) / (b[0] - a[0]), mix = (k: number): number => a[k] + (b[k] - a[k]) * f;
  return { r: Math.round(mix(1)), g: Math.round(mix(2)), b: Math.round(mix(3)), night: mix(4) };
}

// Glow sprites per pixel scale: a warm round pool (lamps, windows) and a headlight beam (+x forward, starts at x = 0)
const cache = new Map<string, HTMLCanvasElement>();
function canvas(key: string, w: number, h: number, s: number, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let c = cache.get(key + s);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = Math.ceil(w * s);
  c.height = Math.ceil(h * s);
  const ctx = c.getContext('2d')!;
  ctx.scale(s, s);
  draw(ctx);
  cache.set(key + s, c);
  return c;
}

export const GLOW_R = 16;
export function glow(s: number): HTMLCanvasElement {
  return canvas('glow', 2 * GLOW_R, 2 * GLOW_R, s, c => {
    const g = c.createRadialGradient(GLOW_R, GLOW_R, 0, GLOW_R, GLOW_R, GLOW_R);
    g.addColorStop(0, 'rgba(255,214,140,.75)');
    g.addColorStop(0.35, 'rgba(255,190,110,.32)');
    g.addColorStop(1, 'rgba(255,170,90,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 2 * GLOW_R, 2 * GLOW_R);
  });
}

export const BEAM_L = 30, BEAM_W = 18;
export function beam(s: number): HTMLCanvasElement {
  return canvas('beam', BEAM_L, BEAM_W, s, c => {
    const g = c.createLinearGradient(0, 0, BEAM_L, 0);
    g.addColorStop(0, 'rgba(255,244,200,.55)');
    g.addColorStop(1, 'rgba(255,244,200,0)');
    c.beginPath();
    c.moveTo(0, BEAM_W / 2 - 3);
    c.lineTo(BEAM_L, 0);
    c.lineTo(BEAM_L, BEAM_W);
    c.lineTo(0, BEAM_W / 2 + 3);
    c.closePath();
    c.fillStyle = g;
    c.fill();
  });
}
