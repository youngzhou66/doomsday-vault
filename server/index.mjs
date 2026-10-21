/**
 * 末日电影库 — 本地服务入口。
 *
 * 定位：把浏览器拿不到的 OS 能力（目录扫描、ffprobe、TMDB、调播放器）收进这个
 * 零依赖的本地进程；前端 web/ 是纯静态页面，由本进程托管，也可放到任意静态服务器上。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG, PLAYER_PRESETS, VIDEO_EXTENSIONS, loadConfig, publicConfig, sanitizeConfig, saveConfig,
} from './config.mjs';
import { Library } from './store.mjs';
import { Jobs } from './jobs.mjs';
import { detectFfprobe, probeFile } from './probe.mjs';
import { resolveLocalArt } from './art.mjs';
import { diagnoseHosts, isSuspiciousAddress, requestJson as netRequestJson } from './net.mjs';
import { Thumbnailer } from './thumb.mjs';
import { shellThumbnailSupported } from './osthumb.mjs';
import { movieIdForFile, previewParse, runScan } from './scan.mjs';
import { TmdbClient, pickBest, scoreCandidate } from './tmdb.mjs';
import { findDuplicates } from './dupes.mjs';
import { launchPlayer } from './player.mjs';
import {
  createBackup, listBackups, moviesToCsv, moviesToJson, verifyDataFiles, verifyLibrary, writeExport,
} from './backup.mjs';
import { ensureDir, isInside, pathExists, pathKey, statSafe } from './fsx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const DATA_DIR = path.resolve(process.env.MOVIE_DATA_DIR || path.join(ROOT_DIR, 'data'));
const APP_NAME = '末日电影库';
const APP_VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── 全局状态 ────────────────────────────────────────────────────────────
const startedAt = new Date();
const library = new Library(DATA_DIR);
const jobs = new Jobs();
let config = sanitizeConfig({}, DEFAULT_CONFIG);
let ffprobeState = { ok: false, path: null, version: null, error: '尚未检测', candidates: [] };
let dupesCache = null;
let activeScanId = null;

const tmdb = new TmdbClient({ dataDir: DATA_DIR, getConfig: () => config });
const thumbnailer = new Thumbnailer({ dataDir: DATA_DIR, getConfig: () => config });

// ── HTTP 工具 ───────────────────────────────────────────────────────────
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `请求体超过上限 ${Math.round(limit / 1024 / 1024)}MB`);
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start = rawStart === '' ? NaN : Number(rawStart);
  let end = rawEnd === '' ? NaN : Number(rawEnd);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // 后缀范围：最后 N 字节
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(req, res, file, { download = null, contentType = null, cache = 'no-cache' } = {}) {
  const stat = await statSafe(file);
  if (!stat?.isFile()) throw new HttpError(404, '文件不存在');
  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  const type = contentType ?? MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const baseHeaders = {
    'Content-Type': type,
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  };
  if (download) baseHeaders['Content-Disposition'] = `attachment; filename="${download}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  if (range?.invalid) {
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start: range.start, end: range.end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ── 路由 ────────────────────────────────────────────────────────────────
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/\/:(\w+)/g, (_, key) => {
    keys.push(key);
    return '/([^/]+)';
  })}/?$`);
  routes.push({ method, regex, keys, handler });
}

function matchRoute(method, pathname) {
  for (const item of routes) {
    if (item.method !== method) continue;
    const match = item.regex.exec(pathname);
    if (!match) continue;
    const params = {};
    item.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { handler: item.handler, params };
  }
  return null;
}

// ── 电影记录序列化 ──────────────────────────────────────────────────────
function displayTitle(movie) {
  return movie.tmdb?.title || movie.parsed?.title || movie.fileName || '未命名';
}
function displayYear(movie) {
  return movie.tmdb?.year ?? movie.parsed?.year ?? null;
}

function summarize(movie) {
  const video = movie.probe?.video ?? null;
  return {
    id: movie.id,
    title: displayTitle(movie),
    originalTitle: movie.tmdb?.originalTitle ?? null,
    year: displayYear(movie),
    kind: movie.kind ?? 'movie',
    path: movie.path,
    fileName: movie.fileName,
    folderName: movie.folderName ?? null,
    size: movie.size ?? 0,
    durationSec: movie.probe?.durationSec ?? null,
    resolution: video ? `${video.width}×${video.height}` : movie.parsed?.resolution ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hdr: video?.hdr ?? null,
    videoCodec: video?.codec ?? movie.parsed?.videoCodec ?? null,
    audioCount: movie.probe?.audio?.length ?? 0,
    subtitleCount: movie.probe?.subtitles?.length ?? 0,
    edition: movie.parsed?.edition ?? null,
    tmdbId: movie.tmdb?.id ?? null,
    vote: movie.tmdb?.voteAverage ?? null,
    genres: movie.tmdb?.genres ?? [],
    tags: movie.tags ?? [],
    collections: movie.collections ?? [],
    matchState: movie.matchState ?? 'pending',
    missing: Boolean(movie.missing),
    probeOk: Boolean(movie.probe),
    playCount: movie.playCount ?? 0,
    resumeSec: movie.resumeSec ?? 0,
    watched: Boolean(movie.watchedAt),
    watchedAt: movie.watchedAt ?? null,
    addedAt: movie.addedAt ?? null,
    lastSeenAt: movie.lastSeenAt ?? null,
    parsedTitle: movie.parsed?.title ?? null,
    parsedYear: movie.parsed?.year ?? null,
  };
}

/**
 * 给列表项补上「有没有封面」。
 * 顺序与接口保持一致：自定义截帧 > 本地图 > TMDB 缓存图。
 */
async function withPosterFlags(items) {
  return Promise.all(items.map(async (item) => {
    const movie = library.get(item.id);
    if (movie?.customPoster?.file) {
      const stat = await statSafe(path.join(thumbnailer.posterDir, movie.customPoster.file));
      if (stat?.isFile()) {
        return { ...item, hasPoster: true, posterSource: movie.customPoster.source === 'tmdb' ? 'custom' : `custom:${movie.customPoster.source ?? 'manual'}` };
      }
    }
    const localPoster = resolveLocalArt(movie ?? {}, 'poster');
    if (localPoster) {
      const stat = await statSafe(localPoster);
      if (stat?.isFile()) return { ...item, hasPoster: true, posterSource: 'local' };
    }
    const hasTmdbPoster = item.tmdbId ? await pathExists(tmdb.imageFile(item.tmdbId, 'poster')) : false;
    return { ...item, hasPoster: hasTmdbPoster, posterSource: hasTmdbPoster ? 'tmdb' : null };
  }));
}

/** 记录里的自定义封面绝对路径（不存在则 null）。 */
async function customPosterPath(movie) {
  const name = movie?.customPoster?.file;
  if (!name) return null;
  const file = path.join(thumbnailer.posterDir, name);
  return (await statSafe(file))?.isFile() ? file : null;
}

