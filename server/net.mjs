/**
 * 自带 DNS 绕行能力的 HTTPS 客户端。
 *
 * 为什么需要它：某些网络会把 api.themoviedb.org 的 DNS 污染到
 * Facebook / Twitter 的地址段（2a03:2880:…:face:b00c、104.244.x 之类），
 * 导致连接直接超时。而 TMDB 前面的 CloudFront 节点其实是通的，
 * 同域的 www.themoviedb.org 也能正常解析。
 *
 * 于是策略是：
 *   1. 系统 DNS → 过滤明显被污染的地址 → TCP 探活；
 *   2. 不行就查 DoH（doh.pub / 阿里 DNS）；
 *   3. 还不行就用同域兄弟域名解析出的地址，配上原域名的 SNI 去访问；
 *   4. 全部失败才报错。
 *
 * 解析结果缓存 10 分钟，避免每次请求都探活。
 */
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';

const CACHE_TTL_MS = 10 * 60 * 1000;
const TCP_TIMEOUT_MS = 2500;

/** 已知的污染/黑洞地址特征。 */
const SUSPICIOUS_V4 = [/^65\.49\./, /^104\.244\./, /^8\.7\./, /^46\.82\./, /^78\.16\./, /^31\.13\./, /^37\.61\./];
const SUSPICIOUS_V6 = [/^2a03:2880:/i, /:face:b00c$/i, /^2001:db8:/i];

/** 同域兄弟域名：主 API 域名被污染时，用这些域名的 IP 顶替。 */
const HOST_ALIASES = {
  'api.themoviedb.org': ['www.themoviedb.org', 'themoviedb.org'],
  'image.tmdb.org': ['www.themoviedb.org'],
};

