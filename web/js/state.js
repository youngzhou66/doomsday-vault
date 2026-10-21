/** 前端共享状态与跨视图动作注册表（无框架，单向数据流）。 */

export const state = {
  health: null,
  config: null,
  presets: {},
  extensions: [],
  envKey: false,
  view: 'library',
  viewMode: localStorage.getItem('dmv.viewMode') === 'list' ? 'list' : 'grid',
  filters: {
    q: '',
    sort: 'addedAt',
    dir: 'desc',
    state: '',
    resolution: '',
    tag: '',
    collection: '',
    root: '',
    kind: '',
    missing: '',
    watched: '',
  },
  movies: { items: [], total: 0, offset: 0, loading: false, limit: 60 },
  queue: { items: [], total: 0, offset: 0, limit: 40 },
  dupes: null,
  selected: new Set(),
  selectMode: false,
  currentMovie: null,
  matchTarget: null,
  activeJob: null,
};

export function resetFilters() {
  state.filters = {
    q: '', sort: 'addedAt', dir: 'desc', state: '', resolution: '',
    tag: '', collection: '', root: '', kind: '', missing: '', watched: '',
  };
}

export function setFilters(patch) {
  Object.assign(state.filters, patch);
  state.movies.offset = 0;
}

/** 视图动作注册表：data-act="xxx" 的点击统一在这里分发。 */
export const actions = new Map();

export function registerActions(map) {
  for (const [key, fn] of Object.entries(map)) actions.set(key, fn);
}

/**
 * app.js 注入的能力，供各视图调用（避免视图反向 import app 造成循环依赖）。
 * 视图只调用这里的函数，不直接碰路由。
 */
export const runtime = {
  navigate: () => {},
  openDetail: () => {},
  closeDetail: () => {},
  reload: () => {},
  refreshHealth: async () => {},
  trackJob: async () => {},
  refreshSidebar: () => {},
};

export function setRuntime(patch) {
  Object.assign(runtime, patch);
}
