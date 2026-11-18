// window-shared.js — 监控时段的统一判断（content.js 与 keepalive.js 共用）
// 使用本地时间；支持跨午夜（如 22 → 8）；配置缺省/起止相同视为全天。
(function (root) {
  function toNum(v, dflt) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  // 周几筛选：仅勾选的日子扫描。activeDays 为勾选的周几数组（与 Date.getDay 一致：
  // 0=周日, 1=周一 … 6=周六）。未启用时不限制；启用后未勾选的日子一律不扫描。
  function inActiveDay(cfg, at) {
    if (!cfg || !cfg.dayFilterEnabled) return true;
    const days = Array.isArray(cfg.activeDays) ? cfg.activeDays : [];
    if (!days.length) return false;         // 启用了筛选但一个都没勾 → 全周不扫描
    const d = at == null ? new Date() : new Date(at);
    return days.indexOf(d.getDay()) !== -1;
  }

  // 是否处于监控时段内
  function inWorkWindow(cfg, at) {
    if (!inActiveDay(cfg, at)) return false;  // 未勾选的日子：不扫描、不报警
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

  root.PMWindow = { inWorkWindow: inWorkWindow, windowStartMs: windowStartMs, inActiveDay: inActiveDay };
})(typeof self !== 'undefined' ? self : this);
