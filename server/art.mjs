/**
 * 本地封面/背景图探测。
 *
 * 很多人的电影目录里已经放好了 poster.jpg / folder.jpg / fanart.jpg，
 * 这类「本地图」优先于 TMDB 海报——自己放的图永远最符合自己的口味。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

/** 通用封面文件名（按优先级）。 */
const POSTER_BASES = ['poster', 'folder', 'cover', 'front', 'poster-art'];

/** 通用背景图文件名（按优先级）。 */
const BACKDROP_BASES = ['fanart', 'backdrop', 'background', 'banner', 'art'];

/** 读取目录项并按小写名索引，失败返回空 Map。 */
async function listDir(dir, cache) {
  if (cache?.has(dir)) return cache.get(dir);
  let map = new Map();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(path.extname(lower))) continue;
      if (!map.has(lower)) map.set(lower, entry.name);
    }
  } catch {
    map = new Map();
  }
  cache?.set(dir, map);
  return map;
}

function firstMatch(files, bases) {
  for (const base of bases) {
    for (const ext of IMAGE_EXTENSIONS) {
      const actual = files.get(`${base}${ext}`);
      if (actual) return actual;
    }
  }
  return null;
}

/**
 * 在视频所在目录里找封面/背景图。
 *
 * @param {string} dir 视频所在目录
 * @param {string} [videoBaseName] 视频文件名（不含扩展名），用于匹配 `片名-poster.jpg`
 * @param {{cache?: Map<string, Map<string,string>>}} [options] 同一目录的 readdir 结果缓存
 * @returns {Promise<{poster: string|null, backdrop: string|null}>} 相对目录的文件名
 */
export async function findLocalArt(dir, videoBaseName = '', { cache } = {}) {
  const files = await listDir(dir, cache);
  if (!files.size) return { poster: null, backdrop: null };

  const specific = [];
  if (videoBaseName) {
    const base = videoBaseName.toLowerCase();
    specific.push(`${base}-poster`, `${base}.poster`, base);
  }

  const poster = firstMatch(files, specific) ?? firstMatch(files, POSTER_BASES);
  const backdrop = firstMatch(files, specific.map((name) => `${name}-fanart`))
    ?? firstMatch(files, BACKDROP_BASES);
  return { poster, backdrop };
}

/**
 * 把记录里的相对文件名还原成绝对路径（文件可能已被删除，调用方需自行校验）。
 * @param {any} movie
 * @param {'poster'|'backdrop'} kind
 * @returns {string|null}
 */
export function resolveLocalArt(movie, kind) {
  const name = kind === 'backdrop' ? movie?.localArt?.backdrop : movie?.localArt?.poster;
  if (!name) return null;
  const dir = movie?.dir || path.dirname(String(movie?.path ?? ''));
  return path.join(dir, name);
}
