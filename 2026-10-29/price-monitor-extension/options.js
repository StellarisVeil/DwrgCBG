// options.js — 配置页逻辑：读写配置、解析皮肤/关键词清单、CSV 导入、测试推送、清空记录、模式切换
// 注入由 manifest 的 content_scripts 声明式完成，本页只写配置。
const $ = (id) => document.getElementById(id);

const DEFAULT_SEARCH_TPL = 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC';
const DEFAULT_PATTERN = 'https://id5.cbg.163.com/*';
const DEFAULT_ITEM_SELECTOR = '.product-item.product-item-cards';
const DEFAULT_PRICE_SELECTOR = '.row-hd .price';

// 预置真实皮肤清单（mr.z 提供，2026-10-29）：皮肤名,参考价
const DEFAULT_SKINS =
`于此岸赴宴,300
蜃景,1000
赤宴,1200`;

// ---------- 工具 ----------
function toNum(v, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? n : dflt;
}
function setStatus(msg, ok) {
  const s = $('status');
  s.textContent = msg;
  s.style.color = ok ? '#0a0' : '#c00';
}
// 必填校验：把缺项的输入框和标签标红，输入时自动消红
function setInvalid(id, bad) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('invalid', bad);
  const row = el.closest('.row');
  const lbl = row && row.querySelector('label');
  if (lbl) lbl.classList.toggle('invalid-label', bad);
}
const INVALID_IDS = ['pattern', 'keywords', 'skins', 'webhook', 'baseInterval', 'jitter', 'hopMinSec', 'hopMaxSec',
  'threshold', 'searchPriceThreshold', 'windowStart', 'windowEnd', 'searchUrlTemplate'];
function clearInvalid() { INVALID_IDS.forEach(id => setInvalid(id, false)); }