function detailOf(movie) {
  const mates = movie.folderPath
    ? library.list().filter((other) => other.id !== movie.id && other.folderPath === movie.folderPath).map(summarize)
    : [];
  return {
    ...summarize(movie),
    dir: movie.dir,
    rootId: movie.rootId,
    rootLabel: movie.rootLabel ?? null,
    relPath: movie.relPath,
    mtimeMs: movie.mtimeMs,
    parsed: movie.parsed,
    probe: movie.probe,
    probeError: movie.probeError ?? null,
    tmdb: movie.tmdb,
    matchError: movie.matchError ?? null,
    notes: movie.notes ?? '',
    hash: movie.hash ?? null,
    folderMates: mates,
    updatedAt: movie.updatedAt ?? null,
    createdAt: movie.addedAt ?? null,
  };
}

// ── 查询与筛选 ──────────────────────────────────────────────────────────
function searchMatches(movie, terms) {
  if (!terms.length) return true;
  const haystack = [
    movie.tmdb?.title, movie.tmdb?.originalTitle, movie.tmdb?.overview,
    (movie.tmdb?.genres ?? []).join(' '), (movie.tmdb?.directors ?? []).join(' '),
    (movie.tmdb?.cast ?? []).map((person) => person.name).join(' '),
    movie.parsed?.title, movie.parsed?.year, movie.fileName, movie.path, movie.folderName,
    (movie.tags ?? []).join(' '), (movie.collections ?? []).join(' '), movie.notes,
    movie.parsed?.resolution, movie.parsed?.edition,
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function applyFilters(movies, query) {
  const state = String(query.state ?? '').trim();
  const missing = String(query.missing ?? '').trim();
  const kind = String(query.kind ?? '').trim();
  const tag = String(query.tag ?? '').trim();
  const collection = String(query.collection ?? '').trim();
  const rootId = String(query.root ?? '').trim();
  const resolution = String(query.resolution ?? '').trim();
  const watched = String(query.watched ?? '').trim();
  const yearFrom = Number(query.yearFrom) || null;
  const yearTo = Number(query.yearTo) || null;
  const terms = String(query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);

  let list = movies.filter((movie) => {
    if (terms.length && !searchMatches(movie, terms)) return false;
    if (state && (movie.matchState ?? 'pending') !== state) return false;
    if (missing === 'yes' && !movie.missing) return false;
    if (missing === 'no' && movie.missing) return false;
    if (watched === 'yes' && !movie.watchedAt) return false;
    if (watched === 'no' && movie.watchedAt) return false;
    if (kind && (movie.kind ?? 'movie') !== kind) return false;
    if (tag && !(movie.tags ?? []).includes(tag)) return false;
    if (collection && !(movie.collections ?? []).includes(collection)) return false;
    if (rootId && movie.rootId !== rootId) return false;
    if (resolution) {
      const actual = movie.probe?.video
        ? `${movie.probe.video.width}×${movie.probe.video.height}`
        : movie.parsed?.resolution ?? '';
      if (!actual.includes(resolution)) return false;
    }
    const year = displayYear(movie);
    if (yearFrom && (!year || year < yearFrom)) return false;
    if (yearTo && (!year || year > yearTo)) return false;
    return true;
  });

  const sortKey = String(query.sort ?? 'addedAt');
  const dir = String(query.dir ?? 'desc') === 'asc' ? 1 : -1;
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const pick = {
    addedAt: (movie) => movie.addedAt ?? '',
    title: (movie) => displayTitle(movie),
    year: (movie) => displayYear(movie) ?? 0,
    size: (movie) => Number(movie.size) || 0,
    duration: (movie) => movie.probe?.durationSec ?? 0,
    rating: (movie) => movie.tmdb?.voteAverage ?? 0,
    lastPlayedAt: (movie) => movie.lastPlayedAt ?? '',
    lastSeenAt: (movie) => movie.lastSeenAt ?? '',
    watchedAt: (movie) => movie.watchedAt ?? '',
  }[sortKey] ?? ((movie) => movie.addedAt ?? '');

  list = [...list].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    if (typeof va === 'string' || typeof vb === 'string') return collator.compare(String(va), String(vb)) * dir;
    return (va - vb) * dir;
  });
  return list;
}

