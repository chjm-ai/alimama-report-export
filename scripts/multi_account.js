#!/usr/bin/env node
/*
 * 阿里妈妈多账号导出
 *
 * ⚠ 先读这段（Chrome 136+ / 144+ 的两套机制，决定了整个设计）：
 *
 *   机制一（Chrome 136+）：--user-data-dir 若是平台默认目录，--remote-debugging-port 被静默忽略。
 *   机制二（Chrome 144+）：通过 chrome://inspect/#remote-debugging 调试「真实 profile」时，
 *                        Chrome 会对「每一次连接」弹「允许远程调试?」对话框，
 *                        没人点就返回 403 Connection rejected。官方 issue #825 标记为 not planned，
 *                        也就是说 —— 这条路无法免弹窗，设计如此。
 *
 *   结论：只要传一个**非默认的 --user-data-dir**，两套机制都不生效 → 零弹窗、可无人值守。
 *
 * 因此本脚本支持两种账号模式：
 *
 *   A. userDataDir（推荐，零弹窗）
 *      每个账号一个独立 Chrome 数据目录。首次用 login 命令打开登录一次，之后永久有效。
 *      不干扰用户日常 Chrome，不需要退出它，连接时也不会弹任何确认框。
 *
 *   B. profileDirectory（复用用户现有 Chrome profile）
 *      沿用用户已有登录态，但**每次连接都需要人工点「允许」**，
 *      且切换账号必须完全退出用户的 Chrome。仅在没有条件用 A 时使用。
 *
 * 命令：
 *   init            扫描本机 Chrome profile（供与用户确认）
 *   check           比对 accounts.json 与现状，退出码 2 = 有变化需确认
 *   login [label]   打开指定账号（缺省=全部）用于人工登录
 *   run             正式导出（开跑前自动 check）
 *
 * 用法：
 *   export NODE_PATH=<node workspace>/node_modules
 *   node scripts/multi_account.js init
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { chromium } = require('playwright-core');
const A = require('./lib/alimama');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const CFG_PATH = process.env.ALIMAMA_ACCOUNTS || path.resolve('accounts.json');
const DEFAULT_PATTERN = process.env.ALIMAMA_PROFILE_PATTERN || '淘宝联盟';
const DEFAULT_PORT = Number(process.env.ALIMAMA_PORT || 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const safeName = (s) => String(s).replace(/[\/\\:*?"<>|\s]+/g, '_').slice(0, 60);
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ---------------- Chrome profile 扫描（默认目录） ----------------

function scanProfiles() {
  const ls = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, 'Local State'), 'utf8'));
  const cache = (ls.profile && ls.profile.info_cache) || {};
  const profiles = Object.entries(cache)
    .map(([dir, v]) => ({
      profileDirectory: dir,
      label: v.name || dir,
      gaia: v.gaia_name || '',
      userName: v.user_name || '',
    }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh'));
  return {
    chromeRunning: aliveIn(CHROME_DIR),
    lastActive: (Array.isArray(ls.profile && ls.profile.last_active_profiles)
      && ls.profile.last_active_profiles[0]) || (ls.profile && ls.profile.last_used) || null,
    profiles,
  };
}

// ---------------- 进程/端口 ----------------

function lockPid(dir) {
  try {
    const t = fs.readlinkSync(path.join(dir, 'SingletonLock'));
    const pid = Number(String(t).split('-').pop());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function aliveIn(dir) {
  const p = lockPid(dir);
  if (!p) return false;
  try { process.kill(p, 0); return true; } catch { return false; }
}

async function quitChromeIn(dir, { graceful = false, timeoutMs = 40000 } = {}) {
  if (!aliveIn(dir)) return;
  const pid = lockPid(dir);
  log(`  退出 Chrome (${path.basename(dir)}) ...`);
  try {
    if (graceful) execFileSync('osascript', ['-e', 'tell application "Google Chrome" to quit'], { stdio: 'ignore' });
    else if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!aliveIn(dir)) { await sleep(1500); return; }
    await sleep(1000);
  }
  if (pid && !graceful) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await sleep(1500);
}

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const d = (v) => { try { s.destroy(); } catch {} res(v); };
    s.on('connect', () => d(true)); s.on('error', () => d(false)); s.setTimeout(1500, () => d(false));
  });
}
async function waitPort(port, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await portOpen(port)) return true; await sleep(700); }
  return false;
}
function findFreePort(start) {
  return new Promise((res) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => tryPort(p + 1));
      srv.listen({ host: '127.0.0.1', port: p }, () => {
        const got = srv.address().port;
        srv.close(() => res(got));
      });
    };
    tryPort(start);
  });
}
function readWsFromFile(dir, timeoutMs = 20000) {
  return (async () => {
    const f = path.join(dir, 'DevToolsActivePort');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const [p, wsPath] = fs.readFileSync(f, 'utf8').trim().split('\n');
        if (p && wsPath) return `ws://127.0.0.1:${p}${wsPath}`;
      } catch {}
      await sleep(500);
    }
    return null;
  })();
}

// ---------------- 启动 ----------------

/** A 模式：独立数据目录，零弹窗 */
function launchDedicated(userDataDir, port) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(CHROME, [
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.unref();

  // 独立目录下 Chrome（147+）不写 DevToolsActivePort，从输出里解析
  let resolveWs;
  const wsPromise = new Promise((r) => { resolveWs = r; });
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolveWs(m[1]);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => resolveWs(null), 60000);
  return wsPromise;
}

