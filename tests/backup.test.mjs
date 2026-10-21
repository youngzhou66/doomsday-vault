import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';

import {
  CSV_COLUMNS, createBackup, listBackups, moviesToCsv, moviesToJson, verifyDataFiles, verifyLibrary,
} from '../server/backup.mjs';
import { Library } from '../server/store.mjs';
import { quickHash } from '../server/fsx.mjs';
import { makeTempDir, writeFakeVideo } from './helpers.mjs';

function sampleMovie(overrides = {}) {
  return {
    id: 'm_abc123',
    path: path.resolve('media', 'The Godfather (1972)', 'The.Godfather.1972.mkv'),
    fileName: 'The.Godfather.1972.mkv',
    folderName: 'The Godfather (1972)',
    kind: 'movie',
    size: 1234567,
    mtimeMs: Date.parse('2026-01-02T03:04:05Z'),
    parsed: { title: 'The Godfather', year: 1972, resolution: '1080p', videoCodec: 'H.264' },
    probe: {
      container: 'matroska',
      durationSec: 10500,
      video: { codec: 'H.264', width: 1920, height: 1080, fps: 23.976, hdr: null },
      audio: [{ codec: 'AC3', channels: 6 }],
      subtitles: [{ codec: 'SUBRIP', language: 'chi' }],
    },
    tmdb: { id: 238, imdbId: 'tt0068646', title: 'The Godfather', originalTitle: 'The Godfather', year: 1972, genres: ['剧情', '犯罪'], directors: ['Francis Ford Coppola'], voteAverage: 8.7 },
    matchState: 'confirmed',
    tags: ['收藏'],
    collections: ['教父三部曲'],
    notes: '经典',
    missing: false,
    addedAt: '2026-01-02T03:04:05Z',
    lastSeenAt: '2026-01-03T03:04:05Z',
    lastPlayedAt: null,
    playCount: 2,
    ...overrides,
  };
}

test('CSV 导出：表头、BOM、逗号/引号/换行转义', () => {
  const csv = moviesToCsv([
    sampleMovie({ notes: '含有,逗号 和 "引号"\n还有换行' }),
  ]);
  assert.ok(csv.startsWith('\ufeff'), '应带 UTF-8 BOM 以便 Excel 正确识别');
  const header = csv.split('\r\n')[0].replace('\ufeff', '');
  assert.equal(header, CSV_COLUMNS.join(','));
  assert.match(csv, /"含有,逗号 和 ""引号""\n还有换行"/, '特殊字符应按 RFC4180 转义');
  assert.match(csv, /The Godfather/);
  assert.match(csv, /教父三部曲/);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2);
});

test('CSV 导出：缺失字段用空字符串占位', () => {
  const csv = moviesToCsv([sampleMovie({ tmdb: null, probe: null, tags: [], collections: [] })]);
  const row = csv.split('\r\n')[1].split(',');
  assert.equal(row.length, CSV_COLUMNS.length);
});

test('JSON 导出：结构与数量正确', () => {
  const parsed = JSON.parse(moviesToJson([sampleMovie(), sampleMovie({ id: 'm_def' })]));
  assert.equal(parsed.count, 2);
  assert.equal(parsed.movies.length, 2);
  assert.equal(parsed.app, 'doomsday-movie-library');
  assert.ok(parsed.exportedAt);
});

