#!/usr/bin/env node
/**
 * 命运麦当劳 Web 后端（零第三方依赖，仅用 Node 内置模块）
 *
 * 职责：
 *   - 静态托管 public/ 下的单页前端
 *   - POST /api/plans   ：编排 MCP，返回三套方案（结构化 JSON）
 *   - POST /api/fortune ：运势周历，返回未来七天
 *   - GET  /api/health  ：健康检查（不泄漏 Token）
 *
 * 安全：MCP Token 只在后端通过环境变量 / .env 读取，绝不下发给前端。
 * 回退：未配置 Token 或 MCP 调用失败时，用 data/mcd-snapshot.json 快照跑通演示，
 *       响应里用 mode: "live" | "snapshot" 标明当前数据来源。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { loadConfig } from './src/config.js';
import { McpClient } from './src/mcpClient.js';
import {
  orchestrateDestiny,
  flattenProducts,
  buildPlans,
  makeSeed,
  mulberry32,
  seedForDate,
  parseBudgetFen,
  fortuneLevelData,
  serializePlan,
  fenToYuan,
  unwrap,
} from './src/core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const SNAPSHOT_PATH = join(__dirname, 'data', 'mcd-snapshot.json');
const PORT = Number(process.env.PORT) || 8788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------------- 快照「假客户端」 ---------------- */

/**
 * 用快照数据模拟 client.callTool，使 core 的编排逻辑无需改动即可离线跑。
 * calculate-price 在快照模式下按商品现价求和模拟；带 couponId 时按券名做确定性模拟折扣。
 */
