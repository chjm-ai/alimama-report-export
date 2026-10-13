# alimama-report-export

阿里妈妈（淘宝联盟）报表数据导出技能 —— 接管真实 Chrome，调用后台官方导出接口，
按 ≤90 天分段下载近一年明细并合并。

## 它解决什么问题

1. **风控**：阿里对自动化浏览器识别很严，`agent-browser` 自带的 Chromium 会暴露
   `navigator.webdriver=true` + `HeadlessChrome` UA，账号密码登录必卡滑块。
   → 本技能接管用户本机真实 Chrome，指纹原生。
2. **异步导出**：页面导出是「提交任务 → 后台计算 → 生成文件 → 取链接」，
   点按钮很不稳定。→ 直接调 `ufc.rpt.*` 接口，轮询任务状态。
3. **Chrome 的授权弹窗**：这是最容易被绕进去的坑，见下。

## 关键前提：Chrome 的两套机制

| 机制 | 行为 | 后果 |
|---|---|---|
| Chrome 136+ | `--user-data-dir` 是**平台默认目录**时，`--remote-debugging-port` **被静默忽略** | 端口不开 |
| Chrome 144+ | 调试**真实 profile**（`chrome://inspect` 授权路径）时，**每次**连接都弹「允许远程调试?」 | 没人点 → `403 Connection rejected` |

官方 issue #825 把「每次都要点允许」标为 **not planned** —— 该路径**无法免弹窗**。

**只有传非默认 `--user-data-dir` 才能零弹窗。** 所以本技能**只做这一种模式**：
每个账号一个独立的 Chrome 数据目录。

```
账号数据目录（与日常 Chrome 完全隔离）
        ↑ 首次 login 一次，登录态永久保存
        ↑ 连接时不需要点任何「允许」
        ↑ 不需要退出使用者日常的 Chrome
```

> 早期版本曾提供「复用使用者现有 profile」的选项，**已彻底移除**：
> 那条路每次连接都必须人工点「允许」，切换账号还要先退出使用者的 Chrome，
> 对使用者是干扰，也容易让人搞不清该选哪个。只留一条路，行为唯一。

## 安装

把本目录放到技能加载路径下，例如：

```bash
ln -s "$(pwd)" ~/.workbuddy/skills/alimama-report-export
```

依赖 `playwright-core`（装到隔离的 node workspace，勿装全局）：

```bash
npm install playwright-core
```

运行前设置：

```bash
export NODE_PATH=<node workspace>/node_modules
```

## 使用

```bash
S=scripts   # 或 ~/.workbuddy/skills/alimama-report-export/scripts

node $S/multi_account.js init          # 扫描已有账号目录（不启动浏览器、不改配置）
node $S/multi_account.js check         # 比对配置与现状，退出码 2 = 有变化需确认
node $S/multi_account.js login [label] # 首次登录（缺省=全部账号）
node $S/multi_account.js run           # 正式导出（开跑前自动 check）
```

`accounts.json` 里每个账号**唯一必填的是 `label`**：

```jsonc
{
  "profileRoot": "~/.workbuddy/profiles/alimama",  // 账号数据目录根，每个账号 = profileRoot/<label>
  "biz": 70, "days": 365, "chunk": 90,
  "accounts": [ { "label": "淘宝联盟01" } ]
}
```

单账号（复用当前 CDP 连接）：

```bash
TARGET_URL=alimama.com node $S/pw.js run $S/run_all.js
```

主要环境变量：`ALIMAMA_DAYS`（回溯天数，默认 365）、`ALIMAMA_CHUNK`（单段天数，上限 90）、
`ALIMAMA_BIZ`（报表类型，默认 70=订单明细报表）、`ALIMAMA_OUT_ROOT`（输出根目录）。

## 目录

```
SKILL.md                    技能主文档（完整流程与铁律）
references/alimama-api.md   接口链路、bizType、字段、指纹取证、错误对照表
scripts/pw.js               通用 CDP 接管入口
scripts/multi_account.js    多账号编排（init/check/login/run）
scripts/run_all.js          单账号分段下载 + 合并
scripts/lib/alimama.js      公共逻辑
scripts/accounts.example.json  账号配置模板
```

## 注意：用户数据不入库

`.gitignore` 已排除 `accounts.json`、`alimama-data/`、`output/`、`raw/`、`*.csv`、
`profiles/` 等。账号清单与下载到的报表属于业务数据，请勿提交。

## 边界

只操作用户自己的账号与自己的数据；不尝试绕过验证码本身，而是用真实浏览器避免「误判」；
分段之间留间隔、轮询保持低频。
