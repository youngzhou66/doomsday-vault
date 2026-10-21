/** 后端 API 客户端。所有错误统一抛 ApiError，由全局处理器转成 Toast。 */

const BASE = window.__MOVIE_API_BASE__ ?? '';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? null;
  }
}

async function request(method, pathname, body, { signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('无法连接本地服务，请确认 `npm start` 仍在运行', 0, 'NETWORK');
  }
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status, payload?.error?.code);
  }
  return payload;
}

function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  health: (opts) => request('GET', '/api/health', undefined, opts),
  facets: (opts) => request('GET', '/api/facets', undefined, opts),

  getConfig: () => request('GET', '/api/config'),
  saveConfig: (patch) => request('PUT', '/api/config', patch),
  detectFfprobe: () => request('POST', '/api/ffprobe/detect', {}),

  roots: () => request('GET', '/api/roots'),
  validateRoot: (path) => request('POST', '/api/roots/validate', { path }),
  addRoot: (path, { label, depth } = {}) => request('POST', '/api/roots', { path, label, depth }),
  patchRoot: (id, patch) => request('PATCH', `/api/roots/${encodeURIComponent(id)}`, patch),
  deleteRoot: (id, prune = false) => request('DELETE', `/api/roots/${encodeURIComponent(id)}${prune ? '?prune=1' : ''}`),
  relocateRoot: (rootId, newPath) => request('POST', '/api/roots/relocate', { rootId, newPath }),
  rootSuggest: () => request('GET', '/api/roots/suggest'),

  scan: (rootId) => request('POST', '/api/scan', rootId ? { rootId } : {}),
  jobs: () => request('GET', '/api/jobs'),
  job: (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id) => request('DELETE', `/api/jobs/${encodeURIComponent(id)}`),

  movies: (params) => request('GET', `/api/movies${query(params)}`),
  movie: (id) => request('GET', `/api/movies/${encodeURIComponent(id)}`),
  patchMovie: (id, patch) => request('PATCH', `/api/movies/${encodeURIComponent(id)}`, patch),
  deleteMovie: (id) => request('DELETE', `/api/movies/${encodeURIComponent(id)}`),
  bulk: (ids, action, value) => request('POST', '/api/movies/bulk', { ids, action, value }),

  scrape: (id, force = false) => request('POST', `/api/movies/${encodeURIComponent(id)}/scrape`, { force }),
  match: (id, tmdbId, force = false) => request('POST', `/api/movies/${encodeURIComponent(id)}/match`, { tmdbId, force }),
  probe: (id) => request('POST', `/api/movies/${encodeURIComponent(id)}/probe`, {}),
  open: (id, startSec) => request('POST', `/api/movies/${encodeURIComponent(id)}/open`, startSec ? { startSec } : {}),
  reveal: (id) => request('POST', `/api/movies/${encodeURIComponent(id)}/reveal`, {}),
  streamUrl: (id) => `${BASE}/api/movies/${encodeURIComponent(id)}/stream`,
  capturePoster: (id, body = {}) => request('POST', `/api/movies/${encodeURIComponent(id)}/poster/capture`, body),
  clearPoster: (id) => request('DELETE', `/api/movies/${encodeURIComponent(id)}/poster/capture`),
  captureMissingPosters: () => request('POST', '/api/posters/capture-missing', {}),
  detectFfmpeg: () => request('POST', '/api/ffmpeg/detect', {}),

  queue: (params) => request('GET', `/api/queue${query(params)}`),
  scrapeQueue: (body) => request('POST', '/api/queue/scrape', body ?? {}),

  tmdbSearch: (q, year) => request('GET', `/api/tmdb/search${query({ q, year })}`),
  tmdbTest: () => request('POST', '/api/tmdb/test', {}),
  networkDiagnose: () => request('POST', '/api/network/diagnose', {}),
  offlineStatus: () => request('GET', '/api/offline/status'),
  tmdbImageUrl: (path, size = 'w92') => `${BASE}/api/tmdb/image?p=${encodeURIComponent(path)}&size=${size}`,

  dupes: () => request('GET', '/api/dupes'),
  findDupes: () => request('POST', '/api/dupes', {}),

  exportUrl: (format) => `${BASE}/api/export?format=${format}`,
  exportToDisk: (format) => request('POST', '/api/export', { format }),
  backup: () => request('POST', '/api/backup', {}),
  backups: () => request('GET', '/api/backups'),
  verify: (deep) => request('POST', '/api/verify', { deep }),
  importLibrary: (movies) => request('POST', '/api/library/import', { movies }),
  previewParse: (name, folder) => request('GET', `/api/preview-parse${query({ name, folder })}`),
};