/** B 模式：复用用户现有 profile（连接时会弹授权框，需人工点允许） */
function launchWithProfile(profileDirectory, port) {
  execFileSync('/usr/bin/open', ['-a', 'Google Chrome', '--args',
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--profile-directory=${profileDirectory}`], { stdio: 'ignore' });
}

/**
 * 连接。B 模式会因未点「允许」而 403，所以持续重试并提示；
 * A 模式没有授权流程，重试只是兜住启动抖动。
 */
async function connectCdp(ws, { expectApproval, timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  let warned = false, last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await chromium.connectOverCDP(ws, { timeout: 15000 });
    } catch (e) {
      last = e;
      const msg = String(e.message);
      if (expectApproval && /403|Forbidden|rejected/i.test(msg) && !warned) {
        log('  ⚠ Chrome 弹出了「允许远程调试?」确认框');
        log('     → 请到 Chrome 窗口点「允许」（这是复用现有 profile 的必然代价），脚本会自动继续');
        warned = true;
      }
      await sleep(3000);
    }
  }
  throw last || new Error('连接 CDP 超时');
}

// ---------------- 配置 ----------------

function loadConfig({ required = true } = {}) {
  if (!fs.existsSync(CFG_PATH)) {
    if (!required) return null;
    throw new Error(`未找到 ${CFG_PATH}。请先 init 并与用户确认后创建 accounts.json`);
  }
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg.biz = Number(process.env.ALIMAMA_BIZ || cfg.biz || 70);
  cfg.days = Number(process.env.ALIMAMA_DAYS || cfg.days || 365);
  cfg.chunk = Math.min(Number(process.env.ALIMAMA_CHUNK || cfg.chunk || 90), 90);
  cfg.port = Number(process.env.ALIMAMA_PORT || cfg.port || DEFAULT_PORT);
  cfg.profilePattern = cfg.profilePattern || DEFAULT_PATTERN;
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) throw new Error('accounts 为空');

  cfg.accounts.forEach((a) => {
    if (a.userDataDir) { a.userDataDir = expand(a.userDataDir); a.mode = 'A'; }
    else if (a.profileDirectory) a.mode = 'B';
    else throw new Error('每个账号必须给 userDataDir(A 模式) 或 profileDirectory(B 模式)');
    if (!a.label) a.label = path.basename(a.userDataDir || a.profileDirectory);
  });
  return cfg;
}

function detectChanges(cfg) {
  const profileAccounts = cfg.accounts.filter((a) => a.mode === 'B');
  const local = loadConfigLocalState();
  const byDir = new Map(local.profiles.map((p) => [p.profileDirectory, p]));

  // B 模式：配置里的 profile 已不存在
  const missing = profileAccounts
    .filter((a) => !byDir.has(a.profileDirectory))
    .map((a) => ({ profileDirectory: a.profileDirectory, label: a.label }));

  // B 模式：出现名字匹配关键字但未纳入配置的 profile（疑似新账号）
  // 注意：只有在确实用了 B 模式时才检查——A 模式完全不碰用户真实 Chrome profile
  const configured = new Set(profileAccounts.map((a) => a.profileDirectory));
  const re = new RegExp(cfg.profilePattern);
  const candidates = profileAccounts.length
    ? local.profiles.filter((p) => re.test(p.label) && !configured.has(p.profileDirectory))
    : [];

  // B 模式：Chrome 侧的 profile 名改了
  const renamed = profileAccounts
    .filter((a) => a.chromeName && byDir.has(a.profileDirectory)
      && byDir.get(a.profileDirectory).label !== a.chromeName)
    .map((a) => ({ profileDirectory: a.profileDirectory, was: a.chromeName,
      now: byDir.get(a.profileDirectory).label, label: a.label }));

  // A 模式：数据目录还不存在 → 说明从未执行过 login
  const uninitialized = cfg.accounts
    .filter((a) => a.mode === 'A' && !fs.existsSync(a.userDataDir))
    .map((a) => ({ label: a.label, userDataDir: a.userDataDir }));

  return {
    needsConfirm: !!(missing.length || candidates.length || renamed.length || uninitialized.length),
    missing, candidates, renamed, uninitialized,
  };
}
function loadConfigLocalState() {
  try { return scanProfiles(); } catch { return { profiles: [], chromeRunning: false, lastActive: null }; }
}

// ---------------- 单账号 ----------------

async function openAccount(acc, cfg, { keepOpen = false } = {}) {
  const isolated = acc.mode === 'A';
  const devToolsDir = isolated ? acc.userDataDir : CHROME_DIR;
  let port = acc.port || cfg.port;
  let wsPromise = null;

  if (isolated) {
    if (aliveIn(devToolsDir)) await quitChromeIn(devToolsDir);
    port = await findFreePort(port + 1);
    wsPromise = launchDedicated(acc.userDataDir, port);
  } else {
    await quitChromeIn(CHROME_DIR, { graceful: true });
    launchWithProfile(acc.profileDirectory, port);
  }

  if (!(await waitPort(port))) throw new Error(`调试端口 ${port} 未就绪`);
  let ws = wsPromise ? await wsPromise : null;
  if (!ws) ws = await readWsFromFile(devToolsDir);
  if (!ws) throw new Error('未能获得 CDP 地址');

  const browser = await connectCdp(ws, { expectApproval: !isolated });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('没有可用的 browser context');

  let page = (await ctx.pages()).find((p) => p.url().includes('overviewOrder'));
  if (!page) page = await ctx.newPage();
  if (!page.url().includes('overviewOrder')) {
    await page.goto(A.ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  }
  return { page, isolated, devToolsDir };
}

async function closeAccount({ isolated, devToolsDir }) {
  await quitChromeIn(devToolsDir, { graceful: !isolated }).catch(() => {});
}

async function cmdLogin(label) {
  const cfg = loadConfig();
  const targets = label
    ? cfg.accounts.filter((a) => a.label === label || a.profileDirectory === label)
    : cfg.accounts;
  if (!targets.length) throw new Error(`没有匹配的账号: ${label}`);

  for (const acc of targets) {
    log(`\n打开账号「${acc.label}」用于登录 (模式 ${acc.mode}) ...`);
    const { page, ...rest } = await openAccount(acc, cfg);
    let who = await A.whoami(page, cfg.biz);
    const t0 = Date.now();
    while (!who.loggedIn && Date.now() - t0 < 10 * 60 * 1000) {
      log(`  尚未登录（${who.reason || '未知'}）。请在弹出的 Chrome 里登录阿里妈妈…`);
      await sleep(8000);
      who = await A.whoami(page, cfg.biz);
    }
    if (who.loggedIn) log(`  ✅ 已登录: memberId=${who.memberId}${who.nick ? ' nick=' + who.nick : ''}`);
    else log('  ⚠ 10 分钟内未检测到登录，跳过');
    await closeAccount(rest);
  }
  log('\n登录流程结束。登录态已存在各自 profile/目录里，之后长期有效。');
}

async function cmdRun() {
  const cfg = loadConfig();
  const outRoot = path.resolve(process.env.ALIMAMA_OUT_ROOT || './alimama-data');

  const drift = detectChanges(cfg);
  if (drift.needsConfirm) {
    console.log(JSON.stringify({ action: 'aborted', reason: 'profile 有变化，需与用户确认', ...drift }, null, 2));
    process.exit(2);
  }

  const before = loadConfigLocalState();
  const useB = cfg.accounts.filter((a) => a.mode === 'B');
  log(`共 ${cfg.accounts.length} 个账号（A 模式 ${cfg.accounts.length - useB.length} 个 / B 模式 ${useB.length} 个）`);
  log(`biz=${cfg.biz} days=${cfg.days} chunk=${cfg.chunk} | 输出: ${outRoot}`);
  if (useB.length) log(`注意：B 模式账号每次连接都需要你在 Chrome 里点「允许」，且切换时**会退出你当前的 Chrome**`);

  const results = [];
  for (const acc of cfg.accounts) {
    log(`\n${'='.repeat(60)}\n账号: ${acc.label}  (模式 ${acc.mode})\n${'='.repeat(60)}`);
    let opened = null;
    try {
      opened = await openAccount(acc, cfg);
      const who = await A.whoami(opened.page, cfg.biz);
      if (!who.loggedIn) throw new Error(`未登录（${who.reason || '未知'}）。先执行 login 命令登录一次`);
      log(`  已登录: memberId=${who.memberId}${who.nick ? ' nick=' + who.nick : ''}`);

      const accOut = path.join(outRoot, safeName(acc.label));
      const res = await A.downloadAll(opened.page, {
        biz: cfg.biz, days: cfg.days, chunk: cfg.chunk,
        rawDir: path.join(accOut, 'raw'), outDir: accOut, label: acc.label,
      });
      results.push({ label: acc.label, mode: acc.mode, memberId: who.memberId, nick: who.nick, ...res });
    } catch (e) {
      const msg = String(e.message).split('\n')[0];
      log(`  失败: ${msg}`);
      results.push({ label: acc.label, mode: acc.mode, ok: false, error: msg });
    } finally {
      if (opened) await closeAccount(opened);
    }
  }

  // 还原用户原本在用的 profile（仅当用过 B 模式且原 profile 不在清单里）
  if (process.env.ALIMAMA_RESTORE !== '0' && useB.length && before.lastActive
      && !cfg.accounts.some((a) => a.profileDirectory === before.lastActive)) {
    try {
      log(`\n还原 Chrome 到原 profile: ${before.lastActive}`);
      await quitChromeIn(CHROME_DIR, { graceful: true });
      launchWithProfile(before.lastActive, cfg.port);
    } catch {}
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const summary = path.join(outRoot, '_summary.json');
  fs.writeFileSync(summary, JSON.stringify({ at: new Date().toISOString(), config: cfg, results }, null, 2), 'utf8');

  log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
  for (const r of results) {
    if (r.ok) log(`  ✅ ${r.label} [${r.mode}]  memberId=${r.memberId}  行数=${r.rows}  →  ${r.outFile}`);
    else log(`  ❌ ${r.label} [${r.mode}]  ${r.error}`);
  }
  log(`\n明细写入: ${summary}`);
}

function cmdInit() {
  const { profiles, lastActive, chromeRunning } = scanProfiles();
  const re = new RegExp(DEFAULT_PATTERN);
  console.log(JSON.stringify({
    action: 'init',
    chromeRunning, lastActive, defaultPattern: DEFAULT_PATTERN,
    totalProfiles: profiles.length,
    profiles,
    matchingProfiles: profiles.filter((p) => re.test(p.label)),
    recommendedMode: {
      A: 'userDataDir —— 独立数据目录，零弹窗、可无人值守、不影响用户日常 Chrome（推荐）',
      B: 'profileDirectory —— 复用现有 profile，但每次连接都要人工点「允许」，且需退出用户 Chrome',
    },
    hint: '请与用户确认：(1) 用 A 还是 B；(2) 哪些账号。写入 accounts.json 后先 check 再 run。'
      + ' A 模式下首次需用 login 命令登录一次。',
  }, null, 2));
}

function cmdCheck() {
  const cfg = loadConfig();
  const r = detectChanges(cfg);
  console.log(JSON.stringify({
    action: 'check', configPath: CFG_PATH,
    configured: cfg.accounts.map((a) => ({ label: a.label, mode: a.mode,
      target: a.userDataDir || a.profileDirectory })),
    ...r,
    hint: r.needsConfirm ? '检测到变化：与用户确认后再更新 accounts.json，然后 run' : '无变化，可以直接 run',
  }, null, 2));
  process.exit(r.needsConfirm ? 2 : 0);
}

(async () => {
  const cmd = process.argv[2] || 'run';
  try {
    if (cmd === 'init') cmdInit();
    else if (cmd === 'check') cmdCheck();
    else if (cmd === 'login') await cmdLogin(process.argv[3]);
    else if (cmd === 'run') await cmdRun();
    else throw new Error(`未知命令: ${cmd}（可用：init / check / login / run）`);
    process.exit(process.exitCode || 0);
  } catch (e) {
    console.error('ERR:', String(e.message).split('\n')[0]);
    process.exit(1);
  }
})();
