import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';

import { sanitizeConfig } from '../server/config.mjs';
import { TmdbClient, normalizeTitle, pickBest, scoreCandidate, similarity } from '../server/tmdb.mjs';
import { makeTempDir } from './helpers.mjs';

const SEARCH_ZH = { results: [] };
const SEARCH_EN = {
  results: [
    { id: 238, title: 'The Godfather', original_title: 'The Godfather', release_date: '1972-03-14', poster_path: '/poster238.jpg', backdrop_path: '/back238.jpg', vote_average: 8.7, vote_count: 20000, popularity: 90 },
    { id: 240, title: 'The Godfather Part II', original_title: 'The Godfather Part II', release_date: '1974-12-20', poster_path: '/poster240.jpg', backdrop_path: null, vote_average: 8.6, vote_count: 12000, popularity: 60 },
  ],
};
const DETAIL_238 = {
  id: 238,
  imdb_id: 'tt0068646',
  title: '教父',
  original_title: 'The Godfather',
  release_date: '1972-03-14',
  overview: '黑帮家族的兴衰。',
  tagline: 'An offer you cannot refuse.',
  runtime: 175,
  genres: [{ name: '剧情' }, { name: '犯罪' }],
  vote_average: 8.7,
  vote_count: 20000,
  poster_path: '/poster238.jpg',
  backdrop_path: '/back238.jpg',
  original_language: 'en',
  status: 'Released',
  production_countries: [{ iso_3166_1: 'US' }],
  belongs_to_collection: { id: 10, name: 'The Godfather Collection', poster_path: '/coll.jpg' },
  credits: {
    crew: [{ job: 'Director', name: 'Francis Ford Coppola' }, { job: 'Producer', name: 'Albert S. Ruddy' }],
    cast: [{ name: 'Marlon Brando', character: 'Don Vito Corleone', order: 0 }, { name: 'Al Pacino', character: 'Michael', order: 1 }],
  },
};

const config = (overrides = {}) => () => sanitizeConfig({
  tmdb: {
    apiKey: 'test-key',
    language: 'zh-CN',
    fallbackLanguage: 'en-US',
    cacheDays: 30,
    ...overrides,
  },
});

/** 假的请求层：记录每次调用，按 URL 返回预设结果。 */
function mockNet(handler) {
  const calls = [];
  const run = async (url, options) => {
    const text = String(url);
    calls.push({ url: text, options });
    const result = await handler(text, options);
    if (result?.buffer) {
      return {
        status: result.status ?? 200,
        headers: result.headers ?? { 'content-type': 'image/jpeg' },
        buffer: result.buffer,
        contentType: 'image/jpeg',
        via: 'test',
      };
    }
    const payload = result?.payload ?? {};
    return {
      status: result?.status ?? 200,
      payload,
      text: JSON.stringify(payload),
      via: 'test',
      address: '127.0.0.1',
    };
  };
  return { calls, run };
}

test('标题归一化与相似度', () => {
  assert.equal(normalizeTitle('The Godfather'), 'godfather');
  assert.equal(normalizeTitle('  Amélie  '), 'amelie');
  assert.equal(normalizeTitle('LE  Fabuleux Destin'), 'fabuleux destin');
  assert.equal(similarity('The Godfather', 'godfather'), 1);
  assert.ok(similarity('The Godfather', 'The Godfather Part II') > 0.8);
  assert.ok(similarity('The Godfather', 'Inception') < 0.3);
});

test('候选打分：年份一致的精确命中最高', () => {
  const parsed = { title: 'The Godfather', year: 1972 };
  const exact = scoreCandidate({ title: 'The Godfather', originalTitle: 'The Godfather', year: 1972 }, parsed);
  const wrongYear = scoreCandidate({ title: 'The Godfather', originalTitle: 'The Godfather', year: 1999 }, parsed);
  const partTwo = scoreCandidate({ title: 'The Godfather Part II', originalTitle: 'The Godfather Part II', year: 1974 }, parsed);
  assert.equal(exact, 1);
  assert.ok(wrongYear < exact);
  assert.ok(partTwo < exact);
  assert.equal(pickBest([{ title: 'Inception', year: 2010 }], parsed, 0.4), null);
});

