import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';

import { findLocalArt, resolveLocalArt } from '../server/art.mjs';
import { makeTempDir, writeFakeVideo } from './helpers.mjs';

const writeImage = async (file, bytes = 64) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 0xab));
};

test('本地封面：识别 poster.jpg / folder.png / cover.webp', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art-');
  t.after(cleanup);
  for (const [name, expected] of [['poster.jpg', 'poster.jpg'], ['folder.png', 'folder.png'], ['cover.webp', 'cover.webp']]) {
    const target = path.join(dir, name);
    await writeImage(target);
    const art = await findLocalArt(dir);
    assert.equal(art.poster, expected);
    await fs.rm(target);
  }
});

test('本地封面：背景图优先 fanart/backdrop', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art2-');
  t.after(cleanup);
  await writeImage(path.join(dir, 'poster.jpg'));
  await writeImage(path.join(dir, 'backdrop.jpg'));
  await writeImage(path.join(dir, 'fanart.jpg'));
  const art = await findLocalArt(dir);
  assert.equal(art.poster, 'poster.jpg');
  assert.equal(art.backdrop, 'fanart.jpg', 'fanart 优先级高于 backdrop');
});

test('本地封面：片名专属图优先于通用图', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art3-');
  t.after(cleanup);
  await writeImage(path.join(dir, 'poster.jpg'));
  await writeImage(path.join(dir, 'The.Godfather.1972-poster.jpg'));
  const art = await findLocalArt(dir, 'The.Godfather.1972');
  assert.equal(art.poster, 'The.Godfather.1972-poster.jpg');
});

test('本地封面：同名图片（movie.jpg）也算封面', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art4-');
  t.after(cleanup);
  await writeVideo(dir, 'movie.mkv');
  await writeImage(path.join(dir, 'movie.jpg'));
  const art = await findLocalArt(dir, 'movie');
  assert.equal(art.poster, 'movie.jpg');
});

test('本地封面：没有图片时返回 null', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art5-');
  t.after(cleanup);
  await writeVideo(dir, 'movie.mkv');
  await fs.writeFile(path.join(dir, 'readme.txt'), 'no art');
  const art = await findLocalArt(dir, 'movie');
  assert.deepEqual(art, { poster: null, backdrop: null });
});

test('本地封面：目录不存在不抛错', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art6-');
  t.after(cleanup);
  const art = await findLocalArt(path.join(dir, 'nope'));
  assert.deepEqual(art, { poster: null, backdrop: null });
});

test('本地封面：目录缓存避免重复 readdir', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-art7-');
  t.after(cleanup);
  await writeImage(path.join(dir, 'poster.jpg'));
  const cache = new Map();
  await findLocalArt(dir, 'a', { cache });
  const firstSize = cache.size;
  await findLocalArt(dir, 'b', { cache });
  assert.equal(cache.size, firstSize);
  assert.equal(firstSize, 1);
});

test('resolveLocalArt 还原绝对路径', () => {
  const movie = { path: path.resolve('media', 'film', 'a.mkv'), dir: path.resolve('media', 'film'), localArt: { poster: 'poster.jpg', backdrop: null } };
  assert.equal(resolveLocalArt(movie, 'poster'), path.join(path.resolve('media', 'film'), 'poster.jpg'));
  assert.equal(resolveLocalArt(movie, 'backdrop'), null);
  assert.equal(resolveLocalArt({ path: path.resolve('x', 'a.mkv'), localArt: null }, 'poster'), null);
});

async function writeVideo(dir, name) {
  await writeFakeVideo(path.join(dir, name), 4096, 9);
}