function makeSnapshotClient(snapshot) {
  const mealMap = snapshot?.meals?.data?.meals || {};
  const priceOf = (code) => {
    const d = mealMap[code];
    if (!d) return 0;
    const n = Number(String(d.currentPrice).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  return {
    async callTool(name, args = {}) {
      if (name === 'query-nearby-stores') return snapshot.store;
      if (name === 'query-meals') return snapshot.meals;
      if (name === 'query-store-coupons') return snapshot.coupons;
      if (name === 'campaign-calendar') return snapshot.calendar;
      if (name === 'calculate-price') {
        const items = args.items || [];
        let total = items.reduce((s, it) => s + priceOf(it.productCode) * (it.quantity || 1), 0);
        // 模拟券：满30减4 / 立减5（仅用于离线演示，真实场景以 MCP 为准）
        const hasCoupon = items.some((it) => it.couponId || it.couponCode);
        if (hasCoupon) {
          if (total >= 3000) total -= 400;
          else total -= 500;
          if (total < 0) total = 0;
        }
        return { success: true, code: 200, data: { payAmount: total } };
      }
      return { success: true, code: 200, data: {} };
    },
  };
}

let snapshotCache = null;
async function loadSnapshot() {
  if (snapshotCache) return snapshotCache;
  const raw = await readFile(SNAPSHOT_PATH, 'utf8');
  snapshotCache = JSON.parse(raw);
  return snapshotCache;
}

/**
 * 根据 Token 是否可用，返回 { client, mode }。
 * 有 Token → 真实 MCP 客户端(live)；无 Token → 快照客户端(snapshot)。
 */
async function resolveClient() {
  const { token, url } = loadConfig();
  // MCD_FORCE_SNAPSHOT=1 可强制使用离线演示数据（便于本地演示/测试，不影响 .env）
  const forceSnapshot = process.env.MCD_FORCE_SNAPSHOT === '1';
  if (token && !forceSnapshot) {
    return { client: new McpClient({ token, url }), mode: 'live' };
  }
  const snapshot = await loadSnapshot();
  return { client: makeSnapshotClient(snapshot), mode: 'snapshot' };
}

/* ---------------- 运势周历（未来七天） ---------------- */

async function orchestrateFortune(client, opts = {}) {
  const { taste = 'any' } = opts;
  const budgetFen = parseBudgetFen(opts.budget);
  const warnings = [];

  // 复用 core 的门店/菜单获取
  const storeRaw = await client.callTool('query-nearby-stores', {
    searchType: 2,
    city: String(opts.city || '').trim(),
    keyword: String(opts.keyword || '').trim(),
    beType: 1,
  });
  const storeList = unwrap(storeRaw);
  const list = Array.isArray(storeList) ? storeList : [];
  if (!list.length) return { error: '没找到门店，换个城市或关键词再试试。', warnings };
  const open = list.filter((s) => s.businessStatus !== false);
  const store = (open.length ? open : list)[0];
  const storeCode = String(store.storeCode || store.code);
  const storeName = store.storeName || store.name || '某家麦当劳';
  const baseArgs = { storeCode, orderType: 1, beType: 1 };

  const products = flattenProducts(unwrap(await client.callTool('query-meals', baseArgs)));
  if (!products.length) return { error: '这家店暂时没查到可售商品。', store: { storeName }, warnings };

  const labels = ['今天', '明天', '后天'];
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const days = [];

  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    const rng = mulberry32(makeSeed(seedForDate(date), taste, storeCode));
    const plans = buildPlans(products, taste, budgetFen, rng);
    const luck = fortuneLevelData(rng());
    const plan = plans[0] || null;

    let payYuan = null;
    let realtime = false;
    if (plan) {
      if (i === 0) {
        try {
          const items = plan.items.map((p) => ({ productCode: String(p.code), quantity: 1 }));
          const priced = await client.callTool('calculate-price', { ...baseArgs, items });
          const total = unwrap(priced)?.payAmount;
          if (Number.isFinite(Number(total))) {
            payYuan = fenToYuan(Number(total));
            realtime = true;
          }
        } catch {
          /* ignore */
        }
      }
      if (payYuan == null) {
        const refFen = plan.items.reduce((s, p) => s + (p.priceFen || 0), 0);
        payYuan = fenToYuan(refFen);
      }
    }

    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    days.push({
      label: labels[i] || `第${i + 1}天`,
      date: `${mm}/${dd}`,
      weekday: weekdays[date.getDay()],
      luck,
      plan: plan ? serializePlan(plan, false) : null,
      priceYuan: payYuan,
      realtime,
    });
  }

  return { store: { storeName }, days, warnings };
}

/* ---------------- HTTP ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // 防滥用
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 防目录穿越
  const safe = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(500);
    res.end('500');
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && url === '/api/health') {
    const { token } = loadConfig();
    const live = !!token && process.env.MCD_FORCE_SNAPSHOT !== '1';
    return sendJson(res, 200, { ok: true, mode: live ? 'live' : 'snapshot' });
  }

  if (req.method === 'POST' && (url === '/api/plans' || url === '/api/fortune')) {
    const body = await readBody(req);
    let resolved;
    try {
      resolved = await resolveClient();
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '服务初始化失败：' + (e?.message || e) });
    }
    const { client, mode } = resolved;
    try {
      const result =
        url === '/api/plans'
          ? await orchestrateDestiny(client, body)
          : await orchestrateFortune(client, body);
      return sendJson(res, 200, { ok: !result.error, mode, ...result });
    } catch (e) {
      // live 失败时自动回退快照，保证演示不中断
      if (mode === 'live') {
        try {
          const snapshot = await loadSnapshot();
          const fb = makeSnapshotClient(snapshot);
          const result =
            url === '/api/plans'
              ? await orchestrateDestiny(fb, body)
              : await orchestrateFortune(fb, body);
          return sendJson(res, 200, {
            ok: !result.error,
            mode: 'snapshot',
            fallback: true,
            fallbackReason: String(e?.message || e),
            ...result,
          });
        } catch (e2) {
          return sendJson(res, 500, { ok: false, error: String(e2?.message || e2) });
        }
      }
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405 Method Not Allowed');
});

server.listen(PORT, () => {
  const { token } = loadConfig();
  console.log(`\n🍔 命运麦当劳 Web 已启动： http://localhost:${PORT}`);
  console.log(token ? '模式：live（已配置 MCP Token，实时数据）' : '模式：snapshot（未配置 Token，使用离线演示数据）');
  console.log('按 Ctrl+C 停止。\n');
});
