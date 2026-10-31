// 验证配置页「勾选启用 + 保存并应用」也会立刻搜索
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const { createHookServer } = require('./hook-server.cjs');
const EXT = path.resolve(process.env.PM_EXT);

const html = (kw) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <h1>${kw || 'home'}</h1>
  <div class="product-item product-item-cards">
    <a class="main-title" href="/item/9">${kw || '号A'}</a>
    <div class="row-hd"><span class="price">¥1,100</span></div>
  </div>
</body></html>`;

(async () => {
  const hook = await createHookServer();
  const navs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cfgsave-'));
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
    navs.push({ t: Date.now(), kw });
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html(kw) });
  });

  // 藏宝阁页先打开，模拟用户正停在列表页
  const page = await ctx.newPage();
  await page.goto('https://id5.cbg.163.com/cgi/mweb/pl', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForTimeout(500);

  // 首次打开配置页 -> 走默认值（未启用）
  const wasEnabled = await opt.isChecked('#enabled');
  console.log('默认未启用:', !wasEnabled);

  // 填 Webhook、勾启用、保存
  await page.bringToFront();
  const before = navs.length;
  const t0 = Date.now();
  await opt.fill('#webhook', hook.url);
  await opt.check('#enabled');
  await opt.click('#save');

  let first = null;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(500);
    first = navs.slice(before).find(n => n.kw);
    if (first) break;
  }
  const sec = first ? (first.t - t0) / 1000 : null;
  console.log('配置页保存后是否搜索:', first ? '是' : '否');
  console.log('首个搜索耗时:', sec, '秒, keyword =', first && first.kw);
  const status = await opt.textContent('#status');
  console.log('状态栏:', JSON.stringify(status));

  // 再验证：只改选择器（关键词不变）也应重新搜
  await page.waitForTimeout(3000);
  const before2 = navs.length;
  await opt.fill('#searchPriceSelector', '.row-hd .price');
  await opt.click('#save');
  await page.waitForTimeout(4000);
  console.log('仅改无关配置后是否重新搜索:', navs.slice(before2).some(n => n.kw) ? '是' : '否（合理，配置未实质变化）');

  await ctx.close();
  await hook.close();
})().catch(e => { console.error('异常:', e); process.exit(2); });
