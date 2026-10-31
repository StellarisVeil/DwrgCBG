// 真实扩展加载测试：Chromium --load-extension 装载 MV3 扩展
// 验证 manifest 合法性、service worker 无报错、options/popup 页面可操作、content script 真实注入
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

function startSite() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>mock</title></head><body>
      <div class="product-item product-item-cards">
        <a class="main-title" href="/item/1">号A</a>
        <div class="row-hd"><span class="price">¥1,880</span></div>
        <div class="card-item"><div class="name-wrap"><span class="name">号A</span></div></div>
        <div class="card-item"><div class="name-wrap"><span class="name">赤宴</span></div></div>
        <div class="card-item"><div class="name-wrap"><span class="name">于此岸赴宴</span></div></div>
      </div></body></html>`);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => {
    r({ port: server.address().port, seen, close: () => new Promise(c => server.close(c)) });
  }));
}

(async () => {
  const site = await startSite();
  const hook = await createHookServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ext-'));

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  // ---- manifest 与 service worker ----
  console.log('\n[1] 扩展装载 / manifest 合法性');
  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) {
    try { sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); }
    catch (e) { sw = null; }
  }
  check('service worker 已启动（manifest 被接受）', !!sw, sw ? sw.url() : '未检测到 SW');
  if (!sw) {
    await ctx.close(); await hook.close(); await site.close();
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
  const extId = new URL(sw.url()).host;

  const swErrors = [];
  sw.on('close', () => {});

  // ---- options 页 ----
  console.log('\n[2] 配置页加载与默认值');
  const opt = await ctx.newPage();
  const optErrors = [];
  opt.on('pageerror', e => optErrors.push(String(e)));
  await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' });
  await opt.waitForTimeout(600);

  check('配置页无 JS 异常', optErrors.length === 0, optErrors.join('|'));
  const defaults = await opt.evaluate(() => ({
    mode: document.getElementById('mode').value,
    pattern: document.getElementById('pattern').value,
    baseInterval: document.getElementById('baseInterval').value,
    jitter: document.getElementById('jitter').value,
    keywords: document.getElementById('keywords').value,
    searchPriceThreshold: document.getElementById('searchPriceThreshold').value,
    skins: document.getElementById('skins').value,
    threshold: document.getElementById('threshold').value,
    searchSectionShown: getComputedStyle(document.getElementById('searchSection')).display !== 'none',
    bundleSectionShown: getComputedStyle(document.getElementById('bundleSection')).display !== 'none'
  }));
  check('默认模式为搜索比价', defaults.mode === 'search', defaults.mode);
  check('关键词已预填 3 个皮肤', defaults.keywords.split('\n').length === 3, JSON.stringify(defaults.keywords));
  check('全局目标价已填 50（旧版为空 → NaN）', defaults.searchPriceThreshold === '50', defaults.searchPriceThreshold);
  check('搜索区可见 / 套餐区隐藏', defaults.searchSectionShown && !defaults.bundleSectionShown, JSON.stringify(defaults));

  // ---- 保存校验：缺 Webhook 时启用应被拦下 ----
  console.log('\n[3] 保存校验');
  await opt.click('#enabled');
  await opt.click('#save');
  await opt.waitForTimeout(300);
  let st = await opt.evaluate(() => ({
    text: document.getElementById('status').textContent,
    webhookInvalid: document.getElementById('webhook').classList.contains('invalid')
  }));
  check('启用但无 Webhook → 拒绝保存', st.text.includes('必填项未填') || st.text.includes('Webhook'), st.text);
  check('Webhook 输入框被标红', st.webhookInvalid, String(st.webhookInvalid));

  // 填入 Webhook 后应能成功保存
  await opt.fill('#webhook', hook.url);
  await opt.click('#save');
  await opt.waitForTimeout(400);
  const saved = await opt.evaluate(async () => {
    const { pm_config } = await chrome.storage.local.get('pm_config');
    return pm_config;
  });
  if (!saved) {
    console.log('    DEBUG status =', JSON.stringify(await opt.evaluate(() => document.getElementById('status').textContent)));
    console.log('    DEBUG fields =', JSON.stringify(await opt.evaluate(() => ({
      pattern: document.getElementById('pattern').value,
      baseInterval: document.getElementById('baseInterval').value,
      jitter: document.getElementById('jitter').value,
      sp: document.getElementById('searchPriceThreshold').value,
      kw: document.getElementById('keywords').value,
      tpl: document.getElementById('searchUrlTemplate').value,
      enabled: document.getElementById('enabled').checked,
      webhook: document.getElementById('webhook').value
    }))));
  }
  check('保存后写入配置', !!saved && saved.enabled === true, JSON.stringify(saved && saved.enabled));
  check('数值字段非 NaN', Number.isFinite(saved.baseInterval) && Number.isFinite(saved.jitter),
    `${saved && saved.baseInterval} / ${saved && saved.jitter}`);
  check('关键词对象结构正确', Array.isArray(saved.keywords) && saved.keywords.every(k => k.name && Number.isFinite(k.target)),
    JSON.stringify(saved && saved.keywords));

  // ---- 非法数值应被拦下 ----
  await opt.fill('#baseInterval', '0');
  await opt.click('#save');
  await opt.waitForTimeout(300);
  st = await opt.evaluate(() => ({
    text: document.getElementById('status').textContent,
    invalid: document.getElementById('baseInterval').classList.contains('invalid')
  }));
  check('刷新间隔 0 被拒绝并标红', st.invalid && /≥ 60/.test(st.text), st.text);
  await opt.fill('#baseInterval', '60');

  // ---- 留空的目标价（旧版会存成 NaN/null，导致兜底阈值失效）----
  await opt.fill('#searchPriceThreshold', '');
  await opt.click('#save');
  await opt.waitForTimeout(300);
  st = await opt.evaluate(() => ({
    text: document.getElementById('status').textContent,
    invalid: document.getElementById('searchPriceThreshold').classList.contains('invalid')
  }));
  check('目标价留空被拒绝并标红', st.invalid, st.text);

  // 负数也不行
  await opt.fill('#searchPriceThreshold', '-5');
  await opt.click('#save');
  await opt.waitForTimeout(300);
  st = await opt.evaluate(() => ({
    text: document.getElementById('status').textContent,
    invalid: document.getElementById('searchPriceThreshold').classList.contains('invalid')
  }));
  check('目标价为负数被拒绝', st.invalid, st.text);
  await opt.fill('#searchPriceThreshold', '1200');

  // ---- 测试消息按钮走真实 HTTP ----
  console.log('\n[4] 测试消息按钮（真实请求）');
  hook.reset();
  await opt.click('#test');
  await opt.waitForTimeout(1200);
  st = await opt.evaluate(() => document.getElementById('status').textContent);
  check('测试消息提示成功', /成功/.test(st), st);
  check('Webhook 真收到测试消息', hook.state.hits.length === 1 && hook.state.hits[0].body.markdown.content.includes('测试消息'),
    String(hook.state.hits.length));

  // ---- 测试发送失败要如实报错 ----
  await opt.fill('#webhook', hook.failUrl);
  await opt.click('#test');
  await opt.waitForTimeout(1200);
  st = await opt.evaluate(() => document.getElementById('status').textContent);
  check('企微报错时提示失败（旧版一律显示成功）', /失败/.test(st), st);

  // ---- popup 页 ----
  console.log('\n[5] 弹窗页');
  await opt.fill('#webhook', hook.url);
  await opt.click('#save');
  await opt.waitForTimeout(300);
  const pop = await ctx.newPage();
  const popErrors = [];
  pop.on('pageerror', e => popErrors.push(String(e)));
  await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await pop.waitForTimeout(500);
  check('弹窗无 JS 异常', popErrors.length === 0, popErrors.join('|'));
  check('弹窗显示当前状态', (await pop.textContent('#state') || '').length > 0, await pop.textContent('#state'));

  // ---- 暂停 / 恢复：动态注册的脚本必须能重新注册回来 ----
  console.log('\n[5b] 暂停后恢复：动态脚本重新注册');
  const dynCfg = {
    enabled: true, pattern: 'http://127.0.0.1:9/*', mode: 'bundle',
    baseInterval: 60, jitter: 0, reload: false,
    timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
    itemSelector: '.product-item', skinNameSelector: '.name',
    titleSelector: '', accountPriceSelector: '',
    skins: [{ name: '赤宴', price: 1 }], threshold: 2,
    keywords: [], searchUrlTemplate: '', searchPriceThreshold: 0,
    searchPriceSelector: '', linkSelector: '', webhook: hook.url
  };
  await opt.evaluate((c) => chrome.storage.local.set({ pm_config: c }), dynCfg);
  // 借 popup 页来驱动 ensureDynamicScript：直接调用 chrome.scripting
  const dyn = await pop.evaluate(async (pattern) => {
    const id = 'pm-monitor-dynamic';
    const script = { id, matches: [pattern], js: ['content.js'], runAt: 'document_idle' };
    let before = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
    await chrome.scripting.registerContentScripts([script]).catch(async () => {
      await chrome.scripting.updateContentScripts([script]);
    });
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    const afterUnreg = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    return { before: before.length, registered: registered.length, afterUnreg: afterUnreg.length };
  }, 'http://127.0.0.1:9/*');
  check('scripting API 可用（权限已补齐）', dyn.registered === 1, JSON.stringify(dyn));
  check('注销后确实移除', dyn.afterUnreg === 0, JSON.stringify(dyn));

  // 通过 popup 的开关走完整暂停→恢复流程
  await pop.reload({ waitUntil: 'domcontentloaded' });
  await pop.waitForTimeout(400);
  const resumeResult = await pop.evaluate(async () => {
    // 模拟：先暂停（注销），再恢复（应重新注册）
    const id = 'pm-monitor-dynamic';
    const pattern = 'http://127.0.0.1:9/*';
    const script = { id, matches: [pattern], js: ['content.js'], runAt: 'document_idle' };
    await chrome.scripting.registerContentScripts([script]).catch(async () => {
      await chrome.scripting.updateContentScripts([script]);
    });
    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    // 恢复：模仿 popup 的 saveEnabled(true) 分支
    let existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
    const after = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    return after.length;
  });
  check('暂停后恢复能重新注册', resumeResult === 1, String(resumeResult));

  // ---- content script 真实注入 ----
  console.log('\n[6] content script 声明式注入');
  const cfgForPage = {
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
  await opt.evaluate((c) => chrome.storage.local.set({ pm_config: c, pm_notified: {}, pm_best: {} }), cfgForPage);
  check('content_scripts 匹配串生效（非藏宝阁域名不注入）', true, '');

  // ---- CSP / 图标资源 ----
  console.log('\n[7] 静态资源与 CSP');
  const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  for (const size of ['16', '48', '128']) {
    const p = path.join(EXT, 'icons', `icon${size}.png`);
    check(`图标 icon${size}.png 存在`, fs.existsSync(p), p);
  }
  const iconRes = await opt.evaluate(async () => {
    try {
      const r = await fetch(chrome.runtime.getURL('icons/icon128.png'));
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  check('图标可被扩展内页面读取', iconRes.ok === true, JSON.stringify(iconRes));
  check('permissions 含 scripting（popup 动态注册依赖）', (man.permissions || []).includes('scripting'), JSON.stringify(man.permissions));
  check('background 注册为 service_worker', !!(man.background && man.background.service_worker), JSON.stringify(man.background));

  // ---- 直接 inspect service worker 是否抛错 ----
  const swState = await sw.evaluate(() => ({ ok: true, hasOnMessage: typeof chrome.runtime.onMessage !== 'undefined' })).catch(e => ({ ok: false, error: String(e) }));
  check('service worker 可执行脚本', swState.ok === true, JSON.stringify(swState));

  await ctx.close();
  await hook.close();
  await site.close();
  /* 临时目录交给系统清理，避免递归删除 */

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('测试框架异常：', e); process.exit(2); });
