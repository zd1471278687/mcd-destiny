/**
 * 领券助手（coupons 命令）
 *
 * 解决“有券不知道、忘了领”的痛点：
 *   - available-coupons：看“麦麦省”当前能领什么
 *   - auto-bind-coupons：一键把能领的都领了（真实动作，领券本身对用户无成本）
 *   - query-my-coupons：看看卡包里现在有哪些券
 */
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { ui, hr, firstOf, pickArray, safeString } from '../format.js';

export async function runCoupons(client, opts = {}) {
  console.log(ui.title('\n🎟  麦省 · 领券助手'));
  console.log(ui.dim('把能领的券先领到手，点餐时才有得用。\n'));

  // 1. 可领券
  const available = await withSpinner('查询可领取的麦麦省券…', () =>
    client.callTool('available-coupons', {})
  );
  const availList = pickArray(available, ['coupons', 'data.coupons', 'list', 'data.list', 'data']);
  if (availList.length) {
    console.log(ui.label(`当前可领取 ${availList.length} 张券：`));
    for (const c of availList.slice(0, 15)) {
      console.log('  · ' + firstOf(c, ['couponName', 'name', 'title', 'promotionName'], '优惠券'));
    }
  } else {
    console.log(ui.dim('暂无可领取的麦麦省券。'));
  }

  // 2. 一键领券（真实动作，需确认）
  console.log('\n' + hr());
  const doBind =
    opts.yes ||
    (availList.length > 0 &&
      (await confirm({ message: '一键领取以上所有可领券？', default: true })));

  if (doBind && availList.length) {
    const bound = await withSpinner('一键领券中…', () =>
      client.callTool('auto-bind-coupons', {})
    );
    console.log(ui.ok('✓ 领券完成。') + ui.dim(' 结果：' + brief(bound)));
  }

  // 3. 卡包现有券
  console.log('\n' + hr());
  console.log(ui.label('你卡包里现有的券：'));
  const mine = await withSpinner('查询卡包…', () =>
    client.callTool('query-my-coupons', { page: '1', pageSize: '50' })
  );
  const mineList = pickArray(mine, ['coupons', 'data.coupons', 'list', 'data.list', 'data']);
  if (mineList.length) {
    for (const c of mineList.slice(0, 20)) {
      console.log('  · ' + firstOf(c, ['couponName', 'name', 'title'], '优惠券'));
    }
    console.log(
      '\n' + ui.dim('提示：卡包里有券不代表当前门店一定能用。运行 `mcd-destiny save` 做真实价格试算。')
    );
  } else {
    console.log(ui.dim('  卡包暂无券。'));
    console.log(ui.dim(safeString(mine)));
  }
}

function brief(v) {
  const s = safeString(v, 120);
  return s.replace(/\s+/g, ' ');
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
