/**
 * 重复文件检测。
 *
 * 两级判断：
 *  1) 体积完全相同的候选之间，算「首尾 4MiB + 总大小」的快速指纹；
 *  2) 指纹相同的归为一组。
 * 只做只读报告，永不自动删除文件。
 */
import { quickHash } from './fsx.mjs';

const CHUNK = 4 * 1024 * 1024;

function reusableHash(movie) {
  const hash = movie.hash;
  if (!hash?.quick) return null;
  if (hash.size !== movie.size || hash.mtimeMs !== movie.mtimeMs) return null;
  return hash.quick;
}

/**
 * @param {{
 *   library: import('./store.mjs').Library,
 *   signal?: AbortSignal,
 *   progress?: (patch: object) => void,
 *   onHash?: (movieId: string, hash: string) => void,
 * }} ctx
 */
export async function findDuplicates({ library, signal, progress = () => {}, onHash = () => {} }) {
  const startedAt = Date.now();
  const movies = library.list().filter((movie) => !movie.missing && Number(movie.size) > 0);

  // 按体积分桶，只有同体积的才值得算指纹
  const buckets = new Map();
  for (const movie of movies) {
    const key = String(movie.size);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(movie);
  }
  const candidates = [...buckets.values()].filter((list) => list.length > 1).flat();
  progress({ phase: '计算指纹', total: candidates.length, done: 0 });

  /** @type {Map<string, any[]>} */
  const byHash = new Map();
  let hashed = 0;
  let reused = 0;
  let failed = 0;

  for (const movie of candidates) {
    if (signal?.aborted) break;
    let hash = reusableHash(movie);
    if (hash) reused += 1;
    else {
      try {
        hash = await quickHash(movie.path, movie.size, CHUNK);
        onHash(movie.id, hash);
        hashed += 1;
      } catch {
        failed += 1;
        progress({ done: hashed + reused + failed });
        continue;
      }
    }
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(movie);
    progress({ done: hashed + reused + failed, current: movie.fileName });
  }

  const groups = [];
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
    groups.push({
      hash,
      size: sorted[0].size,
      count: sorted.length,
      wastedBytes: sorted[0].size * (sorted.length - 1),
      files: sorted.map((movie) => ({
        id: movie.id,
        title: movie.tmdb?.title || movie.parsed?.title || movie.fileName,
        year: movie.tmdb?.year ?? movie.parsed?.year ?? null,
        path: movie.path,
        size: movie.size,
        resolution: movie.probe?.video ? `${movie.probe.video.width}×${movie.probe.video.height}` : movie.parsed?.resolution,
        durationSec: movie.probe?.durationSec ?? null,
        addedAt: movie.addedAt,
        keep: false,
      })),
    });
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes);
  // 每组默认建议保留最早入库的那份
  for (const group of groups) if (group.files.length) group.files[0].keep = true;

  // 同片名 + 同年份但不同文件（可能是不同版本/画质）
  const titleBuckets = new Map();
  for (const movie of movies) {
    const title = movie.tmdb?.title || movie.parsed?.title;
    const year = movie.tmdb?.year ?? movie.parsed?.year;
    if (!title) continue;
    const key = `${String(title).toLowerCase().replace(/\s+/g, ' ')}|${year ?? ''}`;
    if (!titleBuckets.has(key)) titleBuckets.set(key, []);
    titleBuckets.get(key).push(movie);
  }
  const nearGroups = [];
  for (const [, list] of titleBuckets) {
    if (list.length < 2) continue;
    if (new Set(list.map((m) => m.size)).size === 1) continue; // 已由指纹组覆盖
    nearGroups.push({
      title: list[0].tmdb?.title || list[0].parsed?.title,
      year: list[0].tmdb?.year ?? list[0].parsed?.year ?? null,
      files: list.map((movie) => ({
        id: movie.id,
        path: movie.path,
        size: movie.size,
        resolution: movie.probe?.video ? `${movie.probe.video.width}×${movie.probe.video.height}` : movie.parsed?.resolution,
        durationSec: movie.probe?.durationSec ?? null,
      })),
    });
  }

  return {
    scanned: movies.length,
    candidates: candidates.length,
    hashed,
    reused,
    failed,
    groups,
    nearGroups,
    wastedBytes: groups.reduce((sum, group) => sum + group.wastedBytes, 0),
    elapsedMs: Date.now() - startedAt,
  };
}
