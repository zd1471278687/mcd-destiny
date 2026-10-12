/**
 * 积分管家（points 命令）
 *
 * 解决两个真实痛点：
 *   1. “我有多少积分 / 快过期了吗”  -> query-my-account
 *   2. “积分能换啥、换哪个值”        -> mall-points-products
 *   3. “最近有啥积分相关活动”        -> campaign-calendar
 *
 * 不做下单动作，只做信息聚合与建议，避免误操作用户的真实积分。
 */
import ora from 'ora';
import { ui, hr, firstOf, pickArray, safeString, unwrap } from '../format.js';

export async function runPoints(client) {
  console.log(ui.title('\n⭐ 麦省 · 积分管家'));
  console.log(ui.dim('看懂你的积分，告诉你怎么花最值。\n'));

  // ---- 1. 积分账户 ----
  const account = await withSpinner('查询积分账户…', () =>
    client.callTool('query-my-account', {})
  );
  printAccount(account);
  const availablePoints = firstOf(unwrap(account) || {}, [
    'availablePoint',
    'availablePoints',
    'available',
    'points',
  ]);

  // ---- 2. 积分可兑换商品 ----
  console.log('\n' + hr());
  console.log(ui.label('积分可兑换（麦麦商城，门槛从低到高）：'));
  const products = await withSpinner('查询积分商城…', () =>
    client.callTool('mall-points-products', {})
  );
  printMallProducts(products, availablePoints);

  // ---- 3. 活动日历 ----
  console.log('\n' + hr());
  console.log(ui.label('本月活动日历：'));
  const calendar = await withSpinner('查询活动日历…', () =>
    client.callTool('campaign-calendar', {})
  );
  printCalendar(calendar);

  console.log('\n' + ui.dim('积分、商品及活动以麦当劳官方实时结果为准。'));
}

function printAccount(accountRaw) {
  if (typeof accountRaw === 'string') {
    console.log(accountRaw.trim());
    return;
  }
  const account = unwrap(accountRaw);
  // 真实字段名（见 MCP_INTEGRATION.md）：availablePoint / accumulativePoint /
  // currentMouthExpirePoint / nextMouthExpirePoint（注意 API 原文拼写为 Mouth）
  const available = firstOf(account, ['availablePoint', 'availablePoints', 'available', 'points']);
  const accumulative = firstOf(account, ['accumulativePoint']);
  const thisMonthExpire = firstOf(account, ['currentMouthExpirePoint']);
  const nextMonthExpire = firstOf(account, ['nextMouthExpirePoint']);

  if (available == null) {
    console.log(ui.dim('未解析到标准积分字段，原始返回：'));
    console.log(ui.dim(safeString(account)));
    return;
  }

  console.log(ui.label('可用积分：') + ' ' + ui.highlight(String(available)));
  if (accumulative != null) console.log(ui.dim('累计积分：' + accumulative));

  if (thisMonthExpire != null && Number(thisMonthExpire) > 0) {
    console.log(ui.warn(`⚠ 本月将过期：${thisMonthExpire} 分`) + ui.dim('  建议尽快兑换，别浪费。'));
  } else if (nextMonthExpire != null && Number(nextMonthExpire) > 0) {
    console.log(ui.dim(`下月将过期：${nextMonthExpire} 分`));
  }
}

function printMallProducts(productsRaw, availablePoints) {
  if (typeof productsRaw === 'string') {
    console.log(productsRaw.trim());
    return;
  }
  const list = pickArray(unwrap(productsRaw), ['products', 'list', 'data']);
  if (!list.length) {
    console.log(ui.dim('  暂无可兑换商品，或返回结构未识别。'));
    console.log(ui.dim(safeString(productsRaw)));
    return;
  }

  // 真实字段名：spuName / point / status（2=上架）
  // 只展示上架商品，按所需积分升序，突出“门槛最低就能换”的选项
  const parsed = list
    .map((p) => ({
      name: firstOf(p, ['spuName', 'name', 'productName', 'title'], '未命名'),
      points: toNumber(firstOf(p, ['point', 'points', 'needPoints'])),
      status: toNumber(firstOf(p, ['status'])),
    }))
    .filter((p) => p.status == null || p.status === 2)
    .sort((a, b) => (a.points ?? Infinity) - (b.points ?? Infinity));

  const avail = toNumber(availablePoints);
  for (const p of parsed.slice(0, 10)) {
    const pts = p.points != null ? ui.highlight(`${p.points} 积分`) : ui.dim('积分未知');
    // 当前积分够不够，直接标出来，省得用户自己算
    let mark = '';
    if (avail != null && p.points != null) {
      mark = avail >= p.points ? ui.ok('  ✓可换') : ui.dim(`  还差 ${p.points - avail}`);
    }
    console.log(`  · ${p.name}  ${pts}${mark}`);
  }
  if (parsed.length > 10) {
    console.log(ui.dim(`  …共 ${parsed.length} 项上架商品，仅显示门槛最低的 10 项`));
  }
}

function printCalendar(calendarRaw) {
  // 活动日历返回的是 Markdown 文本，直接展示即可
  if (typeof calendarRaw === 'string') {
    console.log(stripImages(calendarRaw).trim());
    return;
  }
  const list = pickArray(unwrap(calendarRaw), ['campaigns', 'activities', 'list', 'data']);
  if (!list.length) {
    console.log(ui.dim('  本月暂无可识别的活动。'));
    console.log(ui.dim(safeString(calendarRaw)));
    return;
  }
  for (const a of list.slice(0, 10)) {
    const name = firstOf(a, ['name', 'title', 'campaignName', 'activityName'], '活动');
    const date = firstOf(a, ['date', 'startDate', 'startTime', 'beginTime'], '');
    console.log(`  · ${name}  ${date ? ui.dim(String(date)) : ''}`);
  }
}

/** 去掉 Markdown 里的 <img> 标签，CLI 里展示不了图片 */
function stripImages(text) {
  return text.replace(/<img[^>]*>/g, '').replace(/\n{3,}/g, '\n\n');
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
