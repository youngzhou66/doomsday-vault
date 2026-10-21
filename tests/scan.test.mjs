import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';

import { sanitizeConfig } from '../server/config.mjs';
import { Library } from '../server/store.mjs';
import { movieIdForFile, matchesIgnoreSuffix, runScan } from '../server/scan.mjs';
import { makeTempDir, NO_FFPROBE, writeFakeVideo } from './helpers.mjs';

/** 搭一套「一片一目录 + 根目录散片 + 剧集 + 过小文件 + 过深目录」的样本。 */
async function buildFixture(dir) {
  const root = path.join(dir, 'media');
  await writeFakeVideo(path.join(root, 'The Godfather (1972)', 'The.Godfather.1972.1080p.BluRay.x264.mkv'), 4096, 11);
  await writeFakeVideo(path.join(root, 'The Godfather Part III (1990)', 'movie.mkv'), 4096, 12);
  await writeFakeVideo(path.join(root, 'Inception.2010.1080p.BluRay.mkv'), 4096, 13);
  await writeFakeVideo(path.join(root, 'Some Show', 'Some.Show.S01E01.1080p.mkv'), 4096, 14);
  await writeFakeVideo(path.join(root, 'tiny.mkv'), 100, 15);
  await writeFakeVideo(path.join(root, 'Deeper', 'Nested', 'Too.Deep.2015.mkv'), 4096, 16);
  await writeFakeVideo(path.join(root, 'readme.txt'), 4096, 17);
  return root;
}

function makeConfig(root, overrides = {}) {
  return sanitizeConfig({
    roots: [{ path: root, depth: 1 }],
    scan: { minSizeBytes: 200, probe: false, includeEpisodes: false, ...(overrides.scan ?? {}) },
    tmdb: { ...(overrides.tmdb ?? {}) },
  });
}

async function scan(library, config, overrides = {}) {
  return runScan({
    library,
    config,
    ffprobe: NO_FFPROBE,
    progress: () => {},
    signal: new AbortController().signal,
    ...overrides,
  });
}

test('扫描：登记一片一目录、跳过剧集/过小/过深文件', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = makeConfig(root);

  const report = await scan(library, config);
  assert.equal(report.roots, 1);
  assert.equal(report.discovered, 4, '应只发现 4 个合格视频文件（不含过小、过深、非视频）');
  assert.equal(report.added, 3);
  assert.equal(report.skippedEpisodes, 1);
  assert.equal(report.probeFailed, 0);
  assert.equal(library.size, 3);

  const titles = library.list().map((movie) => movie.parsed.title).sort();
  assert.deepEqual(titles, ['Inception', 'The Godfather', 'The Godfather Part III']);

  const part3 = library.list().find((movie) => movie.fileName === 'movie.mkv');
  assert.equal(part3.parsed.title, 'The Godfather Part III', '内层垃圾文件名应回退到目录名');
  assert.equal(part3.parsed.year, 1990);
  assert.equal(part3.parsed.titleSource, 'folder');
  assert.equal(part3.folderName, 'The Godfather Part III (1990)');
  assert.equal(part3.matchState, 'pending');
  assert.equal(part3.kind, 'movie');
  assert.equal(part3.missing, false);
  assert.ok(part3.size > 0 && part3.mtimeMs > 0);
});

test('扫描：第二次执行不重复入库', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan2-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = makeConfig(root);

  await scan(library, config);
  const second = await scan(library, config);
  assert.equal(second.added, 0);
  assert.equal(second.unchanged, 3);
  assert.equal(library.size, 3);
});

test('扫描：文件变化时更新记录并保留用户标签', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan3-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = makeConfig(root);
  await scan(library, config);

  const inceptionPath = path.join(root, 'Inception.2010.1080p.BluRay.mkv');
  const id = movieIdForFile(inceptionPath);
  library.patch(id, { tags: ['诺兰'], collections: ['科幻'], notes: 'keep me' });

  await writeFakeVideo(inceptionPath, 8192, 13);
  const report = await scan(library, config);
  assert.equal(report.updated, 1);

  const record = library.get(id);
  assert.equal(record.size, 8192);
  assert.deepEqual(record.tags, ['诺兰']);
  assert.deepEqual(record.collections, ['科幻']);
  assert.equal(record.notes, 'keep me');
});

