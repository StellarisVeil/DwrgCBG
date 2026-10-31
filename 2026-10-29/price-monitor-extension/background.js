// background.js — MV3 service worker
// 职责：接收 content.js 命中的项，推送到企业微信机器人，并弹出本地通知。

const WECOM_MARKDOWN_LIMIT = 4000; // 企微 markdown.content 上限 4096 字节，留余量
const ICON_URL = 'icons/icon128.png';

function fmtTime(ts) {
  try { return new Date(ts || Date.now()).toLocaleString('zh-CN'); }
  catch (e) { return new Date().toISOString(); }
}

// 按字节截断，避免中文被切坏
function truncateBytes(str, limit) {
  const enc = new TextEncoder();
  if (enc.encode(str).length <= limit) return str;
  let out = '';
  for (const ch of str) {
    if (enc.encode(out + ch).length > limit - 3) break;
    out += ch;
  }
  return out + '...';
}

// 企微 markdown 消息体上限 4096 字节，超出按行切分成多条
function splitMarkdown(content, limit) {
  const enc = new TextEncoder();
  if (enc.encode(content).length <= limit) return [content];
  const parts = [];
  let buf = '';
  for (const line of content.split('\n')) {
    const candidate = buf ? buf + '\n' + line : line;
    if (enc.encode(candidate).length > limit) {
      if (buf) parts.push(buf);
      buf = truncateBytes(line, limit);
    } else {
      buf = candidate;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

// 返回 { ok, error }；不再静默吞掉错误
async function postWeCom(webhook, content) {
  let res;
  try {
    res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } })
    });
  } catch (e) {
    return { ok: false, error: '网络请求失败：' + ((e && e.message) || String(e)) };
  }
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };

  // 企微即使出错也常返回 HTTP 200，必须检查 errcode
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (data && typeof data.errcode === 'number' && data.errcode !== 0) {
    return { ok: false, error: `企业微信返回错误 ${data.errcode}：${data.errmsg || ''}` };
  }
  return { ok: true };
}

