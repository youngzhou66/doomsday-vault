#!/usr/bin/env node
/**
 * 命令行入口：不启动网页也能扫描、导出、备份、校验。
 *
 *   node scripts/cli.mjs scan
 *   node scripts/cli.mjs scrape
 *   node scripts/cli.mjs export --format csv --out movies.csv
 *   node scripts/cli.mjs backup
 *   node scripts/cli.mjs verify --deep
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/config.mjs';
import { Library } from '../server/store.mjs';
import { detectFfprobe } from '../server/probe.mjs';
import { runScan } from '../server/scan.mjs';
import { TmdbClient } from '../server/tmdb.mjs';
import { createBackup, moviesToCsv, moviesToJson, verifyLibrary } from '../server/backup.mjs';
import { findDuplicates } from '../server/dupes.mjs';
import { ensureDir, formatBytes } from '../server/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.MOVIE_DATA_DIR || path.join(ROOT, 'data'));

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  await ensureDir(DATA_DIR);
  const config = await loadConfig(DATA_DIR);
  const library = new Library(DATA_DIR);
  await library.load();

  console.log(`末日电影库 CLI · 数据目录 ${DATA_DIR} · 已载入 ${library.size} 条记录`);

  if (command === 'scan') {
    const ffprobe = await detectFfprobe(config.ffprobePath);
    console.log(`ffprobe: ${ffprobe.ok ? ffprobe.version : '未找到（跳过技术参数）'}`);
    if (!config.roots.length) {
      console.error('还没有配置根目录，请先在网页端「设置 → 电影目录」添加，或手动编辑 data/config.json');
      process.exit(1);
    }
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    const report = await runScan({
      library,
      config,
      ffprobe,
      signal: controller.signal,
      progress: (patch) => {
        if (patch.phase) process.stdout.write(`\n[${patch.phase}] `);
        else if (patch.done && patch.done % 50 === 0) process.stdout.write('.');
      },
    });
    console.log('');
    console.log(`扫描完成：${report.roots} 个根目录，发现 ${report.discovered} 个文件`);
    console.log(`  新增 ${report.added} / 更新 ${report.updated} / 未变 ${report.unchanged} / 失踪 ${report.missing}`);
    if (report.skippedEpisodes) console.log(`  跳过剧集 ${report.skippedEpisodes}（可在设置里开启收录）`);
    if (report.probeFailed) console.log(`  探测失败 ${report.probeFailed}`);
    for (const warning of report.warnings.slice(0, 10)) console.log(`  ! ${warning}`);
    return;
  }

  if (command === 'scrape') {
    const tmdb = new TmdbClient({ dataDir: DATA_DIR, getConfig: () => config });
    if (!tmdb.enabled) {
      console.error('没有 TMDB API Key：请在网页端设置，或设置环境变量 TMDB_API_KEY');
      process.exit(1);
    }
    const pending = library.list().filter((movie) => movie.matchState === 'pending' && !movie.missing);
    console.log(`待刮削 ${pending.length} 部`);
    let matched = 0;
    for (const [index, movie] of pending.entries()) {
      try {
        const result = await tmdb.scrape(movie.parsed);
        if (result.match) {
          library.patch(movie.id, { tmdb: { ...result.match, matchScore: result.score }, matchState: 'auto', matchError: null });
          await tmdb.cacheImages(result.match);
          matched += 1;
        } else {
          library.patch(movie.id, { matchState: 'none', matchError: result.reason ?? '未找到匹配' });
        }
      } catch (err) {
        console.log(`  ! ${movie.fileName}: ${err.message}`);
      }
      if ((index + 1) % 10 === 0) console.log(`  进度 ${index + 1}/${pending.length}`);
    }
    await library.flush();
    console.log(`刮削完成：成功 ${matched} / ${pending.length}`);
    return;
  }

  if (command === 'export') {
    const format = String(args.format ?? 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
    const content = format === 'csv' ? moviesToCsv(library.list()) : moviesToJson(library.list());
    const out = args.out ? path.resolve(String(args.out)) : path.join(DATA_DIR, 'exports', `movies-${Date.now()}.${format}`);
    await ensureDir(path.dirname(out));
    await fs.writeFile(out, content);
    console.log(`已导出 ${library.size} 条记录 -> ${out}`);
    return;
  }

  if (command === 'backup') {
    const result = await createBackup({ dataDir: DATA_DIR, config, library });
    console.log(`备份完成 -> ${result.dir}`);
    for (const file of result.files) console.log(`  ${file.name}  ${formatBytes(file.bytes)}  sha256=${file.sha256.slice(0, 16)}…`);
    if (result.pruned.length) console.log(`清理旧备份 ${result.pruned.length} 份`);
    return;
  }

  if (command === 'verify') {
    const result = await verifyLibrary({ library, config, deep: Boolean(args.deep) });
    console.log(`校验 ${result.checked} 部：正常 ${result.ok} / 缺失 ${result.missing} / 体积变化 ${result.sizeMismatch}`);
    if (result.deep) console.log(`深度校验 ${result.hashChecked} 个指纹，不一致 ${result.hashMismatch}`);
    for (const issue of result.issues.slice(0, 20)) console.log(`  ! [${issue.type}] ${issue.path}\n    ${issue.message}`);
    process.exitCode = result.missing || result.sizeMismatch || result.hashMismatch ? 1 : 0;
    return;
  }

  if (command === 'dupes') {
    const result = await findDuplicates({
      library,
      onHash: (id, quick) => {
        const movie = library.get(id);
        library.patch(id, { hash: { quick, algo: 'sha1-headtail-4m', size: movie.size, mtimeMs: movie.mtimeMs } });
      },
    });
    await library.flush();
    console.log(`扫描 ${result.scanned} 部，重复组 ${result.groups.length} 组，可回收 ${formatBytes(result.wastedBytes)}`);
    for (const group of result.groups) {
      console.log(`  组 ${group.files.length} 个 / 每个 ${formatBytes(group.size)}`);
      for (const file of group.files) console.log(`    ${file.keep ? '*' : ' '} ${file.path}`);
    }
    return;
  }

  console.log(`用法：
  node scripts/cli.mjs scan                       扫描已配置的目录
  node scripts/cli.mjs scrape                     批量刮削待确认影片（需 TMDB Key）
  node scripts/cli.mjs export [--format csv|json] [--out 文件]
  node scripts/cli.mjs backup                     生成备份快照
  node scripts/cli.mjs verify [--deep]            校验文件完整性
  node scripts/cli.mjs dupes                      检测重复文件`);
}

main().catch((err) => {
  console.error('执行失败：', err.message);
  process.exit(1);
});