// 统一的「名称,数值」解析：兼容中英文逗号/制表符/分号，跳过表头与空行
function parsePairs(text) {
  const pairs = []; const bad = []; let skipped = 0;
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const t = line.replace(/^\uFEFF/, '').trim();
    if (!t) return;
    const m = t.match(/^(.*?)\s*[,，\t;；]\s*(.*)$/);
    if (!m) { bad.push(`第 ${i + 1} 行缺少逗号分隔：${t}`); return; }
    const name = m[1].trim().replace(/^["']|["']$/g, '');
    const rawVal = m[2].trim().replace(/^["']|["']$/g, '');
    if (!name) { bad.push(`第 ${i + 1} 行名称为空`); return; }
    // 表头行（名称,价格 / name,price）
    if (/^(名称|皮肤名|关键词|name|keyword|skin)$/i.test(name) && toNum(rawVal, null) == null) { skipped++; return; }
    if (rawVal === '') { pairs.push({ name, value: null }); return; } // 只写名称 → 用全局默认
    const v = toNum(rawVal, null);
    if (v == null || v < 0) { bad.push(`第 ${i + 1} 行数值无效：${rawVal}`); return; }
    pairs.push({ name, value: v });
  });
  return { pairs, bad, skipped };
}

// 节奏预览：把当前设置翻译成“实际会怎么跑”，皮肤变多时能直观看到一轮多久
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' 小时' + (r ? ' ' + r + ' 分钟' : '');
}
function renderPace() {
  const el = $('pacePreview');
  if (!el) return;

  if ($('mode').value !== 'search') {
    el.innerHTML = '<b>皮肤套餐模式</b>：按整页刷新节奏运行，轮内间隔不适用。';
    return;
  }

  const kwCount = $('keywords').value.split(/\r?\n/).map(t => t.trim()).filter(Boolean).length;
  if (!kwCount) { el.textContent = '请先填写关键词，这里会显示实际运行节奏。'; return; }

  const base = toNum($('baseInterval').value, 1800);
  const jit = toNum($('jitter').value, 300);
  const minHop = Math.max(15, toNum($('hopMinSec').value, 20));
  const maxHop = Math.max(minHop, toNum($('hopMaxSec').value, 45));

  const periodSec = base + jit / 2;
  const budget = periodSec / kwCount;
  let perHop;
  if (budget >= maxHop) perHop = (minHop + maxHop) / 2;
  else if (budget <= minHop) perHop = minHop;
  else perHop = (minHop + budget) / 2;

  const scanSec = (kwCount - 1) * perHop;
  // 留 2% 余量，避免"33 分钟 vs 33 分钟"这种显示取整误差触发误警告
  const over = scanSec > periodSec * 1.02;

  el.innerHTML = [
    '<b>当前节奏预览</b>（共 ' + kwCount + ' 个关键词）',
    '· 轮内相邻两个词之间：约 <b>' + perHop.toFixed(0) + ' 秒</b>' + (budget < maxHop ? '（已按关键词数量自动收紧）' : ''),
    '· 一整轮扫完约需：<b>' + fmtDur(scanSec * 1000) + '</b>',
    '· 每轮之间间隔：约 <b>' + fmtDur(periodSec * 1000) + '</b>',
    '· 平均每个词多久查一次：约 <b>' + fmtDur((periodSec / kwCount) * 1000) + '</b>',
    over
      ? '<span style="color:#c00">⚠ 关键词太多，一轮本身就要 ' + fmtDur(scanSec * 1000) + '，超过你设的 ' + fmtDur(periodSec * 1000) + '。建议调大整轮间隔，或减少关键词。</span>'
      : '<span style="color:#0a7d24">✓ 一轮可以在设定周期内跑完。</span>'
  ].join('<br>');
}

function applyModeVisibility() {
  const isSearch = $('mode').value === 'search';
  $('searchSection').style.display = isSearch ? '' : 'none';
  $('bundleSection').style.display = isSearch ? 'none' : '';
}

// ---------- 保存 ----------
async function save() {
  clearInvalid();
  const mode = $('mode').value;
  const missing = [];
  const errors = [];

  const pattern = $('pattern').value.trim();
  const webhook = $('webhook').value.trim();
  const enabled = $('enabled').checked;

  // 数值项统一校验，避免把 NaN / null 写进配置导致运行时静默失效
  const baseInterval = toNum($('baseInterval').value, null);
  if (baseInterval == null || baseInterval < 60) {
    setInvalid('baseInterval', true); errors.push('整轮间隔需 ≥ 60 秒');
  }
  const jitter = toNum($('jitter').value, null);
  if (jitter == null || jitter < 0) {
    setInvalid('jitter', true); errors.push('随机抖动需为 ≥ 0 的数字');
  }

  const hopMinSec = toNum($('hopMinSec').value, null);
  const hopMaxSec = toNum($('hopMaxSec').value, null);
  if (hopMinSec == null || hopMinSec < 5) {
    setInvalid('hopMinSec', true); errors.push('轮内最小间隔需 ≥ 5 秒');
  }
  if (hopMaxSec == null || hopMaxSec < 5) {
    setInvalid('hopMaxSec', true); errors.push('轮内最大间隔需 ≥ 5 秒');
  }
  if (hopMinSec != null && hopMaxSec != null && hopMaxSec < hopMinSec) {
    setInvalid('hopMaxSec', true); errors.push('轮内最大间隔不能小于最小间隔');
  }

  const twEnabled = $('timeWindowEnabled').checked;
  let windowStart = toNum($('windowStart').value, 0);
  let windowEnd = toNum($('windowEnd').value, 0);
  if (twEnabled) {
    for (const [id, v, label] of [['windowStart', windowStart, '时段起'], ['windowEnd', windowEnd, '时段止']]) {
      if (!Number.isInteger(v) || v < 0 || v > 23) {
        setInvalid(id, true); errors.push(`${label}需为 0-23 的整数`);
      }
    }
  }

  if (!pattern) {
    setInvalid('pattern', true); missing.push('监控页面地址');
  } else if (!/^(\*|[a-z][a-z0-9+.-]*):\/\//i.test(pattern)) {
    setInvalid('pattern', true);
    errors.push('监控页面地址需以 https:// 开头，例如 ' + DEFAULT_PATTERN);
  } else if (!pattern.includes('*') && !pattern.includes(':')) {
    setInvalid('pattern', true); errors.push('监控页面地址格式不正确');
  }

  if (enabled && !webhook) {
    setInvalid('webhook', true); missing.push('企业微信 Webhook（已启用监控，必填）');
  }
  if (webhook && !/^https?:\/\/\S+$/i.test(webhook)) {
    setInvalid('webhook', true); errors.push('Webhook 需为 http(s):// 开头的完整地址');
  }

  // 模式相关必填 + 数值
  let keywords = [];
  let skins = [];
  let searchPriceThreshold = null;
  let threshold = null;

  if (mode === 'search') {
    const parsed = parsePairs($('keywords').value);
    keywords = parsed.pairs.map(p => (p.value == null ? { name: p.name } : { name: p.name, target: p.value }));
    if (!keywords.length) { setInvalid('keywords', true); missing.push('搜索关键词'); }
    if (parsed.bad.length) errors.push('关键词：' + parsed.bad.join('；'));

    searchPriceThreshold = toNum($('searchPriceThreshold').value, null);
    if (searchPriceThreshold == null || searchPriceThreshold < 0) {
      setInvalid('searchPriceThreshold', true); errors.push('「最低价目标」需为 ≥ 0 的数字');
    }
    const tpl = $('searchUrlTemplate').value.trim() || DEFAULT_SEARCH_TPL;
    if (!/\{keyword\}/i.test(tpl)) {
      setInvalid('searchUrlTemplate', true); errors.push('搜索 URL 模板缺少 {keyword} 占位符');
    }
    $('searchUrlTemplate').value = tpl;
  } else {
    const parsed = parsePairs($('skins').value);
    skins = parsed.pairs.map(p => ({ name: p.name, price: p.value == null ? 0 : p.value }));
    if (!skins.length) { setInvalid('skins', true); missing.push('目标皮肤清单'); }
    if (parsed.bad.length) errors.push('皮肤清单：' + parsed.bad.join('；'));

    threshold = toNum($('threshold').value, null);
    if (threshold == null || threshold < 0) {
      setInvalid('threshold', true); errors.push('「合计参考价阈值」需为 ≥ 0 的数字');
    }
  }

  if (missing.length) { setStatus('以下必填项未填（已标红）：' + missing.join('、'), false); return; }
  if (errors.length) { setStatus('保存失败：' + errors.join('；'), false); return; }

  const cfg = {
    enabled,
    pattern,
    mode,
    baseInterval: Math.round(baseInterval),
    jitter: Math.round(jitter),
    reload: $('reload').checked,
    timeWindowEnabled: twEnabled,
    windowStart: Math.round(windowStart),
    windowEnd: Math.round(windowEnd),
    itemSelector: $('itemSelector').value.trim() || DEFAULT_ITEM_SELECTOR,
    linkSelector: $('linkSelector').value.trim(),
    webhook,
    skinNameSelector: '',
    titleSelector: '',
    accountPriceSelector: '',
    skins: [],
    keywords: [],
    threshold: 0,
    searchUrlTemplate: '',
    searchPriceThreshold: 0,
    searchPriceSelector: ''
  };

  const prev = (await chrome.storage.local.get('pm_config')).pm_config || {};

  if (mode === 'search') {
    cfg.keywords = keywords;
    cfg.searchUrlTemplate = $('searchUrlTemplate').value.trim();
    cfg.searchPriceThreshold = searchPriceThreshold;
    cfg.searchPriceSelector = $('searchPriceSelector').value.trim() || DEFAULT_PRICE_SELECTOR;
    // 关键词或模板变了就换一个 passId，让首轮快扫重新走一遍（否则旧进度会被复用）
    const kwSig = JSON.stringify([keywords, cfg.searchUrlTemplate]);
    const prevSig = prev && prev.__kwSig;
    cfg.searchPassId = (prev && prevSig === kwSig && prev.searchPassId)
      ? prev.searchPassId
      : ('p' + Date.now());
    cfg.__kwSig = kwSig;
    cfg.hopMinSec = Math.round(hopMinSec);
    cfg.hopMaxSec = Math.round(hopMaxSec);
    delete cfg.searchWaitFirst;
  } else {
    cfg.skins = skins;
    cfg.threshold = threshold;
    cfg.skinNameSelector = $('skinNameSelector').value.trim();
    cfg.titleSelector = $('titleSelector').value.trim();
    cfg.accountPriceSelector = $('accountPriceSelector').value.trim();
  }

  // 启用令牌：只有“从停用变成启用”或“关键词/模板改了”才换新，
  // 让监控立刻重新按顺序搜一遍，而不是沿用旧的首轮进度干等间隔。
  const turningOn = enabled && !prev.enabled;
  const kwChanged = mode === 'search' && cfg.searchPassId !== (prev.searchPassId || '');
  cfg.runToken = (turningOn || kwChanged || !prev.runToken)
    ? ('r' + Date.now())
    : prev.runToken;

  await chrome.storage.local.set({ pm_config: cfg });
  kwSavedSig = JSON.stringify(keywords);   // 整份保存后同步，避免即时保存重复写同一份关键词

  // 保存即启用：已打开的藏宝阁页可能还没注入脚本（onChanged 监听不到），
  // 这里主动把它导航到第一个关键词，保证“勾选启用 + 保存”后马上开始搜索。
  let navigated = false;
  if (enabled && mode === 'search') {
    const kws = keywords.map(k => k && k.name).filter(Boolean);
    const tpl = cfg.searchUrlTemplate || DEFAULT_SEARCH_TPL;
    if (kws.length && /\{keyword\}/i.test(tpl)) {
      const targetUrl = tpl.replace(/\{keyword\}/gi, encodeURIComponent(kws[0]));
      // 从停用变启用、或关键词有变化时才强制跳转，避免每次保存都打断用户
      if (turningOn || kwChanged) {
        try {
          // 不用 tabs 权限：chrome.tabs.query({url}) 需要 "tabs"，改为对全部标签页自行过滤
          const all = await chrome.tabs.query({});
          const host = (() => { try { return new URL(pattern.replace(/\*/g, '')).hostname; } catch (e) { return ''; } })();
          const pick = (all || []).find(t => {
            if (!t || t.id == null || !t.url) return false;
            try { return host ? new URL(t.url).hostname === host : false; } catch (e) { return false; }
          });
          if (pick) {
            await chrome.tabs.update(pick.id, { url: targetUrl });
            navigated = true;
          }
        } catch (e) { /* 查询失败就不跳，交给页面自身逻辑 */ }
      }
    }
  }

  // 配置变更：已打开的监控页需要刷新才会按新选择器/模式运行
  const changed = JSON.stringify(prev) !== JSON.stringify(cfg);
  const modeName = mode === 'search' ? '搜索比价' : '皮肤套餐';
  let msg = `已保存（${enabled ? '已启用监控' : '未启用监控'}，${modeName}）`;
  if (enabled) {
    if (twEnabled) msg += `；时段 ${cfg.windowStart}-${cfg.windowEnd} 点`;
    msg += `；每轮 ${cfg.baseInterval}+${cfg.jitter}s 随机`;
    if (mode === 'search') msg += `，轮内每个词间隔 ${cfg.hopMinSec}~${cfg.hopMaxSec}s`;
  }
  if (navigated) msg += '。已跳转到第一个关键词开始搜索。';
  else msg += changed
    ? '。已打开的监控页会自动刷新以应用新配置。'
    : '。配置无变化。';
  setStatus(msg, true);
}

// ---------- 关键词即时生效 ----------
// 只写 pm_config.keywords 一个字段（与已存配置合并），不动 webhook / 皮肤清单 / 去重表。
// 停止输入 KW_DEBOUNCE_MS 后自动落盘；失焦立即落盘，不等防抖。
const KW_DEBOUNCE_MS = 800;
let kwTimer = null;
let kwSavedSig = null;    // 上次落盘的 keywords 序列化值，避免无变化时重复写
let kwSaving = null;      // 串行化写入，避免防抖与失焦两次落盘交叉

function collectKeywords() {
  const parsed = parsePairs($('keywords').value);
  return {
    keywords: parsed.pairs.map(p => (p.value == null ? { name: p.name } : { name: p.name, target: p.value })),
    bad: parsed.bad,
    hasInput: String($('keywords').value || '').split(/\r?\n/).some(l => l.trim())
  };
}

async function persistKeywords() {
  if (kwSaving) return kwSaving;
  kwSaving = (async () => {
    if ($('mode').value !== 'search') return;
    const { keywords, bad, hasInput } = collectKeywords();
    setInvalid('keywords', bad.length > 0);
    const { pm_config } = await chrome.storage.local.get('pm_config');
    // 首次使用还没保存过任何配置：不凭关键词创建半份配置，提示先完成一次初始化
    if (!pm_config) {
      setStatus('还没有已保存的配置：请先点一次「保存并应用」完成初始化（之后关键词改动会自动生效）', false);
      return;
    }
    // 有输入但一行都解析不出：不落盘，避免把用户整段输入静默清空
    if (hasInput && !keywords.length) {
      const cur = Array.isArray(pm_config.keywords) ? pm_config.keywords.length : 0;
      setStatus('关键词未写入：' + (bad.join('；') || '没有可用行') + `（仍沿用已生效的 ${cur} 条）`, false);
      return;
    }
    const sig = JSON.stringify(keywords);
    const badNote = bad.length ? `；已跳过 ${bad.length} 行：` + bad.slice(0, 2).join('；') : '';
    if (sig === kwSavedSig) {
      if (bad.length) setStatus('关键词有格式问题未写入：' + bad.slice(0, 2).join('；'), false);
      return;
    }
    await chrome.storage.local.set({ pm_config: { ...pm_config, keywords } });   // 只覆盖 keywords
    kwSavedSig = sig;
    if (!keywords.length) {
      setStatus('关键词已清空并即时生效：搜索已停止（重新填写后会自动恢复）' + badNote, !bad.length);
    } else {
      setStatus(`关键词已即时生效（${keywords.length} 条），无需点「保存并应用」` + badNote, !bad.length);
    }
  })().catch(e => setStatus('关键词自动保存失败：' + ((e && e.message) || e), false))
    .finally(() => { kwSaving = null; });
  return kwSaving;
}

function scheduleKeywordPersist() {
  if (kwTimer) clearTimeout(kwTimer);
  kwTimer = setTimeout(() => { kwTimer = null; persistKeywords(); }, KW_DEBOUNCE_MS);
}

// ---------- 载入 ----------
function fillDefaults() {
  $('enabled').checked = false;
  $('pattern').value = DEFAULT_PATTERN;
  $('mode').value = 'search';
  $('baseInterval').value = 1800;
  $('jitter').value = 300;
  $('reload').checked = true;
  $('timeWindowEnabled').checked = false;
  $('windowStart').value = 9;
  $('windowEnd').value = 23;
  $('itemSelector').value = DEFAULT_ITEM_SELECTOR;
  $('linkSelector').value = '';
  $('skinNameSelector').value = '.card-item .name-wrap .name';
  $('titleSelector').value = '.main-title';
  $('accountPriceSelector').value = DEFAULT_PRICE_SELECTOR;
  $('skins').value = DEFAULT_SKINS;
  $('threshold').value = 2000;
  $('keywords').value = DEFAULT_SKINS;
  $('searchUrlTemplate').value = DEFAULT_SEARCH_TPL;
  $('searchPriceThreshold').value = 50;
  $('searchPriceSelector').value = DEFAULT_PRICE_SELECTOR;
  $('hopMinSec').value = 20;
  $('hopMaxSec').value = 45;
  $('webhook').value = '';
}

async function load() {
  const { pm_config } = await chrome.storage.local.get('pm_config');
  applyModeVisibility();
  if (!pm_config) { fillDefaults(); applyModeVisibility(); kwSavedSig = JSON.stringify(collectKeywords().keywords); return; }

  const c = pm_config;
  $('enabled').checked = !!c.enabled;
  $('pattern').value = c.pattern || DEFAULT_PATTERN;
  $('mode').value = c.mode === 'bundle' ? 'bundle' : 'search';
  $('baseInterval').value = toNum(c.baseInterval != null ? c.baseInterval : c.intervalSec, 1800);
  $('jitter').value = toNum(c.jitter, 300);
  $('reload').checked = c.reload !== false;
  $('timeWindowEnabled').checked = !!c.timeWindowEnabled;
  $('windowStart').value = toNum(c.windowStart, 9);
  $('windowEnd').value = toNum(c.windowEnd, 23);
  $('itemSelector').value = c.itemSelector || DEFAULT_ITEM_SELECTOR;
  $('linkSelector').value = c.linkSelector || '';
  $('skinNameSelector').value = c.skinNameSelector || '.card-item .name-wrap .name';
  $('titleSelector').value = c.titleSelector || '.main-title';
  $('accountPriceSelector').value = c.accountPriceSelector || DEFAULT_PRICE_SELECTOR;
  $('skins').value = (c.skins || []).map(s => `${s.name},${s.price}`).join('\n') || DEFAULT_SKINS;
  $('threshold').value = toNum(c.threshold, 2000);
  $('keywords').value = (c.keywords || [])
    .map(k => (k && typeof k === 'object')
      ? (k.target != null ? `${k.name},${k.target}` : k.name)
      : k)
    .join('\n') || DEFAULT_SKINS;
  $('searchUrlTemplate').value = c.searchUrlTemplate || DEFAULT_SEARCH_TPL;
  $('searchPriceThreshold').value = toNum(c.searchPriceThreshold, 50);
  $('searchPriceSelector').value = c.searchPriceSelector || DEFAULT_PRICE_SELECTOR;
  $('hopMinSec').value = toNum(c.hopMinSec, 20);
  $('hopMaxSec').value = toNum(c.hopMaxSec, 45);
  $('webhook').value = c.webhook || '';
  applyModeVisibility();
  kwSavedSig = JSON.stringify(collectKeywords().keywords);
}

// ---------- 事件 ----------
$('mode').addEventListener('change', applyModeVisibility);
// 关键词：停止输入 800ms 后落盘；失焦立即落盘（不必再点「保存并应用」）
$('keywords').addEventListener('input', scheduleKeywordPersist);
$('keywords').addEventListener('blur', () => {
  if (kwTimer) { clearTimeout(kwTimer); kwTimer = null; }
  persistKeywords();
});
$('save').onclick = () => { save().catch(e => setStatus('保存出错：' + ((e && e.message) || e), false)); };

$('clear').onclick = async () => {
  // 同时清掉“已提醒过的最低价”，否则清空后仍不会重新提醒
  await chrome.storage.local.set({ pm_notified: {}, pm_best: {} });
  setStatus('已清空已通知记录（下次扫描会重新提醒）', true);
};

$('test').onclick = async () => {
  const webhook = $('webhook').value.trim();
  if (!webhook) { setInvalid('webhook', true); setStatus('请先填写 Webhook 地址', false); return; }
  setStatus('正在发送测试消息…', true);
  try {
    // 用当前输入框的值测试，但不覆盖已保存配置：临时借用，测完还原
    const { pm_config: saved } = await chrome.storage.local.get('pm_config');
    const backup = saved && saved.webhook;
    await chrome.storage.local.set({ pm_config: { ...(saved || {}), webhook } });
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'PM_TEST' });
    } finally {
      if (saved) {
        await chrome.storage.local.set({ pm_config: { ...saved, webhook: backup == null ? saved.webhook : backup } });
      } else {
        await chrome.storage.local.remove('pm_config');
      }
    }
    if (res && res.ok) setStatus('测试消息已发送成功，请查看企业微信', true);
    else setStatus('测试消息发送失败：' + ((res && res.error) || '无响应'), false);
  } catch (e) {
    setStatus('测试消息发送失败：' + ((e && e.message) || e), false);
  }
};

