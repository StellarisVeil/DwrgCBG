// 验证「每轮都等待随机间隔」开关的保存/载入闭环
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-opt-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-first-run', '--no-default-browser-check']
  });
  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); } catch (e) {} }
  const extId = new URL(sw.url()).host;

  const o = await ctx.newPage();
  const errs = [];
  o.on('pageerror', e => errs.push(String(e)));
  await o.goto(`chrome-extension://${extId}/options.html`);
  await o.waitForTimeout(500);

  console.log('复选框存在:', !!(await o.$('#searchWaitFirst')));
  console.log('默认未勾选:', !(await o.isChecked('#searchWaitFirst')));
  console.log('配置页无 JS 异常:', errs.length === 0, errs.join('|'));

  await o.fill('#webhook', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test');
  await o.check('#enabled');
  await o.check('#searchWaitFirst');
  await o.click('#save');
  await o.waitForTimeout(500);

  const cfg1 = await o.evaluate(async () => (await chrome.storage.local.get('pm_config')).pm_config);
  console.log('保存后 searchWaitFirst =', cfg1 && cfg1.searchWaitFirst);
  console.log('保存后 searchPassId =', cfg1 && cfg1.searchPassId);

  await o.reload({ waitUntil: 'domcontentloaded' });
  await o.waitForTimeout(500);
  console.log('重新载入后回填勾选:', await o.isChecked('#searchWaitFirst'));

  await o.uncheck('#searchWaitFirst');
  await o.click('#save');
  await o.waitForTimeout(400);
  const cfg2 = await o.evaluate(async () => (await chrome.storage.local.get('pm_config')).pm_config);
  console.log('取消后 searchWaitFirst =', cfg2 && cfg2.searchWaitFirst);

  // 关键词不变时 passId 应复用，改了关键词应换新
  const idBefore = cfg2.searchPassId;
  await o.click('#save');
  await o.waitForTimeout(400);
  const cfg3 = await o.evaluate(async () => (await chrome.storage.local.get('pm_config')).pm_config);
  console.log('配置未变时 passId 复用:', cfg3.searchPassId === idBefore);

  await o.fill('#keywords', '赤宴,1200\n新皮肤,500');
  await o.click('#save');
  await o.waitForTimeout(400);
  const cfg4 = await o.evaluate(async () => (await chrome.storage.local.get('pm_config')).pm_config);
  console.log('关键词变化后 passId 刷新:', cfg4.searchPassId !== idBefore);
  console.log('退出前异常:', errs.length === 0, errs.join('|'));

  await ctx.close();
})().catch(e => { console.error('异常:', e); process.exit(2); });
