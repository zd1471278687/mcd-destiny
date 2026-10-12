/**
 * 轻量 MCP (Model Context Protocol) 客户端
 *
 * 对接麦当劳 MCP Server（Streamable HTTP 协议）。
 * 只实现省钱/积分管家所需的最小子集：
 *   1. initialize 握手，拿到 Mcp-Session-Id
 *   2. notifications/initialized 通知
 *   3. tools/call 调用具体 Tool
 *
 * 传输说明：
 *   - 请求：POST JSON-RPC 2.0 到接入地址
 *   - 响应：可能是 application/json，也可能是 text/event-stream(SSE)，两种都要解析
 *   - 鉴权：请求头 Authorization: Bearer <token>
 *
 * 参考：https://github.com/M-China/mcd-mcp-server
 */

const PROTOCOL_VERSION = '2025-03-26';

export class McpError extends Error {
  constructor(message, { code, httpStatus } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url   MCP Server 接入地址
   * @param {string} opts.token MCP Token（Bearer）
   */
  constructor({ url, token }) {
    if (!token) {
      throw new McpError('缺少 MCP Token，请在 .env 中配置 MCD_MCP_TOKEN');
    }
    this.url = url || 'https://mcp.mcd.cn';
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  #headers(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      // 同时声明可接收 JSON 与 SSE，兼容两种响应形态
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    return headers;
  }

  /** 解析响应体：兼容纯 JSON 与 SSE 两种格式 */
  async #parseBody(res) {
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();

    if (contentType.includes('text/event-stream')) {
      // SSE：逐行提取 data: 后面的 JSON，取最后一个带 result/error 的消息
      let lastMessage = null;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          lastMessage = JSON.parse(payload);
        } catch {
          // 忽略无法解析的分片
        }
      }
      return lastMessage;
    }

    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new McpError(`无法解析 MCP 响应: ${raw.slice(0, 200)}`);
    }
  }

  /** 发送一个 JSON-RPC 请求并返回解析后的消息 */
  async #rpc(method, params, { isNotification = false } = {}) {
    const body = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    if (!isNotification) {
      body.id = this.nextId++;
    }

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new McpError(`网络请求失败: ${err.message}。请检查网络或接入地址。`);
    }

    // 捕获会话 id（initialize 时服务端下发）
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) {
      throw new McpError('MCP Token 无效、已过期或未提供（HTTP 401）。请检查 MCD_MCP_TOKEN。', {
        httpStatus: 401,
      });
    }
    if (res.status === 429) {
      throw new McpError('触发限流（HTTP 429，超过 600 次/分钟）。请降低调用频率后重试。', {
        httpStatus: 429,
      });
    }

    if (isNotification) {
      // 通知无需响应体
      return null;
    }

    if (!res.ok) {
      throw new McpError(`MCP 请求失败，HTTP ${res.status}`, { httpStatus: res.status });
    }

    const message = await this.#parseBody(res);
    if (message && message.error) {
      throw new McpError(
        `MCP 返回错误: ${message.error.message || JSON.stringify(message.error)}`,
        { code: message.error.code }
      );
    }
    return message;
  }

  /** 建立会话：initialize + initialized 通知 */
  async connect() {
    if (this.initialized) return;

    await this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcd-destiny', version: '1.0.0' },
    });

    // 告知服务端初始化完成
    await this.#rpc('notifications/initialized', undefined, { isNotification: true });

    this.initialized = true;
  }

  /**
   * 调用一个 MCP Tool
   * @param {string} name   工具名，如 "query-nearby-stores"
   * @param {object} args   工具入参
   * @returns {Promise<any>} 解析后的业务数据（已尽量从 content 中还原为对象）
   */
  async callTool(name, args = {}) {
    await this.connect();

    const message = await this.#rpc('tools/call', {
      name,
      arguments: args,
    });

    if (!message || !message.result) {
      throw new McpError(`工具 ${name} 无返回结果`);
    }

    const result = message.result;

    if (result.isError) {
      const text = extractText(result.content);
      throw new McpError(`工具 ${name} 执行出错: ${text || '未知错误'}`);
    }

    // 优先用结构化返回
    if (result.structuredContent != null) {
      checkBusinessError(result.structuredContent, name);
      return result.structuredContent;
    }

    // MCP 规范：result.content 是一个数组，通常是 [{type:'text', text:'...'}]
    // 麦当劳 Tool 的 text 有三种形态：
    //   1. 纯 JSON
    //   2. 说明文字 + JSON（JSON 夹在中间）
    //   3. 纯 Markdown 文字（无 JSON）
    const text = extractText(result.content);
    if (text == null) {
      return result;
    }

    const parsed = extractJson(text);
    if (parsed != null) {
      checkBusinessError(parsed, name);
      return parsed;
    }
    // 没有 JSON 就原样返回文本（供上层按文本展示）
    return text;
  }
}

/**
 * 识别麦当劳统一响应里的业务级失败（success:false / code 非 200）。
 * 这类错误 HTTP 层是 200，但业务未成功，需要显式抛出让用户看到原因。
 */
function checkBusinessError(payload, toolName) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const hasEnvelope = 'success' in payload || 'code' in payload;
    if (hasEnvelope) {
      const ok = payload.success === true || payload.code === 200 || payload.code === '200';
      if (!ok) {
        const msg = payload.message || `code=${payload.code}`;
        throw new McpError(`工具 ${toolName} 返回：${msg}`, { code: payload.code });
      }
    }
  }
}

/**
 * 从一段可能夹带说明文字的文本中抽取 JSON。
 * 策略：先整体 parse；失败则定位第一个 { 或 [ 到与之匹配的收尾括号。
 */
function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续尝试提取内嵌 JSON
  }

  const start = firstJsonStart(trimmed);
  if (start === -1) return null;

  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 找到第一个看起来像 JSON 容器起点的 { 或 [ */
function firstJsonStart(text) {
  const curly = text.indexOf('{');
  const square = text.indexOf('[');
  if (curly === -1) return square;
  if (square === -1) return curly;
  return Math.min(curly, square);
}

/** 从 MCP content 数组中拼接文本 */
function extractText(content) {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  return parts.length ? parts.join('\n') : null;
}
