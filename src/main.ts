import './style.css';
import { Game } from './core/Game.ts';
import { CanvasRenderer } from './rendering/CanvasRenderer.ts';
import { HUD } from './ui/HUD.ts';
import { Tutorial } from './ui/Tutorial.ts';
import { attachInput } from './ui/Input.ts';
import { GameLoop } from './core/GameLoop.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game();
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
