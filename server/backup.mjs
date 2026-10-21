/**
 * 备份、导出、完整性校验。
 * 备份 = data 目录内一份自包含快照（config + library + manifest 校验和），
 * 直接拷走 data 目录即可迁移到另一台机器。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir, hashFile, pathExists, quickHash, readJson, statSafe, writeFileAtomic, writeJsonAtomic,
} from './fsx.mjs';

export const CSV_COLUMNS = [
  'id', 'title', 'originalTitle', 'year', 'kind', 'path', 'folderName', 'sizeBytes', 'durationMin',
  'resolution', 'width', 'height', 'fps', 'videoCodec', 'hdr', 'audioTracks', 'audioCodecs',
  'subtitleTracks', 'container', 'tmdbId', 'imdbId', 'genres', 'directors', 'voteAverage',
  'matchState', 'tags', 'collections', 'notes', 'missing', 'addedAt', 'lastSeenAt', 'lastPlayedAt', 'playCount',
];

function timestamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  // 带毫秒，避免同一秒内连续备份/导出互相覆盖
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function displayTitle(movie) {
  return movie.tmdb?.title || movie.parsed?.title || movie.fileName || '';
}

/** 电影记录 -> CSV 行数组（首行为表头）。 */
export function moviesToCsv(movies) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const movie of movies) {
    const video = movie.probe?.video ?? {};
    const row = {
      id: movie.id,
      title: displayTitle(movie),
      originalTitle: movie.tmdb?.originalTitle ?? '',
      year: movie.tmdb?.year ?? movie.parsed?.year ?? '',
      kind: movie.kind ?? 'movie',
      path: movie.path,
      folderName: movie.folderName ?? '',
      sizeBytes: movie.size ?? '',
      durationMin: movie.probe?.durationSec ? Math.round(movie.probe.durationSec / 60) : '',
      resolution: video.width && video.height ? `${video.width}x${video.height}` : movie.parsed?.resolution ?? '',
      width: video.width ?? '',
      height: video.height ?? '',
      fps: video.fps ?? '',
      videoCodec: video.codec ?? movie.parsed?.videoCodec ?? '',
      hdr: video.hdr ?? '',
      audioTracks: (movie.probe?.audio ?? []).length || '',
      audioCodecs: [...new Set((movie.probe?.audio ?? []).map((a) => a.codec).filter(Boolean))].join('/'),
      subtitleTracks: (movie.probe?.subtitles ?? []).length || '',
      container: movie.probe?.container ?? path.extname(movie.path).slice(1),
      tmdbId: movie.tmdb?.id ?? '',
      imdbId: movie.tmdb?.imdbId ?? '',
      genres: (movie.tmdb?.genres ?? []).join('/'),
      directors: (movie.tmdb?.directors ?? []).join('/'),
      voteAverage: movie.tmdb?.voteAverage ?? '',
      matchState: movie.matchState ?? '',
      tags: (movie.tags ?? []).join('/'),
      collections: (movie.collections ?? []).join('/'),
      notes: movie.notes ?? '',
      missing: movie.missing ? 'yes' : 'no',
      addedAt: movie.addedAt ?? '',
      lastSeenAt: movie.lastSeenAt ?? '',
      lastPlayedAt: movie.lastPlayedAt ?? '',
      playCount: movie.playCount ?? 0,
    };
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  // 带 BOM，Excel 直接打开不乱码
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** 电影记录 -> 可迁移的 JSON（不含运行时体积/stat 之外冗余）。 */
export function moviesToJson(movies) {
  return JSON.stringify(
    {
      app: 'doomsday-movie-library',
      exportedAt: new Date().toISOString(),
      count: movies.length,
      movies,
    },
    null,
    2,
  );
}

/**
 * 创建备份快照。
 *
 * includeCache=true 时会把离线资源一起拷走：
 *   cache/tmdb/*.json  （刮削响应缓存）
 *   cache/images/*     （海报/背景图）
 *   cache/posters/*    （自定义截帧封面）
 * 这样换机器或重装后，断网状态下也能直接看到封面与简介。
 *
 * @param {{dataDir: string, config: object, library: import('./store.mjs').Library, keep?: number, includeCache?: boolean}} opts
 */
export async function createBackup({ dataDir, config, library, keep = 10, includeCache = true }) {
  const stamp = timestamp();
  const dir = path.join(dataDir, 'backups', `backup-${stamp}`);
  await ensureDir(dir);
  await library.flush();

  const libraryTarget = path.join(dir, 'library.json');
  await writeJsonAtomic(libraryTarget, {
    version: 1,
    savedAt: new Date().toISOString(),
    count: library.size,
    movies: library.list(),
  });
  const configTarget = path.join(dir, 'config.json');
  await writeJsonAtomic(configTarget, config);

  const files = [];
  for (const file of [libraryTarget, configTarget]) {
    const stat = await fs.stat(file);
    files.push({ name: path.basename(file), bytes: stat.size, sha256: await hashFile(file) });
  }

  // 离线资源：缓存 JSON + 图片
  const cacheStats = { files: 0, bytes: 0 };
  if (includeCache) {
    for (const sub of ['cache/tmdb', 'cache/images', 'cache/posters']) {
      const source = path.join(dataDir, sub);
      const target = path.join(dir, sub);
      const entries = await fs.readdir(source).catch(() => []);
      if (!entries.length) continue;
      await fs.cp(source, target, { recursive: true, force: true });
      for (const entry of entries) {
        const stat = await fs.stat(path.join(source, entry)).catch(() => null);
        if (stat?.isFile()) {
          cacheStats.files += 1;
          cacheStats.bytes += stat.size;
        }
      }
    }
  }

  const manifest = {
    app: 'doomsday-movie-library',
    createdAt: new Date().toISOString(),
    counts: { movies: library.size },
    cache: cacheStats,
    files,
    note: includeCache
      ? '含 cache/（刮削缓存 + 海报 + 自定义封面），拷回 data/ 下即可离线恢复全部封面与简介'
      : '仅含 config + library；要保留封面和简介请带上 data/cache 目录，或用 includeCache 重新备份',
  };
  await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  const pruned = await pruneBackups(dataDir, keep);
  return { dir, files, manifest, pruned };
}

/** 只保留最近 keep 份备份。 */
export async function pruneBackups(dataDir, keep = 10) {
  const dir = path.join(dataDir, 'backups');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => entry.name)
    .sort();
  const excess = dirs.slice(0, Math.max(0, dirs.length - Math.max(1, keep)));
  for (const name of excess) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
  return excess;
}