// ---------- 查询记录 ----------
const LOG_KEY = 'pm_log';
const LOG_RENDER_LIMIT = 2000;   // 表格最多渲染条数，避免上万条记录卡死配置页；完整记录可导出 CSV

function fmtMoney(v) {
  return (v == null || v === '') ? '—' : ('¥' + v);
}

// 风控暂停提示：被要求验证后这里会显示黄色横幅，告诉你发生了什么、怎么恢复
async function renderPause() {
  const el = $('pauseBanner');
  if (!el) return;
  try {
    const { pm_paused_reason: p } = await chrome.storage.local.get('pm_paused_reason');
    if (!p) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = [
      '<b>⚠ 监控已因风控暂停</b>（' + (p.time || '') + '）',
      '原因：' + (p.reason || '页面要求验证'),
      '',
      '<b>恢复步骤</b>：',
      '1. 点下方链接打开页面，手动完成验证（滑块/验证码）',
      '2. 验证通过后，点浏览器工具栏的扩展图标 →「监控当前页面」',
      '',
      '<a href="' + (p.url || '#') + '" target="_blank" rel="noopener">打开当时的页面</a>',
      ' · <a href="#" id="pauseClear">我已处理，清除提示</a>'
    ].join('<br>');
    const btn = $('pauseClear');
    if (btn) {
      btn.onclick = async (e) => {
        e.preventDefault();
        await chrome.storage.local.remove('pm_paused_reason');
        renderPause();
      };
    }
  } catch (e) { el.style.display = 'none'; }
}

