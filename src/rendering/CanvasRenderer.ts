import { profile } from '../core/Profile.ts';
import type { Vec } from '../util/geom.ts';
import { WORLD, inWater } from '../world/MapGenerator.ts';
import { BIOMES, PURPOSES, TIERS, ZONES, ZONE_NAME, TUNING } from '../core/config.ts';
import { ROAD_W, NODE_R, LANE_W, RINGS, RING_W, onRing, ringOut, roadWidth } from '../network/RoadGraph.ts';
import { approachOf, autoMasks, inLanes, laneMasks, links, mainEdges, moveOf, planOf } from '../network/Junction.ts';
import { curve, editable, linkUI, linksOf, handles, targets } from '../ui/LaneLinks.ts';
import type { Edge, Node, Ring, RoadType } from '../network/RoadGraph.ts';
import type { Building } from '../entities/Building.ts';
import type { Lot } from '../core/Zones.ts';
import type { Car } from '../entities/Car.ts';
import type { Game, PathPlan, PathSeg } from '../core/Game.ts';
import { CONTROL_LABEL, FX_LIFE, HOUR, exitEdge, fmtMoney } from '../core/Game.ts';
import { corners, lotAt, lotRect } from '../core/Zones.ts';
import { PAD, look, shade, sprite, variant } from './BuildingArt.ts';
import { paintTerrain, shimmer, tree } from './Scenery.ts';
import { birds, boats, cloudShadows, pedestrians } from './Ambience.ts';
import { grain, netKey } from './RoadArt.ts';
import { BEAM_L, BEAM_W, GLOW_R, beam, daylight, glow } from './Lighting.ts';
import type { Daylight } from './Lighting.ts';
import { VH, VPAD, VW, vehicle, vshadow } from './VehicleArt.ts';