test('未配置 Key 时拒绝调用', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-');
  t.after(cleanup);
  const client = new TmdbClient({ dataDir: dir, getConfig: () => sanitizeConfig({ tmdb: { apiKey: '' } }) });
  assert.equal(client.enabled, false);
  await assert.rejects(() => client.search('godfather'), /未配置 TMDB API Key/);
});

test('搜索：归一化结果并写缓存', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb2-');
  t.after(cleanup);
  const net = mockNet((url) => {
    if (url.includes('/search/movie')) return { payload: SEARCH_EN };
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({ dataDir: dir, getConfig: config(), requestJson: net.run });

  const first = await client.search('The Godfather', { year: 1972, language: 'en-US' });
  assert.equal(first.results.length, 2);
  assert.equal(first.results[0].title, 'The Godfather');
  assert.equal(first.results[0].year, 1972);
  assert.equal(first.cached, false);
  assert.ok(net.calls[0].url.includes('api_key=test-key'));
  assert.ok(net.calls[0].url.includes('year=1972'));

  const callsAfterFirst = net.calls.length;
  const second = await client.search('The Godfather', { year: 1972, language: 'en-US' });
  assert.equal(second.cached, true);
  assert.equal(net.calls.length, callsAfterFirst, '第二次应命中磁盘缓存，不再请求');

  const cacheFiles = await fs.readdir(path.join(dir, 'cache', 'tmdb'));
  assert.ok(cacheFiles.some((name) => name.startsWith('search-')), '应写入搜索缓存文件');
});

test('刮削：搜索文本只用标题，年份走独立参数', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-query-');
  t.after(cleanup);
  const net = mockNet((url) => {
    if (url.includes('/search/movie')) return { payload: SEARCH_EN };
    if (url.includes('/movie/238')) return { payload: DETAIL_238 };
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({ dataDir: dir, getConfig: config(), requestJson: net.run });

  const result = await client.scrape({ title: 'The Godfather', year: 1972 });
  assert.ok(result.match, '应匹配成功');

  const searchCall = net.calls.find((call) => call.url.includes('/search/movie'));
  const url = new URL(searchCall.url);
  assert.equal(url.searchParams.get('query'), 'The Godfather', 'query 里不应该带年份');
  assert.equal(url.searchParams.get('year'), '1972', '年份应作为独立参数');
});

test('刮削：中文无结果时回退英文并选中正确候选', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb3-');
  t.after(cleanup);
  const net = mockNet((url) => {
    if (url.includes('/search/movie')) {
      return { payload: url.includes('language=zh-CN') ? SEARCH_ZH : SEARCH_EN };
    }
    if (url.includes('/movie/238')) return { payload: DETAIL_238 };
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({ dataDir: dir, getConfig: config(), requestJson: net.run });

  const result = await client.scrape({ title: 'The Godfather', year: 1972 });
  assert.ok(result.match, '应匹配到电影');
  assert.equal(result.match.id, 238);
  assert.equal(result.match.language, 'en-US', '应记录回退后的语言');
  assert.ok(result.score > 0.9);
  assert.deepEqual(result.match.genres, ['剧情', '犯罪']);
  assert.deepEqual(result.match.directors, ['Francis Ford Coppola']);
  assert.equal(result.match.runtimeMin, 175);
  assert.equal(result.match.collection.name, 'The Godfather Collection');
  assert.equal(result.match.cast.length, 2);
});

test('刮削：年份参数过严时去掉年份再搜一次', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-relax-');
  t.after(cleanup);
  let searchCount = 0;
  const net = mockNet((url) => {
    if (url.includes('/search/movie')) {
      searchCount += 1;
      const withYear = new URL(url).searchParams.get('year');
      if (searchCount === 1 && withYear === '1972') return { payload: { results: [] } };
      return { payload: SEARCH_EN };
    }
    if (url.includes('/movie/238')) return { payload: DETAIL_238 };
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({ dataDir: dir, getConfig: config(), requestJson: net.run });
  const result = await client.scrape({ title: 'The Godfather', year: 1972 });
  assert.ok(result.match, '去掉年份后应匹配成功');
  assert.ok(searchCount >= 2, '应该发生重试');
});

test('刮削：候选分低于阈值时返回未匹配原因', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb4-');
  t.after(cleanup);
  const net = mockNet(() => ({ payload: { results: [{ id: 999, title: 'Completely Different', release_date: '2001-01-01' }] } }));
  const client = new TmdbClient({ dataDir: dir, getConfig: config({ minScore: 0.6 }), requestJson: net.run });
  const result = await client.scrape({ title: 'The Godfather', year: 1972 });
  assert.equal(result.match, null);
  assert.match(result.reason, /候选分低于阈值/);
  assert.equal(result.candidates.length, 1);
});

test('海报缓存：下载到本地并跳过已存在的文件', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb5-');
  t.after(cleanup);
  const net = mockNet(() => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }));
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config(),
    requestJson: net.run,
    requestBuffer: net.run,
  });

  const movie = { id: 238, posterPath: '/poster238.jpg', backdropPath: '/back238.jpg' };
  const first = await client.cacheImages(movie);
  assert.deepEqual(first, { poster: true, backdrop: true });
  assert.equal(await client.hasImage(238, 'poster'), true);

  const imageCalls = net.calls.filter((call) => call.url.includes('image.tmdb.org')).length;
  const second = await client.cacheImages(movie);
  assert.deepEqual(second, { poster: true, backdrop: true });
  assert.equal(net.calls.filter((call) => call.url.includes('image.tmdb.org')).length, imageCalls, '第二次不应重复下载');

  const files = await fs.readdir(path.join(dir, 'cache', 'images'));
  assert.ok(files.includes('238-poster.jpg'));
});

