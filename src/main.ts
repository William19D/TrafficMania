import './style.css';
import { Game } from './core/Game.ts';
import { CanvasRenderer } from './rendering/CanvasRenderer.ts';
import { HUD } from './ui/HUD.ts';
import { Tutorial } from './ui/Tutorial.ts';
import { Tips } from './ui/Tips.ts';
import { Menu } from './ui/Menu.ts';
import { attachInput } from './ui/Input.ts';
import { sound } from './ui/Sound.ts';
import { GameLoop } from './core/GameLoop.ts';
import { AUTO, SLOTS, load, peek, restore, serialize, store } from './core/Save.ts';
import { HOUR } from './core/Game.ts';
import { BIOMES, DEFAULT_CONFIG, DIFFICULTY, SIZES } from './core/config.ts';
import type { GameConfig, Mode } from './core/config.ts';
import type { Vec } from './util/geom.ts';
import { MAPS, cfgFor, mapById } from './core/Campaign.ts';
import { profile, recordGrade, saveProfile, toolLevel } from './core/Profile.ts';
import { checkAch } from './core/Achievements.ts';

// URL params (?seed=&biome=&difficulty=&size=&mode=, or ?map=<id>&mode=) start that game at once, skipping the menu (dev and tests)
const q = new URLSearchParams(location.search);
const pick = <T extends string>(key: string, allowed: readonly string[], dflt: T): T => {
  const v = q.get(key);
  return v !== null && allowed.includes(v) ? v as T : dflt;
};
const d = DEFAULT_CONFIG;
const MODES: Mode[] = ['campaign', 'endless', 'creative', 'challenge'], urlMap = mapById(q.get('map') ?? undefined);
const urlCfg: GameConfig | null = urlMap ? cfgFor(urlMap, pick('mode', MODES, 'campaign')) : ['seed', 'biome', 'difficulty', 'size', 'mode'].some(k => q.has(k)) ? {
  seed: q.get('seed')?.slice(0, 64) || d.seed,
  biome: pick('biome', Object.keys(BIOMES), d.biome),
  difficulty: pick('difficulty', Object.keys(DIFFICULTY), d.difficulty),
  size: pick('size', Object.keys(SIZES), d.size),
  mode: pick('mode', MODES.filter(m => m === 'endless' || m === 'creative'), d.mode),
} : null;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;
const renderer = new CanvasRenderer(canvas);
// the script is seen once per profile (an old tm_tutorial_done counts); it runs on a fresh Campaign map 1 only
const tutorialDone = (): boolean => { try { return profile().tips.includes('tutorial') || localStorage.getItem('tm_tutorial_done') === '1'; } catch { return false; /* storage blocked: show it */ } };
const tourFor = (cfg: GameConfig): boolean => !tutorialDone() && cfg.mode === 'campaign' && cfg.map === MAPS[0].id;

// One game at a time: a start aborts the old HUD's and input's listeners and builds them again on the new game
let game: Game, hud: HUD, tutorial: Tutorial, tips: Tips, input: ReturnType<typeof attachInput>, ctl = new AbortController(), day = 0, arrived = 0, achKey = '';
// the profile's lifetime trips grow by what this game arrived since the last count (each midnight and on quitting)
const tally = (): void => { profile().stats.trips += game.stats.arrived - arrived; arrived = game.stats.arrived; saveProfile(); };
// Undo / redo (Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z): every press snapshots the game; when a spend follows (a build, paint or demolish) that
// snapshot becomes an undo step. Steps older than UNDO_AGE game time go (an undo rewinds the clock to its step); off in Challenge.
// ponytail: a whole save per press, ~ms on a big city; snapshot on the tool's press only if it ever shows in a profile
const UNDO_MAX = 30, UNDO_AGE = 6 * HOUR;
type Step = { json: string; at: number };
let undo: Step[] = [], redo: Step[] = [], pend: Step | null = null, pendEdits = 0;
const snap = (): Step => ({ json: serialize(game), at: game.time });
window.addEventListener('pointerdown', () => { if (!menu.open) { pend = snap(); pendEdits = game.edits; } }, true);
const step = (from: Step[], to: Step[], verb: string): void => {
  if (game.challenge) { game.say('Undo is off in Challenge'); return; }
  const fresh = from.findIndex(s => game.time - s.at <= UNDO_AGE);
  from.splice(0, fresh < 0 ? from.length : fresh);
  const s = from.pop();
  if (!s) { game.say(`Nothing to ${verb.toLowerCase()}`); return; }
  input.cancel();
  to.push(snap());
  restore(game, s.json);
  pend = null;
  game.say(verb === 'Undo' ? 'Undone' : 'Redone');
  sound.play(verb === 'Undo' ? 'demolish' : 'build');
};
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || menu.open || (e.target as Element).closest?.('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); step(undo, redo, 'Undo'); }
  else if (k === 'y' || k === 'z') { e.preventDefault(); step(redo, undo, 'Redo'); }
});

