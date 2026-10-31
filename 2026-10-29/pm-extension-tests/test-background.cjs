// background.js 端到端：把 service worker 逻辑放进真实页面，用真实 HTTP 验证企微推送链路
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHookServer } = require('./hook-server.cjs');

const EXT = path.join(__dirname, '..', 'price-monitor-extension');
const BG_SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

// 在页面里提供 chrome.* 桩（storage + notifications + runtime.onMessage）
function stubFactory() {
  return ({ store }) => {
    window.__store = store;
    window.__notifs = [];
    window.__listeners = [];
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
          set(obj) { Object.assign(window.__store, JSON.parse(JSON.stringify(obj))); return Promise.resolve(); }
        }
      },
      notifications: {
        create(id, opts) { window.__notifs.push({ id, opts }); return Promise.resolve(id); },
        clear() { return Promise.resolve(true); },
        onClicked: { addListener() {} }
      },
      runtime: {
        onMessage: { addListener(fn) { window.__listeners.push(fn); } },
        lastError: undefined
      },
      tabs: { create() { return Promise.resolve(); } }
    };
  };
}

(async () => {
  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const store = { pm_config: { webhook: hook.url } };
  await page.addInitScript(stubFactory(), { store });
  await page.goto(hook.pageUrl);
  await page.addScriptTag({ content: BG_SRC });

  // 调用 service worker 的 handleHits / sendTest
  const deliver = (msg) => page.evaluate((m) => new Promise((resolve) => {
    const fn = window.__listeners[0];
    const ret = fn(m, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'listener 未返回 true（异步响应会失效）' });
  }), msg);

  console.log('\n[1] 搜索命中推送企微');
  const r1 = await deliver({
    type: 'PM_HITS',
    hits: [{
      kind: 'search', keyword: '赤宴', price: 1150, threshold: 1200,
      url: 'https://id5.cbg.163.com/x', link: 'https://id5.cbg.163.com/item/11'
    }]
  });
  check('返回 ok', r1 && r1.ok === true, JSON.stringify(r1));
  check('Webhook 收到 1 条', hook.state.hits.length === 1, String(hook.state.hits.length));
  const body1 = hook.state.hits[0] && hook.state.hits[0].body;
  check('msgtype = markdown', body1 && body1.msgtype === 'markdown', JSON.stringify(body1 && body1.msgtype));
  const md1 = (body1 && body1.markdown && body1.markdown.content) || '';
  check('含关键词', md1.includes('赤宴'), md1.slice(0, 80));
  check('含最低价', md1.includes('1150'), md1.slice(0, 120));
  check('含可点击链接', md1.includes('https://id5.cbg.163.com/item/11'), md1.slice(0, 240));
  check('本地通知已弹出', await page.evaluate(() => window.__notifs.length) === 1);
  // 回归：点击通知要能跳转，依赖 pm_last_url 被写入（此前只读不写）
  const lastUrl = await page.evaluate(() => window.__store.pm_last_url);
  check('pm_last_url 已写入（点击通知可跳转）', lastUrl === 'https://id5.cbg.163.com/item/11', String(lastUrl));

  console.log('\n[2] 皮肤套餐命中推送（多条合并为一条消息）');
  hook.reset();
  const r2 = await deliver({
    type: 'PM_HITS',
    hits: [
      { kind: 'bundle', title: '号A', acctPrice: 1880, sum: 1500, matched: [{ name: '赤宴', price: 1200 }, { name: '于此岸赴宴', price: 300 }], url: 'u', link: 'https://id5.cbg.163.com/item/1' },
      { kind: 'bundle', title: '号B', acctPrice: 900, sum: 1300, matched: [{ name: '蜃景', price: 1000 }, { name: '于此岸赴宴', price: 300 }], url: 'u', link: 'https://id5.cbg.163.com/item/2' }
    ]
  });
  check('返回 ok', r2 && r2.ok === true, JSON.stringify(r2));
  check('两条命中合并成 1 次请求', hook.state.hits.length === 1, String(hook.state.hits.length));
  const md2 = hook.state.hits[0].body.markdown.content;
  check('包含两个账号', md2.includes('号A') && md2.includes('号B'), md2.slice(0, 120));
  check('包含命中皮肤明细', md2.includes('赤宴') && md2.includes('于此岸赴宴'), '');

  console.log('\n[3] 企微返回业务错误（HTTP 200 + errcode≠0）必须被发现');
  store.pm_config.webhook = hook.failUrl;
  await page.evaluate((u) => { window.__store.pm_config.webhook = u; }, hook.failUrl);
  const r3 = await deliver({ type: 'PM_HITS', hits: [{ kind: 'search', keyword: 'k', price: 1, threshold: 2, url: 'u', link: 'l' }] });
  check('返回 ok:false', r3 && r3.ok === false, JSON.stringify(r3));
  check('错误信息含 errcode', /93000|invalid webhook url/.test((r3 && r3.error) || ''), r3 && r3.error);

  console.log('\n[4] 未配置 Webhook：只弹本地通知，不算失败');
  await page.evaluate(() => { window.__store.pm_config.webhook = ''; });
  const r4 = await deliver({ type: 'PM_HITS', hits: [{ kind: 'search', keyword: 'k', price: 1, threshold: 2, url: 'u', link: 'l' }] });
  check('返回 ok（不误判失败）', r4 && r4.ok === true, JSON.stringify(r4));

  console.log('\n[5] 测试消息');
  await page.evaluate((u) => { window.__store.pm_config.webhook = u; }, hook.url);
  hook.reset();
  const r5 = await deliver({ type: 'PM_TEST' });
  check('测试消息发送成功', r5 && r5.ok === true, JSON.stringify(r5));
  check('收到测试消息', hook.state.hits.length === 1 && hook.state.hits[0].body.markdown.content.includes('测试消息'), '');

  console.log('\n[6] 超长消息按字节切分，不超企微 4096 限制');
  hook.reset();
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: 'bundle', title: '账号' + i, acctPrice: 1000 + i, sum: 500 + i,
    matched: [{ name: '皮肤名称比较长的一个测试' + i, price: 300 }], url: 'u', link: 'https://id5.cbg.163.com/item/' + i
  }));
  const r6 = await deliver({ type: 'PM_HITS', hits: many });
  check('发送成功', r6 && r6.ok === true, JSON.stringify(r6));
  check('被拆成多条', hook.state.hits.length > 1, String(hook.state.hits.length));
  const enc = new TextEncoder();
  const over = hook.state.hits.filter(h => enc.encode(h.body.markdown.content).length > 4096);
  check('每条都不超 4096 字节', over.length === 0, over.length + ' 条超限');

  check('全程无未捕获异常', errors.length === 0, errors.join('|'));

  await browser.close();
  await hook.close();

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('测试框架异常：', e); process.exit(2); });
