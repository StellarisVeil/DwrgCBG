// content.js — 注入到监控页面（如藏宝阁首页/搜索流）
// 逻辑：扫描每个账号卡 → 看它拥有哪些皮肤（按名字匹配） → 累加你清单里这些皮肤的参考价
//       → 若合计 < 阈值 → 视为命中，推送一次（去重）。
// 皮肤参考价来自配置（你之后用 Excel/CSV 提供），页面只负责“拥有哪些皮肤”。

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

  // 归一化：去首尾及多余空白，避免“ 司药 ” vs “司药” 匹配不上
  function norm(s) { return (s || '').trim().replace(/\s+/g, ' '); }

  // 皮肤名匹配：精确相等，或互相包含（兼容“石榴碟小姐”与“石榴碟小姐(限定)”这类变体）
  function matchSkin(pageName, targetName) {
    const p = norm(pageName), t = norm(targetName);
    if (!p || !t) return false;
    return p === t || p.includes(t) || t.includes(p);
  }

  function scan() {
    if (!cfg.itemSelector || !cfg.skinNameSelector ||
        !Array.isArray(cfg.skins) || !cfg.skins.length) return;

    const items = document.querySelectorAll(cfg.itemSelector);
    const hits = [];

    items.forEach((item) => {
      // 1) 收集该账号在页面上展示的所有皮肤名
      const nameEls = item.querySelectorAll(cfg.skinNameSelector);
      const pageNames = Array.from(nameEls).map(e => norm(e.textContent));

      // 2) 账号标题 / 账号售价（仅用于去重与展示）
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

      // 3) 遍历你的目标皮肤清单，命中则累加参考价
      const matched = [];
      let sum = 0;
      for (const sk of cfg.skins) {
        if (pageNames.some(pn => matchSkin(pn, sk.name))) {
          matched.push(sk);
          sum += (parseFloat(sk.price) || 0);
        }
      }

      // 4) 命中且合计 < 阈值 → 候选
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

  scan();

  const intervalMs = (parseInt(cfg.intervalSec, 10) || 30) * 1000;
  if (cfg.reload) {
    // 整页刷新：依靠 storage 中的 notified 去重，刷新后不再重复提醒
    setTimeout(() => location.reload(), intervalMs);
  } else {
    setInterval(scan, intervalMs);
  }
})();