test('备份：生成快照与校验清单，并按保留数清理旧备份', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-backup-');
  t.after(cleanup);
  const library = new Library(dir);
  library.upsert(sampleMovie());
  await library.flush();

  const config = { version: 1, roots: [], tmdb: { apiKey: 'secret-key' } };
  // 造一点离线资源：海报 + 刮削缓存 + 自定义封面
  await fs.mkdir(path.join(dir, 'cache', 'images'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cache', 'images', '238-poster.jpg'), Buffer.alloc(2048, 1));
  await fs.mkdir(path.join(dir, 'cache', 'tmdb'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cache', 'tmdb', 'movie-abc.json'), '{"cachedAt":"2026-01-01T00:00:00Z"}');
  await fs.mkdir(path.join(dir, 'cache', 'posters'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cache', 'posters', 'custom-m_abc.jpg'), Buffer.alloc(1024, 2));

  const first = await createBackup({ dataDir: dir, config, library, keep: 1 });
  assert.ok(first.dir.includes('backup-'));
  assert.equal(first.files.length, 2);
  assert.equal(first.files[0].sha256.length, 64);
  assert.equal(first.manifest.counts.movies, 1);
  assert.equal(first.manifest.cache.files, 3, '默认把 cache/ 一起备份');
  assert.ok(first.manifest.cache.bytes >= 2048);

  const snapshot = JSON.parse(await fs.readFile(path.join(first.dir, 'library.json'), 'utf8'));
  assert.equal(snapshot.movies.length, 1);
  const savedConfig = JSON.parse(await fs.readFile(path.join(first.dir, 'config.json'), 'utf8'));
  assert.equal(savedConfig.tmdb.apiKey, 'secret-key', '备份应包含完整配置以便恢复');
  // 离线资源应被真正拷进备份目录
  assert.ok(await fs.stat(path.join(first.dir, 'cache', 'images', '238-poster.jpg')));
  assert.ok(await fs.stat(path.join(first.dir, 'cache', 'posters', 'custom-m_abc.jpg')));

  // 不要缓存时可以只备份两个 JSON
  const lean = await createBackup({ dataDir: dir, config, library, keep: 5, includeCache: false });
  assert.equal(lean.manifest.cache.files, 0);
  assert.equal(await fs.access(path.join(lean.dir, 'cache')).then(() => true).catch(() => false), false);

  const second = await createBackup({ dataDir: dir, config, library, keep: 1 });
  assert.ok(second.pruned.length >= 1, 'keep=1 时应清掉更早的备份');
  const backups = await listBackups(dir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].movies, 1);
});

test('校验：缺失 / 体积变化 / 指纹不符都能报告', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-verify-');
  t.after(cleanup);
  const mediaDir = path.join(dir, 'media');
  const goodFile = path.join(mediaDir, 'good.mkv');
  const changedFile = path.join(mediaDir, 'changed.mkv');
  await writeFakeVideo(goodFile, 4096, 41);
  await writeFakeVideo(changedFile, 4096, 42);

  const goodStat = await fs.stat(goodFile);
  const library = new Library(dir);
  library.upsert({
    ...sampleMovie({ id: 'm_good', path: goodFile, size: goodStat.size, mtimeMs: Math.round(goodStat.mtimeMs) }),
    hash: { quick: await quickHash(goodFile, goodStat.size), size: goodStat.size, mtimeMs: Math.round(goodStat.mtimeMs) },
  });
  library.upsert(sampleMovie({ id: 'm_missing', path: path.join(mediaDir, 'gone.mkv'), size: 100 }));
  library.upsert(sampleMovie({ id: 'm_size', path: changedFile, size: 999999 }));
  library.upsert({
    ...sampleMovie({ id: 'm_hash', path: goodFile, size: goodStat.size }),
    hash: { quick: 'deadbeef', size: goodStat.size, mtimeMs: Math.round(goodStat.mtimeMs) },
  });

  const result = await verifyLibrary({ library, config: {}, deep: true });
  assert.equal(result.checked, 4);
  assert.equal(result.ok, 2, 'good 与 m_hash 体积一致即计为文件存在');
  assert.equal(result.missing, 1);
  assert.equal(result.sizeMismatch, 1);
  assert.equal(result.hashMismatch, 1);
  assert.equal(result.hashChecked, 2);
  const types = result.issues.map((issue) => issue.type).sort();
  assert.deepEqual(types, ['hash-mismatch', 'missing', 'size-mismatch']);
});

test('校验：data 目录 JSON 可解析性', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-verifyjson-');
  t.after(cleanup);
  await fs.writeFile(path.join(dir, 'config.json'), '{"version":1}');
  await fs.writeFile(path.join(dir, 'library.json'), '{ 坏掉的 JSON');
  const results = await verifyDataFiles(dir);
  const config = results.find((item) => item.name === 'config.json');
  const library = results.find((item) => item.name === 'library.json');
  assert.equal(config.ok, true);
  assert.equal(library.ok, false);
  assert.match(library.message, /JSON 损坏/);
});
