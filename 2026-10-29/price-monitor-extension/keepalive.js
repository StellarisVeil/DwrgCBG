// keepalive.js — 后台守护：不依赖标签页存活
// 背景：藏宝阁页面是 Vue 客户端渲染，Chrome 的 Memory Saver 会把长时间在后台的标签页
// 冻结甚至丢弃（用户早上看到白页），监控随之中断。这里用 chrome.alarms 做兜底：
//   1) 定期检查标签页是否还活着、页面是否白屏，必要时重新加载并注入脚本；
//   2) 定期检查「最近一次成功查询」距今多久，超时就推送企微报警，让问题暴露而不是静默。

const ALARM_NAME = 'pm-keepalive';
const ALARM_PERIOD_MIN = 5;      // 每 5 分钟巡检一次
const STALE_MIN = 60;            // 超过 60 分钟没有成功查询 → 认为监控已停摆

const MONITOR_HOST = 'id5.cbg.163.com';

function matchPattern(pattern, url) {
  const p = (pattern || '').trim();
  if (!p) return false;
  try {
    const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (re.test(url)) return true;
  } catch (e) { /* ignore */ }
  return false;
}

// 页面是否“白屏/失败”：正文几乎为空
async function pageLooksBroken(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const text = (document.body ? document.body.innerText : '').trim();
        const cards = document.querySelectorAll(sel).length;
        return {
          textLen: text.length,
          cards,
          title: document.title,
          ready: document.readyState
        };
      },
      args: ['.product-item.product-item-cards']
    });
    if (!result) return { broken: true, reason: '无法读取页面' };
    const { textLen, cards, ready } = result;
    // 有卡片 → 正常
    if (cards > 0) return { broken: false, cards };
    // 没卡片且正文极短 → 白屏/被回收
    if (textLen < 40) return { broken: true, reason: `页面近乎空白（文本 ${textLen} 字，卡片 0 个）` };
    // 没卡片但有内容 → 可能只是列表空，不算坏
    return { broken: false, cards: 0, note: `无卡片（文本 ${textLen} 字，readyState=${ready}）` };
  } catch (e) {
    return { broken: true, reason: '脚本无法注入：' + ((e && e.message) || e) };
  }
}

async function notifyStale(detail) {
  const { pm_config = {} } = await chrome.storage.local.get('pm_config');
  const webhook = (pm_config.webhook || '').trim();
  const msg = [
    '### ⚠️ 价格监控已停摆',
    `**原因**：${detail}`,
    `**建议**：打开藏宝阁页面，点扩展图标 →「监控当前页面」重新开始`,
    `> 检测时间：${new Date().toLocaleString('zh-CN')}`
  ].join('\n');

  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: msg } })
      });
    } catch (e) { /* 推送失败也要弹本地通知 */ }
  }
  try {
    await chrome.notifications.create('pm-stale-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '价格监控已停摆',
      message: String(detail).slice(0, 180)
    });
  } catch (e) { /* ignore */ }
  await chrome.storage.local.set({ pm_stale_notified_at: Date.now() });
}

// ---------- 时段判断（与 content.js 的 inWindow 保持一致） ----------
// 关键：只有在"应该工作"的时段内停摆才算异常。时段外停摆是正常现象，不报警。
function toNum(v, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

// 是否处于监控时段内（支持跨午夜，如 22 → 8）
function inWorkWindow(cfg, at) {
  if (!cfg || !cfg.timeWindowEnabled) return true;          // 未启用时段控制 = 全天都在时段内
  const d = at ? new Date(at) : new Date();
  const h = d.getHours();
  const s = toNum(cfg.windowStart, null);
  const e = toNum(cfg.windowEnd, null);
  if (s == null || e == null || s === e) return true;        // 配置无效/起止相同 = 视为全天
  if (s < e) return h >= s && h < e;                         // 普通时段
  return h >= s || h < e;                                    // 跨午夜
}

// 距离"进入下一个工作时段"还有多少分钟（用于给刚进入时段留出宽限期）
function minutesIntoWindow(cfg, nowMs) {
  if (!cfg || !cfg.timeWindowEnabled) return Infinity;
  const s = toNum(cfg.windowStart, null);
  if (s == null) return Infinity;
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s, 0, 0, 0);
  // 若当前已过今天的起始时刻，说明是本段内（含跨午夜的"今天起点是昨天"情形）
  let startedAt = start.getTime();
  if (startedAt > nowMs) startedAt = new Date(start.getTime() - 86400000).getTime();
  return (nowMs - startedAt) / 60000;
}

