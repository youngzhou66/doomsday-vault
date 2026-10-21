import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getFreePort, makeTempDir, waitFor, writeFakeVideo } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startServer(dataDir, port) {
  // 并行跑测试时端口可能被别的进程抢先占用，失败就换端口重试
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const usePort = attempt === 0 ? port : await getFreePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
      env: { ...process.env, MOVIE_DATA_DIR: dataDir, PORT: String(usePort) },
      stdio: 'ignore',
      windowsHide: true,
    });
    const base = `http://127.0.0.1:${usePort}`;
    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`${base}/api/health`);
          return response.ok;
        } catch {
          return false;
        }
      }, { timeout: 30000, interval: 200, label: '服务启动' });
      return { child, base };
    } catch (err) {
      child.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (attempt === 2) throw err;
    }
  }
  throw new Error('无法启动测试服务');
}

async function api(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, payload, headers: response.headers };
}

async function waitJob(base, id, timeout = 20000) {
  return waitFor(async () => {
    const { payload } = await api(base, 'GET', `/api/jobs/${id}`);
    if (payload.status === 'running') return null;
    return payload;
  }, { timeout, interval: 120, label: `任务 ${id}` });
}

test('HTTP 接口端到端', async (t) => {
  const { dir: dataDir, cleanup } = await makeTempDir('dmv-api-');
  const media = path.join(dataDir, 'media');
  await writeFakeVideo(path.join(media, 'The Godfather (1972)', 'The.Godfather.1972.1080p.BluRay.x264-SPARKS.mkv'), 8192, 51);
  await writeFakeVideo(path.join(media, 'The Godfather (1972) copy', 'The.Godfather.1972.1080p.BluRay.x264-SPARKS.mkv'), 8192, 51);
  await writeFakeVideo(path.join(media, '教父2 (1974)', 'movie.mkv'), 6144, 52);
  // 本地封面图：验证「不配 TMDB 也有封面」
  const localPoster = Buffer.alloc(256, 0x11);
  await fs.writeFile(path.join(media, 'The Godfather (1972)', 'poster.jpg'), localPoster);

  const port = await getFreePort();
  const { child, base } = await startServer(dataDir, port);
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cleanup();
  });

  // 静态页面
  const index = await api(base, 'GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.payload, /末日电影库/);

  // 健康检查
  const health = await api(base, 'GET', '/api/health');
  assert.equal(health.payload.ok, true);
  assert.equal(health.payload.counts.total, 0);
  assert.ok('ffprobe' in health.payload);
  assert.equal(health.payload.tmdb.configured, false);

  // 根目录
  const badRoot = await api(base, 'POST', '/api/roots', { path: path.join(media, '不存在') });
  assert.equal(badRoot.status, 400);
  assert.match(badRoot.payload.error.message, /目录不存在/);

  const validate = await api(base, 'POST', '/api/roots/validate', { path: media });
  assert.equal(validate.payload.isDirectory, true);
  assert.equal(validate.payload.videos, 0);
  assert.equal(validate.payload.subdirs, 3);

  const added = await api(base, 'POST', '/api/roots', { path: media, label: '主片库', depth: 1 });
  assert.equal(added.status, 200);
  assert.equal(added.payload.roots.length, 1);
  assert.equal(added.payload.roots[0].label, '主片库');
  assert.equal(added.payload.roots[0].depth, 1);
  const rootId = added.payload.roots[0].id;

  const duplicateRoot = await api(base, 'POST', '/api/roots', { path: media });
  assert.equal(duplicateRoot.status, 409);

  // 默认最小体积 2MB，这里调小以扫到测试用的小文件（顺带验证配置合并）
  const defaultConfig = await api(base, 'GET', '/api/config');
  assert.equal(defaultConfig.payload.config.scan.minSizeBytes, 2 * 1024 * 1024);
  const scanConfig = await api(base, 'PUT', '/api/config', { scan: { minSizeBytes: 1024 } });
  assert.equal(scanConfig.payload.config.scan.minSizeBytes, 1024);
  assert.equal(scanConfig.payload.config.scan.probe, true, '其它扫描配置应保留');

  // 扫描
  const scanStart = await api(base, 'POST', '/api/scan', {});
  assert.ok(scanStart.payload.id);
  const scanJob = await waitJob(base, scanStart.payload.id);
  assert.equal(scanJob.status, 'done');
  assert.equal(scanJob.result.added, 3);
  assert.equal(scanJob.result.discovered, 3);

  // 列表与筛选
  const list = await api(base, 'GET', '/api/movies?limit=10');
  assert.equal(list.payload.total, 3);
  assert.equal(list.payload.items.length, 3);
  const first = list.payload.items.find((movie) => movie.title === 'The Godfather' && movie.folderName === 'The Godfather (1972)');
  assert.ok(first.id && first.path && first.size > 0);
  assert.equal(first.hasPoster, true, '有本地 poster.jpg 就应该标记为有封面');
  assert.equal(first.posterSource, 'local');
  assert.equal(first.matchState, 'pending');

  // 本地封面可以直接取到字节
  const posterResponse = await fetch(`${base}/api/movies/${first.id}/poster`);
  assert.equal(posterResponse.status, 200);
  assert.match(posterResponse.headers.get('content-type'), /image\/jpeg/);
  assert.equal((await posterResponse.arrayBuffer()).byteLength, localPoster.length);

  // 没有封面也没有 TMDB 图时，接口明确返回 404 + NO_ART
  const noArt = list.payload.items.find((movie) => movie.title !== 'The Godfather');
  const noArtResponse = await api(base, 'GET', `/api/movies/${noArt.id}/poster`);
  assert.equal(noArtResponse.status, 404);
  assert.equal(noArtResponse.payload.error.code, 'NO_ART');

  // 自定义封面：浏览器截帧（dataURL）上传后立即可用
  const jpegDataUrl = `data:image/jpeg;base64,${Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(400, 0x20),
    Buffer.from([0xff, 0xd9]),
  ]).toString('base64')}`;
  const captured = await api(base, 'POST', `/api/movies/${noArt.id}/poster/capture`, { dataUrl: jpegDataUrl });
  assert.equal(captured.status, 200);
  assert.equal(captured.payload.customPoster.source, 'browser');
  const customResponse = await fetch(`${base}/api/movies/${noArt.id}/poster`);
  assert.equal(customResponse.status, 200);
  const afterCapture = await api(base, 'GET', '/api/movies?limit=10');
  assert.equal(
    afterCapture.payload.items.find((movie) => movie.id === noArt.id).posterSource,
    'custom:browser',
    '列表里应显示自定义封面来源',
  );

  const cleared = await api(base, 'DELETE', `/api/movies/${noArt.id}/poster/capture`);
  assert.equal(cleared.payload.removed, true);
  const afterClear = await api(base, 'GET', `/api/movies/${noArt.id}/poster`);
  assert.equal(afterClear.status, 404, '取消自定义封面后应回到 NO_ART');

  // 离线可用性报告：断网时能看什么、还缺什么
  const offline = await api(base, 'GET', '/api/offline/status');
  assert.equal(offline.status, 200);
  assert.equal(offline.payload.total, 3);
  assert.equal(offline.payload.withMetadata, 0, '测试库没有刮削过');
  assert.equal(offline.payload.withPoster, 1, '只有本地 poster.jpg 那一部');
  assert.equal(offline.payload.ready, false);
  assert.equal(offline.payload.missingPoster.length, 2);
  assert.ok(offline.payload.availableOffline.length >= 4);
  assert.ok(offline.payload.needsNetwork.some((item) => item.includes('刮削')));
  assert.equal(offline.payload.cache.tmdbJson.files, 0);
  assert.equal(typeof offline.payload.cache.images.bytes, 'number');
  assert.equal(offline.payload.externalAssets.length, 0, '前端不应依赖任何外部资源');

  // 服务端截帧：测试用假视频解不出画面，应给出 409 而不是 500
  const captureFail = await api(base, 'POST', `/api/movies/${first.id}/poster/capture`, {});
  assert.equal(captureFail.status, 409);
  assert.equal(captureFail.payload.error.code, 'NO_FRAME_SOURCE');

  const filtered = await api(base, 'GET', '/api/movies?q=godfather');
  assert.equal(filtered.payload.total, 2);
  const emptySearch = await api(base, 'GET', '/api/movies?q=不存在的片名');
  assert.equal(emptySearch.payload.total, 0);
  const byResolution = await api(base, 'GET', '/api/movies?resolution=1080p');
  assert.equal(byResolution.payload.total, 2);
  const sorted = await api(base, 'GET', '/api/movies?sort=year&dir=asc');
  assert.equal(sorted.payload.items[0].year, 1972);
  const sortedDesc = await api(base, 'GET', '/api/movies?sort=year&dir=desc');
  assert.equal(sortedDesc.payload.items[0].year, 1974);

  // 详情与编辑
  const detail = await api(base, 'GET', `/api/movies/${first.id}`);
  assert.equal(detail.payload.parsed.year, 1972);
  assert.equal(detail.payload.probe, null);
  assert.deepEqual(detail.payload.tags, []);

  const patched = await api(base, 'PATCH', `/api/movies/${first.id}`, {
    tags: ['收藏', '黑帮'],
    collections: ['教父三部曲'],
    notes: '4K 修复版',
    matchState: 'confirmed',
  });
  assert.deepEqual(patched.payload.tags, ['收藏', '黑帮']);
  assert.equal(patched.payload.matchState, 'confirmed');

  // 已看 / 未看标记
  assert.equal(patched.payload.watched, false);
  const marked = await api(base, 'PATCH', `/api/movies/${first.id}`, { watched: true });
  assert.equal(marked.payload.watched, true);
  assert.ok(marked.payload.watchedAt, '标记已看时应记录时间');

  const onlyUnwatched = await api(base, 'GET', '/api/movies?watched=no');
  assert.equal(onlyUnwatched.payload.total, 2, '3 部里有 1 部已看');
  const onlyWatched = await api(base, 'GET', '/api/movies?watched=yes');
  assert.equal(onlyWatched.payload.total, 1);
  assert.equal(onlyWatched.payload.items[0].id, first.id);

  const facetsAfterMark = await api(base, 'GET', '/api/facets');
  assert.equal(facetsAfterMark.payload.watched, 1);
  assert.equal(facetsAfterMark.payload.unwatched, 2);
  assert.equal(facetsAfterMark.payload.stats.watched, 1);

  // 再次标记已看不会刷新时间（幂等）
  const markedAgain = await api(base, 'PATCH', `/api/movies/${first.id}`, { watched: true });
  assert.equal(markedAgain.payload.watchedAt, marked.payload.watchedAt);

  // 批量标记 / 取消
  const bulkMarked = await api(base, 'POST', '/api/movies/bulk', { ids: [first.id], action: 'unwatched' });
  assert.equal(bulkMarked.payload.affected, 1);
  const afterBulk = await api(base, 'GET', `/api/movies/${first.id}`);
  assert.equal(afterBulk.payload.watched, false);
  assert.equal(afterBulk.payload.watchedAt, null, '取消标记应清空时间');

  // 按标记时间排序
  await api(base, 'PATCH', `/api/movies/${first.id}`, { watched: true });
  const sortedByWatched = await api(base, 'GET', '/api/movies?sort=watchedAt&dir=desc');
  assert.equal(sortedByWatched.payload.items[0].id, first.id);

  // 视频流（Range）
  const ranged = await fetch(`${base}/api/movies/${first.id}/stream`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.match(ranged.headers.get('content-range'), /^bytes 0-99\//);
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes');

  const full = await fetch(`${base}/api/movies/${first.id}/stream`);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, first.size);

  // 库外文件必须拒绝
  const imported = await api(base, 'POST', '/api/library/import', {
    movies: [{ path: 'C:\\Windows\\notepad.exe', fileName: 'notepad.exe', parsed: { title: 'evil' }, size: 1, mtimeMs: 1 }],
  });
  assert.equal(imported.payload.added, 1);
  const evil = (await api(base, 'GET', '/api/movies?q=evil')).payload.items[0];
  const evilStream = await api(base, 'GET', `/api/movies/${evil.id}/stream`);
  assert.equal(evilStream.status, 403);
  assert.equal(evilStream.payload.error.code, 'PATH_OUTSIDE_ROOTS');
  await api(base, 'DELETE', `/api/movies/${evil.id}`);

  // 重复检测
  const dupesStart = await api(base, 'POST', '/api/dupes', {});
  const dupesJob = await waitJob(base, dupesStart.payload.id);
  assert.equal(dupesJob.result.groups.length, 1);
  assert.equal(dupesJob.result.groups[0].count, 2);
  const cachedDupes = await api(base, 'GET', '/api/dupes');
  assert.equal(cachedDupes.payload.groups.length, 1);

  // 待确认队列
  const queue = await api(base, 'GET', '/api/queue');
  assert.equal(queue.payload.total, 2, '已确认 1 部，其余 2 部待确认');

  const scrapeWithoutKey = await api(base, 'POST', '/api/queue/scrape', {});
  assert.equal(scrapeWithoutKey.status, 400);
  assert.equal(scrapeWithoutKey.payload.error.code, 'TMDB_NO_KEY');

  const tmdbTestWithoutKey = await api(base, 'POST', '/api/tmdb/test', {});
  assert.equal(tmdbTestWithoutKey.status, 400);
  assert.equal(tmdbTestWithoutKey.payload.error.code, 'TMDB_NO_KEY');

  // 配置（Key 打码 + 局部合并）
  const savedConfig = await api(base, 'PUT', '/api/config', {
    tmdb: { apiKey: 'secret-key-1234', language: 'en-US', minScore: 0.6 },
  });
  assert.equal(savedConfig.payload.config.tmdb.language, 'en-US');
  assert.equal(savedConfig.payload.config.tmdb.apiKey, '');
  assert.equal(savedConfig.payload.config.tmdb.apiKeySet, true);
  assert.match(savedConfig.payload.config.tmdb.apiKeyMasked, /^secr…1234$/);

  const configOnDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(configOnDisk.tmdb.apiKey, 'secret-key-1234');
  assert.equal(configOnDisk.tmdb.minScore, 0.6);

  // 忽略后缀：接口层会去空白、大小写去重后落盘
  const suffixSaved = await api(base, 'PUT', '/api/config', {
    scan: { ignoreSuffixes: [' -trailer ', '-TRAILER', 'sample', ''] },
  });
  assert.deepEqual(suffixSaved.payload.config.scan.ignoreSuffixes, ['-trailer', 'sample']);
  const configAfterSuffix = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(configAfterSuffix.scan.ignoreSuffixes, ['-trailer', 'sample']);
  // 还原，避免影响后续扫描断言
  await api(base, 'PUT', '/api/config', { scan: { ignoreSuffixes: [] } });

  const keepKey = await api(base, 'PUT', '/api/config', { tmdb: { language: 'zh-CN' } });
  assert.equal(keepKey.payload.config.tmdb.apiKeySet, true, '未提交 apiKey 时应保留原 Key');

  const configView = await api(base, 'GET', '/api/config');
  assert.equal(configView.payload.config.tmdb.apiKey, '', '接口不回传明文 Key');
  assert.ok(configView.payload.presets.mpv);

  // 解析预览
  const preview = await api(base, 'GET', `/api/preview-parse?name=${encodeURIComponent('教父.The.Godfather.1972.EXTENDED.1080p.mkv')}&folder=${encodeURIComponent('教父 (1972)')}`);
  assert.equal(preview.payload.parsed.year, 1972);
  assert.equal(preview.payload.parsed.edition, 'Extended');

  // 导出（BOM 要看原始字节：fetch 的 text() 会吞掉 UTF-8 BOM）
  const csvResponse = await fetch(`${base}/api/export?format=csv`);
  assert.equal(csvResponse.status, 200);
  const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
  assert.equal(csvBytes.subarray(0, 3).toString('hex'), 'efbbbf', 'CSV 应带 UTF-8 BOM');
  assert.match(csvBytes.toString('utf8'), /教父三部曲/);
  assert.match(csvResponse.headers.get('content-disposition'), /attachment/);

  const written = await api(base, 'POST', '/api/export', { format: 'json' });
  assert.ok(written.payload.file.endsWith('.json'));
  assert.equal(written.payload.count, 3);

  // 备份与校验
  const backup = await api(base, 'POST', '/api/backup', {});
  assert.equal(backup.payload.files.length, 2);
  assert.equal(backup.payload.manifest.counts.movies, 3);
  const backups = await api(base, 'GET', '/api/backups');
  assert.equal(backups.payload.length, 1);

  const verifyStart = await api(base, 'POST', '/api/verify', { deep: false });
  const verifyJob = await waitJob(base, verifyStart.payload.id);
  assert.equal(verifyJob.result.checked, 3);
  assert.equal(verifyJob.result.missing, 0);
  assert.equal(verifyJob.result.issues.length, 0);

  // 盘符变化：重定位根目录前缀，记录路径与 id 一起改，用户数据保留
  const movedRoot = path.join(dataDir, 'media-moved');
  await fs.cp(media, movedRoot, { recursive: true });
  const beforeRelocate = await api(base, 'GET', '/api/movies?q=godfather');
  const targetBefore = beforeRelocate.payload.items.find((movie) => movie.folderName === 'The Godfather (1972)');
  const relocate = await api(base, 'POST', '/api/roots/relocate', { rootId, newPath: movedRoot });
  assert.equal(relocate.status, 200);
  assert.equal(relocate.payload.changed, 3, '三条记录都应改写前缀');
  assert.equal(relocate.payload.root.path, movedRoot);
  assert.match(relocate.payload.note, /已把 3 条记录/);

  const afterRelocate = await api(base, 'GET', '/api/movies?limit=10');
  assert.equal(afterRelocate.payload.total, 3, '重定位不该丢记录');
  assert.ok(afterRelocate.payload.items.every((movie) => movie.path.startsWith(movedRoot)));
  const targetAfter = afterRelocate.payload.items.find((movie) => movie.folderName === 'The Godfather (1972)');
  assert.notEqual(targetAfter.id, targetBefore.id, 'id 应按新路径重算');
  assert.deepEqual(targetAfter.tags, ['收藏', '黑帮'], '标签跟着记录走');
  assert.equal(targetAfter.watched, true, '已看标记跟着记录走');
  assert.equal((await api(base, 'GET', `/api/movies/${targetBefore.id}`)).status, 404, '旧 id 应失效');

  // 重定位后本地封面和播放都还能用
  const relocatedPoster = await fetch(`${base}/api/movies/${targetAfter.id}/poster`);
  assert.equal(relocatedPoster.status, 200);
  const relocatedStream = await fetch(`${base}/api/movies/${targetAfter.id}/stream`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(relocatedStream.status, 206);
  await relocatedStream.arrayBuffer();

  // 根目录删除（保留记录）
  const removed = await api(base, 'DELETE', `/api/roots/${rootId}`);
  assert.equal(removed.payload.config.roots.length, 0);
  const afterRemove = await api(base, 'GET', '/api/movies');
  assert.equal(afterRemove.payload.total, 3, '移除根目录不应删除库记录');

  // 错误路径
  const unknown = await api(base, 'GET', '/api/nope');
  assert.equal(unknown.status, 404);
  const traversal = await api(base, 'GET', '/../package.json');
  assert.ok([403, 404].includes(traversal.status), `目录穿越应被拒绝，实际 ${traversal.status}`);
});
