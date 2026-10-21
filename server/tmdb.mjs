/**
 * TMDB 刮削：搜索 / 详情 / 海报本地缓存 / 候选打分。
 *
 * 全部响应落盘到 data/cache/tmdb，海报背景图落盘到 data/cache/images，
 * 因此刮削成功后整个界面可完全离线浏览。
 */
import path from 'node:path';
import { ensureDir, hashText, pathExists, readJson, writeFileAtomic, writeJsonAtomic } from './fsx.mjs';
import { requestBuffer, requestJson } from './net.mjs';
import { buildSearchQuery } from './parse.mjs';

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const MIN_INTERVAL_MS = 220;
const ALLOWED_IMAGE_SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'w1280', 'original']);
const RE_IMAGE_PATH = /^\/[\w.-]+\.(?:jpg|jpeg|png|webp)$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 标题归一化：小写、去重音、去标点、去冠词。 */
export function normalizeTitle(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^(?:the|a|an|le|la|les|der|die|das|el|los|las)\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length < 2) return compact ? [compact] : [];
  const out = [];
  for (let index = 0; index < compact.length - 1; index += 1) out.push(compact.slice(index, index + 2));
  return out;
}

/** Dice 系数，0~1。 */
export function similarity(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;
  const gramsLeft = bigrams(left);
  const gramsRight = bigrams(right);
  const counts = new Map();
  for (const gram of gramsLeft) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of gramsRight) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (gramsLeft.length + gramsRight.length);
}

/** 候选与本地解析结果的匹配分。 */
export function scoreCandidate(candidate, parsed) {
  if (!candidate) return 0;
  const sim = Math.max(
    similarity(parsed?.title, candidate.title),
    similarity(parsed?.title, candidate.originalTitle),
  );
  let score = sim;
  const parsedYear = Number(parsed?.year) || null;
  const candidateYear = Number(candidate.year) || null;
  if (parsedYear && candidateYear) {
    const diff = Math.abs(parsedYear - candidateYear);
    score *= diff === 0 ? 1 : diff === 1 ? 0.94 : diff === 2 ? 0.78 : 0.45;
  } else if (parsedYear && !candidateYear) {
    score *= 0.9;
  }
  return Math.max(0, Math.min(1, score));
}

export function pickBest(candidates, parsed, minScore = 0.4) {
  let best = null;
  for (const candidate of candidates ?? []) {
    const score = scoreCandidate(candidate, parsed);
    if (!best || score > best.score) best = { candidate, score };
  }
  if (!best || best.score < minScore) return null;
  return best;
}

function normalizeSearchResult(raw) {
  return {
    id: raw.id,
    title: raw.title ?? raw.name ?? '',
    originalTitle: raw.original_title ?? raw.original_name ?? '',
    year: Number(String(raw.release_date ?? raw.first_air_date ?? '').slice(0, 4)) || null,
    releaseDate: raw.release_date ?? null,
    overview: raw.overview ?? '',
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    voteAverage: raw.vote_average ?? null,
    voteCount: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
  };
}