// 清洗链接：去掉 refer_sn 等一次性会话参数，避免“点了打不开”
const EQUIP_RE_UI = /https?:\/\/[^\s>"'<>()]*?\/cgi\/mweb\/equip\/[^\s>"'<>()?#&]+/i;
function cleanLink(u) {
  if (!u) return '';
  const s = String(u).trim();
  const m = s.match(EQUIP_RE_UI);
  if (m) return m[0];
  try {
    const url = new URL(s);
    ['refer_sn', 'refer_page', 'traceid', 'from', 'spm'].forEach(k => url.searchParams.delete(k));
    return url.href;
  } catch (e) { return s; }
}

function renderLogs() {
  const tbody = document.querySelector('#logTable tbody');
  const summary = $('logSummary');
  if (!tbody) return;

  chrome.storage.local.get(LOG_KEY).then((got) => {
    let list = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
    const onlyHit = $('logOnlyHit') && $('logOnlyHit').checked;
    const onlyEvent = $('logOnlyEvent') && $('logOnlyEvent').checked;
    const total = list.length;
    const hitList = list.slice();
    const hitCount = list.filter(x => x && x.hit).length;
    if (onlyHit) list = list.filter(x => x && x.hit);
    if (onlyEvent) list = list.filter(x => x && (x.event === 'restock' || x.event === 'sold'));

    if (!total) {
      summary.textContent = '还没有记录。启用监控并打开藏宝阁页面后，这里会出现每次查询的明细。';
    } else {
      const evtCount = hitList.filter(x => x && (x.event === 'restock' || x.event === 'sold')).length;
      const restockCount = hitList.filter(x => x && x.event === 'restock').length;
      const soldCount = hitList.filter(x => x && x.event === 'sold').length;
      summary.textContent = `共 ${total} 条记录，命中 ${hitCount} 条；补货 ${restockCount} 次、卖出 ${soldCount} 次。`
        + (onlyHit ? `当前只显示命中（${list.length} 条）。` : '')
        + (onlyEvent ? `当前只显示变动（${list.length} 条）。` : '');
    }

    // 记录量大时只渲染最近一部分，避免配置页卡死；导出 CSV 不受影响
    if (list.length > LOG_RENDER_LIMIT) {
      list = list.slice(0, LOG_RENDER_LIMIT);
      summary.textContent += `（表格最多显示最近 ${LOG_RENDER_LIMIT} 条，完整记录请导出 CSV）`;
    }

    tbody.innerHTML = '';
    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.style.padding = '12px 6px';
      td.style.color = '#888';
      td.textContent = total ? '没有符合条件的记录' : '暂无数据';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    list.forEach((x) => {
      const tr = document.createElement('tr');
      tr.style.borderTop = '1px solid #eee';

      const kindLabel = x.kind === 'bundle' ? '套餐'
        : x.kind === 'restock' ? '🆕 补货'
          : x.kind === 'sold' ? '📤 卖出'
            : x.kind === 'system' ? '系统' : '搜索';

      const cells = [
        { text: x.time || new Date(x.ts || 0).toLocaleString('zh-CN'), align: 'left' },
        { text: kindLabel, align: 'left' },
        { text: x.keyword || '', align: 'left' },
        { text: fmtMoney(x.price), align: 'right' },
        { text: fmtMoney(x.target), align: 'right' },
        {
          text: x.event
            ? (x.event === 'restock' ? '🆕 补货 ' : '📤 卖出 ')
              + fmtMoney(x.prevPrice) + ' → ' + fmtMoney(x.price)
            : (x.result || (x.hit ? '命中' : '未命中')),
          align: 'left'
        }
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.style.padding = '6px';
        td.style.textAlign = c.align;
        td.textContent = c.text;
        if (i === 5 && x.hit) td.style.color = '#0a7d24';
        if (i === 5 && !x.hit) td.style.color = '#666';
        if (i === 5 && x.event === 'restock') { td.style.color = '#0a7d24'; td.style.fontWeight = '600'; }
        if (i === 5 && x.event === 'sold') { td.style.color = '#c2570a'; td.style.fontWeight = '600'; }
        tr.appendChild(td);
      });

      // 商品列：可直接点击打开。优先商品详情页（永久有效），否则退回搜索页
      const linkTd = document.createElement('td');
      linkTd.style.padding = '6px';
      linkTd.style.whiteSpace = 'nowrap';
      const itemUrl = cleanLink(x.link);
      const pageUrl = cleanLink(x.url);
      if (itemUrl) {
        const a = document.createElement('a');
        a.href = itemUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '打开商品';
        a.style.color = '#2563eb';
        a.style.textDecoration = 'none';
        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });
        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });
        linkTd.appendChild(a);
      } else if (pageUrl) {
        const a = document.createElement('a');
        a.href = pageUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '打开列表';
        a.style.color = '#8a8f99';
        a.title = '这条没抓到商品详情页，只能打开搜索结果';
        linkTd.appendChild(a);
      } else {
        linkTd.textContent = '—';
        linkTd.style.color = '#aaa';
      }
      tr.appendChild(linkTd);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }).catch((e) => {
    if (summary) summary.textContent = '读取记录失败：' + ((e && e.message) || e);
  });
}

