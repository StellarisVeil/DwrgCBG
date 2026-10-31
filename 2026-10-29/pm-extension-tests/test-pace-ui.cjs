// 验证配置页「节奏预览」在不同关键词数量下的提示是否正确
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

const mkKeywords = (n) => Array.from({ length: n }, (_, i) => `皮肤${i + 1},1000`).join('\n');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-pace-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-first-run', '--no-default-browser-check']
  });
  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }); } catch (e) {} }
  const extId = new URL(sw.url()).host;

  const o = await ctx.newPage();
  const errs = [];
  o.on('pageerror', e => errs.push(String(e)));
  await o.goto(`chrome-extension://${extId}/options.html`);
  await o.waitForTimeout(600);

  const readPace = async () => (await o.textContent('#pacePreview') || '').replace(/\s+/g, ' ').trim();

  console.log('\n[1] 默认 3 个关键词');
  const p3 = await readPace();
  console.log('  ' + p3);
  check('显示关键词数量', /共 3 个关键词/.test(p3), p3.slice(0, 80));
  check('显示轮内间隔', /轮内相邻两个词之间/.test(p3), '');
  check('显示一轮耗时', /一整轮扫完约需/.test(p3), '');
  check('显示每轮间隔', /每轮之间间隔/.test(p3), '');
  check('判定可在周期内跑完', /✓/.test(p3), p3.slice(-80));

  console.log('\n[2] 皮肤增加到 30 个');
  await o.fill('#keywords', mkKeywords(30));
  await o.waitForTimeout(300);
  const p30 = await readPace();
  console.log('  ' + p30);
  check('数量更新为 30', /共 30 个关键词/.test(p30), p30.slice(0, 60));
  check('30 个词预算充足，不强制收紧（33s 在 20~45 上限内）', !/自动收紧/.test(p30), p30.slice(0, 80));
  check('30 个仍在周期内', /✓/.test(p30), p30.slice(-90));

  console.log('\n[3] 皮肤增加到 100 个');
  await o.fill('#keywords', mkKeywords(100));
  await o.waitForTimeout(300);
  const p100 = await readPace();
  console.log('  ' + p100);
  check('100 个仍能在周期内', /✓/.test(p100), p100.slice(-120));

  console.log('\n[4] 极端：300 个关键词应给出超时警告');
  await o.fill('#keywords', mkKeywords(300));
  await o.waitForTimeout(300);
  const p300 = await readPace();
  console.log('  ' + p300);
  check('给出超时警告', /⚠/.test(p300), p300.slice(-140));
  check('建议调大周期或减少关键词', /调大整轮间隔/.test(p300), '');

  console.log('\n[5] 切到套餐模式时提示不适用');
  await o.selectOption('#mode', 'bundle');
  await o.waitForTimeout(300);
  const pb = await readPace();
  console.log('  ' + pb);
  check('套餐模式提示轮内间隔不适用', /不适用/.test(pb), pb.slice(0, 80));

  check('全程无 JS 异常', errs.length === 0, errs.join('|'));

  await ctx.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
