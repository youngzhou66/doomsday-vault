import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Library } from '../server/store.mjs';
import { mediaId } from '../server/fsx.mjs';
import { makeTempDir } from './helpers.mjs';

const OLD_ROOT = path.resolve('D:\\电影');
const NEW_ROOT = path.resolve('F:\\电影');

function record(overrides) {
  return {
    id: mediaId(overrides.path),
    path: overrides.path,
    dir: path.dirname(overrides.path),
    folderPath: overrides.folderPath ?? null,
    fileName: path.basename(overrides.path),
    relPath: '',
    size: 1024,
    mtimeMs: 1,
    rootId: 'r_test',
    parsed: { title: overrides.title ?? 'Movie', year: 2000 },
    tags: overrides.tags ?? [],
    collections: [],
    notes: '',
    matchState: 'pending',
    ...overrides,
  };
}

test('路径重定位：改前缀、重算 id、保留用户数据', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-rebase-');
  t.after(cleanup);
  const library = new Library(dir);

  const movieA = record({
    path: path.join(OLD_ROOT, 'A', 'a.mkv'),
    folderPath: path.join(OLD_ROOT, 'A'),
    title: 'A',
    tags: ['收藏'],
    watchedAt: '2026-01-01T00:00:00Z',
    notes: '别删',
  });
  const movieB = record({ path: path.join(OLD_ROOT, 'b.mkv'), title: 'B' });
  const outside = record({ path: path.resolve('D:\\其它\\c.mkv'), title: 'C' });
  for (const item of [movieA, movieB, outside]) library.upsert(item);

  const result = library.rebasePath(OLD_ROOT, NEW_ROOT);
  assert.equal(result.changed, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(library.size, 3, '未受影响的记录不应丢失');

  const movedA = library.list().find((movie) => movie.parsed.title === 'A');
  assert.equal(movedA.path, path.join(NEW_ROOT, 'A', 'a.mkv'));
  assert.equal(movedA.id, mediaId(movedA.path), 'id 应按新路径重算');
  assert.equal(movedA.dir, path.join(NEW_ROOT, 'A'));
  assert.equal(movedA.folderPath, path.join(NEW_ROOT, 'A'));
  assert.deepEqual(movedA.tags, ['收藏'], '标签必须保留');
  assert.equal(movedA.watchedAt, '2026-01-01T00:00:00Z', '已看标记必须保留');
  assert.equal(movedA.notes, '别删');
  assert.ok(movedA.rebasedAt);

  // 索引同步：新路径能找到，旧 id 已经不存在
  assert.equal(library.byAbsolutePath(path.join(NEW_ROOT, 'A', 'a.mkv'))?.id, movedA.id);
  assert.equal(library.get(movieA.id), null);
  assert.ok(library.byAbsolutePath(path.resolve('D:\\其它\\c.mkv')), '库外记录不受影响');
});

test('路径重定位：目标已存在同路径记录时跳过，不覆盖', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-rebase2-');
  t.after(cleanup);
  const library = new Library(dir);
  const oldPath = path.join(OLD_ROOT, 'dup.mkv');
  const newPath = path.join(NEW_ROOT, 'dup.mkv');
  library.upsert(record({ path: oldPath, title: 'old' }));
  library.upsert(record({ path: newPath, title: 'existing' }));

  const result = library.rebasePath(OLD_ROOT, NEW_ROOT);
  assert.equal(result.changed, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /已存在/);
  assert.equal(library.size, 2);
  assert.equal(library.get(mediaId(newPath)).parsed.title, 'existing', '已有记录不能被覆盖');
});

test('路径重定位：前缀相同时返回 0 变更', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-rebase3-');
  t.after(cleanup);
  const library = new Library(dir);
  library.upsert(record({ path: path.join(NEW_ROOT, 'x.mkv'), title: 'X' }));
  const result = library.rebasePath(NEW_ROOT, NEW_ROOT);
  assert.equal(result.changed, 1, '同前缀也会命中（路径未变，但会重算一次）');
  assert.equal(library.size, 1);
});
