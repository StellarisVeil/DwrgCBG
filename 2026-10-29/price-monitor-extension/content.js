// content.js — 注入到监控页面（藏宝阁）
// 两种模式：
//   bundle：扫描账号卡，指定皮肤参考价合计 < 阈值 → 提醒（v0.2）
//   search ：按关键词周期搜索并价格升序，最低价 <= 阈值 → 提醒（v0.3 新增）
// 公共风控：时段控制(inWindow) + 刷新随机抖动(nextDelay)
// 注入方式：manifest 声明式 content_scripts（匹配 https://id5.cbg.163.com/*），无需 chrome.scripting。

// 简单 glob 匹配（支持 * 通配），用于运行时按 cfg.pattern 过滤页面
function patternMatches(pattern, url) {
  try {
    const u = new URL(url);
    const reSrc = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // 转义正则特殊字符（保留 *）
      .replace(/\*/g, '.*');                 // * → 任意
    const re = new RegExp('^' + reSrc + '$');
    return re.test(u.href) || re.test(u.origin + u.pathname);
  } catch (e) { return true; }
}

(async function () {
  const CFG_KEY = 'pm_config';
  const NOTIFIED_KEY = 'pm_notified';
  const { [CFG_KEY]: cfg } = await chrome.storage.local.get(CFG_KEY);
  if (!cfg || !cfg.enabled) return;
  if (cfg.pattern && !patternMatches(cfg.pattern, location.href)) return;
  let notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};

  function parseNum(s) {
    if (!s) return null;
    const m = s.replace(/[^0-9.]/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function norm(s) { return (s || '').trim().replace(/\s+/g, ' '); }
  function matchSkin(a, b) {
    const p = norm(a), t = norm(b);
    if (!p || !t) return false;
    return p === t || p.includes(t) || t.includes(p);
  }
  // ③ 提取卡片内可点击的商品链接：优先用配置的选择器，否则自动取卡片内第一个带 href 的 <a>；相对地址解析为绝对地址；都拿不到回退当前页。
  function extractLink(item) {
    const sel = (cfg.linkSelector && cfg.linkSelector.trim()) || 'a[href]';
    let el = null;
    try { el = item.querySelector(sel); } catch (e) { el = null; }
    if (!el) return null;
    const href = el.getAttribute('href') || el.getAttribute('data-href');
    if (!href) return null;
    try { return new URL(href, location.href).href; } catch (e) { return href; }
  }

  // ① 时段控制
  function inWindow() {
    if (!cfg.timeWindowEnabled) return true;
    const h = new Date().getHours();
    const s = parseInt(cfg.windowStart, 10), e = parseInt(cfg.windowEnd, 10);
    if (isNaN(s) || isNaN(e) || s === e) return true;
    if (s < e) return h >= s && h < e;
    return h >= s || h < e;
  }
  // ② 刷新随机抖动
  function nextDelay() {
    const base = Math.max(1, parseInt(cfg.baseInterval != null ? cfg.baseInterval : cfg.intervalSec, 10) || 60);
    const jit = Math.max(0, parseInt(cfg.jitter, 10) || 0);
    return (base + Math.random() * jit) * 1000;
  }

  // ---------- bundle 模式 ----------
  function scanBundle() {
    if (!cfg.itemSelector || !cfg.skinNameSelector ||
        !Array.isArray(cfg.skins) || !cfg.skins.length) return;
    const items = document.querySelectorAll(cfg.itemSelector);
    const hits = [];
    items.forEach((item) => {
      const nameEls = item.querySelectorAll(cfg.skinNameSelector);
      const pageNames = Array.from(nameEls).map(e => norm(e.textContent));
      let acctTitle = '';
      if (cfg.titleSelector) { const t = item.querySelector(cfg.titleSelector); if (t) acctTitle = norm(t.textContent); }
      let acctPrice = null;
      if (cfg.accountPriceSelector) { const p = item.querySelector(cfg.accountPriceSelector); if (p) acctPrice = parseNum(p.textContent); }
      const link = extractLink(item);
      const matched = []; let sum = 0;
      for (const sk of cfg.skins) {
        if (pageNames.some(pn => matchSkin(pn, sk.name))) { matched.push(sk); sum += (parseFloat(sk.price) || 0); }
      }
      if (matched.length && sum < cfg.threshold) {
        const key = (acctTitle || location.href) + '|' + matched.map(m => m.name).sort().join(',');
        if (!notified[key]) {
          notified[key] = Date.now();
          hits.push({ kind: 'bundle', title: acctTitle || '(未命名账号)', acctPrice, matched, sum: Math.round(sum * 100) / 100, url: location.href, link });
        }
      }
    });
    if (hits.length) { chrome.runtime.sendMessage({ type: 'PM_HITS', hits }); chrome.storage.local.set({ [NOTIFIED_KEY]: notified }); }
  }

  // ---------- search 模式 ----------
  function getParam(name) { try { return new URL(location.href).searchParams.get(name); } catch { return null; } }
  function isSearchPage() {
    try { const u = new URL(location.href); return u.pathname.includes('/pl') && u.searchParams.has('keyword'); } catch { return false; }
  }
  function buildSearchUrl(kw) {
    const tpl = cfg.searchUrlTemplate || 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC';
    return tpl.replace('{keyword}', encodeURIComponent(kw));
  }
  // 关键词可能是字符串，或 {name, target} 对象（单独设目标价）
  function kwName(kw) { return (kw && typeof kw === 'object') ? kw.name : kw; }
  function kwTarget(kw) {
    if (kw && typeof kw === 'object' && kw.target != null) return kw.target;
    return cfg.searchPriceThreshold;
  }
  function runSearchCycle() {
    const kws = (cfg.keywords || []).filter(Boolean);
    if (!kws.length) return;
    const cur = getParam('keyword');
    const curName = cur ? decodeURIComponent(cur) : '';
    if (isSearchPage() && cur) {
      const items = document.querySelectorAll(cfg.itemSelector || '.product-item.product-item-cards');
      if (items.length) {
        const first = items[0]; // order_by=price ASC → 第一个即最低价
        const priceEl = first.querySelector(cfg.searchPriceSelector || '.row-hd .price');
        const price = priceEl ? parseNum(priceEl.textContent) : null;
        const link = extractLink(first);
        const curKw = kws.find(k => kwName(k) === curName) || kws[0];
        const target = kwTarget(curKw); // 该词单独目标价，缺省用全局阈值
        if (price != null && price <= target) {
          const key = 'search|' + cur + '|' + price;
          if (!notified[key]) {
            notified[key] = Date.now();
            chrome.runtime.sendMessage({
              type: 'PM_HITS',
              hits: [{ kind: 'search', keyword: curName, price, threshold: target, url: location.href, link }]
            });
            chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
          }
        }
      }
    }
    // 轮到下一个关键词（URL 导航会重载脚本，进入下一轮）
    const idx = kws.findIndex(k => kwName(k) === curName);
    const nextKw = kws[(idx + 1 + kws.length) % kws.length];
    setTimeout(() => { location.href = buildSearchUrl(kwName(nextKw)); }, nextDelay());
  }

  // ---------- 调度 ----------
  function tick() {
    if (!inWindow()) { setTimeout(tick, nextDelay()); return; } // 时段外静默等待
    if (cfg.mode === 'search') { runSearchCycle(); return; }
    // bundle 模式
    if (cfg.reload) {
      scanBundle();
      setTimeout(() => location.reload(), nextDelay());
    } else {
      scanBundle();
      setTimeout(tick, nextDelay());
    }
  }
  tick();
})();
