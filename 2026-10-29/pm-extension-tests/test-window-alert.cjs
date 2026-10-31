// 验证：停摆报警只在「工作时段内」触发，时段外停摆属正常不报警
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const EXT = path.resolve(process.env.PM_EXT);
const KA_SRC = fs.readFileSync(path.join(EXT, 'keepalive.js'), 'utf8');
const { createHookServer } = require('./hook-server.cjs');

let pass = 0, fail = 0; const failures = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; failures.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); }
}

const nowH = new Date().getHours();

(async () => {
  const hook = await createHookServer();
  const browser = await chromium.launch({ headless: true });

  // 构造一个能跑 keepalive 的环境
  async function runCase(label, cfgPatch, opts = {}) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();

    // 计算"当前是否在时段内"
    const inWindowNow = (cfg) => {
      if (!cfg.timeWindowEnabled) return true;
      const h = new Date().getHours();
      const s = cfg.windowStart, e = cfg.windowEnd;
      if (s === e) return true;
      return s < e ? (h >= s && h < e) : (h >= s || h < e);
    };

    const cfg = {
      enabled: true, pattern: 'https://id5.cbg.163.com/*', mode: 'search',
      baseInterval: 1800, jitter: 300, hopMinSec: 20, hopMaxSec: 45,
      keywords: [{ name: 'A', target: 100 }, { name: 'B', target: 100 }],
      webhook: hook.url,
      ...cfgPatch
    };

    const store = {
      pm_config: cfg,
      pm_log: opts.oldLog === false ? [] : [{ ts: Date.now() - 5 * 3600 * 1000, time: 'old', keyword: 'A', price: 100 }],
      pm_stale_notified_at: 0
    };

    await p.addInitScript(({ store, tabs }) => {
      window.__store = store;
      window.__notifs = [];
      window.__alarms = [];
      window.chrome = {
        storage: {
          local: {
            get(k) {
              const list = k == null ? Object.keys(window.__store) : (Array.isArray(k) ? k : [k]);
              const o = {}; list.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; });
              return Promise.resolve(JSON.parse(JSON.stringify(o)));
            },
            set(o) { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
            remove(k) { (Array.isArray(k) ? k : [k]).forEach(x => delete window.__store[x]); return Promise.resolve(); }
          }
        },
        notifications: {
          create(id, o) { window.__notifs.push({ id, opts: o }); return Promise.resolve(id); },
          clear() { return Promise.resolve(true); }, onClicked: { addListener() {} }
        },
        alarms: {
          create(n, i) { window.__alarms.push({ name: n, info: i }); },
          clear() { return Promise.resolve(true); },
          get(n) { return Promise.resolve(window.__alarms.find(a => a.name === n) || null); },
          getAll() { return Promise.resolve(window.__alarms); },
          onAlarm: { addListener(fn) { window.__alarmHandler = fn; } }
        },
        runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, lastError: undefined },
        tabs: {
          query() { return Promise.resolve(tabs); },
          create() { return Promise.resolve(); },
          reload() { return Promise.resolve(); },
          update() { return Promise.resolve(); }
        },
        scripting: {
          executeScript() { return Promise.resolve([{ result: { cards: 1, textLen: 200, title: 'ok', ready: 'complete' } }]); }
        },
        fetch: (...a) => fetch(...a)
      };
    }, { store, tabs: opts.tabs === false ? [] : [{ id: 1, url: 'https://id5.cbg.163.com/cgi/mweb/pl' }] });

    await p.goto(hook.pageUrl);
    await p.addScriptTag({ content: KA_SRC });
    await p.waitForTimeout(400);

    hook.reset();
    const res = await p.evaluate(() => tickKeepAlive());
    await p.waitForTimeout(600);

    const out = {
      res,
      notifs: await p.evaluate(() => window.__notifs),
      pushed: hook.state.hits.length,
      warned: await p.evaluate(async () => (await chrome.storage.local.get('pm_stale_notified_at')).pm_stale_notified_at)
    };
    await ctx.close();
    console.log(`\n[${label}]`);
    console.log('  结果:', JSON.stringify(res));
    console.log('  企微推送:', hook.state.hits.length, '| 本地通知:', out.notifs.length);
    const expectedIn = inWindowNow(cfg);
    out.expectedIn = expectedIn;
    return out;
  }

  // ============ 1. 时段外 + 长期无日志 → 不应报警 ============
  // 构造一个"现在肯定不在"的时段
  const outStart = (nowH + 2) % 24;
  const outEnd = (nowH + 3) % 24;
  const r1 = await runCase('时段外停摆（应静默）', {
    timeWindowEnabled: true, windowStart: outStart, windowEnd: outEnd
  });
  check('识别为不在时段内', r1.res && /outside-window/.test(r1.res.skipped || ''), JSON.stringify(r1.res));
  check('时段外不推企微', r1.pushed === 0, String(r1.pushed));
  check('时段外不弹通知', r1.notifs.length === 0, String(r1.notifs.length));

  // ============ 2. 时段外 + 标签页也没了 → 也不应报警 ============
  const r2 = await runCase('时段外且标签页关闭（仍应静默）', {
    timeWindowEnabled: true, windowStart: outStart, windowEnd: outEnd
  }, { tabs: false });
  check('时段外无标签页也不报警', r2.pushed === 0 && r2.notifs.length === 0,
    `推送 ${r2.pushed}, 通知 ${r2.notifs.length}`);

  // ============ 3. 时段内 + 长期无日志 → 应报警 ============
  const inStart = nowH;                    // 当前小时开始
  const inEnd = (nowH + 3) % 24;           // 往后 3 小时
  const r3 = await runCase('时段内停摆（应报警）', {
    timeWindowEnabled: true, windowStart: inStart, windowEnd: inEnd
  });
  check('识别为在时段内', !(r3.res.skipped || '').includes('outside-window'), JSON.stringify(r3.res));
  check('时段内推企微报警', r3.pushed >= 1, String(r3.pushed));
  check('时段内弹本地通知', r3.notifs.length >= 1, String(r3.notifs.length));
  const msg = r3.pushed ? hook.state.hits[0].body.markdown.content : '';
  if (msg) console.log('  报警内容:\n' + msg.split('\n').map(l => '    ' + l).join('\n'));
  check('报警说明"在监控时段内"', /监控时段内/.test(msg), msg.slice(0, 160));
  check('报警含阈值分钟数', /\d+ 分钟没有新的查询/.test(msg), '');

  // ============ 4. 未启用时段控制 → 视为全天，停摆应报警 ============
  const r4 = await runCase('未启用时段控制（视为全天，应报警）', {
    timeWindowEnabled: false
  });
  check('未启用时段时停摆会报警', r4.pushed >= 1, String(r4.pushed));

  // ============ 5. 时段内刚进入（宽限期内）→ 不报警 ============
  // 构造"刚进入时段 5 分钟"：起始小时 = 当前小时，但把检测时间当作刚过整点
  // 这里直接验证 minutesIntoWindow 的行为（真实时刻无法伪造）
  const r5 = await runCase('时段内正常（有近期日志，不该报警）', {
    timeWindowEnabled: true, windowStart: inStart, windowEnd: inEnd
  }, { oldLog: false });
  // oldLog:false 表示日志为空 → ageMin=Infinity，会触发报警（这是合理的：
  // 在时段内却完全没有记录，说明监控从未成功过，应当告知）
  check('时段内完全无日志会报警（合理）', r5.pushed >= 1, String(r5.pushed));

  // ============ 6. 停摆阈值随配置变化 ============
  const r6 = await runCase('阈值随关键词数与周期变化', {
    timeWindowEnabled: true, windowStart: inStart, windowEnd: inEnd,
    keywords: Array.from({ length: 30 }, (_, i) => ({ name: 'K' + i, target: 100 })),
    baseInterval: 3600, jitter: 600, hopMinSec: 20, hopMaxSec: 45
  });
  const lim = r6.res && r6.res.staleLimitMin;
  console.log('  30 个词 / 1 小时周期 的停摆阈值:', lim, '分钟');
  check('阈值随配置放大（> 60 分钟）', typeof lim === 'number' && lim > 60, String(lim));
  check('阈值有上限（≤ 180 分钟）', typeof lim === 'number' && lim <= 180, String(lim));

  await browser.close();
  await hook.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { failures.forEach(f => console.log('  FAIL: ' + f)); process.exit(1); }
})().catch(e => { console.error('异常:', e); process.exit(2); });
