// 验证合并消息的格式：补货+达标 应合成一条清晰的消息
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const BG_SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
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
  const store = { pm_config: { webhook: hook.url } };
  await p.addInitScript(({ store }) => {
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
  }, { store });
  await p.goto(hook.pageUrl);
  await p.addScriptTag({ content: BG_SRC });
  const deliver = (msg) => p.evaluate((m) => new Promise((resolve) => {
    const fn = window.__listeners[0];
    const ret = fn(m, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'no true' });
  }), msg);

  console.log('\n[1] 补货 + 达标 → 合并为一条');
  hook.reset();
  await deliver({
    type: 'PM_HITS',
    hits: [
      { kind: 'restock', keyword: '赤宴', price: 1800, prevPrice: 2000, delta: -200, target: 1900, link: 'https://x/1' },
      { kind: 'search', keyword: '赤宴', price: 1800, threshold: 1900, link: 'https://x/1', mergedWithEvent: true }
    ]
  });
  check('只发出 1 条企微消息', hook.state.hits.length === 1, String(hook.state.hits.length));
  let md = hook.state.hits[0].body.markdown.content;
  console.log('  ---\n' + md.split('\n').map(l => '  ' + l).join('\n') + '\n  ---');

  check('标题体现补货', /补货/.test(md), '');
  check('含"已达标"提示', /已达到你的目标价/.test(md), '');
  check('只有一处"最新最低价"（未重复）', (md.match(/最新最低价/g) || []).length === 1,
    String((md.match(/最新最低价/g) || []).length));
  check('只出现一次链接', (md.match(/商品链接/g) || []).length === 1,
    String((md.match(/商品链接/g) || []).length));
  check('不含分隔线（不是两条拼接）', !md.includes('---'), '');

  console.log('\n[2] 卖出但未达标 → 一条，且给出差距');
  hook.reset();
  await deliver({
    type: 'PM_HITS',
    hits: [
      { kind: 'sold', keyword: '赤宴', price: 2500, prevPrice: 2000, delta: 500, target: 1900, link: 'https://x/2' },
      { kind: 'search', keyword: '赤宴', price: 2500, threshold: 1900, link: 'https://x/2' }
    ]
  });
  md = hook.state.hits[0].body.markdown.content;
  console.log('  ---\n' + md.split('\n').map(l => '  ' + l).join('\n') + '\n  ---');
  check('标题体现卖出', /卖出/.test(md), '');
  check('显示还差多少', /还差 600 元/.test(md), md);

  console.log('\n[3] 只有补货、没有命中 → 单条正常');
  hook.reset();
  await deliver({
    type: 'PM_HITS',
    hits: [{ kind: 'restock', keyword: '蜃景', price: 900, prevPrice: 1000, delta: -100, target: 800, link: 'https://x/3' }]
  });
  md = hook.state.hits[0].body.markdown.content;
  check('只有补货时正常输出', /补货/.test(md) && !md.includes('还差'), '');

  console.log('\n[4] 多个皮肤同时命中 → 仍用分隔线拼接');
  hook.reset();
  await deliver({
    type: 'PM_HITS',
    hits: [
      { kind: 'search', keyword: 'A', price: 100, threshold: 200, link: 'https://x/a' },
      { kind: 'search', keyword: 'B', price: 300, threshold: 400, link: 'https://x/b' }
    ]
  });
  md = hook.state.hits[0].body.markdown.content;
  check('两个不同命中用分隔线', md.includes('---') && /A/.test(md) && /B/.test(md), '');

  await ctx.close();
  await browser.close();
  await hook.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