function facetsOf(movies) {
  const tags = new Map();
  const collections = new Map();
  const resolutions = new Map();
  const states = { pending: 0, auto: 0, confirmed: 0, none: 0 };
  const roots = new Map();
  let minYear = null;
  let maxYear = null;
  let totalBytes = 0;
  let missing = 0;
  let watched = 0;
  for (const movie of movies) {
    totalBytes += Number(movie.size) || 0;
    if (movie.missing) missing += 1;
    if (movie.watchedAt) watched += 1;
    states[movie.matchState ?? 'pending'] = (states[movie.matchState ?? 'pending'] ?? 0) + 1;
    for (const tag of movie.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    for (const name of movie.collections ?? []) collections.set(name, (collections.get(name) ?? 0) + 1);
    const resolution = movie.probe?.video
      ? `${movie.probe.video.width}×${movie.probe.video.height}`
      : movie.parsed?.resolution ?? '未知';
    resolutions.set(resolution, (resolutions.get(resolution) ?? 0) + 1);
    const rootLabel = movie.rootLabel ?? movie.rootId ?? '未分组';
    roots.set(rootLabel, (roots.get(rootLabel) ?? 0) + 1);
    const year = displayYear(movie);
    if (year) {
      minYear = minYear === null ? year : Math.min(minYear, year);
      maxYear = maxYear === null ? year : Math.max(maxYear, year);
    }
  }
  const toList = (map) => [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    total: movies.length,
    totalBytes,
    missing,
    watched,
    unwatched: movies.length - watched,
    states,
    tags: toList(tags),
    collections: toList(collections),
    resolutions: toList(resolutions),
    roots: toList(roots),
    yearRange: minYear === null ? null : { min: minYear, max: maxYear },
  };
}

// ── 刮削 ────────────────────────────────────────────────────────────────
async function scrapeRecord(movie, { force = false } = {}) {
  if (!tmdb.enabled) throw new HttpError(400, '未配置 TMDB API Key，请在设置页填写', 'TMDB_NO_KEY');
  const result = await tmdb.scrape(movie.parsed, { force });
  if (!result.match) {
    library.patch(movie.id, {
      matchState: 'none',
      matchError: result.reason ?? '未找到匹配',
      tmdbTriedAt: new Date().toISOString(),
    });
    return { matched: false, reason: result.reason ?? '未找到匹配', candidates: result.candidates ?? [] };
  }
  const match = {
    ...result.match,
    matchScore: result.score,
    query: result.query ?? null,
    posterLanguage: tmdb.posterLanguage,
  };
  // 以下任一情况都要重新下载海报，否则本地缓存会一直停在旧图：
  //  - 海报语言设置变了（"跟随元数据" ↔ "原语言" 等）
  //  - TMDB 返回的海报路径变了
  //  - 用户手动点「重新刮削」（force）
  const languageChanged = (movie.tmdb?.posterLanguage ?? 'follow') !== tmdb.posterLanguage;
  const pathChanged = Boolean(movie.tmdb?.posterPath) && movie.tmdb.posterPath !== match.posterPath;
  const posterChanged = languageChanged || pathChanged;
  const updated = library.patch(movie.id, {
    tmdb: match,
    matchState: 'auto',
    matchError: null,
    tmdbTriedAt: new Date().toISOString(),
  });
  const images = await tmdb.cacheImages(match, { force: Boolean(force) || posterChanged });
  return { matched: true, movie: updated, score: result.score, posterChanged, images };
}

function assertPlayable(movie) {
  if (!movie) throw new HttpError(404, '记录不存在');
  const insideAnyRoot = config.roots.some((root) => isInside(root.path, movie.path, { allowEqual: false }));
  if (!insideAnyRoot) throw new HttpError(403, '该文件不在任何已配置的电影目录内，拒绝访问', 'PATH_OUTSIDE_ROOTS');
  return movie;
}

async function requireFile(movie) {
  const stat = await statSafe(movie.path);
  if (!stat?.isFile()) throw new HttpError(410, '磁盘上的文件已不存在（可能被移动或删除）', 'FILE_MISSING');
  return stat;
}

/**
 * 离线可用性小结（纯计算，不碰磁盘）。
 * 判断一张封面「离线可见」不需要真的去 stat：
 * 自定义截帧 / 本地图文件名 / 已刮削的 TMDB 海报路径，三者有其一就算有。
 */
function offlineSummary() {
  const movies = library.list();
  const withMetadata = movies.filter((movie) => Boolean(movie.tmdb?.id)).length;
  const withPoster = movies.filter((movie) => Boolean(
    movie.customPoster?.file || movie.localArt?.poster || movie.tmdb?.posterPath,
  )).length;
  const withProbe = movies.filter((movie) => Boolean(movie.probe)).length;
  return {
    total: movies.length,
    withMetadata,
    withPoster,
    withProbe,
    ready: movies.length > 0 && withPoster === movies.length && withMetadata === movies.length,
    externalAssets: [],
  };
}

async function countCacheFiles() {
  const dirs = {
    tmdbJson: path.join(DATA_DIR, 'cache', 'tmdb'),
    images: path.join(DATA_DIR, 'cache', 'images'),
    posters: path.join(DATA_DIR, 'cache', 'posters'),
  };
  const result = {};
  for (const [key, dir] of Object.entries(dirs)) {
    const entries = await fs.readdir(dir).catch(() => []);
    let bytes = 0;
    for (const name of entries) {
      const stat = await statSafe(path.join(dir, name));
      if (stat?.isFile()) bytes += stat.size;
    }
    result[key] = { files: entries.length, bytes };
  }
  return result;
}

// ── 路由实现 ────────────────────────────────────────────────────────────
route('GET', '/api/health', async () => ({
  ok: true,
  app: { name: APP_NAME, version: APP_VERSION },
  node: process.version,
  platform: process.platform,
  dataDir: DATA_DIR,
  webDir: WEB_DIR,
  startedAt: startedAt.toISOString(),
  uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
  ffprobe: ffprobeState,
  ffmpeg: thumbnailer.state,
  shellThumb: { supported: shellThumbnailSupported(), preferShell: true },
  offline: offlineSummary(),
  tmdb: {
    configured: tmdb.enabled,
    language: config.tmdb.language,
    posterLanguage: config.tmdb.posterLanguage,
    fallbackLanguage: config.tmdb.fallbackLanguage,
    autoScrape: config.tmdb.autoScrape,
  },
  player: { preset: config.player.preset, command: config.player.command },
  counts: library.stats(),
  facets: facetsOf(library.list()),
  jobs: jobs.running(),
}));

route('GET', '/api/config', async () => ({
  config: publicConfig(config),
  presets: PLAYER_PRESETS,
  extensions: VIDEO_EXTENSIONS,
  platform: process.platform,
  dataDir: DATA_DIR,
  envKey: Boolean((process.env.TMDB_API_KEY ?? '').trim()),
}));

route('PUT', '/api/config', async ({ body }) => {
  if (!body || typeof body !== 'object') throw new HttpError(400, '缺少配置内容');
  const previousFfprobe = config.ffprobePath;
  const previousFfmpeg = config.thumb?.ffmpegPath;
  const next = sanitizeConfig(body, config);
  // 端口改动需要重启才生效，先保留运行时端口
  config = await saveConfig(DATA_DIR, next);
  if (config.ffprobePath !== previousFfprobe) ffprobeState = await detectFfprobe(config.ffprobePath);
  if (config.thumb.ffmpegPath !== previousFfmpeg) await thumbnailer.refresh({ force: true });
  return {
    config: publicConfig(config),
    ffprobe: ffprobeState,
    ffmpeg: thumbnailer.state,
    note: config.server.port !== next.server.port ? '端口修改需重启服务后生效' : null,
  };
});

route('POST', '/api/ffmpeg/detect', async () => thumbnailer.refresh({ force: true }));

route('POST', '/api/ffprobe/detect', async () => {
  ffprobeState = await detectFfprobe(config.ffprobePath);
  return ffprobeState;
});

// 根目录
route('GET', '/api/roots', async () => Promise.all(config.roots.map(async (root) => {
  const stat = await statSafe(root.path);
  return {
    ...root,
    exists: Boolean(stat?.isDirectory()),
    movies: library.list().filter((movie) => movie.rootId === root.id).length,
  };
})));

route('POST', '/api/roots/validate', async ({ body }) => {
  const target = path.resolve(String(body?.path ?? '').trim());
  if (!body?.path) throw new HttpError(400, '请填写目录路径');
  const stat = await statSafe(target);
  if (!stat?.isDirectory()) return { path: target, exists: false, isDirectory: false, videos: 0, subdirs: 0 };
  const extensions = new Set(config.scan.extensions);
  let videos = 0;
  let subdirs = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) subdirs += 1;
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) videos += 1;
  }
  return { path: target, exists: true, isDirectory: true, videos, subdirs };
});

route('POST', '/api/roots', async ({ body }) => {
  const rawPath = String(body?.path ?? '').trim();
  if (!rawPath) throw new HttpError(400, '请填写目录路径');
  const abs = path.resolve(rawPath.replace(/^"(.*)"$/, '$1'));
  const stat = await statSafe(abs);
  if (!stat?.isDirectory()) throw new HttpError(400, `目录不存在或不是文件夹：${abs}`);
  const next = sanitizeConfig({
    roots: [...config.roots, { path: abs, label: body?.label, depth: body?.depth }],
  }, config);
  if (next.roots.length === config.roots.length) throw new HttpError(409, '该目录已在库中');
  config = await saveConfig(DATA_DIR, next);
  return { config: publicConfig(config), roots: config.roots };
});

route('PATCH', '/api/roots/:id', async ({ params, body }) => {
  const roots = config.roots.map((root) => (root.id === params.id
    ? { ...root, ...(body?.label !== undefined ? { label: String(body.label) } : {}), ...(body?.depth !== undefined ? { depth: body.depth } : {}), ...(body?.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}) }
    : root));
  if (!roots.some((root) => root.id === params.id)) throw new HttpError(404, '根目录不存在');
  config = await saveConfig(DATA_DIR, { ...config, roots });
  return { config: publicConfig(config) };
});

