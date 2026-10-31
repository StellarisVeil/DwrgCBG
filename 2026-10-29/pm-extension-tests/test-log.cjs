// 验证查询日志：是否记录时间/关键词/底价/目标/结果，以及导出 CSV
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const { createHookServer } = require('./hook-server.cjs');
const EXT = path.resolve(process.env.PM_EXT);

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

// 每个关键词返回不同底价：赤宴便宜（命中）、蜃景贵（不命中）
const PRICES = { '赤宴': '¥1,150', '蜃景': '¥3,600', '于此岸赴宴': '¥280' };
const listHtml = (kw) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <div class="product-item product-item-cards">
    <a class="main-title" href="/item/9">${kw || '号A'}</a>
    <div class="row-hd"><span class="price">${PRICES[kw] || '¥1,000'}</span></div>
  </div>
</body></html>`;

(async () => {
  const hook = await createHookServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-log-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--no-first-run', '--no-default-browser-check']
  });
  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); } catch (e) {} }
  const extId = new URL(sw.url()).host;

  await ctx.route('https://id5.cbg.163.com/**', async (route) => {
    const u = new URL(route.request().url());
    const kw = u.searchParams.get('keyword') || '';
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: listHtml(kw) });
  });

  const opt = await ctx.newPage();
  const optErrors = [];
  opt.on('pageerror', e => optErrors.push(String(e)));
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForTimeout(400);

  await opt.evaluate(async (hookUrl) => {
    await chrome.storage.local.set({
      pm_config: {
        enabled: true, pattern: 'https://id5.cbg.163.com/*', mode: 'search',
        baseInterval: 60, jitter: 30, reload: true,
        timeWindowEnabled: false, windowStart: 9, windowEnd: 23,
        itemSelector: '.product-item.product-item-cards', linkSelector: '',
        skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
        skins: [], threshold: 0,
        keywords: [
          { name: '赤宴', target: 1200 },
          { name: '蜃景', target: 1000 },
          { name: '于此岸赴宴', target: 300 }
        ],
        searchUrlTemplate: 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC',
        searchPriceThreshold: 50, searchPriceSelector: '.row-hd .price',
        hopMinSec: 15, hopMaxSec: 15,
        searchPassId: 'p1', runToken: 'r1', webhook: hookUrl
      },
      pm_notified: {}, pm_best: {}, pm_log: []
    });
  }, hook.url);

  const page = await ctx.newPage();
  await page.goto('https://id5.cbg.163.com/cgi/mweb/pl?keyword=%E8%B5%A4%E5%AE%B4', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(40000);   // 轮内间隔固定 15s，两跳约 30s

  console.log('\n[1] 日志是否记录了每次查询');
  const logs = await opt.evaluate(async () => (await chrome.storage.local.get('pm_log')).pm_log || []);
  check('日志非空', logs.length > 0, '条数 ' + logs.length);
  const kws = [...new Set(logs.map(l => l.keyword))];
  check('记录了 3 个关键词', kws.length === 3, JSON.stringify(kws));
  check('每条都有时间', logs.every(l => l.time && l.ts), '');
  check('每条都有底价或明确原因', logs.every(l => l.price != null || /读不到|未找到/.test(l.result || '')),
    JSON.stringify(logs.map(l => [l.keyword, l.price, l.result])));

  console.log('\n[2] 底价是否准确');
  const chiYan = logs.find(l => l.keyword === '赤宴');
  const shenJing = logs.find(l => l.keyword === '蜃景');
  const yuCi = logs.find(l => l.keyword === '于此岸赴宴');
  check('赤宴底价 = 1150', chiYan && chiYan.price === 1150, chiYan && String(chiYan.price));
  check('蜃景底价 = 3600', shenJing && shenJing.price === 3600, shenJing && String(shenJing.price));
  check('于此岸赴宴底价 = 280', yuCi && yuCi.price === 280, yuCi && String(yuCi.price));

  console.log('\n[3] 命中判定是否正确');
  check('赤宴 1150 ≤ 1200 → 命中', chiYan && chiYan.hit === true, chiYan && String(chiYan.hit));
  check('蜃景 3600 > 1000 → 未命中', shenJing && shenJing.hit === false, shenJing && String(shenJing.hit));
  check('于此岸赴宴 280 ≤ 300 → 命中', yuCi && yuCi.hit === true, yuCi && String(yuCi.hit));
  check('命中项标出已提醒', chiYan && /已提醒/.test(chiYan.result || ''), chiYan && chiYan.result);
  check('未命中项写明未达目标价', shenJing && /未达目标价/.test(shenJing.result || ''), shenJing && shenJing.result);
  check('每条都带页面链接便于核对', logs.every(l => !!l.url), '');
  check('命中项带商品链接', chiYan && !!chiYan.link, chiYan && String(chiYan.link));

  console.log('\n[4] 配置页的日志表格');
  await opt.reload({ waitUntil: 'domcontentloaded' });
  await opt.waitForTimeout(800);
  const summary = await opt.textContent('#logSummary');
  check('有汇总文案', /共 \d+ 条记录/.test(summary || ''), summary);
  const rowCount = await opt.evaluate(() => document.querySelectorAll('#logTable tbody tr').length);
  check('表格渲染了记录行', rowCount >= 3, '行数 ' + rowCount);
  const firstRow = await opt.evaluate(() => {
    const tds = document.querySelectorAll('#logTable tbody tr:first-child td');
    return Array.from(tds).map(td => td.textContent);
  });
  check('表格列齐全（时间/模式/关键词/底价/目标/结果/商品）', firstRow.length === 7, JSON.stringify(firstRow));
  check('最后一列是可点的商品链接', firstRow[6] === '打开商品' || firstRow[6] === '打开列表', firstRow[6]);
  check('表格显示 ¥ 金额', firstRow.some(t => t.startsWith('¥')), JSON.stringify(firstRow));

  console.log('\n[5] 只看命中筛选');
  await opt.check('#logOnlyHit');
  await opt.waitForTimeout(300);
  const hitRows = await opt.evaluate(() => document.querySelectorAll('#logTable tbody tr').length);
  const hitSummary = await opt.textContent('#logSummary');
  check('筛选后行数减少', hitRows < rowCount, `${hitRows} < ${rowCount}`);
  check('筛选后只含命中', /只显示命中/.test(hitSummary || ''), hitSummary);

  console.log('\n[6] 导出 CSV');
  const dl = opt.waitForEvent('download', { timeout: 15000 });
  await opt.uncheck('#logOnlyHit');
  await opt.click('#logExport');
  const download = await dl;
  const csvPath = path.join(dir, 'export.csv');
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  check('文件名含 price-monitor-log', /price-monitor-log-\d{8}-\d{4}\.csv/.test(download.suggestedFilename()),
    download.suggestedFilename());
  check('CSV 有 BOM（Excel 不乱码）', csv.charCodeAt(0) === 0xFEFF, '0x' + csv.charCodeAt(0).toString(16));
  check('CSV 表头包含底价/目标价', csv.includes('底价') && csv.includes('目标价'), csv.slice(0, 120));
  check('CSV 含具体底价 1150', csv.includes('1150'), '');
  check('CSV 行数 = 记录数+表头', csv.trim().split(/\r?\n/).length === logs.length + 1,
    `${csv.trim().split(/\r?\n/).length} vs ${logs.length + 1}`);
  console.log('    CSV 前两行:');
  csv.split(/\r?\n/).slice(0, 2).forEach(l => console.log('      ' + l));

  console.log('\n[7] 无异常');
  check('配置页无 JS 异常', optErrors.length === 0, optErrors.join('|'));

  await ctx.close();
  await hook.close();

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
