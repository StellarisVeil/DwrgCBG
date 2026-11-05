// content.js — 注入到监控页面（藏宝阁）
// 两种模式：
//   bundle：扫描账号卡，指定皮肤参考价合计 < 阈值 → 提醒
//   search ：按关键词周期搜索并价格升序，最低价 <= 目标价 → 提醒
// 公共风控：时段控制(inWindow) + 刷新随机抖动(nextDelay)
// 注入方式：manifest 声明式 content_scripts（匹配 https://id5.cbg.163.com/*），无需 chrome.scripting。

(function () {
  'use strict';

  const CFG_KEY = 'pm_config';
  const NOTIFIED_KEY = 'pm_notified';
  const BEST_KEY = 'pm_best';          // search 模式：每个关键词已提醒过的最低价（仅日志展示，不再作为推送闸门）
  const TRACK_KEY = 'pm_track';        // 每个关键词上次看到的最低价，用于判断补货/卖出
  const DAILY_KEY = 'pm_daily';        // 今日事件流水（补货/卖出），供 0:00 汇总
  const MAX_NOTIFIED = 1000;           // 去重表最多保留条数（按商品粒度记录，条数比旧版多），防止无限增长
  const PRICE_BUCKET = 10;             // 搜索去重的价格档：同一商品价格 ±5 元内视为“同一价格附近”
  // 轮内相邻关键词之间的随机间隔（毫秒）：20~45 秒。
  // 依据公开实测：同一 IP 若平均快于约每 3 秒一次、连续几十次，会触发滑块验证。
  // 这里远低于该阈值，节奏接近“人一个个点开看”。
  const HOP_MIN_MS = 20000;
  const HOP_MAX_MS = 45000;
  const IMMEDIATE_DELAY = 800;         // 刚启用/刚回到列表页时，立刻去搜索的等待（毫秒）
  const DEFAULT_ITEM_SELECTOR = '.product-item.product-item-cards';
  const DEFAULT_SEARCH_TPL = 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC';
  const LOG_KEY = 'pm_log';             // 查询历史（便于事后纠错）
  const MAX_LOG = 500;                  // 最多保留条数


  let cfg = null;
  let notified = {};
  let best = {};
  let track = {};                       // { 'kw:赤宴': { last: 1150, at: ts, linkPrev: '', ts: '' } }
  let timer = null;
  let stopped = false;
  const warned = new Set();

  function warnOnce(key, ...args) {
    if (warned.has(key)) return;
    warned.add(key);
    try { console.warn('[价格监控]', key, ...args); } catch (e) { /* ignore */ }
  }

  // ---------- 工具 ----------
  // "¥1,200.5 起" → 1200.5；无数字 → null
  function parseNum(v) {
    if (v == null) return null;
    let s = String(v).replace(/[\u00a0\s]/g, '');
    // 去掉千分位逗号（仅数字之间的逗号），避免 "1,880" 被读成 1
    s = s.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1');
    const m = s.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isFinite(n) ? n : null;
  }
  function toNum(v, dflt) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : dflt;
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function matchSkin(a, b) {
    const p = norm(a), t = norm(b);
    if (!p || !t) return false;
    return p === t || p.includes(t) || t.includes(p);
  }
  // 选择器容错：用户填错选择器时只告警一次，不让异常中断整轮监控
  function qsa(root, sel) {
    if (!sel) return [];
    try { return Array.from(root.querySelectorAll(sel)); }
    catch (e) { warnOnce('bad-selector:' + sel, '选择器无效：' + sel); return []; }
  }
  function qs(root, sel) {
    if (!sel) return null;
    try { return root.querySelector(sel); }
    catch (e) { warnOnce('bad-selector:' + sel, '选择器无效：' + sel); return null; }
  }

  // ---------- pattern（glob 通配） ----------
  function patternToRegExp(pattern) {
    const src = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // 转义正则特殊字符（保留 *）
      .replace(/\*/g, '.*');                  // * → 任意
    return new RegExp('^' + src + '$');
  }
  function patternMatches(pattern, url) {
    const p = norm(pattern);
    if (!p) return true;
    let u;
    try { u = new URL(url); } catch (e) { return true; }
    try {
      const re = patternToRegExp(p);
      if (re.test(u.href) || re.test(u.origin + u.pathname) || re.test(u.origin)) return true;
    } catch (e) { return true; }
    // 用户只填了域名/目录（没写 *）时按前缀匹配，避免“静静地不工作”
    if (!p.includes('*')) {
      const base = p.replace(/[?#].*$/, '').replace(/\/+$/, '');
      const href = u.href.replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (href === base || href.startsWith(base + '/')) return true;
      if (u.origin === base) return true;
    }
    return false;
  }

  // ---------- 时段 / 抖动 ----------
  function inWindow() {
    if (!cfg.timeWindowEnabled) return true;
    const h = new Date().getHours();
    const s = toNum(cfg.windowStart, null), e = toNum(cfg.windowEnd, null);
    if (s == null || e == null || s === e) return true;
    if (s < e) return h >= s && h < e;
    return h >= s || h < e;
  }
  function nextDelay() {
    const base = Math.max(1, toNum(cfg.baseInterval != null ? cfg.baseInterval : cfg.intervalSec, 60));
    const jit = Math.max(0, toNum(cfg.jitter, 0));
    return (base + Math.random() * jit) * 1000;
  }
  // 轮内相邻关键词的间隔：在 [HOP_MIN_MS, HOP_MAX_MS] 间随机，避免固定节奏被识别。
  // 设了下限保护：无论用户填多小，都不会低于 15 秒，防止误填导致短时间连续跳转触发风控。
  const HOP_FLOOR_MS = 15000;
  function hopDelay() {
    const minRaw = toNum(cfg.hopMinSec, HOP_MIN_MS / 1000) * 1000;
    const maxRaw = toNum(cfg.hopMaxSec, HOP_MAX_MS / 1000) * 1000;
    const min = Math.max(HOP_FLOOR_MS, minRaw);
    const max = Math.max(min, maxRaw);
    return min + Math.random() * (max - min);
  }

  // 自适应轮内间隔：皮肤会越来越多，若固定用 20~45 秒，词一多一轮就超出整轮周期。
  // 做法：按「整轮周期 ÷ 关键词数」给出每个词的预算，再夹在 [下限, 上限] 之间。
  //   - 词少：预算大，但不超过上限，避免无意义地拖慢（3 个词不必每跳等 10 分钟）
  //   - 词多：预算变小，逐步逼近下限，保证一轮能按周期跑完
  //   - 词特别多：预算低于下限时以下限为准，一轮自然变长（此时应调大周期或减词）
  function roundPeriodMs() {
    const base = Math.max(60, toNum(cfg.baseInterval != null ? cfg.baseInterval : cfg.intervalSec, 1800));
    const jit = Math.max(0, toNum(cfg.jitter, 0));
    return (base + Math.random() * jit) * 1000;
  }
  function adaptiveHopDelay(keywordCount) {
    const n = Math.max(1, keywordCount || 1);
    const budget = roundPeriodMs() / n;       // 每个词能分到的时间
    const minRaw = toNum(cfg.hopMinSec, HOP_MIN_MS / 1000) * 1000;
    const maxRaw = toNum(cfg.hopMaxSec, HOP_MAX_MS / 1000) * 1000;
    const floorMs = Math.max(HOP_FLOOR_MS, minRaw);
    const capMs = Math.max(floorMs, maxRaw);
    // 预算夹在 [下限, 上限]；预算充足时在上限内随机，预算紧张时贴近下限
    let hop;
    if (budget >= capMs) {
      hop = floorMs + Math.random() * (capMs - floorMs);
    } else if (budget <= floorMs) {
      hop = floorMs;
    } else {
      // 在 [下限, 预算] 内随机，保证一轮能落进周期
      hop = floorMs + Math.random() * (budget - floorMs);
    }
    return hop;
  }
  // 估算一轮总耗时（毫秒），供配置页展示
  function estimateRoundMs(keywordCount) {
    const n = Math.max(1, keywordCount || 1);
    const base = Math.max(60, toNum(cfg.baseInterval != null ? cfg.baseInterval : cfg.intervalSec, 1800));
    const jit = Math.max(0, toNum(cfg.jitter, 0));
    const period = (base + jit / 2) * 1000;
    const minRaw = Math.max(HOP_FLOOR_MS, toNum(cfg.hopMinSec, HOP_MIN_MS / 1000) * 1000);
    const maxRaw = Math.max(minRaw, toNum(cfg.hopMaxSec, HOP_MAX_MS / 1000) * 1000);
    // 取实际会用的期望间隔：预算充足时是区间均值，预算紧张时是预算值或下限
    let perHop;
    const budget = period / n;
    if (budget >= maxRaw) perHop = (minRaw + maxRaw) / 2;   // 在 [min,max] 均匀随机 → 均值
    else if (budget <= minRaw) perHop = minRaw;              // 触底，用下限
    else perHop = (minRaw + budget) / 2;                     // 在 [min,budget] 均匀随机 → 均值
    return {
      scanMs: (n - 1) * perHop,        // 一轮内 n 个词之间的 n-1 次间隔
      periodMs: period,
      perHop
    };
  }

  // ---------- 查询日志 ----------
  // 每次扫描都记一条：什么时候查的、查的什么、查到多少、目标多少、是否命中。
  // 存 chrome.storage.local，配置页可查看/导出 CSV 到项目目录，方便事后纠错。
  let logQueue = Promise.resolve();
  function addLog(entry) {
    // 串行化，避免多标签页并发写导致互相覆盖
    logQueue = logQueue.then(async () => {
      try {
        const got = await chrome.storage.local.get(LOG_KEY);
        const list = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
        list.unshift({
          ts: Date.now(),
          time: new Date().toLocaleString('zh-CN'),
          ...entry
        });
        if (list.length > MAX_LOG) list.length = MAX_LOG;
        await chrome.storage.local.set({ [LOG_KEY]: list });
      } catch (e) { /* 日志失败不影响监控 */ }
    }).catch(() => {});
    return logQueue;
  }

  // 记录今日补货/卖出事件（只写本地，不推送），供次日 0:00 汇总
  async function pushDailyEvent(evt) {
    try {
      const got = await chrome.storage.local.get(DAILY_KEY);
      const d = got[DAILY_KEY] && typeof got[DAILY_KEY] === 'object' ? got[DAILY_KEY] : {};
      const day = new Date().toLocaleDateString('zh-CN');   // 按本地日期分桶
      if (!d.days) d.days = {};
      if (!d.days[day]) d.days[day] = [];
      d.days[day].unshift({
        ts: evt.at || Date.now(),
        time: evt.time || new Date().toLocaleString('zh-CN'),
        keyword: evt.keyword,
        kind: evt.kind,                 // restock | sold
        price: evt.price,
        prevPrice: evt.prevPrice,
        delta: evt.delta,
        link: evt.link || '',
        target: evt.target == null ? null : evt.target
      });
      // 只保留最近 7 天，避免无限增长
      const keys = Object.keys(d.days).sort();
      while (keys.length > 7) delete d.days[keys.shift()];
      await chrome.storage.local.set({ [DAILY_KEY]: d });
    } catch (e) { /* 汇总数据写入失败不影响监控 */ }
  }

  // ---------- 存储 ----------
  function trimNotified() {
    const keys = Object.keys(notified);
    if (keys.length <= MAX_NOTIFIED) return;
    keys
      .sort((a, b) => toNum(notified[b], 0) - toNum(notified[a], 0))
      .slice(MAX_NOTIFIED)
      .forEach(k => { delete notified[k]; });
  }
  // 带回调的 sendMessage：service worker 未就绪/扩展重载时不抛未捕获异常
  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message || String(err) }); return; }
          resolve(res || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }
  // 先落去重记录再推送；推送失败则回滚，避免“漏提醒后永不再提醒”
  async function commitAndNotify(hits, keys) {
    const now = Date.now();
    keys.forEach(k => { notified[k] = now; });
    trimNotified();
    try { await chrome.storage.local.set({ [NOTIFIED_KEY]: notified }); } catch (e) { /* ignore */ }
    const res = await sendMessage({ type: 'PM_HITS', hits });
    if (res && res.ok === false) {
      warnOnce('push-failed', '企业微信推送失败：' + (res.error || '未知错误'));
      keys.forEach(k => { delete notified[k]; });
      try { await chrome.storage.local.set({ [NOTIFIED_KEY]: notified }); } catch (e) { /* ignore */ }
    }
    return res;
  }

  // ---------- 链接提取 ----------
  // 优先用配置的选择器，否则自动取卡片内第一个带 href 的 <a>；相对地址解析为绝对地址
  // 从任意字符串里抠出永久有效的商品详情链接。
  // 藏宝阁真实详情页形如 .../cgi/mweb/equip/1/202610261903416-1-J7XEAGX9OZKOYF
  // 关键：必须丢掉 refer_sn 之类的会话参数，否则链接过一会儿就失效、在微信里打不开。
  const EQUIP_RE = /https?:\/\/[^\s"'<>()]*?\/cgi\/mweb\/equip\/[^\s"'<>()?#&]+/i;
  function cleanEquipUrl(u) {
    if (!u) return null;
    const s = String(u).trim();
    const m = s.match(EQUIP_RE);
    if (m) return m[0];
    // 不是 equip 形式就原样返回，但要剥掉可疑的会话参数
    try {
      const url = new URL(s, location.href);
      ['refer_sn', 'refer_page', 'traceid', 'from', 'spm', 'sessionid'].forEach(k => url.searchParams.delete(k));
      return url.href;
    } catch (e) { return s; }
  }

  // 商品链接提取：优先用配置的选择器，否则在卡片里找“看起来像商品详情”的链接。
  // 返回的永远是去参后的干净地址，保证点击能打开。
  function extractLink(item) {
    const custom = norm(cfg.linkSelector);

    // 1) 用户自定义选择器
    if (custom) {
      const el = qs(item, custom);
      const href = el && (el.getAttribute('href') || el.getAttribute('data-href'));
      if (href && href !== '#' && !/^javascript:/i.test(href)) {
        return cleanEquipUrl(new URL(href, location.href).href);
      }
    }

    // 2) 卡片内所有 <a>：优先挑 equip 详情链接
    const anchors = qsa(item, 'a[href], a[data-href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || a.getAttribute('data-href');
      if (!href || href === '#' || /^javascript:/i.test(href)) continue;
      let abs;
      try { abs = new URL(href, location.href).href; } catch (e) { continue; }
      if (EQUIP_RE.test(abs)) return cleanEquipUrl(abs);
    }

    // 3) 退而求其次：找卡片上任何 data-* 里带 equip 的地址
    const html = item.outerHTML || '';
    const m = html.match(EQUIP_RE);
    if (m) return cleanEquipUrl(m[0]);

    // 4) 最后才用第一个普通链接（至少能点开）
    for (const a of anchors) {
      const href = a.getAttribute('href') || a.getAttribute('data-href');
      if (!href || href === '#' || /^javascript:/i.test(href)) continue;
      try { return cleanEquipUrl(new URL(href, location.href).href); } catch (e) { /* ignore */ }
    }
    return null;
  }

  // ---------- bundle 模式 ----------
  async function scanBundle() {
    if (!cfg.itemSelector || !cfg.skinNameSelector) {
      warnOnce('bundle-selector', '皮肤套餐模式缺少「账号卡容器选择器」或「皮肤名选择器」');
      return null;
    }
    const skins = Array.isArray(cfg.skins) ? cfg.skins : [];
    if (!skins.length) { warnOnce('bundle-skins', '皮肤清单为空'); return null; }
    const threshold = toNum(cfg.threshold, null);
    if (threshold == null) { warnOnce('bundle-threshold', '「合计参考价阈值」不是有效数字，已跳过判断'); return null; }

    const chalB = detectChallenge();
    if (chalB.hit) { await enterRateLimitPause({ ...chalB, keyword: '(列表扫描)' }); return null; }

    await waitForCards(RENDER_WAIT_MS);
    const items = qsa(document, cfg.itemSelector);
    if (!items.length) {
      const chalB2 = detectChallenge();
      if (chalB2.hit) { await enterRateLimitPause({ ...chalB2, keyword: '(列表扫描)' }); return null; }
      warnOnce('bundle-empty', '未匹配到账号卡：' + cfg.itemSelector);
      addLog({
        kind: 'bundle', keyword: '(列表扫描)', price: null, target: threshold,
        hit: false,
        result: `等待 ${Math.round(RENDER_WAIT_MS / 1000)}s 仍未出现账号卡`
          + (isLoadingLike() ? '（页面仍在加载）' : '（可能选择器不匹配；若多次出现请检查是否被风控）'),
        cards: 0, url: location.href
      });
    }

    // 本轮最低的“命中账号合计价”，用于记录行情
    let lowestSum = null;
    let lowestAcct = null;

    const hits = [];
    items.forEach((item) => {
      const pageNames = qsa(item, cfg.skinNameSelector).map(e => norm(e.textContent));
      const titleEl = qs(item, cfg.titleSelector);
      const acctTitle = titleEl ? norm(titleEl.textContent) : '';
      const priceEl = qs(item, cfg.accountPriceSelector);
      const acctPrice = priceEl ? parseNum(priceEl.textContent) : null;
      const link = extractLink(item);

      const matched = [];
      let sum = 0;
      for (const sk of skins) {
        if (sk && pageNames.some(pn => matchSkin(pn, sk.name))) {
          matched.push(sk);
          sum += toNum(sk.price, 0);
        }
      }
      if (matched.length && (lowestSum == null || sum < lowestSum)) {
        lowestSum = sum;
        lowestAcct = { title: acctTitle || '(未命名账号)', acctPrice, link, matched: matched.map(m => m.name) };
      }
      if (!matched.length || sum >= threshold) return;

      // 去重主键：优先用商品链接（唯一），其次账号标题+售价；都没有则回退当前页
      const idParts = [link, acctTitle, acctPrice].filter(v => v !== '' && v != null);
      const key = 'bundle|' + (idParts.length ? idParts.join('|') : location.href)
        + '|' + matched.map(m => m.name).sort().join(',');
      if (notified[key]) return;

      hits.push({
        kind: 'bundle',
        title: acctTitle || '(未命名账号)',
        acctPrice,
        matched,
        sum: Math.round(sum * 100) / 100,
        url: location.href,
        link,
        key
      });
    });

    // 记录本轮扫描行情：命中账号数 + 最低合计价
    if (items.length) {
      addLog({
        kind: 'bundle',
        keyword: '(列表扫描)',
        price: lowestSum,
        target: threshold,
        hit: hits.length > 0,
        result: hits.length
          ? `命中 ${hits.length} 个账号待提醒`
          : (lowestSum == null ? '无目标皮肤' : '有目标皮肤但合计价未低于阈值'),
        lowest: lowestAcct,
        cards: items.length,
        url: location.href,
        link: lowestAcct ? lowestAcct.link : null
      });
    }

    if (!hits.length) return null;
    return { hits, keys: hits.map(h => h.key) };
  }

  // ---------- search 模式 ----------
  function getKeywordParam() {
    try {
      // searchParams.get() 已解码，不要再 decodeURIComponent（否则 % 会抛 URIError）
      const v = new URL(location.href).searchParams.get('keyword');
      return v == null ? null : v.trim();
    } catch (e) { return null; }
  }
  function buildSearchUrl(kw) {
    const tpl = norm(cfg.searchUrlTemplate) || DEFAULT_SEARCH_TPL;
    if (!/\{keyword\}/i.test(tpl)) {
      warnOnce('search-tpl', '「搜索 URL 模板」缺少 {keyword} 占位符，已停止自动跳转');
      return null;
    }
    return tpl.replace(/\{keyword\}/gi, encodeURIComponent(kw));
  }
  function kwName(kw) { return (kw && typeof kw === 'object') ? norm(kw.name) : norm(kw); }
  function kwTarget(kw) {
    if (kw && typeof kw === 'object' && kw.target != null) {
      const t = toNum(kw.target, null);
      if (t != null) return t;
    }
    return toNum(cfg.searchPriceThreshold, null);
  }
  function readCardPrice(card) {
    let el = qs(card, cfg.searchPriceSelector || '.row-hd .price');
    if (!el) el = qs(card, '.price');
    if (!el) return null;
    return parseNum(el.textContent);
  }

  // 搜索结果里的“商品身份”：链接优先（同一商品刷新/换页都不变）；
  // 链接拿不到时退化为「标题 + 卡片文本」，并剔除价格文本，避免价格变化改变身份。
  function cardIdentity(card) {
    const link = extractLink(card);
    if (link) return 'link:' + link;
    const titleEl = qs(card, cfg.titleSelector || '.main-title');
    const title = norm(titleEl ? titleEl.textContent : '');
    let text = norm(card.textContent);
    const priceEl = qs(card, cfg.searchPriceSelector || '.row-hd .price') || qs(card, '.price');
    const priceTxt = priceEl ? norm(priceEl.textContent) : '';
    if (priceTxt) text = norm(text.split(priceTxt).join(' '));
    return 'text:' + norm(title + '|' + text).slice(0, 200);
  }

  // 读取整页卡片的最低报价。
  // 默认第一个即最低（order_by=price ASC），但如果某张卡读不到价、或排序参数被改动，
  // 就退化成“取所有卡片里的最小值”，避免把非最低价当成最低价造成误判。
  function readLowest(items) {
    const prices = [];
    for (const it of items) {
      const p = readCardPrice(it);
      if (p != null && isFinite(p)) prices.push({ price: p, el: it });
    }
    if (!prices.length) return null;
    prices.sort((a, b) => a.price - b.price);
    const lowest = prices[0];
    return {
      price: lowest.price,
      el: lowest.el,
      link: extractLink(lowest.el),
      count: items.length,       // 本页卡片数，用于辅助判断
      all: prices.map(p => p.price)
    };
  }

  // ---------- 补货 / 卖出 判定 ----------
  // 逻辑：同一关键词，比较本次最低价与上次最低价
  //   价格变低 → 有更便宜的上架 = 补货（restock）
  //   价格变高 → 最便宜的那个没了 = 卖出（sold）
  //   价格不变 → 无事件
  // 首次记录只建立基线，不产生事件，避免一启用就误报。
  const TRACK_MIN_DIFF = 1;       // 价格差至少 1 元才判定为变化（防浮点抖动）
  function detectPriceEvent(shownName, price, link, target) {
    const k = 'kw:' + shownName;
    const prev = track[k];
    const now = { last: price, at: Date.now(), time: new Date().toLocaleString('zh-CN'), link: link || '' };

    if (!prev || !isFinite(toNum(prev.last, null))) {
      track[k] = now;
      return null;                 // 第一次见到：只建立基线
    }
    const before = toNum(prev.last, null);
    const diff = price - before;
    if (Math.abs(diff) < TRACK_MIN_DIFF) {
      track[k] = { ...now, firstSeen: prev.firstSeen || prev.at };  // 价格未变，只更新时间
      return null;
    }

    track[k] = { ...now, firstSeen: prev.firstSeen || prev.at };
    if (diff < 0) {
      return {
        kind: 'restock',
        keyword: shownName,
        price,
        prevPrice: before,
        delta: diff,
        target,
        link,
        url: location.href
      };
    }
    return {
      kind: 'sold',
      keyword: shownName,
      price,
      prevPrice: before,
      delta: diff,
      target,
      link,
      url: location.href
    };
  }

  // 藏宝阁是 Vue 客户端渲染：DOM 先出现骨架，商品卡片要等接口返回后才挂上去。
  // 在 document_idle 立刻扫描必然读到 0 个卡片，这是日志里“未找到商品卡片”的根因。
  // 这里改成轮询等待，直到卡片出现或超时。
  const RENDER_WAIT_MS = 12000;
  const RENDER_POLL_MS = 250;

  function countCards() {
    return qsa(document, cfg.itemSelector || DEFAULT_ITEM_SELECTOR).length;
  }
  function isLoadingLike() {
    // 页面还在加载时常见：骨架屏、loading 文案、内容极少
    const txt = norm(document.body ? document.body.textContent : '');
    if (/加载中|loading|请稍候/i.test(txt)) return true;
    return false;
  }

  // ---------- 风控识别 ----------
  // 目的：一旦被要求验证/被拦截，立刻停止监控并通知，避免在风控状态下继续刷、
  // 把临时限制刷成更严重的封禁。
  const VERIFY_TEXTS = [
    /拖动.{0,6}滑块/i, /滑动.{0,4}验证/i, /安全验证/, /人机验证/,
    /验证码.{0,4}(错误|不正确|已过期|失效)/,     // 只认“验证码出错”，不认"用验证码登录"
    /访问.{0,6}过于频繁/, /操作.{0,6}频繁/, /请稍后再试/, /异常访问/,
    /禁止访问/, /访问受限/, /暂时无法访问/, /请求异常/
  ];
  // 这些是正常业务文案，命中不代表风控
  const BENIGN = [/验证码直接登录/, /手机.{0,4}验证码.{0,4}登录/, /获取验证码/, /发送验证码/];
  // 出现这些说明需要人手动过验证
  function detectChallenge() {
    const text = norm(document.body ? document.body.textContent : '').slice(0, 3000);
    const title = norm(document.title);
    const hay = title + ' ' + text;

    // 常见验证码容器
    const sel = [
      '#nc_1_wrapper', '.nc-container', '.nc_wrapper',     // 阿里滑块
      '#captcha', '.captcha', '.verify-wrap', '.geetest_panel',
      'iframe[src*="captcha"]', 'iframe[src*="verify"]',
      '[class*="slider-verify"]', '[class*="verify-slider"]'
    ].join(',');
    let hasWidget = false;
    try { hasWidget = !!document.querySelector(sel); } catch (e) { hasWidget = false; }

    // 被跳转到登录页（登录态失效）——优先判断，避免被"验证码登录"字样误判为风控
    if (/show_login|showlogin/i.test(location.href)) {
      return { hit: true, reason: '被跳转到登录页（登录态可能已失效）', hasWidget: false };
    }
    if (/登录/.test(title) && !document.querySelector('.product-item')) {
      return { hit: true, reason: '页面被替换为登录页（登录态可能已失效）', hasWidget: false };
    }

    // 命中正常业务文案则不算风控
    const benignHit = BENIGN.some(re => re.test(hay));

    for (const re of VERIFY_TEXTS) {
      if (re.test(hay)) {
        if (benignHit && !/滑块|安全验证|人机验证/.test(hay)) continue;
        return { hit: true, reason: '页面要求验证：' + (hay.match(re) || [''])[0], hasWidget };
      }
    }
    if (hasWidget) return { hit: true, reason: '页面出现验证码组件', hasWidget: true };

    return { hit: false };
  }

  // 进入风控暂停：停掉定时器 + 记录 + 上报
  let challengeReported = false;
  async function enterRateLimitPause(info) {
    if (challengeReported) return;
    challengeReported = true;
    stop();   // 立即停止所有跳转/扫描

    addLog({
      kind: 'system',
      keyword: '(风控)',
      price: null,
      target: null,
      hit: false,
      result: '⚠ 已暂停监控：' + info.reason,
      url: location.href
    });

    try {
      await chrome.storage.local.set({
        pm_paused_reason: {
          reason: info.reason,
          url: location.href,
          at: Date.now(),
          time: new Date().toLocaleString('zh-CN')
        }
      });
    } catch (e) { /* ignore */ }

    sendMessage({
      type: 'PM_CHALLENGE',
      reason: info.reason,
      url: location.href,
      keyword: info.keyword || '',
      hasWidget: !!info.hasWidget
    }).catch(() => {});
  }
  function waitForCards(timeoutMs) {
    const limit = timeoutMs == null ? RENDER_WAIT_MS : timeoutMs;
    return new Promise((resolve) => {
      const start = Date.now();
      const tickCheck = () => {
        if (stopped) { resolve(0); return; }
        const n = countCards();
        if (n > 0) { resolve(n); return; }
        if (Date.now() - start >= limit) { resolve(0); return; }
        setTimeout(tickCheck, RENDER_POLL_MS);
      };
      tickCheck();
    });
  }

  // 首轮遍历进度：跨页面导航保留（sessionStorage 在同标签页导航间不清空）。
  // 以“启用令牌”为界：每次重新启用（令牌变化）都重新把每个关键词立刻搜一遍；
  // 之后才按 60~90 秒的随机间隔轮询。
  const PASS_KEY = 'pm_first_pass';
  function currentToken() {
    return String(cfg.runToken || 'default');
  }
  function readPass() {
    const tok = currentToken();
    try {
      const raw = sessionStorage.getItem(PASS_KEY);
      const st = raw ? JSON.parse(raw) : null;
      if (st && st.tok === tok && st.passId === cfg.searchPassId) return st;
    } catch (e) { /* ignore */ }
    return { tok, passId: cfg.searchPassId, done: [], complete: false };
  }
  function writePass(st) {
    try { sessionStorage.setItem(PASS_KEY, JSON.stringify(st)); } catch (e) { /* ignore */ }
  }

  // 是否是“列表类”页面：首页/分类/搜索页（有卡片）才允许自动跳去搜索。
  // 商品详情页、个人中心等不要劫持走，否则用户点进商品就被弹出去。
  function isListLikePage() {
    if (qsa(document, cfg.itemSelector || DEFAULT_ITEM_SELECTOR).length) return true;
    try {
      const path = new URL(location.href).pathname.replace(/\/+$/, '');
      if (path === '') return true;                       // 站点根
      if (/\/pl(\/|$)/.test(path)) return true;          // 藏宝阁列表路由
      if (/\/(index|list|search)(\.[a-z]+)?$/i.test(path)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  async function runSearchCycle() {
    const kws = (Array.isArray(cfg.keywords) ? cfg.keywords : []).filter(k => kwName(k));
    if (!kws.length) { warnOnce('search-kws', '关键词清单为空'); return stop(); }

    const curName = getKeywordParam();
    const onSearchPage = !!curName;
    // 不在搜索结果页：刚启用或刚回到列表页就立刻去搜；详情页则等待，不劫持
    const autoStart = !onSearchPage && isListLikePage();
    if (!onSearchPage && !autoStart) {
      schedule(tick, nextDelay());
      return;
    }

    if (onSearchPage) {
      const curKw = kws.find(k => kwName(k) === curName) || kws.find(k => matchSkin(kwName(k), curName));
      const target = curKw ? kwTarget(curKw) : toNum(cfg.searchPriceThreshold, null);
      const shownName = curKw ? kwName(curKw) : curName;

      // 先查风控：被要求验证/被拦截时立刻停下并通知，绝不继续跳转
      const chal = detectChallenge();
      if (chal.hit) { await enterRateLimitPause({ ...chal, keyword: shownName }); return; }

      // 关键：等卡片真正渲染出来再扫（Vue 异步渲染，立刻扫一定是 0 个）
      const waited = await waitForCards(RENDER_WAIT_MS);
      const items = qsa(document, cfg.itemSelector || DEFAULT_ITEM_SELECTOR);

      if (!items.length) {
        // 等完仍没卡片：可能是风控静默拦截（返回空列表），再查一次
        const chal2 = detectChallenge();
        if (chal2.hit) { await enterRateLimitPause({ ...chal2, keyword: shownName }); return; }
        warnOnce('search-empty', '搜索结果为空或卡片选择器不匹配：' + (cfg.itemSelector || DEFAULT_ITEM_SELECTOR));
        addLog({
          kind: 'search', keyword: shownName, price: null, target,
          hit: false,
          result: `等待 ${Math.round(RENDER_WAIT_MS / 1000)}s 仍未出现商品卡片`
            + (isLoadingLike() ? '（页面仍在加载）' : '（可能选择器不匹配；若多次出现请检查是否被风控）'),
          cards: 0, url: location.href
        });
        void waited;
      } else {
        const lowest = readLowest(items);
        const price = lowest ? lowest.price : null;
        const cardLink = lowest ? lowest.link : null;
        if (price == null) {
          warnOnce('search-price', '读不到最低价，请检查「最低价所在元素选择器」');
          addLog({
            kind: 'search', keyword: shownName, price: null, target,
            hit: false, result: '读不到价格', cards: items.length,
            url: location.href, link: cardLink
          });
        } else {
          // ① 判断「补货 / 卖出」——只做记录，用于每日汇总，不推送
          //    低于上次 → 补货（有更便宜的上架）；高于上次 → 卖出（最便宜的没了）
          let evt = null;
          if (cfg.trackChanges !== false) {
            evt = detectPriceEvent(shownName, price, cardLink, target);
            try { await chrome.storage.local.set({ [TRACK_KEY]: track }); } catch (e) { /* ignore */ }
            if (evt) {
              // 记入"今日事件"流水，供 0:00 汇总使用（不触发任何通知）
              await pushDailyEvent(evt);
            }
          }

          // ② 判断「是否低于目标价」：按「商品身份 + 价格档」去重后推送
          //    旧版用 pm_best（该词历史最低价）当闸门：另一个商品同样 ¥300 会被判成“非新低”而漏报。
          //    现在改为逐商品判断：商品 ≤ 目标价、且该商品在该价格档没提醒过就提醒；
          //    同一商品同价附近仍只提醒一次，原有防刷屏能力保留。
          const reached = target != null && price <= target;
          const prevBest = toNum(best['kw:' + shownName], null);
          const hits = [];
          const keys = [];
          const seenKeys = new Set();
          let skipped = 0;                 // 命中过、但同一商品同一价格档已提醒过的数量
          let eventAttached = false;
          if (reached) {
            for (const it of items) {
              const p = readCardPrice(it);
              if (p == null || p > target) continue;
              // 新键带 item: 前缀，与旧版 search|关键词|价格 的键天然不冲突（旧键视作无记录）
              const key = 'search|item:' + cardIdentity(it)
                + '|p' + Math.round(p / PRICE_BUCKET);
              if (notified[key] || seenKeys.has(key)) { skipped++; continue; }
              seenKeys.add(key);
              // 补货/卖出事件按全场最低价判定，只挂到对应那条消息上
              const isEventHit = !eventAttached && !!evt && p === price;
              if (isEventHit) eventAttached = true;
              keys.push(key);
              hits.push({
                kind: 'search',
                keyword: shownName,
                price: p,
                threshold: target,
                url: location.href,
                link: extractLink(it),
                hasEvent: isEventHit,
                eventKind: isEventHit ? (evt ? evt.kind : '') : ''
              });
            }
          }
          let pushed = false;
          let pushError = '';

          if (hits.length) {
            const res = await commitAndNotify(hits, keys);
            pushed = !(res && res.ok === false);
            if (!pushed) pushError = (res && res.error) || '未知错误';
            else {
              // pm_best 仅作为“该词已提醒过的最低价”记录，用于日志展示，不再参与推送判断
              const minHit = hits.reduce((m, h) => (m == null || h.price < m ? h.price : m), null);
              if (minHit != null && (prevBest == null || minHit < prevBest)) {
                best['kw:' + shownName] = minHit;
                try { await chrome.storage.local.set({ [BEST_KEY]: best }); } catch (e) { /* ignore */ }
              }
            }
          }

          // ④ 写查询记录（把变动事件合并进同一条）
          let resultText;
          if (!reached) resultText = '未达目标价';
          else if (pushed) resultText = '命中已提醒'
            + (hits.length > 1 ? `（${hits.length} 个商品）` : '')
            + (skipped ? `，${skipped} 个同商品同价已跳过` : '');
          else if (hits.length) resultText = '命中但推送失败：' + pushError;
          else resultText = '命中但已提醒过（同一商品同价）';
          if (evt) {
            resultText = (evt.kind === 'restock' ? '🆕 补货' : '📤 卖出')
              + '（' + evt.prevPrice + '→' + price + '，' + (evt.delta > 0 ? '+' : '') + evt.delta + '）'
              + (evt.pushOk ? '已通知' : '通知失败：' + (evt.pushError || ''))
              + '；' + resultText;
          }

          addLog({
            kind: 'search',
            keyword: shownName,
            price,
            target,
            hit: reached,
            pushed,
            result: resultText,
            event: evt ? evt.kind : '',
            prevPrice: evt ? evt.prevPrice : (prevBest != null ? prevBest : null),
            delta: evt ? evt.delta : null,
            prevLow: prevBest,
            cards: items.length,
            url: location.href,
            link: cardLink
          });
        }
      }
    }

    // 记录本轮进度
    const pass = readPass();
    if (!pass.roundStart) pass.roundStart = Date.now();   // 本轮开始时间，用于补足周期
    if (onSearchPage && curName && !pass.done.includes(curName)) pass.done.push(curName);
    if (kws.every(k => pass.done.includes(kwName(k)))) pass.complete = true;

    // 本轮已扫完 → 即将开始的是一次「新一轮」，把进度清零，
    // 否则 complete 永远为真，轮内每个词都会被当成“整轮间隔”，节奏退回最慢。
    const startingNewRound = pass.complete;
    const roundUsedMs = pass.roundStart ? (Date.now() - pass.roundStart) : 0;  // 先取本轮到此刻用了多久
    if (startingNewRound) {
      pass.done = [];
      pass.complete = false;
      pass.roundStart = 0;      // 新一轮开始时重置
    }
    writePass(pass);

    // 决定下一个要搜的关键词：
    //  - 不在结果页 → 从第一个关键词开始（用户刚启用/刚回主页，应该马上看到搜索）
    //  - 在结果页   → 顺延到下一个（扫完最后一个则回到第一个，即新一轮）
    let nextKw;
    if (autoStart || startingNewRound) {
      nextKw = kws[0];
    } else {
      const idx = kws.findIndex(k => kwName(k) === curName);
      nextKw = kws[(idx + 1 + kws.length) % kws.length];
    }
    const nextUrl = buildSearchUrl(kwName(nextKw));
    if (!nextUrl) return;

    // 调度：把“整轮扫完所有关键词”当作一个周期（baseInterval），
    // 轮内每个词之间按「周期 ÷ 词数」自适应用间隔错开，
    // 这样皮肤从 3 个涨到 30 个，一轮仍然能落在设定周期内。
    let delay;
    if (autoStart) {
      delay = IMMEDIATE_DELAY;          // 刚启用/刚回主页：立刻开始
    } else if (startingNewRound) {
      // 上一轮已扫完 → 补足整轮周期再开始新一轮（扣掉本轮已经用掉的时间）
      const period = roundPeriodMs();
      delay = Math.max(HOP_FLOOR_MS, period - roundUsedMs);
    } else {
      delay = adaptiveHopDelay(kws.length);   // 轮内推进下一个关键词
    }
    schedule(() => { location.href = nextUrl; }, delay);
  }

  // ---------- 调度 ----------
  function schedule(fn, delay) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, delay);
  }
  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function tick() {
    if (stopped) return;
    if (!inWindow()) { schedule(tick, nextDelay()); return; } // 时段外静默等待
    if (cfg.mode === 'search') { runSearchCycle().catch(e => warnOnce('search-err', e)); return; }
    // bundle 模式
    const run = async () => {
      let result = null;
      try { result = await scanBundle(); } catch (e) { warnOnce('bundle-err', e); }
      if (result) {
        try {
          await commitAndNotify(result.hits, result.keys);
        } catch (e) { warnOnce('bundle-push', e); }
        if (cfg.reload) { location.reload(); return; }
      } else if (cfg.reload) {
        location.reload();
        return;
      }
      if (!cfg.reload) schedule(tick, nextDelay());
    };
    if (cfg.reload) schedule(() => { run(); }, nextDelay());
    else run();
  }

  // ---------- 启动 ----------
  (async function init() {
    try {
      const got = await chrome.storage.local.get([CFG_KEY, NOTIFIED_KEY, BEST_KEY, TRACK_KEY, 'pm_paused_reason']);
      cfg = got[CFG_KEY];
      notified = got[NOTIFIED_KEY] || {};
      best = got[BEST_KEY] || {};
      track = got[TRACK_KEY] || {};
      if (!cfg || !cfg.enabled) return;
      if (!patternMatches(cfg.pattern, location.href)) return;

      // 之前因风控暂停过：本次是用户手动重新启用（runToken 变了）才会走进来，
      // 这里清掉暂停标记，让监控继续。若仍在验证页，detectChallenge 会再次触发暂停。
      if (got.pm_paused_reason) {
        const paused = got.pm_paused_reason;
        try { await chrome.storage.local.remove('pm_paused_reason'); } catch (e) { /* ignore */ }
        warned.add('resumed');
        try {
          console.info('[价格监控] 已清除上次的风控暂停标记（' +
            (paused && paused.reason) + '），继续监控');
        } catch (e) { /* ignore */ }
      }

      // 配置变更：关掉就停；重新启用则立刻去搜，而不是慢吞吞地刷新
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[CFG_KEY]) return;
        const next = changes[CFG_KEY].newValue;
        const was = changes[CFG_KEY].oldValue || {};
        if (!next || !next.enabled) { stop(); return; }
        // 从停用切到启用：不必刷整页，直接跳到第一个关键词
        if (!was.enabled && next.enabled && next.mode === 'search') {
          const kws = (Array.isArray(next.keywords) ? next.keywords : []).filter(k => kwName(k));
          if (kws.length) {
            const url = buildSearchUrl(kwName(kws[0]));
            if (url) { location.href = url; return; }
          }
        }
        location.reload();
      });

      tick();
    } catch (e) {
      try { console.warn('[价格监控] 初始化失败', e); } catch (err) { /* ignore */ }
    }
  })();
})();
