/**
 * 命运麦当劳 · 今日天选套餐（destiny 命令）—— 本项目的主命令
 *
 * 解决的痛点不是“太贵”，而是「每天不知道吃什么、点餐选择困难」。
 * 思路：不给你一堆选项让你纠结，而是——
 *   1. 查到你附近正在营业的门店（query-nearby-stores）
 *   2. 拉这家店的真实菜单（query-meals）
 *   3. 按你的预算 + 口味偏好过滤
 *   4. 用“带约束的随机”抽出一套【天选套餐】（主食 + 搭配），给你一个确定的答案
 *   5. 查当前门店可用券，用 calculate-price 逐张试算，附上“这么点最省”
 *   6. 顺带告诉你今天有什么活动（campaign-calendar）
 *
 * “命运感”来自可复现的随机：同一天 + 同一组输入，结果稳定（像每日运势），
 * 加 --reroll 可以重新抽一次。
 */
import { select, input, confirm } from '@inquirer/prompts';
import ora from 'ora';
import {
  ui,
  yuan,
  hr,
  fenToYuan,
  pickArray,
  firstOf,
  safeString,
  unwrap,
  banner,
  card,
  fortuneLevel,
} from '../format.js';

// 口味偏好 -> 命中餐品名的关键词
export const TASTE_KEYWORDS = {
  chicken: ['鸡', '麦辣', '麦乐鸡', '板烧', '鸡翅', '鸡腿'],
  beef: ['牛', '巨无霸', '安格斯', '吉士汉堡', '双层'],
  fish: ['鱼', '麦香鱼'],
  veggie: ['素', '蔬', '沙拉'],
  any: [],
};

const DESTINY_LINES = [
  '命运已经替你选好了，别再纠结了。',
  '今天的你，注定属于这一餐。',
  '算法掷出的骰子，落在了这里。',
  '别问为什么，问就是天选。',
  '选择困难？今天不存在的。',
];

