import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSearchQuery, isJunkTitle, parseFileName, parseMovieName } from '../server/parse.mjs';

/** 常见发布命名 */
const CASES = [
  {
    name: 'The.Godfather.1972.1080p.BluRay.x264-SPARKS.mkv',
    expect: { title: 'The Godfather', year: 1972, resolution: '1080p', source: 'BluRay', videoCodec: 'H.264', group: 'SPARKS' },
  },
  {
    name: 'The Godfather Part II (1974) [Remastered] 1080p.mkv',
    expect: { title: 'The Godfather Part II', year: 1974, edition: 'Remastered', resolution: '1080p' },
  },
  {
    name: 'Blade.Runner.2049.2017.2160p.UHD.BluRay.x265-TERMiNAL.mkv',
    expect: { title: 'Blade Runner 2049', year: 2017, resolution: '2160p', videoCodec: 'HEVC', source: 'BluRay' },
  },
  {
    name: '1917.2019.1080p.WEB-DL.H.264.mkv',
    expect: { title: '1917', year: 2019, resolution: '1080p', source: 'WEB-DL', videoCodec: 'H.264' },
  },
  {
    name: '2001.A.Space.Odyssey.1968.1080p.mkv',
    expect: { title: '2001 A Space Odyssey', year: 1968 },
  },
  {
    name: '教父.The.Godfather.1972.EXTENDED.1080p.BluRay.x265-GRP.mkv',
    expect: { title: '教父 The Godfather', year: 1972, edition: 'Extended', videoCodec: 'HEVC' },
  },
  {
    name: '教父2.The.Godfather.Part.II.1974.REMASTERED.1080p.mkv',
    expect: { title: '教父2 The Godfather Part II', year: 1974, edition: 'Remastered' },
  },
  {
    name: 'Dune.2021.4K.HDR.TrueHD.Atmos.mkv',
    expect: { title: 'Dune', year: 2021, resolution: '2160p', audioCodec: 'TrueHD' },
  },
  {
    name: 'Interstellar.2014.1080p.BluRay.DTS-HD.MA.5.1.x264.mkv',
    expect: { title: 'Interstellar', year: 2014, audioCodec: 'DTS-HD' },
  },
  {
    name: 'Spider-Man.No.Way.Home.2021.1080p.WEB-DL.mkv',
    expect: { title: 'Spider-Man No Way Home', year: 2021 },
  },
  {
    name: 'Parasite.2019.KOREAN.1080p.BluRay.x264.mkv',
    expect: { title: 'Parasite', year: 2019 },
  },
  {
    name: 'Blade Runner 2049.mkv',
    expect: { title: 'Blade Runner 2049', year: null },
  },
];

for (const testCase of CASES) {
  test(`解析文件名：${testCase.name}`, () => {
    const parsed = parseFileName(testCase.name);
    for (const [key, value] of Object.entries(testCase.expect)) {
      assert.equal(parsed[key], value, `${key} 期望 ${value}，实际 ${parsed[key]}`);
    }
  });
}

test('剧集文件被识别为 episode', () => {
  const parsed = parseFileName('Some.Show.S01E02.1080p.WEB-DL.mkv');
  assert.equal(parsed.kind, 'episode');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 2);
});

test('中文集数也能识别', () => {
  const parsed = parseFileName('大明王朝.第03集.mkv');
  assert.equal(parsed.kind, 'episode');
  assert.equal(parsed.episode, 3);
});

test('分卷（CD1）被识别', () => {
  const parsed = parseFileName('The.Godfather.Part.II.CD1.avi');
  assert.equal(parsed.part, 1);
});

test('一片一目录：内层垃圾文件名用目录名兜底', () => {
  const parsed = parseMovieName({ fileName: 'movie.mkv', folderName: 'The Godfather Part III (1990)' });
  assert.equal(parsed.title, 'The Godfather Part III');
  assert.equal(parsed.year, 1990);
  assert.equal(parsed.titleSource, 'folder');
});

test('一片一目录：CD1.avi 这类文件名走目录名', () => {
  const parsed = parseMovieName({ fileName: 'CD1.avi', folderName: '教父 (1972)' });
  assert.equal(parsed.title, '教父');
  assert.equal(parsed.year, 1972);
});

test('一片一目录：文件名缺年份时用目录年份补齐', () => {
  const parsed = parseMovieName({ fileName: 'The.Matrix.1080p.BluRay.mkv', folderName: 'The Matrix (1999)' });
  assert.equal(parsed.title, 'The Matrix');
  assert.equal(parsed.year, 1999);
  assert.equal(parsed.resolution, '1080p');
  assert.equal(parsed.titleSource, 'file');
});

test('一片一目录：目录名是占位词时保留文件名解析', () => {
  const parsed = parseMovieName({ fileName: 'Inception.2010.1080p.mkv', folderName: '电影' });
  assert.equal(parsed.title, 'Inception');
  assert.equal(parsed.year, 2010);
});

test('无目录名时等同于单文件名解析', () => {
  const parsed = parseMovieName({ fileName: 'Inception.2010.1080p.mkv' });
  assert.equal(parsed.title, 'Inception');
  assert.equal(parsed.year, 2010);
});

test('发布组标记不会被当成标题', () => {
  const parsed = parseFileName('[YTS.MX] The.Matrix.1999.1080p.BluRay.x264.mkv');
  assert.equal(parsed.title, 'The Matrix');
  assert.equal(parsed.year, 1999);
});

test('占位标题识别', () => {
  for (const title of ['video', 'movie', 'CD1', '2', '', 'x']) {
    assert.equal(isJunkTitle(title), true, `${title} 应判定为占位`);
  }
  for (const title of ['Inception', '教父', 'The Godfather']) {
    assert.equal(isJunkTitle(title), false, `${title} 不应判定为占位`);
  }
});

test('搜索词带年份', () => {
  assert.equal(buildSearchQuery({ title: 'Inception', year: 2010 }), 'Inception 2010');
  assert.equal(buildSearchQuery({ title: 'Inception', year: null }), 'Inception');
});
