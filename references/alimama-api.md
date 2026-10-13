# 阿里妈妈导出接口与页面结构参考

## 页面

| 项 | 值 |
|---|---|
| 订单概览页 | `https://pub.alimama.com/portal/v2/effect/order/overviewOrder/page/index.htm` |
| 页面标题 | 淘宝联盟 · 生态伙伴 |
| 业务板块 | 数据报表 → 订单明细报表 / 推广订单明细 |
| UI 组件库 | mux（阿里内部库），DOM class 前缀 `mux-` |
| 弹窗结构 | `.mux-modal-content` / `.mux-modal-body` / `.mux-modal-footer` |

弹窗内两个标签：**下载报表**（提交任务）和**下载记录**（看进度、取文件）。

## 接口

Base：`https://pub.alimama.com/openapi/param2/1/gateway.unionpub/`

所有接口为 **GET**，公共参数：

| 参数 | 说明 |
|---|---|
| `t` | 毫秒时间戳 |
| `_tb_token_` | 反 CSRF 令牌，从 `document.cookie` 读取（形如 `_tb_token_=7db16b781ee64`） |
| `bizType` | 报表类型，订单明细报表为 `70` |

### 1) 提交导出任务

```
GET ufc.rpt.taskstart.json
    ?bizType=70
    &startTime=2025-10-14 00:00:00
    &endTime=2026-01-11 23:59:59

→ {"data":{"idList":"1008263968"},"success":true,"resultCode":200,"bizErrorCode":0}
```

单次跨度 ≤ 90 天，超出会被拒。查询与下载支持近一年。

### 2) 查询任务列表（相当于「下载记录」）

```
GET ufc.rpt.process.list.json?bizType=70&pageNo=1&pageSize=50
```

响应：

```json
{"data":{"result":[{
  "id": 1008263968,
  "process": "100",
  "status": 1,
  "fileName": "2026-10-13 00:00:00~2026-10-13 14:42:03-时间类型(付款时间)-推广者身份(全部)-订单状态(全部)-订单明细报表",
  "createTime": "2026-10-13 14:42:06",
  "memberId": 64912046,
  "bizType": 70
}],"pageNo":1,"totalCount":1,"hasNext":false}}
```

- `process == "100"` → 计算完成
- 列表按创建时间倒序，**新任务在 page 1 首位**（可用任务 id 差集识别本次提交的任务）
- 报表文件在服务端**只保留 30 天**

### 3) 取下载地址

```
GET ufc.rpt.filelink.json?bizType=70&idList=1008263968

→ {"data":{"allDone":true,"urlList":[{"id":1008263968,"url":"https://union-file-center.oss-cn-zhangjiakou.aliyuncs.com/online_xxx?Expires=...&Signature=..."}]}}
```

OSS 地址带签名，**可直接下载，无需 Cookie**。响应头 `response-content-disposition` 里的 filename 即报表名。

### 4) 下载

直接 GET 上一步的 `url`，得到 UTF-8（带 BOM）的 CSV。

## bizType 对照

| bizType | 报表 | 状态 |
|---|---|---|
| 70 | 订单明细报表 | ✅ 已验证 |

页面上「数据报表」菜单里还有其他报表，bizType 待补：

整体效果报表、推广位效果报表、商品效果报表、店铺效果报表、活动效果报表、权益效果报表、奖励活动报表、渠道效果报表、会员效果报表。

> 补 bizType 的方法：在目标报表页点「下载报表」→ 点「确定」，抓 `ufc.rpt.taskstart.json` 请求里的 `bizType` 值。

## 订单明细报表 CSV 字段（58 列）

```
点击时间, 创建时间, 付款时间, 结算时间, 淘宝付款时间,
商品ID, 商品图片, 商品标题, 掌柜旺旺, 店铺名称, 商品数量, 商品单价, 类目名称,
订单编号, 子订单号, 订单状态, 平台类型, 付款金额, 结算金额,
佣金比率, 佣金金额, 佣金分成比率, 佣金提成, 付款预估佣金收入, 结算预估佣金收入,
产品类型, 补贴比率, 补贴金额, 补贴类型, 补贴分成比率, 补贴提成,
付款预估补贴收入, 结算预估补贴收入, 收入比率, 付款预估收入, 结算预估收入,
平台技术服务费比率, 平台技术服务费, 平台技术服务费类型,
平台专项服务费比率, 平台专项服务费, 平台专项服务费类型,
推广者身份, 媒体ID, 媒体名称, 推广位ID, 推广位名称, 成交平台, 维权标签,
渠道关系ID, 会员运营ID, 定金付款时间, 定金淘宝付款时间, 定金付款金额,
团长ID, 团长昵称, 营销类型, 佣金类型, 淘礼金ID
```

无数据时只有表头（约 947 字节）。

## 风控指纹取证

用 agent-browser 自带 Chromium 打开淘系页面时，实测：

```
navigator.webdriver = true
navigator.userAgent = "... HeadlessChrome/155.0.0.0 Safari/537.36"
navigator.plugins.length = 5
```

对比接管真实 Chrome（Chrome 155）：

```
navigator.webdriver = false
navigator.userAgent = "... Chrome/155.0.0.0 Safari/537.36"
```

前者会在 `login.taobao.com/havanaone` 登录页被滑块反复拦截——**不是用户操作问题，是浏览器指纹被判为机器人**。

## Chrome 调试端口