export async function runDestiny(client, opts = {}) {
  console.log(banner());
  console.log(ui.dim('\n治好你的麦当劳选择困难。你只管吃，选什么交给命运。\n'));

  // ---- 口味 & 预算 & 地点 ----
  const taste =
    opts.taste ||
    (await select({
      message: '今天想吃点什么路线？',
      choices: [
        { name: '随便，全凭天意', value: 'any' },
        { name: '鸡肉控', value: 'chicken' },
        { name: '牛肉汉堡党', value: 'beef' },
        { name: '鱼堡/清淡', value: 'fish' },
        { name: '素食/沙拉', value: 'veggie' },
      ],
      default: 'any',
    }));

  const budgetInput =
    opts.budget ??
    (await input({
      message: '预算上限（元，直接回车表示不限）：',
      default: '',
    }));
  const budgetFen = parseBudgetFen(budgetInput);

  const beType = 1; // 到店自取
  const orderType = 1;
  const city = opts.city || (await input({ message: '城市（如：上海）：' }));
  const keyword =
    opts.keyword || (await input({ message: '位置关键词（如：陆家嘴）：' }));

  // ---- 1. 门店（优先营业中）----
  const storesRaw = await withSpinner('寻找附近营业中的门店…', () =>
    client.callTool('query-nearby-stores', {
      searchType: 2,
      city: city.trim(),
      keyword: keyword.trim(),
      beType,
    })
  );
  const storeList = pickArray(unwrap(storesRaw), ['stores', 'list', 'data']);
  if (!storeList.length) {
    console.log(ui.warn('\n没找到门店，换个关键词再试试。'));
    console.log(ui.dim(safeString(storesRaw)));
    return;
  }
  // 命运也要务实：优先选营业中的
  const openStores = storeList.filter((s) => firstOf(s, ['businessStatus']) !== false);
  const store = (openStores.length ? openStores : storeList)[0];
  const storeCode = String(firstOf(store, ['storeCode', 'code']));
  const storeName = firstOf(store, ['storeName', 'name'], '某家麦当劳');
  const baseArgs = { storeCode, orderType, beType };

  console.log(ui.dim(`命运选中的门店：${storeName}`));

  // ---- 2. 菜单 ----
  const mealsRaw = await withSpinner('翻开今天的菜单…', () =>
    client.callTool('query-meals', baseArgs)
  );
  const products = flattenProducts(unwrap(mealsRaw));
  if (!products.length) {
    console.log(ui.warn('\n这家店暂时没查到可售商品，换家店或稍后再试。'));
    console.log(ui.dim(safeString(mealsRaw)));
    return;
  }

  // ---- 3. 抽多套不同风格的方案 ----
  const seed = makeSeed(opts.reroll ? Date.now() : todaySeed(), taste, storeCode);
  const rng = mulberry32(seed);
  const luck = fortuneLevel(rng());

  const plans = buildPlans(products, taste, budgetFen, rng);
  if (!plans.length) {
    console.log(ui.warn('\n按你的预算/口味没凑出套餐，放宽点再试（比如提高预算）。'));
    return;
  }

  // ---- 4. 查一次可用券（各方案共用）----
  console.log('\n' + hr());
  const couponsRaw = await withSpinner('看看这家店有什么券…', () =>
    client.callTool('query-store-coupons', baseArgs).catch(() => null)
  );
  const coupons = normalizeCoupons(couponsRaw);

  // ---- 5. 为每套方案真实算价（原价 + 最省券）----
  for (const plan of plans) {
    const items = plan.items.map((p) => ({ productCode: String(p.code), quantity: 1 }));
    const basePriced = await withSpinner(`计算「${plan.label}」价格…`, () =>
      client.callTool('calculate-price', { ...baseArgs, items }).catch(() => null)
    );
    plan.baseTotal = extractTotal(basePriced);
    plan.best = await findBestCoupon(client, baseArgs, items, coupons);
    plan.payTotal = plan.best?.total ?? plan.baseTotal;
  }

  // 推荐：到手价最低的那套
  const priced = plans.filter((p) => p.payTotal != null);
  const recommended = priced.length
    ? priced.reduce((a, b) => (b.payTotal < a.payTotal ? b : a))
    : plans[0];

  // ---- 6. 揭晓（多方案卡片 + 运势等级）----
  console.log('\n' + card('✨ 今日天选 · 命运给了你几条路 ✨', buildHeaderLines(storeName, luck), { color: luck.color }));

  for (const plan of plans) {
    const isRec = plan === recommended;
    const title = (isRec ? '⭐ ' : '') + plan.label + (isRec ? ' · 推荐' : '');
    console.log('\n' + card(title, buildPlanLines(plan), { color: isRec ? luck.color : ((s) => ui.dim(s)) }));
  }

  console.log('\n' + luck.color('  ' + DESTINY_LINES[Math.floor(rng() * DESTINY_LINES.length)]));

  // 今日活动点缀
  const cal = await client.callTool('campaign-calendar', {}).catch(() => null);
  const todayLine = extractTodayHint(cal);
  if (todayLine) {
    console.log('\n' + hr());
    console.log(ui.label('顺带一提，今天还有：'));
    console.log('  ' + ui.dim(todayLine));
  }

  console.log('\n' + ui.dim('不满意？加 --reroll 让命运再掷一次骰子。'));
  console.log(ui.dim('价格与供应以麦当劳官方下单时实时结果为准。'));

  // 可选：想不想看看怎么点得更省（引导到 save）
  if (!opts.yes && process.stdout.isTTY) {
    const more = await confirm({
      message: '想手动挑商品、比遍所有券找最省吗？（运行 save）',
      default: false,
    }).catch(() => false);
    if (more) {
      console.log(ui.dim('\n运行：mcd-destiny save --city ' + city + ' --keyword ' + keyword));
    }
  }
}

/* ---------------- 核心：带约束的随机抽套餐 ---------------- */

/**
 * 抽一套“主食 + 搭配”的组合。
 * 规则：先抽一个主食（池里随机），再在预算允许时追加一个搭配项，尽量不超预算。
 */
export function pickCombo(pool, allProducts, budgetFen, rng) {
  if (!pool.length) return [];

  const main = pool[Math.floor(rng() * pool.length)];
  const combo = [main];
  let spent = main.priceFen ?? 0;

  // 搭配候选：全量里价格较低的，排除已选
  const sides = allProducts
    .filter((p) => p.code !== main.code && p.priceFen != null)
    .sort((a, b) => a.priceFen - b.priceFen);

  if (sides.length) {
    const affordable =
      budgetFen == null ? sides : sides.filter((p) => spent + p.priceFen <= budgetFen);
    const candidates = (affordable.length ? affordable : sides).slice(0, 12);
    if (candidates.length && rng() > 0.15) {
      const side = candidates[Math.floor(rng() * candidates.length)];
      combo.push(side);
    }
  }
  return combo;
}

