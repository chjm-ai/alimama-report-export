#!/usr/bin/env node
/*
 * 阿里妈妈多账号导出（单模式：独立数据目录）
 *
 * 为什么只保留一种模式 —— Chrome 136+/144+ 的两套限制：
 *   136+：--user-data-dir 若是平台默认目录，--remote-debugging-port 被静默忽略。
 *   144+：调试「真实 profile」时，每一次 CDP 连接都会弹「允许远程调试?」对话框，
 *         没人点就返回 403 Connection rejected。官方 issue #825 标记 not planned，
 *         即无法通过配置免除。
 *   结论：只有非默认 --user-data-dir 能零弹窗。所以本技能只做这一种，
 *         不再提供「复用现有 profile」的选项，避免使用者混淆与互相干扰。
 *
 * 工作方式：每个账号一个独立 Chrome 数据目录；首次 login 一次，之后长期有效。
 *           不干扰使用者日常 Chrome，不需要退出它，连接时也不需要点任何确认。
 *
 * 命令：
 *   init            扫描已有账号目录（不启动浏览器、不改配置）
 *   check           比对 accounts.json 与磁盘现状，退出码 2 = 有变化需确认
 *   login [label]   打开指定账号（缺省=全部）用于人工登录
 *   run             正式导出（开跑前自动 check）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const A = require('./lib/alimama');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CFG_PATH = process.env.ALIMAMA_ACCOUNTS || path.resolve('accounts.json');
const DEFAULT_ROOT = '~/.workbuddy/profiles/alimama-accounts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const safeName = (s) => String(s).replace(/[\/\\:*?"<>|\s]+/g, '_').slice(0, 60);
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ---------------- 账号目录 ----------------

function accountDir(acc, cfg) {
  return acc.userDataDir ? expand(acc.userDataDir) : path.join(cfg.profileRoot, safeName(acc.label));
}

/** 账号登录后写入的标记，用于 init/check 显示已知账号 */
function stateFile(dir) { return path.join(dir, '.alimama-account.json'); }
function readState(dir) {
  try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')); } catch { return null; }
}
function writeState(dir, who) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile(dir), JSON.stringify({ ...who, at: new Date().toISOString() }, null, 2));
  } catch {}
}

/** 判断一个目录是否像一个「账号数据目录」（Chrome user-data-dir） */
function looksLikeAccountDir(dir) {
  try {
    if (fs.existsSync(stateFile(dir))) return true;
    return fs.existsSync(path.join(dir, 'Local State')) || fs.existsSync(path.join(dir, 'Default'));
  } catch { return false; }
}

