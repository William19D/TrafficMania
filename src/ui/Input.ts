import type { Game, Tool, PathPlan } from '../core/Game.ts';
import type { CanvasRenderer } from '../rendering/CanvasRenderer.ts';
import type { Vec } from '../util/geom.ts';
import { dist } from '../util/geom.ts';
import { cubicPoints, autoControls, bendControls } from '../util/curve.ts';

const KEY_TOOLS: Tool[] = ['road', 'light', 'roundabout', 'demolish'];
const CLICK_PX = 6;

type Mode = 'idle' | 'placing' | 'pressed' | 'bending';

export function attachInput(canvas: HTMLCanvasElement, game: Game, renderer: CanvasRenderer): {
  readonly preview: PathPlan | null; readonly anchor: Vec | null; readonly handle: Vec | null; readonly hover: Vec | null;
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

  const blocked = () => game.gameOver || !!game.pendingReward;

  const cancel = () => {
    mode = 'idle';
    press = null;
    anchor = end = handle = null;
    plan = null;
  };

  const autoPlan = (a: Vec, c: Vec): PathPlan => {
    const ta = game.tangentAt(a, c), tb = game.tangentAt(c, a);
    const pts = !ta && !tb ? [a, c] : cubicPoints(a, ...autoControls(a, c, ta, tb), c);
    return game.planPath(pts);
  };

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
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
        end = w;
        plan = autoPlan(anchor, w);
      }
    } else if (game.tool === 'demolish') game.demolishAt(w);
    else game.placeControl(w, game.tool);
  });

  canvas.addEventListener('pointermove', e => {
    hover = renderer.screenToWorld(e.clientX, e.clientY);
    if (panning) {
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) > 0) panMoved = true;
      renderer.pan(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (game.tool !== 'road' || blocked()) { if (mode !== 'idle') cancel(); return; }
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    if (mode === 'placing' && anchor) plan = autoPlan(anchor, w);
    else if ((mode === 'pressed' || mode === 'bending') && anchor && end && press) {
      if (mode === 'pressed' && dist(press, { x: e.clientX, y: e.clientY }) > CLICK_PX) mode = 'bending';
      if (mode === 'bending') {
        handle = w;
        plan = game.planPath(cubicPoints(anchor, ...bendControls(anchor, end, w), end));
      }
    }
  });

  canvas.addEventListener('pointerup', e => {
    if (e.button === 1 || e.button === 2) {
      // right click without drag cancels; done here, not in contextmenu, which fires on press on macOS
      if (panning && e.button === 2 && !panMoved) cancel();
      panning = false;
      return;
    }
    if (e.button !== 0 || game.tool !== 'road') return;
    if (mode === 'pressed' || mode === 'bending') {
      // Recompute with the release position so the built curve matches where the button was released.
      if (mode === 'bending' && anchor && end) {
        const w = renderer.screenToWorld(e.clientX, e.clientY);
        plan = game.planPath(cubicPoints(anchor, ...bendControls(anchor, end, w), end));
      }
      if (plan) game.commitPath(plan);
      cancel();
    } else if (mode === 'idle' && press && !blocked() && dist(press, { x: e.clientX, y: e.clientY }) <= CLICK_PX) {
      anchor = renderer.screenToWorld(e.clientX, e.clientY);
      mode = 'placing';
      plan = autoPlan(anchor, anchor);
    }
    press = null;
  });

  canvas.addEventListener('pointerleave', () => { hover = null; });

  canvas.addEventListener('pointercancel', () => { panning = false; cancel(); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    renderer.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
  });

  window.addEventListener('keydown', e => {
    const n = Number(e.key);
    if (n >= 1 && n <= KEY_TOOLS.length) {
      game.tool = KEY_TOOLS[n - 1];
      cancel();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (blocked()) return;
      game.speed = game.speed === 0 ? 1 : 0;
    } else if (e.key === 'Escape') cancel();
    else if (e.key === 'PageUp' || e.key === '+' || e.key === '=') { e.preventDefault(); game.setLevel(game.level + 1); }
    else if (e.key === 'PageDown' || e.key === '-') { e.preventDefault(); game.setLevel(game.level - 1); }
  });

  // Tool switches from the HUD (or a modal opening) cancel the placement.
  // also mirrors the tool onto <body data-tool> so CSS can switch the canvas cursor
  const live = () => {
    if (document.body.dataset.tool !== game.tool) document.body.dataset.tool = game.tool;
    if (mode !== 'idle' && (game.tool !== 'road' || blocked())) cancel();
  };

  return {
    get preview() { live(); return plan; },
    get anchor() { live(); return anchor; },
    get handle() { live(); return handle; },
    get hover() { live(); return blocked() ? null : hover; },
  };
}
