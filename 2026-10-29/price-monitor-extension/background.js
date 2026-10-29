// background.js — MV3 service worker
// 职责：接收 content.js 命中的商品，推送到企业微信机器人，并弹出本地通知。

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

async function sendToWeCom(webhook, content) {
  if (!webhook) return;
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } })
  });
}

async function handleHits(hits) {
  const { pm_config = {} } = await chrome.storage.local.get('pm_config');
  for (const h of hits) {
    const content =
      `### 🔔 价格提醒\n` +
      `**商品**: ${h.title || '(未命名)'}\n` +
      `**价格**: ${h.price}\n` +
      `**页面**: [打开](${h.url})\n` +
      `> 检测时间: ${new Date().toLocaleString('zh-CN')}`;
    await sendToWeCom(pm_config.webhook, content);
  }
  if (hits.length) {
    try {
      await chrome.notifications.create('pm-' + Date.now(), {
        type: 'basic',
        iconUrl: ICON,
        title: '价格监控提醒',
        message: `发现 ${hits.length} 个满足条件的商品，已推送企业微信`
      });
    } catch (e) { /* 通知失败不影响推送 */ }
  }
}

async function sendTest() {
  const { pm_config = {} } = await chrome.storage.local.get('pm_config');
  if (!pm_config.webhook) return;
  await sendToWeCom(
    pm_config.webhook,
    `### ✅ 测试消息\n价格监控插件已正确连接企业微信机器人\n> ${new Date().toLocaleString('zh-CN')}`
  );
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PM_HITS') handleHits(msg.hits);
  if (msg.type === 'PM_TEST') sendTest();
});