test('海报语言：follow 直接用详情里的海报', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-poster-follow-');
  t.after(cleanup);
  const net = mockNet((url) => {
    if (url.includes('/search/movie')) return { payload: SEARCH_EN };
    if (url.includes('/movie/238/images')) return { payload: { posters: [] } };
    if (url.includes('/movie/238')) return { payload: DETAIL_238 };
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ posterLanguage: 'follow' }),
    requestJson: net.run,
  });
  const result = await client.scrape({ title: 'The Godfather', year: 1972 });
  assert.equal(result.match.posterPath, '/poster238.jpg', 'follow 时保持详情返回的海报');
  assert.equal(net.calls.some((call) => call.url.includes('/images')), false, 'follow 不应额外查 images');
});

test('海报语言：original 选原语言（英语）海报', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-poster-orig-');
  t.after(cleanup);
  const net = mockNet((url) => {
    if (url.includes('/search/movie')) return { payload: SEARCH_EN };
    if (url.includes('/movie/238/images')) {
      return {
        payload: {
          posters: [
            { iso_639_1: 'zh', file_path: '/poster-zh.jpg', vote_average: 9 },
            { iso_639_1: 'en', file_path: '/poster-en.jpg', vote_average: 4 },
            { iso_639_1: null, file_path: '/poster-neutral.jpg', vote_average: 7 },
          ],
        },
      };
    }
    if (url.includes('/movie/238')) return { payload: DETAIL_238 };
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ posterLanguage: 'original' }),
    requestJson: net.run,
  });
  const result = await client.scrape({ title: 'The Godfather', year: 1972 });
  assert.equal(result.match.originalLanguage, 'en');
  assert.equal(result.match.posterPath, '/poster-en.jpg', 'original 应选英语海报而不是中文或通用图');
});

