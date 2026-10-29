// background.js — MV3 service worker
// 职责：接收 content.js 命中的项，推送到企业微信机器人，并弹出本地通知。

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
    let content;
    if (h.kind === 'search') {
      content =
        `### 🔍 搜索比价提醒\n` +
        `**关键词**: ${h.keyword}\n` +
        `**最低价**: ¥${h.price}（目标 ≤ ¥${h.threshold}）\n` +
        `**商品链接**: [点此查看](${h.link || h.url})\n` +
        `> 检测时间: ${new Date().toLocaleString('zh-CN')}`;
    } else {
      const skinLines = (h.matched || []).map(m => `- ${m.name}：¥${m.price}`).join('\n');
      content =
        `### 🔔 皮肤套餐提醒\n` +
        `**账号**: ${h.title || '(未命名账号)'}\n` +
        `**命中皮肤**:\n${skinLines}\n` +
        `**合计参考价**: ¥${h.sum}` +
        (h.acctPrice != null ? `（账号售价 ¥${h.acctPrice}）` : '') + `\n` +
        `**商品链接**: [点此查看](${h.link || h.url})\n` +
        `> 检测时间: ${new Date().toLocaleString('zh-CN')}`;
    }
    await sendToWeCom(pm_config.webhook, content);
  }
  if (hits.length) {
    try {
      await chrome.notifications.create('pm-' + Date.now(), {
        type: 'basic',
        iconUrl: ICON,
        title: hits[0].kind === 'search' ? '搜索比价提醒' : '皮肤套餐提醒',
        message: `发现 ${hits.length} 个命中，已推送企业微信`
      });
    } catch (e) { /* 通知失败不影响推送 */ }
  }
}

async function sendTest() {
  const { pm_config = {} } = await chrome.storage.local.get('pm_config');
  if (!pm_config.webhook) return;
  await sendToWeCom(
    pm_config.webhook,
    `### ✅ 测试消息\n皮肤监控插件已正确连接企业微信机器人\n> ${new Date().toLocaleString('zh-CN')}`
  );
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PM_HITS') handleHits(msg.hits);
  if (msg.type === 'PM_TEST') sendTest();
});
