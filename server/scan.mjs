/**
 * 目录扫描。
 *
 * 默认「不递归」：只登记根目录本层的视频文件（depth=0）。
 * 需要时可为单个根目录设 depth=1/2 下钻，最大 99 层，避免误把整个磁盘拖进库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaId, pathKey, statSafe } from './fsx.mjs';
import { findLocalArt } from './art.mjs';
import { parseMovieName } from './parse.mjs';
import { probeFile } from './probe.mjs';

/** 由绝对路径推导稳定 id：文件不移动则 id 不变。 */
export function movieIdForFile(absPath) {
  return mediaId(absPath);
}

function compilePatterns(list) {
  const out = [];
  for (const raw of list ?? []) {
    try {
      out.push(new RegExp(raw, 'i'));
    } catch {
      // 非法正则忽略，不影响扫描
    }
  }
  return out;
}

/**
 * 文件名（去掉扩展名）是否命中「忽略后缀」。
 * 规则：大小写不敏感的后缀匹配；空白项会被忽略。
 * @param {string} baseName 不含扩展名的文件名
 * @param {string[]} suffixes
 * @returns {string|null} 命中的后缀，未命中返回 null
 */
export function matchesIgnoreSuffix(baseName, suffixes) {
  const name = String(baseName ?? '').trim().toLowerCase();
  if (!name) return null;
  for (const raw of suffixes ?? []) {
    const suffix = String(raw ?? '').trim().toLowerCase();
    if (!suffix) continue;
    if (name.endsWith(suffix)) return suffix;
  }
  return null;
}

/**
 * 遍历一个根目录，对每个视频文件回调 onFile。
 * @param {{path: string, depth?: number}} root
 * @param {object} config
 * @param {{signal?: AbortSignal, onFile: (entry: object) => Promise<void>|void, onIgnored?: (entry: {path: string, name: string, suffix: string}) => void, onWarning?: (msg: string) => void}} opts
 */
