import './style.css';
import { Game } from './core/Game.ts';
import { CanvasRenderer } from './rendering/CanvasRenderer.ts';
import { HUD } from './ui/HUD.ts';
import { Tutorial } from './ui/Tutorial.ts';
import { Menu } from './ui/Menu.ts';
import { attachInput } from './ui/Input.ts';
import { GameLoop } from './core/GameLoop.ts';
import { AUTO, load, store } from './core/Save.ts';
import { BIOMES, DEFAULT_CONFIG, DIFFICULTY, SIZES } from './core/config.ts';
import type { GameConfig } from './core/config.ts';

// URL params (?seed=&biome=&difficulty=&size=&mode=) start that game at once, skipping the menu (dev and tests)
const q = new URLSearchParams(location.search);
const pick = <T extends string>(key: string, allowed: readonly string[], dflt: T): T => {
  const v = q.get(key);
  return v !== null && allowed.includes(v) ? v as T : dflt;
};
const d = DEFAULT_CONFIG;
const urlCfg: GameConfig | null = ['seed', 'biome', 'difficulty', 'size', 'mode'].some(k => q.has(k)) ? {
  seed: q.get('seed')?.slice(0, 64) || d.seed,
  biome: pick('biome', Object.keys(BIOMES), d.biome),
  difficulty: pick('difficulty', Object.keys(DIFFICULTY), d.difficulty),
  size: pick('size', Object.keys(SIZES), d.size),
  mode: pick('mode', ['career', 'creative'], d.mode),
} : null;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;
const renderer = new CanvasRenderer(canvas);
const tutorialDone = (): boolean => { try { return localStorage.getItem('tm_tutorial_done') === '1'; } catch { return false; /* storage blocked: show it */ } };

// One game at a time: a start aborts the old HUD's and input's listeners and builds them again on the new game
let game: Game, hud: HUD, tutorial: Tutorial, input: ReturnType<typeof attachInput>, ctl = new AbortController(), day = 0;
const autosave = (): void => { if (!game.gameOver) store(AUTO, game); };

const menu = new Menu(document.getElementById('menu') as HTMLElement, hudRoot, {
  game: () => game,
  newGame: cfg => start(new Game(cfg), !tutorialDone()),
  load: key => { const g = load(key); if (g) start(g); return !!g; },
  save: key => store(key, game),
  quit: autosave,
  canPause: () => !game.gameOver && !game.pendingLevel && !hud.helpOpen && !input.busy && game.tool !== 'place'
    && !game.selected && !game.inspect && !game.follow && !game.picked && !game.ichg,
});

function start(g: Game, tour = false): void {
  ctl.abort();
  ctl = new AbortController();
  game = g;
  day = g.day;
  hud = new HUD(hudRoot, g, ctl.signal);
  tutorial = new Tutorial(hudRoot, g);
  hud.onTutorial = () => tutorial.start();
  hud.onJump = p => renderer.centerOn(p);
  hud.onRestart = () => start(new Game(g.cfg));
  hud.onMenu = () => menu.show('main');
  hud.onPause = () => menu.show('pause');
  input = attachInput(canvas, g, renderer, ctl.signal);
  renderer.reset();
  Object.assign(window, { game, tutorial, renderer, hud }); // debugging from the console
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
  },
  () => {
    renderer.render(game, input.preview, input.anchor, input.handle, input.hover);
    hud.update();
    tutorial.update();
  },
).start();