const autosave = (): void => { tally(); if (!game.gameOver) store(AUTO, game); };

const menu = new Menu(document.getElementById('menu') as HTMLElement, hudRoot, {
  game: () => game,
  newGame: cfg => start(new Game(cfg), tourFor(cfg)),
  load: key => { const g = load(key); if (g) start(g); return !!g; },
  save: key => store(key, game),
  quit: autosave,
  canPause: () => !game.modal && !hud.helpOpen && !hud.buildOpen && !input.busy && game.tool !== 'place' && game.tool !== 'zone'
    && !game.selected && !game.inspect && !game.follow && !game.picked && !game.ichg,
});

function start(g: Game, tour = false): void {
  ctl.abort();
  ctl = new AbortController();
  game = g;
  undo = [];
  redo = [];
  pend = null;
  day = g.day;
  arrived = g.stats.arrived;
  // a map grade with stars goes to the profile; an Endless run gains the tools starred since it began
  const m = g.map;
  if (m) g.onGrade = r => { recordGrade(profile(), m, r, g.challenge); saveProfile(); };
  if (g.cfg.mode === 'endless' && g.cfg.unlock !== undefined) g.cfg = { ...g.cfg, unlock: Math.max(g.cfg.unlock, toolLevel(profile())) };
  hud = new HUD(hudRoot, g, ctl.signal);
  const jump = (p: Vec): void => renderer.centerOn(p);
  tutorial = new Tutorial(hudRoot, g, jump);
  tips = new Tips(hudRoot, g, jump);
  hud.tut = tutorial;
  // the help panel's tutorial: a new game on map 1. A city past day 1 goes to the first empty slot first (the tutorial's own midnight
  // autosave would replace it in the autosave)
  hud.onTutorial = () => {
    const slot = g.day > 1 ? SLOTS.find(k => !peek(k)) : undefined;
    if (g.day > 1 && !confirm(`Start the tutorial on a new ${MAPS[0].name}? ${slot ? `Your city is saved to Slot ${SLOTS.indexOf(slot) + 1} first.` : 'Every save slot is full, so your city is not kept: save it over a slot first to keep it.'}`)) return;
    if (slot && !store(slot, g)) { g.say('Could not save your city: the tutorial did not start'); return; }
    autosave();
    start(new Game(cfgFor(MAPS[0], 'campaign')), true);
  };
  hud.onJump = jump;
  hud.onRestart = () => start(new Game(g.cfg));
  hud.onMenu = () => menu.show('main');
  hud.onMaps = () => { autosave(); menu.show('campaign'); };
  hud.onPause = () => menu.show('pause');
  input = attachInput(canvas, g, renderer, ctl.signal);
  renderer.reset();
  Object.assign(window, { game, tutorial, tips, renderer, hud, sound }); // debugging from the console
  if (tour) tutorial.start();
}

if (urlCfg) start(new Game(urlCfg), tourFor(urlCfg));
else {
  // the menu opens over the last autosave, or over a fresh default map
  start(load(AUTO) ?? new Game(DEFAULT_CONFIG));
  menu.show('main');
}

new GameLoop(
  dt => {
    // 1/60 s substeps so 4x does not break the simulation
    let acc = dt * game.speed;
    while (acc > 0) {
      const step = Math.min(acc, 1 / 60);
      game.update(step);
      acc -= step;
    }
    if (pend && game.edits !== pendEdits) { undo.push(pend); undo.splice(0, undo.length - UNDO_MAX); redo = []; pend = null; }
    if (game.day !== day) { day = game.day; autosave(); }
    // achievements: on the hour and on each counted event (fv)
    const k = `${game.lastHour}|${game.fv}`;
    if (k !== achKey) {
      achKey = k;
      const got = checkAch(game, profile());
      for (const a of got) hud.achieve(a);
      if (got.length) saveProfile();
    }
    if (game.running && !menu.open) profile().stats.seconds += dt;
  },
  () => {
    renderer.render(game, input.preview, input.anchor, input.handle, input.hover);
    hud.update();
    tutorial.update();
    if (!menu.open) tips.update();
    sound.update(game, renderer, menu.open || game.speed === 0 || game.modal);
  },
).start();
