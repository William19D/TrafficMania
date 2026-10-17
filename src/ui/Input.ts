import type { Game, Tool, PathPlan } from '../core/Game.ts';
import { ZONE_KEYS } from '../core/Game.ts';
import type { Edge } from '../network/RoadGraph.ts';
import type { Building } from '../entities/Building.ts';
import type { CanvasRenderer } from '../rendering/CanvasRenderer.ts';
import type { Vec } from '../util/geom.ts';
import { dist, snapAngle } from '../util/geom.ts';
import { approachOf, cycleSign, moveOf, setLink } from '../network/Junction.ts';
import { cubicPoints, bendControls } from '../util/curve.ts';
import { commitZone, planZone } from '../core/Zones.ts';
import { editable, handleAt, linkAt, linkUI, signHit, targetAt } from './LaneLinks.ts';

// Number keys follow the dock left to right; Z toggles the zone brush, Tab steps through its zones (Unzone last)
export const KEY_TOOLS: Tool[] = ['road', 'grid', 'light', 'roundabout', 'interchange', 'edit', 'demolish'];
const CLICK_PX = 6, HIT_PX = 9;

type Mode = 'idle' | 'placing' | 'pressed' | 'bending';

// signal: aborted when the game is replaced, removing every listener
export function attachInput(canvas: HTMLCanvasElement, game: Game, renderer: CanvasRenderer, signal?: AbortSignal): {
  readonly preview: PathPlan | null; readonly anchor: Vec | null; readonly handle: Vec | null; readonly hover: Vec | null;
  // a road, bend or grid in progress (Esc cancels it before it opens the pause menu)
  readonly busy: boolean;
  // drops a road, bend, grid or brush in progress (an undo swaps the objects under it)
  cancel(): void;
} {
  let hover: Vec | null = null;
  let panning = false;
  let panMoved = false;
  let last = { x: 0, y: 0 };
  let mode: Mode = 'idle';
  let press: { x: number; y: number } | null = null; // screen position of the left press
  let anchor: Vec | null = null;
  let end: Vec | null = null;
  let handle: Vec | null = null;
  let plan: PathPlan | null = null;
  let run: Edge[] | null = null; // Edit tool: the run pressed on (bent while dragging)
  let grab: Building | null = null; // Edit tool: the building pressed on (dragging it moves it); then the move being dragged
  let grid: Vec[] = []; // Grid tool: the corner, then the end of the first side
  let brush: Vec | null = null; // Zone tool: where the drag started
  let shift = false, snap = false; // Shift: straight this road; Ctrl / Alt: its end turns in 15° steps around the anchor

  const blocked = () => game.modal;

  const cancel = () => {
    mode = 'idle';
    press = null;
    anchor = end = handle = null;
    plan = null;
    run = null;
    grab = null;
    grid = [];
    brush = null;
    game.zonePlan = null;
    linkUI.drag = null;
  };

  const autoPlan = (a: Vec, c: Vec): PathPlan => game.planRoad(a, c, game.roadCurve && !shift);
  const bendPlan = (a: Vec, b: Vec, q: Vec): PathPlan => ({ ...game.planPath(cubicPoints(a, ...bendControls(a, b, q), b)), note: 'Bend' });
  const aim = (a: Vec, w: Vec): Vec => snap ? snapAngle(a, w, Math.PI / 12) : w;
  const mods = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }) => { shift = e.shiftKey; snap = e.ctrlKey || e.altKey; };
  // the road being placed follows a mode switch or a modifier key at once, without waiting for the mouse
  // lane connection hit radius in world px; fingers get more
  const hitR = (e: PointerEvent): number => HIT_PX * (e.pointerType === 'touch' ? 1.8 : 1) / renderer.cam.zoom;
  // Releases a lane drag: a click on a line removes it; a drag moves it (or makes a new one) to the road let go on, or off any road removes it
  const dropLink = () => {
    const d = linkUI.drag, n = game.inspect;
    linkUI.drag = null;
    if (!d || !editable(n) || (d.moved && d.was && d.t?.o === d.was.t.o) || (!d.was && (!d.moved || !d.t))) return;
    game.editPlan(n, p => {
      if (d.was) setLink(p, n, d.h.e, d.h.j, d.was.mv, false);
      if (d.moved && d.t) setLink(p, n, d.h.e, d.h.j, moveOf(n, d.h.e, d.t.o), true);
    });
  };
  const replan = () => { if (game.tool === 'road' && mode === 'placing' && anchor && hover && !blocked()) plan = autoPlan(anchor, aim(anchor, hover)); };

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    mods(e);
    if (e.button === 1 || e.button === 2) {
      panning = true;
      panMoved = false;
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0 || blocked()) return;
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    if (game.tool === 'road') {
      press = { x: e.clientX, y: e.clientY };
      if (mode === 'placing' && anchor) {
        mode = 'pressed';
        end = aim(anchor, w);
        plan = autoPlan(anchor, end);
      }
    } else if (game.tool === 'edit') {
      press = { x: e.clientX, y: e.clientY };
      const n = game.inspect, r = hitR(e), sg = editable(n) ? signHit(n, w, r) : null;
      // a priority sign post: click cycles priority road, yield, stop
      if (sg) { press = null; game.editPlan(n!, p => cycleSign(p, n!, approachOf(p, n!, sg)), true); return; }
      const h = editable(n) ? handleAt(n, w, r) : null, l = !h && editable(n) ? linkAt(n, w, r) : null;
      if (h || l) { linkUI.drag = { h: h ?? l!.h, was: l, x: w.x, y: w.y, t: null, moved: false }; return; }
      grab = game.carAt(w) || game.junctionAt(w) ? null : game.buildingUnder(w);
      run = grab ? null : game.runAt(w);
    } else if (game.tool === 'grid') press = { x: e.clientX, y: e.clientY };
    else if (game.tool === 'interchange') game.pickInterchange(w);
    else if (game.tool === 'demolish') game.demolishAt(w);
    else if (game.tool === 'place') game.placeBuilding(w);
    else if (game.tool === 'zone') { game.zonePlan = planZone(game, w, w, game.zone, shift); brush = game.zonePlan ? w : null; }
    else game.placeControl(w, game.tool);
  }, { signal });

  canvas.addEventListener('pointermove', e => {
    hover = renderer.screenToWorld(e.clientX, e.clientY);
    mods(e);
    if (panning) {
      // dragging the map lets go of a followed car
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) > 0) { panMoved = true; game.follow = null; }
      renderer.pan(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    const w = renderer.screenToWorld(e.clientX, e.clientY), n = game.inspect, d = linkUI.drag;
    if (d && editable(n)) {
      d.x = w.x;
      d.y = w.y;
      d.moved ||= !!press && dist(press, { x: e.clientX, y: e.clientY }) > CLICK_PX;
      d.t = d.moved ? targetAt(n, w, hitR(e), d.h) : null;
      return;
    }
    if (game.tool === 'edit' && editable(n) && !press) { const r = hitR(e), h = handleAt(n, w, r), sg = signHit(n, w, r); linkUI.hover = sg ? `sign:${sg.id}` : h?.key ?? linkAt(n, w, r)?.key ?? ''; }
    if (game.tool === 'edit' && grab && press && !blocked() && dist(press, { x: e.clientX, y: e.clientY }) > CLICK_PX) { game.startMove(grab); return; }
    if (game.tool === 'edit' && run && press && !blocked()) {
      if (mode === 'idle' && dist(press, { x: e.clientX, y: e.clientY }) > CLICK_PX) mode = 'bending';
      if (mode === 'bending') {
        handle = w;
        plan = game.planBend(run, w);
      }
      return;
    }
    if (game.tool === 'grid' && grid.length && !blocked()) { plan = game.planGrid(grid[0], grid[1] ?? w, grid[1] ? w : null); return; }
    if (game.tool === 'zone' && brush && !blocked()) { game.zonePlan = planZone(game, brush, w, game.zone, shift); return; }
    if (game.tool !== 'road' || blocked()) { if (mode !== 'idle') cancel(); return; }
    if (mode === 'placing' && anchor) plan = autoPlan(anchor, aim(anchor, w));
    else if ((mode === 'pressed' || mode === 'bending') && anchor && end && press) {
      if (mode === 'pressed' && dist(press, { x: e.clientX, y: e.clientY }) > CLICK_PX) mode = 'bending';
      if (mode === 'bending') {
        handle = w;
        plan = bendPlan(anchor, end, w);
      }
    }
  }, { signal });

  canvas.addEventListener('pointerup', e => {
    if (e.button === 1 || e.button === 2) {
      // right click without drag cancels; done here, not in contextmenu, which fires on press on macOS
      if (panning && e.button === 2 && !panMoved) cancel();
      panning = false;
      return;
    }
    if (e.button !== 0) return;
    // a building dragged with Edit drops where it is let go; a refused spot leaves it held, a click places it then
    if (game.tool === 'place' && grab && game.moving === grab) {
      if (!blocked()) game.placeBuilding(renderer.screenToWorld(e.clientX, e.clientY));
      grab = press = null;
      return;
    }
    if (game.tool === 'edit') {
      if (linkUI.drag) dropLink();
      else if (mode === 'bending' && run) {
        // replan at the release point, like the road bend
        game.commitBend(run, game.planBend(run, renderer.screenToWorld(e.clientX, e.clientY)));
      } else if (press && !blocked() && dist(press, { x: e.clientX, y: e.clientY }) <= CLICK_PX) {
        game.select(renderer.screenToWorld(e.clientX, e.clientY));
      }
      cancel();
      return;
    }
    if (game.tool === 'zone') {
      const p = brush && !blocked() ? planZone(game, brush, renderer.screenToWorld(e.clientX, e.clientY), game.zone, shift) : null;
      if (p) commitZone(game, p);
      cancel();
      return;
    }
    if (game.tool === 'grid') {
      if (press && !blocked() && dist(press, { x: e.clientX, y: e.clientY }) <= CLICK_PX) {
        const w = renderer.screenToWorld(e.clientX, e.clientY);
        if (grid.length < 2) grid.push(w);
        else if (game.commitGrid(grid[0], grid[1], w)) cancel();
        if (grid.length) plan = game.planGrid(grid[0], grid[1] ?? w, grid[1] ? w : null);
      }
      press = null;
      return;
    }
    if (game.tool !== 'road') return;
    if (mode === 'pressed' || mode === 'bending') {
      // Recompute with the release position so the built curve matches where the button was released.
      if (mode === 'bending' && anchor && end) {
        plan = bendPlan(anchor, end, renderer.screenToWorld(e.clientX, e.clientY));
      }
      if (plan) game.commitPath(plan);
      cancel();
    } else if (mode === 'idle' && press && !blocked() && dist(press, { x: e.clientX, y: e.clientY }) <= CLICK_PX) {
      anchor = renderer.screenToWorld(e.clientX, e.clientY);
      mode = 'placing';
      plan = autoPlan(anchor, anchor);
    }
    press = null;
  }, { signal });

  canvas.addEventListener('pointerleave', () => { hover = null; }, { signal });

  canvas.addEventListener('pointercancel', () => { panning = false; cancel(); }, { signal });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    renderer.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false, signal });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
  }, { signal });

  for (const t of ['keydown', 'keyup'] as const) window.addEventListener(t, e => {
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt') return;
    mods(e);
    replan();
  }, { signal });

  window.addEventListener('keydown', e => {
    const n = Number(e.key);
    if (n >= 1 && n <= KEY_TOOLS.length) {
      game.setTool(KEY_TOOLS[n - 1]);
      cancel();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (blocked()) return;
      game.speed = game.speed === 0 ? 1 : 0;
    } else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key === 'z' || e.key === 'Z') { cancel(); if (game.tool === 'zone') game.setTool('road'); else game.setZone(game.zone); }
    else if (e.key === 'Tab' && game.tool === 'zone') {
      e.preventDefault();
      const order = [...ZONE_KEYS, null];
      cancel();
      game.setZone(order[(order.indexOf(game.zone) + 1) % order.length]);
    } else if ((e.key === 'r' || e.key === 'R') && game.tool === 'place') game.placeAngle += Math.PI / 2;
    else if (e.key === 'v' || e.key === 'V') { game.roadCurve = !game.roadCurve; replan(); }
    else if (e.key === 'Escape' && linkUI.drag) linkUI.drag = null;
    else if (e.key === 'Escape' && brush) cancel();
    else if (e.key === 'Escape') { cancel(); game.select(null); game.ichg = null; if (game.tool === 'place') game.setTool(game.moving ? 'edit' : 'road'); else if (game.tool === 'zone') game.setTool('road'); }
    else if (e.key === 'PageUp' || e.key === '+' || e.key === '=') { e.preventDefault(); game.setLevel(game.level + 1); }
    else if (e.key === 'PageDown' || e.key === '-') { e.preventDefault(); game.setLevel(game.level - 1); }
  }, { signal });

  // Tool switches from the HUD (or a modal opening) cancel the placement / bend and drop the Edit selection.
  // also mirrors the tool onto <body data-tool> so CSS can switch the canvas cursor
  const live = () => {
    if (document.body.dataset.tool !== game.tool) document.body.dataset.tool = game.tool;
    if ((mode !== 'idle' || run) && (game.tool !== (run ? 'edit' : 'road') || blocked())) cancel();
    if (grid.length && (game.tool !== 'grid' || blocked())) cancel();
    if (brush && (game.tool !== 'zone' || blocked())) cancel();
    if (game.selected && game.tool !== 'edit') game.select(null);
    if (game.tool !== 'edit' || !editable(game.inspect) || blocked()) { linkUI.drag = null; linkUI.hover = ''; }
  };

  return {
    get preview() { live(); return game.tool === 'interchange' ? game.ichgAt(blocked() ? null : hover) : plan; },
    get anchor() { live(); return grid[0] ?? anchor; },
    get handle() { live(); return handle; },
    get hover() { live(); return blocked() ? null : hover; },
    get busy() { return mode !== 'idle' || !!run || grid.length > 0 || !!brush || !!linkUI.drag; },
    cancel,
  };
}
