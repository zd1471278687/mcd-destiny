/**
 * 输出格式化工具：价格换算、金额展示、表格、提示语等。
 */
import chalk from 'chalk';

/** 分 -> 元（麦当劳 MCP 的价格字段单位均为“分”） */
export function fenToYuan(fen) {
  const n = Number(fen);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** 格式化为“¥12.50”样式 */
export function yuan(fen) {
  const v = fenToYuan(fen);
  if (v == null) return '—';
  return `¥${v.toFixed(2)}`;
}

export const ui = {
  title: (s) => chalk.bold.yellow(s),
  dim: (s) => chalk.gray(s),
  ok: (s) => chalk.green(s),
  warn: (s) => chalk.yellow(s),
  err: (s) => chalk.red(s),
  price: (s) => chalk.bold.green(s),
  highlight: (s) => chalk.bold.cyan(s),
  label: (s) => chalk.cyan(s),
};

/** 画一条分隔线 */
export function hr(width = 48) {
  return chalk.gray('─'.repeat(width));
}

/* ======================= 视觉组件 ======================= */

/**
 * 计算字符串的「显示宽度」（终端列数）。
 * 关键点：CJK 全角字符、emoji 占 2 列，ASCII 占 1 列，
 * 否则中文混排时边框永远对不齐。会先剥掉 ANSI 颜色码。
 */
export function displayWidth(str) {
  const s = stripAnsi(String(str));
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    // 零宽字符
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首/符号
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名/CJK符号
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji 区
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展B+
  );
}

/** 去掉 ANSI 转义序列，用于正确计算宽度 */
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/\u001b\[[0-9;]*m/g, '');
}

/** 右侧补空格到指定显示宽度 */
export function padEndWidth(str, width) {
  const diff = width - displayWidth(str);
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

/**
 * ASCII 艺术标题（命运麦当劳主 banner）。
 * 用 chalk 上色，但宽度计算基于纯文本，故边框始终对齐。
 */
export function banner() {
  const art = [
    '███╗   ███╗ ██████╗██████╗',
    '████╗ ████║██╔════╝██╔══██╗',
    '██╔████╔██║██║     ██║  ██║',
    '██║╚██╔╝██║██║     ██║  ██║',
    '██║ ╚═╝ ██║╚██████╗██████╔╝',
    '╚═╝     ╚═╝ ╚═════╝╚═════╝ ',
  ];
  const lines = art.map((l) => chalk.bold.yellow(l));
  lines.push(chalk.bold.red('      D E S T I N Y  🍔  命运麦当劳'));
  return '\n' + lines.join('\n');
}

/**
 * 边框卡片。传入标题与若干行内容，自动按显示宽度对齐。
 * @param {string} title 卡片标题（会被居中/左对齐在顶边）
 * @param {string[]} lines 内容行（可含 chalk 颜色）
 * @param {object} opts { color: chalkFn, minWidth }
 */
export function card(title, lines, opts = {}) {
  const color = opts.color || chalk.yellow;
  const pad = 1; // 内容左右各留 1 空格
  const bodyWidths = lines.map((l) => displayWidth(l));
  const titleWidth = title ? displayWidth(title) + 2 : 0; // 标题两侧各留空
  const inner = Math.max(opts.minWidth || 0, titleWidth, ...bodyWidths, 10);
  const totalInner = inner + pad * 2;

  const top = title
    ? color('╭─ ') + chalk.bold(title) + color(' ' + '─'.repeat(Math.max(0, totalInner - titleWidth - 2)) + '╮')
    : color('╭' + '─'.repeat(totalInner) + '╮');
  const bottom = color('╰' + '─'.repeat(totalInner) + '╯');

  const body = lines.map((l) => {
    const content = ' '.repeat(pad) + padEndWidth(l, inner) + ' '.repeat(pad);
    return color('│') + content + color('│');
  });

  return [top, ...body, bottom].join('\n');
}

/**
 * 运势等级：把一个 0~1 的随机值映射为五档运势（含 emoji 与星级）。
 * 用于给“今日天选”增加一点玄学仪式感。
 */
export function fortuneLevel(roll) {
  const levels = [
    { name: '大吉', emoji: '🌟', stars: 5, color: chalk.bold.red },
    { name: '中吉', emoji: '✨', stars: 4, color: chalk.bold.yellow },
    { name: '小吉', emoji: '🍀', stars: 3, color: chalk.bold.green },
    { name: '平', emoji: '🙂', stars: 2, color: chalk.cyan },
    { name: '待努力', emoji: '🌧', stars: 1, color: chalk.gray },
  ];
  // 让“大吉”稀有一点：非线性映射
  const idx =
    roll > 0.88 ? 0 : roll > 0.68 ? 1 : roll > 0.4 ? 2 : roll > 0.15 ? 3 : 4;
  const lv = levels[idx];
  const stars = '★'.repeat(lv.stars) + '☆'.repeat(5 - lv.stars);
  return { ...lv, starbar: stars, text: `${lv.emoji} ${lv.name}  ${stars}` };
}

/** 把任意值安全转成可读字符串，用于兜底展示未知结构 */
export function safeString(value, max = 400) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? s.slice(0, max) + ' …(已截断)' : s;
  } catch {
    return String(value);
  }
}

/**
 * 从结构不确定的 MCP 返回里，按候选键名找出第一个“数组”字段。
 * 麦当劳不同 Tool 返回包装层不完全一致，这里做容错提取。
 */
export function pickArray(obj, candidateKeys = []) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];

  for (const key of candidateKeys) {
    const v = getByPath(obj, key);
    if (Array.isArray(v)) return v;
  }
  // 兜底：深度优先找第一个数组
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = pickArray(value, candidateKeys);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** 支持 a.b.c 形式的取值 */
export function getByPath(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * 剥掉麦当劳统一响应包装 {success, code, message, data}，返回业务 data。
 * 若不是该结构则原样返回。
 */
export function unwrap(res) {
  if (res && typeof res === 'object' && !Array.isArray(res) && 'data' in res &&
      ('success' in res || 'code' in res || 'message' in res)) {
    return res.data;
  }
  return res;
}

/** 取对象中第一个存在的字段 */
export function firstOf(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return fallback;
}