- `DevToolsActivePort` 位置：`~/Library/Application Support/Google/Chrome/DevToolsActivePort`
- 格式：首行端口，次行 `/devtools/browser/<uuid>`
- **可能是旧文件**。使用前务必 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 确认在监听
- `SingletonLock` 指向的 PID 可用于判断 Chrome 是否真的在运行（指向死进程说明已退出，锁是陈旧的）
- Chrome 136+ 对默认 user-data-dir 会忽略 `--remote-debugging-port`；实测
  `open -a "Google Chrome" --args --remote-debugging-port=9222` 在 Chrome 155 上可行
- 配置文件目录（用于判断哪个 profile）：`~/Library/Application Support/Google/Chrome/Local State` 的
  `profile.info_cache`，含各 profile 的 `name` 与 `gaia_name`

## 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `connect ECONNREFUSED 127.0.0.1:9222` | 端口没监听／沙箱网络命名空间隔离 | 确认端口 + 非沙箱执行 |
| `Unexpected status 404 ... /json/version/` | Playwright 用了 http 形式（带尾斜杠） | 改传完整 `ws://` 地址 |
| `Connection rejected 403` | 用了**默认 user-data-dir**，落进 Chrome 144+ 的授权流程 | 改用独立 `--user-data-dir`（本技能的做法） |
| Chrome 反复弹「允许调试」 | 同上：调试真实 profile 每次都弹 | 改用独立 `--user-data-dir`，该模式完全不弹 |
| 页面选到了 `chrome://inspect` | 用了 `pages[0]` | 用 `TARGET_URL` 关键字匹配 |
| 表格「暂无数据」 | 时间范围只有"今天"／账号无数据 | 调大范围；测试账号空属正常 |
| 文件名像没有扩展名 | 阿里原始名超长含 `~`/括号，Finder 截断 | 自行重命名为短名 + `.csv` |
| 启动输出「正在现有的浏览器会话中打开。」且端口没起来 | 同一 user-data-dir 已有 Chrome 进程，启动参数被转发 | 用各自独立的 `--user-data-dir`；或先退出该目录的实例 |

## 多账号相关（Chrome 限制）

**本技能只采用一种模式：每个账号一个独立的 `--user-data-dir`。** 原因见下。

- 同一 `--user-data-dir` 下**只能有一个 Chrome 进程**。
  已有实例时，`Chrome --profile-directory="Profile 6"` 会输出
  「正在现有的浏览器会话中打开。」而**不**开端口——参数被转发丢弃。
  所以"多个 profile 各开一个调试端口"做不到。
- 想让多个账号并发/互不干扰，唯一可行的是**各自独立 `--user-data-dir`**
  （顺带也绕开了下面两套安全机制）。
- 判断某个目录的 Chrome 是否在运行：`readlink <dir>/SingletonLock` → `hostname-<pid>`，
  再 `kill -0 <pid>`。指向死进程说明锁是陈旧的、Chrome 已退出。
- 退出该实例用 `kill -TERM <pid>` 即可（用 default 目录时才需要
  `osascript -e 'tell application "Google Chrome" to quit'`）。

### 取 CDP 地址（独立 `--user-data-dir`）

自己 spawn 进程，从子进程输出解析：

```
DevTools listening on ws://127.0.0.1:9224/devtools/browser/469bd822-f941-404b-b4d2-bd0657fa5908
```

**Chrome 147+ 在自定义 `user-data-dir` 下不写 `DevToolsActivePort` 文件**，只能这么取。
（只有默认目录才会写那个文件。）

> `GET /json/version` **不可靠**：行为不稳定，有时正常返回 JSON，有时返回空 / 404（与 Host 头无关）。
> 不要用它来发现地址。

### Chrome 136+ / 144+ 的两套机制（这是所有「连不上」问题的根因）

| 机制 | 行为 |
|---|---|
| Chrome 136+ | `--user-data-dir` 为**平台默认目录**时，`--remote-debugging-port` **被静默忽略**，端口不开、无任何提示 |
| Chrome 144+ | 调试**真实 profile**（`chrome://inspect/#remote-debugging` 授权路径）时，**每一次** CDP 连接都会弹「允许远程调试?」对话框；未点允许 → WebSocket 升级返回 **403 `Connection rejected`** |

官方 issue #825 已将「每次都要点允许」标为 **not planned** —— 无法通过配置免除。
**这正是本技能不提供「复用真实 profile」选项的原因。**

**只要传非默认 `--user-data-dir`，两套机制都不生效 → 零弹窗。**

实测握手对比：

```
无 Origin：  HTTP/1.1 403 Forbidden   body: Connection rejected
带 Origin：  HTTP/1.1 403 Forbidden   body: Rejected an incoming WebSocket connection from the
             http://127.0.0.1:9222 origin. Use the command line flag --remote-allow-origins=...
```

注意：`--remote-allow-origins=*` **只能解决 Origin 那一类** 403；
「Connection rejected」属于授权流程，加这个参数**没有用**，必须改用独立目录。

### 平台默认 user-data-dir 位置（这些目录要避开）

- macOS：`~/Library/Application Support/Google/Chrome`
- Windows：`%LOCALAPPDATA%\Google\Chrome\User Data`
- Linux：`~/.config/google-chrome`

把默认 profile 的文件**复制**到自定义目录通常救不回登录态（cookie 加密与目录绑定），
所以不要指望用拷贝的方式「既复用登录又免弹窗」——在独立目录里老实登录一次更省事。