/**
 * 构造多套不同风格的方案（最多 3 套，去重）。
 * 风格偏好只影响"主食优先从哪些候选里抽"，不臆造规则：
 *   - 尝鲜新品：优先带促销标记/划线价的商品（真实 discountInfos/originalPrice）
 *   - 经典之选：优先无促销的常规商品
 *   - 轻享低价：优先价格较低的商品
 * 每套都用同一个 rng 推进，保证"当天固定"的可复现性。
 */
export function buildPlans(products, taste, budgetFen, rng) {
  const pool = filterPool(products, taste, budgetFen);
  if (!pool.length) return [];

  const onSale = pool.filter((p) => p.onSale);
  const regular = pool.filter((p) => !p.onSale);
  const cheap = [...pool].sort((a, b) => (a.priceFen ?? 1e9) - (b.priceFen ?? 1e9));

  const styleDefs = [
    { label: '尝鲜新品', mains: onSale.length ? onSale : pool },
    { label: '经典之选', mains: regular.length ? regular : pool },
    { label: '轻享低价', mains: cheap },
  ];

  const plans = [];
  const seenKeys = new Set();
  for (const def of styleDefs) {
    const combo = pickCombo(def.mains, products, budgetFen, rng);
    if (!combo.length) continue;
    const key = combo.map((p) => p.code).sort().join('|');
    if (seenKeys.has(key)) continue; // 去重：风格撞车就跳过
    seenKeys.add(key);
    plans.push({ label: def.label, items: combo });
  }
  return plans;
}

/** 对一组商品，逐张券试算，返回到手价最低的 {coupon,total}；无更优则 null */
async function findBestCoupon(client, baseArgs, items, coupons) {
  let best = null;
  for (const c of coupons) {
    const itemsC = items.map((it, i) =>
      i === 0
        ? {
            ...it,
            ...(c.id ? { couponId: String(c.id) } : {}),
            ...(c.code ? { couponCode: String(c.code) } : {}),
          }
        : it
    );
    try {
      const priced = await client.callTool('calculate-price', { ...baseArgs, items: itemsC });
      const total = extractTotal(priced);
      if (total != null && (best == null || total < best.total)) {
        best = { coupon: c, total };
      }
    } catch {
      /* 该券不适用，跳过 */
    }
  }
  return best;
}

/** 卡片头：门店 + 今日手气 */
function buildHeaderLines(storeName, luck) {
  return [ui.dim('门店：') + storeName, ui.dim('今日手气：') + luck.color(luck.text)];
}

/** 单套方案的卡片内容行 */
function buildPlanLines(plan) {
  const lines = [];
  for (const p of plan.items) {
    let line = '🍔 ' + ui.highlight(p.name);
    if (p.priceText) line += ui.dim('  ¥' + p.priceText);
    // 真实促销标记：优先用 discountInfos 文案，否则用划线价
    if (p.onSale) {
      if (p.discountInfo) line += ' ' + ui.warn('⚡' + p.discountInfo);
      else if (p.originalText) line += ' ' + ui.dim('原价¥' + p.originalText);
    }
    lines.push(line);
  }
  lines.push('');
  if (plan.baseTotal != null) {
    lines.push(ui.label('原价：') + ui.price(yuan(plan.baseTotal)));
  }
  if (plan.best && plan.best.total != null) {
    lines.push(
      ui.label('用券到手：') + ui.price(yuan(plan.best.total)) + ui.dim(`（${plan.best.coupon.name || '优惠券'}）`)
    );
    if (plan.baseTotal != null && plan.baseTotal > plan.best.total) {
      lines.push(ui.ok(`省了 ¥${fenToYuan(plan.baseTotal - plan.best.total).toFixed(2)}`));
    }
  } else if (plan.baseTotal == null) {
    lines.push(ui.dim('价格以官方实时结果为准'));
  }
  return lines;
}

/** 按口味关键词 + 预算过滤候选池（过滤后为空则回退，不强求） */
export function filterPool(products, taste, budgetFen) {
  const kws = TASTE_KEYWORDS[taste] || [];
  let pool = products;
  if (kws.length) {
    const matched = products.filter((p) => kws.some((k) => p.name.includes(k)));
    if (matched.length) pool = matched;
  }
  if (budgetFen != null) {
    const within = pool.filter((p) => p.priceFen == null || p.priceFen <= budgetFen);
    if (within.length) pool = within;
  }
  return pool;
}

/* ---------------- 可复现随机（每日运势感） ---------------- */

function todaySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 把一个 Date 转成 yyyymmdd 数字种子，供 fortune 连抽多天使用 */
export function seedForDate(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function makeSeed(base, taste, storeCode) {
  let h = base >>> 0;
  const s = String(taste) + '|' + String(storeCode);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h ^ s.charCodeAt(i), 2654435761)) >>> 0;
  }
  return h >>> 0;
}

// mulberry32：轻量可复现 PRNG
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 复用 save 的解析逻辑（含价格字段） ---------------- */

function parseBudgetFen(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100); // 元 -> 分
}

/** 菜单拍平：data.meals 映射表（key=code），name/currentPrice 在其中 */
export function flattenProducts(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const mealMap = data.meals;
  if (mealMap && typeof mealMap === 'object' && !Array.isArray(mealMap)) {
    for (const [code, detail] of Object.entries(mealMap)) {
      if (!detail || typeof detail !== 'object') continue;
      const name = firstOf(detail, ['name', 'productName', 'title']);
      if (!name) continue;
      out.push(buildProduct(code, detail));
    }
    if (out.length) return out;
  }
  // 兜底遍历
  const seen = new Set();
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    const code = firstOf(node, ['productCode', 'code', 'skuCode']);
    const name = firstOf(node, ['name', 'productName', 'title']);
    if (code && name && !seen.has(String(code))) {
      seen.add(String(code));
      out.push(buildProduct(code, node));
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(data);
  return out;
}

/**
 * 从一条餐品详情构造统一的 product 结构。
 * 真实字段（见 MCP_INTEGRATION.md）：
 *   currentPrice 现价、originalPrice 划线原价（均为「元」字符串）
 *   discountInfos 优惠类型：null=无优惠，否则如"促销优惠"/"早餐卡优惠"/"麦金卡优惠"
 * 促销判定：discountInfos 非空，或原价明显高于现价。
 */
function buildProduct(code, detail) {
  const priceText = firstOf(detail, ['currentPrice', 'price', 'salePrice']);
  const originalText = firstOf(detail, ['originalPrice']);
  const priceFen = yuanTextToFen(priceText);
  const originalFen = yuanTextToFen(originalText);
  const discountInfo = firstOf(detail, ['discountInfos']); // 可能为 null/undefined

  const onSale =
    (discountInfo != null && String(discountInfo).trim() !== '') ||
    (originalFen != null && priceFen != null && originalFen > priceFen);

  return {
    code,
    name: firstOf(detail, ['name', 'productName', 'title']),
    priceText,
    priceFen,
    originalText,
    originalFen,
    discountInfo: discountInfo || null,
    onSale,
  };
}

/** 菜单里的价格是“元”字符串（如 "17.9"），转成分 */
function yuanTextToFen(t) {
  if (t == null) return null;
  const n = Number(String(t).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function normalizeCoupons(raw) {
  if (!raw || typeof raw === 'string') return [];
  const list = pickArray(unwrap(raw), ['coupons', 'list', 'data']);
  return list
    .map((c) => ({
      id: firstOf(c, ['couponId', 'id']),
      code: firstOf(c, ['couponCode', 'code']),
      name: firstOf(c, ['couponName', 'name', 'title', 'promotionName']),
    }))
    .filter((c) => c.id || c.code);
}

function extractTotal(pricedRaw) {
  const priced = unwrap(pricedRaw);
  if (priced == null || typeof priced !== 'object') return null;
  const keys = ['payAmount', 'payableAmount', 'totalPrice', 'finalPrice', 'totalAmount', 'actualAmount', 'amount'];
  for (const k of keys) {
    const v = priced[k];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  for (const [k, v] of Object.entries(priced)) {
    if (/amount|price|pay/i.test(k) && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** 从活动日历文本/结构里抽一条“今天”的提示 */
function extractTodayHint(cal) {
  if (!cal) return null;
  if (typeof cal === 'string') {
    // 文本形态：取“活动标题”第一条
    const m = cal.match(/\*\*活动标题\*\*[：:]\s*(.+)/);
    if (m) return m[1].trim();
    return null;
  }
  const list = pickArray(unwrap(cal), ['campaigns', 'activities', 'list', 'data']);
  if (list.length) {
    return firstOf(list[0], ['name', 'title', 'campaignName'], null);
  }
  return null;
}

async function withSpinner(text, fn) {
  const spinner = ora(text).start();
  try {
    const r = await fn();
    spinner.succeed();
    return r;
  } catch (err) {
    spinner.fail();
    throw err;
  }
}