// 消息用链接清洗：去掉 refer_sn 等一次性会话参数，避免“点了打不开”。
const EQUIP_RE_MSG = /https?:\/\/[^\s>"'<>()]*?\/cgi\/mweb\/equip\/[^\s>"'<>()?#&]+/i;
function cleanForMessage(u) {
  if (!u) return '';
  const s = String(u).trim();
  const m = s.match(EQUIP_RE_MSG);
  if (m) return m[0];
  try {
    const url = new URL(s);
    ['refer_sn', 'refer_page', 'traceid', 'from', 'spm'].forEach(k => url.searchParams.delete(k));
    return url.href;
  } catch (e) { return s; }
}

function fmtDelta(d) {
  const n = Number(d) || 0;
  return (n > 0 ? '+' : '') + (Math.round(n * 100) / 100);
}

// 消息里的链接行。
// 企业微信 markdown 的 [文字](url) 在某些客户端里不可点击（尤其非 http 开头或含特殊字符时），
// 所以同时给一行明文地址，保证「点不到也能复制/直接点」。
function linkLine(url) {
  const u = cleanForMessage(url);
  if (!u) return '';
  return `**商品链接**：[点此查看](${u})
${u}`;
}

function hitToMarkdown(h) {
  const time = `> 检测时间：${fmtTime()}`;
  // 消息里的链接：优先商品详情页（永久有效）；拿不到才退回搜索页。
  // 搜索页可能带 refer_sn 会话参数，稍后会失效，所以尽量剥掉。
  const rawLink = h.link || h.url || '';
  const link = cleanForMessage(rawLink);

  // 补货：有更便宜的上架了
  if (h.kind === 'restock') {
    // 只有伴随"命中目标价"时才提目标价；单纯补货不显示差距，保持消息干净
    const targetNote = h.mergedWithEvent
      ? ((h.target != null && h.price <= h.target)
        ? `✅ 已低于你的目标价 ¥${h.target}`
        : (h.target != null ? `目标价 ¥${h.target}，还差 ${Math.round((h.price - h.target) * 100) / 100} 元` : ''))
      : '';
    return [
      `### 🆕 ${h.keyword} · 补货（有更便宜的）`,
      `**皮肤**：${h.keyword}`,
      `**最新最低价**：¥${h.price}（原 ¥${h.prevPrice}，降了 ${Math.abs(fmtDelta(h.delta))}）`,
      targetNote,
      linkLine(link),
      time
    ].filter(Boolean).join('\n');
  }

  // 卖出：最便宜的那个没了
  if (h.kind === 'sold') {
    return [
      `### 📤 ${h.keyword} · 卖出（便宜的被买走）`,
      `**皮肤**：${h.keyword}`,
      `**最新最低价**：¥${h.price}（原 ¥${h.prevPrice}，涨了 ${fmtDelta(h.delta).replace('+', '')}）`,
      `**说明**：之前 ¥${h.prevPrice} 那个已经不在了，现在最低是 ¥${h.price}`,
      linkLine(link),
      time
    ].filter(Boolean).join('\n');
  }

  if (h.kind === 'search') {
    // 若同一轮还伴随补货/卖出，简单标注一下（不作为独立消息推送）
    const evtNote = h.eventKind === 'restock' ? '🆕 同时检测到补货（有更便宜的上架）'
      : h.eventKind === 'sold' ? '📤 同时检测到上一档已卖出' : '';
    return [
      `### 💰 ${h.keyword} · 低于目标价 ¥${h.price}`,
      `**关键词**：${h.keyword}`,
      `**最低价**：¥${h.price}（目标 ≤ ¥${h.threshold}）`,
      evtNote,
      linkLine(link),
      time
    ].filter(Boolean).join('\n');
  }
  const skinLines = (h.matched || []).map(m => `- ${m.name}：¥${m.price}`).join('\n');
  return [
    `### 🔔 皮肤套餐提醒 · ${(h.matched || []).map(m => m.name).join('/') || h.title || ''}`,
    `**账号**：${h.title || '(未命名账号)'}`,
    '**命中皮肤**：',
    skinLines || '- (无)',
    `**合计参考价**：¥${h.sum}` + (h.acctPrice != null ? `（账号售价 ¥${h.acctPrice}）` : ''),
    linkLine(link),
    time
  ].join('\n');
}

// 把同一次请求里的多条命中合成一条消息。
// 典型场景：同一轮既"补货"又"达到目标价"——合成一条，附带"已达标"标记。
function mergeHitsToMarkdown(hits) {
  if (!Array.isArray(hits) || !hits.length) return '';
  if (hits.length === 1) return hitToMarkdown(hits[0]);

  const evt = hits.find(h => h.kind === 'restock' || h.kind === 'sold');
  const hit = hits.find(h => h.kind === 'search');
  const others = hits.filter(h => h !== evt && h !== hit);

  // 变动 + 命中 合成一条
  if (evt && hit) {
    const link = hit.link || evt.link || hit.url || evt.url || '';
    const isRestock = evt.kind === 'restock';
    const absDelta = Math.abs(Number(evt.delta) || 0);
    const reached = hit.threshold != null && hit.price <= hit.threshold;
    const gap = (hit.threshold != null && !reached)
      ? `，还差 ${Math.round((hit.price - hit.threshold) * 100) / 100} 元` : '';

    const lines = [
      isRestock
        ? `### 🆕 ${hit.keyword || evt.keyword} · 补货且达标`
        : `### 📤 ${hit.keyword || evt.keyword} · 卖出`,
      `**皮肤**：${hit.keyword || evt.keyword}`,
      `**最新最低价**：¥${hit.price}（原 ¥${evt.prevPrice}，${isRestock ? '降了' : '涨了'} ${absDelta}）`,
      reached ? `✅ **已达到你的目标价** ¥${hit.threshold}` : `目标价 ¥${hit.threshold}${gap}`,
      linkLine(link),
      `> 检测时间：${fmtTime()}`
    ];
    if (others.length) lines.push('', ...others.map(hitToMarkdown));
    return lines.join('\n');
  }

  // 其余情况：多个不同皮肤并列。
  // 每条都自带 `### 皮肤名 · 类型`，即使企微只把第一个渲染成大标题，
  // 后面每条的皮肤名依然写在标题文字里，不会被漏掉。
  return hits.map(hitToMarkdown).join('\n\n---\n\n');
}

async function getWebhook() {
  const { pm_config = {} } = await chrome.storage.local.get('pm_config');
  return (pm_config.webhook || '').trim();
}

// 多条命中合并为一条消息，避免触发企微每分钟 20 条的限流
async function handleHits(hits) {
  if (!Array.isArray(hits) || !hits.length) return { ok: true };
  const webhook = await getWebhook();
  let pushOk = false;
  let pushError = '';

  if (!webhook) {
    pushError = '未配置企业微信 Webhook，仅弹出本地通知';
  } else {
    // 同一轮里「价格变动 + 命中目标价」会被合并成一次请求发来：
    // 此时只输出一条整合消息，而不是两条内容高度重叠的通知。
    const body = mergeHitsToMarkdown(hits);
    const chunks = splitMarkdown(body, WECOM_MARKDOWN_LIMIT);
    for (const chunk of chunks) {
      const r = await postWeCom(webhook, chunk);
      if (!r.ok) { pushOk = false; pushError = r.error || ('第 ' + (chunks.indexOf(chunk) + 1) + ' 段推送失败'); break; }
      pushOk = true;
    }
  }

  try {
    const kind0 = hits[0].kind;
    // 皮肤名必须进标题：标题里永远能看到是哪个皮肤
    const names = [...new Set(hits.map(h => h.keyword || h.title).filter(Boolean))];
    const nameLabel = names.slice(0, 3).join('/') + (names.length > 3 ? ` 等${names.length}个` : '');
    const kindLabel = kind0 === 'restock' ? '补货提醒'
      : kind0 === 'sold' ? '卖出提醒'
        : kind0 === 'search' ? '低于目标价' : '皮肤套餐提醒';
    const title = `${nameLabel ? nameLabel + ' · ' : ''}${kindLabel}`.slice(0, 60);
    const message = pushOk
      ? (kind0 === 'restock' ? `「${hits[0].keyword}」有更便宜的：¥${hits[0].price}（原 ¥${hits[0].prevPrice}）`
        : kind0 === 'sold' ? `「${hits[0].keyword}」最便宜的已卖出，现最低 ¥${hits[0].price}`
          : `发现 ${hits.length} 个命中，已推送企业微信`)
      : `发现 ${hits.length} 条，但推送失败：${pushError}`;
    // 记录本次命中的首个商品链接，供点击通知时跳转（此前只读不写，点击无反应）
    const targetUrl = (hits[0] && (hits[0].link || hits[0].url)) || '';
    if (targetUrl) {
      try { await chrome.storage.local.set({ pm_last_url: targetUrl }); } catch (e) { /* ignore */ }
    }
    await chrome.notifications.create('pm-' + Date.now(), {
      type: 'basic',
      iconUrl: ICON_URL,
      title,
      message: message.slice(0, 200)
    });
  } catch (e) {
    // 通知失败不影响推送结果
  }

  return pushOk || !webhook ? { ok: true } : { ok: false, error: pushError || '推送未成功（未收到明确原因）' };
}

// 风控报警：被要求验证/被拦截时立刻推企微 + 弹本地通知
async function handleChallenge(info) {
  const webhook = await getWebhook();
  const { pm_config: cfg = {} } = await chrome.storage.local.get('pm_config');
  const url = (info && info.url) || '';

  const lines = [
    `### ⚠️ ${info && info.keyword ? info.keyword + ' · ' : ''}藏宝阁要求验证，已暂停`,
    `**原因**：${(info && info.reason) || '检测到验证/拦截页面'}`,
    info && info.keyword ? `**发生在**：搜索「${info.keyword}」时` : '',
    `**处理**：已停止所有自动跳转，避免把临时限制刷成更严重的问题`,
    '',
    '**你需要做的**：',
    '1. 打开下面这个页面，手动完成验证（滑块/验证码）',
    '2. 验证通过后，点扩展图标 →「监控当前页面」重新开始',
    '',
    `**页面**：[点此打开](${url})`,
    `> 检测时间：${fmtTime()}`
  ].filter(Boolean);

  const content = lines.join('\n');
  let pushError = '';
  let pushOk = false;
  if (webhook) {
    const r = await postWeCom(webhook, content);
    pushOk = r.ok;
    if (!r.ok) pushError = r.error;
  } else {
    pushError = '未配置 Webhook';
  }

  try {
    if (url) await chrome.storage.local.set({ pm_last_url: url });
    await chrome.notifications.create('pm-challenge-' + Date.now(), {
      type: 'basic',
      iconUrl: ICON_URL,
      title: `${(info && info.keyword) ? info.keyword + ' · ' : ''}藏宝阁要求验证，已暂停`.slice(0, 60),
      message: String((info && info.reason) || '请到页面手动完成验证').slice(0, 180)
    });
  } catch (e) { /* ignore */ }

  return pushOk || !webhook ? { ok: true, pushOk } : { ok: false, error: pushError || '推送未成功（未收到明确原因）' };
}

async function sendTest() {
  const webhook = await getWebhook();
  if (!webhook) return { ok: false, error: '请先填写 Webhook 地址' };
  const r = await postWeCom(webhook, `### ✅ 测试消息\n价格监控插件已正确连接企业微信机器人\n> ${fmtTime()}`);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const run = async () => {
    if (msg.type === 'PM_HITS') return handleHits(msg.hits);
    if (msg.type === 'PM_TEST') return sendTest();
    if (msg.type === 'PM_CHALLENGE') return handleChallenge(msg);
    return { ok: false, error: '未知消息类型' };
  };
  run()
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true; // 异步 sendResponse，必须返回 true
});

// 点击通知时打开对应商品页
chrome.notifications.onClicked.addListener(async (id) => {
  try {
    const { pm_last_url: url } = await chrome.storage.local.get('pm_last_url');
    if (url) await chrome.tabs.create({ url });
  } catch (e) { /* ignore */ }
  try { chrome.notifications.clear(id); } catch (e) { /* ignore */ }
});

// ---- 后台守护：标签页白屏/被回收/长时间无查询时自动恢复并报警 ----
try {
  importScripts('keepalive.js');
} catch (e) {
  // 加载失败不影响核心推送功能
  try { console.warn('[价格监控] 保活脚本加载失败', e); } catch (err) { /* ignore */ }
}