async function tickKeepAlive() {
  const { pm_config: cfg, pm_log: log = [], pm_stale_notified_at: lastWarn } =
    await chrome.storage.local.get(['pm_config', 'pm_log', 'pm_stale_notified_at']);

  if (!cfg || !cfg.enabled) return { skipped: '未启用' };

  // ---- 0) 时段判断：不在工作时段内，停摆属正常，一律不报警 ----
  const nowMs = Date.now();
  const inWindow = inWorkWindow(cfg, nowMs);
  if (!inWindow) {
    return {
      skipped: 'outside-window',
      detail: `当前不在监控时段（${cfg.windowStart}:00-${cfg.windowEnd}:00），停摆属正常`
    };
  }
  // 刚进入时段不久，给页面留出恢复时间，避免"刚上班 1 分钟就报停摆"。
  // 注意：宽限期只对"进时段后还没跑完一轮"的情况生效；若进时段后完全没成功过、
  // 且早已超过一轮时间，那是真异常，不能靠宽限期掩盖。
  const into = minutesIntoWindow(cfg, nowMs);
  const GRACE_MIN = 15;
  const inGraceByTime = into < GRACE_MIN;
  const newestAtStart = (() => {
    const newest0 = Array.isArray(log) && log.length
      ? Math.max(...log.map(x => Number(x && x.ts) || 0)) : 0;
    if (!newest0) return 0;
    return newest0;
  })();
  // 进入本时段之后是否曾有过查询
  const hadQueryInWindow = (() => {
    if (!newestAtStart) return false;
    if (!cfg.timeWindowEnabled) return true;
    const s = toNum(cfg.windowStart, null);
    if (s == null) return true;
    const now = new Date(nowMs);
    let startTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s, 0, 0, 0).getTime();
    if (startTs > nowMs) startTs -= 86400000;
    return newestAtStart >= startTs;
  })();
  const inGrace = inGraceByTime && hadQueryInWindow;

  // ---- 1) 找监控中的标签页 ----
  const tabs = await chrome.tabs.query({});
  const targets = (tabs || []).filter(t => t && t.url && matchPattern(cfg.pattern, t.url));

  if (!targets.length) {
    const detail = '监控页面已被关闭（找不到匹配的标签页）';
    // 刚进入时段、且时段内跑过查询时给宽限（刚开机没来得及开页面）；
    // 若整个时段都没动静且标签页也没了，就是要报警的真异常
    if (inGrace) return { action: 'no-tab-grace', detail, into: Math.round(into) };
    // 30 分钟内不重复报警
    if (!lastWarn || Date.now() - lastWarn > 30 * 60 * 1000) await notifyStale(detail);
    return { action: 'no-tab', detail };
  }

  // ---- 2) 检查页面是否白屏，必要时重新加载 ----
  let recovered = 0;
  for (const t of targets) {
    const st = await pageLooksBroken(t.id);
    if (st.broken) {
      try {
        await chrome.tabs.reload(t.id);
        recovered++;
      } catch (e) { /* ignore */ }
    }
  }

  // ---- 3) 检查是否长时间没有新日志 ----
  const newest = Array.isArray(log) && log.length
    ? Math.max(...log.map(x => Number(x && x.ts) || 0))
    : 0;
  const ageMin = newest ? (Date.now() - newest) / 60000 : Infinity;

  let staleWarned = false;
  if (inGrace) {
    return { checked: targets.length, recovered, ageMin: Math.round(ageMin), staleWarned, graced: true };
  }

  // 停摆阈值跟随配置：整轮周期 + 词数 × 轮内间隔，再留 1.5 倍余量。
  // 固定 60 分钟会在"皮肤多、周期长"时误报，在"周期短"时又太迟钝。
  const staleLimitMin = (() => {
    const n = Math.max(1, (cfg.keywords || []).length);
    const period = Math.max(60, toNum(cfg.baseInterval, 1800)) + Math.max(0, toNum(cfg.jitter, 0));
    const hop = Math.max(15, toNum(cfg.hopMinSec, 20) * 1.5);
    const oneRound = Math.max(period, (n - 1) * hop);
    // 至少给 60 分钟，最多 3 小时，避免极端配置导致长期不报警
    return Math.min(180, Math.max(60, Math.ceil(oneRound / 60 * 2.5)));
  })();

  if (ageMin > staleLimitMin) {
    if (!lastWarn || Date.now() - lastWarn > 30 * 60 * 1000) {
      await notifyStale(
        `已超过 ${staleLimitMin} 分钟没有新的查询记录（当前在监控时段内）`
        + (recovered ? `；已自动重载页面 ${recovered} 个` : '')
      );
      staleWarned = true;
    }
  }

  return { checked: targets.length, recovered, ageMin: Math.round(ageMin), staleLimitMin, staleWarned };
}

// ---------- 每日 0:00 汇总（补货 / 卖出） ----------
const DAILY_ALARM = 'pm-daily-summary';
const DAILY_KEY = 'pm_daily';

