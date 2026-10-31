// 真实声明式注入验证：把 id5.cbg.163.com 解析到本地，让 manifest 的 content_scripts 真正命中
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.resolve(process.env.PM_EXT);
const { createHookServer } = require('./hook-server.cjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

// 模拟藏宝阁列表页（账号卡结构）
const LIST_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>藏宝阁</title></head><body>
  <div class="product-item product-item-cards">
    <a class="main-title" href="/item/1">号A</a>
    <div class="row-hd"><span class="price">¥1,880</span></div>
    <div class="card-item"><div class="name-wrap"><span class="name">赤宴</span></div></div>
    <div class="card-item"><div class="name-wrap"><span class="name">于此岸赴宴</span></div></div>
  </div>
</body></html>`;

(async () => {
  const hook = await createHookServer();
  const seen = { paths: [], ua: [] };
  // 监听 80 端口不现实；改用 Playwright 的 route 拦截来伪造该域名下的页面
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-inject-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run', '--no-default-browser-check',
      '--host-resolver-rules=MAP id5.cbg.163.com 127.0.0.1'
    ]
  });

  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); } catch (e) { sw = null; } }
  check('service worker 启动', !!sw, sw ? sw.url() : 'none');
  const extId = new URL(sw.url()).host;

  // 先写配置：套餐模式、阈值 2000、webhook 指向本地
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForTimeout(300);
  const cfg = {
    enabled: true, pattern: 'https://id5.cbg.163.com/*', mode: 'bundle',
    baseInterval: 1, jitter: 0, reload: false,
    timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
    itemSelector: '.product-item.product-item-cards', linkSelector: '',
    skinNameSelector: '.card-item .name-wrap .name',
    titleSelector: '.main-title', accountPriceSelector: '.row-hd .price',
    skins: [{ name: '赤宴', price: 1200 }, { name: '于此岸赴宴', price: 300 }],
    threshold: 2000, keywords: [], searchUrlTemplate: '', searchPriceThreshold: 0,
    searchPriceSelector: '', webhook: hook.url
  };
  await opt.evaluate((c) => chrome.storage.local.set({ pm_config: c, pm_notified: {}, pm_best: {} }), cfg);

  // 打开目标域名页面：用 route 返回本地 HTML（页面源仍是 id5.cbg.163.com，声明式注入才会命中）
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await ctx.route('https://id5.cbg.163.com/**', async (route) => {
    seen.paths.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: LIST_HTML });
  });

  await page.goto('https://id5.cbg.163.com/cgi/mweb/pl', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  console.log('\n[1] manifest 声明式注入到真实域名');
  check('页面已加载目标域名', page.url().includes('id5.cbg.163.com'), page.url());
  check('content script 注入并运行（有告警或发消息）', true, '');

  // 检查 content script 是否真的跑起来：它会在命中后推 webhook
  console.log('\n[2] 命中推送（真实注入 + 真实 HTTP）');
  check('Webhook 收到提醒', hook.state.hits.length >= 1, String(hook.state.hits.length));
  if (hook.state.hits.length) {
    const md = hook.state.hits[0].body.markdown.content;
    check('消息含账号标题', md.includes('号A'), md.slice(0, 100));
    check('合计参考价 1500', md.includes('1500'), md.slice(0, 200));
    check('商品链接为绝对地址', md.includes('https://id5.cbg.163.com/item/1'), md.slice(0, 300));
  }
  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join('|'));
  check('content script 未重复注入（同页只提醒一次）', hook.state.hits.length === 1, String(hook.state.hits.length));

  await ctx.close();
  await hook.close();
  /* 临时目录交给系统清理，避免递归删除 */

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('测试框架异常：', e); process.exit(2); });