function normalizeDetail(raw, language) {
  const crew = raw.credits?.crew ?? [];
  const cast = raw.credits?.cast ?? [];
  return {
    id: raw.id,
    imdbId: raw.imdb_id ?? null,
    title: raw.title ?? '',
    originalTitle: raw.original_title ?? '',
    year: Number(String(raw.release_date ?? '').slice(0, 4)) || null,
    releaseDate: raw.release_date ?? null,
    overview: raw.overview ?? '',
    tagline: raw.tagline ?? '',
    runtimeMin: raw.runtime ?? null,
    genres: (raw.genres ?? []).map((genre) => genre.name).filter(Boolean),
    voteAverage: raw.vote_average ?? null,
    voteCount: raw.vote_count ?? 0,
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    originalLanguage: raw.original_language ?? null,
    status: raw.status ?? null,
    countries: (raw.production_countries ?? []).map((country) => country.iso_3166_1).filter(Boolean),
    collection: raw.belongs_to_collection
      ? {
          id: raw.belongs_to_collection.id,
          name: raw.belongs_to_collection.name ?? '',
          posterPath: raw.belongs_to_collection.poster_path ?? null,
        }
      : null,
    directors: crew.filter((member) => member.job === 'Director').map((member) => member.name).filter(Boolean),
    cast: cast.slice(0, 12).map((member) => ({
      name: member.name,
      character: member.character ?? '',
      order: member.order ?? 0,
    })),
    language: language ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

export class TmdbClient {
  /**
   * @param {{
   *   dataDir: string,
   *   getConfig: () => any,
   *   requestJson?: typeof requestJson,
   *   requestBuffer?: typeof requestBuffer,
   * }} options 请求层可注入，便于测试（默认走带 DNS 绕行的实现）
   */
  constructor({ dataDir, getConfig, requestJson: requestJsonImpl = requestJson, requestBuffer: requestBufferImpl = requestBuffer }) {
    this.dataDir = dataDir;
    this.getConfig = getConfig;
    this.requestJson = requestJsonImpl;
    this.requestBuffer = requestBufferImpl;
    this.cacheDir = path.join(dataDir, 'cache', 'tmdb');
    this.imageDir = path.join(dataDir, 'cache', 'images');
    this.lastRequestAt = 0;
  }

  get config() {
    return this.getConfig();
  }

  /**
   * 读取凭据并判断类型。
   *
   * TMDB 页面上有两个值，都支持：
   *  - 「API 密钥 / API Key (v3 auth)」：32 位十六进制，走 `?api_key=`
   *  - 「API 读访问令牌 / Read Access Token (v4 auth)」：eyJ 开头的 JWT，走 `Authorization: Bearer`
   *
   * 环境变量 TMDB_API_KEY / TMDB_API_TOKEN 优先于配置文件。
   * @returns {{token: string, mode: 'query'|'bearer'|null, source: string}}
   */
  get credentials() {
    const fromEnv = (process.env.TMDB_API_KEY ?? '').trim() || (process.env.TMDB_API_TOKEN ?? '').trim();
    const raw = fromEnv || (this.config.tmdb?.apiKey ?? '').trim();
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    if (!token) return { token: '', mode: null, source: fromEnv ? 'env' : 'none' };
    // v4 JWT；v3 是 32 位十六进制。其它格式先按 v3 试，401 时自动切 Bearer。
    const mode = token.startsWith('eyJ') ? 'bearer' : 'query';
    return { token, mode, source: fromEnv ? 'env' : 'config' };
  }

  /** 兼容旧调用点。 */
  get apiKey() {
    return this.credentials.token;
  }

  get enabled() {
    return Boolean(this.credentials.token);
  }

  get language() {
    return this.config.tmdb?.language || 'zh-CN';
  }

  get fallbackLanguage() {
    return this.config.tmdb?.fallbackLanguage || 'en-US';
  }

  async throttle() {
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** 按指定鉴权方式发一次请求（不含 401 换模式的逻辑）。 */
  async send(pathname, params, { token, mode }, retries) {
    const url = new URL(`${API_BASE}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('include_adult', 'false');

    const headers = { accept: 'application/json' };
    if (mode === 'bearer') headers.Authorization = `Bearer ${token}`;
    else url.searchParams.set('api_key', token);

    for (let attempt = 0; ; attempt += 1) {
      await this.throttle();
      let result;
      try {
        // 走自带的 DNS 绕行客户端：api.themoviedb.org 在部分网络会被污染
        result = await this.requestJson(url.toString(), { headers, timeoutMs: 20000 });
      } catch (err) {
        if (attempt < retries) {
          await sleep(600);
          continue;
        }
        throw new Error(
          `TMDB 请求失败：${err.message}。`
          + '如果浏览器也打不开 api.themoviedb.org，请检查网络或配置代理；'
          + '如果只是本程序失败，可在设置里点「网络诊断」查看解析结果。',
        );
      }

      this.lastVia = result.via ?? null;
      this.lastAddress = result.address ?? null;

      if (result.status === 401) {
        const error = new Error(
          'TMDB 认证失败（401）：Key 无效或类型不对。'
          + '页面上「API 密钥 / API Key」是 32 位十六进制，「API 读访问令牌」是 eyJ 开头的长串，两种本程序都支持，'
          + '请重新粘贴后点「测试连接」。',
        );
        error.code = 'UNAUTHORIZED';
        throw error;
      }
      if (result.status === 429 && attempt < retries) {
        await sleep(1500);
        continue;
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`TMDB 返回 ${result.status}：${String(result.text ?? '').slice(0, 200)}`);
      }
      return result.payload;
    }
  }

  /**
   * 统一请求入口：自动选择 v3/v4 鉴权；401 时换另一种再试一次
   * （用户很容易把 v4 令牌粘到 v3 的位置）。
   */
  async request(pathname, params = {}, { retries = 1 } = {}) {
    const credentials = this.credentials;
    if (!credentials.token) throw new Error('未配置 TMDB API Key');
    try {
      return await this.send(pathname, params, credentials, retries);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED' && credentials.mode === 'query') {
        return this.send(pathname, params, { token: credentials.token, mode: 'bearer' }, retries);
      }
      throw err;
    }
  }

  cacheFile(kind, key) {
    return path.join(this.cacheDir, `${kind}-${hashText(key, 'sha1').slice(0, 24)}.json`);
  }

  async readCache(file) {
    const ttlDays = Number(this.config.tmdb?.cacheDays ?? 30);
    if (ttlDays <= 0) return null;
    const cached = await readJson(file, null);
    if (!cached) return null;
    const ageMs = Date.now() - Date.parse(cached.cachedAt ?? 0);
    if (!Number.isFinite(ageMs) || ageMs > ttlDays * 86400000) return null;
    return cached.payload ?? null;
  }

  async writeCache(file, payload) {
    await writeJsonAtomic(file, { cachedAt: new Date().toISOString(), payload });
  }

  /**
   * 搜索电影。
   * @returns {Promise<{results: object[], language: string, cached: boolean}>}
   */
  async search(query, { year = null, language = null, force = false } = {}) {
    const text = String(query ?? '').trim();
    if (!text) return { results: [], language: this.language, cached: false };
    const lang = language || this.language;
    const cacheFile = this.cacheFile('search', `${lang}|${text}|${year ?? ''}`);
    if (!force) {
      const cached = await this.readCache(cacheFile);
      if (cached) return { ...cached, cached: true };
    }
    const data = await this.request('/search/movie', {
      query: text,
      year: year ?? undefined,
      language: lang,
      page: 1,
    });
    const results = (data.results ?? []).map(normalizeSearchResult);
    const payload = { results, language: lang, query: text, year };
    await this.writeCache(cacheFile, payload);
    return { ...payload, cached: false };
  }

  /** 电影详情（含演职员）。 */
  async detail(tmdbId, { language = null, force = false } = {}) {
    const lang = language || this.language;
    const cacheFile = this.cacheFile('movie', `${lang}|${tmdbId}`);
    if (!force) {
      const cached = await this.readCache(cacheFile);
      if (cached) return { ...cached, cached: true };
    }
    const raw = await this.request(`/movie/${tmdbId}`, {
      language: lang,
      append_to_response: 'credits',
    });
    const payload = normalizeDetail(raw, lang);
    await this.writeCache(cacheFile, payload);
    return { ...payload, cached: false };
  }

  /**
   * 完整刮削：搜索 -> 打分选片 -> 详情。
   *
   * 注意：搜索文本只用标题，年份走单独的 `year` 参数。
   * 把年份拼进 query（"The Godfather 1972"）会让 TMDB 的模糊搜索直接返回空。
   *
   * @param {object} parsed 文件名解析结果
   */
  async scrape(parsed, { minScore = null, force = false } = {}) {
    const query = String(parsed?.title ?? '').trim() || buildSearchQuery(parsed);
    if (!query) return { match: null, score: 0, reason: '标题为空，无法搜索' };
    const threshold = Number(minScore ?? this.config.tmdb?.minScore ?? 0.4);

    let { results, language } = await this.search(query, { year: parsed?.year ?? null, force });
    if (!results.length) {
      // 年份参数可能过严（TMDB 的年份是精确匹配），去掉年份再搜一次
      const relaxed = await this.search(query, { year: null, force: true });
      if (relaxed.results.length) {
        results = relaxed.results;
        language = relaxed.language;
      }
    }
    if (!results.length) {
      const fallback = await this.search(query, { language: this.fallbackLanguage, force });
      if (fallback.results.length) {
        results = fallback.results;
        language = fallback.language;
      }
    }
    const best = pickBest(results, parsed, threshold);
    if (!best) {
      return {
        match: null,
        score: 0,
        reason: results.length ? '候选分低于阈值，请手动匹配' : '没有搜到候选',
        candidates: results.slice(0, 8),
      };
    }
    const detail = await this.detail(best.candidate.id, { language, force });
    // 海报语言可能与元数据语言不同（例如中文简介 + 原版海报）
    const posterPath = await this.posterPathFor(detail, { force });
    return {
      match: { ...detail, posterPath },
      score: best.score,
      query,
      candidates: results.slice(0, 8),
    };
  }

  get posterLanguage() {
    return this.config.tmdb?.posterLanguage || 'follow';
  }

  /**
   * 按配置挑选海报。
   *
   * TMDB 的 `poster_path` 是跟着请求语言走的：language=zh-CN 会给中文版海报。
   * `follow` 直接用详情里的海报；其它取值会查 /images，按语言挑一张。
   *
   * @param {object} movie 归一化后的详情
   * @param {{force?: boolean}} [options]
   * @returns {Promise<string|null>} TMDB 图片路径
   */
  async posterPathFor(movie, { force = false } = {}) {
    const preference = this.posterLanguage;
    if (preference === 'follow' || !movie?.id) return movie?.posterPath ?? null;

    const wanted = preference === 'original'
      ? String(movie.originalLanguage || 'en').slice(0, 2)
      : preference.slice(0, 2);

    const cacheFile = this.cacheFile('poster', `${wanted}|${movie.id}`);
    try {
      let data = force ? null : await this.readCache(cacheFile);
      if (!data) {
        data = await this.request(`/movie/${movie.id}/images`, { include_image_language: `null,${wanted}` });
        await this.writeCache(cacheFile, data);
      }
      const posters = (data?.posters ?? []).filter((item) => item?.file_path);
      if (!posters.length) return movie.posterPath ?? null;
      const exact = posters.find((item) => (item.iso_639_1 ?? null) === wanted);
      if (exact) return exact.file_path;
      const neutral = posters.find((item) => !item.iso_639_1);
      if (neutral) return neutral.file_path;
      const best = [...posters].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))[0];
      return best?.file_path ?? movie.posterPath ?? null;
    } catch {
      // /images 失败不影响刮削，退回详情里的海报
      return movie.posterPath ?? null;
    }
  }

  /** 本地海报文件名（与 tmdbId 绑定，便于离线复用）。 */
  imageFile(tmdbId, kind) {
    return path.join(this.imageDir, `${tmdbId}-${kind}.jpg`);
  }

  async hasImage(tmdbId, kind) {
    return pathExists(this.imageFile(tmdbId, kind));
  }

  /**
   * 下载海报/背景图到本地缓存（已存在则跳过）。
   * @returns {Promise<{poster: boolean, backdrop: boolean}>}
   */
  async cacheImages(movie, { force = false } = {}) {
    const result = { poster: false, backdrop: false };
    if (!movie?.id) return result;
    const jobs = [
      ['poster', movie.posterPath, this.config.tmdb?.posterSize || 'w342'],
      ['backdrop', movie.backdropPath, this.config.tmdb?.backdropSize || 'w780'],
    ];
    await ensureDir(this.imageDir);
    for (const [kind, remotePath, size] of jobs) {
      if (!remotePath) continue;
      const target = this.imageFile(movie.id, kind);
      if (!force && (await pathExists(target))) {
        result[kind] = true;
        continue;
      }
      try {
        await this.throttle();
        const image = await this.requestBuffer(`${IMAGE_BASE}/${size}${remotePath}`, { timeoutMs: 30000 });
        if (image.status !== 200) continue;
        await writeFileAtomic(target, image.buffer);
        result[kind] = true;
      } catch {
        // 单张图失败不影响刮削结果
      }
    }
    return result;
  }

  /**
   * 代理任意 TMDB 图片（用于「手动匹配」面板的候选缩略图），带本地缓存。
   * @returns {Promise<{file: string, contentType: string}|null>}
   */
  async proxyImage(remotePath, size = 'w92') {
    if (!RE_IMAGE_PATH.test(String(remotePath ?? ''))) return null;
    const useSize = ALLOWED_IMAGE_SIZES.has(size) ? size : 'w92';
    const target = path.join(this.imageDir, `remote-${hashText(`${useSize}${remotePath}`, 'sha1').slice(0, 24)}.jpg`);
    if (await pathExists(target)) return { file: target, contentType: 'image/jpeg' };
    await ensureDir(this.imageDir);
    await this.throttle();
    try {
      const image = await this.requestBuffer(`${IMAGE_BASE}/${useSize}${remotePath}`, { timeoutMs: 20000 });
      if (image.status !== 200) return null;
      await writeFileAtomic(target, image.buffer);
      return { file: target, contentType: image.contentType };
    } catch {
      return null;
    }
  }
}
