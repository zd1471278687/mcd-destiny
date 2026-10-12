/**
 * 配置加载：从环境变量 + 可选的 .env 文件读取 MCP 连接信息。
 * 不引入第三方 dotenv，保持零额外依赖的轻量解析。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

/** 极简 .env 解析：KEY=VALUE，忽略空行与 # 注释，支持可选引号 */
function parseEnvFile(path) {
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 加载配置。优先级：真实环境变量 > .env 文件。
 * @returns {{ token: string|undefined, url: string }}
 */
export function loadConfig() {
  let fileEnv = {};
  const envPath = join(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) {
    try {
      fileEnv = parseEnvFile(envPath);
    } catch {
      // 读取失败则忽略，退回到进程环境变量
    }
  }

  const token = process.env.MCD_MCP_TOKEN || fileEnv.MCD_MCP_TOKEN;
  const url = process.env.MCD_MCP_URL || fileEnv.MCD_MCP_URL || 'https://mcp.mcd.cn';

  // 过滤掉示例占位符，避免拿着占位符去请求
  const cleanToken = token && token !== 'YOUR_MCP_TOKEN' ? token : undefined;

  return { token: cleanToken, url };
}
