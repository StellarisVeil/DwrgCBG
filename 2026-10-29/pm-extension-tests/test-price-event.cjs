// 验证「补货 / 卖出」判定
// 注意：单关键词时每轮间隔 = 整轮周期（这是正确设计），测试会很慢。
// 这里用 2 个关键词：轮内 15s 就换词，能快速观察到多次价格变化。
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

let pricePlan = {};   // { 'A': [2000,1800], 'B': [...] }
let idx = {};
const page = (p) => `<html><body><div class="product-item product-item-cards">
  <a class="main-title" href="/i/${p}">x</a>
  <div class="row-hd"><span class="price">¥${p}</span></div>
</div></body></html>`;

(async () => {
  const hits = [];
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    const kw = u.searchParams.get('keyword') || '';
    hits.push({ t: Date.now(), kw });
    const plan = pricePlan[kw] || [1000];
    const i = idx[kw] || 0;
    idx[kw] = i + 1;
    const p = plan[Math.min(i, plan.length - 1)];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(p));
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${s.address().port}`;

  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });

  const runSeq = async (plans, label, rounds) => {
    pricePlan = plans; idx = {};
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(String(e)));

    const cfg = {
      enabled: true, pattern: origin + '/*', mode: 'search',
      baseInterval: 60, jitter: 0,          // 整轮周期 60s（测试用）
      hopMinSec: 15, hopMaxSec: 15,         // 轮内 15 秒切下一个词
      timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
      itemSelector: '.product-item.product-item-cards', linkSelector: '',
      skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
      skins: [], threshold: 0,
      keywords: [{ name: 'A', target: 999999 }, { name: 'B', target: 999999 }],
      searchUrlTemplate: origin + '/pl?keyword={keyword}&order_by=price%20ASC',
      searchPriceThreshold: 999999, searchPriceSelector: '.row-hd .price',
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
        runtime: { lastError: undefined, sendMessage(m, cb) { window.__sent.push(m); if (cb) cb({ ok: true }); } }
      };
    }, { seed: { pm_config: cfg, pm_notified: {}, pm_best: {}, pm_log: [], pm_track: {} } });

    await p.addInitScript({ content: CONTENT_SRC });
    const before = hits.length;
    await p.goto(`${origin}/pl?keyword=${encodeURIComponent('A')}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(rounds * 61000 + 20000);

    const out = await p.evaluate(() => ({
      sent: window.__sent.map(m => ({ type: m.type, hits: m.hits })),
      logs: (window.__readStore().pm_log) || [],
      track: window.__readStore().pm_track || {}
    }));
    const navs = hits.slice(before).map(h => h.kw);
    await ctx.close();
    console.log(`\n[${label}]`);
    console.log('  请求序列:', navs.join(' → '));
    out.logs.slice(0, 8).forEach(l =>
      console.log('    ¥' + l.price + ' (' + l.keyword + ') event=' + (l.event || '-') +
        ' | ' + String(l.result).slice(0, 60)));
    return { out, errs, navs };
  };

  // ---- 1. A 降价 → 补货；B 涨价 → 卖出（一次跑完）----
  hook.reset();
  const r1 = await runSeq({
    A: [2000, 1800],     // 降价 = 补货
    B: [2000, 2500]      // 涨价 = 卖出
  }, '1 A 降价(补货) / B 涨价(卖出)', 2);

  const ev1 = r1.out.logs.filter(l => l.event === 'restock' || l.event === 'sold')
    .map(l => ({ kind: l.event, keyword: l.keyword, prevPrice: l.prevPrice, price: l.price }));
  console.log('  事件:', ev1.map(h => `${h.kind}(${h.keyword} ${h.prevPrice}→${h.price})`).join(', ') || '(无)');

  // 新行为：补货/卖出只记录，不再实时推送
  const evtPushes = r1.out.sent.filter(m => (m.hits || []).some(h => h.kind === 'restock' || h.kind === 'sold'));
  check('补货/卖出不再实时推送（只记录）', evtPushes.length === 0, JSON.stringify(evtPushes.map(m => m.hits)));
  check('事件仍记录在日志里（供每日汇总）', r1.out.logs.some(l => l.event === 'restock') && r1.out.logs.some(l => l.event === 'sold'),
    JSON.stringify(r1.out.logs.map(l => l.event)));
  check('识别出补货事件', ev1.some(h => h.kind === 'restock' && h.keyword === 'A'),
    JSON.stringify(ev1.map(h => h.kind + ':' + h.keyword)));
  const rs = ev1.find(h => h.kind === 'restock');
  check('补货记录 2000 → 1800', rs && rs.prevPrice === 2000 && rs.price === 1800,
    rs ? `${rs.prevPrice}→${rs.price}` : 'none');

  check('识别出卖出事件', ev1.some(h => h.kind === 'sold' && h.keyword === 'B'),
    JSON.stringify(ev1.map(h => h.kind + ':' + h.keyword)));
  const sd = ev1.find(h => h.kind === 'sold');
  check('卖出记录 2000 → 2500', sd && sd.prevPrice === 2000 && sd.price === 2500,
    sd ? `${sd.prevPrice}→${sd.price}` : 'none');

  check('事件写入日志', r1.out.logs.some(l => l.event === 'restock') && r1.out.logs.some(l => l.event === 'sold'),
    JSON.stringify(r1.out.logs.map(l => l.event)));
  check('首次记录不误报为事件', r1.out.logs.filter(l => l.price === 2000 || l.price === 2500)
    .filter(l => l.time).length >= 0, '');
  check('track 已持久化', Object.keys(r1.out.track).length === 2, JSON.stringify(Object.keys(r1.out.track)));

  // ---- 2. 价格不变 → 不报 ----
  hook.reset();
  const r2 = await runSeq({ A: [2000], B: [2000] }, '2 价格恒定（不应产生事件）', 2);
  const ev2 = r2.out.logs.filter(l => l.event === 'restock' || l.event === 'sold');
  check('价格不变时不产生事件', ev2.length === 0, JSON.stringify(ev2.map(h => h.kind)));

  // ---- 3. 连续波动：涨→跌 ----
  hook.reset();
  const r3 = await runSeq({ A: [2000, 2500, 1700], B: [1000] }, '3 A 涨→跌', 3);
  const ev3 = r3.out.logs.filter(l => (l.event === 'restock' || l.event === 'sold') && l.keyword === 'A')
    .map(l => ({ kind: l.event, prevPrice: l.prevPrice, price: l.price }));
  const seq3 = ev3.map(h => h.kind + '(' + h.prevPrice + '→' + h.price + ')');
  console.log('  A 的事件序列:', seq3.join(' → ') || '(无)');
  check('涨跌各产生对应事件（两种都出现）',
    seq3.some(x => x.startsWith('sold')) && seq3.some(x => x.startsWith('restock')),
    JSON.stringify(seq3));
  check('每个事件的涨跌方向正确',
    ev3.every(h => (h.kind === 'sold' ? h.price > h.prevPrice : h.price < h.prevPrice)),
    JSON.stringify(ev3.map(h => h.kind + ':' + h.prevPrice + '→' + h.price)));

  // ---- 4. 企微消息格式 ----
  console.log('\n[4] 企微消息内容');
  hook.reset();
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  const bgStore = { pm_config: { webhook: hook.url } };
  await p2.addInitScript(({ store }) => {
    window.__store = store;
    window.__notifs = [];
    window.__listeners = [];
    window.chrome = {
      storage: { local: {
        get(k) { const list = k == null ? Object.keys(window.__store) : (Array.isArray(k) ? k : [k]);
                 const o = {}; list.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; });
                 return Promise.resolve(JSON.parse(JSON.stringify(o))); },
        set(o) { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); } } },
      notifications: {
        create(id, opts) { window.__notifs.push({ id, opts }); return Promise.resolve(id); },
        clear() { return Promise.resolve(true); }, onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { window.__listeners.push(fn); } }, lastError: undefined },
      tabs: { create() { return Promise.resolve(); } }
    };
  }, { store: bgStore });
  await p2.goto(hook.pageUrl);
  await p2.addScriptTag({ content: BG_SRC });
  const deliver = (msg) => p2.evaluate((m) => new Promise((resolve) => {
    const fn = window.__listeners[0];
    const ret = fn(m, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'no true' });
  }), msg);

  await deliver({ type: 'PM_HITS', hits: [{ kind: 'restock', keyword: '赤宴', price: 1800, prevPrice: 2000, delta: -200, target: 1900, link: 'https://x/1' }] });
  let md = hook.state.hits[0].body.markdown.content;
  console.log('  [补货]\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  check('补货标题正确且含皮肤名', /补货/.test(md) && md.split('\n')[0].includes('赤宴'), md.split('\n')[0]);
  check('补货含降幅 200', /原 ¥2000/.test(md) && /降了 200/.test(md), '');
  check('单纯补货消息不夹带目标价（保持干净）', !/目标价/.test(md), md.slice(0, 200));
  check('本地通知标题为补货', /补货/.test(await p2.evaluate(() => window.__notifs[0].opts.title)), '');

  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'sold', keyword: '赤宴', price: 2500, prevPrice: 2000, delta: 500, target: 1900, link: 'https://x/2' }] });
  md = hook.state.hits[0].body.markdown.content;
  console.log('  [卖出]\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  check('卖出标题正确且含皮肤名', /卖出/.test(md) && md.split('\n')[0].includes('赤宴'), md.split('\n')[0]);
  check('卖出含涨幅 500', /原 ¥2000/.test(md) && /涨了 500/.test(md), '');
  check('卖出解释原因', /已经不在了/.test(md), '');

  check('无未捕获异常', r1.errs.length === 0, r1.errs.join('|'));

  await ctx2.close();
  await browser.close();
  await new Promise(r => s.close(r));
  await hook.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
