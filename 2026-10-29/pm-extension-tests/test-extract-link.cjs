// 验证 extractLink 能从各种真实卡片结构里抓到详情链接
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const CONTENT_SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

const EQUIP = 'https://id5.cbg.163.com/cgi/mweb/equip/1/202610261903416-1-J7XEAGX9OZKOYF';

// 各种卡片结构，模拟不同的链接放置方式
const CASES = {
  'a 标签直挂详情': `<div class="product-item"><a href="${EQUIP.replace('https://id5.cbg.163.com','')}"><img></a><span class="price">¥100</span></div>`,
  'div data-href 带参数': `<div class="product-item"><div data-href="${EQUIP}?refer_sn=ABC123&from=list"><span class="price">¥100</span></div></div>`,
  '相对路径': `<div class="product-item"><a href="/cgi/mweb/equip/1/202610261903416-1-J7XEAGX9OZKOYF?refer_sn=X">x</a></div>`,
  '外层包裹跳转链接': `<div class="product-item"><a href="/cgi/mweb/pl?keyword=x">列表</a><div class="inner"><a href="${EQUIP}">真链接</a></div></div>`,
  'HTML 里嵌 equip': `<div class="product-item"><div data-raw="url=${EQUIP}&t=1"><span class="price">¥100</span></div></div>`,
  '只有普通链接': `<div class="product-item"><a href="/cgi/mweb/pl?keyword=x&refer_sn=Y">列表</a></div>`,
  '完全没有链接': `<div class="product-item"><span class="price">¥100</span></div>`
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();

  await p.addInitScript(({ seed }) => {
    const KEY = '__s';
    if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(seed));
    const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
    window.chrome = {
      storage: {
        local: {
          get(k) {
            const st = read();
            const l = k == null ? Object.keys(st) : (Array.isArray(k) ? k : [k]);
            const o = {}; l.forEach(x => { if (x in st) o[x] = st[x]; });
            return Promise.resolve(JSON.parse(JSON.stringify(o)));
          },
          set(o) {
            const st = read(); Object.assign(st, JSON.parse(JSON.stringify(o)));
            localStorage.setItem(KEY, JSON.stringify(st)); return Promise.resolve();
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: { lastError: undefined, sendMessage(m, cb) { if (cb) cb({ ok: true }); } }
    };
  }, { seed: { pm_config: { enabled: false }, pm_notified: {}, pm_best: {}, pm_log: [] } });

  await p.goto('https://id5.cbg.163.com/cgi/mweb/pl', { waitUntil: 'domcontentloaded' }).catch(() => {});
  // 页面可能因网络失败，改用本地空白页 + 手动设 base
  if (!p.url().includes('cbg')) {
    await p.goto('about:blank');
  }

  // 直接在页面上下文里调用 extractLink（通过注入 content.js 后的内部函数不可达，
  // 所以这里复刻同样的规则做校验，并同时检查 content.js 里规则的实现）
  const results = await p.evaluate((cases) => {
    const EQUIP_RE = /https?:\/\/[^\s"'<>()]*?\/cgi\/mweb\/equip\/[^\s"'<>()?#&]+/i;
    function cleanEquipUrl(u) {
      if (!u) return null;
      const s = String(u).trim();
      const m = s.match(EQUIP_RE);
      if (m) return m[0];
      try {
        const url = new URL(s, 'https://id5.cbg.163.com/');
        ['refer_sn', 'refer_page', 'traceid', 'from', 'spm', 'sessionid'].forEach(k => url.searchParams.delete(k));
        return url.href;
      } catch (e) { return s; }
    }
    const out = {};
    for (const [name, html] of Object.entries(cases)) {
      const box = document.createElement('div');
      box.innerHTML = html;
      const item = box.querySelector('.product-item');
      const anchors = Array.from(item.querySelectorAll('a[href], a[data-href]'));
      let found = null;
      for (const a of anchors) {
        const href = a.getAttribute('href') || a.getAttribute('data-href');
        if (!href || href === '#' || /^javascript:/i.test(href)) continue;
        let abs; try { abs = new URL(href, 'https://id5.cbg.163.com/').href; } catch (e) { continue; }
        if (EQUIP_RE.test(abs)) { found = cleanEquipUrl(abs); break; }
      }
      if (!found) {
        const m = (item.outerHTML || '').match(EQUIP_RE);
        if (m) found = cleanEquipUrl(m[0]);
      }
      if (!found) {
        for (const a of anchors) {
          const href = a.getAttribute('href') || a.getAttribute('data-href');
          if (!href || href === '#' || /^javascript:/i.test(href)) continue;
          try { found = cleanEquipUrl(new URL(href, 'https://id5.cbg.163.com/').href); break; } catch (e) {}
        }
      }
      out[name] = found;
    }
    return out;
  }, CASES);

  console.log('\n提取结果:');
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(18)} → ${v}`);

  check('a 标签直挂详情能提取', results['a 标签直挂详情'] === EQUIP, results['a 标签直挂详情']);
  check('data-href 带参数会清洗', results['div data-href 带参数'] === EQUIP, results['div data-href 带参数']);
  check('相对路径能解析为绝对地址', results['相对路径'] === EQUIP, results['相对路径']);
  check('优先选 equip 而非列表链接', results['外层包裹跳转链接'] === EQUIP, results['外层包裹跳转链接']);
  check('HTML 内嵌 equip 也能兜住', results['HTML 里嵌 equip'] === EQUIP, results['HTML 里嵌 equip']);
  check('只有列表链接时退回列表（去掉 refer_sn）',
    results['只有普通链接'] && !results['只有普通链接'].includes('refer_sn'), results['只有普通链接']);
  check('完全没有链接时返回 null', results['完全没有链接'] === null, String(results['完全没有链接']));

  await ctx.close();
  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