test('扫描：磁盘上消失的文件被标记 missing，记录不删除', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan4-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = makeConfig(root);
  await scan(library, config);
  assert.equal(library.size, 3);

  await (await import('node:fs/promises')).rm(path.join(root, 'Inception.2010.1080p.BluRay.mkv'));
  const report = await scan(library, config);
  assert.equal(report.missing, 1);
  assert.equal(library.size, 3, '缺失文件仍保留记录');
  const missing = library.list().filter((movie) => movie.missing);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].parsed.title, 'Inception');
});

test('扫描：开启 includeEpisodes 后剧集也入库', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan5-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = makeConfig(root, { scan: { includeEpisodes: true } });
  const report = await scan(library, config);
  assert.equal(report.skippedEpisodes, 0);
  assert.equal(library.size, 4);
  const episode = library.list().find((movie) => movie.kind === 'episode');
  assert.ok(episode);
  assert.equal(episode.parsed.season, 1);
});

test('扫描：根目录不存在时给出警告而不是抛错', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan6-');
  t.after(cleanup);
  const library = new Library(dir);
  const config = makeConfig(path.join(dir, 'not-exists'));
  const report = await scan(library, config);
  assert.equal(report.roots, 0);
  assert.equal(report.added, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /根目录不可用/);
});

test('扫描：停用的根目录被跳过', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan7-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = sanitizeConfig({
    roots: [{ path: root, depth: 1, enabled: false }],
    scan: { minSizeBytes: 200, probe: false },
  });
  const report = await scan(library, config);
  assert.equal(report.roots, 0);
  assert.equal(library.size, 0);
});

test('扫描：ffprobe 不可用时不会每次把整库重写一遍', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan8-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  // probe 打开，但环境里没有 ffprobe
  const config = makeConfig(root, { scan: { probe: true } });

  const first = await scan(library, config);
  assert.equal(first.added, 3);
  assert.equal(first.probed, 0);

  const second = await scan(library, config);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 3);
});

test('扫描：识别电影目录里的本地封面图', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan-art-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const folder = path.join(root, 'The Godfather (1972)');
  await fs.writeFile(path.join(folder, 'poster.jpg'), Buffer.alloc(128, 0xcd));
  await fs.writeFile(path.join(folder, 'fanart.jpg'), Buffer.alloc(256, 0xce));
  const library = new Library(dir);
  const config = makeConfig(root);

  await scan(library, config);
  const movie = library.list().find((item) => item.folderName === 'The Godfather (1972)');
  assert.equal(movie.localArt.poster, 'poster.jpg');
  assert.equal(movie.localArt.backdrop, 'fanart.jpg');
});

test('扫描：后加的封面图会被重新扫描拾取（文件本身没变）', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan-art2-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const library = new Library(dir);
  const config = makeConfig(root);
  await scan(library, config);

  const folder = path.join(root, 'The Godfather (1972)');
  const moviePath = path.join(folder, 'The.Godfather.1972.1080p.BluRay.x264.mkv');
  const id = movieIdForFile(moviePath);
  assert.equal(library.get(id).localArt?.poster ?? null, null);

  await fs.writeFile(path.join(folder, 'folder.jpg'), Buffer.alloc(64, 0xaa));
  const report = await scan(library, config);
  assert.equal(report.unchanged, 3, '视频文件本身没变，仍算未变');
  assert.equal(report.artUpdated, 1, '封面变化应单独计数');
  assert.equal(library.get(id).localArt.poster, 'folder.jpg');
});

test('扫描：删掉封面图后记录里的封面被清空', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan-art3-');
  t.after(cleanup);
  const root = await buildFixture(dir);
  const folder = path.join(root, 'The Godfather (1972)');
  await fs.writeFile(path.join(folder, 'poster.jpg'), Buffer.alloc(64, 0xbb));
  const library = new Library(dir);
  const config = makeConfig(root);
  await scan(library, config);
  const id = movieIdForFile(path.join(folder, 'The.Godfather.1972.1080p.BluRay.x264.mkv'));
  assert.equal(library.get(id).localArt.poster, 'poster.jpg');

  await fs.rm(path.join(folder, 'poster.jpg'));
  await scan(library, config);
  assert.equal(library.get(id).localArt.poster, null);
});

