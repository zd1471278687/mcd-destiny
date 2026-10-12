/**
 * 省钱核心流程（save 命令）
 *
 * 思路（全部基于真实 MCP 调用，不臆造数据）：
 *   1. 按城市 + 关键词查附近门店（query-nearby-stores）
 *   2. 用户选门店、选就餐方式（到店自取 / 得来速）
 *   3. 查该门店在售菜单（query-meals），用户勾选想吃的商品
 *   4. 查该门店+订单类型下真正可用的券（query-store-coupons）
 *   5. 先算“不用券”的原价（calculate-price），
 *      再对每一张可用券分别试算，挑出“到手价最低”的方案
 *   6. 输出最省点法 + 省了多少钱 + 一键领券提示
 *
 * 诚实声明：满减/满折（query-promotions）仅企业团餐 beType=6 可用，
 * 个人到店/外送场景拿不到，所以本工具的“省”主要来自“选对券”。
 */
import { select, checkbox, input } from '@inquirer/prompts';
import ora from 'ora';
import { ui, yuan, hr, fenToYuan, pickArray, firstOf, safeString, unwrap } from '../format.js';

export async function runSave(client, opts = {}) {
  console.log(ui.title('\n🍔 麦省 · 省钱助手'));
  console.log(ui.dim('帮你把最省的点法算出来，而不是只喊口号。\n'));

  // ---- 1. 选就餐方式 ----
  const beType = await select({
    message: '选择就餐方式：',
    choices: [
      { name: '到店自取', value: 1 },
      { name: '得来速（车道取餐）', value: 5 },
    ],
    default: 1,
  });
  const orderType = 1; // 到店自取/得来速均为订单类型 1

  // ---- 2. 查门店 ----
  const city = opts.city || (await input({ message: '城市（如：上海）：' }));
  const keyword =
    opts.keyword || (await input({ message: '位置关键词（如：陆家嘴 / 某商场）：' }));

  const stores = await withSpinner('查询附近门店…', () =>
    client.callTool('query-nearby-stores', {
      searchType: 2,
      city: city.trim(),
      keyword: keyword.trim(),
      beType,
    })
  );

  const storeList = pickArray(unwrap(stores), ['stores', 'list', 'data']);
  if (!storeList.length) {
    console.log(ui.warn('\n没有查到门店。换个关键词或城市再试试。'));
    console.log(ui.dim(safeString(stores)));
    return;
  }

  const store = await select({
    message: `找到 ${storeList.length} 家门店，选择一家：`,
    choices: storeList.slice(0, 15).map((s) => {
      const open = firstOf(s, ['businessStatus']);
      const dist = firstOf(s, ['distance']);
      const flags =
        (open === false ? ui.warn(' [未营业]') : '') +
        (dist != null ? ui.dim(` ${Math.round(Number(dist))}m`) : '');
      return {
        name:
          firstOf(s, ['storeName', 'name', 'shopName'], '未命名门店') +
          flags +
          '  ' +
          ui.dim(firstOf(s, ['address', 'storeAddress'], '')),
        value: s,
      };
    }),
  });

  const storeCode = String(firstOf(store, ['storeCode', 'code', 'shopCode']));
  const beCode = firstOf(store, ['beCode']);
  if (!storeCode || storeCode === 'undefined') {
    console.log(ui.err('该门店缺少 storeCode，无法继续。'));
    return;
  }

  const baseArgs = { storeCode, orderType, beType };
  if (beType === 5 && beCode) baseArgs.beCode = String(beCode);

  // ---- 3. 查菜单，选商品 ----
  const meals = await withSpinner('查询在售菜单…', () =>
    client.callTool('query-meals', baseArgs)
  );

  const products = flattenProducts(unwrap(meals));
  if (!products.length) {
    console.log(ui.warn('\n该门店暂未查到可售商品。'));
    console.log(ui.dim(safeString(meals)));
    return;
  }

  const picked = await checkbox({
    message: '勾选想吃的商品（空格选中，回车确认）：',
    choices: products.slice(0, 40).map((p) => ({
      // 菜单价是「元」字符串，仅作参考展示；到手价以 calculate-price 为准
      name: `${p.name}  ${p.priceText != null ? ui.price('¥' + p.priceText) : ''}`,
      value: p,
    })),
    required: true,
  });

  const items = picked.map((p) => ({ productCode: String(p.code), quantity: 1 }));

  // ---- 4. 查该门店可用券 ----
  const couponsRaw = await withSpinner('查询当前门店可用优惠券…', () =>
    client.callTool('query-store-coupons', baseArgs)
  );
  const coupons = normalizeCoupons(couponsRaw);

  // ---- 5. 价格对比 ----
  console.log('\n' + hr());
  const basePrice = await withSpinner('计算不用券的原价…', () =>
    client.callTool('calculate-price', { ...baseArgs, items })
  );
  const baseTotal = extractTotal(basePrice);

  console.log(ui.label('原价（不使用优惠券）：') + ' ' + ui.price(yuan(baseTotal)));

  const results = [];
  for (const c of coupons) {
    const itemsWithCoupon = items.map((it, idx) =>
      idx === 0
        ? { ...it, ...(c.id ? { couponId: String(c.id) } : {}), ...(c.code ? { couponCode: String(c.code) } : {}) }
        : it
    );
    try {
      const priced = await client.callTool('calculate-price', {
        ...baseArgs,
        items: itemsWithCoupon,
      });
      const total = extractTotal(priced);
      if (total != null) {
        results.push({ coupon: c, total });
      }
    } catch {
      // 该券对当前组合不适用，跳过
    }
  }

  // ---- 6. 输出最优方案 ----
  console.log('\n' + hr());
  if (!results.length) {
    console.log(ui.warn('当前商品组合没有可直接试算成功的券。'));
    if (coupons.length) {
      console.log(ui.dim('你卡包/门店里有券，但可能有门槛或适用商品限制，换组合或看券面说明。'));
    } else {
      console.log(ui.dim('该门店当前没查到可用券。可运行 `mcd-destiny coupons` 一键领券后再试。'));
    }
    console.log('\n' + ui.ok(`建议下单：原价 ${yuan(baseTotal)}`));
    return;
  }

  results.sort((a, b) => a.total - b.total);
  const best = results[0];
  const saved =
    baseTotal != null && best.total != null ? baseTotal - best.total : null;

  console.log(ui.title('💰 最省点法'));
  console.log(
    `  使用券：${ui.highlight(best.coupon.name || best.coupon.id || '优惠券')}`
  );
  console.log(`  到手价：${ui.price(yuan(best.total))}`);
  if (saved != null && saved > 0) {
    console.log(
      `  相比原价省：${ui.ok('¥' + fenToYuan(saved).toFixed(2))}` +
        ui.dim(`（原价 ${yuan(baseTotal)}）`)
    );
  }

  if (results.length > 1) {
    console.log('\n' + ui.dim('其他可用券对比：'));
    for (const r of results.slice(1, 6)) {
      console.log(
        ui.dim(`  · ${r.coupon.name || r.coupon.id}: ${yuan(r.total)}`)
      );
    }
  }
  console.log('\n' + ui.dim('价格以麦当劳官方下单时实时结果为准。'));
}

