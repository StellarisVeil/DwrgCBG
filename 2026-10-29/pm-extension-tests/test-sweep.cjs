// 验证「整轮扫描」调度：轮内错开、轮间等待整轮间隔
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const CONTENT_SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

const html = (kw) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
  <div class="product-item product-item-cards">
    <a class="main-title" href="/item/9">${kw}</a>
    <div class="row-hd"><span class="price">¥1,100</span></div>
  </div></body></html>`;

(async () => {
  const navs = [];
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const kw = u.searchParams.get('keyword') || '';
    navs.push({ t: Date.now(), kw });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html(kw));
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${s.address().port}`;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();

  // 压小时间参数以便在测试中观察节奏（真实默认是 20~45 秒 / 30 分钟）
  const cfg = {
    enabled: true, pattern: origin + '/*', mode: 'search',
    baseInterval: 6, jitter: 0,          // 整轮间隔 6 秒（测试用）
    hopMinSec: 2, hopMaxSec: 2,          // 轮内 2 秒（会被 floor 拉到 15s？见下）
    timeWindowEnabled: false, windowStart: 0, windowEnd: 0,
    itemSelector: '.product-item.product-item-cards', linkSelector: '',
    skinNameSelector: '', titleSelector: '', accountPriceSelector: '',
    skins: [], threshold: 0,
    keywords: [{ name: 'A词', target: 5000 }, { name: 'B词', target: 5000 }, { name: 'C词', target: 5000 }],
    searchUrlTemplate: origin + '/pl?keyword={keyword}&order_by=price%20ASC',
    searchPriceThreshold: 50, searchPriceSelector: '.row-hd .price',
    searchPassId: 'p1', runToken: 'r1', webhook: ''
  };

  await p.addInitScript(({ seed, content }) => {
    const KEY = '__pm_store';
    if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(seed));
    const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
    window.__readStore = read;
    window.chrome = {
      storage: {
        local: {
          get(k) {
            const st = read();
            const list = k == null ? Object.keys(st) : (Array.isArray(k) ? k : [k]);
            const o = {}; list.forEach(x => { if (x in st) o[x] = st[x]; });
            return Promise.resolve(JSON.parse(JSON.stringify(o)));
          },
          set(obj) {
            const st = read(); Object.assign(st, JSON.parse(JSON.stringify(obj)));
            localStorage.setItem(KEY, JSON.stringify(st));
            return Promise.resolve();
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: { lastError: undefined, sendMessage(m, cb) { if (cb) cb({ ok: true }); } }
    };
    // content.js 由下面 addInitScript 单独注入
  }, { seed: { pm_config: cfg, pm_notified: {}, pm_best: {}, pm_log: [] } });

  // 每个新文档开始加载时注入 content.js（模拟声明式注入，跨导航有效）
  await p.addInitScript({ content: CONTENT_SRC });

  await p.goto(`${origin}/pl`, { waitUntil: 'domcontentloaded' });

  // 观察 75 秒（3 词 × 15s 下限 + 轮间 6s，足够看到一轮半）
  await p.waitForTimeout(75000);

  const seq = navs.filter(n => n.kw).map(n => ({ kw: n.kw, t: n.t }));
  console.log('\n访问序列:');
  for (let i = 0; i < seq.length; i++) {
    const gap = i ? ((seq[i].t - seq[i - 1].t) / 1000).toFixed(1) + 's' : '-';
    console.log(`  ${seq[i].kw}  间隔 ${gap}`);
  }

  check('完成了首轮三个关键词', ['A词', 'B词', 'C词'].every(k => seq.some(x => x.kw === k)),
    JSON.stringify(seq.map(x => x.kw)));
  check('首轮顺序正确', seq.slice(0, 3).map(x => x.kw).join(',') === 'A词,B词,C词',
    JSON.stringify(seq.slice(0, 3).map(x => x.kw)));

  const gaps = seq.slice(1).map((x, i) => (x.t - seq[i].t) / 1000);
  const innerGaps = gaps.slice(0, 2);
  check('轮内间隔 ≥ 15 秒（下限保护生效，防误设过小）',
    innerGaps.every(g => g >= 14), JSON.stringify(innerGaps.map(g => +g.toFixed(1))));

  // 第 4 次跳转应回到第 1 个关键词（新一轮）
  if (seq.length >= 4) {
    check('扫完后从头开始新一轮', seq[3].kw === 'A词', seq[3].kw);
    const roundGap = (seq[3].t - seq[2].t) / 1000;
    check('轮间等待整轮间隔（≥6s）', roundGap >= 5, roundGap.toFixed(1) + 's');
  } else {
    check('扫完后从头开始新一轮', false, '只观察到 ' + seq.length + ' 次跳转');
  }

  await browser.close();
  await new Promise(r => s.close(r));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