test('扫描：条目标记 id 与路径绑定且稳定', () => {
  const target = path.resolve('media', 'The Godfather (1972)', 'a.mkv');
  assert.equal(movieIdForFile(target), movieIdForFile(target));
  assert.match(movieIdForFile(target), /^m_[0-9a-f]{14}$/);
  assert.notEqual(movieIdForFile(target), movieIdForFile(`${target}.other.mkv`));
});

test('忽略后缀：匹配函数大小写不敏感、跳过空白项', () => {
  assert.equal(matchesIgnoreSuffix('Movie.2020-trailer', ['-trailer']), '-trailer');
  assert.equal(matchesIgnoreSuffix('Movie.2020-TRAILER', ['-trailer']), '-trailer');
  assert.equal(matchesIgnoreSuffix('电影预告', ['预告']), '预告');
  assert.equal(matchesIgnoreSuffix('Movie.2020', ['-trailer', '  ']), null);
  assert.equal(matchesIgnoreSuffix('', ['x']), null);
  assert.equal(matchesIgnoreSuffix('Movie-trailer', []), null);
});

test('忽略后缀：命中后不入库，且已入库的记录会被清理（不动文件）', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan-suffix-');
  t.after(cleanup);
  const root = path.join(dir, 'media');
  const mainFile = path.join(root, 'The.Godfather.1972.1080p.mkv');
  const trailerFile = path.join(root, 'The.Godfather.1972-trailer.mkv');
  await writeFakeVideo(mainFile, 4096, 21);
  await writeFakeVideo(trailerFile, 4096, 22);

  const library = new Library(dir);
  // 先不带忽略规则扫一次：两个都入库
  await scan(library, makeConfig(root));
  assert.equal(library.size, 2);
  const trailerId = movieIdForFile(trailerFile);
  library.patch(trailerId, { tags: ['预告片'], watchedAt: '2026-01-01T00:00:00Z' });

  // 加上忽略后缀再扫：预告片被跳过，旧记录被清掉
  const report = await scan(library, makeConfig(root, { scan: { ignoreSuffixes: ['-trailer'] } }));
  assert.equal(report.skippedIgnored, 1);
  assert.equal(report.ignoredRemoved, 1);
  assert.equal(library.size, 1, '只应剩正片');
  assert.equal(library.get(trailerId), null);
  assert.ok(library.byAbsolutePath(mainFile), '正片要留着');
  assert.equal(library.byAbsolutePath(trailerFile), null);

  // 文件本身必须还在磁盘上
  const stat = await fs.stat(trailerFile);
  assert.ok(stat.size > 0, '忽略规则只影响入库，不删除文件');

  // 去掉规则再扫，预告片重新入库
  await scan(library, makeConfig(root));
  assert.equal(library.size, 2);
});

test('忽略后缀：不会命中扩展名部分，也不会误伤普通片名', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-scan-suffix2-');
  t.after(cleanup);
  const root = path.join(dir, 'media');
  await writeFakeVideo(path.join(root, 'Movie.2020.mkv'), 4096, 31);
  await writeFakeVideo(path.join(root, 'Movie.2020.sample.mkv'), 4096, 32);
  await writeFakeVideo(path.join(root, 'Sample.2019.1080p.mkv'), 4096, 33);

  const library = new Library(dir);
  const report = await scan(library, makeConfig(root, { scan: { ignoreSuffixes: ['.sample'] } }));
  assert.equal(report.skippedIgnored, 1, '只有 Movie.2020.sample 命中');
  const titles = library.list().map((movie) => movie.parsed.title).sort();
  assert.deepEqual(titles, ['Movie', 'Sample']);

  // 扩展名不算文件名的一部分：'mkv' 不会命中
  const second = await scan(library, makeConfig(root, { scan: { ignoreSuffixes: ['mkv'] } }));
  assert.equal(second.skippedIgnored, 0, '不应因为扩展名是 mkv 就忽略');
});
