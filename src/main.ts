import './style.css';
import { Game } from './core/Game.ts';
import { CanvasRenderer } from './rendering/CanvasRenderer.ts';
import { HUD } from './ui/HUD.ts';
import { Tutorial } from './ui/Tutorial.ts';
import { Menu } from './ui/Menu.ts';
import { attachInput } from './ui/Input.ts';
import { sound } from './ui/Sound.ts';
import { GameLoop } from './core/GameLoop.ts';
import { AUTO, load, store } from './core/Save.ts';
import { BIOMES, DEFAULT_CONFIG, DIFFICULTY, SIZES } from './core/config.ts';
import type { GameConfig, Mode } from './core/config.ts';
import { MAPS, cfgFor, mapById } from './core/Campaign.ts';
import { profile, recordGrade, saveProfile, toolLevel } from './core/Profile.ts';

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
const tutorialDone = (): boolean => { try { return localStorage.getItem('tm_tutorial_done') === '1'; } catch { return false; /* storage blocked: show it */ } };

// One game at a time: a start aborts the old HUD's and input's listeners and builds them again on the new game
let game: Game, hud: HUD, tutorial: Tutorial, input: ReturnType<typeof attachInput>, ctl = new AbortController(), day = 0, arrived = 0;
// the profile's lifetime trips grow by what this game arrived since the last count (each midnight and on quitting)
const tally = (): void => { profile().stats.trips += game.stats.arrived - arrived; arrived = game.stats.arrived; saveProfile(); };
const autosave = (): void => { tally(); if (!game.gameOver) store(AUTO, game); };

const menu = new Menu(document.getElementById('menu') as HTMLElement, hudRoot, {
  game: () => game,
  // the tour runs on the first campaign map until it has been seen once
  newGame: cfg => start(new Game(cfg), !tutorialDone() && cfg.mode === 'campaign' && cfg.map === MAPS[0].id),
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
  day = g.day;
  arrived = g.stats.arrived;
  // a map grade with stars goes to the profile; an Endless run gains the tools starred since it began
  const m = g.map;
  if (m) g.onGrade = r => { recordGrade(profile(), m, r, g.challenge); saveProfile(); };
  if (g.cfg.mode === 'endless' && g.cfg.unlock !== undefined) g.cfg = { ...g.cfg, unlock: Math.max(g.cfg.unlock, toolLevel(profile())) };
  hud = new HUD(hudRoot, g, ctl.signal);
  tutorial = new Tutorial(hudRoot, g);
  hud.onTutorial = () => tutorial.start();
  hud.onJump = p => renderer.centerOn(p);
  hud.onRestart = () => start(new Game(g.cfg));
  hud.onMenu = () => menu.show('main');
  hud.onMaps = () => { autosave(); menu.show('campaign'); };
  hud.onPause = () => menu.show('pause');
  input = attachInput(canvas, g, renderer, ctl.signal);
  renderer.reset();
  Object.assign(window, { game, tutorial, renderer, hud, sound }); // debugging from the console
  if (tour) tutorial.start();
}

if (urlCfg) start(new Game(urlCfg), !tutorialDone());
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
    if (game.day !== day) { day = game.day; autosave(); }
    if (game.running && !menu.open) profile().stats.seconds += dt;
  },
  () => {
    renderer.render(game, input.preview, input.anchor, input.handle, input.hover);
    hud.update();
    tutorial.update();
    sound.update(game, renderer, menu.open || game.speed === 0 || game.modal);
  },
).start();