/** 列出备份。 */
export async function listBackups(dataDir) {
  const dir = path.join(dataDir, 'backups');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue;
    const full = path.join(dir, entry.name);
    const manifest = await readJson(path.join(full, 'manifest.json'), null);
    const library = await readJson(path.join(full, 'library.json'), null);
    let bytes = 0;
    for (const file of manifest?.files ?? []) bytes += Number(file.bytes) || 0;
    out.push({
      name: entry.name,
      dir: full,
      createdAt: manifest?.createdAt ?? null,
      movies: library?.count ?? manifest?.counts?.movies ?? 0,
      bytes,
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * 校验库完整性：文件是否还在、体积是否变了、指纹是否一致。
 * deep=true 时重算快速指纹（较慢）。
 */
export async function verifyLibrary({ library, config, deep = false, signal, progress = () => {} }) {
  const movies = library.list();
  const issues = [];
  const stats = { checked: 0, ok: 0, missing: 0, sizeMismatch: 0, mtimeChanged: 0, hashChecked: 0, hashMismatch: 0 };
  progress({ phase: '核对文件', total: movies.length, done: 0 });

  for (let index = 0; index < movies.length; index += 1) {
    if (signal?.aborted) break;
    const movie = movies[index];
    const stat = await statSafe(movie.path);
    stats.checked += 1;

    if (!stat?.isFile()) {
      stats.missing += 1;
      issues.push({ id: movie.id, path: movie.path, type: 'missing', message: '文件不存在' });
    } else if (Number(movie.size) && stat.size !== Number(movie.size)) {
      stats.sizeMismatch += 1;
      issues.push({
        id: movie.id,
        path: movie.path,
        type: 'size-mismatch',
        message: `体积变化：记录 ${movie.size} 字节，实际 ${stat.size} 字节`,
      });
    } else {
      stats.ok += 1;
      if (Number(movie.mtimeMs) && Math.round(stat.mtimeMs) !== Number(movie.mtimeMs)) {
        stats.mtimeChanged += 1;
      }
    }

    if (deep && movie.hash?.quick && stat?.isFile()) {
      try {
        const fresh = await quickHash(movie.path, stat.size, 4 * 1024 * 1024);
        stats.hashChecked += 1;
        if (fresh !== movie.hash.quick) {
          stats.hashMismatch += 1;
          issues.push({ id: movie.id, path: movie.path, type: 'hash-mismatch', message: '内容指纹与记录不一致' });
        }
      } catch {
        // 读取失败已在 missing/size 分支覆盖
      }
    }
    progress({ done: index + 1, current: movie.fileName });
  }

  return { ...stats, deep, issues: issues.slice(0, 1000), issueCount: issues.length };
}

/** 校验 data 目录里的 JSON 是否能解析（防止迁移时文件损坏）。 */
export async function verifyDataFiles(dataDir) {
  const targets = ['config.json', 'library.json'];
  const results = [];
  for (const name of targets) {
    const file = path.join(dataDir, name);
    if (!(await pathExists(file))) {
      results.push({ name, ok: false, message: '文件不存在' });
      continue;
    }
    try {
      const stat = await fs.stat(file);
      const data = await readJson(file, null);
      results.push({ name, ok: data !== null, bytes: stat.size, message: data === null ? '内容为空' : 'ok' });
    } catch (err) {
      results.push({ name, ok: false, message: err.message });
    }
  }
  return results;
}

/** 把导出文件写到 data/exports 下。 */
export async function writeExport({ dataDir, format, content }) {
  const dir = path.join(dataDir, 'exports');
  await ensureDir(dir);
  const ext = format === 'csv' ? 'csv' : 'json';
  const file = path.join(dir, `movies-${timestamp()}.${ext}`);
  await writeFileAtomic(file, content);
  const stat = await fs.stat(file);
  return { file, bytes: stat.size };
}
