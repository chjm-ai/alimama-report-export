// 单账号导出任务 —— 复用当前 CDP 连接（由 pw.js 建立）
//
// 用法：
//   export TARGET_URL=alimama.com
//   node pw.js run run_all.js
//
// 环境变量：ALIMAMA_BIZ / ALIMAMA_DAYS / ALIMAMA_CHUNK /
//          ALIMAMA_RAW_DIR / ALIMAMA_OUT_DIR
//
// 多账号请用 multi_account.js（它自己管理 Chrome 切换）
const path = require('path');
const A = require('./lib/alimama');

module.exports = async ({ page }) => {
  const biz = Number(process.env.ALIMAMA_BIZ || 70);
  const days = Number(process.env.ALIMAMA_DAYS || 365);
  const chunk = Math.min(Number(process.env.ALIMAMA_CHUNK || 90), 90);

  const who = await A.whoami(page, biz);
  if (!who.loggedIn) {
    throw new Error(`当前未登录（${who.reason || '未知'}），请先在 Chrome 窗口登录`);
  }
  console.log(`当前账号: memberId=${who.memberId}${who.nick ? ' nick=' + who.nick : ''}`);

  const rawDir = path.resolve(process.env.ALIMAMA_RAW_DIR || './alimama-data/raw');
  const outDir = path.resolve(process.env.ALIMAMA_OUT_DIR || './alimama-data/output');

  const res = await A.downloadAll(page, { biz, days, chunk, rawDir, outDir });
  if (!res.ok) throw new Error(res.error || '导出失败');
  console.log(`完成: ${res.outFile}（数据行 ${res.rows}）`);
};
