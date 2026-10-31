// 验证「自适应轮内间隔」在不同皮肤数量下的表现（纯算法层，不需要浏览器）
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

// 从源码里抠出算法函数，用 vm 执行（避免依赖浏览器环境）
const vm = require('vm');
function extract(name) {
  const i = SRC.indexOf('function ' + name);
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const consts = `
const HOP_FLOOR_MS = 15000;
const HOP_MIN_MS = 20000;
const HOP_MAX_MS = 45000;
function toNum(v, d) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : d; }
`;
const fns = ['roundPeriodMs', 'adaptiveHopDelay', 'estimateRoundMs'].map(extract).join('\n');

function makeCtx(cfg) {
  const sandbox = { cfg, Math, Date, isFinite, parseFloat, console };
  vm.createContext(sandbox);
  vm.runInContext(consts + '\n' + fns, sandbox);
  return sandbox;
}

// 默认配置：30 分钟一轮 + 5 分钟抖动
const cfg = { baseInterval: 1800, jitter: 300, hopMinSec: 20, hopMaxSec: 45 };

console.log('\n[1] 不同皮肤数量下，一轮实际耗时是否落在整轮周期内');
const period = 1800 * 1000;   // 30 分钟（不含抖动）
for (const n of [3, 5, 10, 20, 30, 60, 100]) {
  const ctx = makeCtx(cfg);
  // 蒙特卡洛：跑 200 轮，统计一轮总耗时
  let within = 0, total = 0;
  const samples = [];
  for (let k = 0; k < 200; k++) {
    let sum = 0;
    for (let i = 0; i < n - 1; i++) sum += ctx.adaptiveHopDelay(n);
    samples.push(sum);
    total += sum;
    if (sum <= period + 300 * 1000) within++;   // 含抖动上限
  }
  const avgMin = (total / samples.length / 60000).toFixed(1);
  const maxMin = (Math.max(...samples) / 60000).toFixed(1);
  console.log(`  ${String(n).padStart(3)} 个词 → 轮内平均 ${avgMin} 分钟，最长 ${maxMin} 分钟（周期上限约 35 分钟）`);
  // 词数不超过 100 时都应能在周期内跑完
  check(`${n} 个词一轮不超出周期`, within === 200, `${within}/200 超时`);
}

console.log('\n[2] 词少时不应被无意义地拖慢（上限 45 秒生效）');
{
  const ctx = makeCtx(cfg);
  const hops = Array.from({ length: 300 }, () => ctx.adaptiveHopDelay(3));
  const maxHop = Math.max(...hops) / 1000;
  const minHop = Math.min(...hops) / 1000;
  console.log(`  3 个词的轮内间隔范围：${minHop.toFixed(1)}~${maxHop.toFixed(1)} 秒`);
  check('3 个词时轮内间隔不超过 45 秒上限', maxHop <= 45.5, maxHop.toFixed(1));
  check('3 个词时轮内间隔不低于 15 秒下限', minHop >= 14.9, minHop.toFixed(1));
}

console.log('\n[3] 词多时逼近下限但不突破');
{
  const ctx = makeCtx(cfg);
  const hops = Array.from({ length: 300 }, () => ctx.adaptiveHopDelay(100));
  const maxHop = Math.max(...hops) / 1000;
  const minHop = Math.min(...hops) / 1000;
  console.log(`  100 个词的轮内间隔范围：${minHop.toFixed(1)}~${maxHop.toFixed(1)} 秒`);
  check('100 个词时间隔降到你设的下限附近（不突破下限）', maxHop <= 21, maxHop.toFixed(1));
  check('不会为了赶上周期而低于你设的下限 20 秒', minHop >= 19.9, minHop.toFixed(1));
}

console.log('\n[4] 极端：词数多到无法在周期内跑完时，仍守住下限（不加速）');
{
  const ctx = makeCtx(cfg);
  const n = 500;
  const hops = Array.from({ length: 50 }, () => ctx.adaptiveHopDelay(n));
  const minHop = Math.min(...hops) / 1000;
  const roundMin = ((n - 1) * 15) / 60;
  console.log(`  500 个词：单跳最低 ${minHop.toFixed(1)} 秒，一轮至少 ${roundMin.toFixed(0)} 分钟`);
  check('不因跑不完而突破 15 秒下限', minHop >= 14.9, minHop.toFixed(1));
}

console.log('\n[5] estimator 输出与实算一致');
{
  const ctx = makeCtx(cfg);
  const est = ctx.estimateRoundMs(10);
  const real = Array.from({ length: 50 }, () => {
    let s = 0; for (let i = 0; i < 9; i++) s += ctx.adaptiveHopDelay(10);
    return s;
  });
  const avgReal = real.reduce((a, b) => a + b, 0) / real.length;
  console.log(`  估算一轮扫描 ${(est.scanMs / 60000).toFixed(1)} 分钟，实测平均 ${(avgReal / 60000).toFixed(1)} 分钟`);
  check('估算值与实测接近（误差 < 40%）',
    Math.abs(est.scanMs - avgReal) / avgReal < 0.4,
    `est=${(est.scanMs / 60000).toFixed(1)} real=${(avgReal / 60000).toFixed(1)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
