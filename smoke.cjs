const fs = require('fs');
const vm = require('vm');
const ctx = {
  document: { getElementById: () => ({
    getContext: () => new Proxy({}, { get: () => () => {} }),
    width:1280, height:720, addEventListener:()=>{}
  })},
  window: { addEventListener: () => {} },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  console,
};
vm.createContext(ctx);
const html = fs.readFileSync('race-car.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let body = m[1].replace(/requestAnimationFrame\(loop\);\s*$/m, '');
body += `
;globalThis.state = state; globalThis.update = update; globalThis.render = render; globalThis.isOffTrack = isOffTrack; globalThis.keys = keys; globalThis.resetRace = resetRace;
`;
vm.runInContext(body, ctx);

console.log('initial phase:', ctx.state.phase);
ctx.resetRace();
for (let i = 0; i < 5; i++) ctx.update(ctx.performance.now() + i*16);
console.log('after 5 countdown frames:');
console.log('  cars spawned:', ctx.state.cars.length);
console.log('  car0 pos:', ctx.state.cars[0].x.toFixed(1), ctx.state.cars[0].y.toFixed(1), 'angle:', ctx.state.cars[0].angle.toFixed(2));
console.log('  car1 (AI aggressive) pos:', ctx.state.cars[1].x.toFixed(1), ctx.state.cars[1].y.toFixed(1));

// force transition to racing by jumping the countdown timer
ctx.state.countT = 3.5;
for (let i = 0; i < 5; i++) ctx.update(ctx.performance.now() + 100 + i*16);
console.log('after countdown completes:');
console.log('  phase:', ctx.state.phase);
for (let i = 0; i < 5; i++) ctx.update(ctx.performance.now() + i*16);
console.log('after 5 countdown frames:');
console.log('  cars spawned:', ctx.state.cars.length);
console.log('  car0 pos:', ctx.state.cars[0].x.toFixed(1), ctx.state.cars[0].y.toFixed(1), 'angle:', ctx.state.cars[0].angle.toFixed(2));
console.log('  car1 (AI aggressive) pos:', ctx.state.cars[1].x.toFixed(1), ctx.state.cars[1].y.toFixed(1));

// transition to racing
ctx.state.phase = "racing";
ctx.state.raceStartMs = ctx.performance.now();
for (const c of ctx.state.cars) c.lastLapStart = ctx.performance.now();

for (let i = 0; i < 60; i++) ctx.update(ctx.performance.now() + 100 + i*16);
console.log('after 60 racing frames (no input):');
console.log('  player speed:', ctx.state.cars[0].speed.toFixed(1));
console.log('  car1 (AI) speed:', ctx.state.cars[1].speed.toFixed(1));
console.log('  car1 progress:', ctx.state.cars[1].progress.toFixed(1));
console.log('  skids:', ctx.state.skids.length);

ctx.keys.KeyW = true;
for (let i = 0; i < 60; i++) ctx.update(ctx.performance.now() + 200 + i*16);
console.log('after 60 more frames accelerating:');
console.log('  player speed:', ctx.state.cars[0].speed.toFixed(1));
console.log('  player pos:', ctx.state.cars[0].x.toFixed(1), ctx.state.cars[0].y.toFixed(1));
console.log('  off-track?', ctx.isOffTrack(ctx.state.cars[0].x, ctx.state.cars[0].y));

ctx.state.phase = "racing";
for (let i = 0; i < 1200; i++) ctx.update(ctx.performance.now() + 1000 + i*16);
console.log('after 1200 more frames:');
for (let i = 0; i < ctx.state.cars.length; i++) {
  const c = ctx.state.cars[i];
  console.log('  car', i, c.name, 'pos:', c.x.toFixed(0), c.y.toFixed(0), 'speed:', c.speed.toFixed(0), 'lap:', c.lap, 'finished:', c.finished);
}
console.log('SMOKE TEST PASSED');
