// 验证：链接清洗（去 refer_sn、保留 equip 详情页）+ 表格可点击
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const BG_SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const { createHookServer } = require('./hook-server.cjs');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

const EQUIP = 'https://id5.cbg.163.com/cgi/mweb/equip/1/202610261903416-1-J7XEAGX9OZKOYF';
const SEARCH_WITH_SN = 'https://id5.cbg.163.com/cgi/mweb/pl?keyword=%E8%B5%A4%E5%AE%B4&order_by=price%20ASC&refer_sn=01A18CEB-A03E-CB1E-3B63-B2B2E0E6E688';

(async () => {
  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });

  // ---------- 1. 后台消息里的链接 ----------
  console.log('\n[1] 企微消息里的链接');
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const store = { pm_config: { webhook: hook.url } };
  await p.addInitScript(({ store }) => {
    window.__store = store; window.__notifs = []; window.__listeners = [];
    window.chrome = {
      storage: { local: {
        get(k) { const list = k == null ? Object.keys(window.__store) : (Array.isArray(k) ? k : [k]);
                 const o = {}; list.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; });
                 return Promise.resolve(JSON.parse(JSON.stringify(o))); },
        set(o) { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); } } },
      notifications: { create(id, opts) { window.__notifs.push({ id, opts }); return Promise.resolve(id); },
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

  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'search', keyword: '赤宴', price: 1150, threshold: 1200, link: EQUIP, url: SEARCH_WITH_SN }] });
  let md = hook.state.hits[0].body.markdown.content;
  console.log('  ---\n' + md.split('\n').map(l => '  ' + l).join('\n') + '\n  ---');
  check('含商品详情链接', md.includes(EQUIP), '');
  check('不含 refer_sn 会话参数', !md.includes('refer_sn'), '');
  check('同时给出明文地址（点不到也能复制）', (md.match(new RegExp(EQUIP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2,
    '出现 ' + (md.match(/equip/g) || []).length + ' 次');
  check('markdown 链接格式正确', md.includes('](' + EQUIP + ')'), '');

  // 只有搜索页链接（带 refer_sn）时应被剥净
  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'search', keyword: '蜃景', price: 900, threshold: 1000, link: null, url: SEARCH_WITH_SN }] });
  md = hook.state.hits[0].body.markdown.content;
  check('仅有搜索页时也剥掉 refer_sn', !md.includes('refer_sn'), md.slice(0, 200));
  check('搜索页保留 keyword 参数', md.includes('keyword='), '');

  // 补货/卖出消息同样处理
  hook.reset();
  await deliver({ type: 'PM_HITS', hits: [{ kind: 'restock', keyword: '赤宴', price: 1800, prevPrice: 2000, delta: -200, target: 1900, link: EQUIP }] });
  md = hook.state.hits[0].body.markdown.content;
  check('补货消息含可点详情链接', md.includes('](' + EQUIP + ')'), '');
  check('补货消息含明文地址', (md.match(new RegExp(EQUIP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2, '');

  await ctx.close();

  // ---------- 2. 表格里的商品列可点击 ----------
  console.log('\n[2] 查询记录表格的可点击链接');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-link-'));
  const c2 = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-first-run', '--no-default-browser-check']
  });
  let sw = c2.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await c2.waitForEvent('serviceworker', { timeout: 10000 }); } catch (e) {} }
  const extId = new URL(sw.url()).host;

  const o = await c2.newPage();
  const errs = [];
  o.on('pageerror', e => errs.push(String(e)));
  await o.goto(`chrome-extension://${extId}/options.html`);
  await o.waitForTimeout(500);

  await o.evaluate(async ({ equip, sn }) => {
    await chrome.storage.local.set({
      pm_log: [
        { ts: Date.now(), time: 'T1', kind: 'search', keyword: '赤宴', price: 1150, target: 1200, hit: true, result: '命中已提醒', link: equip, url: sn },
        { ts: Date.now() - 1000, time: 'T2', kind: 'search', keyword: '蜃景', price: 900, target: 1000, hit: false, result: '未达目标价', link: null, url: sn },
        { ts: Date.now() - 2000, time: 'T3', kind: 'restock', keyword: '赤宴', price: 1800, prevPrice: 2000, delta: -200, target: 1900, event: 'restock', hit: true, link: equip, url: sn }
      ]
    });
  }, { equip: EQUIP, sn: SEARCH_WITH_SN });

  await o.reload({ waitUntil: 'domcontentloaded' });
  await o.waitForTimeout(700);

  const cells = await o.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#logTable tbody tr'));
    return rows.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const a = tds[tds.length - 1] && tds[tds.length - 1].querySelector('a');
      return {
        cellCount: tds.length,
        lastText: tds.length ? (tds[tds.length - 1].textContent || '').trim() : '',
        href: a ? a.href : null,
        text: a ? a.textContent : null,
        target: a ? a.getAttribute('target') : null
      };
    });
  });
  console.log('  行数据:', JSON.stringify(cells, null, 1));

  check('表头新增「商品」列', (await o.textContent('#logTable thead')) .includes('商品'), '');
  check('每行 7 列', cells.every(c => c.cellCount === 7), JSON.stringify(cells.map(c => c.cellCount)));
  check('有商品链接的行可点击', cells[0] && cells[0].href === EQUIP, cells[0] && cells[0].href);
  check('链接在新标签打开', cells[0] && cells[0].target === '_blank', cells[0] && cells[0].target);
  check('无商品链接的行退回列表链接', cells[1] && cells[1].href && cells[1].href.includes('/pl?'), cells[1] && cells[1].href);
  check('列表链接已去掉 refer_sn', cells[1] && !cells[1].href.includes('refer_sn'), cells[1] && cells[1].href);
  check('补货行也能点开商品', cells[2] && cells[2].href === EQUIP, cells[2] && cells[2].href);
  check('配置页无 JS 异常', errs.length === 0, errs.join('|'));

  await c2.close();
  await browser.close();
  await hook.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
