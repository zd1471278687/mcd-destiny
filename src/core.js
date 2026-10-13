/**
 * 核心决策逻辑（无 UI 依赖）—— CLI 与 Web 后端共用。
 *
 * 这里只做"数据 + 算法"：查门店/菜单/券、拍平菜单、识别促销、
 * 抽三套风格方案、可复现随机、运势等级（纯数据）、价格字段解析。
 * 任何终端着色 / 浏览器渲染都在各自的展示层做，不进这里。
 */

/* ---------------- 通用字段容错工具 ---------------- */

export function unwrap(res) {
  if (
    res &&
    typeof res === 'object' &&
    !Array.isArray(res) &&
    'data' in res &&
    ('success' in res || 'code' in res || 'message' in res)
  ) {
    return res.data;
  }
  return res;
}

export function pickArray(obj, candidateKeys = []) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const key of candidateKeys) {
    const v = key.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
    if (Array.isArray(v)) return v;
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = pickArray(value, candidateKeys);
      if (nested.length) return nested;
    }
  }
  return [];
}

export function firstOf(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return fallback;
}

/* ---------------- 价格换算 ---------------- */

export function fenToYuan(fen) {
  const n = Number(fen);
  return Number.isFinite(n) ? n / 100 : null;
}

export function yuanTextToFen(t) {
  if (t == null) return null;
  const n = Number(String(t).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function parseBudgetFen(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/* ---------------- 口味 ---------------- */

export const TASTE_KEYWORDS = {
  chicken: ['鸡', '麦辣', '麦乐鸡', '板烧', '鸡翅', '鸡腿'],
  beef: ['牛', '巨无霸', '安格斯', '吉士汉堡', '双层'],
  fish: ['鱼', '麦香鱼'],
  veggie: ['素', '蔬', '沙拉'],
  any: [],
};

export const DESTINY_LINES = [
  '命运已经替你选好了，别再纠结了。',
  '今天的你，注定属于这一餐。',
  '算法掷出的骰子，落在了这里。',
  '别问为什么，问就是天选。',
  '选择困难？今天不存在的。',
];

/* ---------------- 可复现随机 ---------------- */

export function todaySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function seedForDate(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function makeSeed(base, taste, storeCode) {
  let h = base >>> 0;
  const s = String(taste) + '|' + String(storeCode);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 2654435761) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 运势等级（纯数据，不含终端颜色）。返回 { key, name, emoji, stars, hex }。
 * 展示层按 key/hex 自行着色。
 */
export function fortuneLevelData(roll) {
  const levels = [
    { key: 'great', name: '大吉', emoji: '🌟', stars: 5, hex: '#DA291C' },
    { key: 'good', name: '中吉', emoji: '✨', stars: 4, hex: '#FFC72C' },
    { key: 'small', name: '小吉', emoji: '🍀', stars: 3, hex: '#2E7D32' },
    { key: 'flat', name: '平', emoji: '🙂', stars: 2, hex: '#0097A7' },
    { key: 'low', name: '待努力', emoji: '🌧', stars: 1, hex: '#757575' },
  ];
  const idx =
    roll > 0.88 ? 0 : roll > 0.68 ? 1 : roll > 0.4 ? 2 : roll > 0.15 ? 3 : 4;
  const lv = levels[idx];
  const starbar = '★'.repeat(lv.stars) + '☆'.repeat(5 - lv.stars);
  return { ...lv, starbar, text: `${lv.emoji} ${lv.name}  ${starbar}` };
}

/* ---------------- 菜单解析 ---------------- */

export function flattenProducts(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const mealMap = data.meals;
  if (mealMap && typeof mealMap === 'object' && !Array.isArray(mealMap)) {
    for (const [code, detail] of Object.entries(mealMap)) {
      if (!detail || typeof detail !== 'object') continue;
      if (!firstOf(detail, ['name', 'productName', 'title'])) continue;
      out.push(buildProduct(code, detail));
    }
    if (out.length) return out;
  }
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
 * 构造统一 product 结构。
 * 真实字段：currentPrice 现价 / originalPrice 划线原价（元字符串）/
 * discountInfos 优惠类型（null=无优惠）。促销判定：discountInfos 非空 或 原价>现价。
 */
export function buildProduct(code, detail) {
  const priceText = firstOf(detail, ['currentPrice', 'price', 'salePrice']);
  const originalText = firstOf(detail, ['originalPrice']);
  const priceFen = yuanTextToFen(priceText);
  const originalFen = yuanTextToFen(originalText);
  const discountInfo = firstOf(detail, ['discountInfos']);
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

export function normalizeCoupons(raw) {
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

export function extractTotal(pricedRaw) {
  const priced = unwrap(pricedRaw);
  if (priced == null || typeof priced !== 'object') return null;
  const keys = [
    'payAmount',
    'payableAmount',
    'totalPrice',
    'finalPrice',
    'totalAmount',
    'actualAmount',
    'amount',
  ];
  for (const k of keys) {
    const v = priced[k];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  for (const [k, v] of Object.entries(priced)) {
    if (/amount|price|pay/i.test(k) && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export function extractTodayHint(cal) {
  if (!cal) return null;
  if (typeof cal === 'string') {
    const m = cal.match(/\*\*活动标题\*\*[：:]\s*(.+)/);
    return m ? m[1].trim() : null;
  }
  const list = pickArray(unwrap(cal), ['campaigns', 'activities', 'list', 'data']);
  return list.length ? firstOf(list[0], ['name', 'title', 'campaignName'], null) : null;
}

/* ---------------- 候选过滤 & 组合 & 多方案 ---------------- */

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

export function pickCombo(pool, allProducts, budgetFen, rng) {
  if (!pool.length) return [];
  const main = pool[Math.floor(rng() * pool.length)];
  const combo = [main];
  const spent = main.priceFen ?? 0;
  const sides = allProducts
    .filter((p) => p.code !== main.code && p.priceFen != null)
    .sort((a, b) => a.priceFen - b.priceFen);
  if (sides.length) {
    const affordable =
      budgetFen == null ? sides : sides.filter((p) => spent + p.priceFen <= budgetFen);
    const candidates = (affordable.length ? affordable : sides).slice(0, 12);
    if (candidates.length && rng() > 0.15) {
      combo.push(candidates[Math.floor(rng() * candidates.length)]);
    }
  }
  return combo;
}

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
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    plans.push({ label: def.label, items: combo });
  }
  return plans;
}

/* ---------------- MCP 数据获取（纯逻辑，不含 UI） ---------------- */

/** 查附近门店，优先营业中；返回 {storeCode, storeName} 或 null */
export async function fetchStore(client, { city, keyword, beType = 1 }) {
  const raw = await client.callTool('query-nearby-stores', {
    searchType: 2,
    city: String(city || '').trim(),
    keyword: String(keyword || '').trim(),
    beType,
  });
  const list = pickArray(unwrap(raw), ['stores', 'list', 'data']);
  if (!list.length) return null;
  const open = list.filter((s) => firstOf(s, ['businessStatus']) !== false);
  const store = (open.length ? open : list)[0];
  const storeCode = firstOf(store, ['storeCode', 'code']);
  if (storeCode == null) return null;
  return {
    storeCode: String(storeCode),
    storeName: firstOf(store, ['storeName', 'name'], '某家麦当劳'),
    address: firstOf(store, ['address', 'storeAddress'], ''),
    distance: firstOf(store, ['distance']),
  };
}

/** 查菜单并拍平成 product 列表 */
export async function fetchProducts(client, baseArgs) {
  const raw = await client.callTool('query-meals', baseArgs);
  return flattenProducts(unwrap(raw));
}

/** 对一组 items 逐张券试算，返回到手价最低 {coupon,total} 或 null */
export async function findBestCoupon(client, baseArgs, items, coupons) {
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
      if (total != null && (best == null || total < best.total)) best = { coupon: c, total };
    } catch {
      /* 该券不适用 */
    }
  }
  return best;
}

/**
 * 端到端编排：输入偏好，返回结构化结果（供 CLI 展示或 Web JSON 响应）。
 * 不抛错中断：任一步失败写进 warnings，其余照常返回。
 * @returns {Promise<{store,luck,plans,recommendedLabel,todayHint,line,warnings}>}
 */
export async function orchestrateDestiny(client, opts = {}) {
  const { taste = 'any', reroll = false } = opts;
  const budgetFen = parseBudgetFen(opts.budget);
  const warnings = [];

  const store = await fetchStore(client, {
    city: opts.city,
    keyword: opts.keyword,
    beType: 1,
  });
  if (!store) return { error: '没找到门店，换个城市或关键词再试试。', warnings };

  const baseArgs = { storeCode: store.storeCode, orderType: 1, beType: 1 };

  let products = [];
  try {
    products = await fetchProducts(client, baseArgs);
  } catch (e) {
    warnings.push('菜单查询失败：' + (e?.message || e));
  }
  if (!products.length) return { error: '这家店暂时没查到可售商品，换家店或稍后再试。', store, warnings };

  const seed = makeSeed(reroll ? Date.now() : todaySeed(), taste, store.storeCode);
  const rng = mulberry32(seed);
  const luck = fortuneLevelData(rng());

  const plans = buildPlans(products, taste, budgetFen, rng);
  if (!plans.length) return { error: '按你的预算/口味没凑出套餐，放宽点再试。', store, luck, warnings };

  let coupons = [];
  try {
    const couponsRaw = await client.callTool('query-store-coupons', baseArgs);
    coupons = normalizeCoupons(couponsRaw);
  } catch (e) {
    warnings.push('优惠券查询失败：' + (e?.message || e));
  }

  for (const plan of plans) {
    const items = plan.items.map((p) => ({ productCode: String(p.code), quantity: 1 }));
    try {
      const basePriced = await client.callTool('calculate-price', { ...baseArgs, items });
      plan.baseTotal = extractTotal(basePriced);
    } catch (e) {
      plan.baseTotal = null;
      warnings.push(`「${plan.label}」计价失败`);
    }
    plan.best = coupons.length ? await findBestCoupon(client, baseArgs, items, coupons) : null;
    plan.payTotal = plan.best?.total ?? plan.baseTotal;
  }

  const pricedPlans = plans.filter((p) => p.payTotal != null);
  const recommended = pricedPlans.length
    ? pricedPlans.reduce((a, b) => (b.payTotal < a.payTotal ? b : a))
    : plans[0];

  let todayHint = null;
  try {
    todayHint = extractTodayHint(await client.callTool('campaign-calendar', {}));
  } catch {
    /* 活动日历可选，失败忽略 */
  }

  const line = DESTINY_LINES[Math.floor(rng() * DESTINY_LINES.length)];

  return {
    store,
    luck,
    plans: plans.map((p) => serializePlan(p, p === recommended)),
    recommendedLabel: recommended?.label ?? null,
    todayHint,
    line,
    warnings,
  };
}

/** 把一套方案序列化为纯数据（Web/JSON 友好） */
export function serializePlan(plan, isRecommended) {
  return {
    label: plan.label,
    recommended: !!isRecommended,
    items: plan.items.map((p) => ({
      name: p.name,
      priceText: p.priceText,
      onSale: p.onSale,
      discountInfo: p.discountInfo,
      originalText: p.originalText,
    })),
    baseTotal: plan.baseTotal ?? null,
    baseYuan: plan.baseTotal != null ? fenToYuan(plan.baseTotal) : null,
    payTotal: plan.payTotal ?? null,
    payYuan: plan.payTotal != null ? fenToYuan(plan.payTotal) : null,
    couponName: plan.best?.coupon?.name ?? null,
    savedYuan:
      plan.baseTotal != null && plan.best?.total != null && plan.baseTotal > plan.best.total
        ? fenToYuan(plan.baseTotal - plan.best.total)
        : null,
  };
}
