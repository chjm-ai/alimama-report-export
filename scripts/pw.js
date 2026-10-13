// 通过 CDP 连接「用户本机正在运行的真实 Chrome」——不注入启动参数，指纹保持原生
//
// 关键设计（改动前请先读 SKILL.md 的「必须遵守的四条」）：
//   1. 绝不调用 browser.close()，否则会关掉用户的浏览器
//   2. 一个脚本只建一次连接，否则 Chrome 会反复弹「允许调试」
//   3. 按 URL 关键字选页，不用 pages[0]（chrome:// 内部页常占据首位）
//
// 用法：
//   node pw.js probe
//   node pw.js info
//   node pw.js shot /tmp/x.png
//   node pw.js goto <url>
//   node pw.js eval '<js表达式>'
//   node pw.js run <task.js>        # module.exports = async ({page, ctx, browser, pages}) => {}
//
// 环境变量：
//   CDP_URL     显式指定，如 ws://127.0.0.1:9222/devtools/browser/xxx（优先级最高）
//   TARGET_URL  页面 URL 关键字，用于在多标签中选中目标页
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');

function resolveCdp() {
  if (process.env.CDP_URL) return process.env.CDP_URL;
  const f = path.join(CHROME_DIR, 'DevToolsActivePort');
  if (fs.existsSync(f)) {
    const [port, wsPath] = fs.readFileSync(f, 'utf8').trim().split('\n');
    if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  }
  throw new Error('未找到 CDP 地址：设置 CDP_URL，或先执行 open -a "Google Chrome" --args --remote-debugging-port=9222');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectRetry(cdp, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await chromium.connectOverCDP(cdp, { timeout: 20000 });
    } catch (e) {
      last = e;
      process.stderr.write(`[cdp] 第 ${i} 次连接失败: ${String(e.message).split('\n')[0]}\n`);
      await sleep(1200 * i);
    }
  }
  throw last;
}

(async () => {
  const cmd = process.argv[2] || 'probe';
  const cdp = resolveCdp();
  process.stderr.write(`[cdp] ${cdp}\n`);

  const browser = await connectRetry(cdp);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('没有可用的 browser context');

  function pickPage() {
    const all = ctx.pages();
    if (process.env.TARGET_URL) {
      const hit = all.find((p) => p.url().includes(process.env.TARGET_URL));
      if (hit) return hit;
    }
    return all.find((p) => /^https?:/.test(p.url())) || all[0];
  }
  const page = pickPage();

  const dump = async () => {
    const list = ctx.pages();
    for (const p of list) {
      let t = '';
      try { t = await p.title(); } catch {}
      console.log('  PAGE:', t.slice(0, 40), '|', p.url().slice(0, 110));
    }
    return list;
  };

  if (cmd === 'probe') {
    console.log(`contexts=${browser.contexts().length} pages=${(await dump()).length}`);
    if (page) {
      const fp = await page.evaluate(() => ({ wd: navigator.webdriver, ua: navigator.userAgent }));
      console.log('FP:', JSON.stringify(fp));
    }
  } else if (cmd === 'info') {
    const r = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      tables: [...document.querySelectorAll('table')].map((x) => ({
        cols: [...x.querySelectorAll('thead th')].map((th) => (th.innerText || '').trim()),
        rows: x.querySelectorAll('tbody tr').length,
      })),
    }));
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'shot') {
    const out = process.argv[3] || '/tmp/pw-shot.png';
    await page.screenshot({ path: out });
    console.log('SAVED:', out, '| URL:', page.url());
  } else if (cmd === 'goto') {
    await page.goto(process.argv[3], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    console.log('URL:', page.url(), '|', await page.title());
  } else if (cmd === 'eval') {
    const r = await page.evaluate(process.argv[3]);
    console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  } else if (cmd === 'run') {
    const mod = require(path.resolve(process.argv[3]));
    await mod({ page, ctx, browser, pages: ctx.pages() });
  } else {
    throw new Error('未知命令: ' + cmd);
  }

  // 绝不调用 browser.close()：那会关掉用户的浏览器。进程退出即断开。
  process.exit(0);
})().catch((e) => { console.error('ERR:', String(e.message).split('\n')[0]); process.exit(1); });
