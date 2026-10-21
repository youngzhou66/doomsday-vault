/**
 * 配置：默认值、加载、净化、保存。
 * 配置只保存在 data/config.json，随数据目录一起迁移。
 */
import path from 'node:path';
import { readJson, writeJsonAtomic, shortId, pathKey } from './fsx.mjs';
import { PLAYER_PRESETS } from './presets.mjs';

export { PLAYER_PRESETS };

/** 扫描时认可的容器后缀。 */
export const VIDEO_EXTENSIONS = [
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts',
  '.m2ts', '.mts', '.mpg', '.mpeg', '.rmvb', '.rm', '.vob', '.iso', '.divx',
  '.ogv', '.3gp', '.asf', '.f4v', '.mxf', '.dat',
];

/** 本地播放器预设见 presets.mjs（{file} / {time} 占位符）。 */

export const DEFAULT_CONFIG = {
  version: 1,
  language: 'zh-CN',
  roots: [],
  scan: {
    extensions: [...VIDEO_EXTENSIONS],
    ignoreDirs: [
      '@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information',
      '.git', 'node_modules', '.Trash', 'lost+found', '.thumbnails', '.DS_Store',
    ],
    ignorePatterns: [],
    // 文件名（去掉扩展名后）以这些后缀结尾就跳过，大小写不敏感
    ignoreSuffixes: [],
    minSizeBytes: 2 * 1024 * 1024,
    includeEpisodes: false,
    probe: true,
    probeConcurrency: 3,
    quickHashOnScan: false,
  },
  ffprobePath: 'ffprobe',
  thumb: {
    // 截帧用的 ffmpeg：命令名或绝对路径
    ffmpegPath: 'ffmpeg',
    // 默认截取视频 20% 处的那一帧（避开片头黑屏）
    offsetPercent: 20,
    // 封面宽度（像素）
    width: 500,
  },
  tmdb: {
    apiKey: '',
    language: 'zh-CN',
    fallbackLanguage: 'en-US',
    // follow | original | 具体语言（zh-CN / en-US / ja-JP…）
    posterLanguage: 'follow',
    cacheDays: 30,
    posterSize: 'w342',
    backdropSize: 'w780',
    autoScrape: false,
    minScore: 0.4,
  },
  player: { preset: 'auto', command: '' },
  server: { port: 7788, host: '127.0.0.1' },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深合并：对象递归合并，数组/标量整体替换。 */
export function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base?.[key])) {
      out[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function toPositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function normalizeExtensions(list) {
  const source = Array.isArray(list) && list.length ? list : VIDEO_EXTENSIONS;
  const out = new Set();
  for (const raw of source) {
    const ext = String(raw ?? '').trim().toLowerCase();
    if (!ext) continue;
    out.add(ext.startsWith('.') ? ext : `.${ext}`);
  }
  return [...out];
}

function makeRootId(p) {
  return `r_${shortId(pathKey(p), 10)}`;
}

/** 归一化根目录列表：绝对路径、去重、补齐 id/label。 */
export function normalizeRoots(roots) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(roots) ? roots : []) {
    const rawPath = String(raw?.path ?? '').trim();
    if (!rawPath) continue;
    const abs = path.resolve(rawPath);
    const key = pathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: /^r_[0-9a-f]{6,}$/.test(String(raw?.id ?? '')) ? raw.id : makeRootId(abs),
      path: abs,
      label: String(raw?.label ?? '').trim() || path.basename(abs) || abs,
      enabled: raw?.enabled !== false,
      // 默认 1：适配「一部电影一个目录」的布局（根目录 + 每片子目录内的文件）。
      // 0 = 只扫根目录本层（平铺布局）；2+ = 继续下钻
      depth: (() => {
        const rawDepth = raw?.depth;
        if (rawDepth === undefined || rawDepth === null || rawDepth === '') return 1;
        return Math.min(Math.max(Math.trunc(Number(rawDepth)) || 0, 0), 99);
      })(),
    });
  }
  return out;
}

/**
 * 用补丁覆盖默认配置并强制类型正确。返回可直接落盘的新配置。
 * @param {object} patch 用户提交的部分配置
 * @param {object} [base] 当前配置
 */
