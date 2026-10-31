// content.js 端到端逻辑测试：真实 Chromium + chrome.* API 桩 + 本地模拟藏宝阁页
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { searchPage, listPage } = require('./mock-pages.cjs');

const EXT = path.join(__dirname, '..', 'price-monitor-extension');
const CONTENT_SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

// ---------- 本地站点 ----------
function startSite() {
  const hits = { navigations: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    hits.navigations.push(u.pathname + u.search);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u.pathname === '/pl') {
      const kw = u.searchParams.get('keyword') || '';
      const data = SCENARIO.search[kw];
      if (!data) { res.end(searchPage(kw, [])); return; }
      res.end(searchPage(kw, data));
    } else if (u.pathname === '/list') {
      res.end(listPage(SCENARIO.list));
    } else {
      res.end('<html><body>ok</body></html>');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, port: server.address().port, hits, close: () => new Promise(r => server.close(r)) });
  }));
}

// 场景数据（每个用例前重置）
let SCENARIO = { search: {}, list: [] };

// chrome.* 桩：由 Node 侧 store 驱动，跨导航保持
function initScriptFactory() {
  return ({ store, pushOk }) => {
    window.__store = store;
    window.__sent = [];
    window.__warns = [];
    window.__pushOk = pushOk !== false;
    const origWarn = console.warn.bind(console);
    console.warn = (...a) => { window.__warns.push(a.map(String).join(' ')); origWarn(...a); };
    window.chrome = {
      storage: {
        local: {
          get(keys) {
            const out = {};
            const list = keys == null ? Object.keys(window.__store)
              : (Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys)));
            list.forEach(k => { if (k in window.__store) out[k] = window.__store[k]; });
            return Promise.resolve(JSON.parse(JSON.stringify(out)));
          },
          set(obj) {
            Object.assign(window.__store, JSON.parse(JSON.stringify(obj)));
            return Promise.resolve();
          }
        },
        onChanged: { addListener() { /* 测试中不触发 */ } }
      },
      runtime: {
        lastError: undefined,
        sendMessage(msg, cb) {
          if (msg && msg.type === 'PM_HITS') window.__sent.push(msg);
          if (cb) cb(window.__pushOk ? { ok: true } : { ok: false, error: '模拟推送失败' });
        }
      }
    };
  };
}

async function withPage(browser, site, cfg, storeSeed, fn, opts) {
  const store = { pm_config: cfg, ...(storeSeed || {}) };
  const pushOk = !(opts && opts.pushOk === false);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(initScriptFactory(), { store, pushOk });

  const startPath = cfg.mode === 'search'
    ? `/pl?keyword=${encodeURIComponent(cfg.__startKeyword || '')}`
    : '/list';
  await page.goto(`http://127.0.0.1:${site.port}${startPath}`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: CONTENT_SRC });
  await page.waitForTimeout(opts && opts.wait != null ? opts.wait : 400);

  const read = async () => page.evaluate(() => ({
    sent: window.__sent,
    warns: window.__warns,
    store: window.__store
  }));

  try { await fn({ page, read, store, errors, site }); }
  finally { await ctx.close(); }
}

