// popup.js — 快捷操作：一键对当前页面启用监控、打开配置
const $ = (id) => document.getElementById(id);
const SCRIPT_ID = 'pm-monitor-dynamic';
const MANIFEST_HOST = 'id5.cbg.163.com';
const DEFAULT_SEARCH_TPL = 'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC';

const setStatus = (msg, ok) => {
  const s = $('status');
  s.textContent = msg;
  s.style.color = ok ? '#0a0' : '#c00';
};

// 该域名是否已被 manifest 声明式注入覆盖（覆盖时无需动态注册，否则会注入两次）
function coveredByManifest(url) {
  try { return new URL(url).hostname === MANIFEST_HOST; } catch (e) { return false; }
}

// 动态注册：脚本已存在则 update，不存在则 register（两个 API 都是数组入参）
async function ensureDynamicScript(pattern) {
  const script = { id: SCRIPT_ID, matches: [pattern], js: ['content.js'], runAt: 'document_idle' };
  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }); }
  catch (e) { existing = []; }
  if (existing && existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}
async function removeDynamicScript() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch (e) { /* 不存在时忽略 */ }
}

async function refreshState() {
  const { pm_config: c } = await chrome.storage.local.get('pm_config');
  const modeName = c && c.mode === 'bundle' ? '皮肤套餐' : '搜索比价';
  const stateEl = $('state');
  if (stateEl) {
    stateEl.textContent = c
      ? `当前：${c.enabled ? '监控中' : '已暂停'} · ${modeName} · 间隔 ${(c.baseInterval != null ? c.baseInterval : 60)}+${c.jitter != null ? c.jitter : 0}s`
      : '尚未配置';
  }
  const en = $('enabled');
  if (en) en.checked = !!(c && c.enabled);
}

// 生成新令牌：每次“启用”都让监控重新把关键词搜一遍
function newRunToken() {
  return 'r' + Date.now();
}

// 待跳转的搜索页地址：搜索模式下优先取第一个关键词
function firstSearchUrl(c) {
  const kws = Array.isArray(c && c.keywords) ? c.keywords : [];
  const firstKw = kws.map(k => (k && typeof k === 'object') ? k.name : k).filter(Boolean)[0];
  const tpl = (c && c.searchUrlTemplate) || DEFAULT_SEARCH_TPL;
  if (!firstKw || !/\{keyword\}/i.test(tpl)) return null;
  return tpl.replace(/\{keyword\}/gi, encodeURIComponent(firstKw));
}

async function saveEnabled(next) {
  const { pm_config: c = {} } = await chrome.storage.local.get('pm_config');
  c.enabled = next;
  if (next) c.runToken = newRunToken();   // 重新启用 → 重新搜一遍
  await chrome.storage.local.set({ pm_config: c });
  if (!next) {
    await removeDynamicScript();
  } else if (c.pattern) {
    // 恢复监控：非 manifest 覆盖的域名需要重新注册，否则暂停后就再也起不来
    let covered = false;
    try { covered = coveredByManifest(c.pattern.replace(/\*/g, '')); } catch (e) { covered = false; }
    if (!covered) {
      try { await ensureDynamicScript(c.pattern); } catch (e) { /* 无 scripting 权限时忽略，由 content 侧自行判断 */ }
    }
  }
  // 重新启用时直接跳到第一个关键词的搜索页，而不是干等一轮间隔
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    const target = next ? firstSearchUrl(c) : null;
    if (target) await chrome.tabs.update(tab.id, { url: target });
    else chrome.tabs.reload(tab.id);
  }
}

const openOptionsEl = $('openOptions');
if (openOptionsEl) openOptionsEl.onclick = () => chrome.runtime.openOptionsPage();

// 暂停 / 恢复
const enabledEl = $('enabled');
if (enabledEl) {
  enabledEl.addEventListener('change', async (e) => {
    try {
      await saveEnabled(e.target.checked);
      setStatus(e.target.checked ? '已恢复监控' : '已暂停监控', true);
      refreshState();
    } catch (err) {
      e.target.checked = !e.target.checked;
      setStatus('切换失败：' + ((err && err.message) || err), false);
    }
  });
}

const monitorEl = $('monitor');
if (monitorEl) monitorEl.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    setStatus('当前页面不是普通网页，无法监控', false);
    return;
  }
  let origin;
  try { origin = new URL(tab.url).origin; } catch (e) {
    setStatus('无法解析当前页面地址', false);
    return;
  }
  const pattern = origin + '/*';

  try {
    const { pm_config: c = {} } = await chrome.storage.local.get('pm_config');
    // 只改域名与开关，保留其它配置；无配置时给出搜索模式的可用默认值
    const next = {
      mode: 'search',
      baseInterval: 60,
      jitter: 30,
      reload: true,
      itemSelector: '.product-item.product-item-cards',
      searchPriceSelector: '.row-hd .price',
      keywords: [{ name: '于此岸赴宴', target: 300 }],
      ...c,
      enabled: true,
      pattern,
      runToken: newRunToken()   // 每次启用都重新搜一遍
    };
    await chrome.storage.local.set({ pm_config: next });

    if (!coveredByManifest(tab.url)) await ensureDynamicScript(pattern);

    // 直接跳到第一个关键词的搜索结果页，而不是只刷新干等 60~90 秒
    const target = firstSearchUrl(next);
    if (tab.id != null) {
      if (target) await chrome.tabs.update(tab.id, { url: target });
      else chrome.tabs.reload(tab.id);
    }

    setStatus(target
      ? `已启用，正在搜索「${next.keywords.map(k => k.name).filter(Boolean)[0]}」…`
      : '已对 ' + pattern + ' 启用监控，页面已刷新', true);
    if (!next.webhook) setStatus('已启用，但还没填 Webhook（不会推企微）→ 点「打开配置」填写', false);
    refreshState();
  } catch (e) {
    setStatus('失败：' + ((e && e.message) || e), false);
  }
};

refreshState().catch(() => {});