/**
 * 根目录重定位：换盘符 / 移动硬盘挂载点变了的时候用。
 * 会把该根目录下所有记录的路径前缀一起改写，id 重算，标签/已看/备注全部保留。
 */
route('POST', '/api/roots/relocate', async ({ body }) => {
  const rootId = String(body?.rootId ?? '');
  const root = config.roots.find((item) => item.id === rootId);
  if (!root) throw new HttpError(404, '根目录不存在');

  const rawPath = String(body?.newPath ?? '').trim();
  if (!rawPath) throw new HttpError(400, '请填写新的目录路径');
  const newPath = path.resolve(rawPath.replace(/^"(.*)"$/, '$1'));
  const stat = await statSafe(newPath);
  if (!stat?.isDirectory()) throw new HttpError(400, `目录不存在或不是文件夹：${newPath}`);

  const oldPath = root.path;
  if (pathKey(oldPath) === pathKey(newPath)) {
    return { unchanged: true, root, changed: 0, skipped: [] };
  }

  const rebased = library.rebasePath(oldPath, newPath);
  config = await saveConfig(DATA_DIR, {
    ...config,
    roots: config.roots.map((item) => (item.id === rootId
      ? { ...item, path: newPath, label: item.label || path.basename(newPath) }
      : item)),
  });
  await library.flush();
  return {
    unchanged: false,
    root: config.roots.find((item) => item.id === rootId),
    changed: rebased.changed,
    skipped: rebased.skipped,
    note: `已把 ${rebased.changed} 条记录的路径从 ${oldPath} 改到 ${newPath}`,
  };
});

/** 根目录路径失效时，帮忙在其它盘符里找同名目录。 */
route('GET', '/api/roots/suggest', async () => {
  const suggestions = [];
  for (const root of config.roots) {
    const stat = await statSafe(root.path);
    if (stat?.isDirectory()) continue;
    // 去掉盘符，只保留「\\a\\b」这部分，再去各盘符下试
    const tail = root.path.replace(/^[A-Za-z]:/, '');
    const candidates = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (`${letter}:`.toLowerCase() === root.path.slice(0, 2).toLowerCase()) continue;
      const candidate = `${letter}:${tail}`;
      if ((await statSafe(candidate))?.isDirectory()) candidates.push(candidate);
    }
    suggestions.push({
      rootId: root.id,
      label: root.label,
      path: root.path,
      exists: false,
      candidates,
    });
  }
  return suggestions;
});

route('DELETE', '/api/roots/:id', async ({ params, query }) => {
  const removed = config.roots.find((root) => root.id === params.id);
  if (!removed) throw new HttpError(404, '根目录不存在');
  const roots = config.roots.filter((root) => root.id !== params.id);
  config = await saveConfig(DATA_DIR, { ...config, roots });
  const prune = String(query.prune ?? '') === '1';
  if (prune) {
    for (const movie of library.list()) {
      if (movie.rootId === removed.id) library.remove(movie.id);
    }
    await library.flush();
  }
  return { config: publicConfig(config), prunedRecords: prune };
});

// 扫描
route('POST', '/api/scan', async ({ body }) => {
  if (activeScanId) {
    const running = jobs.get(activeScanId);
    if (running?.status === 'running') return { id: activeScanId, reused: true };
  }
  const rootId = body?.rootId ? String(body.rootId) : null;
  const roots = rootId ? config.roots.filter((root) => root.id === rootId) : config.roots;
  if (!roots.length) throw new HttpError(400, '还没有配置电影目录，请先在设置里添加', 'NO_ROOTS');
  const { id } = jobs.start('扫描电影目录', async (ctx) => {
    activeScanId = id;
    try {
      return await runScan({
        library,
        config,
        roots,
        ffprobe: ffprobeState,
        progress: ctx.progress,
        signal: ctx.signal,
        applyMetadata: (movie) => scrapeRecord(movie).catch(() => null),
      });
    } finally {
      activeScanId = null;
    }
  });
  return { id, reused: false };
});

// 任务
route('GET', '/api/jobs', async () => jobs.list(20));
route('GET', '/api/jobs/:id', async ({ params }) => {
  const job = jobs.get(params.id);
  if (!job) throw new HttpError(404, '任务不存在');
  return job;
});
route('DELETE', '/api/jobs/:id', async ({ params }) => {
  const ok = jobs.cancel(params.id);
  return { cancelled: ok };
});