/** 扫描 profileRoot 下已有的账号目录（只认像 Chrome user-data-dir 的） */
function discoverAccountDirs(cfg) {
  try {
    return fs.readdirSync(cfg.profileRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .filter((name) => looksLikeAccountDir(path.join(cfg.profileRoot, name)))
      .sort();
  } catch { return []; }
}

// ---------------- Chrome 生命周期 ----------------

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

async function quitChromeIn(dir, timeoutMs = 30000) {
  if (!aliveIn(dir)) return;
  const pid = lockPid(dir);
  log(`  退出该账号的 Chrome ...`);
  try { if (pid) process.kill(pid, 'SIGTERM'); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!aliveIn(dir)) { await sleep(1200); return; }
    await sleep(800);
  }
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await sleep(1200);
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

/** 启动该账号的独立 Chrome，返回解析 ws 地址的 Promise */
function launchAccount(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(CHROME, [
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${dir}`,
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

async function connectCdp(ws, tries = 6) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await chromium.connectOverCDP(ws, { timeout: 15000 }); }
    catch (e) { last = e; await sleep(2000); }
  }
  throw last;
}

// ---------------- 配置 ----------------

function loadConfig({ required = true } = {}) {
  if (!fs.existsSync(CFG_PATH)) {
    if (!required) return null;
    throw new Error(`未找到 ${CFG_PATH}。请先 init 并与用户确认后创建 accounts.json（模板见 scripts/accounts.example.json）`);
  }
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg.profileRoot = expand(cfg.profileRoot || DEFAULT_ROOT);
  cfg.biz = Number(process.env.ALIMAMA_BIZ || cfg.biz || 70);
  cfg.days = Number(process.env.ALIMAMA_DAYS || cfg.days || 365);
  cfg.chunk = Math.min(Number(process.env.ALIMAMA_CHUNK || cfg.chunk || 90), 90);
  cfg.basePort = Number(process.env.ALIMAMA_PORT || cfg.basePort || 9222);
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) throw new Error('accounts 为空');
  cfg.accounts.forEach((a, i) => {
    if (!a.label) a.label = `account${i + 1}`;
  });
  return cfg;
}

function detectChanges(cfg) {
  const onDisk = discoverAccountDirs(cfg);
  const configuredLabels = cfg.accounts.map((a) => safeName(a.label));

  // 配置了但目录不存在 → 还没跑过 login
  const uninitialized = cfg.accounts
    .filter((a) => !fs.existsSync(accountDir(a, cfg)))
    .map((a) => ({ label: a.label, userDataDir: accountDir(a, cfg) }));

  // 目录存在但未纳入配置 → 疑似新增账号
  const newAccounts = onDisk
    .filter((d) => !configuredLabels.includes(d))
    .map((d) => ({ dir: d, path: path.join(cfg.profileRoot, d), known: readState(path.join(cfg.profileRoot, d)) }));

  return {
    needsConfirm: !!(uninitialized.length || newAccounts.length),
    uninitialized, newAccounts,
  };
}

// ---------------- 单账号 ----------------

async function openAccount(acc, cfg) {
  const dir = accountDir(acc, cfg);
  if (aliveIn(dir)) await quitChromeIn(dir);
  const port = await findFreePort(cfg.basePort + 1);
  const wsPromise = launchAccount(dir, port);

  if (!(await waitPort(port))) throw new Error(`调试端口 ${port} 未就绪`);
  const ws = await wsPromise;
  if (!ws) throw new Error('未能从 Chrome 输出中解析出 CDP 地址');

  const browser = await connectCdp(ws);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('没有可用的 browser context');

  let page = (await ctx.pages()).find((p) => p.url().includes('overviewOrder'));
  if (!page) page = await ctx.newPage();
  if (!page.url().includes('overviewOrder')) {
    await page.goto(A.ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  }
  return { page, dir };
}

async function cmdLogin(label) {
  const cfg = loadConfig();
  const targets = label ? cfg.accounts.filter((a) => a.label === label) : cfg.accounts;
  if (!targets.length) throw new Error(`没有匹配的账号: ${label}`);

  for (const acc of targets) {
    log(`\n打开账号「${acc.label}」用于登录 ...`);
    const { page, dir } = await openAccount(acc, cfg);
    let who = await A.whoami(page, cfg.biz);
    const t0 = Date.now();
    while (!who.loggedIn && Date.now() - t0 < 10 * 60 * 1000) {
      log(`  尚未登录（${who.reason || '未知'}）。请在弹出的 Chrome 里登录阿里妈妈…`);
      await sleep(8000);
      who = await A.whoami(page, cfg.biz);
    }
    if (who.loggedIn) {
      log(`  ✅ 已登录: memberId=${who.memberId}${who.nick ? ' nick=' + who.nick : ''}`);
      writeState(dir, { memberId: who.memberId, nick: who.nick || '' });
    } else {
      log('  ⚠ 10 分钟内未检测到登录，跳过');
    }
    await quitChromeIn(dir);
  }
  log('\n登录流程结束。登录态存在各自的数据目录里，之后长期有效。');
}

async function cmdRun() {
  const cfg = loadConfig();
  const outRoot = path.resolve(process.env.ALIMAMA_OUT_ROOT || './alimama-data');

  const drift = detectChanges(cfg);
  if (drift.needsConfirm) {
    console.log(JSON.stringify({ action: 'aborted', reason: '账号目录有变化，需与用户确认', ...drift }, null, 2));
    process.exit(2);
  }

  log(`共 ${cfg.accounts.length} 个账号 | biz=${cfg.biz} days=${cfg.days} chunk=${cfg.chunk}`);
  log(`账号根目录: ${cfg.profileRoot}`);
  log(`输出根目录: ${outRoot}`);

  const results = [];
  for (const acc of cfg.accounts) {
    log(`\n${'='.repeat(60)}\n账号: ${acc.label}\n${'='.repeat(60)}`);
    let opened = null;
    try {
      opened = await openAccount(acc, cfg);
      const who = await A.whoami(opened.page, cfg.biz);
      if (!who.loggedIn) throw new Error(`未登录（${who.reason || '未知'}）。先执行 login 命令登录一次`);
      log(`  已登录: memberId=${who.memberId}${who.nick ? ' nick=' + who.nick : ''}`);
      writeState(opened.dir, { memberId: who.memberId, nick: who.nick || '' });

      const accOut = path.join(outRoot, safeName(acc.label));
      const res = await A.downloadAll(opened.page, {
        biz: cfg.biz, days: cfg.days, chunk: cfg.chunk,
        rawDir: path.join(accOut, 'raw'), outDir: accOut, label: acc.label,
      });
      results.push({ label: acc.label, memberId: who.memberId, nick: who.nick, ...res });
    } catch (e) {
      const msg = String(e.message).split('\n')[0];
      log(`  失败: ${msg}`);
      results.push({ label: acc.label, ok: false, error: msg });
    } finally {
      if (opened) await quitChromeIn(opened.dir).catch(() => {});
    }
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const summary = path.join(outRoot, '_summary.json');
  fs.writeFileSync(summary, JSON.stringify({ at: new Date().toISOString(), config: cfg, results }, null, 2), 'utf8');

  log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
  for (const r of results) {
    if (r.ok) log(`  ✅ ${r.label}  memberId=${r.memberId}  行数=${r.rows}  →  ${r.outFile}`);
    else log(`  ❌ ${r.label}  ${r.error}`);
  }
  log(`\n明细写入: ${summary}`);
}

function cmdInit() {
  const cfg = loadConfig({ required: false });
  const root = cfg ? cfg.profileRoot : expand(DEFAULT_ROOT);
  const onDisk = (() => {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .filter((name) => looksLikeAccountDir(path.join(root, name)))
        .map((name) => ({ dir: name, path: path.join(root, name), known: readState(path.join(root, name)) }))
        .sort((a, b) => a.dir.localeCompare(b.dir, 'zh'));
    } catch { return []; }
  })();

  console.log(JSON.stringify({
    action: 'init',
    accountRoot: root,
    rootExists: fs.existsSync(root),
    existingAccounts: onDisk,
    configured: cfg ? cfg.accounts.map((a) => ({ label: a.label, dir: accountDir(a, cfg) })) : [],
    configPath: CFG_PATH,
    configExists: fs.existsSync(CFG_PATH),
    howItWorks: [
      '每个账号 = 一个独立的 Chrome 数据目录，与使用者的日常 Chrome 完全隔离。',
      '首次用 login 命令打开并登录一次，登录态永久保存在该目录，之后无需再登录。',
      '不需要退出使用者日常的 Chrome，连接时也不需要点任何「允许调试」确认框。',
    ],
    hint: '请与用户确认要抓几个账号、分别叫什么名字，写入 accounts.json（模板见 scripts/accounts.example.json），'
      + '然后 node multi_account.js login 登录，最后 run。',
  }, null, 2));
}

function cmdCheck() {
  const cfg = loadConfig();
  const r = detectChanges(cfg);
  const detail = cfg.accounts.map((a) => {
    const dir = accountDir(a, cfg);
    return { label: a.label, dir, exists: fs.existsSync(dir), known: readState(dir) };
  });
  console.log(JSON.stringify({
    action: 'check', configPath: CFG_PATH, accounts: detail, ...r,
    hint: r.needsConfirm
      ? '检测到变化：与用户确认后再更新 accounts.json，然后 run'
      : '无变化，可以直接 run',
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