// 计算距离下一个本地 0:00 还有多少分钟（chrome.alarms 用 periodInMinutes 只能等间隔，
// 所以每次触发后重算下一次的 when，保证每天都在 0:00 左右）
function minutesUntilMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30, 0);
  return Math.max(1, Math.round((next.getTime() - now.getTime()) / 60000));
}

async function scheduleDailySummary() {
  try { await chrome.alarms.clear(DAILY_ALARM); } catch (e) { /* ignore */ }
  chrome.alarms.create(DAILY_ALARM, { when: Date.now() + minutesUntilMidnight() * 60000 });
}

// 汇总"昨天"的补货/卖出事件（0:00 触发时，要总结的是刚结束的那一天）
async function buildDailySummary() {
  const got = await chrome.storage.local.get([DAILY_KEY, 'pm_config']);
  const cfg = got.pm_config || {};
  const daily = got[DAILY_KEY] || {};

  const y = new Date();
  y.setDate(y.getDate() - 1);
  const day = y.toLocaleDateString('zh-CN');

  const events = (daily.days && daily.days[day]) ? daily.days[day].slice() : [];
  const restocks = events.filter(e => e.kind === 'restock');
  const solds = events.filter(e => e.kind === 'sold');

  // 按皮肤聚合
  const byKw = {};
  events.forEach(e => {
    if (!byKw[e.keyword]) byKw[e.keyword] = { restock: [], sold: [] };
    if (e.kind === 'restock') byKw[e.keyword].restock.push(e);
    else byKw[e.keyword].sold.push(e);
  });

  const fmt = (n) => (Math.round(n * 100) / 100);

  // 标题里带上涉及的皮肤名（最多 3 个），方便一眼知道是哪些皮肤有动静
  const kwNames = [...new Set(events.map(e => e.keyword).filter(Boolean))];
  const nameLabel = kwNames.length
    ? kwNames.slice(0, 3).join('/') + (kwNames.length > 3 ? ` 等${kwNames.length}个` : '')
    : '无变动';
  const lines = [`### 📊 ${nameLabel} · 昨日补货/卖出（${day}）`, ''];

  if (!events.length) {
    lines.push('昨天没有检测到补货或卖出。');
  } else {
    lines.push(`**总计**：补货 ${restocks.length} 次，卖出 ${solds.length} 次`, '');
    Object.keys(byKw).forEach(kw => {
      const g = byKw[kw];
      lines.push(`**${kw}**`);
      if (g.restock.length) {
        const lowest = Math.min(...g.restock.map(e => e.price));
        lines.push(`- 🆕 补货 ${g.restock.length} 次，最低到 ¥${fmt(lowest)}`);
        g.restock.slice(0, 3).forEach(e =>
          lines.push(`  · ${e.time.slice(-8)} ¥${fmt(e.prevPrice)} → ¥${fmt(e.price)}`));
      }
      if (g.sold.length) {
        const highest = Math.max(...g.sold.map(e => e.price));
        lines.push(`- 📤 卖出 ${g.sold.length} 次，最高到 ¥${fmt(highest)}`);
        g.sold.slice(0, 3).forEach(e =>
          lines.push(`  · ${e.time.slice(-8)} ¥${fmt(e.prevPrice)} → ¥${fmt(e.price)}`));
      }
      lines.push('');
    });
  }

  lines.push(`> 汇总时间：${new Date().toLocaleString('zh-CN')}`);
  const content = lines.join('\n');

  const webhook = (cfg.webhook || '').trim();
  if (webhook) {
    try {
      if (typeof postWeCom === 'function') {
        await postWeCom(webhook, content);
      } else {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content } })
        });
      }
    } catch (e) { /* ignore */ }
  }

  // 清理 8 天前的数据
  try {
    const keys = Object.keys(daily.days || {}).sort();
    let changed = false;
    while (keys.length > 8) { delete daily.days[keys.shift()]; changed = true; }
    if (changed) await chrome.storage.local.set({ [DAILY_KEY]: daily });
  } catch (e) { /* ignore */ }

  return { day, restocks: restocks.length, solds: solds.length, content };
}

async function tickDailySummary() {
  const r = await buildDailySummary();
  await scheduleDailySummary();   // 重排下一次 0:00
  return r;
}

chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN, delayInMinutes: 1 });
chrome.alarms.get(DAILY_ALARM).then(a => { if (!a) scheduleDailySummary(); }).catch(() => scheduleDailySummary());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) { tickKeepAlive().catch(() => {}); return; }
  if (alarm.name === DAILY_ALARM) { tickDailySummary().catch(() => {}); return; }
});

// 浏览器启动/扩展更新后立刻巡检一次；若错过了 0:00，启动时补发
chrome.runtime.onStartup.addListener(() => {
  tickKeepAlive().catch(() => {});
  chrome.alarms.get(DAILY_ALARM).then(a => { if (!a) scheduleDailySummary(); }).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  tickKeepAlive().catch(() => {});
  scheduleDailySummary();
});