// 列表
route('GET', '/api/movies', async ({ query }) => {
  const limit = Math.min(Math.max(Number(query.limit) || 60, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const filtered = applyFilters(library.list(), query);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    offset,
    limit,
    items: await withPosterFlags(page.map(summarize)),
  };
});

route('GET', '/api/facets', async () => ({
  ...facetsOf(library.list()),
  stats: library.stats(),
}));

/**
 * 离线可用性报告：确认「断网后还能看到什么」不需要网络。
 * 同时列出还缺元数据 / 封面的片子，方便补齐。
 */
route('GET', '/api/offline/status', async () => {
  const summary = offlineSummary();
  const cache = await countCacheFiles();
  const movies = library.list().filter((movie) => !movie.missing);
  const pick = (movie) => ({
    id: movie.id,
    title: displayTitle(movie),
    year: displayYear(movie),
  });
  const missingMetadata = movies
    .filter((movie) => !movie.tmdb?.id)
    .map((movie) => ({ ...pick(movie), reason: movie.matchState === 'none' ? '未匹配' : '待刮削' }));
  const missingPoster = movies
    .filter((movie) => !(movie.customPoster?.file || movie.localArt?.poster || movie.tmdb?.posterPath))
    .map((movie) => ({ ...pick(movie), reason: '无封面' }));

  return {
    ...summary,
    cache,
    dataDir: DATA_DIR,
    missingMetadata: missingMetadata.slice(0, 50),
    missingPoster: missingPoster.slice(0, 50),
    // 断网后这些功能不可用（数据本身仍可浏览）
    needsNetwork: ['首次刮削/重新刮削元数据', '手动匹配搜索', 'TMDB 测试连接与网络诊断'],
    availableOffline: [
      '浏览、搜索、筛选、标签、合集、已看/未看标记',
      '详情页元数据（已刮削过的）与本地封面/截帧',
      'ffprobe 技术参数（音轨/字幕/时长）',
      '调用本地播放器、浏览器播放',
      '导出 JSON/CSV、备份、完整性校验、重复检测',
    ],
  };
});

route('GET', '/api/movies/:id', async ({ params }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  const detail = detailOf(movie);
  const localPoster = resolveLocalArt(movie, 'poster');
  const localBackdrop = resolveLocalArt(movie, 'backdrop');
  const custom = await customPosterPath(movie);
  detail.hasCustomPoster = Boolean(custom);
  detail.customPoster = movie.customPoster ?? null;
  detail.hasPoster = Boolean(custom)
    || Boolean(localPoster && (await statSafe(localPoster))?.isFile())
    || (movie.tmdb?.id ? await pathExists(tmdb.imageFile(movie.tmdb.id, 'poster')) : false);
  detail.hasBackdrop = Boolean(localBackdrop && (await statSafe(localBackdrop))?.isFile())
    || (movie.tmdb?.id ? await pathExists(tmdb.imageFile(movie.tmdb.id, 'backdrop')) : false);
  detail.localArt = movie.localArt ?? null;
  return detail;
});

/**
 * 截取/上传封面。
 *  body: { mode: 'auto'|'shell'|'ffmpeg', atSec?, percent?, dataUrl? }
 *  - dataUrl：浏览器 canvas 截帧，直接存
 *  - 其它：系统缩略图 → ffmpeg 截帧
 */
route('POST', '/api/movies/:id/poster/capture', async ({ params, body }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  await requireFile(movie);

  let result;
  try {
    if (body?.dataUrl) {
      result = await thumbnailer.saveDataUrl(movie.id, String(body.dataUrl));
    } else {
      result = await thumbnailer.capture(movie, {
        mode: body?.mode ?? 'auto',
        atSec: Number.isFinite(Number(body?.atSec)) ? Number(body.atSec) : null,
        percent: Number.isFinite(Number(body?.percent)) ? Number(body.percent) : null,
      });
    }
  } catch (err) {
    if (err.code === 'NO_FRAME_SOURCE' || err.code === 'FFMPEG_UNAVAILABLE') {
      throw new HttpError(409, err.message, err.code);
    }
    throw new HttpError(400, err.message, 'CAPTURE_FAILED');
  }

  const customPoster = {
    file: result.file,
    source: result.source,
    atSec: result.atSec ?? null,
    width: result.width ?? null,
    height: result.height ?? null,
    bytes: result.bytes ?? null,
    at: new Date().toISOString(),
  };
  const updated = library.patch(movie.id, { customPoster });
  const detail = detailOf(updated);
  detail.hasPoster = true;
  detail.hasCustomPoster = true;
  detail.posterSource = `custom:${customPoster.source}`;
  return { ok: true, customPoster, detail };
});

/** 取消自定义封面，回退到本地图 / TMDB。 */
route('DELETE', '/api/movies/:id/poster/capture', async ({ params }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  await thumbnailer.removeCustom(movie.id);
  const updated = library.patch(movie.id, { customPoster: null });
  return { ok: true, removed: true, detail: detailOf(updated) };
});

/** 为所有缺封面的影片批量截帧（系统缩略图优先，失败跳过）。 */
route('POST', '/api/posters/capture-missing', async () => {
  const targets = [];
  for (const movie of library.list()) {
    if (movie.missing) continue;
    if (movie.customPoster?.file) continue;
    if (resolveLocalArt(movie, 'poster')) continue;
    if (movie.tmdb?.id && await pathExists(tmdb.imageFile(movie.tmdb.id, 'poster'))) continue;
    targets.push(movie.id);
  }

  const { id } = jobs.start('截取封面', async (ctx) => {
    ctx.progress({ phase: '截取封面', total: targets.length, done: 0 });
    const succeeded = [];
    const failed = [];
    for (let index = 0; index < targets.length; index += 1) {
      if (ctx.signal.aborted) break;
      const movie = library.get(targets[index]);
      if (!movie) continue;
      try {
        const shot = await thumbnailer.capture(movie);
        library.patch(movie.id, {
          customPoster: {
            file: shot.file,
            source: shot.source,
            width: shot.width ?? null,
            height: shot.height ?? null,
            bytes: shot.bytes ?? null,
            at: new Date().toISOString(),
          },
        });
        succeeded.push(movie.id);
        ctx.progress({ done: index + 1, current: movie.fileName });
      } catch (err) {
        failed.push({ id: movie.id, title: movie.parsed?.title ?? movie.fileName, reason: err.message });
        ctx.progress({ done: index + 1, current: movie.fileName, warning: `${movie.fileName}: ${err.message}` });
      }
    }
    await library.flush();
    return { total: targets.length, succeeded: succeeded.length, failed };
  });
  return { id, total: targets.length };
});

route('PATCH', '/api/movies/:id', async ({ params, body }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  const changes = {};
  if (Array.isArray(body?.tags)) changes.tags = [...new Set(body.tags.map((tag) => String(tag).trim()).filter(Boolean))];
  if (Array.isArray(body?.collections)) changes.collections = [...new Set(body.collections.map((name) => String(name).trim()).filter(Boolean))];
  if (typeof body?.notes === 'string') changes.notes = body.notes.slice(0, 5000);
  if (body?.matchState && ['pending', 'auto', 'confirmed', 'none'].includes(body.matchState)) changes.matchState = body.matchState;
  if (Number.isFinite(Number(body?.resumeSec))) changes.resumeSec = Math.max(0, Math.floor(Number(body.resumeSec)));
  if (Number.isFinite(Number(body?.playCount))) changes.playCount = Math.max(0, Math.floor(Number(body.playCount)));
  // 已看 / 未看：以 watchedAt 为准；标记已看时记录时间，取消时清空
  if (body?.watched !== undefined) {
    const nextWatched = Boolean(body.watched);
    if (nextWatched) {
      changes.watchedAt = movie.watchedAt ?? new Date().toISOString();
    } else {
      changes.watchedAt = null;
    }
  }
  if (body?.tmdb === null) {
    changes.tmdb = null;
    changes.matchState = 'pending';
    changes.matchError = null;
  }
  const updated = library.patch(movie.id, changes);
  return detailOf(updated);
});

route('DELETE', '/api/movies/:id', async ({ params }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  library.remove(movie.id);
  await library.flush();
  return { removed: movie.id, note: '只从库中移除记录，磁盘文件未删除' };
});

route('POST', '/api/movies/bulk', async ({ body }) => {
  const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
  const action = String(body?.action ?? '');
  const value = body?.value !== undefined ? String(body.value).trim() : '';
  if (!ids.length) throw new HttpError(400, '请选择至少一部电影');
  const validActions = new Set(['addTag', 'removeTag', 'addCollection', 'confirm', 'pending', 'watched', 'unwatched', 'remove']);
  if (!validActions.has(action)) throw new HttpError(400, `未知批量操作：${action}`);
  if (['addTag', 'removeTag', 'addCollection'].includes(action) && !value) {
    throw new HttpError(400, '该操作需要一个值（标签名或合集名）');
  }
  let affected = 0;
  for (const id of ids) {
    const movie = library.get(id);
    if (!movie) continue;
    if (action === 'addTag') {
      library.patch(id, { tags: [...new Set([...(movie.tags ?? []), value])] });
    } else if (action === 'removeTag') {
      library.patch(id, { tags: (movie.tags ?? []).filter((tag) => tag !== value) });
    } else if (action === 'addCollection') {
      library.patch(id, { collections: [...new Set([...(movie.collections ?? []), value])] });
    } else if (action === 'confirm') {
      library.patch(id, { matchState: 'confirmed' });
    } else if (action === 'pending') {
      library.patch(id, { matchState: 'pending' });
    } else if (action === 'watched') {
      library.patch(id, { watchedAt: movie.watchedAt ?? new Date().toISOString() });
    } else if (action === 'unwatched') {
      library.patch(id, { watchedAt: null });
    } else if (action === 'remove') {
      library.remove(id);
    }
    affected += 1;
  }
  await library.flush();
  return { affected };
});

// 刮削 / 匹配 / 探测
route('POST', '/api/movies/:id/scrape', async ({ params, body }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  return scrapeRecord(movie, { force: Boolean(body?.force) });
});

route('POST', '/api/movies/:id/match', async ({ params, body }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  const tmdbId = Number(body?.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new HttpError(400, '缺少有效的 TMDB ID');
  const detail = await tmdb.detail(tmdbId, { force: Boolean(body?.force) });
  const posterPath = await tmdb.posterPathFor(detail, { force: Boolean(body?.force) });
  const matchData = {
    ...detail,
    posterPath,
    matchScore: 1,
    manual: true,
    posterLanguage: tmdb.posterLanguage,
  };
  const languageChanged = (movie.tmdb?.posterLanguage ?? 'follow') !== tmdb.posterLanguage;
  const posterChanged = languageChanged || (Boolean(movie.tmdb?.posterPath) && movie.tmdb.posterPath !== posterPath);
  const updated = library.patch(movie.id, {
    tmdb: matchData,
    matchState: 'confirmed',
    matchError: null,
    tmdbTriedAt: new Date().toISOString(),
  });
  const images = await tmdb.cacheImages(matchData, { force: Boolean(body?.force) || posterChanged });
  return { movie: detailOf(updated), images };
});

route('POST', '/api/movies/:id/probe', async ({ params }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  if (!ffprobeState.ok) throw new HttpError(400, 'ffprobe 不可用，请先在设置里配置', 'FFPROBE_UNAVAILABLE');
  await requireFile(movie);
  const probe = await probeFile(ffprobeState.path, movie.path);
  const updated = library.patch(movie.id, { probe, probeError: null });
  return detailOf(updated);
});

route('POST', '/api/movies/:id/open', async ({ params, body }) => {
  const movie = library.get(params.id);
  assertPlayable(movie);
  await requireFile(movie);
  const startSec = Number(body?.startSec) > 0 ? Number(body.startSec) : Number(movie.resumeSec) || 0;
  const result = await launchPlayer({
    preset: config.player.preset,
    command: config.player.command,
    file: movie.path,
    startSec,
  });
  if (result.ok) {
    library.patch(movie.id, {
      playCount: (movie.playCount ?? 0) + 1,
      lastPlayedAt: new Date().toISOString(),
    });
  }
  return result;
});

route('POST', '/api/movies/:id/reveal', async ({ params }) => {
  const movie = library.get(params.id);
  assertPlayable(movie);
  const file = movie.path;
  let bin = 'explorer';
  let args = [`/select,${file}`];
  if (process.platform === 'darwin') {
    bin = 'open';
    args = ['-R', file];
  } else if (process.platform !== 'win32') {
    bin = 'xdg-open';
    args = [path.dirname(file)];
  }
  const ok = await new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
  return { ok, dir: path.dirname(file) };
});

route('GET', '/api/movies/:id/stream', async ({ req, res, params }) => {
  const movie = library.get(params.id);
  assertPlayable(movie);
  await requireFile(movie);
  await serveFile(req, res, movie.path, {
    contentType: MIME[path.extname(movie.path).toLowerCase()] ?? 'application/octet-stream',
    cache: 'private, max-age=0, must-revalidate',
  });
  return undefined;
});

route('GET', '/api/movies/:id/poster', async ({ req, res, params, query }) => {
  const movie = library.get(params.id);
  if (!movie) throw new HttpError(404, '记录不存在');
  const kind = String(query.kind ?? 'poster') === 'backdrop' ? 'backdrop' : 'poster';

  // 1) 自定义封面（截帧/浏览器截取/系统缩略图）优先级最高
  if (kind === 'poster') {
    const custom = await customPosterPath(movie);
    if (custom) {
      await serveFile(req, res, custom, {
        contentType: MIME[path.extname(custom).toLowerCase()] ?? 'image/jpeg',
        cache: 'private, max-age=3600',
      });
      return undefined;
    }
  }

  // 2) 用户自己放在电影目录里的图（poster.jpg / folder.jpg / fanart.jpg …）
  const local = resolveLocalArt(movie, kind);
  if (local && (await statSafe(local))?.isFile()) {
    await serveFile(req, res, local, {
      contentType: MIME[path.extname(local).toLowerCase()] ?? 'image/jpeg',
      cache: 'private, max-age=3600',
    });
    return undefined;
  }

  // 3) 刮削时缓存到本地的 TMDB 图
  if (movie.tmdb?.id) {
    const file = tmdb.imageFile(movie.tmdb.id, kind);
    if (await pathExists(file)) {
      await serveFile(req, res, file, { contentType: 'image/jpeg', cache: 'private, max-age=86400' });
      return undefined;
    }
  }

  throw new HttpError(404, '没有可用的封面', 'NO_ART');
});

// 待确认队列
route('GET', '/api/queue', async ({ query }) => {
  const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 200);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const pending = library.list()
    .filter((movie) => movie.matchState === 'pending' && !movie.missing)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const page = pending.slice(offset, offset + limit);
  return {
    total: pending.length,
    offset,
    limit,
    items: await withPosterFlags(page.map((movie) => ({
      ...summarize(movie),
      matchError: movie.matchError ?? null,
      searchQuery: movie.parsed?.year ? `${movie.parsed.title} ${movie.parsed.year}` : movie.parsed?.title ?? '',
    }))),
  };
});

route('POST', '/api/queue/scrape', async ({ body }) => {
  if (!tmdb.enabled) throw new HttpError(400, '未配置 TMDB API Key', 'TMDB_NO_KEY');
  const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 2000);
  const ids = Array.isArray(body?.ids) && body.ids.length
    ? body.ids.map(String)
    : library.list()
      .filter((movie) => movie.matchState === 'pending' && !movie.missing)
      .map((movie) => movie.id);
  const targets = ids.slice(0, limit);
  const { id } = jobs.start('批量刮削', async (ctx) => {
    ctx.progress({ phase: '刮削元数据', total: targets.length, done: 0 });
    let matched = 0;
    let failed = 0;
    for (let index = 0; index < targets.length; index += 1) {
      if (ctx.signal.aborted) break;
      const movie = library.get(targets[index]);
      if (!movie) continue;
      try {
        const result = await scrapeRecord(movie, { force: Boolean(body?.force) });
        if (result.matched) matched += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        ctx.progress({ error: `${movie.fileName}: ${err.message}` });
      }
      ctx.progress({ done: index + 1, current: movie.fileName });
    }
    await library.flush();
    return { matched, failed, total: targets.length };
  });
  return { id, total: targets.length };
});

