// 完整验证用户的三个诉求：
// 1) 点启用 → 立刻搜索
// 2) 跑过一轮后回到主页 → 仍会去搜索
// 3) 关掉再开启 → 立刻重新搜索一遍
// 4) 副作用检查：停在商品详情页时不被劫持跳走
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const { createHookServer } = require('./hook-server.cjs');
const EXT = path.resolve(process.env.PM_EXT);

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

const listHtml = (kw) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <h1>${kw || 'home'}</h1>
  <div class="product-item product-item-cards">
    <a class="main-title" href="/item/9">${kw || '号A'}</a>
    <div class="row-hd"><span class="price">¥1,100</span></div>
  </div>
</body></html>`;

const detailHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <h1>商品详情页</h1><div class="detail-body">这是详情，不应该被自动跳走</div>
</body></html>`;

(async () => {
  const hook = await createHookServer();
  const navs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-final-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-first-run', '--no-default-browser-check']
  });
  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); } catch (e) {} }
  const extId = new URL(sw.url()).host;

  await ctx.route('https://id5.cbg.163.com/**', async (route) => {
    const u = new URL(route.request().url());
    const kw = u.searchParams.get('keyword') || '';
    navs.push({ t: Date.now(), kw, path: u.pathname });
    const body = /\/item\//.test(u.pathname) ? detailHtml : listHtml(kw);
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });

  const base = {
    enabled: true, pattern: 'https://id5.cbg.163.com/*', mode: 'search',
    baseInterval: 60, jitter: 30, reload: true,
    timeWindowEnabled: false, windowStart: 9, windowEnd: 23,
    itemSelector: '.product-item.product-item-cards', linkSelector: '',
    skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
    skins: [], threshold: 0,
    keywords: [
      { name: '于此岸赴宴', target: 300 },
      { name: '蜃景', target: 1000 },
      { name: '赤宴', target: 1200 }
    ],
    searchUrlTemplate: 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC',
    searchPriceThreshold: 50, searchPriceSelector: '.row-hd .price',
    hopMinSec: 15, hopMaxSec: 15,
    webhook: hook.url
  };

  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/options.html`);
  await pop.waitForTimeout(300);
  await pop.evaluate(async (c) => {
    await chrome.storage.local.set({ pm_config: { ...c, enabled: false, searchPassId: 'p0', runToken: 'r0' }, pm_notified: {}, pm_best: {} });
  }, base);

  // ============ 诉求 1：点启用就搜索 ============
  console.log('\n[诉求 1] 从"未启用"点开启 → 应立刻搜索');
  const page = await ctx.newPage();
  await page.goto('https://id5.cbg.163.com/cgi/mweb/pl', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.bringToFront();

  const popPage = await ctx.newPage();
  await popPage.goto(`chrome-extension://${extId}/popup.html`);
  await popPage.waitForTimeout(300);
  const before1 = navs.length;
  const t1 = Date.now();
  await popPage.evaluate(() => document.getElementById('enabled').click());

  let firstSearch1 = null;
  for (let i = 0; i < 20; i++) {
    await popPage.waitForTimeout(500);
    firstSearch1 = navs.slice(before1).find(n => n.kw);
    if (firstSearch1) break;
  }
  const sec1 = firstSearch1 ? (firstSearch1.t - t1) / 1000 : null;
  check('开启后立刻发起搜索', !!firstSearch1, JSON.stringify(navs.slice(before1).map(n => n.kw)));
  check('首个搜索在 5 秒内', sec1 != null && sec1 <= 5, sec1 == null ? '未搜索' : sec1 + 's');
  console.log('    首个搜索耗时:', sec1, '秒，keyword =', firstSearch1 && firstSearch1.kw);

  await page.waitForTimeout(40000);   // 轮内间隔 15s，等三个关键词跑完
  const round1 = navs.slice(before1).filter(n => n.kw).map(n => n.kw);
  check('首轮把 3 个关键词都搜了', [...new Set(round1)].length === 3, JSON.stringify(round1));

  // ============ 诉求 2：回到主页仍会搜索 ============
  console.log('\n[诉求 2] 跑过一轮后回到主页 → 应仍然去搜索');
  const before2 = navs.length;
  await page.goto('https://id5.cbg.163.com/', { waitUntil: 'domcontentloaded' });
  let firstSearch2 = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    firstSearch2 = navs.slice(before2).find(n => n.kw);
    if (firstSearch2) break;
  }
  check('回主页后会去搜索', !!firstSearch2, JSON.stringify(navs.slice(before2).map(n => n.kw)));

  // ============ 诉求 3：关掉再开启 ============
  console.log('\n[诉求 3] 关掉再开启 → 应立刻重新搜索一遍');
  await page.goto('https://id5.cbg.163.com/cgi/mweb/pl', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.bringToFront();
  // 重新打开弹窗页（先前那次导航后可能已失效）
  await popPage.goto(`chrome-extension://${extId}/popup.html`);
  await popPage.waitForTimeout(400);
  const before3 = navs.length;
  await popPage.evaluate(() => document.getElementById('enabled').click()); // 关
  await popPage.waitForTimeout(3500);   // 等关闭后的残留跳转全部安静下来
  const before3b = navs.length;
  const t3 = Date.now();
  await popPage.evaluate(() => document.getElementById('enabled').click()); // 开
  let firstSearch3 = null;
  for (let i = 0; i < 20; i++) {
    await popPage.waitForTimeout(500);
    firstSearch3 = navs.slice(before3b).find(n => n.kw);
    if (firstSearch3) break;
  }
  const sec3 = firstSearch3 ? (firstSearch3.t - t3) / 1000 : null;
  check('重新开启后立刻搜索', !!firstSearch3, JSON.stringify(navs.slice(before3b).map(n => n.kw)));
  check('重新开启后 5 秒内出结果', sec3 != null && sec3 <= 5, sec3 == null ? '未搜索' : sec3 + 's');
  console.log('    重新开启耗时:', sec3, '秒');

  // ============ 副作用：详情页不被劫持 ============
  console.log('\n[副作用检查] 停在商品详情页时不应被强制跳走');
  const before4 = navs.length;
  await page.goto('https://id5.cbg.163.com/cgi/mweb/item/12345', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const detailNavs = navs.slice(before4).filter(n => n.kw);
  check('详情页不会被自动跳去搜索', detailNavs.length === 0, JSON.stringify(detailNavs.map(n => n.kw)));
  const stillOnDetail = page.url().includes('/item/');
  check('仍停留在详情页', stillOnDetail, page.url());

  await ctx.close();
  await hook.close();

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