(async () => {
  const site = await startSite();
  const browser = await chromium.launch({ headless: true });

  const origin = `http://127.0.0.1:${site.port}`;
  const baseCfg = {
    enabled: true,
    pattern: origin + '/*',
    mode: 'bundle',
    baseInterval: 1, jitter: 0, reload: false,
    timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
    itemSelector: '.product-item.product-item-cards',
    linkSelector: '',
    skinNameSelector: '.card-item .name-wrap .name',
    titleSelector: '.main-title',
    accountPriceSelector: '.row-hd .price',
    skins: [{ name: '赤宴', price: 1200 }, { name: '蜃景', price: 1000 }, { name: '于此岸赴宴', price: 300 }],
    threshold: 2000,
    keywords: [], searchUrlTemplate: '', searchPriceThreshold: 0, searchPriceSelector: '',
    webhook: 'http://127.0.0.1:1/hook'
  };

  // ===== 1. bundle：合计低于阈值命中 =====
  console.log('\n[1] 皮肤套餐：合计参考价 < 阈值 → 命中');
  SCENARIO = {
    search: {},
    list: [
      { title: '号A', price: '¥1,880', href: '/item/1', skins: ['赤宴', '于此岸赴宴'] },  // 1500 < 2000 命中
      { title: '号B', price: '¥5,000', href: '/item/2', skins: ['赤宴', '蜃景'] }          // 2200 >= 2000 不命中
    ]
  };
  await withPage(browser, site, { ...baseCfg }, {}, async ({ read, errors }) => {
    const { sent, store } = await read();
    check('命中数量为 1', sent.length === 1, '实际 ' + sent.length);
    const h = sent[0] && sent[0].hits && sent[0].hits[0];
    check('命中项为 bundle 类型', h && h.kind === 'bundle', JSON.stringify(h));
    check('合计价 = 1500', h && h.sum === 1500, h && String(h.sum));
    check('命中皮肤 2 个', h && h.matched.length === 2, h && String(h.matched.length));
    check('商品链接解析为绝对地址', h && h.link === origin + '/item/1', h && h.link);
    check('账号售价解析 1880（千分位）', h && h.acctPrice === 1880, h && String(h.acctPrice));
    check('无未捕获异常', errors.length === 0, errors.join('|'));
    check('去重记录已落盘', store.pm_notified && Object.keys(store.pm_notified).length === 1,
      JSON.stringify(Object.keys(store.pm_notified || {})));
  });

  // ===== 2. bundle：去重（同页二次扫描不再提醒） =====
  console.log('\n[2] 皮肤套餐：同一账号重复扫描不重复提醒');
  const seed2 = {};
  await withPage(browser, site, { ...baseCfg }, {}, async ({ read }) => {
    const first = await read();
    check('首轮命中 1 次', first.sent.length === 1, String(first.sent.length));
    Object.assign(seed2, { pm_notified: first.store.pm_notified });
  });
  await withPage(browser, site, { ...baseCfg }, seed2, async ({ read }) => {
    const second = await read();
    check('带已有记录时不再提醒', second.sent.length === 0, String(second.sent.length));
  });

  // ===== 3. bundle：无命中 + 空选择器不崩 =====
  console.log('\n[3] 皮肤套餐：无命中 / 选择器填错均不崩溃');
  SCENARIO = { search: {}, list: [{ title: '号C', price: '¥99', href: '/item/3', skins: ['无关皮肤'] }] };
  await withPage(browser, site, { ...baseCfg }, {}, async ({ read, errors }) => {
    const { sent } = await read();
    check('无命中时发送 0 条', sent.length === 0, String(sent.length));
    check('无异常', errors.length === 0, errors.join('|'));
  });
  await withPage(browser, site, { ...baseCfg, itemSelector: 'div[[' }, {}, async ({ read, errors }) => {
    const r = await read();
    check('非法选择器不抛异常', errors.length === 0, errors.join('|'));
    check('非法选择器有告警', r.warns.some(w => w.includes('选择器')), JSON.stringify(r.warns));
  });

  // ===== 4. search：最低价 <= 目标 → 命中 =====
  console.log('\n[4] 搜索比价：最低价 ≤ 目标价 → 命中');
  SCENARIO = {
    search: {
      '赤宴': [
        { title: '赤宴号1', price: '¥1,150', href: '/item/11' },
        { title: '赤宴号2', price: '¥1,300', href: '/item/12' }
      ]
    },
    list: []
  };
  const searchCfg = {
    ...baseCfg,
    mode: 'search',
    keywords: [{ name: '赤宴', target: 1200 }],
    searchUrlTemplate: origin + '/pl?keyword={keyword}&order_by=price%20ASC',
    searchPriceThreshold: 0,
    searchPriceSelector: '.row-hd .price',
    __startKeyword: '赤宴'
  };
  await withPage(browser, site, searchCfg, {}, async ({ read, errors }) => {
    const r = await read();
    check('命中 1 条', r.sent.length === 1, String(r.sent.length));
    const h = r.sent[0] && r.sent[0].hits && r.sent[0].hits[0];
    check('类型 search', h && h.kind === 'search');
    check('最低价 1150', h && h.price === 1150, h && String(h.price));
    check('目标价 1200', h && h.threshold === 1200, h && String(h.threshold));
    check('带上商品链接', h && h.link === origin + '/item/11', h && h.link);
    check('无异常', errors.length === 0, errors.join('|'));
  });

  // ===== 5. search：价格未创新低不重复提醒 =====
  console.log('\n[5] 搜索比价：同一关键词价格未创新低 → 不重复提醒');
  const seed5 = { pm_best: { 'kw:赤宴': 1150 } };
  await withPage(browser, site, searchCfg, seed5, async ({ read }) => {
    const r = await read();
    check('相同价格不再提醒', r.sent.length === 0, String(r.sent.length));
  });
  SCENARIO.search['赤宴'] = [{ title: '赤宴号1', price: '¥1,099', href: '/item/13' }];
  await withPage(browser, site, searchCfg, seed5, async ({ read }) => {
    const r = await read();
    check('价格创新低再次提醒', r.sent.length === 1, String(r.sent.length));
    const h = r.sent[0] && r.sent[0].hits[0];
    check('新低价 1099', h && h.price === 1099, h && String(h.price));
  });

  // ===== 6. search：关键词含 % 和空格不崩溃（旧版 decodeURIComponent 会抛 URIError） =====
  console.log('\n[6] 搜索比价：关键词含 % / 空格 / 中文不崩溃');
  const weird = '100%纯血 赤宴';
  SCENARIO.search[weird] = [{ title: 'x', price: '¥800', href: '/item/21' }];
  await withPage(browser, site, { ...searchCfg, keywords: [{ name: weird, target: 900 }], __startKeyword: weird }, {}, async ({ read, errors }) => {
    const r = await read();
    check('含 % 的关键词不抛异常', errors.length === 0, errors.join('|'));
    check('含 % 的关键词能正常命中', r.sent.length === 1, String(r.sent.length));
  });

  // ===== 7. search：关键词轮转 =====
  console.log('\n[7] 搜索比价：多关键词自动轮转');
  SCENARIO.search = {
    '甲': [{ title: 'a', price: '¥10', href: '/item/a' }],
    '乙': [{ title: 'b', price: '¥10', href: '/item/b' }]
  };
  const navBefore = site.hits.navigations.length;
  await withPage(browser, site, {
    ...searchCfg,
    keywords: [{ name: '甲', target: 5 }, { name: '乙', target: 5 }],
    hopMinSec: 15, hopMaxSec: 15,   // 轮内间隔（有 15s 下限保护）
    __startKeyword: '甲'
  }, {}, async ({ page }) => {
    await page.waitForTimeout(20000);
    const navs = site.hits.navigations.slice(navBefore);
    check('发生了下一次跳转', navs.length >= 1, JSON.stringify(navs));
    check('跳转到下一个关键词「乙」', navs.some(n => decodeURIComponent(n).includes('乙')), JSON.stringify(navs));
  });

  // ===== 8. 时段外不工作 =====
  console.log('\n[8] 时段控制：窗口外不扫描/不跳转');
  SCENARIO = { search: {}, list: [{ title: '号D', price: '¥1', href: '/item/4', skins: ['赤宴'] }] };
  const hour = new Date().getHours();
  await withPage(browser, site, {
    ...baseCfg,
    timeWindowEnabled: true,
    windowStart: (hour + 2) % 24,
    windowEnd: (hour + 3) % 24
  }, {}, async ({ read }) => {
    const r = await read();
    check('时段外不发提醒', r.sent.length === 0, String(r.sent.length));
  });

  // ===== 9. 推送失败 → 回滚去重记录，下轮可重试 =====
  console.log('\n[9] 推送失败：去重记录回滚，下轮仍会重试');
  SCENARIO = { search: {}, list: [{ title: '号E', price: '¥1,500', href: '/item/5', skins: ['赤宴'] }] };
  let seed9 = {};
  await withPage(browser, site, { ...baseCfg }, {}, async ({ read }) => {
    const r = await read();
    check('推送失败时仍统计到命中', r.sent.length === 1, String(r.sent.length));
    check('推送失败后去重记录为空（已回滚）',
      !r.store.pm_notified || Object.keys(r.store.pm_notified).length === 0,
      JSON.stringify(r.store.pm_notified || {}));
    seed9 = { pm_notified: r.store.pm_notified || {} };
  }, { pushOk: false });
  await withPage(browser, site, { ...baseCfg }, seed9, async ({ read }) => {
    const r = await read();
    check('恢复后下一轮能重新提醒', r.sent.length === 1, String(r.sent.length));
    check('成功后去重记录写入', r.store.pm_notified && Object.keys(r.store.pm_notified).length === 1,
      JSON.stringify(r.store.pm_notified || {}));
  });

  // ===== 9b. 搜索模式推送失败 → pm_best 回滚，恢复后仍能提醒 =====
  console.log('\n[9b] 搜索模式推送失败：pm_best 回滚，恢复后仍能提醒');
  SCENARIO.search['赤宴'] = [{ title: '赤宴号1', price: '¥1,099', href: '/item/13' }];
  let seed9b = { pm_best: { 'kw:赤宴': 1150 } };
  await withPage(browser, site, searchCfg, seed9b, async ({ read }) => {
    const r = await read();
    check('推送失败仍统计到命中', r.sent.length === 1, String(r.sent.length));
    const b = (r.store.pm_best || {})['kw:赤宴'];
    check('pm_best 回滚为旧值 1150', b === 1150, String(b));
    seed9b = { pm_best: r.store.pm_best || {} };
  }, { pushOk: false });
  await withPage(browser, site, searchCfg, seed9b, async ({ read }) => {
    const r = await read();
    check('恢复后能再次提醒（未永久漏报）', r.sent.length === 1, String(r.sent.length));
    const b = (r.store.pm_best || {})['kw:赤宴'];
    check('成功后 pm_best 更新为 1099', b === 1099, String(b));
  });

  // ===== 10. enabled=false 完全不启动 =====
  console.log('\n[10] 未启用：完全不扫描');
  await withPage(browser, site, { ...searchCfg, enabled: false, mode: 'search' }, {}, async ({ read, page }) => {
    const navBase = site.hits.navigations.length; // 基线在页面加载之后再取
    await page.waitForTimeout(1500);
    const r = await read();
    check('未启用不提醒', r.sent.length === 0, String(r.sent.length));
    check('未启用不跳转', site.hits.navigations.length === navBase,
      JSON.stringify(site.hits.navigations.slice(navBase)));
  });

  // ===== 11. pattern 不匹配不启动 =====
  console.log('\n[11] 监控地址不匹配 → 不启动');
  await withPage(browser, site, { ...baseCfg, pattern: 'https://other.example.com/*' }, {}, async ({ read }) => {
    const r = await read();
    check('域名不匹配不提醒', r.sent.length === 0, String(r.sent.length));
  });

  await browser.close();
  await site.close();

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('测试框架异常：', e); process.exit(2); });