// 手动匹配候选
route('GET', '/api/tmdb/search', async ({ query }) => {
  if (!tmdb.enabled) throw new HttpError(400, '未配置 TMDB API Key', 'TMDB_NO_KEY');
  const rawText = String(query.q ?? '').trim();
  if (!rawText) return { results: [], best: null };
  // 用户习惯输入「教父 1972」，年份单独拆出来交给 TMDB，避免搜索文本带年份导致零结果
  const yearMatch = rawText.match(/\b(18|19|20)\d{2}\b/);
  const text = yearMatch ? rawText.replace(yearMatch[0], '').replace(/\s+/g, ' ').trim() : rawText;
  const year = Number(query.year) || (yearMatch ? Number(yearMatch[0]) : null);
  const { results, language, cached } = await tmdb.search(text || rawText, { year, force: String(query.force ?? '') === '1' });
  const parsed = { title: text || rawText, year };
  const scored = results.map((candidate) => ({ ...candidate, score: Math.round(scoreCandidate(candidate, parsed) * 1000) / 1000 }));
  const best = pickBest(results, parsed, 0.4);
  return {
    results: scored,
    best: best ? { id: best.candidate.id, score: best.score } : null,
    language,
    cached,
  };
});

/** 测试 TMDB 连通性与 Key 是否有效（不写入任何数据）。 */
route('POST', '/api/tmdb/test', async () => {
  if (!tmdb.enabled) {
    throw new HttpError(400, '还没有配置 TMDB API Key', 'TMDB_NO_KEY');
  }
  const startedAt = Date.now();
  const credentials = tmdb.credentials;
  try {
    const { results, language } = await tmdb.search('The Godfather', { year: 1972, force: true });
    return {
      ok: true,
      language,
      authMode: credentials.mode,
      authLabel: credentials.mode === 'bearer' ? 'v4 读访问令牌' : 'v3 API 密钥',
      source: credentials.source,
      resolvedVia: tmdb.lastVia ?? null,
      resolvedAddress: tmdb.lastAddress ?? null,
      elapsedMs: Date.now() - startedAt,
      sample: results[0]
        ? { id: results[0].id, title: results[0].title, year: results[0].year, hasPoster: Boolean(results[0].posterPath) }
        : null,
      message: results.length ? '连接正常，Key 有效' : '连接正常，但搜索没有返回结果（可能是网络代理返回了空数据）',
    };
  } catch (err) {
    throw new HttpError(400, err.message, 'TMDB_TEST_FAILED');
  }
});

