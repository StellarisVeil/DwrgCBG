// 验证：补货/卖出不推送（只记录）；仅低于目标价才推送；0:00 生成汇总
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const CONTENT_SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const KA_SRC = fs.readFileSync(path.join(EXT, 'keepalive.js'), 'utf8');
const { createHookServer } = require('./hook-server.cjs');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

let pricePlan = {};
let idx = {};
const page = (p) => `<html><body><div class="product-item product-item-cards">
  <a class="main-title" href="/cgi/mweb/equip/1/202610261903416-1-J7XEAGX9OZKOYF">x</a>
  <div class="row-hd"><span class="price">¥${p}</span></div></div></body></html>`;

(async () => {
  const hits = [];
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    const kw = u.searchParams.get('keyword') || '';
    hits.push({ t: Date.now(), kw });
    const plan = pricePlan[kw] || [1000];
    const i = idx[kw] || 0; idx[kw] = i + 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(plan[Math.min(i, plan.length - 1)]));
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${s.address().port}`;

  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });

  // ================= 1. 补货/卖出不推送 =================
  console.log('\n[1] 补货 / 卖出：只记录，不发消息');
  // A: 2000 → 1800（补货，但目标价 100 远未达到）
  // B: 2000 → 2600（卖出）
  pricePlan = { A: [2000, 1800], B: [2000, 2600] };
  idx = {};

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));

  const cfg = {
    enabled: true, pattern: origin + '/*', mode: 'search',
    baseInterval: 60, jitter: 0, hopMinSec: 15, hopMaxSec: 15,
    timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
    itemSelector: '.product-item.product-item-cards', linkSelector: '',
    skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
    skins: [], threshold: 0,
    keywords: [{ name: 'A', target: 100 }, { name: 'B', target: 100 }],  // 目标价很低，不会命中
    searchUrlTemplate: origin + '/pl?keyword={keyword}&order_by=price%20ASC',
    searchPriceThreshold: 100, searchPriceSelector: '.row-hd .price',
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
      runtime: { lastError: undefined, sendMessage(m, cb) { window.__sent.push(m); localStorage.setItem('__sent', JSON.stringify(window.__sent)); if (cb) cb({ ok: true }); } }
    };
  }, { seed: { pm_config: cfg, pm_notified: {}, pm_best: {}, pm_log: [], pm_track: {}, pm_daily: {} } });
  await p.addInitScript({ content: CONTENT_SRC });

  await p.goto(`${origin}/pl?keyword=${encodeURIComponent('A')}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(130000);

  const out1 = await p.evaluate(() => ({
    sent: JSON.parse(localStorage.getItem('__sent') || '[]'),
    logs: (window.__readStore().pm_log) || [],
    daily: window.__readStore().pm_daily || {}
  }));

  const evtLogs = out1.logs.filter(l => l.event === 'restock' || l.event === 'sold');
  console.log('  检测到的事件:', evtLogs.map(l => l.event + '(' + l.keyword + ')').join(', ') || '(无)');
  console.log('  发出的消息:', out1.sent.map(m => m.type + '[' + (m.hits || []).map(h => h.kind).join(',') + ']').join(', ') || '(无)');

  check('检测到补货或卖出事件', evtLogs.length > 0, JSON.stringify(evtLogs.map(l => l.event)));
  const pushForEvent = out1.sent.filter(m => (m.hits || []).some(h => h.kind === 'restock' || h.kind === 'sold'));
  check('补货/卖出没有触发任何推送', pushForEvent.length === 0, JSON.stringify(pushForEvent.map(m => m.hits)));

  const days = Object.keys(out1.daily.days || {});
  const today = new Date().toLocaleDateString('zh-CN');
  check('事件已写入今日流水', days.includes(today), JSON.stringify(days));
  const todayEvts = (out1.daily.days && out1.daily.days[today]) || [];
  console.log('  今日流水:', todayEvts.map(e => e.kind + '(' + e.keyword + ' ' + e.prevPrice + '→' + e.price + ')').join(', '));
  check('流水含事件明细', todayEvts.length > 0, '条数 ' + todayEvts.length);
  check('流水记录了涨跌方向', todayEvts.every(e => (e.kind === 'restock' ? e.price < e.prevPrice : e.price > e.prevPrice)), '');

  await ctx.close();

  // ================= 2. 低于目标价才推送 =================
  console.log('\n[2] 低于目标价：正常推送');
  pricePlan = { C: [5000, 900] };   // 目标 1000：900 命中
  idx = {};
  hook.reset();

  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  const cfg2 = { ...cfg, keywords: [{ name: 'C', target: 1000 }], searchPriceThreshold: 1000 };
  await p2.addInitScript(({ seed }) => {
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
      runtime: { lastError: undefined, sendMessage(m, cb) { window.__sent.push(m); localStorage.setItem('__sent', JSON.stringify(window.__sent)); if (cb) cb({ ok: true }); } }
    };
  }, { seed: { pm_config: cfg2, pm_notified: {}, pm_best: {}, pm_log: [], pm_track: {}, pm_daily: {} } });
  await p2.addInitScript({ content: CONTENT_SRC });
  await p2.goto(`${origin}/pl?keyword=${encodeURIComponent('C')}`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(130000);

  const out2 = await p2.evaluate(() => ({
    sent: JSON.parse(localStorage.getItem('__sent') || '[]'),
    logs: (window.__readStore().pm_log) || []
  }));
  const searchPush = out2.sent.filter(m => (m.hits || []).some(h => h.kind === 'search'));
  console.log('  推送消息:', searchPush.map(m => JSON.stringify(m.hits.map(h => ({ k: h.kind, p: h.price })))).join(', ') || '(无)');
  console.log('  日志:', out2.logs.map(l => '¥' + l.price + ' ' + l.result).join(' | '));
  check('低于目标价时推送了消息', searchPush.length > 0, String(searchPush.length));
  check('推送内容是 search 类型（不是补货/卖出）',
    searchPush.every(m => m.hits.every(h => h.kind === 'search')), '');
  check('推送价格 900', searchPush.some(m => m.hits.some(h => h.price === 900)), '');

  await ctx2.close();

  // ================= 3. 0:00 汇总 =================
  console.log('\n[3] 每日 0:00 汇总');
  hook.reset();
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  const bgStore = {
    pm_config: { webhook: hook.url, enabled: true },
    pm_best: { 'kw:赤宴': 1800 },
    pm_track: {},
    pm_daily: {}
  };
  await p3.addInitScript(({ store }) => {
    window.__store = store;
    window.__notifs = []; window.__listeners = []; window.__alarms = [];
    window.chrome = {
      storage: {
        local: {
          get(k) {
            const list = k == null ? Object.keys(window.__store) : (Array.isArray(k) ? k : [k]);
            const o = {}; list.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; });
            return Promise.resolve(JSON.parse(JSON.stringify(o)));
          },
          set(o) { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
          remove(k) { (Array.isArray(k) ? k : [k]).forEach(x => delete window.__store[x]); return Promise.resolve(); }
        }
      },
      notifications: {
        create(id, opts) { window.__notifs.push({ id, opts }); return Promise.resolve(id); },
        clear() { return Promise.resolve(true); },
        onClicked: { addListener() {} }
      },
      alarms: {
        create(name, info) { window.__alarms.push({ name, info }); },
        clear(n) { return Promise.resolve(true); },
        get(n) { return Promise.resolve(window.__alarms.find(a => a.name === n) || null); },
        getAll() { return Promise.resolve(window.__alarms); },
        onAlarm: { addListener(fn) { window.__alarmHandler = fn; } }
      },
      runtime: {
        onMessage: { addListener(fn) { window.__listeners.push(fn); } },
        onStartup: { addListener(fn) { window.__startup = fn; } },
        onInstalled: { addListener(fn) { window.__installed = fn; } },
        lastError: undefined
      },
      tabs: { query() { return Promise.resolve([]); }, create() { return Promise.resolve(); }, reload() { return Promise.resolve(); } },
      scripting: { executeScript() { return Promise.resolve([{ result: { cards: 0, textLen: 10 } }]); } },
      fetch: (...a) => fetch(...a)
    };
  }, { store: bgStore });

  await p3.goto(hook.pageUrl);

  // 造昨天的数据
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = y.toLocaleDateString('zh-CN');
  await p3.evaluate(async (day) => {
    await chrome.storage.local.set({
      pm_daily: {
        days: {
          [day]: [
            { ts: Date.now() - 3600e3, time: day + ' 10:00:00', keyword: '赤宴', kind: 'restock', price: 1800, prevPrice: 2000, delta: -200, target: 1900 },
            { ts: Date.now() - 7200e3, time: day + ' 09:00:00', keyword: '赤宴', kind: 'restock', price: 1700, prevPrice: 1800, delta: -100, target: 1900 },
            { ts: Date.now() - 10800e3, time: day + ' 08:00:00', keyword: '赤宴', kind: 'sold', price: 2600, prevPrice: 1700, delta: 900, target: 1900 },
            { ts: Date.now() - 14400e3, time: day + ' 07:00:00', keyword: '蜃景', kind: 'sold', price: 1100, prevPrice: 1000, delta: 100, target: 1200 }
          ]
        }
      }
    });
  }, yesterday);

  await p3.addScriptTag({ content: BG_SRC });
  await p3.addScriptTag({ content: KA_SRC });
  await p3.waitForTimeout(500);

  const alarms = await p3.evaluate(() => window.__alarms.map(a => a.name));
  console.log('  注册的定时器:', JSON.stringify(alarms));
  check('注册了每日汇总定时器', alarms.includes('pm-daily-summary'), JSON.stringify(alarms));
  check('保留原有保活定时器', alarms.includes('pm-keepalive'), JSON.stringify(alarms));

  // 手动触发汇总
  hook.reset();
  const r = await p3.evaluate(async () => {
    const out = await tickDailySummary();
    return { day: out.day, restocks: out.restocks, solds: out.solds };
  });
  console.log('  汇总结果:', JSON.stringify(r));
  check('汇总统计补货 2 次', r.restocks === 2, String(r.restocks));
  check('汇总统计卖出 2 次', r.solds === 2, String(r.solds));

  check('企微收到汇总消息', hook.state.hits.length === 1, String(hook.state.hits.length));
  const md = hook.state.hits[0].body.markdown.content;
  console.log('  --- 汇总消息 ---\n' + md.split('\n').map(l => '  ' + l).join('\n') + '\n  ---');
  check('标题为昨日汇总且含皮肤名', /昨日补货\/卖出/.test(md) && /赤宴/.test(md.split('\n')[0]), md.split('\n')[0]);
  check('含合计次数', /补货 2 次/.test(md) && /卖出 2 次/.test(md), '');
  check('按皮肤分组（赤宴）', /赤宴/.test(md), '');
  check('显示当前最低价', /当前最低 ¥1800/.test(md), '');
  check('显示补货最低价', /最低到 ¥1700/.test(md), '');
  check('显示卖出最高价', /最高到 ¥2600/.test(md), '');

  await ctx3.close();
  await browser.close();
  await new Promise(r2 => s.close(r2));
  await hook.close();

  check('无未捕获异常', errs.length === 0, errs.join('|'));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
