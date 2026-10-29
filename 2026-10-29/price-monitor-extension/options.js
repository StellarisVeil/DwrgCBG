// options.js — 配置页逻辑：读写配置、注册/注销 content script、测试、清空去重记录
const $ = (id) => document.getElementById(id);
const SCRIPT_ID = 'pm-monitor';

async function unregister() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch (e) {}
}

async function register(pattern) {
  await unregister();
  await chrome.scripting.registerContentScripts({
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

async function save() {
  const cfg = {
    enabled: $('enabled').checked,
    pattern: $('pattern').value.trim(),
    intervalSec: Math.max(1, parseInt($('intervalSec').value, 10) || 30),
    reload: $('reload').checked,
    itemSelector: $('itemSelector').value.trim(),
    fieldSelector: $('fieldSelector').value.trim(),
    titleSelector: $('titleSelector').value.trim(),
    operator: $('operator').value,
    threshold: parseFloat($('threshold').value),
    webhook: $('webhook').value.trim()
  };
  await chrome.storage.local.set({ pm_config: cfg });

  if (cfg.enabled && cfg.pattern && cfg.itemSelector && cfg.fieldSelector) {
    try {
      await register(cfg.pattern);
      setStatus('已保存并启用监控，匹配: ' + cfg.pattern, true);
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
  if (!pm_config) return;
  $('enabled').checked = !!pm_config.enabled;
  $('pattern').value = pm_config.pattern || '';
  $('intervalSec').value = pm_config.intervalSec || 30;
  $('reload').checked = pm_config.reload !== false;
  $('itemSelector').value = pm_config.itemSelector || '';
  $('fieldSelector').value = pm_config.fieldSelector || '';
  $('titleSelector').value = pm_config.titleSelector || '';
  $('operator').value = pm_config.operator || '<';
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

load();
