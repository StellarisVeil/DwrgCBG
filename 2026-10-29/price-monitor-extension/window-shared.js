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

  // 当前“连续监控段”的起点（毫秒），同时考虑周几筛选与时段控制。
  // 用于停摆判定：不监测日/时段外的静默不应计入“多久没新查询”。
  //   - 返回 null：监控一直连续（如全天每天都监测），没有自然起点，按最后一次查询算；
  //   - 返回毫秒：从这一刻起才进入本段监控（例如不监测日结束后的 0:00、
  //     或跨午夜时段起点落在不监测日时收敛到的 0:00）。
  function activeRunStartMs(cfg, nowMs) {
    if (!cfg) return null;
    const now = nowMs == null ? Date.now() : nowMs;
    const dayStart = (ms) => {
      const d = new Date(ms);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };

    const ws = windowStartMs(cfg, now);   // 时段模式下的本段起点；全天/无效时段为 null
    if (ws != null) {
      if (!cfg.dayFilterEnabled) return ws;
      // 跨午夜时 ws 可能落在昨天（不监测日）：本段实际从今天 0:00 才开始
      return inActiveDay(cfg, ws) ? ws : dayStart(now);
    }

    // 全天模式（未启用时段 / 起止相同）
    if (!cfg.dayFilterEnabled) return null;
    if (!inActiveDay(cfg, now)) return dayStart(now);
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    // 昨天也是监测日 → 全天连续，无自然起点；否则从今天 0:00 起算
    return inActiveDay(cfg, y.getTime()) ? null : dayStart(now);
  }

  root.PMWindow = {
    inWorkWindow: inWorkWindow,
    windowStartMs: windowStartMs,
    inActiveDay: inActiveDay,
    activeRunStartMs: activeRunStartMs
  };
})(typeof self !== 'undefined' ? self : this);
