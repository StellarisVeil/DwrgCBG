// options.js — 配置页逻辑：读写配置、注册/注销 content script、解析皮肤清单、CSV 导入、测试、清空去重记录
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
  const out = [];
  let bad = 0;
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

async function save() {
  const { skins, bad } = parseSkins($('skins').value);
  if (!skins.length) {
    setStatus('皮肤清单为空或格式不对（应为 名称,价格 每行一个）', false);
    return;
  }
  const cfg = {
    enabled: $('enabled').checked,
    pattern: $('pattern').value.trim(),
    intervalSec: Math.max(1, parseInt($('intervalSec').value, 10) || 60),
    reload: $('reload').checked,
    itemSelector: $('itemSelector').value.trim(),
    skinNameSelector: $('skinNameSelector').value.trim(),
    titleSelector: $('titleSelector').value.trim(),
    accountPriceSelector: $('accountPriceSelector').value.trim(),
    skins,
    threshold: parseFloat($('threshold').value),
    webhook: $('webhook').value.trim()
  };
  await chrome.storage.local.set({ pm_config: cfg });

  if (cfg.enabled && cfg.pattern && cfg.itemSelector && cfg.skinNameSelector) {
    try {
      await register(cfg.pattern);
      let msg = `已保存并启用监控，匹配: ${cfg.pattern}；皮肤清单 ${skins.length} 条`;
      if (bad) msg += `（${bad} 行无效已忽略）`;
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
    // 首次进入：预置假数据 + 藏宝阁首页默认选择器
    $('pattern').value = 'https://id5.cbg.163.com/*';
    $('intervalSec').value = 60;
    $('reload').checked = true;
    $('itemSelector').value = '.product-item.product-item-cards';
    $('skinNameSelector').value = '.card-item .name-wrap .name';
    $('titleSelector').value = '.main-title';
    $('accountPriceSelector').value = '.row-hd .price';
    $('skins').value = DEFAULT_SKINS;
    $('threshold').value = 100;
    return;
  }
  $('enabled').checked = !!pm_config.enabled;
  $('pattern').value = pm_config.pattern || '';
  $('intervalSec').value = pm_config.intervalSec || 60;
  $('reload').checked = pm_config.reload !== false;
  $('itemSelector').value = pm_config.itemSelector || '';
  $('skinNameSelector').value = pm_config.skinNameSelector || '';
  $('titleSelector').value = pm_config.titleSelector || '';
  $('accountPriceSelector').value = pm_config.accountPriceSelector || '';
  $('skins').value = (pm_config.skins || []).map(s => `${s.name},${s.price}`).join('\n');
  $('threshold').value = (pm_config.threshold != null) ? pm_config.threshold : 100;
  $('webhook').value = pm_config.webhook || '';
}

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
