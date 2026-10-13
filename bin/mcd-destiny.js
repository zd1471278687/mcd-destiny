#!/usr/bin/env node
/**
 * 命运麦当劳 (mcd-destiny) CLI 入口
 *
 * 主命令：
 *   destiny   今日天选套餐：治好选择困难，一键帮你决定今天吃什么（默认命令）
 *
 * 辅助命令：
 *   save      省钱助手：手动选商品，比遍所有券找最省的点法
 *   points    积分管家：积分余额 / 积分商城 / 活动日历
 *   coupons   领券助手：看券、一键领券、查卡包
 *   doctor    连接自检：验证 MCP Token 与接入是否正常
 */
import { Command } from 'commander';
import { loadConfig } from '../src/config.js';
import { McpClient, McpError } from '../src/mcpClient.js';
import { ui } from '../src/format.js';
import { runDestiny } from '../src/commands/destiny.js';
import { runFortune } from '../src/commands/fortune.js';
import { runSave } from '../src/commands/save.js';
import { runPoints } from '../src/commands/points.js';
import { runCoupons } from '../src/commands/coupons.js';

const program = new Command();

program
  .name('mcd-destiny')
  .description('命运麦当劳 — 治好你的麦当劳选择困难，基于麦当劳 MCP')
  .version('1.0.0');

/** 构造并返回已配置的 MCP 客户端；缺 Token 时给出清晰指引 */
function makeClient() {
  const { token, url } = loadConfig();
  if (!token) {
    console.log(ui.err('\n未检测到 MCP Token。'));
    console.log(
      '请复制 ' +
        ui.highlight('.env.example') +
        ' 为 ' +
        ui.highlight('.env') +
        '，填入在 https://open.mcd.cn/mcp 申请的 Token，'
    );
    console.log('或设置环境变量 ' + ui.highlight('MCD_MCP_TOKEN') + '。\n');
    process.exit(1);
  }
  return new McpClient({ token, url });
}

/** 统一的错误处理包装 */
async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err && err.name === 'ExitPromptError') {
      console.log(ui.dim('\n已取消。'));
      return;
    }
    if (err instanceof McpError) {
      console.log(ui.err('\n✗ ' + err.message));
    } else {
      console.log(ui.err('\n✗ 出错了：' + (err?.message || String(err))));
    }
    process.exitCode = 1;
  }
}

program
  .command('destiny', { isDefault: true })
  .description('今日天选套餐：治好选择困难，帮你决定今天吃什么（默认命令）')
  .option('--city <city>', '城市')
  .option('--keyword <keyword>', '位置关键词')
  .option('--taste <taste>', '口味偏好：any/chicken/beef/fish/veggie')
  .option('--budget <yuan>', '预算上限（元）')
  .option('--reroll', '重新抽一次（不按当天固定结果）')
  .option('-y, --yes', '非交互模式，跳过结尾追问')
  .action((opts) => run(() => runDestiny(makeClient(), opts)));

program
  .command('fortune')
  .description('运势周历：一次抽好未来七天的天选套餐')
  .option('--city <city>', '城市')
  .option('--keyword <keyword>', '位置关键词')
  .option('--taste <taste>', '口味偏好：any/chicken/beef/fish/veggie')
  .option('--budget <yuan>', '每餐预算上限（元）')
  .action((opts) => run(() => runFortune(makeClient(), opts)));

program
  .command('save')
  .description('省钱助手：手动选商品，比遍所有券找最省的点法')
  .option('--city <city>', '城市')
  .option('--keyword <keyword>', '位置关键词')
  .action((opts) => run(() => runSave(makeClient(), opts)));

program
  .command('points')
  .description('积分管家：积分余额 / 积分商城可兑换 / 活动日历')
  .action(() => run(() => runPoints(makeClient())));

program
  .command('coupons')
  .description('领券助手：查看可领券、一键领券、查卡包')
  .option('-y, --yes', '跳过确认，直接一键领券')
  .action((opts) => run(() => runCoupons(makeClient(), opts)));

program
  .command('doctor')
  .description('连接自检：验证 MCP Token 与接入是否正常')
  .action(() =>
    run(async () => {
      const client = makeClient();
      console.log(ui.dim('正在连接麦当劳 MCP Server…'));
      await client.connect();
      console.log(ui.ok('✓ 连接成功，MCP Token 有效。'));
      console.log(ui.dim('会话 ID：' + (client.sessionId || '（服务端未下发）')));
    })
  );

program.parse(process.argv);
