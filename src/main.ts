import './style.css';
import { Game } from './core/Game.ts';
import { CanvasRenderer } from './rendering/CanvasRenderer.ts';
import { HUD } from './ui/HUD.ts';
import { Tutorial } from './ui/Tutorial.ts';
import { attachInput } from './ui/Input.ts';
import { GameLoop } from './core/GameLoop.ts';
import { BIOMES, DEFAULT_CONFIG, DIFFICULTY, SIZES } from './core/config.ts';
import type { GameConfig } from './core/config.ts';

// ponytail: new-game settings from ?seed=&biome=&difficulty=&size=&mode= until the main menu exists
const q = new URLSearchParams(location.search);
const pick = <T extends string>(key: string, allowed: readonly string[], dflt: T): T => {
  const v = q.get(key);
  return v !== null && allowed.includes(v) ? v as T : dflt;
};
const d = DEFAULT_CONFIG;
const cfg: GameConfig = {
  seed: q.get('seed')?.slice(0, 64) || d.seed,
  biome: pick('biome', Object.keys(BIOMES), d.biome),
  difficulty: pick('difficulty', Object.keys(DIFFICULTY), d.difficulty),
  size: pick('size', Object.keys(SIZES), d.size),
  mode: pick('mode', ['career', 'creative'], d.mode),
};

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(cfg);
const renderer = new CanvasRenderer(canvas);
const hudRoot = document.getElementById('hud') as HTMLElement;
const hud = new HUD(hudRoot, game);
const tutorial = new Tutorial(hudRoot, game);
Object.assign(window, { game, tutorial, renderer, hud }); // debugging from the console
hud.onTutorial = () => tutorial.start();
hud.onDanger = c => renderer.centerOn(c);
let tutorialDone = false;
try { tutorialDone = localStorage.getItem('tm_tutorial_done') === '1'; } catch { /* storage blocked: show the tutorial */ }
if (!tutorialDone) tutorial.start();
const input = attachInput(canvas, game, renderer);

new GameLoop(
  dt => {
    // 1/60 s substeps so 4x does not break the simulation
    let acc = dt * game.speed;
    while (acc > 0) {
      const step = Math.min(acc, 1 / 60);
      game.update(step);
      acc -= step;
    }
  },
  () => {
    renderer.render(game, input.preview, input.anchor, input.handle, input.hover);
    hud.update();
    tutorial.update();
  },
).start();
