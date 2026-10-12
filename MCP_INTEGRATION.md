# MCP 集成说明

本文件说明 `mcd-destiny` 实际使用的麦当劳 MCP Server、调用的 Tool、调用流程，以及这些调用带来的业务价值。文中记录的字段名与返回形态，均来自对麦当劳 MCP Server 的真实调用观察，而非凭空假设。

## 1. 使用的 MCP Server

- **Server**：麦当劳中国 MCP Server
- **接入地址**：`https://mcp.mcd.cn`
- **传输协议**：Streamable HTTP
- **鉴权**：请求头 `Authorization: Bearer <MCD_MCP_TOKEN>`
- **限流**：单 Token 600 次/分钟，超限返回 HTTP 429
- **错误码**：401（Token 无效/过期/缺失）、429（限流）

客户端实现见 `src/mcpClient.js`，完成 `initialize` 握手、`notifications/initialized` 通知、`tools/call` 调用。

## 2. 实际调用的 Tool

| Tool | 用在哪个命令 | 用途 |
|---|---|---|
| `query-nearby-stores` | destiny / save | 按城市 + 关键词查附近门店，优先营业中，拿到 `storeCode`/`beCode` |
| `query-meals` | destiny / save | 查门店在售菜单，拿到商品 `code` 与价格 |
| `query-store-coupons` | destiny / save | 查该门店 + 订单类型下**真正可用**的券 |
| `calculate-price` | destiny / save | 分别试算"不用券"与"用每张券"的到手价，用于比价 |
| `campaign-calendar` | destiny / points | 查当月活动日历，destiny 用于点出"今天还有什么活动" |

> `fortune`（运势周历）命令复用 destiny 的门店/菜单/过滤/随机逻辑，调用 `query-nearby-stores`、`query-meals` 各一次，只对"今天"那套调用一次 `calculate-price`，明/后天用菜单参考价，以控制请求频率（MCP 限流 600 次/分钟）。
| `query-my-account` | points | 查可用积分、累计积分、将过期积分 |
| `mall-points-products` | points | 查积分商城可兑换商品 |
| `available-coupons` | coupons | 查麦麦省当前可领券 |
| `auto-bind-coupons` | coupons | 一键领取所有可领券 |
| `query-my-coupons` | coupons | 查卡包现有券 |

## 3. 核心调用流程（destiny · 今日天选套餐）

`destiny` 是本项目主命令，解决"选择困难"痛点。调用链如下：

```
query-nearby-stores(searchType=2, city, keyword, beType=1)
        │  → 用 businessStatus 过滤，优先选营业中的门店
        ▼
query-meals(storeCode, orderType=1, beType=1)
        │  → 拍平菜单，得到候选商品（含 code / name / currentPrice / originalPrice / discountInfos）
        │  → 据 discountInfos 非空 或 originalPrice>currentPrice 识别"正在促销"的商品
        ▼
[本地] 按口味关键词 + 预算过滤候选池
[本地] 以「当天日期 + 口味 + 门店」为种子的可复现随机，抽出【三套不同风格】的方案：
        尝鲜新品(优先促销商品) / 经典之选(优先非促销) / 轻享低价(优先低价)
        ▼
query-store-coupons(...)                → 当前门店可用券（三套方案共用，只查一次）
对每套方案：
  calculate-price(items)                → 该方案原价
  calculate-price(items + 每张券)        → 逐张到手价，取最省
        ▼
取到手价最低的方案标记 ⭐ 推荐
        ▼
campaign-calendar()                    → 点出今天的活动
        ▼
揭晓【三套方案并排对比】+ 各自最省价 + 促销标记 + 今日活动
```

"命运感"的实现：随机数发生器用 `mulberry32`，种子由当天日期与用户输入推导，所以**同一天同一输入结果稳定**；`--reroll` 时改用时间戳作种子以重新抽取。这保证了"每日运势"般的确定性体验，而不是让用户反复刷新陷入新的纠结。

关键规则（均来自 Tool 定义，已在代码中遵守）：

- `beType`：1=到店自取（不传 `beCode`），到店场景 `orderType` 固定为 1。
- `calculate-price` 返回的金额单位是**分**，展示时除以 100。
- 菜单里的价格字段是**「元」字符串**（如 `"17.9"`），用于本地预算过滤前会转成分。
- 满减/满折 `query-promotions` 仅企业团餐（`beType=6`）可用，个人场景不适用，故本项目**不使用**该 Tool。

## 4. 返回结构的真实观察与处理

麦当劳 MCP 的 Tool 返回并不统一，`mcd-destiny` 对三种形态都做了容错（见 `src/mcpClient.js` 与 `src/format.js`）：

1. **纯 JSON**，统一包装为 `{ success, code, message, data }`，业务数据在 `data`。
   - `success:false` 或 `code != 200`（如 508「太火爆了」）视为业务错误并抛出提示。
2. **说明文字 + JSON 混排**（如 `query-nearby-stores`、`query-meals`、`mall-points-products` 会在 JSON 前后附带展示指引文字）。客户端用括号配对算法从文本中抽取 JSON。
3. **纯 Markdown 文本**（如 `available-coupons`、`campaign-calendar`）。客户端识别为文本，destiny 从中正则提取"活动标题"作为今日提示。

真实字段名（已据此编码，不靠猜）：

- `query-nearby-stores` → `data` 为数组，字段 `storeCode` / `storeName` / `address` / `beCode` / `businessStatus`（是否营业）/ `distance`。
- `query-meals` → `data.categories[].meals[]` 仅含 `code` + `tags`；商品名与价格在 `data.meals` 这个**以 code 为键的映射表**里：`name` / `currentPrice`（现价）/ `originalPrice`（划线原价）均为「元」字符串，`discountInfos` 为优惠类型（`null`=无优惠，否则如"促销优惠"/"早餐卡优惠"/"麦金卡优惠"）。本项目据 `discountInfos` 非空或 `originalPrice>currentPrice` 判定商品是否在促销，并在天选套餐中标注 ⚡。
- `calculate-price` → 金额在 `data` 下，单位为**分**。
- `query-my-account` → `data.availablePoint` / `accumulativePoint` / `currentMouthExpirePoint` / `nextMouthExpirePoint`（注意 API 原文把 Month 拼成了 `Mouth`，代码按原文匹配）。
- `mall-points-products` → `data` 为数组，字段 `spuName` / `point`（所需积分）/ `price` / `status`（2=上架）。

## 5. 业务价值

- **把"做决定"这件事外包出去**：面对选择困难，destiny 直接给一个确定答案，而不是又抛一堆选项；可复现随机带来"今日运势"般的仪式感。
- **决定得务实**：优先营业中的门店、尊重预算与口味、并顺手算出最省券，决策不是瞎抽而是有真实数据兜底。
- **多方案而非独断**：给出尝鲜/经典/低价三套风格，各自真实算价、标出促销（来自 `discountInfos`），把到手价最低者标为推荐——既有选择感又不增加决策负担。
- **省钱部分量化**：用 `calculate-price` 真实算出每张券的到手价，直接给最优解和节省金额，而非凭券面文案猜测。
- **容错优先**：面对 SIT 环境的繁忙错误（508）与多种返回形态，工具不会崩，会给出清晰提示。

## 6. 复现方式

```bash
npm install
cp .env.example .env    # 填入真实 MCD_MCP_TOKEN
node bin/mcd-destiny.js doctor    # 验证连接
node bin/mcd-destiny.js           # 抽今日天选套餐
```
