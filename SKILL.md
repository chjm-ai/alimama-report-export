---
name: alimama-report-export
description: 从阿里妈妈/淘宝联盟（pub.alimama.com）后台导出报表数据，如订单明细报表、整体效果报表等。当用户提出「下载/导出阿里妈妈报表」「导出联盟订单数据」「淘宝联盟订单明细」「下载推广订单」等需求，或需要在被风控拦截的淘系页面（pub.alimama.com、login.taobao.com）上操作时使用。核心做法是接管用户本机已登录的真实 Chrome（CDP），再调用页面官方导出接口分段下载并合并。
agent_created: true
---

# 阿里妈妈报表导出

> **维护位置**：规范仓库是 `~/Desktop/Repos/AI_Skills/alimama-report-export`（git 管理）。
> `~/.workbuddy/skills/alimama-report-export` 是指向它的**软链接**，仅用于让 WorkBuddy 加载。
> 改动请直接改仓库里的文件。
>
> **不要提交用户数据**：仓库内 `.gitignore` 已排除 `accounts.json`（除 `accounts.example.json` 模板外）、
> `alimama-data/`、`output/`、`raw/`、`*.csv`、`profiles/` 等。

## 用途

从阿里妈妈（淘宝联盟）后台导出报表数据。难点不在数据本身，而在**两点**：

1. 阿里风控会拦截"长得像机器人"的浏览器，账号密码登录会卡在滑块验证码；
2. 页面导出是**异步任务**（提交 → 后台计算 → 生成文件 → 取下载链接），直接点按钮很难稳定拿到结果。

本 skill 的做法：**接管用户本机已登录的真实 Chrome**（指纹原生、登录态现成），然后直接调用页面自己的导出接口，按 ≤90 天分段提交任务、轮询进度、取 OSS 链接下载，最后合并。

## 铁律：不要用 agent-browser 自带的浏览器

`agent-browser` 启动的 Chromium 会被识别为自动化，实测指纹：

```
navigator.webdriver = true
User-Agent 含 HeadlessChrome/<ver>
全新空白 profile（无历史、无扩展）
```

结果就是**滑块验证码永远过不去**（阿里会直接判定机器人）。

试过但**无效**的办法：`--args '--no-sandbox,--disable-blink-features=AutomationControlled'`。因为底层走 CDP，Playwright 仍会暴露 `navigator.webdriver`。

> 附注：`--args` / `AGENT_BROWSER_ARGS` 的值是**逗号或换行分隔**，用空格分隔会让 Chrome 直接崩溃（报 `CDP response channel closed`）。

正确路径是接入真实 Chrome，见下文。

## 步骤一：接入用户本机的真实 Chrome

### 1. 确认 CDP 端口

Chrome 136+ 禁止对**默认 user-data-dir** 开启 `--remote-debugging-port`。实测（Chrome 155）下面这条可用：

```bash
open -a "Google Chrome" --args --remote-debugging-port=9222
```

然后确认端口真的在监听，并读取浏览器 ws 地址：

```bash
lsof -nP -iTCP:9222 -sTCP:LISTEN
cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
# 首行=端口，次行=/devtools/browser/<id>
```

**该文件可能是上次遗留的旧文件**，端口没监听就说明没生效，不能盲信文件内容。

### 2. 用 Playwright 连接

```js
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP('ws://127.0.0.1:9222/devtools/browser/<id>');
```

- **必须传完整 `ws://` 地址**。传 `http://127.0.0.1:9222` 会失败：Playwright 请求的是 `/json/version/`（带尾斜杠），Chrome 返回 404。
- 直接用 `scripts/pw.js`，它已封装好：自动读 `DevToolsActivePort`、连接重试、按 URL 选页。

### 3. 必须遵守的四条

| 规则 | 原因 |
|---|---|
| **绝不调用 `browser.close()`** | 那会关掉用户的浏览器。进程退出即断开，不需显式关闭 |
| **一个脚本只连一次** | 每新建一次 CDP 连接，Chrome 就弹一次「允许调试」。分多次跑会把用户弹到崩溃 |
| **长任务用后台运行** | 前台 Bash 调用结束会把子进程连同 Chrome 一起回收 |
| **按 URL 关键字选页，别用 `pages[0]`** | `chrome://inspect` 等内部页常常占据第一个位置 |

## 步骤二：调用导出接口

以「订单明细报表」为例（`bizType=70`），全部是 GET，挂在
`https://pub.alimama.com/openapi/param2/1/gateway.unionpub/` 下，**必须带 `_tb_token_`**（从 `document.cookie` 读取）。

```
1) ufc.rpt.taskstart.json?bizType=70&startTime=YYYY-MM-DD 00:00:00&endTime=YYYY-MM-DD 23:59:59
   → {"data":{"idList":"<taskId>"}}

2) ufc.rpt.process.list.json?bizType=70&pageNo=1&pageSize=50
   → 列表；process == "100" 表示算完

3) ufc.rpt.filelink.json?bizType=70&idList=<taskId>
   → {"data":{"urlList":[{"url":"<OSS 签名地址>"}]}}

4) 直接 fetch 该 OSS 地址 → CSV（UTF-8 带 BOM）
```