route('GET', '/api/tmdb/image', async ({ req, res, query }) => {
  const remotePath = String(query.p ?? '');
  const image = await tmdb.proxyImage(remotePath, String(query.size ?? 'w92'));
  if (!image) throw new HttpError(404, '图片不可用');
  await serveFile(req, res, image.file, { contentType: image.contentType, cache: 'private, max-age=604800' });
  return undefined;
});

/**
 * 网络诊断：告诉用户到底卡在 DNS、TCP 还是认证上。
 * 部分网络会把 api.themoviedb.org 污染到 Facebook 的地址段，
 * 这里会显示「系统 DNS / 实际使用的地址 / 走的是哪条策略」。
 */
route('POST', '/api/network/diagnose', async () => {
  const hosts = await diagnoseHosts(['api.themoviedb.org', 'image.tmdb.org']);
  const api = hosts[0];
  // 只要系统 DNS 里有任何一个地址像被污染，就提示用户「解析被劫持」
  const poisoned = api.systemDns.some((item) => isSuspiciousAddress(item.address));

  let https = null;
  try {
    const response = await netRequestJson('https://api.themoviedb.org/3/configuration', { timeoutMs: 8000 });
    https = { ok: response.status === 200 || response.status === 401, status: response.status, via: response.via };
  } catch (err) {
    https = { ok: false, status: 0, error: err.message };
  }

  return {
    ok: Boolean(https?.ok),
    poisoned,
    hosts,
    https,
    summary: poisoned
      ? `api.themoviedb.org 的 DNS 被污染（解析到 ${api.systemDns.map((item) => item.address).join(', ')}），已自动改用 ${api.via} 的地址，HTTPS ${https?.ok ? '可用' : '仍不可用'}`
      : `DNS 解析正常（${api.systemDns.map((item) => item.address).join(', ') || '无记录'}），HTTPS ${https?.ok ? '可用' : '不可用'}`,
  };
});

// 重复文件
route('GET', '/api/dupes', async () => dupesCache ?? {
  scanned: 0, candidates: 0, hashed: 0, reused: 0, failed: 0, groups: [], nearGroups: [], wastedBytes: 0,
});

route('POST', '/api/dupes', async ({ body }) => {
  const { id } = jobs.start('重复文件检测', async (ctx) => {
    const result = await findDuplicates({
      library,
      signal: ctx.signal,
      progress: ctx.progress,
      onHash: (movieId, quickHash) => {
        const movie = library.get(movieId);
        if (movie) {
          library.patch(movieId, {
            hash: { quick: quickHash, algo: 'sha1-headtail-4m', size: movie.size, mtimeMs: movie.mtimeMs, at: new Date().toISOString() },
          });
        }
      },
    });
    dupesCache = result;
    await library.flush();
    return result;
  });
  return { id, deep: Boolean(body?.deep) };
});

