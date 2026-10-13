// 阿里妈妈报表导出 —— 公共逻辑（供 run_all.js / multi_account.js 复用）
const path = require('path');
const fs = require('fs');

const API = '/openapi/param2/1/gateway.unionpub/';
const ORDER_URL =
  'https://pub.alimama.com/portal/v2/effect/order/overviewOrder/page/index.htm';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 在页面上下文里调接口，自带 Cookie */
async function api(page, name, params) {
  return page.evaluate(
    async ({ api, name, extra }) => {
      const token = (document.cookie.match(/_tb_token_=([^;]+)/) || [])[1] || '';
      const qs = new URLSearchParams({ t: String(Date.now()), _tb_token_: token, ...extra }).toString();
      const res = await fetch(api + name + '?' + qs, { credentials: 'include' });
      return { status: res.status, text: await res.text() };
    },
    { api: API, name, extra: params }
  );
}

async function listTasks(page, biz) {
  const r = await api(page, 'ufc.rpt.process.list.json', { bizType: biz, pageNo: 1, pageSize: 50 });
  try { return JSON.parse(r.text).data.result || []; } catch { return []; }
}

/**
 * 识别当前登录身份。未登录返回 {loggedIn:false}
 * 依赖 process.list 能调通（未登录会失败或被重定向到登录页）
 */
async function whoami(page, biz) {
  if (/login\.taobao\.com|havanaone/.test(page.url())) {
    return { loggedIn: false, reason: '被重定向到登录页' };
  }
  const r = await api(page, 'ufc.rpt.process.list.json', { bizType: biz, pageNo: 1, pageSize: 1 });
  let j = null;
  try { j = JSON.parse(r.text); } catch {}
  if (!j || j.success !== true) {
    return { loggedIn: false, reason: `接口返回异常(status=${r.status})`, raw: r.text.slice(0, 120) };
  }
  const t = (j.data && j.data.result && j.data.result[0]) || null;
  let nick = '';
  try {
    nick = await page.evaluate(() => {
      const el = document.querySelector('[class*="user-name"],[class*="userName"],[class*="nick"],[class*="account-name"]');
      return (el && el.innerText ? el.innerText : '').trim().slice(0, 40);
    });
  } catch {}
  return { loggedIn: true, memberId: t ? t.memberId : null, nick };
}

/** 确保有「订单概览」页可用；返回该 page */
async function ensureOrderPage(ctx) {
  const pages = ctx.pages();
  let page = pages.find((p) => p.url().includes('overviewOrder'));
  if (page) return page;
  page = pages.find((p) => /^https?:/.test(p.url()));
  if (!page) page = await ctx.newPage();
  if (!page.url().includes('overviewOrder')) {
    await page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
  }
  return page;
}

function buildRanges(days, chunk) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));

  const ranges = [];
  let cur = new Date(start);
  while (cur <= today) {
    let end = new Date(cur);
    end.setDate(end.getDate() + (chunk - 1));
    if (end > today) end = new Date(today);
    ranges.push({ from: ymd(cur), to: ymd(end) });
    cur = new Date(end);
    cur.setDate(cur.getDate() + 1);
  }
  return ranges;
}

const POLL_MS = 10000;
const GAP_MS = 5000;

async function runRange(page, biz, idx, total, from, to, rawDir) {
  const tag = `[${idx}/${total}] ${from} ~ ${to}`;
  console.log(`${tag} 提交任务...`);

  const before = new Set((await listTasks(page, biz)).map((t) => t.id));
  const res = await api(page, 'ufc.rpt.taskstart.json', {
    bizType: biz,
    startTime: `${from} 00:00:00`,
    endTime: `${to} 23:59:59`,
  });
  console.log(`${tag} taskstart -> ${res.text.slice(0, 160)}`);

  const deadline = Date.now() + 15 * 60 * 1000;
  let task = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const list = await listTasks(page, biz);
    task = list.find((t) => !before.has(t.id) && String(t.process) === '100');
    if (task) break;
    const pending = list.find((t) => !before.has(t.id));
    console.log(pending ? `${tag} 计算中 process=${pending.process}` : `${tag} 等待任务出现...`);
  }
  if (!task) { console.log(`${tag} 超时未完成，跳过`); return null; }
  console.log(`${tag} 完成 id=${task.id}`);

  const link = await api(page, 'ufc.rpt.filelink.json', { bizType: biz, idList: String(task.id) });
  const url = JSON.parse(link.text)?.data?.urlList?.[0]?.url;
  if (!url) { console.log(`${tag} 未取到下载地址: ${link.text.slice(0, 160)}`); return null; }

  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const file = path.join(rawDir, `batch${idx}_${from}_${to}.csv`);
  fs.writeFileSync(file, buf);
  console.log(`${tag} 已保存 ${path.basename(file)} (${buf.length} 字节)`);
  return { file, from, to, bytes: buf.length };
}

/** 合并：保留一个表头，按整行去重（阿里 CSV 无稳定主键，用整行做 key） */
function mergeCsv(files) {
  const seen = new Set();
  let header = null;
  const rows = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    if (!header) header = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const key = lines[i].slice(0, 400);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(lines[i]);
    }
  }
  return { header, rows };
}

/**
 * 主流程：分段下载 + 合并
 * @returns {{ok:boolean, outFile?:string, rows?:number, segments?:Array, error?:string}}
 */
async function downloadAll(page, opts) {
  const { biz, days, chunk, rawDir, outDir, label } = opts;
  const tag = label ? `[${label}] ` : '';
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const ranges = buildRanges(days, chunk);
  console.log(`${tag}分 ${ranges.length} 段（每段<=${chunk} 天）`);

  const saved = [];
  for (let i = 0; i < ranges.length; i++) {
    try {
      const s = await runRange(page, biz, i + 1, ranges.length, ranges[i].from, ranges[i].to, rawDir);
      if (s) saved.push(s);
    } catch (e) {
      console.log(`${tag}第 ${i + 1} 段出错: ${String(e.message).split('\n')[0]}`);
    }
    await sleep(GAP_MS);
  }
  if (!saved.length) return { ok: false, error: '所有分段都失败', segments: [] };

  const { header, rows } = mergeCsv(saved.map((s) => s.file));
  const outFile = path.join(outDir, `alimama-订单明细报表-近${days}天.csv`);
  fs.writeFileSync(outFile, '\uFEFF' + [header, ...rows].join('\n') + '\n', 'utf8');
  console.log(`${tag}合并完成: ${outFile}（数据行 ${rows.length}）`);
  if (rows.length === 0) console.log(`${tag}提示：0 行通常表示该账号/该时段没有成交数据。`);

  return { ok: true, outFile, rows: rows.length, segments: saved };
}

module.exports = {
  API, ORDER_URL,
  sleep, ymd,
  api, listTasks, whoami, ensureOrderPage,
  buildRanges, runRange, mergeCsv, downloadAll,
};