约束：

- **单次最多 90 天**；查询与下载支持**近一年** → 按 90 天分段下载再合并。
- 下载中心的报表**只保留 30 天**，要定期下。
- 字段与 bizType 对照见 `references/alimama-api.md`。

在页面上下文里发请求（自带 Cookie，无需自己拼鉴权）：

```js
await page.evaluate(async ({api, name, extra}) => {
  const token = (document.cookie.match(/_tb_token_=([^;]+)/) || [])[1] || '';
  const qs = new URLSearchParams({ t: String(Date.now()), _tb_token_: token, ...extra }).toString();
  const res = await fetch(api + name + '?' + qs, { credentials: 'include' });
  return await res.text();
}, { api: '/openapi/param2/1/gateway.unionpub/', name: 'ufc.rpt.taskstart.json', extra: {...} });
```

## 步骤三：用现成脚本跑

`scripts/pw.js` 是通用 CDP 入口：

```bash
export NODE_PATH=<node workspace>/node_modules
node scripts/pw.js probe                      # 看连到了谁 + 指纹
node scripts/pw.js run <task.js>              # 跑自定义任务
node scripts/pw.js shot /tmp/x.png
```

`scripts/run_all.js` 是成品任务：自动按 90 天分段 → 提交 → 轮询 → 下载 → 去重合并。
公共逻辑在 `scripts/lib/alimama.js`（接口封装、身份识别 `whoami`、分段下载 `downloadAll`、合并 `mergeCsv`）。
多账号见**步骤四**，用 `scripts/multi_account.js`（独立运行，自己管理 Chrome 切换）。

```bash
export NODE_PATH=<node workspace>/node_modules
export TARGET_URL=alimama.com                 # 用于精确选中阿里妈妈那个标签页
node scripts/pw.js run scripts/run_all.js
```

产物：

- `ALIMAMA_RAW_DIR`（默认 `./alimama-data/raw`）分段 CSV
- `ALIMAMA_OUT_DIR`（默认 `./alimama-data/output`）合并后的 `alimama-订单明细报表-近一年.csv`

> 依赖：`playwright-core`。若未安装：
> `npm install playwright-core`（装到隔离的 node workspace，勿装全局）。

## 步骤四：多账号顺序导出

### 前提：Chrome 的两套安全机制（决定了整个设计，务必先读）

Chrome 136+ / 144+ 加了两道限制，网上很多教程已经过时：

| 机制 | 内容 | 后果 |
|---|---|---|
| **136+** | `--user-data-dir` 若是**平台默认目录**，`--remote-debugging-port` 被**静默忽略** | 端口根本不开，`/json/version` connection refused |
| **144+** | 调试「真实 profile」走的是 `chrome://inspect/#remote-debugging` 的**授权流程**：**每一次**连接都弹「允许远程调试?」对话框 | 没人点 → WebSocket 升级返回 **403 `Connection rejected`** |

官方 issue（#825）把「每次都要点允许」标记为 **not planned**——**这条路无法免弹窗，是设计如此。**

> 实测证据：复用默认 profile 启动后，CDP 握手返回
> `HTTP/1.1 403 Forbidden` + body `Connection rejected`；
> 换用非默认 `--user-data-dir` 后，同样的代码直接连通，全程零点击。

**结论：只要传一个非默认的 `--user-data-dir`，两套机制都不生效 —— 零弹窗、可无人值守。**

**所以本技能只做一种模式：每个账号一个独立 Chrome 数据目录。**

> 曾经提供过「复用使用者现有 profile」的选项，**已彻底移除**。
> 原因就是上表第 144+ 条：那条路每次连接都必须人工点「允许」，而且切换账号还要先把使用者
> 日常的 Chrome 退掉。这两种行为对使用者都是干扰，也容易让人搞不清该选哪个。
> 只留一条路，行为和预期都唯一。

该模式的三个好处：

| | 说明 |
|---|---|
| 免弹窗 | 完全不需要点任何东西，可无人值守 |
| 不干扰 | 独立实例，**不需要退出使用者日常的 Chrome** |
| 登录成本 | 首次 `login` 登录一次，之后长期有效（登录态就在该目录里） |

### 四个动作

```bash
export NODE_PATH=<node workspace>/node_modules
cd <工作目录>
S=~/.workbuddy/skills/alimama-report-export/scripts

node $S/multi_account.js init          # 扫描已有账号目录（不启动浏览器、不改配置）
node $S/multi_account.js check         # 比对配置与现状，退出码 2 = 有变化需确认
node $S/multi_account.js login [label] # 首次登录（缺省=全部账号）
node $S/multi_account.js run           # 正式跑（开跑前自动 check，有变化即中止）
```

退出码：`0` 正常 / `2` **需要与用户确认** / `1` 报错。

`login` 会打开该账号的浏览器并停在阿里妈妈页，脚本轮询检测登录（最多 10 分钟），
检测到就自动收工。**每个账号只需要登录一次，之后长期有效。**

