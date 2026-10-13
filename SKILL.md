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

因此本技能有 A / B 两种账号模式，**默认用 A**：

| | A. `userDataDir`（推荐） | B. `profileDirectory` |
|---|---|---|
| 免弹窗 | ✅ 完全不需要点任何东西 | ❌ **每次连接都要人工点「允许」** |
| 干扰用户日常 Chrome | ✅ 无（独立实例，不用退出它） | ❌ 切换账号必须先完全退出用户的 Chrome |
| 登录成本 | 首次用 `login` 命令登录一次，之后长期有效 | 沿用已有登录态 |
| 取 CDP 地址 | 从子进程输出解析 `DevTools listening on ws://…`（Chrome 147+ 不写 `DevToolsActivePort`） | 读默认目录的 `DevToolsActivePort` |
| 适用 | 无人值守、批量多账号 | 只图省一次登录、且能接受手动点允许 |

> 另外：Chrome 同一份 user-data-dir 只能跑一个进程。
> `Chrome --profile-directory="Profile 6"` 在已有实例时会输出
> 「正在现有的浏览器会话中打开。」而**不**开端口——这是 B 模式必须退出 Chrome 的原因。

### 四个动作

```bash
export NODE_PATH=<node workspace>/node_modules
cd <工作目录>
S=~/.workbuddy/skills/alimama-report-export/scripts

node $S/multi_account.js init          # 扫描 profile 清单（不启动 Chrome、不改配置）
node $S/multi_account.js check         # 比对配置与现状，退出码 2 = 有变化需确认
node $S/multi_account.js login [label] # A 模式首次登录（缺省=全部账号）
node $S/multi_account.js run           # 正式跑（开跑前自动 check，有变化即中止）
```

退出码：`0` 正常 / `2` **需要与用户确认** / `1` 报错。

`login` 会打开该账号的浏览器并停在阿里妈妈页，脚本轮询检测登录（最多 10 分钟），
检测到就自动收工。**A 模式每个账号只需要跑一次**。

### 首次初始化流程（必须与用户确认）

1. 执行 `init`，得到 JSON：本机全部 Chrome profile（`profileDirectory` / `label` / `gaia`）、
   按关键字（默认「淘宝联盟」）匹配的 profile，以及两种模式的说明。
2. **把清单拿给用户确认两件事**：
   - 用 A 模式还是 B 模式（**默认推荐 A**：免弹窗、不干扰日常浏览器）
   - 要抓哪些账号
   不要自动全选。
3. 按确认结果写 `accounts.json`（结构见 `scripts/accounts.example.json`）：

```jsonc
{
  "profilePattern": "淘宝联盟", "biz": 70, "days": 365, "chunk": 90, "port": 9222,
  "accounts": [
    // A 模式（推荐）：标签页里唯一需要维护的字段是 label
    { "userDataDir": "~/.workbuddy/profiles/alimama-01", "label": "淘宝联盟01" },
    // B 模式：profileDirectory 是稳定标识；chromeName 仅用于检测改名，别手改
    { "profileDirectory": "Profile 6", "label": "淘宝联盟02", "chromeName": "淘宝联盟02" }
  ]
}
```

4. A 模式账号执行 `login` 登录一次（可指定 label 逐个来）。
5. `check` 确认无变化后 `run`。

### 后续调用流程（增量确认）

每次调用**先跑 `check`**（`run` 内部也会先查一遍）：

- **有变化 → 中止并输出 JSON**（退出码 2），把变化项交给用户确认后再更新 `accounts.json`
- 变化分四类：

| 类型 | 适用模式 | 含义 | 处理 |
|---|---|---|---|
| `missing` | B | 配置里的 profile 在 Chrome 里已不存在 | 阻塞性，必须修配置 |
| `candidates` | B | 出现名字匹配关键字但未纳入配置的 profile | 疑似新账号，问用户是否加入 |
| `renamed` | B | Chrome 侧 profile 名改了（比对 `chromeName`，**不是** `label`） | 提示用户，更新 `chromeName` |
| `uninitialized` | A | 配置的 `userDataDir` 还不存在 | 说明没跑过 `login`，提醒用户登录 |

- **无变化 → 直接跑**，不再打扰用户。

### 流程细节

```
A 模式账号（推荐，顺序无副作用）：
  1. 若该目录已有实例 → 退出它
  2. 直接 spawn Chrome 二进制：
     --no-sandbox --remote-debugging-port=<空闲端口> --remote-allow-origins=*
     --user-data-dir=<该账号目录> --no-first-run --no-default-browser-check
  3. 从子进程输出解析 "DevTools listening on ws://..."（Chrome 147+ 不写 DevToolsActivePort）
  4. connectOverCDP → 打开订单概览页 → whoami 校验 → 下载 → 合并
  5. 结束时 SIGTERM 该实例

B 模式账号（会弹授权框）：
  1. 退出用户的 Chrome，等它真正退出（SingletonLock 指向的 pid 消失）
  2. open -a "Google Chrome" --args --remote-debugging-port=<port>
     --remote-allow-origins=* --profile-directory=<dir>
  3. 等端口就绪 → 读默认目录的 DevToolsActivePort → 连接
     ⚠ 连接会 403，需**用户手动点「允许」**；脚本会持续重试并打印提示（最多 3 分钟）
  4. 同上做下载
  5. 结束时退出 Chrome
全部账号跑完：还原用户原本在用的 profile，并写 alimama-data/_summary.json
```

`connectCdp` 在收到 403 时会打印「请点允许」并**持续重试**，不会一次失败就退出。

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

- 切换账号会**退出用户当前的 Chrome**。开跑前先确认用户没有正在填的表单之类的活。
- 想保留用户原来的窗口布局，别设 `ALIMAMA_RESTORE=0`（默认会还原）。
- profile 目录名（`Profile 6`）是稳定标识，`label` 只是显示名。改 `label` 会改变输出子目录名。

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
