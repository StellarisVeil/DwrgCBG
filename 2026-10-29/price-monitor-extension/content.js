// content.js — 注入到监控页面，负责扫描、去重、刷新、上报
// 通过 chrome.scripting.registerContentScripts 注册，页面每次加载都会自动运行。

(async function () {
  const CFG_KEY = 'pm_config';
  const NOTIFIED_KEY = 'pm_notified';

  const { [CFG_KEY]: cfg } = await chrome.storage.local.get(CFG_KEY);
  if (!cfg || !cfg.enabled) return;

  let notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};

  // 从文本中提取数值：去掉货币符号/逗号/空格，取第一个数字
  function parseNum(s) {
    if (!s) return null;
    const m = s.replace(/[^0-9.]/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function matchOp(a, op, b) {
    switch (op) {
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: return false;
    }
  }

  // 用标题作为去重主键；没有标题选择器时退化为条目前 60 字
  function itemKey(itemEl) {
    if (cfg.titleSelector) {
      const t = itemEl.querySelector(cfg.titleSelector);
      if (t && t.textContent.trim()) return t.textContent.trim();
    }
    return itemEl.textContent.trim().slice(0, 60);
  }

  function scan() {
    if (!cfg.itemSelector || !cfg.fieldSelector) return;
    const items = document.querySelectorAll(cfg.itemSelector);
    const hits = [];
    items.forEach((item) => {
      const fieldEl = item.querySelector(cfg.fieldSelector);
      if (!fieldEl) return;
      const val = parseNum(fieldEl.textContent);
      if (val === null) return;
      if (matchOp(val, cfg.operator, cfg.threshold)) {
        const key = itemKey(item);
        if (!notified[key]) {
          notified[key] = Date.now();
          hits.push({ title: key, price: val, url: location.href });
        }
      }
    });
    if (hits.length) {
      chrome.runtime.sendMessage({ type: 'PM_HITS', hits });
      chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
    }
  }

  scan();

  const intervalMs = (parseInt(cfg.intervalSec, 10) || 30) * 1000;
  if (cfg.reload) {
    // 整页刷新：依靠 storage 中的 notified 去重，刷新后不再重复提醒
    setTimeout(() => location.reload(), intervalMs);
  } else {
    // 仅定时重新扫描（适合页面自身会动态加载新商品的场景）
    setInterval(scan, intervalMs);
  }
})();
