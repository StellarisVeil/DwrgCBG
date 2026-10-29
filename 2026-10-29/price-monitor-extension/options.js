// options.js — 配置页逻辑：读写配置、注册/注销 content script、解析皮肤清单、CSV 导入、测试、清空去重记录、模式切换
const $ = (id) => document.getElementById(id);
const SCRIPT_ID = 'pm-monitor';

// 预置假数据：让功能在没有真实 Excel 时也能跑通演示
const DEFAULT_SKINS =
`司药,30
石榴碟小姐,50
片刻闲暇,40
长夜,25
欧律狄刻,35`;

function unregister() {
  return chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
}

async function register(pattern) {
  await unregister();
  return chrome.scripting.registerContentScripts({
    id: SCRIPT_ID,
    matches: [pattern],
    js: ['content.js'],
    runAt: 'document_idle'
  });
}

function setStatus(msg, ok) {
  const s = $('status');
  s.textContent = msg;
  s.style.color = ok ? '#0a0' : '#c00';
}

// 把文本框解析成 [{name, price}]；忽略空行和无效行
function parseSkins(text) {
  const out = []; let bad = 0;
  text.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t) return;
    const idx = t.indexOf(',');
    if (idx < 0) { bad++; return; }
    const name = t.slice(0, idx).trim();
    const price = t.slice(idx + 1).trim();
    if (!name) { bad++; return; }
    out.push({ name, price });
  });
  return { skins: out, bad };
}

// 模式切换：显示/隐藏对应配置区
function applyModeVisibility() {
  const isSearch = $('mode').value === 'search';
  $('searchSection').style.display = isSearch ? '' : 'none';
  $('bundleSection').style.display = isSearch ? 'none' : '';
}

async function save() {
  const mode = $('mode').value;
  const cfg = {
    enabled: $('enabled').checked,
    pattern: $('pattern').value.trim(),
    mode,
    baseInterval: Math.max(1, parseInt($('baseInterval').value, 10) || 60),
    jitter: Math.max(0, parseInt($('jitter').value, 10) || 0),
    reload: $('reload').checked,
    timeWindowEnabled: $('timeWindowEnabled').checked,
    windowStart: parseInt($('windowStart').value, 10) || 0,
    windowEnd: parseInt($('windowEnd').value, 10) || 0,
    itemSelector: $('itemSelector').value.trim(),
    webhook: $('webhook').value.trim()
  };

  if (mode === 'search') {
    const keywords = $('keywords').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!keywords.length) { setStatus('搜索模式需要至少填一个关键词', false); return; }
    cfg.keywords = keywords;
    cfg.searchUrlTemplate = $('searchUrlTemplate').value.trim() ||
      'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC';
    cfg.searchPriceThreshold = parseFloat($('searchPriceThreshold').value);
    cfg.searchPriceSelector = $('searchPriceSelector').value.trim() || '.row-hd .price';
    cfg.skinNameSelector = '';
    cfg.titleSelector = '';
    cfg.accountPriceSelector = '';
    cfg.skins = [];
    cfg.threshold = 0;
  } else {
    const { skins, bad } = parseSkins($('skins').value);
    if (!skins.length) { setStatus('皮肤清单为空或格式不对（应为 名称,价格 每行一个）', false); return; }
    cfg.skinNameSelector = $('skinNameSelector').value.trim();
    cfg.titleSelector = $('titleSelector').value.trim();
    cfg.accountPriceSelector = $('accountPriceSelector').value.trim();
    cfg.skins = skins;
    cfg.threshold = parseFloat($('threshold').value);
    cfg.keywords = [];
    cfg.searchUrlTemplate = '';
    cfg.searchPriceThreshold = 0;
    cfg.searchPriceSelector = '';
  }

  await chrome.storage.local.set({ pm_config: cfg });

  if (cfg.enabled && cfg.pattern) {
    try {
      await register(cfg.pattern);
      let msg = `已保存并启用监控（${mode === 'search' ? '搜索比价' : '皮肤套餐'}），匹配: ${cfg.pattern}`;
      if (cfg.timeWindowEnabled) msg += `；时段 ${cfg.windowStart}-${cfg.windowEnd} 点`;
      msg += `；间隔 ${cfg.baseInterval}+${cfg.jitter}s 随机`;
      setStatus(msg, true);
    } catch (e) {
      setStatus('保存成功，但注册脚本失败: ' + e.message, false);
    }
  } else {
    await unregister();
    setStatus('已保存（未启用或缺少必填项，已停止注入）', true);
  }
}

