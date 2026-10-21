import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { sanitizeConfig } from '../server/config.mjs';
import { findDuplicates } from '../server/dupes.mjs';
import { Library } from '../server/store.mjs';
import { movieIdForFile, runScan } from '../server/scan.mjs';
import { makeTempDir, NO_FFPROBE, writeFakeVideo } from './helpers.mjs';

async function libraryWithFiles(dir) {
  const root = path.join(dir, 'media');
  await writeFakeVideo(path.join(root, 'A', 'Movie.2020.1080p.mkv'), 8192, 21);
  await writeFakeVideo(path.join(root, 'A copy', 'Movie.2020.1080p.mkv'), 8192, 21);
  await writeFakeVideo(path.join(root, 'B', 'Other.2021.1080p.mkv'), 8192, 22);
  const library = new Library(dir);
  const config = sanitizeConfig({
    roots: [{ path: root, depth: 1 }],
    scan: { minSizeBytes: 1, probe: false },
  });
  await runScan({ library, config, ffprobe: NO_FFPROBE, progress: () => {}, signal: new AbortController().signal });
  return { root, library, config };
}

test('重复检测：同体积同内容归为一组', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-dupes-');
  t.after(cleanup);
  const { library } = await libraryWithFiles(dir);

  const stored = new Map();
  const result = await findDuplicates({
    library,
    onHash: (id, hash) => stored.set(id, hash),
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.candidates, 3, '三个文件体积相同，都应参与比对');
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].count, 2);
  assert.equal(result.groups[0].wastedBytes, 8192);
  assert.equal(result.groups[0].files.filter((file) => file.keep).length, 1, '每组默认建议保留一份');
  assert.equal(result.failed, 0);
  assert.equal(stored.size, 3);
});

test('重复检测：不同内容但同体积不算重复', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-dupes2-');
  t.after(cleanup);
  const { library } = await libraryWithFiles(dir);
  const result = await findDuplicates({ library });
  const paths = result.groups[0].files.map((file) => file.path);
  assert.ok(paths.some((item) => item.includes('A copy')), '副本应在重复组里');
  assert.ok(!paths.some((item) => item.includes(`${path.sep}B${path.sep}`) || item.includes('Other')), '不同内容不应入组');
});

test('重复检测：指纹写回库后复用缓存', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-dupes3-');
  t.after(cleanup);
  const { library } = await libraryWithFiles(dir);

  const first = await findDuplicates({
    library,
    onHash: (id, quick) => {
      const movie = library.get(id);
      library.patch(id, {
        hash: { quick, algo: 'sha1-headtail-4m', size: movie.size, mtimeMs: movie.mtimeMs },
      });
    },
  });
  assert.equal(first.hashed, 3);

  const second = await findDuplicates({ library });
  assert.equal(second.reused, 3);
  assert.equal(second.hashed, 0);
  assert.equal(second.groups.length, 1);
});

test('重复检测：同片名不同体积提示为疑似同片', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-dupes4-');
  t.after(cleanup);
  const root = path.join(dir, 'media');
  await writeFakeVideo(path.join(root, 'X', 'Movie.2020.1080p.mkv'), 4096, 31);
  await writeFakeVideo(path.join(root, 'Y', 'Movie.2020.2160p.mkv'), 8192, 32);
  const library = new Library(dir);
  const config = sanitizeConfig({ roots: [{ path: root, depth: 1 }], scan: { minSizeBytes: 1, probe: false } });
  await runScan({ library, config, ffprobe: NO_FFPROBE, progress: () => {}, signal: new AbortController().signal });

  const result = await findDuplicates({ library });
  assert.equal(result.groups.length, 0);
  assert.equal(result.nearGroups.length, 1);
  assert.equal(result.nearGroups[0].files.length, 2);
});

test('重复检测：忽略缺失文件', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-dupes5-');
  t.after(cleanup);
  const { library } = await libraryWithFiles(dir);
  for (const movie of library.list()) library.patch(movie.id, { missing: true });
  const result = await findDuplicates({ library });
  assert.equal(result.scanned, 0);
  assert.equal(result.groups.length, 0);
});
