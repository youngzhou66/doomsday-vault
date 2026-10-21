/**
 * 文件系统与哈希工具箱。
 * 全部基于 node: 内置模块，零外部依赖。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 递归建目录（幂等）。 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** 路径是否存在（不抛错）。 */
export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 读 JSON，文件不存在时返回 fallback；损坏时抛出可读错误。 */
export async function readJson(file, fallback = null) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 损坏：${file} -> ${err.message}`);
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免断电/中断留下半截文件。 */
export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 原子写任意文本/二进制。 */
export async function writeFileAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/** 字符串哈希（十六进制）。 */
export function hashText(text, algo = 'sha256') {
  return createHash(algo).update(text).digest('hex');
}

/** 稳定短 id。 */
export function shortId(input, len = 12) {
  return hashText(String(input), 'sha1').slice(0, len);
}

/** 跨平台路径比较键：Windows/macOS 大小写不敏感。 */
export function pathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/**
 * 由文件绝对路径推导稳定的记录 id。
 * 用在扫描入库、根目录重定位（盘符变化）等所有需要保持一致的地方。
 */
export function mediaId(absPath) {
  return `m_${shortId(pathKey(absPath), 14)}`;
}

/**
 * child 是否位于 parent 之内（用于阻止越权访问库外文件）。
 * @param {string} parent
 * @param {string} child
 * @param {{allowEqual?: boolean}} [opts]
 */
export function isInside(parent, child, { allowEqual = false } = {}) {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return allowEqual;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function hashStreamInto(hash, file, opts) {
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file, opts);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

/** 全文件哈希，默认 sha256。 */
export async function hashFile(file, algo = 'sha256') {
  const hash = createHash(algo);
  await hashStreamInto(hash, file);
  return hash.digest('hex');
}

/**
 * 快速指纹：文件大小 + 首尾各 4MiB 内容。
 * 大文件重复检测用它，避免读整个 GB 级文件。
 */
export async function quickHash(file, size, chunk = 4 * 1024 * 1024) {
  let stat = null;
  if (typeof size !== 'number') stat = await fs.stat(file);
  const total = typeof size === 'number' ? size : stat.size;
  const hash = createHash('sha1');
  hash.update(`size:${total}`);
  if (total === 0) return hash.digest('hex');
  if (total <= chunk * 2) {
    await hashStreamInto(hash, file);
  } else {
    await hashStreamInto(hash, file, { start: 0, end: chunk - 1 });
    await hashStreamInto(hash, file, { start: total - chunk, end: total - 1 });
  }
  return hash.digest('hex');
}

/** 人类可读体积（服务端日志/CLI 用）。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

/** 安全解析 stat，失败返回 null。 */
export async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** 读取目录项，失败返回空数组（权限不足的目录不应中断整次扫描）。 */
export async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
