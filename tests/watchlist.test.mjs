import assert from 'node:assert/strict';
import test from 'node:test';

import { Watchlist, pickMetadata } from '../server/watchlist.mjs';
import { makeTempDir } from './helpers.mjs';

test('想看清单：添加、去重、改状态、删除、落盘重载', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-wish-');
  t.after(cleanup);

  const list = new Watchlist(dir);
  await list.load();
  assert.equal(list.list().length, 0);

  const first = list.add({ tmdbId: 603, title: '黑客帝国', year: 1999, voteAverage: 8.2, genres: ['动作'] });
  assert.equal(first.existed, false);
  assert.equal(first.item.id, 'w_603');
  assert.equal(first.item.status, 'wish');

  // 同一个 tmdbId 再加一次：幂等
  const again = list.add({ tmdbId: 603, title: '黑客帝国' });
  assert.equal(again.existed, true);
  assert.equal(list.list().length, 1);

  // 手动添加（没有 TMDB）
  const manual = list.add({ title: '还没找到的片子', year: 2025 });
  assert.match(manual.item.id, /^w_local_[0-9a-f]{12}$/);
  assert.equal(manual.item.tmdbId, null);
  assert.equal(manual.item.status, 'wish');

  // 改状态 / 备注
  const patched = list.patch(first.item.id, { status: 'watched', note: '周末看' });
  assert.equal(patched.status, 'watched');
  assert.equal(patched.note, '周末看');
  assert.equal(list.patch('w_nope', { status: 'wish' }), null);

  // 非法状态回落到 wish
  assert.equal(list.patch(manual.item.id, { status: 'bogus' }).status, 'wish');

  await list.flush();
  const reloaded = new Watchlist(dir);
  const loaded = await reloaded.load();
  assert.equal(loaded.count, 2);
  assert.equal(reloaded.get('w_603').status, 'watched');
  assert.equal(reloaded.get('w_603').note, '周末看');

  assert.equal(reloaded.remove('w_603'), true);
  assert.equal(reloaded.remove('w_603'), false);
  await reloaded.flush();
  const third = new Watchlist(dir);
  await third.load();
  assert.equal(third.list().length, 1);
});

test('想看清单：TMDB 元数据只挑需要的字段', () => {
  const meta = pickMetadata({
    id: 155,
    title: '黑暗骑士',
    originalTitle: 'The Dark Knight',
    year: 2008,
    voteAverage: 8.5,
    voteCount: 30000,
    genres: ['动作', '犯罪'],
    overview: '简介',
    runtimeMin: 152,
    posterPath: '/p.jpg',
    backdropPath: '/b.jpg',
    imdbId: 'tt0468569',
    directors: ['Christopher Nolan'],
    cast: [{ name: 'Christian Bale' }],
    fetchedAt: '2000-01-01T00:00:00.000Z',
  });
  assert.equal(meta.tmdbId, 155);
  assert.equal(meta.title, '黑暗骑士');
  assert.equal(meta.year, 2008);
  assert.deepEqual(meta.genres, ['动作', '犯罪']);
  assert.deepEqual(meta.directors, ['Christopher Nolan']);
  assert.equal(meta.posterPath, '/p.jpg');
  assert.equal('cast' in meta, false, '演员不存清单，避免清单文件膨胀');
  assert.ok(meta.fetchedAt !== '2000-01-01T00:00:00.000Z', 'fetchedAt 用当前时间');
});

test('想看清单：刷新元数据时整体覆盖并改成 TMDB id', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-wish2-');
  t.after(cleanup);
  const list = new Watchlist(dir);
  await list.load();
  const { item } = list.add({ title: 'The Matrix', year: 1999 });
  assert.match(item.id, /^w_local_/);

  const updated = list.patch(item.id, {
    metadata: pickMetadata({ id: 603, title: '黑客帝国', year: 1999, genres: ['动作'], posterPath: '/m.jpg' }),
  });
  assert.equal(updated.id, 'w_603');
  assert.equal(updated.title, '黑客帝国');
  assert.equal(updated.tmdbId, 603);
  assert.equal(updated.posterPath, '/m.jpg');
  assert.equal(list.list().length, 1);
});