/* ---------------- 辅助函数 ---------------- */

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

/**
 * 把菜单拍平成 {code, name, priceText} 列表。
 *
 * 真实结构（见 MCP_INTEGRATION.md）：
 *   data.categories[].meals[] 只含 code + tags
 *   data.meals 是一个「以 code 为键」的详情映射表，name/currentPrice 在这里
 * 这里的价格字段是「元」字符串（如 "17.9"），仅用于展示；
 * 真正的到手价一律以 calculate-price（单位分）为准。
 */
function flattenProducts(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];

  // 优先走标准结构：以 data.meals 映射表为准
  const mealMap = data.meals;
  if (mealMap && typeof mealMap === 'object' && !Array.isArray(mealMap)) {
    for (const [code, detail] of Object.entries(mealMap)) {
      if (!detail || typeof detail !== 'object') continue;
      const name = firstOf(detail, ['name', 'productName', 'title']);
      if (!name) continue;
      out.push({
        code,
        name,
        priceText: firstOf(detail, ['currentPrice', 'price', 'originalPrice']),
      });
    }
    if (out.length) return out;
  }

  // 兜底：深度遍历找 code+name
  const seen = new Set();
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    const code = firstOf(node, ['productCode', 'code', 'skuCode']);
    const name = firstOf(node, ['name', 'productName', 'title']);
    if (code && name && !seen.has(String(code))) {
      seen.add(String(code));
      out.push({ code, name, priceText: firstOf(node, ['currentPrice', 'price', 'salePrice']) });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(data);
  return out;
}

/** 规范化券列表 -> [{id, code, name}] */
function normalizeCoupons(raw) {
  if (typeof raw === 'string') return [];
  const list = pickArray(unwrap(raw), ['coupons', 'list', 'data']);
  return list
    .map((c) => ({
      id: firstOf(c, ['couponId', 'id']),
      code: firstOf(c, ['couponCode', 'code']),
      name: firstOf(c, ['couponName', 'name', 'title', 'promotionName']),
    }))
    .filter((c) => c.id || c.code);
}

/** 从 calculate-price 返回里提取应付总价（单位：分） */
function extractTotal(pricedRaw) {
  const priced = unwrap(pricedRaw);
  if (priced == null || typeof priced !== 'object') return null;
  const candidates = [
    'payAmount',
    'payableAmount',
    'totalPrice',
    'finalPrice',
    'totalAmount',
    'actualAmount',
    'amount',
  ];
  for (const key of candidates) {
    const v = priced[key];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  // 深度兜底：找第一个像金额的数字字段
  for (const [k, v] of Object.entries(priced)) {
    if (/amount|price|pay/i.test(k) && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}