### 首次初始化流程（必须与用户确认）

1. 执行 `init`，得到 JSON：账号根目录、**磁盘上已有的账号目录**（含各目录上次登录到的 `memberId`）、
   以及当前配置。这一步**不启动浏览器、不改配置**。
2. **问用户要抓几个账号、分别叫什么名字。** 不要自动决定。
3. 写入 `accounts.json`（结构见 `scripts/accounts.example.json`）：

```jsonc
{
  "profileRoot": "~/.workbuddy/profiles/alimama",  // 账号数据目录根；每个账号 = profileRoot/<label>
  "biz": 70, "days": 365, "chunk": 90, "basePort": 9222,
  "accounts": [
    { "label": "淘宝联盟01" },
    { "label": "淘宝联盟02" }
  ]
}
```

每个账号**唯一必填的就是 `label`**（决定数据目录名和输出子目录名）。
需要把某个账号的数据目录放到别处时，才加 `userDataDir` 覆盖。

4. 逐个 `login`（可一次跑全部）：`node scripts/multi_account.js login`
5. `check` 确认无变化后 `run`。

### 后续调用流程（增量确认）

每次调用**先跑 `check`**（`run` 内部也会先查一遍）：

- **有变化 → 中止并输出 JSON**（退出码 2），把变化项交给用户确认后再更新 `accounts.json`
- 变化分两类：

| 类型 | 含义 | 处理 |
|---|---|---|
| `uninitialized` | 配置里的账号目录还不存在 | 说明没跑过 `login`，提醒用户先登录 |
| `newAccounts` | 磁盘上出现未纳入配置的账号目录 | **疑似新增账号**，问用户是否加入配置 |

- **无变化 → 直接跑**，不再打扰用户。

### 流程细节

```
对每个账号：
  1. 若该账号目录已有实例 → 退出它（SIGTERM，只影响这一个账号）
  2. 直接 spawn Chrome 二进制：
     --no-sandbox --remote-debugging-port=<空闲端口> --remote-allow-origins=*
     --user-data-dir=<账号目录> --no-first-run --no-default-browser-check
     （端口从 basePort+1 起自动找空闲的，避免抢占）
  3. 从子进程输出解析 "DevTools listening on ws://..."
     —— Chrome 147+ 在自定义 user-data-dir 下不写 DevToolsActivePort，只能这么取
  4. connectOverCDP → 打开订单概览页 → whoami 校验登录 → 分段下载 + 合并
  5. 结束时 SIGTERM 该实例
全部账号跑完 → 写 alimama-data/_summary.json
```

`whoami` 成功后会把 `memberId` 写进 `<账号目录>/.alimama-account.json`，
这样 `init` / `check` 不用启动浏览器就能显示每个账号上次登录的是谁。

输出结构：

```
alimama-data/
├── _summary.json
├── 淘宝联盟01/
│   ├── raw/batch1_2025-10-14_2026-01-11.csv
│   └── alimama-订单明细报表-近365天.csv
└── 淘宝联盟02/…
```

**每个账号独立目录**，不会互相覆盖；`_summary.json` 记录每个账号的 `memberId`，
**避免把 A 账号数据误存成 B**。

### 注意事项

- 全程**不需要**使用者退出日常 Chrome，也**不会**弹任何授权框。
- 改 `label` 会同时改数据目录名和输出子目录名；已登录过的账号改名等于换了个新账号，要重新登录。
- 账号数据目录里含 cookie / 登录态，**不要提交到 git、不要外传**（仓库 `.gitignore` 已排除）。

### 安全校验（已内置）

下载前会调用 `ufc.rpt.process.list.json` 确认登录态并取出 `memberId`：

- 被重定向到 `login.taobao.com` → 判定未登录，等待人工登录
- 接口 `success != true` → 判定未登录
- 结果写进 `_summary.json`，**避免把 A 账号数据误存成 B**

## 常见坑

- **文件名看起来"没有扩展名"**：阿里返回的原始文件名极长且含 `~`、括号、全角字符，Finder 会截断并把扩展名藏起来。**自己重命名为短名 + 明确 `.csv`**。
- **磁盘上文件有 `.csv` 但用户说没有**：先 `ls -lb` 核实真实文件名，再解释是 Finder 显示问题。
- **Bash 默认沙箱有网络命名空间隔离**，连不上本机调试端口（表现为 `ECONNREFUSED 127.0.0.1:9222`）→ 需要非沙箱执行。
- **连不上/403**：Chrome 对并发 CDP 连接会拒绝，`scripts/pw.js` 已带 4 次重试。
- **表格"暂无数据"**：多半是时间范围只选了"今天"。测试账号无成交数据也会这样，属正常。
- **登录态失效**：让用户在弹出的 Chrome 窗口里手动登录一次即可，不要在自动化里代填账号密码。

## 边界

- 只操作用户自己的账号与自己的数据。
- 不要尝试绕过验证码本身；正确做法是使用真实浏览器规避"误判"。
- 保持低频：分段之间留 5 秒以上间隔，轮询 10 秒一次。