const ROAD_OUT = '#9E9E9A';
const ROAD_FILL = '#FFFFFF';
const YELLOW = '#E6C84B';
const BRIDGE = '#6F7F93';
const DARK = '#3A3A3A';
const CAR_OUT = '#2B2B2B';
const GREEN = '#4CC26A';
const RED = '#E5484D';
const RAIL = '#55657A';
const PILLAR = '#8A99AD';
const ACCENT = '#2F6FED';
// lane connection colours, one per junction approach
const LINK_COLS = [ACCENT, '#2F8F5B', '#E08A1E', '#8A4FD8', '#D0457A', '#1E9AA8'];
const BRAKE_ON = '#FF2A2A';
const BRAKE_OFF = '#8C2A2A';
const AMBER = '#FFB020';
const NOISE = '#8E7CC3';
const SMOG = '#9A6B2F';
// Sidewalk paving and its outer kerb (street, avenue, boulevard); driveways in concrete; paint near junctions
const WALK = '#EFECE5', KERB = '#CBC6BA', PAINT = '#B9B9B4', GRANITE = '#B3AEA2', JOINT = '#D9D4C9';
// a busy junction gets zebras too: a light, or four roads or more
const zebraAt = (n: Node): boolean => n.control === 'light' || (!onRing(n) && n.edges.filter(e => !e.drive).length >= 4);
// stable 0..1 per world spot, for the scattered details
const hash01 = (x: number, y: number): number => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
const DRIVE = { out: '#BDB6A6', fill: '#E3DED3' };
const walked = (e: Edge): boolean => !e.drive && !e.bridge && !e.tunnel && (e.type.tier === 'street' || e.type.tier === 'avenue' || e.type.tier === 'boulevard');
// A junction that gets paint: 3+ roads, or a sign or light (a driveway junction is a bend for the road's traffic)
const junction = (n: Node): boolean => !n.building && (n.control !== 'none' || n.edges.filter(e => !e.drive).length >= 3);
// Heat map: free flow -> slow -> jammed
const HEAT: [number, number, number][] = [[0x4C, 0xC2, 0x6A], [0xE0, 0xA1, 0x00], [0xE5, 0x48, 0x4D]];
export const heatColor = (h: number): string => {
  const x = 2 * Math.max(0, Math.min(1, h)), i = Math.min(1, Math.floor(x)), f = x - i, a = HEAT[i], b = HEAT[i + 1];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join()})`;
};
// Home happiness dot under an overlay: the happiness chip's bands
const happyColor = (h: number): string => h >= TUNING.GROW_HI ? GREEN : h >= TUNING.GROW_LO ? AMBER : RED;

export class CanvasRenderer {
  cam: { x: number; y: number; zoom: number };
  private ctx: CanvasRenderingContext2D;
  // Land colour of the current biome, for the roundabout islands
  private land = BIOMES.temperate.land;
  private treeCol = BIOMES.temperate.tree;
  // Cached static ground roads (asphalt, kerbs, verges, markings, islands, stop lines) over a world rect at s px per world px
  private roads: { key: number; isl: string; t: Game['terrain']; s: number; x: number; y: number; w: number; h: number; c: HTMLCanvasElement } | null = null;
  // The followed car's last known route (its path is null for a tick after each node), and the car it belongs to
  private route: { car: Car | null; nodes: Node[] } = { car: null, nodes: [] };
  // Cached ground of the current map at s px per world px; building sprites' scale
  private ground: { t: Game['terrain']; s: number; c: HTMLCanvasElement } | null = null;
  private artS = 1;
  // Cars drawn this frame and where, for the headlights over the night tint
  private seen: Car[] = [];
  private seenAt: { x: number; y: number; angle: number }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.cam = {
      x: WORLD.w / 2,
      y: WORLD.h / 2,
      zoom: Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h) * 0.95,
    };
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // A new game (its map may have another size): the whole map in view
  reset(): void {
    this.cam = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h) * 0.95 };
    this.route = { car: null, nodes: [] };
    this.glide = null;
    this.clamp();
  }

  resize(): void {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
    this.clamp();
  }

  // Smallest zoom: the whole world fits on screen (a bit of margin)
  get minZoom(): number {
    return Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h) * 0.9;
  }

  // Keeps the zoom in range and the world on screen (at most MARGIN of empty land past its border)
  private clamp(): void {
    const MARGIN = 120;
    // a page loaded hidden has a 0x0 viewport: Infinity - Infinity would turn the camera into NaN for good
    if (!innerWidth || !innerHeight) return;
    this.cam.zoom = Math.max(this.minZoom, Math.min(3, this.cam.zoom));
    const hw = innerWidth / 2 / this.cam.zoom, hh = innerHeight / 2 / this.cam.zoom;
    const axis = (v: number, size: number, half: number): number =>
      half - MARGIN > size - half + MARGIN ? size / 2 : Math.max(half - MARGIN, Math.min(size - half + MARGIN, v));
    this.cam.x = axis(this.cam.x, WORLD.w, hw);
    this.cam.y = axis(this.cam.y, WORLD.h, hh);
  }

  // Eases the camera there (render moves it a share of the way each frame); a pan or zoom takes over
  private glide: Vec | null = null;
  centerOn(p: Vec): void {
    this.glide = { x: p.x, y: p.y };
    this.cam.zoom = Math.max(this.cam.zoom, 1);
    this.clamp();
  }

  worldToScreen(p: Vec): Vec {
    const z = this.cam.zoom;
    return { x: (p.x - this.cam.x) * z + innerWidth / 2, y: (p.y - this.cam.y) * z + innerHeight / 2 };
  }

  screenToWorld(sx: number, sy: number): Vec {
    const z = this.cam.zoom;
    return { x: (sx - innerWidth / 2) / z + this.cam.x, y: (sy - innerHeight / 2) / z + this.cam.y };
  }

  pan(dxScreen: number, dyScreen: number): void {
    this.glide = null;
    this.cam.x -= dxScreen / this.cam.zoom;
    this.cam.y -= dyScreen / this.cam.zoom;
    this.clamp();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    // Keeps the world point under the cursor fixed
    this.glide = null;
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(this.minZoom, Math.min(3, this.cam.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clamp();
  }

  render(game: Game, preview: PathPlan | null, anchor: Vec | null, handle: Vec | null, hover: Vec | null = null): void {
    const ctx = this.ctx;
    const dpr = devicePixelRatio || 1;
    // the viewport can change without a resize event (a page loaded hidden at 0x0, then shown)
    if (this.canvas.width !== Math.round(innerWidth * dpr) || this.canvas.height !== Math.round(innerHeight * dpr)) this.resize();
    // still 0x0: nothing to draw, and a 0 zoom would make a 0px ground canvas whose drawImage throws and stops the game loop
    if (!innerWidth || !innerHeight) return;
    // Follow camera: centred on the car, zoomed in to at least 1.2 when the follow starts
    const fc = game.follow, gl = this.glide;
    if (gl && !fc) {
      const x = this.cam.x, y = this.cam.y;
      this.cam.x += (gl.x - x) * 0.15;
      this.cam.y += (gl.y - y) * 0.15;
      this.clamp();
      // arrived, or held at the map's edge
      if (Math.hypot(gl.x - this.cam.x, gl.y - this.cam.y) < 1 || Math.hypot(x - this.cam.x, y - this.cam.y) < 0.05) this.glide = null;
    }
    if (fc) {
      const p = game.graph.carPos(fc);
      if (this.route.car !== fc) { this.route = { car: fc, nodes: [] }; this.cam.zoom = Math.max(this.cam.zoom, 1.2); }
      this.cam.x = p.x;
      this.cam.y = p.y;
      this.clamp();
    }
    const z = this.cam.zoom;
    this.seen.length = this.seenAt.length = 0;

    // Background: flat land (in screen coordinates), then the cached ground of the map and the water's glints
    const biome = BIOMES[game.terrain.biome], terrain = game.terrain;
    this.land = biome.land;
    this.treeCol = biome.tree;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = biome.land;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // sprite and ground scale buckets: whole px per world px, rounded up so a close-up stays sharp
    this.artS = Math.min(8, 2 ** Math.ceil(Math.log2(Math.max(1, z * dpr))));
    // ponytail: the ground is one world-sized canvas capped at 12M px (soft past ~2.5x zoom on a small map); tile it if close-ups matter
    const gs = Math.min(Math.ceil(z * dpr), Math.floor(Math.sqrt(12e6 / (WORLD.w * WORLD.h)) * 100) / 100);
    if (this.ground?.t !== terrain || this.ground.s !== gs) this.ground = { t: terrain, s: gs, c: paintTerrain(terrain, gs) };

    const world = (): void => ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (innerWidth / 2 - this.cam.x * z), dpr * (innerHeight / 2 - this.cam.y * z));
    world();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.ground.c, 0, 0, this.ground.c.width / gs, this.ground.c.height / gs);
    const now = performance.now() / 1000, hw = innerWidth / 2 / z, hh = innerHeight / 2 / z;
    const view = { x0: this.cam.x - hw, y0: this.cam.y - hh, x1: this.cam.x + hw, y1: this.cam.y + hh };
    shimmer(ctx, terrain, now);
    boats(ctx, terrain, now, view);

    // World border, almost invisible
    ctx.strokeStyle = '#DDDBD4';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, WORLD.w, WORLD.h);

    if (game.overlay === 'noise') this.noiseMap(game);

    const edges = game.graph.edges;
    const nodes = game.graph.nodes;
    const ground = edges.filter((e) => !e.tunnel && e.level === 0);
    // A node belongs to the level of its edges; a ramp joint to the upper one (doors are ground)
    const levelNodes = (L: number): Node[] => nodes.filter((n) => (n.building ? 0 : Math.max(0, ...n.edges.map(e => e.level))) === L);
    const carsAt = (L: number): void => {
      for (const car of game.cars) if (car.lane.edge.level === L) this.car(game, car);
    };

    // Tunnels: body hidden under the mountain, faint dashed trace + big portals
    for (const e of edges) {
      if (!e.tunnel) continue;
      ctx.setLineDash([6, 6]);
      ctx.globalAlpha = 0.5;
      this.line(e, ROAD_FILL, 2);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      // portals only where the tunnel run ends, not at the joints inside a curved tunnel
      const inner = (n: Node): boolean => n.edges.length === 2 && n.edges.every((x) => x.tunnel);
      if (!inner(e.a)) this.portal(e.a, e.b, e.width);
      if (!inner(e.b)) this.portal(e.b, e.a, e.width);
    }

    // Selected run (Edit tool): soft accent halo under the road of its level
    const halo = (L: number): void => {
      if (!game.selected) return;
      ctx.globalAlpha = 0.35;
      this.runPath(game.selected.filter(e => e.level === L), ACCENT);
      ctx.globalAlpha = 1;
    };
    halo(0);
    this.lots(game);

    // Ground roads: the cached static layer, then the live lane arrows, heat, signals and signs over it
    const nodes0 = levelNodes(0);
    this.roadLayer(game, ground, nodes0, dpr);
    this.laneArrows(ground);
    if (game.overlay === 'heat') this.heatMap(ground, nodes0);
    this.controls(nodes0, 'live');
    // Buildings sit on the ground, under the viaducts; cars never enter a footprint (the door is outside it)
    for (const b of game.buildings) if (b.kind !== 'gate') this.building(b, game.time);
    this.exits(game);
    if (z >= 0.8) pedestrians(ctx, ground.filter(walked), game.hour, now, view);
    carsAt(0);

    // Elevated layers, lowest first: each covers the roads and cars below it
    const top = edges.reduce((m, e) => Math.max(m, e.level), 0);
    for (let L = 1; L <= top; L++) {
      const layer = edges.filter((e) => e.level === L);
      if (!layer.length) continue;
      const nodesL = levelNodes(L);
      halo(L);
      this.viaduct(L, layer, nodesL);
      if (game.overlay === 'heat') this.heatMap(layer, nodesL);
      this.controls(nodesL, 'all');
      carsAt(L);
    }

    // Ambience over every level: cloud shadows drifting over the ground, birds above them
    if (game.overlay === 'none') cloudShadows(ctx, now, view);
    birds(ctx, now, view);

    // Day/night: the world under a multiply tint from the clock (not under an overlay, which must read true), then the night's
    // lamps, windows and headlights over it; labels and tool hints below stay untinted
    const light = daylight(game.hour);
    if (game.overlay === 'none' && light.r + light.g + light.b < 765) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${light.r},${light.g},${light.b})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      world();
      this.night(game, light, ground);
    }

    // events over the tint, so their markers read at night
    this.events(game);
    this.rain(game, now);
    // Junction open in the Edit panel
    if (game.inspect) { ctx.globalAlpha = 0.5; this.ring(game.inspect.x, game.inspect.y, hubR(game.inspect), ACCENT, 2); ctx.globalAlpha = 1; this.linkEditor(game.inspect); }
    if (game.picked) this.outlineB(game.picked, ACCENT, 6);
    // the building being moved still stands where it was until it is set down; the one a Demolish click armed
    if (game.moving) { ctx.setLineDash([5, 4]); this.outlineB(game.moving, ACCENT, 6); ctx.setLineDash([]); }
    if (game.armed) this.outlineB(game.armed, RED, 6);
    if (game.zonePlan && game.tool === 'zone') this.zonePreview(game);

    // Followed car: its route ahead as a dashed accent line, and a ring around it
    if (fc) {
      if (fc.path) this.route.nodes = fc.path;
      const p = game.graph.carPos(fc);
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([6, 5]);
      this.polyline([p, ...this.route.nodes]);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
      this.ring(p.x, p.y, 14, ACCENT, 2.5);
      ctx.globalAlpha = 1;
    }

    // Tutorial targets: pulsing accent ring + static outer ring
    if (game.tutorialTargets.length) {
      const r = 30 + 4 * Math.sin(performance.now() / 250);
      for (const t of game.tutorialTargets) {
        ctx.globalAlpha = 0.9;
        this.ring(t.x, t.y, r, ACCENT, 3);
        ctx.globalAlpha = 0.35;
        this.ring(t.x, t.y, 40, ACCENT, 1.5);
      }
      ctx.globalAlpha = 1;
    }

    // Build preview: polyline of segments (a grid or an interchange mixes road types, so each segment draws its own)
    if (preview && preview.segs.length) {
      const segs = preview.segs;
      const W = (g: PathSeg): number => roadWidth(g.type), look = (g: PathSeg) => TIERS[g.type.tier];
      const draw = (g: PathSeg, color: string, width: number): void => this.seg(g.a, g.b, color, width);
      // Colored dashed outline: wider so it peeks out behind the gray outline
      ctx.setLineDash([8, 6]);
      for (const g of segs) draw(g, preview.ok ? GREEN : RED, W(g) + 7);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      for (const g of segs) {
        if (g.tunnel) {
          ctx.setLineDash([6, 6]);
          draw(g, look(g).out, W(g) + 3);
          ctx.setLineDash([]);
        } else if (g.level >= 1) {
          draw(g, BRIDGE, W(g) + 5);
        } else if (g.bridge) {
          this.bridge(g.a, g.b, terrain, W(g));
        } else {
          draw(g, look(g).out, W(g) + 3);
        }
      }
      for (const g of segs) {
        if (g.tunnel) ctx.setLineDash([6, 6]);
        draw(g, look(g).fill, W(g));
        ctx.setLineDash([]);
      }
      for (const g of segs) if (g.level >= 1) this.rails(g.a, g.b, W(g));
      for (const g of segs) if (!g.tunnel) this.markings(g.a, g.b, g.type);
      ctx.globalAlpha = 1;

      let label = preview.reason;
      if (preview.ok && preview.net !== undefined) {
        // Bend: price of the new curve minus the old run's price
        const n = Math.round(preview.net);
        label = n > 0 ? fmtMoney(n) : n < 0 ? `+${fmtMoney(-n)} back` : 'free';
      } else if (preview.ok) {
        label = fmtMoney(preview.cost);
      }
      // levels: one (a viaduct) or a span (a ramp)
      const lo = Math.min(...segs.map(g => g.level)), hi = Math.max(...segs.map(g => g.level));
      if (label && hi > 0) label += lo === hi ? ` · L${hi}` : ` · L${lo}-L${hi}`;
      if (label && preview.note) label = `${preview.note} · ${label}`;
      const last = preview.points[preview.points.length - 1] ?? segs[segs.length - 1].b;
      if (handle) {
        // Bend handle with dashed guides from the anchor (or the bent run's start) and to the end point
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const from = anchor ?? preview.points[0] ?? handle;
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(handle.x, handle.y);
        ctx.lineTo(last.x, last.y);
        ctx.strokeStyle = DARK;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      if (label) this.text(label, last.x + 14, last.y - 10, 'bold 12px system-ui', preview.ok ? '#2E8B4A' : RED);
    }
    if (handle) this.circle(handle.x, handle.y, 5, DARK);
    if (anchor) {
      this.circle(anchor.x, anchor.y, 7, ROAD_FILL);
      ctx.strokeStyle = DARK;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    this.juice(game);
    if (hover && (!preview || game.tool === 'interchange')) this.hoverFx(game, hover, preview);

    // No road access: red badge on the roof, and a label while the cursor is over the building
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of game.buildings) {
      const over = !!hover && b.contains(hover, 4), top = b.y - Math.max(b.w, b.h) / 2 - 10;
      if (b.connected) {
        if (b.downH) { this.pin(b, top, over); continue; }
        // homes: a red dot while households are moving out (every home's happiness under an overlay), residents and happiness under the cursor
        if (b.kind !== 'home' || b.abandoned) continue;
        if (b.happy < TUNING.GROW_LO || game.overlay !== 'none') { this.circle(b.x, b.y, 4.5, '#FFFFFF'); this.circle(b.x, b.y, 3, happyColor(b.happy)); }
        if (over) this.text(b.residents < 1 ? `Empty · ${Math.round(b.happy)}% happy` : `${Math.round(b.residents)} / ${b.cap} residents · ${Math.round(b.happy)}% happy`,
          b.x, top, 'bold 11px system-ui', b.happy < TUNING.GROW_LO ? RED : DARK);
        continue;
      }
      this.circle(b.x, b.y, 6, RED);
      ctx.font = 'bold 9px system-ui';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('!', b.x, b.y + 0.5);
      if (over) this.text('No road access', b.x, top, 'bold 11px system-ui', RED);
    }

    this.offscreenMarkers(game, dpr);
  }

  // Downgrade pin (Mini Motorways): amber with a ring counting down to abandonment (grey and red for an abandoned building, toward
  // clearing); under the cursor its cause, and a dashed line to where to fix it
  private pin(b: Building, top: number, over: boolean): void {
    const ctx = this.ctx, y = top - 4, k = Math.min(1, b.downH / TUNING.DOWN_H), col = b.abandoned ? RED : AMBER;
    this.circle(b.x, y, 8, '#FFFFFF');
    this.circle(b.x, y, 6, b.abandoned ? '#8A8A8A' : col);
    ctx.beginPath();
    ctx.arc(b.x, y, 8, -Math.PI / 2, -Math.PI / 2 + k * 2 * Math.PI);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = 'bold 9px system-ui';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('!', b.x, y + 0.5);
    if (!over || !b.cause) return;
    const at = b.cause.at;
    if (at) {
      ctx.setLineDash([4, 4]);
      this.polyline([{ x: b.x, y }, at]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      this.ring(at.x, at.y, 12, col, 2.5);
    }
    const left = Math.ceil(TUNING.DOWN_H - b.downH);
    this.text(`${b.cause.text} · ${b.abandoned ? 'cleared' : 'abandoned'} in ${left} h`, b.x, y - 16, 'bold 11px system-ui', b.abandoned ? RED : DARK);
  }

  // Traffic events (Events.ts): each a badge with a ring counting down its warning (dashed) or what is left of it; roadworks cones along
  // the road (a barrier at both ends once shut), a wreck on its road, a flag over the VIP target; on match day the stadium counts down
  // to kickoff from noon
  private events(game: Game): void {
    const ctx = this.ctx, t = game.time;
    const badge = (x: number, y: number, col: string, k: number, glyph: string, warn: boolean): void => {
      this.circle(x, y, 10, '#FFFFFF');
      this.circle(x, y, 7.5, col);
      ctx.beginPath();
      ctx.arc(x, y, 10, -Math.PI / 2, -Math.PI / 2 + Math.max(0, Math.min(1, k)) * 2 * Math.PI);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      if (warn) ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      this.text(glyph, x, y + 0.5, 'bold 10px system-ui', '#FFFFFF');
    };
    const cone = (x: number, y: number): void => { this.circle(x, y, 2.8, '#E8731C'); this.circle(x, y, 1.1, '#FFFFFF'); };
    for (const ev of game.events) {
      const warn = t < ev.at, k = warn ? (ev.at - t) / HOUR : (ev.end - t) / (ev.end - ev.at);
      if (ev.edge) {
        const e = ev.edge, dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, hw = e.width / 2;
        const at = (f: number, o: number): [number, number] => [e.a.x + dx * f - uy * o, e.a.y + dy * f + ux * o];
        if (ev.kind === 'roadworks') {
          // warning: cones along the kerb; shut: a row across each end and a striped barrier in the middle
          for (let f = 0.2; f <= 0.8; f += 0.15) cone(...at(f, hw + 2));
          if (!warn) for (const f of [Math.min(0.45, 14 / L), Math.max(0.55, 1 - 14 / L)]) for (let o = -hw + 2; o <= hw - 2; o += 5) cone(...at(f, o));
          if (!warn) { ctx.setLineDash([4, 4]); this.seg({ x: at(0.5, -hw)[0], y: at(0.5, -hw)[1] }, { x: at(0.5, hw)[0], y: at(0.5, hw)[1] }, '#E8731C', 3); ctx.setLineDash([]); }
        } else {
          // two cars askew and a flashing light
          const [x, y] = at(0.5, 0), a = Math.atan2(dy, dx);
          for (const [f, r, col] of [[-5, 0.5, '#C9CED6'], [5, -0.3, '#D9534F']] as const) {
            ctx.save();
            ctx.translate(x + ux * f, y + uy * f);
            ctx.rotate(a + r);
            ctx.fillStyle = col;
            ctx.fillRect(-6, -3.5, 12, 7);
            ctx.restore();
          }
          this.circle(x, y - 8, 2.5, (t * 4 | 0) % 2 ? RED : ACCENT);
        }
        const [bx, by] = at(0.5, -hw - 16);
        badge(bx, by, ev.kind === 'roadworks' ? '#E8731C' : RED, k, '!', warn);
      } else if (ev.to) {
        const b = ev.to, top = b.y - Math.max(b.w, b.h) / 2 - 18;
        badge(b.x, top, YELLOW, k, '★', warn);
      }
    }
    const st = game.buildings.find(b => b.special === 'stadium' && b.connected), h = game.hour;
    if (st && !(game.day % TUNING.MATCH_DAYS) && h >= 12 && h < TUNING.KICKOFF)
      badge(st.x, st.y - Math.max(st.w, st.h) / 2 - 18, ACCENT, (TUNING.KICKOFF - h) / (TUNING.KICKOFF - 12), '⚽', true);
  }

  // Rain (Events.ts): clouds darken the screen through the warning hour, then streaks fall while it lasts
  private rain(game: Game, now: number): void {
    const ev = game.events.find(e => e.kind === 'rain');
    if (!ev || game.overlay !== 'none') return;
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, k = game.time < ev.at ? 1 - (ev.at - game.time) / HOUR : 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgba(52,66,90,${0.16 * k})`;
    ctx.fillRect(0, 0, W, H);
    if (ev.base) {
      ctx.strokeStyle = 'rgba(210,225,245,0.45)';
      ctx.lineWidth = 1.2 * (devicePixelRatio || 1);
      ctx.beginPath();
      // ponytail: 160 streaks on a fixed lattice scrolled by time; no splashes
      for (let i = 0; i < 160; i++) {
        const x = ((i * 397.3 + now * 90) % (W + 60)) - 30, y = ((i * 211.7 + now * (520 + i % 7 * 40)) % (H + 60)) - 30;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 6, y + 16);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Zoned lots: an empty one a dashed plot in its zone's colours, a built one a faint plot under its building
  private lots(game: Game): void {
    const ctx = this.ctx;
    for (const l of game.lots) {
      const z = ZONES[l.zone], r = lotRect(l);
      this.polyline(corners({ ...r, w: r.w - 3, h: r.h - 3 }), true);
      ctx.globalAlpha = l.building ? 0.2 : 0.4;
      ctx.fillStyle = z.roof;
      ctx.fill();
      if (!l.building) {
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = z.out;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
  }

  // Zone brush drag: the path along the roads, the lots it adds (zone colours), re-zones (new colours, red where a building goes) or
  // erases (red dashed), and the label: lots, price and the demand it answers, or why not
  private zonePreview(game: Game): void {
    const ctx = this.ctx, p = game.zonePlan!, z = p.zone ? ZONES[p.zone] : null;
    ctx.globalAlpha = 0.35;
    this.polyline(p.path);
    ctx.strokeStyle = p.ok ? ACCENT : RED;
    ctx.lineWidth = 10;
    ctx.stroke();
    const plot = (l: Lot, fill: string | null, out: string, dash: boolean): void => {
      const r = lotRect(l);
      this.polyline(corners({ ...r, w: r.w - 3, h: r.h - 3 }), true);
      if (fill) { ctx.globalAlpha = 0.6; ctx.fillStyle = fill; ctx.fill(); }
      ctx.globalAlpha = 1;
      if (dash) ctx.setLineDash([4, 3]);
      ctx.strokeStyle = out;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (z) for (const l of p.add) plot(l, z.roof, z.out, false);
    if (z) for (const l of p.rezone) plot(l, z.roof, l.building ? RED : z.out, false);
    for (const l of p.erase) plot(l, null, RED, true);
    ctx.globalAlpha = 1;
    const end = p.path[p.path.length - 1];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    this.text(p.ok ? p.label : '⚠ ' + p.reason, end.x + 14, end.y - 10, 'bold 12px system-ui', p.ok && !p.demolish ? '#2E8B4A' : RED);
  }

  // Screen-edge markers for buildings without a road outside the view: zone-coloured square, red arrow toward it
  private offscreenMarkers(game: Game, dpr: number): void {
    const ctx = this.ctx;
    // ponytail: fixed insets for the HUD bars (top chips, bottom dock); measure the DOM if the layout changes
    const T = 70, B = 110, X = 24, R = 12;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const b of game.buildings) {
      if (b.connected) continue;
      const s = this.worldToScreen(b);
      if (s.x > X && s.x < innerWidth - X && s.y > T && s.y < innerHeight - B) continue;
      const x = Math.max(X + R, Math.min(innerWidth - X - R, s.x));
      const y = Math.max(T + R, Math.min(innerHeight - B - R, s.y));
      const z = ZONES[b.kind];
      ctx.save();
      ctx.translate(x, y);
      this.circle(0, 0, R + 1, '#FFFFFF');
      this.ring(0, 0, R + 1, RED, 2);
      ctx.beginPath();
      ctx.roundRect(-6, -6, 12, 12, 3);
      ctx.fillStyle = z.fill;
      ctx.fill();
      ctx.strokeStyle = z.out;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      this.edgeArrow(Math.atan2(s.y - y, s.x - x), R, RED);
      ctx.restore();
    }
    // the tutorial's targets: an accent disc with an arrow toward each one off screen
    for (const t of game.tutorialTargets) {
      const s = this.worldToScreen(t);
      if (s.x > X && s.x < innerWidth - X && s.y > T && s.y < innerHeight - B) continue;
      const x = Math.max(X + R, Math.min(innerWidth - X - R, s.x)), y = Math.max(T + R, Math.min(innerHeight - B - R, s.y));
      ctx.save();
      ctx.translate(x, y);
      this.circle(0, 0, R + 1, ACCENT);
      this.circle(0, 0, 4, '#FFFFFF');
      this.edgeArrow(Math.atan2(s.y - y, s.x - x), R, ACCENT);
      ctx.restore();
    }
  }

  private edgeArrow(a: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(r + 10, 0);
    ctx.lineTo(r + 3, -5);
    ctx.lineTo(r + 3, 5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // The static ground roads, cached over the view and a quarter view of margin at a half-power-of-2 zoom bucket: redrawn when the
  // network signature, the map, the bucket changes or the view leaves the rect, else one blit
  private roadLayer(game: Game, ground: Edge[], nodes0: Node[], dpr: number): void {
    const z = this.cam.zoom, s = Math.min(8, 2 ** (Math.ceil(2 * Math.log2(z * dpr)) / 2)), P = 60, vw = innerWidth / z, vh = innerHeight / z;
    const x0 = Math.max(-P, this.cam.x - vw / 2), y0 = Math.max(-P, this.cam.y - vh / 2);
    const x1 = Math.min(WORLD.w + P, this.cam.x + vw / 2), y1 = Math.min(WORLD.h + P, this.cam.y + vh / 2);
    const key = netKey(game.graph.edges, game.graph.nodes), isl = profile().cosmetics.island;
    let r = this.roads;
    if (!r || r.key !== key || r.isl !== isl || r.t !== game.terrain || r.s !== s || x0 < r.x || y0 < r.y || x1 > r.x + r.w || y1 > r.y + r.h) {
      // ponytail: no margin past ~20M px (a 4K screen close up), so a pan there redraws every frame; tile the layer if it shows
      const m = (x1 - x0) * (y1 - y0) * 2.25 * s * s > 2e7 ? 0 : 0.25;
      const x = Math.max(-P, x0 - vw * m), y = Math.max(-P, y0 - vh * m);
      const w = Math.min(WORLD.w + P, x1 + vw * m) - x, h = Math.min(WORLD.h + P, y1 + vh * m) - y;
      const c = r?.c ?? document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w * s));
      c.height = Math.max(1, Math.ceil(h * s));
      const main = this.ctx;
      this.ctx = c.getContext('2d')!;
      this.ctx.setTransform(s, 0, 0, s, -x * s, -y * s);
      this.paintRoads(game.terrain, ground, game.graph.nodes, nodes0, game.graph.rings);
      this.ctx = main;
      r = this.roads = { key, isl, t: game.terrain, s, x, y, w, h, c };
    }
    this.ctx.drawImage(r.c, r.x, r.y, r.c.width / r.s, r.c.height / r.s);
  }

  // Ground roads: bridge decks, kerbs, sidewalks with paving joints, boulevard verges, the asphalt (tier outline, fill, grain, tyre
  // wear, repairs, cracks), markings, details, then the static junction paint (islands, stop lines, zebras, signs)
  private paintRoads(terrain: Game['terrain'], ground: Edge[], nodes: Node[], nodes0: Node[], rings: Ring[]): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const e of ground) if (e.bridge) this.bridge(e.a, e.b, terrain, e.width);

    const joints = nodes.filter((n) => n.edges.some((e) => !e.tunnel && e.level === 0));
    const walkJ = joints.map(n => [n, jointEdge(n, 0)] as const).filter((x): x is [Node, Edge] => !!x[1] && walked(x[1]));
    const kerbX = (e: Edge): number => e.type.tier === 'boulevard' ? 16 : 12;
    const band = (col: (e: Edge) => string, extra: (e: Edge) => number, only: (e: Edge) => boolean, edgesOnly = false): void => {
      for (const e of ground) if (walked(e) && only(e)) this.line(e, col(e), e.width + extra(e));
      if (edgesOnly) return;
      for (const [n, j] of walkJ) if (only(j)) this.circle(n.x, n.y, (j.width + extra(j)) / 2, col(j));
    };
    const all = (): boolean => true;
    band(e => e.type.tier === 'street' ? KERB : GRANITE, kerbX, all);
    band(() => WALK, e => kerbX(e) - 2, all);
    // paving joints: thin dashes across the sidewalk band, the road covers their middle
    ctx.lineCap = 'butt';
    ctx.setLineDash([0.45, 3.6]);
    band(() => JOINT, e => kerbX(e) - 2, all, true);
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    band(() => '#C3DAA5', () => 7, e => e.type.tier === 'boulevard');

    // Colours per tier; a joint takes the tier of its widest road; a driveway is a narrower concrete strip. The fill is the tier
    // colour with grain at half a world px
    const pats = new Map<string, CanvasPattern>();
    const fillOf = (c: string): CanvasPattern => {
      let p = pats.get(c);
      if (!p) { pats.set(c, p = ctx.createPattern(grain(c), 'repeat')!); p.setTransform(new DOMMatrix().scale(0.5)); }
      return p;
    };
    const pass = (key: 'out' | 'fill', extra: number): void => {
      const col = (c: string): string | CanvasPattern => key === 'fill' ? fillOf(c) : c;
      // Bridges keep their blue deck as the outline
      for (const e of ground) if (!(extra && e.bridge)) this.line(e, col(e.drive ? DRIVE[key] : TIERS[e.type.tier][key]), e.width + extra - (e.drive ? 4 : 0));
      for (const n of joints) {
        const j = jointEdge(n, 0), color = col(j?.drive ? DRIVE[key] : TIERS[j?.type.tier ?? 'street'][key]);
        this.circle(n.x, n.y, ((j?.width ?? ROAD_W) + extra - (j?.drive ? 4 : 0)) / 2, color);
      }
    };
    pass('out', 3);
    pass('fill', 0);
    // markings stop at the edge of a junction's box
    const cut = (n: Node, o: Node): Vec => {
      const d = junction(n) ? Math.max(...n.edges.map(x => x.drive || x.a === o || x.b === o ? 0 : x.width / 2 + 1)) : 0;
      if (!d) return n;
      const k = Math.min(0.5, d / (Math.hypot(o.x - n.x, o.y - n.y) || 1));
      return { x: n.x + (o.x - n.x) * k, y: n.y + (o.y - n.y) * k };
    };
    // wear: tyre tracks down each lane, now and then a repair patch or a crack
    ctx.lineCap = 'butt';
    for (const e of ground) {
      if (e.drive || e.ring || e.type.tier === 'dirt') continue;
      const ux = (e.b.x - e.a.x) / e.length, uy = (e.b.y - e.a.y) / e.length, A = cut(e.a, e.b), B = cut(e.b, e.a);
      const at = (s: number, o: number): Vec => ({ x: e.a.x + ux * s - uy * o, y: e.a.y + uy * s + ux * o });
      const s0 = Math.hypot(A.x - e.a.x, A.y - e.a.y) + 4, s1 = e.length - Math.hypot(B.x - e.b.x, B.y - e.b.y) - 4;
      ctx.beginPath();
      if (s1 > s0) for (const l of e.lanes) for (const o of [l.offset - 2.2, l.offset + 2.2]) { const p = at(s0, o), q = at(s1, o); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      ctx.strokeStyle = 'rgba(60,60,52,.05)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const h = hash01(e.a.x + e.b.x, e.a.y + e.b.y), l0 = e.lanes[0];
      if (e.length > 50 && h < 0.35 && l0) {
        const p = at(e.length * (0.25 + h), l0.offset);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.atan2(uy, ux) + (h - 0.17) * 0.3);
        ctx.beginPath();
        ctx.rect(-4 - h * 8, -2.6, 8 + h * 16, 5.2);
        ctx.fillStyle = 'rgba(70,70,62,.05)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(70,70,62,.09)';
        ctx.lineWidth = 0.4;
        ctx.stroke();
        ctx.restore();
      } else if (e.length > 40 && h > 0.75) {
        const s = e.length * (h - 0.4), o = (h - 0.875) * e.width * 2;
        this.polyline([at(s, o), at(s + 2, o + 1.2), at(s + 3.5, o + 0.6), at(s + 6, o + 2.2), at(s + 7, o + 1.4)]);
        ctx.strokeStyle = 'rgba(70,70,62,.16)';
        ctx.lineWidth = 0.35;
        ctx.stroke();
      }
    }
    ctx.lineCap = 'round';

    for (const e of ground) if (!e.drive && !e.ring) this.markings(cut(e.a, e.b), cut(e.b, e.a), e.type);
    this.details(ground.filter(e => !e.ring));
    this.controls(nodes0, 'static');
    for (const r of rings) this.island(r);
  }

  // A little model per building (BuildingArt: home with a pitched roof and yard, shop with awning and sign, office tower,
  // saw-tooth factory with a yard), its variant from its position, with a shadow as long as it is tall and smoke off a
  // staffed factory's chimney. Pending trips are dots on the roof in their purpose colour; a building without a road gets a
  // dashed red outline.
  private building(b: Building, time: number): void {
    const ctx = this.ctx, h = b.h / 2, w = b.w / 2, v = variant(b.x, b.y), L = look(b.art, v, h, w), alpha = ctx.globalAlpha;
    const c = Math.cos(b.angle), sn = Math.sin(b.angle), toWorld = (x: number, y: number): Vec => ({ x: b.x + x * c - y * sn, y: b.y + x * sn + y * c });
    // shadow: the body swept down-right by its height (the hull of the body and its offset copy)
    const [bx, by, bw, bh] = L.body, o = L.height;
    const corners = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]].map(([x, y]) => toWorld(x, y));
    this.polyline(hull([...corners, ...corners.map(p => ({ x: p.x + o * 0.7, y: p.y + o }))]), true);
    ctx.fillStyle = 'rgba(30,40,60,.16)';
    ctx.fill();
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    // an empty home (everyone moved out) fades
    if (b.node && b.kind === 'home' && b.residents < 1) ctx.globalAlpha = alpha * 0.45;
    const img = sprite(b.art, v, this.artS, false, b.w, b.h, b.abandoned);
    ctx.drawImage(img, -h - PAD, -w - PAD, img.width / this.artS, img.height / this.artS);
    b.pending.slice(0, Math.floor((2 * w - 6) / 6)).forEach((t, i) => {
      ctx.beginPath();
      ctx.roundRect(-h + 4, -w + 4 + i * 6, 4, 4, 1);
      ctx.fillStyle = PURPOSES[t.purpose].color;
      ctx.fill();
      ctx.strokeStyle = CAR_OUT;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    });
    // a ghost (place tool) has no door node yet
    if (b.node && !b.connected) {
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.roundRect(-h - 3, -w - 3, 2 * h + 6, 2 * w + 6, 6);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    // smoke drifts downwind off the chimney only while the factory has workers
    if (L.chimney && b.staffed > 0) {
      const ch = toWorld(L.chimney.x, L.chimney.y);
      for (let i = 0; i < 4; i++) {
        const t = (time * 0.35 + i / 4) % 1;
        const x = ch.x + t * 24 + Math.sin(t * 6 + i) * 2, y = ch.y - t * 14, r = 2.8 + t * 6;
        ctx.globalAlpha = alpha * 0.75 * (1 - t) * Math.min(1, t * 6);
        this.circle(x, y, r, i % 2 ? '#C4C2BD' : '#B5B3AE');
        this.circle(x - r * 0.3, y - r * 0.3, r * 0.55, '#DEDCD7');
      }
      ctx.globalAlpha = alpha;
    }
  }

  // On-map hint for what the current tool would affect under the cursor. Same lookups as Game.demolishAt / placeControl / snap.
  // Coin pops rise and fade over income; a cleared jam throws a ring of green sparkles
  private juice(game: Game): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of game.fx) {
      const k = Math.min(1, Math.max(0, (game.time - f.at) / FX_LIFE));
      ctx.globalAlpha = 1 - k * k;
      if (f.kind === 'coin') {
        const y = f.y - 14 - 22 * k;
        this.circle(f.x - 9, y, 5, '#E8B23A');
        this.circle(f.x - 9, y, 3, '#F7D774');
        this.text(`+${fmtMoney(f.n)}`, f.x + 6, y, 'bold 10px system-ui', '#2E8B4A');
      } else for (let i = 0; i < 10; i++) {
        const a = i * Math.PI / 5 + f.x, r = 6 + 26 * Math.sqrt(k);
        this.circle(f.x + Math.cos(a) * r, f.y + Math.sin(a) * r, 2.5 * (1 - k) + 0.5, i % 2 ? '#7FD88F' : '#FFFFFF');
      }
    }
    ctx.globalAlpha = 1;
  }

  private hoverFx(game: Game, p: Vec, preview: PathPlan | null): void {
    const ctx = this.ctx, g = game.graph;
    const label = (s: string, x: number, y: number, color: string) => {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      this.text(s, x + 14, y - 10, 'bold 12px system-ui', color);
    };
    // under a building's footprint, clear of its own residents label above it
    const below = (s: string, b: Building, color: string) => {
      ctx.font = 'bold 12px system-ui';
      label(s, b.x - 14 - ctx.measureText(s).width / 2, b.y + Math.max(b.w, b.h) / 2 + 26, color);
    };
    if (game.tool === 'demolish') {
      const b = game.buildingUnder(p);
      if (b) {
        const who = game.occupants(b);
        this.outlineB(b, RED, 4);
        below(game.armed === b ? `Click again: ${who}` : `Demolish ${b.label.toLowerCase()}${b.lots.length ? ' · the lot stays zoned' : ''}`, b, RED);
        return;
      }
      const n = g.ringAt(p, 4)?.hub ?? g.nearestNode(p, NODE_R + 4);
      if (n && n.control !== 'none') {
        this.ring(n.x, n.y, n.control === 'roundabout' ? ringOut(n.ring) + 2 : NODE_R + 6, RED, 3);
        label(`Remove ${CONTROL_LABEL[n.control].toLowerCase()} · +${fmtMoney(game.controlRefund(n))}`, n.x, n.y, RED);
        return;
      }
      const hit = g.nearestEdge(p, ROAD_W, game.level) ?? g.nearestEdge(p, ROAD_W);
      if (!hit) return;
      const e = hit.edge;
      if (exitEdge(e)) { label('The highway to the outside stays', hit.point.x, hit.point.y, RED); return; }
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.6;
      this.line(e, RED, e.width + 6);
      ctx.globalAlpha = 1;
      this.line(e, TIERS[e.type.tier].fill, e.width);
      label(`Demolish · +${fmtMoney(game.refundOf(e))}`, hit.point.x, hit.point.y, RED);
    } else if (game.tool === 'light' || game.tool === 'roundabout') {
      const r = g.ringAt(p, 4), n = r?.hub ?? g.nearestNode(p, NODE_R + 6);
      if (!n) return;
      const kind = game.tool === 'light' ? 'light' : 'roundabout';
      const cost = game.controlPrice(kind) - game.controlRefund(n), ring = kind === 'roundabout';
      const here = n.control === kind && (!ring || n.ring === game.ringSize);
      const reason = n.building || (!r && n.edges.length < 3) ? 'Needs an intersection (3+ roads)'
        : ring && !here && game.ringRoom(n, game.ringSize) || (!here && cost > game.money ? 'Not enough money' : null);
      // a roundabout previews the ring of the chosen size
      this.ring(n.x, n.y, ring ? ringOut(game.ringSize) + 2 : NODE_R + 6, reason ? RED : GREEN, 3);
      const what = !ring ? 'Place traffic light' : `${n.control === kind ? 'Resize to' : 'Place'} ${RINGS[game.ringSize].label.toLowerCase()} roundabout`;
      const place = here ? 'Already here' : `${what} · ${cost < 0 ? '+' : ''}${fmtMoney(Math.abs(cost))}`;
      label(reason ? '⚠ ' + reason : place, n.x, n.y, reason ? RED : '#2E8B4A');
    } else if (game.tool === 'road') {
      // a node or road of another level: the road ramps from there to the dock level
      const s = game.snapEnd(p), L = game.levelAt(s);
      if (!s.node && !s.edge) return;
      this.ring(s.point.x, s.point.y, NODE_R, ROAD_OUT, 2);
      label(L === game.level ? 'Start here' : `Ramp from ${L ? `L${L}` : 'the ground'}`, s.point.x, s.point.y, DARK);
    } else if (game.tool === 'grid') {
      label('Click the first corner', p.x, p.y, DARK);
    } else if (game.tool === 'interchange') {
      // the picked junction (or the one under the cursor); its reason when no ghost can be drawn
      const n = game.ichg?.node ?? game.junctionAt(p);
      if (!n) { label('Click a junction of 3 or 4 roads', p.x, p.y, DARK); return; }
      this.ring(n.x, n.y, hubR(n), preview?.ok ? GREEN : RED, 2);
      if (!preview) label('⚠ Needs a junction of 3 or 4 roads', n.x, n.y, RED);
      else if (!preview.segs.length) label('⚠ ' + preview.reason, n.x, n.y, RED);
      else if (!game.ichg) label('Click to pick an interchange', n.x, n.y + 18, ACCENT);
    } else if (game.tool === 'place') {
      this.ghost(game, p);
    } else if (game.tool === 'zone') {
      // where a drag would start, and whether it paints or erases
      const hit = g.nearestEdge(p, TUNING.BRUSH_R, 0), on = lotAt(game, p), z = game.zone;
      if (!hit || hit.edge.drive || hit.edge.ring || !TIERS[hit.edge.type.tier].access) { label('Drag along a road to zone its sides', p.x, p.y, DARK); return; }
      this.ring(hit.point.x, hit.point.y, NODE_R, z ? ZONES[z].out : RED, 2.5);
      label(!z ? 'Drag over lots to unzone them' : on?.zone === z ? `Drag to erase ${ZONE_NAME[z]} lots` : `Drag along the road to paint ${ZONE_NAME[z]} · Shift: one side`,
        hit.point.x, hit.point.y, z ? DARK : RED);
    } else if (game.tool === 'edit') {
      // same order as Game.select: car, junction, building, road
      const c = game.carAt(p);
      if (c) {
        const q = g.carPos(c);
        this.ring(q.x, q.y, 14, ACCENT, 2);
        label('Click to follow this car', q.x, q.y, ACCENT);
        return;
      }
      const j = game.junctionAt(p);
      if (j) {
        this.ring(j.x, j.y, hubR(j), ACCENT, 1.5);
        label(j.control === 'roundabout' ? 'Click to edit roundabout: size, control' : 'Click to edit junction: control, phases, lanes', j.x, j.y, ACCENT);
        return;
      }
      const b = game.buildingUnder(p);
      if (b) {
        this.outlineB(b, ACCENT, 4);
        below(`${b.label}: click for details${b.lots.length ? '' : ' · drag to move'}`, b, ACCENT);
        return;
      }
      const run = game.runAt(p);
      if (!run) return;
      ctx.globalAlpha = 0.25;
      this.runPath(run, ACCENT);
      ctx.globalAlpha = 1;
      label('Click to edit · drag to bend', p.x, p.y, ACCENT);
    }
  }

  // Outside connections: past the gate the highway runs on off the map under a fade, with an arrow out and one in, and a green
  // sign at the edge; an exit no town road reaches yet pulses at its stub's end with what linking it brings
  private exits(game: Game): void {
    const ctx = this.ctx, gates = game.buildings.filter(b => b.kind === 'gate');
    if (!gates.length) return;
    const linked = new Set(game.linkedExits()), pulse = Math.sin(performance.now() / 250);
    for (const b of gates) {
      const d = b.node, e = d.edges[0], ux = Math.cos(b.angle), uy = Math.sin(b.angle);
      if (!e) continue;
      const w = e.width, at = (s: number, o: number): Vec => ({ x: d.x + ux * s - uy * o, y: d.y + uy * s + ux * o }), far = at(-110, 0);
      ctx.lineCap = 'butt';
      this.seg(d, far, TIERS.highway.out, w + 3);
      this.seg(d, far, TIERS.highway.fill, w);
      this.markings(d, far, e.type);
      const fade = ctx.createLinearGradient(d.x, d.y, far.x, far.y);
      fade.addColorStop(0, this.land + '00');
      fade.addColorStop(0.7, this.land);
      this.seg(at(-8, 0), far, fade, w + 6);
      ctx.lineCap = 'round';
      // inbound traffic keeps right: its lane is at +o heading in (+s), the outbound one at -o heading out
      for (const k of [1, -1]) {
        const p = at(-26, k * LANE_W), tip = at(-26 + k * 7, k * LANE_W), l = at(-26 - k * 4, k * LANE_W + 5), r = at(-26 - k * 4, k * LANE_W - 5);
        this.polyline([tip, l, p, r], true);
        ctx.fillStyle = k > 0 ? GREEN : '#2F8F5B';
        ctx.fill();
      }
      // highway sign beside the inbound lane, square to the screen: green board on two legs, a blue shield and the direction
      const s = at(36, w / 2 + 30), name = ['WEST', 'NORTH', 'EAST', 'SOUTH'][(Math.round(b.angle / (Math.PI / 2)) + 4) % 4];
      for (const k of [-18, 18]) this.seg({ x: s.x + k, y: s.y + 8 }, { x: s.x + k + 1, y: s.y + 16 }, '#6E6E6A', 1.6);
      const board = (dx: number, dy: number, fill: string, r = 3.5): void => {
        ctx.beginPath();
        ctx.roundRect(s.x - 32 + dx, s.y - 11 + dy, 64 - 2 * dx, 22 - 2 * dy, r);
        ctx.fillStyle = fill;
        ctx.fill();
      };
      ctx.save();
      ctx.translate(2, 3);
      board(0, 0, 'rgba(0,0,0,.18)');
      ctx.restore();
      board(0, 0, '#1E7A4A');
      ctx.beginPath();
      ctx.roundRect(s.x - 30.5, s.y - 9.5, 61, 19, 2.5);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.stroke();
      // shield: flat top, pointed bottom
      const hx = s.x - 21, hy = s.y;
      ctx.beginPath();
      ctx.moveTo(hx - 5.5, hy - 6);
      ctx.lineTo(hx + 5.5, hy - 6);
      ctx.lineTo(hx + 5.5, hy + 1);
      ctx.quadraticCurveTo(hx + 5.5, hy + 5, hx, hy + 7);
      ctx.quadraticCurveTo(hx - 5.5, hy + 5, hx - 5.5, hy + 1);
      ctx.closePath();
      ctx.fillStyle = '#2F5FB3';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 6px system-ui';
      ctx.fillText('H', hx, hy - 0.5);
      ctx.font = 'bold 8px system-ui';
      ctx.fillText(name, s.x + 6, s.y - 3);
      ctx.font = '5.5px system-ui';
      ctx.fillText('HIGHWAY EXIT', s.x + 6, s.y + 5);
      if (linked.has(b)) continue;
      const o = e.a === d ? e.b : e.a;
      ctx.setLineDash([5, 4]);
      this.ring(o.x, o.y, w / 2 + 8 + 2 * pulse, ACCENT, 2);
      ctx.setLineDash([]);
      const k = w / 2 + 24 + 58 * Math.abs(ux), q = { x: o.x + ux * k, y: o.y + uy * k };
      this.text('Connect a road here', q.x, q.y - 7, 'bold 11px system-ui', ACCENT);
      this.text('exports, imports and visitors', q.x, q.y + 7, '10px system-ui', DARK);
    }
  }

  // Rounded outline pad px around a building's footprint
  private outlineB(b: Building, color: string, pad: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.beginPath();
    ctx.roundRect(-b.h / 2 - pad, -b.w / 2 - pad, b.h + 2 * pad, b.w + 2 * pad, 4 + pad);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Heat map over one level: each road stroked green -> amber -> red by its heat; junctions with waiting cars get a disc sized and
  // coloured by their delay (8 s and more = red)
  private heatMap(edges: Edge[], nodes: Node[]): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.75;
    for (const e of edges) if (!e.tunnel) this.line(e, heatColor(e.heat), e.width + 4);
    for (const n of nodes) {
      if (n.delay < 0.5) continue;
      this.circle(n.x, n.y, NODE_R * 0.6 + Math.min(18, 2 * n.delay), heatColor(n.delay / 8));
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Noise and pollution, under the roads: a purple band NOISE_R either side of each road by its tier's noise (one path per tier, so
  // joints do not darken), and a brown haze fading out at its tier's pollution reach round each factory while it has workers
  private noiseMap(game: Game): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.strokeStyle = NOISE;
    for (const t of Object.keys(TIERS) as RoadType['tier'][]) {
      const es = game.graph.edges.filter(e => e.type.tier === t && !e.drive && !e.tunnel);
      if (!es.length) continue;
      ctx.beginPath();
      for (const e of es) { ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); }
      ctx.globalAlpha = 0.25 * TIERS[t].noise;
      for (const w of [2, 1]) { ctx.lineWidth = w * TUNING.NOISE_R; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    for (const b of game.buildings) {
      const R = b.def.pollution;
      if (!R || b.staffed <= 0) continue;
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, R);
      g.addColorStop(0, SMOG + Math.round(0x66 * b.staffed).toString(16).padStart(2, '0'));
      g.addColorStop(1, SMOG + '00');
      ctx.beginPath();
      ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  // Place tool: the held building, faded, with a green / red footprint outline, its door, the driveway it would get, a dashed
  // pollution ring for a factory, and a label: the reason it cannot go there, else what its residents will dislike, else its name
  private ghost(game: Game, p: Vec): void {
    const plan = game.planPlace(p);
    if (!plan) return;
    const ctx = this.ctx, b = plan.b, col = plan.ok ? GREEN : RED, door = b.door();
    if (b.def.pollution) {
      ctx.setLineDash([6, 6]);
      ctx.globalAlpha = 0.6;
      this.ring(b.x, b.y, b.def.pollution, ZONES.industry.out, 1.5);
      ctx.setLineDash([]);
    }
    if (plan.road) {
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.8;
      this.seg(door, plan.road, ROAD_OUT, 2);
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 0.6;
    this.building(b, game.time);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.beginPath();
    ctx.roundRect(-b.h / 2 - 2, -b.w / 2 - 2, b.h + 4, b.w + 4, 5);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    this.circle(door.x, door.y, 3.5, '#FFFFFF');
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const y = b.y - Math.max(b.w, b.h) / 2 - 10;
    if (!plan.ok) this.text(plan.reason, b.x, y, 'bold 12px system-ui', RED);
    else if (plan.warn) this.text(plan.warn, b.x, y, 'bold 12px system-ui', '#A86A00');
    else this.text(plan.label, b.x, y, 'bold 12px system-ui', '#2E8B4A');
  }

  // Tier centre (two-way: yellow line, green median or double gray line; dirt has none), dashed separators between
  // same-direction lanes, solid shoulder lines (highway), chevrons a->b (one-way)
  private markings(a: Vec, b: Vec, t: RoadType): void {
    const ctx = this.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const tier = TIERS[t.tier], m = t.oneWay ? 0 : tier.median / 2;
    const at = (o: number, f: (p: Vec, q: Vec) => void) => f({ x: a.x - uy * o, y: a.y + ux * o }, { x: b.x - uy * o, y: b.y + ux * o });
    ctx.lineCap = 'butt';
    const W = roadWidth(t) / 2;
    // highway: darker shoulders, a guardrail on posts outside each edge
    if (t.tier === 'highway') {
      for (const s of [1, -1]) {
        at(s * (W - tier.shoulder / 2), (p, q) => this.seg(p, q, 'rgba(90,100,115,.07)', tier.shoulder));
        at(s * (W + 3), (p, q) => {
          this.seg({ x: p.x + 0.6, y: p.y + 0.9 }, { x: q.x + 0.6, y: q.y + 0.9 }, 'rgba(0,0,0,.12)', 1.2);
          ctx.setLineDash([0.8, 5]);
          this.seg(p, q, '#6F7884', 2);
          ctx.setLineDash([]);
          this.seg(p, q, '#B9C1CB', 0.9);
        });
      }
    }
    if (!t.oneWay && tier.line === 'yellow') { for (const o of [0.9, -0.9]) at(o, (p, q) => this.seg(p, q, YELLOW, 0.9)); }
    else if (!t.oneWay && tier.line === 'median') {
      // raised median: kerb, grass, a small tree every 24px clear of its ends
      this.seg(a, b, GRANITE, tier.median);
      this.seg(a, b, '#B9D59B', tier.median - 1.4);
      for (let s = 22; s <= len - 22; s += 24) {
        const p = { x: a.x + ux * s, y: a.y + uy * s }, h = hash01(p.x, p.y);
        this.circle(p.x + 1.2, p.y + 1.7, 2.6, 'rgba(30,50,30,.16)');
        tree(ctx, p, 2.2 + h * 0.6, 'round', this.treeCol, (h - 0.5) * 0.12, h * 6);
      }
      ctx.lineCap = 'butt';
    } else if (!t.oneWay && tier.line === 'double') {
      // concrete barrier down the middle
      this.seg(a, b, '#A9A69E', 3.2);
      this.seg(a, b, '#E2DFD8', 2.2);
      this.seg(a, b, '#C4C1B9', 0.5);
    }
    if (tier.shoulder >= 1.5) {
      const o = W - tier.shoulder;
      for (const s of [o, -o]) at(s, (p, q) => this.seg(p, q, '#C9C9C5', 0.9));
    }
    const offs: number[] = [];
    for (let k = 1; k < t.lanes; k++) {
      if (t.oneWay) offs.push((k - t.lanes / 2) * LANE_W);
      else offs.push(k * LANE_W + m, -k * LANE_W - m);
    }
    if (offs.length) {
      ctx.setLineDash([6, 6]);
      for (const o of offs) at(o, (p, q) => this.seg(p, q, '#C9C9C5', 1));
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'round';
    if (!t.oneWay) return;
    ctx.beginPath();
    for (let s = Math.min(20, len / 2); s < len; s += 40) {
      const x = a.x + ux * s, y = a.y + uy * s;
      ctx.moveTo(x - ux * 3 - uy * 3, y - uy * 3 + ux * 3);
      ctx.lineTo(x + ux * 2, y + uy * 2);
      ctx.lineTo(x - ux * 3 + uy * 3, y - uy * 3 - ux * 3);
    }
    ctx.strokeStyle = ROAD_OUT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private polyline(pts: Vec[], close = false): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
  }

  // Tunnel portal at p, facing q: dark rounded block with a lighter inner arch
  private portal(p: Vec, q: Vec, w: number): void {
    const ctx = this.ctx;
    const W = w + 6;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(q.y - p.y, q.x - p.x));
    ctx.beginPath();
    ctx.roundRect(NODE_R - 3, -W / 2, 6, W, 2);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(NODE_R, -(w - 2) / 2, 3, w - 2, 1.5);
    ctx.fillStyle = '#6E6E6A';
    ctx.fill();
    ctx.restore();
  }

  // Bridge deck from a to b; the caller draws the white road fill on top
  private bridge(a: Vec, b: Vec, terrain: Game['terrain'], w: number): void {
    const ctx = this.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const at = (s: number, off: number): Vec => ({ x: a.x + ux * s - uy * off, y: a.y + uy * s + ux * off });
    const half = (w + 6) / 2;

    // Pillars: 2-3 evenly spaced over the wet stretch, peeking out on both sides
    let s0 = -1, s1 = -1;
    for (let s = 0; s <= len; s += 4) {
      if (!inWater(terrain, at(s, 0))) continue;
      if (s0 < 0) s0 = s;
      s1 = s;
    }
    if (s0 >= 0) {
      const n = s1 - s0 > 60 ? 3 : 2;
      for (let i = 1; i <= n; i++) {
        const s = s0 + ((s1 - s0) * i) / (n + 1);
        for (const off of [half, -half]) {
          const p = at(s, off);
          this.circle(p.x, p.y, 3, PILLAR);
        }
      }
    }

    // the deck's shadow on the water, then the deck
    this.seg({ x: a.x + 2.5, y: a.y + 3.5 }, { x: b.x + 2.5, y: b.y + 3.5 }, 'rgba(30,50,90,.18)', w + 6);
    this.seg(a, b, BRIDGE, w + 6);
    ctx.beginPath();
    for (let s = 6; s < len; s += 12) {
      const p = at(s, half), q = at(s, -half);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = RAIL;
    ctx.lineWidth = 1;
    ctx.stroke();
    // railings: posts every 4px under a lighter top rail
    const rail = half - 1.5;
    ctx.lineCap = 'butt';
    for (const o of [rail, -rail]) {
      ctx.setLineDash([1, 3]);
      this.seg(at(0, o), at(len, o), RAIL, 2.2);
      ctx.setLineDash([]);
      this.seg(at(0, o), at(len, o), '#A9B6C6', 0.8);
    }
    ctx.lineCap = 'round';
  }

  // Intersection markings (stop lines) and traffic lights
  // part: 'static' (stop lines, zebras, signs: the cached layer), 'live' (lights), 'all'
  private controls(nodes: Node[], part: 'static' | 'live' | 'all'): void {
    const ctx = this.ctx;
    for (const n of nodes) {
      if (part !== 'static' && n.control === 'light') this.drawLights(n);
      if (part === 'live' || !junction(n)) continue;
      // Stop line across the lanes coming in: solid at a light or stop sign, dashed at a give-way, a plain junction or a ring entry
      const d0 = NODE_R + 3.6, solid = n.control === 'light' || n.control === 'stop';
      // a light's zebra starts past the widest road crossing the arm, its stop line just behind it. ponytail: cars still stop at
      // stopDist, so on a street meeting an avenue they halt a few px past the line
      const zb = zebraAt(n);
      const zebra = (e: Edge): number => zb ? Math.max(d0 - 5.5, ...n.edges.map(o => o === e || o.drive ? 0 : o.width / 2 + 0.5)) : 0;
      const at = (e: Edge): number => zb ? Math.max(d0, zebra(e) + 5.2) : d0;
      ctx.setLineDash(solid ? [] : [2, 1.6]);
      ctx.strokeStyle = solid ? '#8F8F8B' : '#B4B4B0';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const e of n.edges) {
        if (e.drive || e.ring || (e.type.oneWay && e.a === n)) continue;
        const [ux, uy] = this.dir(n, e), d = at(e);
        const x = n.x + ux * d, y = n.y + uy * d, h = e.width / 2 - 0.5, h0 = e.type.oneWay ? -h : TIERS[e.type.tier].median / 2;
        ctx.moveTo(x + uy * h0, y - ux * h0);
        ctx.lineTo(x + uy * h, y - ux * h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // Zebra crossing on every arm of a busy junction, just inside the stop line
      if (zb) {
        ctx.beginPath();
        for (const e of n.edges) {
          if (e.drive) continue;
          const [ux, uy] = this.dir(n, e), h = e.width / 2 - 1, z0 = zebra(e), z1 = z0 + 4.2;
          for (let o = -h + 1; o <= h - 1; o += 3) {
            ctx.moveTo(n.x + ux * z0 + uy * o, n.y + uy * z0 - ux * o);
            ctx.lineTo(n.x + ux * z1 + uy * o, n.y + uy * z1 - ux * o);
          }
        }
        ctx.strokeStyle = '#C6C6C1';
        ctx.lineWidth = 1.7;
        ctx.stroke();
      }
      ctx.lineCap = 'round';
      if (n.control === 'yield' || n.control === 'stop') this.drawSigns(n);
    }
  }

  // Roundabout centre: a cobbled truck apron, a kerb, a planted island with shrubs round it and, by the profile's decor (Achievements.ts),
  // a tree on grass, a flower bed, a fountain or a statue in the middle
  private island(ring: Ring): void {
    const ctx = this.ctx, n = ring.hub, R = RINGS[n.ring].r - RING_W / 2, g = shade(this.land, -0.12), decor = profile().cosmetics.island;
    this.circle(n.x, n.y, R, '#D9D3C5');
    ctx.setLineDash([1.2, 1.2]);
    this.ring(n.x, n.y, R - 1.3, '#C4BDAD', 1.4);
    ctx.setLineDash([]);
    this.circle(n.x, n.y, R - 2.6, GRANITE);
    this.circle(n.x, n.y, R - 3.4, g);
    const m = Math.max(4, Math.floor(R / 2.6));
    for (let i = 0; i < m; i++) {
      const a = (i / m) * Math.PI * 2 + 0.3, p = { x: n.x + Math.cos(a) * R * 0.74, y: n.y + Math.sin(a) * R * 0.74 };
      this.circle(p.x + 0.8, p.y + 1.1, 1.8, 'rgba(30,50,30,.14)');
      tree(ctx, p, 1.6 + (i % 3) * 0.25, i % 4 === 3 ? 'blossom' : 'round', this.treeCol, (i % 3 - 1) * 0.06, a);
    }
    const r = Math.min(5.5, R * 0.3);
    if (decor === 'fountain') {
      this.circle(n.x, n.y, R * 0.5, '#CFC8B8');
      this.circle(n.x, n.y, R * 0.5 - 1.2, '#5FA8D6');
      this.ring(n.x, n.y, R * 0.3, '#9FD3F0', 0.8);
      this.circle(n.x, n.y, r * 0.5, '#CFC8B8');
      this.circle(n.x, n.y, r * 0.25, '#E8F6FF');
      return;
    }
    if (decor === 'statue') {
      this.circle(n.x, n.y, R * 0.42, '#C9C2B2');
      ctx.fillStyle = '#A9A293';
      ctx.fillRect(n.x - r * 0.6, n.y - r * 0.6, r * 1.2, r * 1.2);
      this.circle(n.x + 0.8, n.y + 1.2, r * 0.45, 'rgba(30,40,40,.25)');
      this.circle(n.x, n.y, r * 0.45, '#5E8C7E');
      this.circle(n.x - r * 0.12, n.y - r * 0.12, r * 0.2, '#7FB0A0');
      return;
    }
    if (decor === 'grass') {
      this.circle(n.x + 1.6, n.y + 2.3, r + 0.4, 'rgba(30,50,30,.18)');
      tree(ctx, n, r, 'round', this.treeCol, 0.02, n.id);
      return;
    }
    this.circle(n.x, n.y, R * 0.5, '#B89A74');
    this.circle(n.x, n.y, R * 0.5 - 0.8, '#A6875F');
    const k = Math.floor(R * 0.9);
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2, f = ['#F28DB2', '#FFD45C', '#FFFFFF', '#B79CF2'][i % 4];
      this.circle(n.x + Math.cos(a) * R * 0.34, n.y + Math.sin(a) * R * 0.34, 0.8, f);
    }
    this.circle(n.x + 1.6, n.y + 2.3, r + 0.4, 'rgba(30,50,30,.18)');
    tree(ctx, n, r, 'round', this.treeCol, 0.02, n.id);
  }

  // One elevated layer: ground shadow, pillars, blue-grey deck, white body, railings, centre line
  private viaduct(level: number, edges: Edge[], joints: Node[]): void {
    const ctx = this.ctx;
    // Shadow cast down-right, further and softer the higher the deck: a faint wide band and a core. One path per width so
    // overlapping shadows do not darken each other
    ctx.save();
    ctx.translate(level * 3, level * 4.5);
    // ponytail: one path per width; shadows of different widths overlapping darken slightly
    for (const w of new Set(edges.map((e) => e.width))) {
      ctx.beginPath();
      for (const e of edges) {
        if (e.width !== w) continue;
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
      }
      ctx.strokeStyle = 'rgba(20,30,50,.06)';
      ctx.lineWidth = w + 10 + level * 2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(20,30,50,.12)';
      ctx.lineWidth = w + 4;
      ctx.stroke();
    }
    ctx.restore();

    // Pillars, each with its own shadow down to the ground
    for (const e of edges) {
      const off = e.width / 2 + 2;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      for (let s = 20; s < len; s += 40) {
        const x = e.a.x + ux * s, y = e.a.y + uy * s;
        for (const k of [1, -1]) {
          const px = x - k * uy * off, py = y + k * ux * off;
          this.seg({ x: px, y: py }, { x: px + level * 3, y: py + level * 4.5 }, 'rgba(20,30,50,.12)', 3);
          this.circle(px, py, 2.6, PILLAR);
          this.circle(px - 0.6, py - 0.6, 1.3, '#A7B4C5');
        }
      }
    }

    // color null: the tier fill of the joint's widest road
    const joint = (color: string | null, extra: number): void => {
      for (const n of joints) {
        const j = jointEdge(n, level), c = color ?? TIERS[j?.type.tier ?? 'street'].fill;
        this.circle(n.x, n.y, ((j?.width ?? ROAD_W) + extra) / 2, c);
      }
    };
    for (const e of edges) this.line(e, BRIDGE, e.width + 5);
    joint(BRIDGE, 5);
    for (const e of edges) this.line(e, TIERS[e.type.tier].fill, e.width);
    for (const e of edges) this.rails(e.a, e.b, e.width);
    // Joints after the railings keep junctions open
    joint(null, 0);
    for (const e of edges) this.markings(e.a, e.b, e.type);
  }

  // Viaduct railings on both sides of a to b
  private rails(a: Vec, b: Vec, w: number): void {
    const ctx = this.ctx, dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const o = w / 2 + 1;
    const px = (-dy / len) * o, py = (dx / len) * o;
    for (const k of [1, -1]) {
      const p = { x: a.x + k * px, y: a.y + k * py }, q = { x: b.x + k * px, y: b.y + k * py };
      this.seg(p, q, RAIL, 1.2);
      ctx.setLineDash([0.8, 3.5]);
      this.seg(p, q, '#3F4C5E', 2);
      ctx.setLineDash([]);
    }
  }

  // A cached model (VehicleArt) on a soft shadow cast down-right, then the live lights: tail lights (bright while braking), the
  // indicator blinking on game time (so pause freezes it) and an ambulance's red / blue bar
  private car(game: Game, car: Car): void {
    const ctx = this.ctx, p = game.graph.carPos(car), k = car.kind, h = car.len / 2, w = VW[k] / 2, s = this.artS;
    this.seen.push(car);
    this.seenAt.push(p);
    const c = Math.cos(p.angle), sn = Math.sin(p.angle), img = vehicle(k, car.paint, s), sh = vshadow(k, s);
    const x0 = -h - VPAD, y0 = -VH / 2, dw = img.width / s, dh = img.height / s;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    // the world offset (1.2, 1.8) turned into the car's frame
    ctx.drawImage(sh, x0 + 1.2 * c + 1.8 * sn, y0 - 1.2 * sn + 1.8 * c, dw, dh);
    ctx.drawImage(img, x0, y0, dw, dh);
    ctx.fillStyle = car.brake ? BRAKE_ON : BRAKE_OFF;
    if (k === 'moto') ctx.fillRect(-h - 0.4, -0.6, 1.2, 1.2);
    else { ctx.fillRect(-h - 0.4, -w + 0.6, 1.3, 1.6); ctx.fillRect(-h - 0.4, w - 2.2, 1.3, 1.6); }
    if (car.blink && (game.time * 3 | 0) % 2) {
      const sy = car.blink > 0 ? w - 1.5 : -w - 0.5;
      ctx.fillStyle = AMBER;
      ctx.fillRect(-h - 1, sy, 2, 2);
      ctx.fillRect(h - 1, sy, 2, 2);
    }
    // a VIP convoy car: a gold pennant on the roof
    if (car.trip.vip) {
      ctx.fillStyle = YELLOW;
      ctx.fillRect(-2, -w + 1, 4, 2 * w - 2);
      ctx.fillStyle = CAR_OUT;
      ctx.fillRect(-0.5, -w + 1, 1, 2 * w - 2);
    }
    if (k === 'ambulance') {
      const on = (game.time * 4 | 0) % 2;
      ctx.fillStyle = on ? RED : ACCENT;
      ctx.fillRect(h - 7.4, -w + 0.8, 1.5, w - 0.8);
      ctx.fillStyle = on ? ACCENT : RED;
      ctx.fillRect(h - 7.4, 0, 1.5, w - 0.8);
    }
    // trip purpose as a roof dot, only when asked (Purpose toggle or the traffic overlay): paint is just paint
    if (game.purposeDots || game.overlay === 'heat') {
      const bx = k === 'truck' ? -3.5 : k === 'moto' ? -1.2 : -1;
      ctx.beginPath();
      ctx.arc(bx, 0, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx, 0, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = PURPOSES[car.trip.purpose].color;
      ctx.fill();
    }
    ctx.restore();
  }

  // Night, added over the tint: warm pools under the street lamps, lit windows, headlight beams and the red glow of brake lights
  private night(game: Game, d: Daylight, ground: Edge[]): void {
    if (d.night < 0.02) return;
    const ctx = this.ctx, s = Math.min(2, this.artS), gl = glow(s), bm = beam(s), R = GLOW_R;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = d.night * 0.85;
    this.lamps(ground, (x, y) => ctx.drawImage(gl, x - R, y - R, 2 * R, 2 * R));
    ctx.globalAlpha = d.night;
    for (const b of game.buildings) {
      if (b.kind === 'gate' || b.abandoned || (b.kind === 'home' && b.residents < 1)) continue;
      const img = sprite(b.art, variant(b.x, b.y), this.artS, true, b.w, b.h);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle);
      ctx.drawImage(img, -b.h / 2 - PAD, -b.w / 2 - PAD, img.width / this.artS, img.height / this.artS);
      ctx.restore();
    }
    for (let i = 0; i < this.seen.length; i++) {
      const car = this.seen[i], p = this.seenAt[i], h = car.len / 2, w = VW[car.kind] / 2, f = car.kind === 'moto' ? 0.6 : 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.drawImage(bm, h - 1, -BEAM_W * f / 2, BEAM_L * f, BEAM_W * f);
      if (car.brake) { ctx.fillStyle = 'rgba(255,50,40,.6)'; ctx.fillRect(-h - 2.5, -w, 2.5, 2 * w); }
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
    // signal heads stay readable: redrawn over the tint as the night deepens
    ctx.globalAlpha = d.night;
    for (const n of game.graph.nodes) if (n.control === 'light') this.drawLights(n);
    ctx.globalAlpha = 1;
  }

  // Street lamps on the verge of town roads and highways: one per link of 34px or more (a home-lined road is cut into ~40px
  // links), one per 70px on longer ones, sides alternating
  private lamps(edges: Edge[], f: (x: number, y: number) => void): void {
    for (const e of edges) {
      if (e.drive || e.bridge || e.type.tier === 'dirt' || e.length < 34) continue;
      const n = Math.max(1, Math.floor(e.length / 70)), ux = (e.b.x - e.a.x) / e.length, uy = (e.b.y - e.a.y) / e.length;
      for (let i = 0; i < n; i++) {
        const t = e.length * (i + 0.5) / n, o = ((e.id + i) & 1 ? 1 : -1) * (e.width / 2 + 3.5);
        f(e.a.x + ux * t - uy * o, e.a.y + uy * t + ux * o);
      }
    }
  }

  // Painted lane arrows into each junction (the turns its roads and its lane arrows allow): live, junction plans change them
  private laneArrows(edges: Edge[]): void {
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = ctx.fillStyle = PAINT;
    ctx.lineWidth = 1.1;
    for (const e of edges) {
      if (e.drive || e.tunnel) continue;
      for (const n of [e.a, e.b]) {
        if (!junction(n) || e.length < NODE_R + 40) continue;
        const [ux, uy] = this.dir(n, e), tx = -ux, ty = -uy;
        let turns = 0;
        for (const o of n.edges) {
          if (o === e || o.drive || (o.type.oneWay && o.a !== n)) continue;
          const [vx, vy] = this.dir(n, o), a = Math.atan2(tx * vy - ty * vx, tx * vx + ty * vy);
          turns |= Math.abs(a) < 0.6 ? 2 : a > 0 ? 4 : 1;
        }
        if (!turns) continue;
        // each lane: the turns there are, within its lane connections (set or auto)
        const m = this.arrowsOf(n, e);
        let j = 0;
        for (const l of e.lanes) {
          if (l.to !== n) continue;
          const t = turns & (m ? m[j] : 7);
          j++;
          if (!t) continue;
          ctx.save();
          ctx.translate(n.x + ux * (NODE_R + 22) + uy * l.offset, n.y + uy * (NODE_R + 22) - ux * l.offset);
          ctx.rotate(Math.atan2(ty, tx));
          this.arrow(t);
          ctx.restore();
        }
      }
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  // Static road details: a manhole on every third road, kerb drains, lamp posts, and street trees on boulevard verges
  private details(edges: Edge[]): void {
    const ctx = this.ctx;
    for (const e of edges) {
      if (e.drive || e.tunnel || e.type.tier === 'dirt') continue;
      const ux = (e.b.x - e.a.x) / e.length, uy = (e.b.y - e.a.y) / e.length;
      const at = (s: number, o: number): Vec => ({ x: e.a.x + ux * s - uy * o, y: e.a.y + uy * s + ux * o });
      if (!e.bridge && e.length >= 50 && !(e.id % 3)) {
        const p = at(e.length * 0.62, e.type.oneWay ? 0 : e.width / 4);
        this.circle(p.x, p.y, 1.9, '#9C9C97');
        this.circle(p.x, p.y, 1.4, '#C9C9C4');
        ctx.beginPath();
        for (const k of [-0.7, 0, 0.7]) { ctx.moveTo(p.x - 1, p.y + k); ctx.lineTo(p.x + 1, p.y + k); }
        ctx.strokeStyle = '#A3A39E';
        ctx.lineWidth = 0.3;
        ctx.stroke();
      }
      // drains in the gutter, one side per road
      if (walked(e) && e.length >= 40) {
        const side = e.id & 1 ? 1 : -1, p = at(e.length * 0.4, side * (e.width / 2 - 1.3));
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.atan2(uy, ux));
        ctx.fillStyle = '#7D7D78';
        ctx.fillRect(-2, -0.9, 4, 1.8);
        ctx.fillStyle = '#B4B4AE';
        for (let k = -1.5; k < 2; k += 1) ctx.fillRect(k, -0.6, 0.45, 1.2);
        ctx.restore();
      }
      // street trees on the verge: clear of junctions and driveways
      if (e.type.tier === 'boulevard' && !e.bridge) {
        const clear = (n: Node): number => junction(n) ? NODE_R + 16 : n.edges.some(x => x.drive) ? 13 : 4;
        const s0 = clear(e.a), s1 = e.length - clear(e.b);
        for (let s = s0 + ((e.id * 7) % 10); s <= s1; s += 24) {
          for (const k of [1, -1]) {
            const p = at(s, k * (e.width / 2 + 4.5)), h = hash01(p.x, p.y);
            this.circle(p.x + 1.4, p.y + 2, 3.3, 'rgba(30,50,30,.16)');
            tree(ctx, p, 2.9 + h * 0.8, 'round', this.treeCol, (h - 0.5) * 0.12, h * 6);
          }
        }
      }
    }
    this.lamps(edges, (x, y) => { this.circle(x + 0.7, y + 1, 1.5, 'rgba(0,0,0,.16)'); this.circle(x, y, 1.4, '#5E646C'); this.circle(x - 0.3, y - 0.3, 0.7, '#F3EED8'); });
  }

  // Lane arrow in its local frame (+x toward the junction): a shaft and a head per allowed turn (bits: 1 left, 2 straight, 4 right)
  private arrow(turns: number): void {
    const ctx = this.ctx;
    const head = (x: number, y: number, dx: number, dy: number): void => {
      ctx.moveTo(x + dx * 2.2, y + dy * 2.2);
      ctx.lineTo(x - dy * 1.7, y + dx * 1.7);
      ctx.lineTo(x + dy * 1.7, y - dx * 1.7);
      ctx.closePath();
    };
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(turns & 2 ? 2.5 : 0, 0);
    for (const k of [-1, 1]) if (turns & (k > 0 ? 4 : 1)) { ctx.moveTo(-0.5, 0); ctx.lineTo(1.4, k * 1.9); }
    ctx.stroke();
    ctx.beginPath();
    if (turns & 2) head(2.5, 0, 1, 0);
    for (const k of [-1, 1]) if (turns & (k > 0 ? 4 : 1)) head(1.4, k * 1.9, 0.6, k * 0.8);
    ctx.fill();
  }

  private seg(a: Vec, b: Vec, color: string | CanvasGradient, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // One translucent stroke over a whole run (a per-edge stroke shows overlapping round caps on curves)
  private runPath(run: Edge[], color: string): void {
    if (!run.length) return;
    const ctx = this.ctx;
    ctx.beginPath();
    for (const e of run) { ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(...run.map(e => e.width)) + 8;
    ctx.stroke();
  }

  // a ring road edge is drawn as its arc of the circle
  private line(e: Edge, color: string | CanvasPattern, width: number): void {
    const ctx = this.ctx, r = e.ring?.hub;
    ctx.beginPath();
    if (r) ctx.arc(r.x, r.y, RINGS[r.ring].r, Math.atan2(e.a.y - r.y, e.a.x - r.x), Math.atan2(e.b.y - r.y, e.b.x - r.x), true);
    else {
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private ring(x: number, y: number, r: number, color: string | CanvasPattern, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // Text with a white halo
  private text(s: string, x: number, y: number, font: string, color: string): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#FFFFFF';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  // Unit direction from the node toward the other end of the edge
  private dir(n: Node, e: Edge): [number, number] {
    const o = e.a === n ? e.b : e.a;
    const len = Math.hypot(o.x - n.x, o.y - n.y) || 1;
    return [(o.x - n.x) / len, (o.y - n.y) / len];
  }

  private circle(x: number, y: number, r: number, color: string | CanvasPattern): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Spot d px out along e from n, right of the lane coming in (traffic flows toward the node, -u; its right is (uy, -ux))
  private spot(n: Node, e: Edge, d: number): [number, number] {
    // pushed out past the kerb of the widest road crossing the arm
    const off = e.width / 2 + 3, [ux, uy] = this.dir(n, e);
    d += Math.max(0, ...n.edges.map(o => o === e || o.drive ? 0 : o.width / 2 + 4 - NODE_R - 6));
    return [n.x + ux * d + uy * off, n.y + uy * d - ux * off];
  }

  // One traffic light per approach: green while any of its movements may go, amber in the last second before all turn red
  // (cosmetic: the sim has no amber)
  private drawLights(n: Node): void {
    const ctx = this.ctx, p = planOf(n), ph = p.phases[n.phase] ?? p.phases[0], next = p.phases[(n.phase + 1) % p.phases.length];
    for (const e of n.edges) {
      const a = approachOf(p, n, e), go = ph.sig[a].some(x => x > 0);
      const amber = go && ph.seconds - n.phaseTimer < 1 && !next.sig[a].some(x => x > 0);
      if (e.drive) continue;
      // a pole on the kerb right of the lanes coming in, a mast arm over them, and a three-lamp head lit by the phase
      const [ux, uy] = this.dir(n, e), [px, py] = this.spot(n, e, NODE_R + 6);
      const reach = (e.type.oneWay ? e.width / 2 : e.width / 4) + 3, hx = px - uy * reach, hy = py + ux * reach;
      this.seg({ x: px + 1.3, y: py + 1.9 }, { x: hx + 1.3, y: hy + 1.9 }, 'rgba(0,0,0,.16)', 1.4);
      this.seg({ x: px, y: py }, { x: hx, y: hy }, '#5C6168', 1.1);
      this.circle(px + 0.6, py + 0.9, 1.9, 'rgba(0,0,0,.2)');
      this.circle(px, py, 1.7, '#4A4F56');
      this.circle(px - 0.4, py - 0.4, 0.7, '#8E949B');
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(Math.atan2(ux, -uy));
      ctx.beginPath();
      ctx.roundRect(-4.6, -1.9, 9.2, 3.8, 1.3);
      ctx.fillStyle = '#2E3136';
      ctx.fill();
      const lit = amber ? 1 : go ? 2 : 0;
      ['#FF4D4F', AMBER, '#3DDC6A'].forEach((c, i) => {
        const x = (i - 1) * 2.9;
        if (i === lit) {
          ctx.globalAlpha *= 0.35;
          this.circle(x, 0, 2.6, c);
          ctx.globalAlpha /= 0.35;
          this.circle(x, 0, 1.15, c);
        } else this.circle(x, 0, 1, '#4A4D52');
      });
      ctx.restore();
    }
  }

  // Yield: a give-way triangle on every side-road approach; stop: a red octagon on every approach
  private drawSigns(n: Node): void {
    const ctx = this.ctx, main = n.control === 'yield' ? mainEdges(n) : [];
    for (const e of n.edges) {
      if (main.includes(e)) continue;
      const [px, py] = this.spot(n, e, NODE_R + 6);
      const shape = (x: number, y: number): void => {
        ctx.beginPath();
        if (n.control === 'stop') for (let i = 0; i < 8; i++) ctx.lineTo(x + 3.6 * Math.cos((i + 0.5) * Math.PI / 4), y + 3.6 * Math.sin((i + 0.5) * Math.PI / 4));
        else { ctx.moveTo(x - 3.8, y - 2.6); ctx.lineTo(x + 3.8, y - 2.6); ctx.lineTo(x, y + 3.8); }
        ctx.closePath();
      };
      // its post's shadow and its own, cast down-right
      this.seg({ x: px, y: py }, { x: px + 2.2, y: py + 3.3 }, 'rgba(0,0,0,.18)', 0.9);
      shape(px + 2.2, py + 3.3);
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.fill();
      shape(px, py);
      ctx.fillStyle = n.control === 'stop' ? RED : '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = n.control === 'stop' ? '#FFFFFF' : RED;
      ctx.lineWidth = n.control === 'stop' ? 0.8 : 1.3;
      ctx.stroke();
    }
  }

  // Arrows of e's lanes into n: its plan's lane connections (less legacy bans), else auto ones where two lanes or more come in
  // (roundabouts: set ones only)
  private arrowsOf(n: Node, e: Edge): number[] | null {
    const p = n.plan, k = inLanes(n, e);
    if (p && (laneMasks(p, n, e) || p.ban[approachOf(p, n, e)].some(Boolean))) return links(p, n, e);
    return k > 1 && !onRing(n) ? autoMasks(k) : null;
  }
  // Lane connection editor (LaneLinks) of the junction open in the panel: a soft pad, the target zones on the roads out, a curve per
  // connection in its approach's colour (thicker hovered), the lane handles, and the line being dragged snapping onto a zone
  private linkEditor(n: Node): void {
    if (!editable(n)) return;
    const ctx = this.ctx, z = this.cam.zoom, lw = Math.max(1.5, 2 / z), d = linkUI.drag, ls = linksOf(n), hs = handles(n);
    const col = (a: number): string => LINK_COLS[a % LINK_COLS.length];
    const r = Math.max(...hs.map(h => Math.hypot(h.x - n.x, h.y - n.y)), NODE_R) + 10;
    ctx.globalAlpha = 0.45;
    this.circle(n.x, n.y, r, '#FFFFFF');
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    for (const t of targets(n)) {
      const own = d?.h.e === t.o, on = d?.t === t, px = -t.uy * t.w, py = t.ux * t.w, ox = t.x + t.ux * 4, oy = t.y + t.uy * 4;
      ctx.globalAlpha = own ? 0.25 : 1;
      ctx.beginPath();
      ctx.moveTo(ox - px, oy - py);
      ctx.lineTo(ox + px, oy + py);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = (on ? 7 : 5) * lw / 1.5;
      ctx.stroke();
      ctx.strokeStyle = own ? '#9A9A96' : d ? col(d.h.a) : '#7C8796';
      ctx.lineWidth = (on ? 4.5 : 2.5) * lw / 1.5;
      ctx.setLineDash(d && !on && !own ? [2, 2] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    const stroke = (c: number[], color: string, w: number, head: boolean): void => {
      const [sx, sy, ax, ay, bx, by, ex, ey] = c, l = Math.hypot(ex - bx, ey - by) || 1, vx = (ex - bx) / l, vy = (ey - by) / l, hw = w * 1.4 + 1;
      for (const [cl, cw] of [['#FFFFFF', w + 1.8], [color, w]] as const) {
        ctx.strokeStyle = ctx.fillStyle = cl;
        ctx.lineWidth = cw;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(ax, ay, bx, by, ex - vx * hw, ey - vy * hw);
        ctx.stroke();
        if (!head) continue;
        const k = cw === w ? 0 : 0.9;
        ctx.beginPath();
        ctx.moveTo(ex + vx * (hw * 0.6 + k), ey + vy * (hw * 0.6 + k));
        ctx.lineTo(ex - vx * (hw + k) - vy * (hw + k), ey - vy * (hw + k) + vx * (hw + k));
        ctx.lineTo(ex - vx * (hw + k) + vy * (hw + k), ey - vy * (hw + k) - vx * (hw + k));
        ctx.fill();
      }
    };
    for (const l of ls) {
      // the line being dragged off fades; hovered thickens
      if (d?.moved && d.was?.key === l.key) ctx.globalAlpha = 0.3;
      stroke(l.c, col(l.h.a), !d && linkUI.hover === l.key ? lw * 2 : lw, true);
      ctx.globalAlpha = 1;
    }
    if (d) {
      const c = d.t ? curve(n, d.h, d.t, moveOf(n, d.h.e, d.t.o)) : [d.h.x, d.h.y, d.h.x + (n.x - d.h.x) * 0.5, d.h.y + (n.y - d.h.y) * 0.5, d.x, d.y, d.x, d.y];
      if (!d.t) ctx.setLineDash([3, 3]);
      if (d.moved) stroke(c, col(d.h.a), lw * 1.6, !!d.t);
      ctx.setLineDash([]);
    }
    for (const h of hs) {
      const hot = linkUI.hover === h.key || d?.h.key === h.key;
      this.circle(h.x, h.y, (hot ? 3.2 : 2.4) * Math.max(1, 1.4 / z), '#FFFFFF');
      ctx.strokeStyle = col(h.a);
      ctx.lineWidth = lw * 0.9;
      ctx.stroke();
    }
  }
}

// Highlight radius round a junction, or round a roundabout (its hub)
const hubR = (n: Node): number => n.control === 'roundabout' ? ringOut(n.ring) + 8 : NODE_R + 26;

// Joint disc: the widest non-tunnel road of that level meeting at the node sets its width and tier colour
function jointEdge(n: Node, level: number): Edge | null {
  return n.edges.reduce<Edge | null>((w, e) => (!e.tunnel && e.level === level && e.width > (w?.width ?? 0) ? e : w), null);
}

// Convex hull (monotone chain), counter-clockwise
function hull(pts: Vec[]): Vec[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y), cross = (o: Vec, a: Vec, b: Vec): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: Vec[]): Vec[] => {
    const h: Vec[] = [];
    for (const q of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); }
    return h.slice(0, -1);
  };
  return [...half(p), ...half([...p].reverse())];
}