export async function walkRoot(root, config, { signal, onFile, onIgnored, onWarning }) {
  const extensions = new Set((config.scan.extensions ?? []).map((e) => e.toLowerCase()));
  const ignoreDirs = new Set((config.scan.ignoreDirs ?? []).map((s) => s.toLowerCase()));
  const patterns = compilePatterns(config.scan.ignorePatterns);
  const ignoreSuffixes = config.scan.ignoreSuffixes ?? [];
  const minSize = Number(config.scan.minSizeBytes) || 0;
  const maxDepth = Math.min(Math.max(Math.trunc(Number(root.depth) || 0), 0), 99);
  const queue = [{ dir: root.path, level: 0 }];

  while (queue.length) {
    if (signal?.aborted) return;
    const { dir, level } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      onWarning?.(`无法读取目录 ${dir}: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      if (signal?.aborted) return;
      const name = entry.name;
      const absPath = path.join(dir, name);

      if (entry.isDirectory()) {
        if (level >= maxDepth) continue;
        if (ignoreDirs.has(name.toLowerCase())) continue;
        if (name.startsWith('$') || name.startsWith('.')) continue;
        if (patterns.some((re) => re.test(absPath))) continue;
        queue.push({ dir: absPath, level: level + 1 });
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!extensions.has(ext)) continue;
      if (patterns.some((re) => re.test(absPath))) continue;

      // 名字（不含扩展名）命中忽略后缀：视频存在也不入库
      const ignoredSuffix = matchesIgnoreSuffix(path.basename(name, path.extname(name)), ignoreSuffixes);
      if (ignoredSuffix) {
        onIgnored?.({ path: absPath, name, suffix: ignoredSuffix });
        continue;
      }

      const stat = await statSafe(absPath);
      if (!stat?.isFile()) continue;
      if (stat.size < minSize) continue;

      await onFile({
        path: absPath,
        dir,
        name,
        folderName: level > 0 ? path.basename(dir) : null,
        folderPath: level > 0 ? dir : null,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        rootId: root.id,
        relPath: path.relative(root.path, absPath) || name,
      });
    }
  }
}

/**
 * 执行一次扫描任务（由 jobs 驱动）。
 * @param {{
 *   library: import('./store.mjs').Library,
 *   config: any,
 *   roots?: any[],
 *   ffprobe: {ok: boolean, path?: string, version?: string},
 *   progress: (patch: object) => void,
 *   signal: AbortSignal,
 *   applyMetadata?: (movie: any, signal: AbortSignal) => Promise<any>,
 * }} ctx
 */
export async function runScan(ctx) {
  const { library, config, ffprobe, progress, signal } = ctx;
  const startedAt = Date.now();
  const roots = (ctx.roots ?? config.roots).filter((r) => r.enabled !== false);
  const report = {
    roots: 0,
    discovered: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    skippedEpisodes: 0,
    skippedIgnored: 0,
    ignoredRemoved: 0,
    probed: 0,
    probeFailed: 0,
    artUpdated: 0,
    missing: 0,
    scraped: 0,
    warnings: [],
  };
  const warn = (msg) => {
    report.warnings.push(msg);
    if (report.warnings.length > 500) report.warnings.shift();
  };

  // ── 阶段 1：发现文件 ────────────────────────────────────────────────
  progress({ phase: '发现文件', total: 0, done: 0, current: '' });
  const discovered = [];
  const ignored = [];
  for (const root of roots) {
    if (signal.aborted) break;
    const stat = await statSafe(root.path);
    if (!stat?.isDirectory()) {
      warn(`根目录不可用：${root.path}`);
      continue;
    }
    report.roots += 1;
    await walkRoot(root, config, {
      signal,
      onWarning: warn,
      onIgnored: (entry) => {
        ignored.push({ ...entry, rootLabel: root.label });
        report.skippedIgnored += 1;
      },
      onFile: (entry) => {
        discovered.push({ ...entry, rootLabel: root.label });
        if (discovered.length % 25 === 0) progress({ total: discovered.length });
      },
    });
    progress({ total: discovered.length, current: root.label });
  }
  report.discovered = discovered.length;

  // 忽略规则生效后，之前误入库的记录也要清掉（只删记录，不碰文件）
  for (const item of ignored) {
    const existing = library.byAbsolutePath(item.path);
    if (!existing) continue;
    library.remove(existing.id);
    report.ignoredRemoved += 1;
  }
  if (ignored.length) {
    progress({ phase: '解析与探测', total: discovered.length, done: 0, current: `已忽略 ${ignored.length} 个文件` });
  } else {
    progress({ phase: '解析与探测', total: discovered.length, done: 0 });
  }

  // ── 阶段 2：解析 / 探测 / 入库 ──────────────────────────────────────
  const seenIds = new Set();
  let processed = 0;
  let cursor = 0;
  const now = () => new Date().toISOString();
  // ffprobe 不可用时不能要求「已有探测结果」，否则每次扫描都会把整库重写一遍
  const probeRequired = config.scan.probe && ffprobe.ok;
  // 同一目录的 readdir 结果缓存，避免为每个文件重复读目录
  const artCache = new Map();

  const processOne = async (entry) => {
    const id = movieIdForFile(entry.path);
    seenIds.add(id);
    const existing = library.get(id);
    const parsed = parseMovieName({ fileName: entry.name, folderName: entry.folderName });

    if (parsed.kind === 'episode' && !config.scan.includeEpisodes) {
      report.skippedEpisodes += 1;
      return;
    }

    const unchanged =
      existing &&
      existing.size === entry.size &&
      existing.mtimeMs === entry.mtimeMs &&
      (parsed.kind === 'episode' || existing.parsed?.title === parsed.title && existing.parsed?.year === parsed.year) &&
      (!probeRequired || existing.probe);

    // 本地封面图：放 poster.jpg / folder.jpg / fanart.jpg 到电影目录即可直接用
    let localArt = { poster: null, backdrop: null };
    try {
      localArt = await findLocalArt(entry.dir, path.basename(entry.name, path.extname(entry.name)), { cache: artCache });
    } catch {
      // 读不到就当没有
    }

    if (unchanged) {
      report.unchanged += 1;
      const artChanged = localArt.poster !== (existing.localArt?.poster ?? null)
        || localArt.backdrop !== (existing.localArt?.backdrop ?? null);
      if (artChanged) report.artUpdated += 1;
      library.patch(id, {
        lastSeenAt: now(),
        missing: false,
        rootId: entry.rootId,
        rootLabel: entry.rootLabel,
        relPath: entry.relPath,
        ...(artChanged ? { localArt } : {}),
      });
      return;
    }

    let probe = existing?.probe ?? null;
    let probeError = null;
    if (config.scan.probe && ffprobe.ok) {
      try {
        probe = await probeFile(ffprobe.path, entry.path);
        report.probed += 1;
      } catch (err) {
        probeError = err.message;
        report.probeFailed += 1;
        warn(`ffprobe 失败：${entry.name} -> ${err.message}`);
      }
    }

    const titleChanged =
      !existing || existing.parsed?.title !== parsed.title || existing.parsed?.year !== parsed.year;

    const record = {
      ...(existing ?? {}),
      id,
      kind: parsed.kind,
      path: entry.path,
      dir: entry.dir,
      folderName: entry.folderName ?? null,
      folderPath: entry.folderPath ?? null,
      relPath: entry.relPath,
      fileName: entry.name,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      rootId: entry.rootId,
      rootLabel: entry.rootLabel,
      parsed,
      probe,
      probeError,
      localArt,
      hash: existing?.hash ?? null,
      tags: existing?.tags ?? [],
      collections: existing?.collections ?? [],
      notes: existing?.notes ?? '',
      resumeSec: existing?.resumeSec ?? 0,
      playCount: existing?.playCount ?? 0,
      lastPlayedAt: existing?.lastPlayedAt ?? null,
      missing: false,
      lastSeenAt: now(),
      // 文件名变了或首次入库 -> 重新进入待确认；否则保留原来的匹配结果
      matchState: titleChanged ? 'pending' : existing?.matchState ?? 'pending',
      tmdb: titleChanged ? null : existing?.tmdb ?? null,
    };
    const saved = library.upsert(record);
    if (existing) report.updated += 1;
    else report.added += 1;

    if (ctx.applyMetadata && config.tmdb.autoScrape && !signal.aborted) {
      try {
        const applied = await ctx.applyMetadata(saved, signal);
        if (applied) report.scraped += 1;
      } catch (err) {
        warn(`自动刮削失败：${entry.name} -> ${err.message}`);
      }
    }
  };

  const concurrency = Math.max(1, Math.min(Number(config.scan.probeConcurrency) || 3, 12));
  const worker = async () => {
    for (;;) {
      if (signal.aborted) return;
      const index = cursor++;
      if (index >= discovered.length) return;
      const entry = discovered[index];
      try {
        await processOne(entry);
      } catch (err) {
        warn(`处理失败 ${entry.name}: ${err.message}`);
      }
      processed += 1;
      progress({ done: processed, current: entry.name, total: discovered.length });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // ── 阶段 3：标记失踪文件（只标记，不删除记录） ──────────────────────
  progress({ phase: '核对库存', current: '' });
  const scannedRootIds = new Set(roots.map((r) => r.id));
  for (const movie of library.list()) {
    if (!scannedRootIds.has(movie.rootId)) continue;
    if (seenIds.has(movie.id)) continue;
    if (movie.missing) continue;
    library.patch(movie.id, { missing: true });
    report.missing += 1;
  }

  if (signal.aborted) progress({ phase: '已取消' });
  await library.flush();
  return { ...report, elapsedMs: Date.now() - startedAt };
}

/** 解析但不落库，用于「先看解析效果」。 */
export function previewParse({ fileName, folderName = null }) {
  return parseMovieName({ fileName: String(fileName ?? ''), folderName });
}
