/**
 * 麦当劳运势周历（fortune 命令）—— “连抽三天”玩法
 *
 * 一次性给出今天 / 明天 / 后天各一套【天选套餐】+ 运势等级，
 * 像翻日历一样提前把这三天的麦当劳安排好。
 *
 * 复用 destiny 的核心逻辑（门店、菜单、口味/预算过滤、可复现随机），
 * 不同之处：用「每一天的日期」作种子，三天结果各自固定、互不相同。
 *
 * 为了省请求（MCP 限流 600/分钟），门店与菜单只查一次，
 * 价格只对“今天”那套做一次实时计算作为参考，明/后天展示菜单参考价。
 */
import { select, input } from '@inquirer/prompts';
import ora from 'ora';
import {
  ui,
  yuan,
  card,
  fortuneLevel,
  banner,
  pickArray,
  firstOf,
  unwrap,
  safeString,
  fenToYuan,
} from '../format.js';
import {
  flattenProducts,
  filterPool,
  pickCombo,
  makeSeed,
  mulberry32,
  seedForDate,
} from './destiny.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_LABELS = ['今天', '明天', '后天'];

export async function runFortune(client, opts = {}) {
  console.log(banner());
  console.log(ui.dim('\n🗓  麦当劳运势周历 · 一次看好这三天吃什么\n'));

  const taste =
    opts.taste ||
    (await select({
      message: '这三天的口味路线？',
      choices: [
        { name: '随便，全凭天意', value: 'any' },
        { name: '鸡肉控', value: 'chicken' },
        { name: '牛肉汉堡党', value: 'beef' },
        { name: '鱼堡/清淡', value: 'fish' },
        { name: '素食/沙拉', value: 'veggie' },
      ],
      default: 'any',
    }));

  const budgetFen = parseBudgetFen(
    opts.budget ?? (await input({ message: '每餐预算上限（元，回车表示不限）：', default: '' }))
  );

  const city = opts.city || (await input({ message: '城市（如：上海）：' }));
  const keyword = opts.keyword || (await input({ message: '位置关键词（如：陆家嘴）：' }));

  // 门店 + 菜单只查一次
  const storesRaw = await withSpinner('寻找附近营业中的门店…', () =>
    client.callTool('query-nearby-stores', {
      searchType: 2,
      city: city.trim(),
      keyword: keyword.trim(),
      beType: 1,
    })
  );
  const storeList = pickArray(unwrap(storesRaw), ['stores', 'list', 'data']);
  if (!storeList.length) {
    console.log(ui.warn('\n没找到门店，换个关键词再试试。'));
    console.log(ui.dim(safeString(storesRaw)));
    return;
  }
  const openStores = storeList.filter((s) => firstOf(s, ['businessStatus']) !== false);
  const store = (openStores.length ? openStores : storeList)[0];
  const storeCode = String(firstOf(store, ['storeCode', 'code']));
  const storeName = firstOf(store, ['storeName', 'name'], '某家麦当劳');
  const baseArgs = { storeCode, orderType: 1, beType: 1 };

  const mealsRaw = await withSpinner('翻开菜单…', () =>
    client.callTool('query-meals', baseArgs)
  );
  const products = flattenProducts(unwrap(mealsRaw));
  if (!products.length) {
    console.log(ui.warn('\n这家店暂时没查到可售商品，换家店或稍后再试。'));
    console.log(ui.dim(safeString(mealsRaw)));
    return;
  }

  const pool = filterPool(products, taste, budgetFen);

  // 为今天那套算一次真实价格（作为参考），明/后天用菜单参考价
  let todayRealTotal = null;

  console.log('\n' + ui.dim(`门店：${storeName}`));
  console.log('');

  for (let i = 0; i < 3; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    const seed = makeSeed(seedForDate(date), taste, storeCode);
    const rng = mulberry32(seed);

    const chosen = pickCombo(pool, products, budgetFen, rng);
    const luck = fortuneLevel(rng());

    const lines = [];
    if (!chosen.length) {
      lines.push(ui.warn('这天按你的预算没凑出套餐，放宽点再试。'));
    } else {
      lines.push(ui.dim('手气：') + luck.color(luck.text));
      lines.push('');
      let refFen = 0;
      let hasRef = true;
      for (const p of chosen) {
        lines.push('🍔 ' + ui.highlight(p.name) + (p.priceText ? ui.dim('  ¥' + p.priceText) : ''));
        if (p.priceFen != null) refFen += p.priceFen;
        else hasRef = false;
      }
      lines.push('');

      if (i === 0) {
        // 今天：实时算一次
        const priced = await client
          .callTool('calculate-price', {
            ...baseArgs,
            items: chosen.map((p) => ({ productCode: String(p.code), quantity: 1 })),
          })
          .catch(() => null);
        todayRealTotal = extractTotal(priced);
        if (todayRealTotal != null) {
          lines.push(ui.label('实时价：') + ui.price(yuan(todayRealTotal)));
        } else if (hasRef) {
          lines.push(ui.label('菜单参考价：') + ui.price('¥' + fenToYuan(refFen).toFixed(2)));
        }
      } else if (hasRef) {
        lines.push(ui.label('菜单参考价：') + ui.price('¥' + fenToYuan(refFen).toFixed(2)));
      }
    }

    const dayTitle = `${DAY_LABELS[i]} · ${fmtDate(date)} ${WEEKDAYS[date.getDay()]}`;
    console.log(card(dayTitle, lines, { color: luck.color }));
    console.log('');
  }

  console.log(ui.dim('三天的结果都按当天日期固定，像运势一样。明/后天为菜单参考价，'));
  console.log(ui.dim('当天用 `mcd-destiny` 可查实时价与最省券。供应与价格以官方实时结果为准。'));
}

/* ---------------- 局部辅助（与 destiny 保持一致） ---------------- */

function parseBudgetFen(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
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

function fmtDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}`;
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
