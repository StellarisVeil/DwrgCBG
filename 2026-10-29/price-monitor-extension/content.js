// content.js — 注入到监控页面（如藏宝阁首页/搜索流）
// 风控策略：①时段控制（仅窗口内扫描/刷新）②刷新随机抖动（基础间隔 + 随机秒数）
// 业务逻辑：扫描每个账号卡 → 看它拥有哪些皮肤（按名字匹配） → 累加清单里这些皮肤的参考价
//          → 若合计 < 阈值 → 命中，推送一次（去重）。皮肤参考价来自配置（你后续用 Excel/CSV 提供）。

(async function () {
  const CFG_KEY = 'pm_config';
  const NOTIFIED_KEY = 'pm_notified';

  const { [CFG_KEY]: cfg } = await chrome.storage.local.get(CFG_KEY);
  if (!cfg || !cfg.enabled) return;

  let notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};

  function parseNum(s) {
    if (!s) return null;
    const m = s.replace(/[^0-9.]/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function norm(s) { return (s || '').trim().replace(/\s+/g, ' '); }
  function matchSkin(pageName, targetName) {
    const p = norm(pageName), t = norm(targetName);
    if (!p || !t) return false;
    return p === t || p.includes(t) || t.includes(p);
  }

  // ① 时段控制：是否在允许监控的时段内
  function inWindow() {
    if (!cfg.timeWindowEnabled) return true;
    const h = new Date().getHours();
    const s = parseInt(cfg.windowStart, 10);
    const e = parseInt(cfg.windowEnd, 10);
    if (isNaN(s) || isNaN(e) || s === e) return true; // 未正确配置 → 放行
    if (s < e) return h >= s && h < e;                // 同日：9→23
    return h >= s || h < e;                            // 跨午夜：22→8
  }

  // ② 刷新随机：基础间隔 + [0, jitter) 秒随机
  function nextDelay() {
    const base = Math.max(1, parseInt(cfg.baseInterval != null ? cfg.baseInterval : cfg.intervalSec, 10) || 60);
    const jit = Math.max(0, parseInt(cfg.jitter, 10) || 0);
    return (base + Math.random() * jit) * 1000;
  }

  function scan() {
    if (!cfg.itemSelector || !cfg.skinNameSelector ||
        !Array.isArray(cfg.skins) || !cfg.skins.length) return;
    const items = document.querySelectorAll(cfg.itemSelector);
    const hits = [];
    items.forEach((item) => {
      const nameEls = item.querySelectorAll(cfg.skinNameSelector);
      const pageNames = Array.from(nameEls).map(e => norm(e.textContent));
      let acctTitle = '';
      if (cfg.titleSelector) {
        const t = item.querySelector(cfg.titleSelector);
        if (t) acctTitle = norm(t.textContent);
      }
      let acctPrice = null;
      if (cfg.accountPriceSelector) {
        const p = item.querySelector(cfg.accountPriceSelector);
        if (p) acctPrice = parseNum(p.textContent);
      }
      const matched = [];
      let sum = 0;
      for (const sk of cfg.skins) {
        if (pageNames.some(pn => matchSkin(pn, sk.name))) {
          matched.push(sk);
          sum += (parseFloat(sk.price) || 0);
        }
      }
      if (matched.length && sum < cfg.threshold) {
        const key = (acctTitle || location.href) + '|' + matched.map(m => m.name).sort().join(',');
        if (!notified[key]) {
          notified[key] = Date.now();
          hits.push({
            title: acctTitle || '(未命名账号)',
            acctPrice,
            matched,
            sum: Math.round(sum * 100) / 100,
            url: location.href
          });
        }
      }
    });
    if (hits.length) {
      chrome.runtime.sendMessage({ type: 'PM_HITS', hits });
      chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
    }
  }

  // 初次：仅在时段内扫描一次
  if (inWindow()) scan();

  // 调度：递归 setTimeout 实现随机抖动；时段外不刷新、只静默空转等待窗口开启
  function schedule() {
    const delay = nextDelay();
    setTimeout(() => {
      if (cfg.reload) {
        if (inWindow()) { location.reload(); return; } // 时段内才真正刷新（重载后脚本重跑）
        schedule();                                     // 时段外：不刷新，继续等待
      } else {
        if (inWindow()) scan();
        schedule();
      }
    }, delay);
  }
  schedule();
})();