async function load() {
  const { pm_config } = await chrome.storage.local.get('pm_config');
  if (!pm_config) {
    $('pattern').value = 'https://id5.cbg.163.com/*';
    $('mode').value = 'bundle';
    $('baseInterval').value = 60;
    $('jitter').value = 30;
    $('reload').checked = true;
    $('timeWindowEnabled').checked = false;
    $('windowStart').value = 9;
    $('windowEnd').value = 23;
    $('itemSelector').value = '.product-item.product-item-cards';
    $('skinNameSelector').value = '.card-item .name-wrap .name';
    $('titleSelector').value = '.main-title';
    $('accountPriceSelector').value = '.row-hd .price';
    $('skins').value = DEFAULT_SKINS;
    $('threshold').value = 100;
    applyModeVisibility();
    return;
  }
  $('enabled').checked = !!pm_config.enabled;
  $('pattern').value = pm_config.pattern || '';
  $('mode').value = pm_config.mode || 'bundle';
  $('baseInterval').value = (pm_config.baseInterval != null ? pm_config.baseInterval : (pm_config.intervalSec || 60));
  $('jitter').value = (pm_config.jitter != null ? pm_config.jitter : 30);
  $('reload').checked = pm_config.reload !== false;
  $('timeWindowEnabled').checked = !!pm_config.timeWindowEnabled;
  $('windowStart').value = (pm_config.windowStart != null) ? pm_config.windowStart : 9;
  $('windowEnd').value = (pm_config.windowEnd != null) ? pm_config.windowEnd : 23;
  $('itemSelector').value = pm_config.itemSelector || '.product-item.product-item-cards';
  $('skinNameSelector').value = pm_config.skinNameSelector || '.card-item .name-wrap .name';
  $('titleSelector').value = pm_config.titleSelector || '.main-title';
  $('accountPriceSelector').value = pm_config.accountPriceSelector || '.row-hd .price';
  $('skins').value = (pm_config.skins || []).map(s => `${s.name},${s.price}`).join('\n');
  $('threshold').value = (pm_config.threshold != null) ? pm_config.threshold : 100;
  $('keywords').value = (pm_config.keywords || []).join('\n');
  $('searchUrlTemplate').value = pm_config.searchUrlTemplate ||
    'https://id5.cbg.163.com/cgi/mweb/pl?keyword={keyword}&order_by=price%20ASC';
  $('searchPriceThreshold').value = (pm_config.searchPriceThreshold != null) ? pm_config.searchPriceThreshold : 50;
  $('searchPriceSelector').value = pm_config.searchPriceSelector || '.row-hd .price';
  $('webhook').value = pm_config.webhook || '';
  applyModeVisibility();
}

$('mode').addEventListener('change', applyModeVisibility);
$('save').onclick = save;
$('clear').onclick = async () => {
  await chrome.storage.local.set({ pm_notified: {} });
  setStatus('已清空已通知记录（下次扫描会重新提醒）', true);
};
$('test').onclick = async () => {
  const { pm_config } = await chrome.storage.local.get('pm_config');
  if (!pm_config || !pm_config.webhook) { setStatus('请先填写 Webhook 地址', false); return; }
  chrome.runtime.sendMessage({ type: 'PM_TEST' });
  setStatus('已发送测试消息，请查看企业微信', true);
};

// CSV 导入：Excel 导出为 .csv（皮肤名,价格）后直接读入文本框
$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('skins').value = reader.result; setStatus('已读取 CSV，记得点「保存并应用」', true); };
  reader.readAsText(file, 'utf-8');
});

load();
