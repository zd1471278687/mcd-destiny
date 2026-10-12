---
name: mcd-destiny
description: 麦当劳「命运麦当劳」决策 Skill。治好点餐选择困难——结合预算、口味、门店营业状态与优惠券，用官方 query-nearby-stores / query-meals / query-store-coupons / calculate-price 真实数据，一次给出「尝鲜新品 / 经典之选 / 轻享低价」三套已算好价的方案，到手价最低的自动标推荐、正在促销的商品带划线原价；还能连抽今明后三天的运势周历。适用于"今天吃什么""帮我选个麦当劳套餐""点什么最划算""选择困难""随便给我推荐一顿"等需求。
---

# 命运麦当劳 / mcd-destiny

点麦当劳的真实痛点往往不是"没得选"，而是**选项太多、决策太累**，盯着满屏套餐纠结十分钟，最后还是点上次那套。本 Skill 反其道而行：不列一堆选项让你挑，而是用麦当劳 MCP 的真实数据**替你把决定做了**，并把价格、促销、最省券都算清楚，**停在"告诉你怎么点"这一步，不替你下单**。

## 何时使用

- 用户说：今天吃什么、帮我决定、随便推荐一顿、选择困难、懒得挑
- 用户说：点什么最划算、这几样怎么点最省、有没有在打折的
- 用户想要点餐有点仪式感/趣味：给我抽一套、今天手气如何、把这三天的都安排好

## 前置条件

- 需要麦当劳中国 MCP Token：https://open.mcd.cn/mcp
- 配置 `mcd-mcp`（见 `mcp-config.example.json`，Token 用环境变量 `MCD_MCP_TOKEN` 占位）
- 运行环境：Node.js 18+（使用原生 fetch）

## 核心原则

1. **替用户做决定**：面对选择困难，直接给出确定的方案，而不是又抛一堆选项。
2. **多方案而非独断**：给尝鲜 / 经典 / 低价三套风格，各自真实算价，把到手价最低者标为 ⭐ 推荐，兼顾"选择感"与"不增加决策负担"。
3. **可复现的命运感**：以「当天日期 + 口味 + 门店」为种子的可复现随机（mulberry32），同一天同一输入结果稳定，像每日运势；`--reroll` 才重新抽，避免用户反复刷新陷入新纠结。
4. **真实数据，禁止臆造**：
   - 门店是否营业只认 `query-nearby-stores` 的 `businessStatus`。
   - 促销标记只认菜单的 `discountInfos` 字段，或 `originalPrice > currentPrice`。
   - 价格只用 `calculate-price` 返回值，注意其单位为**分**（菜单价是**元**）。
5. **停在付款前**：核价与推荐给出后由用户自行决定，**不调用 `create-order`**。

## 标准工作流（destiny 主命令）

### 第 1 步：采集偏好

- 口味路线：any（全凭天意）/ chicken / beef / fish / veggie
- 预算上限（元，可不限）
- 城市 + 位置关键词

### 第 2 步：定门店（优先营业中）

```
query-nearby-stores(searchType=2, city, keyword, beType=1)
  → 用 businessStatus 过滤，优先营业中的门店，拿到 storeCode
```

### 第 3 步：拉菜单 + 识别促销

```
query-meals(storeCode, orderType=1, beType=1)
  → 拍平 data.meals 映射表（key=code），取 name / currentPrice / originalPrice / discountInfos
  → discountInfos 非空 或 originalPrice>currentPrice 即判定"正在促销"
```

### 第 4 步：抽三套不同风格的方案

- **尝鲜新品**：优先带促销标记的商品
- **经典之选**：优先无促销的常规商品
- **轻享低价**：优先价格较低的商品

用同一个可复现随机推进，各套去重；每套为"主食 + 搭配"的组合。

### 第 5 步：真实算价 + 逐张券取最省

```
query-store-coupons(...)              → 当前门店可用券（三套共用，只查一次）
calculate-price(items)                → 每套原价
calculate-price(items + 每张券)        → 逐张到手价，取最省
  → 到手价最低的方案标 ⭐ 推荐
```

### 第 6 步：揭晓

三套方案并排展示（含促销 ⚡ 与划线原价、原价、用券到手价、节省金额），附当日"手气"运势等级，并用 `campaign-calendar` 点出今天的活动。

## 其他命令

- `fortune`：运势周历，一次抽今 / 明 / 后三天各一套，今天实时算价、明后用菜单参考价（控制请求频率）。
- `save`：手动选商品，比遍当前门店所有可用券找最省点法。
- `points`：积分余额与过期提醒、积分商城可兑换（标注够不够换）、活动日历。
- `coupons`：查看可领券、一键领券、查卡包。
- `doctor`：连接自检。

## 输出要求

- 必须展示门店、每套方案的组成与价格来源（原价 / 用券到手价）。
- 促销标记必须来自真实 `discountInfos` 或划线价，不得编造"打折"。
- 价格来自官方 `calculate-price`（单位分，展示除以 100）；拿不到实时价时明确标为"菜单参考价"。
- 每次输出附：非麦当劳官方产品、价格与供应以官方实时结果为准。

## 诚实性护栏

- 券不满足门槛时，`calculate-price` 返回的到手价可能与原价相同——如实展示"未省"，不得伪造节省金额。
- 满减 / 满折 `query-promotions` 仅企业团餐 `beType=6` 可用，个人到店/外送场景**不做**"凑单满减"，省钱只做"同组合下哪张券最省"。
- 员工卡等账户级特殊权益不在个人 MCP 场景内，**不臆造**此类折扣。
- 遇到业务级错误（如 `code:508` 太火爆了）如实提示，不当作空数据。

## 硬约束

- 不跨品牌对比。
- **不代用户下单或支付**（不调用 `create-order` / `mall-create-order` / `party-order-create`）。
- 产物中不出现真实 Token / 个人信息。

## 文件说明

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 本 Skill 工作流定义 |
| `README.md` | 项目介绍、安装、使用示例、目标用户 |
| `MCP_INTEGRATION.md` | 实际使用的 MCP Server / Tool / 调用流程 |
| `CONTEST_DECLARATION.md` | 参赛声明（官方文件，内容不可改） |
| `workbuddy.md` | WorkBuddy 开发/使用上下文 |
| `mcp-config.example.json` | 配置示例（仅环境变量占位符） |
| `bin/mcd-destiny.js` | CLI 入口（destiny 为默认命令） |
| `src/mcpClient.js` | MCP Streamable HTTP 客户端 |
| `src/commands/*.js` | destiny / fortune / save / points / coupons 各命令实现 |
