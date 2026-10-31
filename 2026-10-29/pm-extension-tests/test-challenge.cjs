// 验证风控识别：出现验证页/拦截页时，应立即停止跳转、记录日志、推送企微
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const CONTENT_SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const { createHookServer } = require('./hook-server.cjs');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

// 各种被拦截/要求验证的页面形态
const PAGES = {
  slider: `<html><body><div id="nc_1_wrapper"><div>请拖动滑块完成验证</div></div></body></html>`,
  text: `<html><body><h2>访问过于频繁</h2><p>请稍后再试</p></body></html>`,
  forbidden: `<html><body><h1>禁止访问</h1><p>您的访问请求异常</p></body></html>`,
  login: `<html><head><title>登录第五人格藏宝阁</title></head><body>登录 未注册手机可用验证码直接登录</body></html>`,
  // 正常商品页，但含"登录""验证码"等易误判词
  normalWithWords: `<html><head><title>第五人格藏宝阁</title></head><body>
    <div class="top">登录 | 注册 | 获取验证码</div>
    <div class="product-item product-item-cards">
      <a class="main-title" href="/item/9">号A</a>
      <div class="row-hd"><span class="price">¥1,100</span></div>
    </div>
    <div class="footer">客服：请勿轻信索要验证码的陌生人</div></body></html>`,
  normal: `<html><body><div class="product-item product-item-cards">
      <a class="main-title" href="/item/9">号A</a>
      <div class="row-hd"><span class="price">¥1,100</span></div>
    </div></body></html>`
};