/** 可用的 DoH 端点（按顺序尝试）。 */
const DOH_PROVIDERS = [
  { name: 'doh.pub', url: (host) => `https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=A` },
  { name: 'alidns', url: (host) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=A` },
];

const resolutionCache = new Map();
/** 记录每个 host 最近一次用了哪种策略，供诊断接口展示。 */
export const resolutionHistory = new Map();

/** 地址是否像被污染的结果。 */
export function isSuspiciousAddress(address) {
  const text = String(address ?? '');
  if (!text) return true;
  if (text.includes(':')) return SUSPICIOUS_V6.some((re) => re.test(text));
  return SUSPICIOUS_V4.some((re) => re.test(text));
}

/** TCP 探活。 */
export function probeTcp(address, port = 443, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 系统 DNS 解析（A + AAAA）。 */
async function systemResolve(host) {
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    return records.map((record) => ({ address: record.address, family: record.family }));
  } catch {
    return [];
  }
}

/** 通过 DoH 解析，返回同样的结构。 */
async function dohResolve(host) {
  for (const provider of DOH_PROVIDERS) {
    try {
      const url = provider.url(host);
      const text = await rawHttpsGet(url, { timeoutMs: 4000 });
      const data = JSON.parse(text);
      const answers = Array.isArray(data?.Answer) ? data.Answer : [];
      const ips = answers
        .filter((answer) => answer.type === 1 || answer.type === 28)
        .map((answer) => ({ address: answer.data, family: answer.type === 28 ? 6 : 4 }));
      if (ips.length) return { ips, via: `doh:${provider.name}` };
    } catch {
      // 换下一个 DoH
    }
  }
  return { ips: [], via: 'doh:none' };
}

/** 原始 HTTPS GET（只用于 DoH / 探针，不参与业务请求）。 */
function rawHttpsGet(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: 'application/dns-json' }, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => request.destroy(new Error('DoH 超时')));
    request.on('error', reject);
  });
}

/**
 * 给某个 host 挑一批「能连上」的地址。
 * @param {string} host
 * @param {{force?: boolean, deps?: {systemResolve?: Function, dohResolve?: Function, probeTcp?: Function, aliases?: object}}} [options]
 *        deps 仅供测试注入
 * @returns {Promise<{ips: {address: string, family: number}[], via: string, attempts: string[]}>}
 */
export async function resolveCandidates(host, { force = false, deps = {} } = {}) {
  const systemResolveFn = deps.systemResolve ?? systemResolve;
  const dohResolveFn = deps.dohResolve ?? dohResolve;
  const probeFn = deps.probeTcp ?? probeTcp;
  const aliases = deps.aliases ?? HOST_ALIASES;

  const cached = resolutionCache.get(host);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return { ips: cached.ips, via: cached.via, attempts: [] };
  }

  const attempts = [];
  const accept = async (list, via) => {
    const usable = list.filter((item) => !isSuspiciousAddress(item.address));
    for (const item of usable) {
      if (await probeFn(item.address, 443, TCP_TIMEOUT_MS)) {
        attempts.push(`${via}:${item.address}`);
        return { ips: [item], via, attempts };
      }
    }
    attempts.push(`${via}:无可用地址`);
    return null;
  };

  // 1) 系统 DNS
  const systemIps = await systemResolveFn(host);
  let result = await accept(systemIps, 'system');
  if (!result) {
    // 2) DoH
    const { ips, via } = await dohResolveFn(host);
    result = await accept(ips, via);
  }
  // 3) 同域兄弟域名
  if (!result) {
    for (const alias of aliases[host] ?? []) {
      const aliasIps = await systemResolveFn(alias);
      const accepted = await accept(aliasIps, `alias:${alias}`);
      if (accepted) {
        result = accepted;
        break;
      }
    }
  }
  // 4) 兜底：把系统 DNS 的结果原样交出去，让上层报具体错误
  if (!result) {
    result = { ips: systemIps, via: 'system-unverified', attempts };
  }

  result.attempts = attempts;
  resolutionHistory.set(host, { ...result, at: new Date().toISOString() });
  if (result.ips.length) {
    resolutionCache.set(host, { ips: result.ips, via: result.via, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return result;
}

/**
 * 用「指定 IP + 原域名 SNI」发一次 HTTPS 请求。
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
function httpsOnce(url, { address, family }, { method = 'GET', headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      protocol: 'https:',
      host: target.hostname,
      servername: target.hostname, // SNI 必须是原域名
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: timeoutMs,
      agent: false,
      // Node 20+ 在 autoSelectFamily 时会用 all:true 调用 lookup，此时必须回数组
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * 带 DNS 绕行的 HTTPS 请求：按候选地址依次重试。
 * @param {string} url
 * @param {{method?: string, headers?: object, timeoutMs?: number}} [options]
 */
export async function requestResilient(url, options = {}) {
  const host = new URL(url).hostname;
  const { ips, via } = await resolveCandidates(host);
  if (!ips.length) throw new Error(`无法解析 ${host}（DNS 可能被污染）`);

  let lastError = null;
  for (const ip of ips) {
    try {
      const response = await httpsOnce(url, ip, options);
      return { ...response, via, address: ip.address };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`连接 ${host} 失败：${lastError?.message ?? '未知错误'}`);
}

/** 取 JSON。 */
export async function requestJson(url, options = {}) {
  const response = await requestResilient(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  const text = response.body.toString('utf8');
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload, text, via: response.via, address: response.address };
}

/** 取二进制（海报等）。 */
export async function requestBuffer(url, options = {}) {
  const response = await requestResilient(url, options);
  return {
    status: response.status,
    headers: response.headers,
    buffer: response.body,
    contentType: response.headers['content-type'] ?? 'application/octet-stream',
    via: response.via,
  };
}

/**
 * 网络诊断：给每个 host 一份「系统 DNS / 是否可疑 / 实际用哪个地址」的报告。
 * @param {string[]} hosts
 */
export async function diagnoseHosts(hosts) {
  const report = [];
  for (const host of hosts) {
    const systemIps = await systemResolve(host);
    const entry = {
      host,
      systemDns: systemIps,
      suspicious: systemIps.length ? systemIps.every((item) => isSuspiciousAddress(item.address)) : null,
      useIps: [],
      via: null,
      tcpOk: false,
    };
    const { ips, via } = await resolveCandidates(host, { force: true });
    entry.useIps = ips;
    entry.via = via;
    entry.tcpOk = ips.length > 0;
    report.push(entry);
  }
  return report;
}

/** 清空解析缓存（改配置/重试时用）。 */
export function clearResolutionCache() {
  resolutionCache.clear();
}
