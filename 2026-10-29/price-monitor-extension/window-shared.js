// window-shared.js — 监控时段的统一判断（content.js 与 keepalive.js 共用）
// 使用本地时间；支持跨午夜（如 22 → 8）；配置缺省/起止相同视为全天。
(function (root) {
  function toNum(v, dflt) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  // 是否处于监控时段内
  function inWorkWindow(cfg, at) {
    if (!cfg || !cfg.timeWindowEnabled) return true;
    const d = at == null ? new Date() : new Date(at);
    const h = d.getHours();
    const s = toNum(cfg.windowStart, null);
    const e = toNum(cfg.windowEnd, null);
    if (s == null || e == null || s === e) return true;
    if (s < e) return h >= s && h < e;
    return h >= s || h < e;                 // 跨午夜
  }

  // 当前所在这一段时段的起点（毫秒）；未启用时段/配置无效返回 null。
  // 仅在 inWorkWindow 为 true 时使用：普通时段取今天的起点，跨午夜且当前在午夜后时取昨天的起点。
  function windowStartMs(cfg, nowMs) {
    if (!cfg || !cfg.timeWindowEnabled) return null;
    const s = toNum(cfg.windowStart, null);
    const e = toNum(cfg.windowEnd, null);
    if (s == null || e == null || s === e) return null;
    const now = nowMs == null ? Date.now() : nowMs;
    const d = new Date(now);
    let start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), s, 0, 0, 0).getTime();
    if (start > now) start -= 86400000;     // 跨午夜的凌晨段：本段从昨天开始
    return start;
  }

  root.PMWindow = { inWorkWindow: inWorkWindow, windowStartMs: windowStartMs };
})(typeof self !== 'undefined' ? self : this);