// 导出
route('GET', '/api/export', async ({ req, res, query }) => {
  const format = String(query.format ?? 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
  const movies = library.list();
  const content = format === 'csv' ? moviesToCsv(movies) : moviesToJson(movies);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.writeHead(200, {
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="doomsday-library-${stamp}.${format}"`,
    'Cache-Control': 'no-store',
  });
  res.end(content);
  return undefined;
});

route('POST', '/api/export', async ({ body }) => {
  const format = String(body?.format ?? 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
  const movies = library.list();
  const content = format === 'csv' ? moviesToCsv(movies) : moviesToJson(movies);
  const result = await writeExport({ dataDir: DATA_DIR, format, content });
  return { ...result, count: movies.length, format };
});

// 备份 / 校验 / 导入
route('POST', '/api/backup', async ({ body }) => {
  // 默认连 cache/ 一起备份：换机器后断网也能看到封面和简介
  const result = await createBackup({
    dataDir: DATA_DIR,
    config,
    library,
    includeCache: body?.includeCache !== false,
  });
  return result;
});

route('GET', '/api/backups', async () => listBackups(DATA_DIR));

route('POST', '/api/verify', async ({ body }) => {
  const deep = Boolean(body?.deep);
  const { id } = jobs.start('完整性校验', async (ctx) => {
    const fileChecks = await verifyDataFiles(DATA_DIR);
    const result = await verifyLibrary({
      library,
      config,
      deep,
      signal: ctx.signal,
      progress: ctx.progress,
    });
    return { ...result, dataFiles: fileChecks };
  });
  return { id };
});

route('POST', '/api/library/import', async ({ body }) => {
  const incoming = Array.isArray(body?.movies) ? body.movies : null;
  if (!incoming) throw new HttpError(400, '缺少 movies 数组');
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of incoming) {
    if (!raw?.path) {
      skipped += 1;
      continue;
    }
    const id = typeof raw.id === 'string' && raw.id.startsWith('m_') ? raw.id : movieIdForFile(raw.path);
    const existing = library.get(id);
    const record = {
      ...(existing ?? {}),
      ...raw,
      id,
      tags: Array.isArray(raw.tags) ? raw.tags : existing?.tags ?? [],
      collections: Array.isArray(raw.collections) ? raw.collections : existing?.collections ?? [],
    };
    library.upsert(record);
    if (existing) updated += 1;
    else added += 1;
  }
  await library.flush();
  return { added, updated, skipped, total: library.size };
});

// 解析预览（调试文件名规则用）
route('GET', '/api/preview-parse', async ({ query }) => ({
  fileName: String(query.name ?? ''),
  folderName: query.folder ? String(query.folder) : null,
  parsed: previewParse({
    fileName: String(query.name ?? ''),
    folderName: query.folder ? String(query.folder) : null,
  }),
}));

// ── 请求分发 ────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const matched = matchRoute(req.method, url.pathname);
  if (!matched) throw new HttpError(404, `接口不存在：${req.method} ${url.pathname}`);
  const query = Object.fromEntries(url.searchParams.entries());
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
    ? await readBody(req, url.pathname === '/api/library/import' ? 64 * 1024 * 1024 : 4 * 1024 * 1024)
    : null;
  const result = await matched.handler({ req, res, params: matched.params, query, body });
  // 流式响应（视频/图片/导出）已自行写头，不能再包一层 JSON
  if (res.headersSent || res.writableEnded) return;
  sendJson(res, 200, result ?? { ok: true });
}

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '只支持 GET');
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.join(WEB_DIR, relative.replace(/^\/+/, ''));
  if (!isInside(WEB_DIR, target, { allowEqual: false })) throw new HttpError(403, '禁止访问');
  await serveFile(req, res, target, {
    cache: relative === '/index.html' ? 'no-cache' : 'no-cache',
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const isApi = url.pathname.startsWith('/api/');
  const runner = isApi ? handleApi(req, res, url) : handleStatic(req, res, url);
  runner.catch((err) => {
    if (res.writableEnded) return;
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(`[http] ${req.method} ${url.pathname}:`, err);
    sendJson(res, status, { error: { message: err.message ?? '服务器内部错误', code: err.code ?? null } });
  });
});

// ── 启动 ────────────────────────────────────────────────────────────────
/** 解析命令行参数：--port=8080 --host=127.0.0.1 --open --data=路径 */
function parseCliArgs(argv) {
  const args = { open: false };
  for (const token of argv) {
    if (token === '--open') args.open = true;
    else if (token.startsWith('--port=')) args.port = Number(token.slice(7));
    else if (token.startsWith('--host=')) args.host = token.slice(7);
  }
  return args;
}

/** 用系统默认浏览器打开地址（失败不影响服务）。 */
function openBrowser(target) {
  const command = process.platform === 'win32'
    ? { bin: 'cmd', args: ['/c', 'start', '', target] }
    : process.platform === 'darwin'
      ? { bin: 'open', args: [target] }
      : { bin: 'xdg-open', args: [target] };
  try {
    const child = spawn(command.bin, command.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 打不开浏览器就让用户手动点链接
  }
}

/** 端口被占用时，判断是不是「本程序已经在跑」。 */
async function probeRunningInstance(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.app?.name === APP_NAME ? data : null;
  } catch {
    return null;
  }
}

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  await ensureDir(DATA_DIR);
  await ensureDir(path.join(DATA_DIR, 'cache'));

  if (!(await pathExists(path.join(WEB_DIR, 'index.html')))) {
    console.error('');
    console.error(`[启动失败] 找不到前端文件：${path.join(WEB_DIR, 'index.html')}`);
    console.error('  请确认在项目根目录下运行（应能看到 server/、web/、package.json 三个同级的目录/文件）。');
    console.error(`  当前工作目录：${process.cwd()}`);
    process.exit(1);
  }

  try {
    config = await loadConfig(DATA_DIR);
  } catch (err) {
    console.error('');
    console.error(`[启动失败] 配置文件无法解析：${path.join(DATA_DIR, 'config.json')}`);
    console.error(`  ${err.message}`);
    console.error('  处理办法：把该文件重命名为 config.json.bak 后重启（会用默认配置），或从 data/backups 里恢复一份。');
    process.exit(1);
  }

  const loaded = await library.load();
  if (loaded.count) console.log(`[库] 已加载 ${loaded.count} 条记录`);
  ffprobeState = await detectFfprobe(config.ffprobePath);
  await thumbnailer.refresh({ force: true });

  const port = Number(process.env.PORT) || cli.port || config.server.port || 7788;
  const host = process.env.HOST || cli.host || config.server.host || '127.0.0.1';
  const url = `http://127.0.0.1:${port}`;

  try {
    await listen(port, host);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const running = await probeRunningInstance(port);
      if (running) {
        console.log('');
        console.log(`  ${APP_NAME} 已经在运行了。`);
        console.log(`  → ${url}`);
        console.log(`  数据目录: ${running.dataDir ?? DATA_DIR}（已加载 ${running.counts?.total ?? 0} 部影片）`);
        console.log('');
        console.log('  直接打开上面的地址即可；要重启请先关掉原来的窗口。');
        console.log('');
        if (cli.open) openBrowser(url);
        process.exit(0);
      }
      console.error('');
      console.error(`[启动失败] 端口 ${port} 被别的程序占用了。`);
      console.error(`  查看占用者：netstat -ano | findstr :${port}`);
      console.error(`  结束进程：taskkill /PID <上面查到的PID> /F`);
      console.error(`  或者换个端口：set PORT=7799 && npm start`);
      console.error('');
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error('');
      console.error(`[启动失败] 没有权限监听端口 ${port}（1024 以下的端口需要管理员权限）。`);
      console.error('  请在设置里换一个 1024 以上的端口，或用 PORT=7799 启动。');
      console.error('');
      process.exit(1);
    }
    throw err;
  }

  console.log('');
  console.log(`  ${APP_NAME} v${APP_VERSION}`);
  console.log(`  → ${url}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  监听地址: ${host}:${port}（注意：这会让局域网内其它设备也能访问）`);
  }
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  ffprobe : ${ffprobeState.ok ? ffprobeState.version : '未找到（仅影响技术参数展示）'}`);
  console.log(`  ffmpeg  : ${thumbnailer.state.ok ? thumbnailer.state.version : '未找到（截帧会用系统缩略图/浏览器兜底）'}`);
  console.log(`  TMDB    : ${tmdb.enabled ? `已配置（${config.tmdb.language}，海报 ${config.tmdb.posterLanguage}）` : '未配置 API Key（刮削不可用）'}`);
  console.log('');
  console.log('  按 Ctrl+C 停止服务。');
  console.log('');

  if (cli.open) openBrowser(url);

  const shutdown = async (signal) => {
    console.log(`\n[退出] 收到 ${signal}，正在保存…`);
    jobs.cancelAll();
    try {
      await library.flush();
      await new Promise((resolve) => server.close(resolve));
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[启动失败]', err);
  process.exit(1);
});