test('海报语言：没有对应语言时退回无语言通用海报', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-poster-fallback-');
  t.after(cleanup);
  const net = mockNet((url) => {
    if (url.includes('/movie/238/images')) {
      return {
        payload: {
          posters: [
            { iso_639_1: 'zh', file_path: '/poster-zh.jpg', vote_average: 9 },
            { iso_639_1: null, file_path: '/poster-neutral.jpg', vote_average: 1 },
          ],
        },
      };
    }
    return { status: 404, payload: {} };
  });
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ posterLanguage: 'en-US' }),
    requestJson: net.run,
  });
  const posterPath = await client.posterPathFor(DETAIL_238);
  assert.equal(posterPath, '/poster-neutral.jpg');
  const call = net.calls.find((item) => item.url.includes('/images'));
  assert.ok(call.url.includes('include_image_language=null%2Cen'), '请求应包含 null 与目标语言');
});

test('图片代理：只接受合法 TMDB 路径', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb6-');
  t.after(cleanup);
  const net = mockNet(() => ({ buffer: Buffer.from([1, 2, 3]) }));
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config(),
    requestJson: net.run,
    requestBuffer: net.run,
  });
  assert.equal(await client.proxyImage('https://evil.example/x.jpg'), null);
  assert.equal(await client.proxyImage('/../../etc/passwd'), null);
  const safe = await client.proxyImage('/poster238.jpg', 'w92');
  assert.ok(safe?.file.endsWith('.jpg'));
});

test('v3 密钥走 api_key 查询参数', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-v3-');
  t.after(cleanup);
  const net = mockNet(() => ({ payload: SEARCH_EN }));
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ apiKey: 'test-key-0000000000000000000000dead' }),
    requestJson: net.run,
  });
  assert.equal(client.credentials.mode, 'query');
  await client.search('godfather');
  const url = new URL(net.calls[0].url);
  assert.equal(url.searchParams.get('api_key'), 'test-key-0000000000000000000000dead');
  assert.equal(net.calls[0].options.headers.Authorization, undefined);
});

test('v4 读访问令牌走 Authorization: Bearer', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-v4-');
  t.after(cleanup);
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJkZTQ1In0.signature';
  const net = mockNet(() => ({ payload: SEARCH_EN }));
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ apiKey: token }),
    requestJson: net.run,
  });
  assert.equal(client.credentials.mode, 'bearer');
  await client.search('godfather');
  const url = new URL(net.calls[0].url);
  assert.equal(url.searchParams.get('api_key'), null, 'v4 不应把令牌塞进 query');
  assert.equal(net.calls[0].options.headers.Authorization, `Bearer ${token}`);
});

test('401 时自动换一种鉴权方式重试', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb-retry-');
  t.after(cleanup);
  let attempt = 0;
  const net = mockNet(() => {
    attempt += 1;
    if (attempt === 1) return { status: 401, payload: { status_message: 'Invalid API key' } };
    return { payload: SEARCH_EN };
  });
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ apiKey: 'looks-like-v3-but-wrong' }),
    requestJson: net.run,
  });
  const result = await client.search('godfather');
  assert.equal(result.results.length, 2);
  assert.equal(net.calls.length, 2);
  assert.equal(net.calls[1].options.headers.Authorization, 'Bearer looks-like-v3-but-wrong');
});

test('两种鉴权都失败时给出可读错误', async (t) => {
  const { dir, cleanup } = await makeTempDir('dmv-tmdb401-');
  t.after(cleanup);
  const net = mockNet(() => ({ status: 401, payload: { status_message: 'Invalid API key' } }));
  const client = new TmdbClient({
    dataDir: dir,
    getConfig: config({ apiKey: 'test-key-0000000000000000000000dead' }),
    requestJson: net.run,
  });
  await assert.rejects(
    () => client.search('x'),
    /认证失败（401）[\s\S]*API 密钥[\s\S]*读访问令牌/,
  );
});
