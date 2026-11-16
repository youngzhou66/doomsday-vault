/**
 * 会话（Cookie）认证：给公网部署用的登录页用。
 *
 * 为什么不继续用 HTTP Basic：浏览器那个原生弹窗是浏览器画的，
 * 页面无法改样式；这里改成「服务端渲染登录页 + 签名 Cookie」，
 * 同时保留 Basic 兼容，方便 curl / 脚本。
 */
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'dmv_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 生成签名后的会话 token（payload.exp 到期失效）。 */
export function signSession(payload, secret, ttlMs = SESSION_TTL_MS) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** 校验会话 token，失败返回 null。 */
export function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 解析 Cookie 头。 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** 简单的登录失败限速：每个 IP 每分钟最多 6 次。 */
export class LoginThrottle {
  constructor({ limit = 6, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** @returns {boolean} true 表示本次允许尝试 */
  allow(ip) {
    const now = Date.now();
    const record = this.hits.get(ip);
    if (!record || record.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    record.count += 1;
    return record.count <= this.limit;
  }

  reset(ip) {
    this.hits.delete(ip);
  }
}