export function sanitizeConfig(patch, base = DEFAULT_CONFIG) {
  const merged = mergeDeep(structuredClone(DEFAULT_CONFIG), mergeDeep(base, patch ?? {}));
  const cfg = {
    version: 1,
    language: String(merged.language || 'zh-CN'),
    roots: normalizeRoots(merged.roots),
    scan: {
      extensions: normalizeExtensions(merged.scan?.extensions),
      ignoreDirs: (Array.isArray(merged.scan?.ignoreDirs) ? merged.scan.ignoreDirs : [])
        .map((s) => String(s ?? '').trim()).filter(Boolean),
      ignorePatterns: (Array.isArray(merged.scan?.ignorePatterns) ? merged.scan.ignorePatterns : [])
        .map((s) => String(s ?? '').trim()).filter(Boolean),
      // 忽略后缀：去空白、去重（大小写不敏感）、最多 50 条、每条最长 60 字符
      ignoreSuffixes: (() => {
        const seen = new Set();
        const out = [];
        for (const raw of Array.isArray(merged.scan?.ignoreSuffixes) ? merged.scan.ignoreSuffixes : []) {
          const suffix = String(raw ?? '').trim().slice(0, 60);
          if (!suffix) continue;
          const key = suffix.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(suffix);
          if (out.length >= 50) break;
        }
        return out;
      })(),
      minSizeBytes: toPositiveInt(merged.scan?.minSizeBytes, DEFAULT_CONFIG.scan.minSizeBytes, { min: 0 }),
      includeEpisodes: merged.scan?.includeEpisodes === true,
      probe: merged.scan?.probe !== false,
      probeConcurrency: toPositiveInt(merged.scan?.probeConcurrency, 3, { min: 1, max: 12 }),
      quickHashOnScan: merged.scan?.quickHashOnScan === true,
    },
    ffprobePath: String(merged.ffprobePath ?? 'ffprobe').trim() || 'ffprobe',
    thumb: {
      ffmpegPath: String(merged.thumb?.ffmpegPath ?? 'ffmpeg').trim() || 'ffmpeg',
      offsetPercent: (() => {
        const value = Number(merged.thumb?.offsetPercent);
        return Number.isFinite(value) ? Math.min(Math.max(value, 0), 95) : 20;
      })(),
      width: (() => {
        const value = Number(merged.thumb?.width);
        return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 120), 2000) : 500;
      })(),
    },
    tmdb: {
      apiKey: String(merged.tmdb?.apiKey ?? '').trim(),
      language: String(merged.tmdb?.language || 'zh-CN'),
      fallbackLanguage: String(merged.tmdb?.fallbackLanguage || 'en-US'),
      // 海报语言：follow=跟随元数据语言；original=原语言版本；也可指定 zh-CN / en-US / ja-JP…
      posterLanguage: (() => {
        const raw = String(merged.tmdb?.posterLanguage ?? 'follow').trim();
        if (raw === 'follow' || raw === 'original') return raw;
        return /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(raw) ? raw : 'follow';
      })(),
      cacheDays: toPositiveInt(merged.tmdb?.cacheDays, 30, { min: 0, max: 3650 }),
      posterSize: String(merged.tmdb?.posterSize || 'w342'),
      backdropSize: String(merged.tmdb?.backdropSize || 'w780'),
      autoScrape: merged.tmdb?.autoScrape === true,
      minScore: Math.min(Math.max(Number(merged.tmdb?.minScore) || 0.4, 0), 1),
    },
    player: {
      preset: Object.hasOwn(PLAYER_PRESETS, merged.player?.preset) ? merged.player.preset : 'auto',
      command: String(merged.player?.command ?? '').trim(),
    },
    server: {
      port: toPositiveInt(merged.server?.port, 7788, { min: 1, max: 65535 }),
      host: String(merged.server?.host || '127.0.0.1'),
    },
  };
  return cfg;
}

/** data/config.json 读入（不存在则用默认值）。 */
export async function loadConfig(dataDir) {
  const raw = await readJson(path.join(dataDir, 'config.json'), null);
  return sanitizeConfig(raw ?? {}, DEFAULT_CONFIG);
}

/** 原子写回 data/config.json。 */
export async function saveConfig(dataDir, cfg) {
  const clean = sanitizeConfig(cfg, cfg);
  await writeJsonAtomic(path.join(dataDir, 'config.json'), clean);
  return clean;
}

/** 对外展示的配置：把 TMDB Key 打码，避免前端/devtools 里裸奔。 */
export function publicConfig(cfg, { revealKey = false } = {}) {
  const copy = structuredClone(cfg);
  const key = copy.tmdb?.apiKey ?? '';
  copy.tmdb.apiKeySet = Boolean(key);
  copy.tmdb.apiKeyMasked = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '';
  if (!revealKey) copy.tmdb.apiKey = '';
  return copy;
}
