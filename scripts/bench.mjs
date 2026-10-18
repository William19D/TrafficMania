// Browser performance benchmark: npm run bench [-- --secs 8] [-- --quality high|medium|low|auto] (default high: Auto would move mid-run)
// Starts Vite (or reuses this project's dev server on :5173), launches headless Chrome with the GPU, restores
// scripts/fixtures/bench-city.json and times game.update / renderer.render / hud.update per scenario. Writes bench-results.json.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SECS = Number(process.argv[process.argv.indexOf('--secs') + 1]) || 8;
const QUALITY = process.argv.includes('--quality') ? process.argv[process.argv.indexOf('--quality') + 1] : 'high';
const PREROLL = 60 * 45; // 45 game seconds at the game's 1/60 s step: ~300 cars on the fixture
const SAVE = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/bench-city.json'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const until = async (f, ms, what) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { try { const v = await f(); if (v) return v; } catch {} } throw new Error('timed out: ' + what); };
const ours = async base => (await (await fetch(base + '/src/core/Save.ts')).text()).includes('export function restore');

let vite, chrome, dataDir;
const cleanup = () => {
  if (chrome?.exitCode === null) try { execFileSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { chrome.kill(); }
  if (vite?.exitCode === null) try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { vite.kill(); }
  if (dataDir) try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  // ---- dev server ----
  let base = 'http://localhost:5173';
  if (!(await ours(base).catch(() => false))) {
    const port = await freePort();
    base = `http://localhost:${port}`;
    vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', port, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await until(() => ours(base), 30000, 'vite');
  }
  // ---- chrome ----
  const dbg = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bench-'));
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${dataDir}`, '--window-size=1920,1080',
    '--no-first-run', '--no-default-browser-check', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-precise-memory-info',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find(t => t.type === 'page'), 20000, 'chrome');

  // ---- raw CDP ----
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const wait = new Map(), events = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { const [ok, no] = wait.get(d.id); wait.delete(d.id); d.error ? no(new Error(JSON.stringify(d.error))) : ok(d.result); }
    else if (d.method) events.push(d.method);
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; wait.set(i, [ok, no]); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Profiler.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  // ?seed= starts a game at once, without the menu
  await send('Page.navigate', { url: base + '/?seed=bench&quality=' + QUALITY });
  await until(() => evaluate('!!window.game && !!window.renderer && !!window.hud'), 30000, 'game boot');
  const gpu = await evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl'); const x = gl?.getExtension('WEBGL_debug_renderer_info');
    return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'no webgl' })()`);
  console.log('GPU', gpu, '| quality', QUALITY);
  if (/swiftshader|llvmpipe|software/i.test(gpu)) console.warn('WARNING: software rendering, numbers are not the real GPU');

  await evaluate(`window.__save = ${JSON.stringify(SAVE)}; (async () => {
    const S = await import('/src/core/Save.ts'), R = await import('/src/util/rng.ts');
    const T = window.__T = { upd: 0, ren: 0, hud: 0, frames: 0, worst: 0, last: performance.now(), t0: performance.now() };
    const C = window.__C = { arm: false, on: false, frames: 0, drawImage: 0, fill: 0, stroke: 0, fillRect: 0, strokeRect: 0, fillText: 0, clearRect: 0, px: 0, srcPx: 0 };
    const wrap = (o, k, key) => { const f = o[k].bind(o); o[k] = (...a) => { const t = performance.now(); if (key === 'ren' && C.arm) { C.on = true; C.frames++; }
      const r = f(...a); T[key] += performance.now() - t; C.on = false; return r; }; };
    wrap(game, 'update', 'upd'); wrap(renderer, 'render', 'ren'); wrap(hud, 'update', 'hud');
    const P = CanvasRenderingContext2D.prototype;
    for (const k of ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'clearRect']) { const f = P[k]; P[k] = function (...a) { if (C.on) C[k]++; return f.apply(this, a); }; }
    const di = P.drawImage;
    P.drawImage = function (img, ...a) {
      if (C.on) {
        const t = this.getTransform(), s = Math.abs(t.a * t.d - t.b * t.c), iw = img.width, ih = img.height;
        const [w, h] = a.length >= 8 ? [a[6], a[7]] : a.length >= 4 ? [a[2], a[3]] : [iw, ih];
        C.drawImage++; C.px += Math.abs(w * h) * s; C.srcPx += a.length >= 8 ? Math.abs(a[2] * a[3]) : iw * ih;
      }
      return di.call(this, img, ...a);
    };
    // saves hold no cars: a seeded, fixed-step pre-roll fills the roads the same way every run
    S.restore(game, __save); R.setSeed(R.hashSeed('bench'));
    for (let i = 0; i < ${PREROLL}; i++) game.update(1 / 60);
    window.__view = (speed, zoom) => {
      game.speed = speed; renderer.reset();
      if (zoom !== 1) renderer.zoomAt(innerWidth / 2, innerHeight / 2, zoom);
    };
    const tick = now => { T.frames++; T.worst = Math.max(T.worst, now - T.last); T.last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
  const city = await evaluate(`({ buildings: game.buildings.length, edges: game.graph.edges.length, nodes: game.graph.nodes.length, cars: game.cars.length, viewport: innerWidth + 'x' + innerHeight })`);
  console.log('city', JSON.stringify(city));

  const zero = `Object.assign(__T, { upd: 0, ren: 0, hud: 0, frames: 0, worst: 0, last: performance.now(), t0: performance.now() })`;
  const run = async (label, speed, zoom) => {
    await evaluate(`__view(${speed}, ${zoom})`);
    await sleep(1000); // caches rebuild for the new view
    await evaluate(zero);
    await send('Profiler.setSamplingInterval', { interval: 200 });
    await send('Profiler.start');
    await sleep(SECS * 1000);
    const { profile } = await send('Profiler.stop');
    const r = await evaluate(`(() => { const T = __T, s = (performance.now() - T.t0) / 1000, f = T.frames || 1, m = v => +(v / f).toFixed(2);
      return { fps: +(T.frames / s).toFixed(1), worstMs: Math.round(T.worst), simMs: m(T.upd), drawMs: m(T.ren), hudMs: m(T.hud), cars: game.cars.length,
        heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6) } })()`);
    const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
    let total = 0;
    profile.samples.forEach((sid, i) => {
      const cf = byId.get(sid).callFrame, k = `${cf.functionName || '(anon)'} ${cf.url ? cf.url.split('/').pop().split('?')[0] + ':' + (cf.lineNumber + 1) : ''}`.trim();
      self.set(k, (self.get(k) || 0) + profile.timeDeltas[i]); total += profile.timeDeltas[i];
    });
    r.top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${(100 * v / total).toFixed(1)}% ${k}`);
    return { label, ...r };
  };
  // paused first: the frame drawn is the pre-roll's, the same every run
  const paused = await run('paused draw-only', 0, 1);
  // canvas call census: what one paused frame draws (averaged over 30 frames)
  await evaluate(`Object.assign(__C, { arm: true, frames: 0, drawImage: 0, fill: 0, stroke: 0, fillRect: 0, strokeRect: 0, fillText: 0, clearRect: 0, px: 0, srcPx: 0 })`);
  await until(() => evaluate('__C.frames >= 30'), 10000, 'census');
  const census = await evaluate(`(() => { const C = __C; C.arm = false; const f = C.frames, o = {};
    for (const k of ['drawImage', 'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'clearRect']) o[k] = Math.round(C[k] / f);
    o.blitMpx = +(C.px / f / 1e6).toFixed(2); o.srcMpx = +(C.srcPx / f / 1e6).toFixed(2); return o })()`);
  const scenarios = [await run('1x whole city', 1, 1), await run('4x whole city', 4, 1), await run('4x zoom 3x', 4, 3), paused];

  // ---- report ----
  const cols = ['fps', 'worstMs', 'simMs', 'drawMs', 'hudMs', 'cars'];
  console.log(`\n${'scenario'.padEnd(18)}${cols.map(c => c.padStart(9)).join('')}`);
  for (const s of scenarios) console.log(`${s.label.padEnd(18)}${cols.map(c => String(s[c]).padStart(9)).join('')}`);
  console.log('\npaused frame census', JSON.stringify(census));
  for (const s of scenarios) console.log(`\n-- ${s.label} top self time\n  ${s.top.join('\n  ')}`);
  const out = { date: new Date().toISOString(), gpu, quality: QUALITY, secs: SECS, city, scenarios, census };
  fs.writeFileSync(path.join(ROOT, 'bench-results.json'), JSON.stringify(out, null, 1));
  console.log('\nwrote bench-results.json');
  await send('Browser.close').catch(() => {});
  ws.close();
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