function csvCell(v) {
  const s = (v == null) ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function logsToCsv(list) {
  const head = ['时间', '类型', '关键词/账号', '底价', '目标价', '是否命中', '结果',
    '变动事件', '变动前价', '价差', '上次提醒价', '商品数', '商品链接', '页面地址'];
  const rows = list.map(x => [
    x.time || new Date(x.ts || 0).toLocaleString('zh-CN'),
    x.kind === 'bundle' ? '套餐'
      : x.kind === 'restock' ? '补货'
        : x.kind === 'sold' ? '卖出'
          : x.kind === 'system' ? '系统' : '搜索',
    x.keyword || '',
    x.price == null ? '' : x.price,
    x.target == null ? '' : x.target,
    x.hit ? '是' : '否',
    x.result || '',
    x.event === 'restock' ? '补货' : x.event === 'sold' ? '卖出' : '',
    x.prevPrice == null ? '' : x.prevPrice,
    x.delta == null ? '' : x.delta,
    x.prevLow == null ? '' : x.prevLow,
    x.cards == null ? '' : x.cards,
    x.link || '',
    x.url || ''
  ]);
  // 加 BOM，Excel 打开中文不乱码
  return '\uFEFF' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

function downloadCsv(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

if ($('logRefresh')) $('logRefresh').onclick = renderLogs;
if ($('logOnlyHit')) $('logOnlyHit').addEventListener('change', renderLogs);
if ($('logOnlyEvent')) $('logOnlyEvent').addEventListener('change', renderLogs);
if ($('logClear')) {
  $('logClear').onclick = async () => {
    await chrome.storage.local.set({ [LOG_KEY]: [] });
    renderLogs();
    setStatus('已清空查询记录', true);
  };
}
if ($('logExport')) {
  $('logExport').onclick = async () => {
    const got = await chrome.storage.local.get(LOG_KEY);
    const list = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
    if (!list.length) { setStatus('还没有可导出的查询记录', false); return; }
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    downloadCsv(`price-monitor-log-${stamp}.csv`, logsToCsv(list));
    setStatus(`已导出 ${list.length} 条记录到下载目录（可直接移动到你想要的项目文件夹）`, true);
  };
}

// CSV 导入：按当前模式导入到对应框（自动识别 GBK 编码的 Excel 导出）
function readAsText(file, encoding) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取失败'));
    reader.readAsText(file, encoding);
  });
}
$('csvFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const targetId = $('mode').value === 'search' ? 'keywords' : 'skins';
  const targetName = targetId === 'keywords' ? '关键词' : '皮肤清单';
  try {
    let text = await readAsText(file, 'utf-8');
    // UTF-8 解码出现替换字符 → 视为 GBK（Excel 中文默认导出编码）
    if (text.includes('\uFFFD')) {
      try { text = await readAsText(file, 'gbk'); } catch (err) { /* 保留 utf-8 结果 */ }
    }
    const { pairs, bad, skipped } = parsePairs(text);
    if (!pairs.length) {
      setStatus('CSV 未解析出有效行（每行格式：名称,数值）' + (bad.length ? '；' + bad.slice(0, 3).join('；') : ''), false);
      return;
    }
    $(targetId).value = pairs.map(p => (p.value == null ? p.name : `${p.name},${p.value}`)).join('\n');
    let msg = `已读取 ${pairs.length} 行到「${targetName}」，记得点「保存并应用」`;
    if (skipped) msg += `；跳过 ${skipped} 行（表头/空行）`;
    if (bad.length) msg += `；${bad.length} 行无法解析：${bad.slice(0, 2).join('；')}`;
    setStatus(msg, bad.length ? false : true);
    setInvalid(targetId, false);
  } catch (err) {
    setStatus('CSV 读取失败：' + ((err && err.message) || err), false);
  } finally {
    e.target.value = ''; // 允许重复选择同一文件
  }
});

// 编辑必填项时自动消红
INVALID_IDS.forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('input', () => setInvalid(id, false));
});

// 节奏预览实时刷新
['keywords', 'baseInterval', 'jitter', 'hopMinSec', 'hopMaxSec', 'mode'].forEach(id => {
  const el = $(id);
  if (el) {
    el.addEventListener('input', renderPace);
    el.addEventListener('change', renderPace);
  }
});

load()
  .catch(e => setStatus('载入配置失败：' + ((e && e.message) || e), false))
  .finally(() => { renderLogs(); renderPace(); renderPause(); });
