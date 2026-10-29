// popup.js — 快捷操作：一键对当前页面启用监控、打开配置
const $ = (id) => document.getElementById(id);

$('openOptions').onclick = () => chrome.runtime.openOptionsPage();

$('monitor').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) { $('status').textContent = '无法获取当前页面'; return; }
  let pattern;
  try { pattern = new URL(tab.url).origin + '/*'; } catch (e) { pattern = tab.url; }

  const { pm_config = {} } = await chrome.storage.local.get('pm_config');
  pm_config.enabled = true;
  pm_config.pattern = pattern;
  await chrome.storage.local.set({ pm_config });

  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['pm-monitor'] });
    await chrome.scripting.registerContentScripts({
      id: 'pm-monitor', matches: [pattern], js: ['content.js'], runAt: 'document_idle'
    });
    chrome.tabs.reload(tab.id);
    $('status').textContent = '已对 ' + pattern + ' 启用监控，页面已刷新';
  } catch (e) {
    $('status').textContent = '失败: ' + e.message;
  }
};
