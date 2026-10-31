// 验证：所有企微消息标题都带皮肤名
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const BG_SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const KA_SRC = fs.readFileSync(path.join(EXT, 'keepalive.js'), 'utf8');
const { createHookServer } = require('./hook-server.cjs');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

(async () => {
  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const store = {
    pm_config: { webhook: hook.url, enabled: true },
    pm_best: { 'kw:赤宴': 1800 },
    pm_daily: {}
  };
  await p.addInitScript(({ store }) => {
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
        clear() { return Promise.resolve(true); }, onClicked: { addListener() {} }
      },
      alarms: {
        create(n, i) { window.__alarms.push({ name: n, info: i }); },
        clear() { return Promise.resolve(true); },
        get(n) { return Promise.resolve(window.__alarms.find(a => a.name === n) || null); },
        getAll() { return Promise.resolve(window.__alarms); },
        onAlarm: { addListener(fn) { window.__alarmHandler = fn; } }
      },
      runtime: {
        onMessage: { addListener(fn) { window.__listeners.push(fn); } },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} }, lastError: undefined
      },
      tabs: { query() { return Promise.resolve([]); }, create() { return Promise.resolve(); }, reload() { return Promise.resolve(); } },
      scripting: { executeScript() { return Promise.resolve([{ result: { cards: 0, textLen: 10 } }]); } }
    };
  }, { store });
  await p.goto(hook.pageUrl);
  await p.addScriptTag({ content: BG_SRC });
  await p.addScriptTag({ content: KA_SRC });
  await p.waitForTimeout(600);

  const deliver = (msg) => p.evaluate((m) => new Promise((resolve) => {
    const fn = window.__listeners[0];
    const ret = fn(m, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'no true' });
  }), msg);

  const titleOf = (md) => {
    const line = (md.split('\n').find(l => l.startsWith('###')) || '').replace(/^###\s*/, '');
    return line;
  };

  // ---------- 1. 低于目标价 ----------
  console.log('\n[1] 低于目标价提醒');
  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'search', keyword: '赤宴', price: 1800, threshold: 1900, link: 'https://x/1' }] });
  let md = hook.state.hits[0].body.markdown.content;
  let t = titleOf(md);
  console.log('  标题:', t);
  check('标题含皮肤名「赤宴」', t.includes('赤宴'), t);
  check('标题含"低于目标价"', /低于目标价/.test(t), t);
  const notif1 = await p.evaluate(() => window.__notifs[window.__notifs.length - 1].opts.title);
  console.log('  本地通知标题:', notif1);
  check('本地通知标题含皮肤名', notif1.includes('赤宴'), notif1);

  // ---------- 2. 补货（不推送，但模板仍需带名） ----------
  console.log('\n[2] 补货消息模板');
  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'restock', keyword: '蜃景', price: 900, prevPrice: 1000, delta: -100, target: 800, link: 'https://x/2' }] });
  md = hook.state.hits[0].body.markdown.content;
  t = titleOf(md);
  console.log('  标题:', t);
  check('补货标题含皮肤名', t.includes('蜃景'), t);

  // ---------- 3. 卖出 ----------
  console.log('\n[3] 卖出消息模板');
  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'sold', keyword: '于此岸赴宴', price: 2600, prevPrice: 2000, delta: 600, target: 300, link: 'https://x/3' }] });
  md = hook.state.hits[0].body.markdown.content;
  t = titleOf(md);
  console.log('  标题:', t);
  check('卖出标题含皮肤名', t.includes('于此岸赴宴'), t);

  // ---------- 4. 多皮肤同时命中 ----------
  console.log('\n[4] 多个皮肤同时命中');
  hook.reset();
  await deliver({
    type: 'PM_HITS',
    hits: [
      { kind: 'search', keyword: '赤宴', price: 1100, threshold: 1200, link: 'https://x/a' },
      { kind: 'search', keyword: '蜃景', price: 900, threshold: 1000, link: 'https://x/b' }
    ]
  });
  md = hook.state.hits[0].body.markdown.content;
  console.log('  ---\n' + md.split('\n').map(l => '  ' + l).join('\n') + '\n  ---');
  const heads = md.split('\n').filter(l => l.startsWith('###'));
  check('两个皮肤各有一个标题', heads.length === 2, JSON.stringify(heads));
  check('每个标题都含对应皮肤名',
    heads.some(h => h.includes('赤宴')) && heads.some(h => h.includes('蜃景')), JSON.stringify(heads));
  const notif2 = await p.evaluate(() => window.__notifs[window.__notifs.length - 1].opts.title);
  console.log('  本地通知标题:', notif2);
  check('通知标题含全部皮肤名', notif2.includes('赤宴') && notif2.includes('蜃景'), notif2);

  // ---------- 5. 每日汇总 ----------
  console.log('\n[5] 每日汇总');
  hook.reset();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = y.toLocaleDateString('zh-CN');
  await p.evaluate(async (day) => {
    await chrome.storage.local.set({
      pm_daily: { days: { [day]: [
        { ts: Date.now(), time: day + ' 10:00:00', keyword: '赤宴', kind: 'restock', price: 1800, prevPrice: 2000, delta: -200, target: 1900 },
        { ts: Date.now(), time: day + ' 09:00:00', keyword: '蜃景', kind: 'sold', price: 1100, prevPrice: 1000, delta: 100, target: 1200 }
      ] } }
    });
  }, yesterday);
  await p.evaluate(async () => { await tickDailySummary(); });
  md = hook.state.hits[0].body.markdown.content;
  t = titleOf(md);
  console.log('  标题:', t);
  check('汇总标题含皮肤名', t.includes('赤宴') && t.includes('蜃景'), t);
  check('汇总标题含"昨日"', /昨日/.test(t), t);

  // ---------- 6. 风控告警 ----------
  console.log('\n[6] 风控告警');
  hook.reset();
  await deliver({ type: 'PM_CHALLENGE', reason: '页面要求验证：滑块', url: 'https://x', keyword: '赤宴' });
  md = hook.state.hits[0].body.markdown.content;
  t = titleOf(md);
  console.log('  标题:', t);
  check('风控标题含皮肤名', t.includes('赤宴'), t);
  const notif3 = await p.evaluate(() => window.__notifs[window.__notifs.length - 1].opts.title);
  check('风控本地通知标题也含名', notif3.includes('赤宴'), notif3);

  await ctx.close();
  await browser.close();
  await hook.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
