// 验证后台保活：alarms 是否注册、白页是否能被识别并自动重载
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

// 模拟「白页」：返回几乎没有内容的页面
const blank = `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title></head><body></body></html>`;
let serveBlank = true;
const normal = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
  <div class="product-item product-item-cards">
    <a class="main-title" href="/item/1">号A</a>
    <div class="row-hd"><span class="price">¥1,100</span></div>
  </div></body></html>`;

(async () => {
  const http = require('http');
  const hits = [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-keep-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-first-run', '--no-default-browser-check']
  });

  // 用 route 拦截该域名（避免 https↔http 映射的 SSL 问题）
  const routeHandler = async (route) => {
    hits.push({ t: Date.now(), url: route.request().url() });
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: serveBlank ? blank : normal
    });
  };
  await ctx.route('https://id5.cbg.163.com/**', routeHandler);

  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }); } catch (e) {} }
  check('service worker 启动', !!sw, sw ? sw.url() : 'none');
  if (!sw) { await ctx.close(); process.exit(1); }
  const extId = new URL(sw.url()).host;

  console.log('\n[1] alarms 是否注册');
  const alarms = await sw.evaluate(async () => {
    const all = await chrome.alarms.getAll();
    return all.map(a => ({ name: a.name, period: a.periodInMinutes }));
  });
  check('已注册 pm-keepalive 定时任务', alarms.some(a => a.name === 'pm-keepalive'), JSON.stringify(alarms));
  const ka = alarms.find(a => a.name === 'pm-keepalive');
  check('周期为 5 分钟', ka && ka.period === 5, ka && String(ka.period));

  console.log('\n[2] 保活脚本函数可用');
  const hasFn = await sw.evaluate(() => typeof tickKeepAlive === 'function');
  check('tickKeepAlive 已加载', hasFn, String(hasFn));

  console.log('\n[3] 白页检测 + 自动重载');
  // 准备一个「白页」标签页
  const keep = await ctx.newPage();
  await keep.goto(`https://id5.cbg.163.com/cgi/mweb/pl`, { waitUntil: 'domcontentloaded' });
  await keep.waitForTimeout(800);

  // 写入启用配置（无 webhook，避免真实推送）
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      pm_config: {
        enabled: true, pattern: 'https://id5.cbg.163.com/*', mode: 'search',
        baseInterval: 1200, jitter: 300, reload: true,
        timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
        itemSelector: '.product-item.product-item-cards', linkSelector: '',
        skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
        skins: [], threshold: 0,
        keywords: [{ name: '赤宴', target: 1200 }],
        searchUrlTemplate: 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC',
        searchPriceThreshold: 50, searchPriceSelector: '.row-hd .price',
        webhook: ''
      },
      pm_log: [], pm_notified: {}, pm_best: {}
    });
  });

  const before = hits.length;
  const r1 = await sw.evaluate(() => tickKeepAlive());
  await keep.waitForTimeout(1500);
  const reloaded = hits.length - before;
  console.log('  巡检结果:', JSON.stringify(r1), '重载次数:', reloaded);

  check('识别出白页', r1 && (r1.recovered > 0 || r1.action === 'no-tab'), JSON.stringify(r1));
  check('白页被自动重载', reloaded >= 1, '重载 ' + reloaded + ' 次');

  console.log('\n[4] 页面正常时不误重载');
  serveBlank = false;
  await keep.goto('https://id5.cbg.163.com/cgi/mweb/pl', { waitUntil: 'domcontentloaded' });
  await keep.waitForTimeout(1200);
  const before2 = hits.length;
  const r2 = await sw.evaluate(() => tickKeepAlive());
  await keep.waitForTimeout(1200);
  const reloaded2 = hits.length - before2;
  console.log('  巡检结果:', JSON.stringify(r2), '重载次数:', reloaded2);
  check('正常页面不被重载', reloaded2 === 0, '重载 ' + reloaded2 + ' 次（应 0）');

  console.log('\n[5] 长时间无查询 → 报警');
  await sw.evaluate(async () => {
    // 制造一条 3 小时前的日志
    await chrome.storage.local.set({
      pm_log: [{ ts: Date.now() - 3 * 3600 * 1000, time: 'old', keyword: 'x', price: 1, hit: false, result: 'x' }],
      pm_stale_notified_at: 0
    });
  });
  const beforeNotifs = await sw.evaluate(async () => {
    const o = await chrome.storage.local.get('pm_stale_notified_at');
    return o.pm_stale_notified_at;
  });
  const r3 = await sw.evaluate(() => tickKeepAlive());
  console.log('  巡检结果:', JSON.stringify(r3));
  check('检测到停摆', r3 && r3.staleWarned === true, JSON.stringify(r3));
  const afterNotifs = await sw.evaluate(async () => (await chrome.storage.local.get('pm_stale_notified_at')).pm_stale_notified_at);
  check('写入了报警时间戳', afterNotifs > 0 && afterNotifs !== beforeNotifs, String(afterNotifs));

  console.log('\n[6] 未启用时不打扰');
  await sw.evaluate(async () => {
    const { pm_config } = await chrome.storage.local.get('pm_config');
    await chrome.storage.local.set({ pm_config: { ...pm_config, enabled: false }, pm_stale_notified_at: 0 });
  });
  const r4 = await sw.evaluate(() => tickKeepAlive());
  check('未启用直接跳过', r4 && r4.skipped === '未启用', JSON.stringify(r4));

  await ctx.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