(async () => {
  const navs = [];
  let currentPage = 'normal';
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    navs.push({ t: Date.now(), kw: u.searchParams.get('keyword') || '', path: u.pathname });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGES[currentPage] || PAGES.normal);
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${s.address().port}`;

  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });

  const runCase = async (pageKey, label) => {
    currentPage = pageKey;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(String(e)));

    const cfg = {
      enabled: true, pattern: origin + '/*', mode: 'search',
      baseInterval: 60, jitter: 0,
      hopMinSec: 15, hopMaxSec: 15,
      timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
      itemSelector: '.product-item.product-item-cards', linkSelector: '',
      skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
      skins: [], threshold: 0,
      keywords: [{ name: '赤宴', target: 1200 }, { name: '蜃景', target: 1000 }],
      searchUrlTemplate: origin + '/pl?keyword={keyword}&order_by=price%20ASC',
      searchPriceThreshold: 50, searchPriceSelector: '.row-hd .price',
      searchPassId: 'p1', runToken: 'r1', webhook: hook.url
    };

    await p.addInitScript(({ seed }) => {
      const KEY = '__pm_store';
      if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(seed));
      const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
      window.__readStore = read;
      window.__sent = [];
      window.chrome = {
        storage: {
          local: {
            get(k) {
              const st = read();
              const list = k == null ? Object.keys(st) : (Array.isArray(k) ? k : [k]);
              const o = {}; list.forEach(x => { if (x in st) o[x] = st[x]; });
              return Promise.resolve(JSON.parse(JSON.stringify(o)));
            },
            set(obj) { const st = read(); Object.assign(st, JSON.parse(JSON.stringify(obj))); localStorage.setItem(KEY, JSON.stringify(st)); return Promise.resolve(); },
            remove(k) { const st = read(); (Array.isArray(k) ? k : [k]).forEach(x => delete st[x]); localStorage.setItem(KEY, JSON.stringify(st)); return Promise.resolve(); }
          },
          onChanged: { addListener() {} }
        },
        runtime: {
          lastError: undefined,
          sendMessage(m, cb) { window.__sent.push(m); if (cb) cb({ ok: true }); }
        }
      };
    }, { seed: { pm_config: cfg, pm_notified: {}, pm_best: {}, pm_log: [] } });

    await p.addInitScript({ content: CONTENT_SRC });
    const navBefore = navs.length;
    await p.goto(`${origin}/pl?keyword=${encodeURIComponent('赤宴')}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(14000);   // 超过 RENDER_WAIT_MS

    const out = await p.evaluate(() => ({
      sent: window.__sent,
      logs: (window.__readStore().pm_log) || [],
      paused: window.__readStore().pm_paused_reason || null
    }));

    const jumpedAfter = navs.slice(navBefore + 1);   // 第一次是 goto 本身
    console.log(`\n[${label}]`);
    console.log('  日志:', out.logs.map(l => l.result).join(' | ') || '(无)');
    console.log('  发送消息:', out.sent.map(m => m.type).join(',') || '(无)');
    console.log('  暂停标记:', out.paused ? out.paused.reason : '(无)');
    console.log('  后续跳转:', jumpedAfter.filter(n => n.kw).map(n => n.kw).join(',') || '(无)');

    await ctx.close();
    return { out, jumpedAfter: jumpedAfter.filter(n => n.kw), errs };
  };

  // ---- 1. 滑块验证 ----
  const r1 = await runCase('slider', '1 滑块验证');
  check('识别出需要验证', r1.out.paused && /验证/.test(r1.out.paused.reason), JSON.stringify(r1.out.paused));
  check('发送了 PM_CHALLENGE', r1.out.sent.some(m => m.type === 'PM_CHALLENGE'), JSON.stringify(r1.out.sent.map(m => m.type)));
  check('风控已记入日志', r1.out.logs.some(l => /已暂停监控/.test(l.result || '')), JSON.stringify(r1.out.logs.map(l => l.result)));
  check('停止后续跳转（不再搜下一个词）', r1.jumpedAfter.length === 0, JSON.stringify(r1.jumpedAfter.map(n => n.kw)));

  // ---- 2. 访问过于频繁 ----
  const r2 = await runCase('text', '2 访问过于频繁');
  check('识别出频率限制', r2.out.paused && r2.out.paused.reason, JSON.stringify(r2.out.paused));
  check('停止后续跳转', r2.jumpedAfter.length === 0, JSON.stringify(r2.jumpedAfter.map(n => n.kw)));

  // ---- 3. 禁止访问 ----
  const r3 = await runCase('forbidden', '3 禁止访问');
  check('识别出禁止访问', r3.out.paused && /访问/.test(r3.out.paused.reason), JSON.stringify(r3.out.paused));

  // ---- 4. 被跳到登录页 ----
  const r4 = await runCase('login', '4 登录页');
  check('识别出登录页', r4.out.paused && /登录/.test(r4.out.paused.reason), JSON.stringify(r4.out.paused));

  // ---- 5. 正常页面不应误报 ----
  const r5 = await runCase('normal', '5 正常页面（不应误报）');
  check('正常页面不触发风控', !r5.out.paused, JSON.stringify(r5.out.paused));
  check('正常页面继续读取价格', r5.out.logs.some(l => l.price != null), JSON.stringify(r5.out.logs.map(l => l.price)));

  // ---- 5b. 正常页含"登录/验证码"等词，不应误判 ----
  const r5b = await runCase('normalWithWords', '5b 正常页含验证码等字样（不应误报）');
  check('含"登录/获取验证码"的正常页不误报', !r5b.out.paused, JSON.stringify(r5b.out.paused));
  check('正常读取价格', r5b.out.logs.some(l => l.price != null), JSON.stringify(r5b.out.logs.map(l => l.price)));

  // ---- 6. background 收到 PM_CHALLENGE 后推企微 ----
  console.log('\n[6] 后台报警推送');
  hook.reset();
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  const bgStore = { pm_config: { webhook: hook.url } };
  await p2.addInitScript(({ store }) => {
    window.__store = store;
    window.__notifs = [];
    window.__listeners = [];
    window.chrome = {
      storage: {
        local: {
          get(k) { const list = k == null ? Object.keys(window.__store) : (Array.isArray(k) ? k : [k]);
                   const o = {}; list.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; });
                   return Promise.resolve(JSON.parse(JSON.stringify(o))); },
          set(o) { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); }
        }
      },
      notifications: {
        create(id, opts) { window.__notifs.push({ id, opts }); return Promise.resolve(id); },
        clear() { return Promise.resolve(true); },
        onClicked: { addListener() {} }
      },
      runtime: { onMessage: { addListener(fn) { window.__listeners.push(fn); } }, lastError: undefined },
      tabs: { create() { return Promise.resolve(); } }
    };
  }, { store: bgStore });
  await p2.goto(hook.pageUrl);
  await p2.addScriptTag({ content: BG_SRC });

  const deliver = (msg) => p2.evaluate((m) => new Promise((resolve) => {
    const fn = window.__listeners[0];
    const ret = fn(m, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'listener not returning true' });
  }), msg);

  const res = await deliver({
    type: 'PM_CHALLENGE', reason: '页面要求验证：请拖动滑块完成验证',
    url: 'https://id5.cbg.163.com/cgi/mweb/pl?keyword=x', keyword: '赤宴', hasWidget: true
  });
  check('后台返回成功', res && res.ok === true, JSON.stringify(res));
  check('企微收到报警', hook.state.hits.length === 1, String(hook.state.hits.length));
  const md = (hook.state.hits[0] && hook.state.hits[0].body.markdown.content) || '';
  console.log('  消息内容:\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  check('消息含"已自动暂停"', /暂停/.test(md), '');
  check('消息含原因', /滑块|验证/.test(md), '');
  check('消息含恢复步骤', /监控当前页面/.test(md), '');
  check('消息含页面链接', /id5\.cbg\.163\.com/.test(md), '');
  check('弹出本地通知', await p2.evaluate(() => window.__notifs.length) === 1, '');

  await ctx2.close();
  await browser.close();
  await new Promise(r => s.close(r));
  await hook.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
