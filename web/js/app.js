/**
 * 应用外壳：路由、侧栏、顶栏、任务进度、全局事件分发。
 */
import { api } from './api.js';
import { actions, registerActions, resetFilters, setFilters, setRuntime, state } from './state.js';
import { esc, fmtBytes, icon, toast } from './util.js';
import { renderLibrary, reloadLibrary } from './views/library.js';
import { closeDetail, openDetail } from './views/detail.js';
import { renderQueue } from './views/queue.js';
import { renderDupes } from './views/dupes.js';
import { renderSettings } from './views/settings.js';

const content = document.getElementById('content');
const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');

export const VIEWS = {
  library: { render: (root) => renderLibrary(root) },
  queue: { render: (root) => renderQueue(root) },
  dupes: { render: (root) => renderDupes(root) },
  settings: { render: (root) => renderSettings(root) },
};

/* ── 路由 ─────────────────────────────────────────────── */
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, queryText] = raw.split('?');
  const segments = path.split('/').filter(Boolean);
  return {
    name: segments[0] || 'library',
    arg: segments[1] ? decodeURIComponent(segments[1]) : null,
    params: Object.fromEntries(new URLSearchParams(queryText ?? '')),
  };
}

export function navigate(name, params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== '' && value != null),
  ).toString();
  const next = `#/${name}${search ? `?${search}` : ''}`;
  if (location.hash === next) applyRoute();
  else location.hash = next;
}

function applyRoute() {
  const route = parseRoute();

  if (route.name === 'movie' && route.arg) {
    state.view = 'library';
    VIEWS.library.render(content);
    openDetail(route.arg).catch((err) => toast(err.message, 'err'));
    return;
  }

  closeDetail({ silent: true });
  state.view = route.name;

  if (route.params.collection) {
    resetFilters();
    setFilters({ collection: route.params.collection, sort: 'year', dir: 'asc' });
  } else if (route.params.tag) {
    resetFilters();
    setFilters({ tag: route.params.tag });
  } else if (route.params.state) {
    resetFilters();
    setFilters({ state: route.params.state });
  } else if (route.params.missing) {
    resetFilters();
    setFilters({ missing: route.params.missing });
  } else if (route.name === 'library') {
    resetFilters();
    setFilters({ q: route.params.q ?? '' });
  }

  const view = VIEWS[route.name] ?? VIEWS.library;
  view.render(content);
  content.scrollTop = 0;
  syncSearchBox();
  syncNavActive();
}

function syncSearchBox() {
  const input = document.getElementById('search-input');
  if (input && input.value !== state.filters.q) input.value = state.filters.q;
}

function syncNavActive() {
  const hash = location.hash || '#/library';
  for (const link of sidebar.querySelectorAll('.nav-item')) {
    const href = link.getAttribute('href');
    if (href) link.classList.toggle('active', href === hash);
  }
}

/* ── 侧栏 ─────────────────────────────────────────────── */
function sidebarHtml() {
  const counts = state.health?.counts ?? {};
  const facets = state.health?.facets ?? {};
  const navItem = (href, iconName, label, badge) => `
    <a class="nav-item" href="${href}">
      ${icon(iconName, 16)}
      <span>${esc(label)}</span>
      ${badge !== undefined && badge !== null && badge !== '' ? `<span class="nav-count">${badge}</span>` : ''}
    </a>`;

  const collections = (facets.collections ?? []).slice(0, 7);
  const tags = (facets.tags ?? []).slice(0, 7);

  return `
    <div class="nav-label">资料库</div>
    ${navItem('#/library', 'library', '全部电影', counts.total ?? 0)}
    ${navItem('#/queue', 'queue', '待确认', counts.pending ?? 0)}
    ${navItem('#/dupes', 'copy', '重复文件', '')}
    ${navItem('#/library?missing=yes', 'warn', '仅缺失', counts.missing ?? 0)}
    ${navItem('#/settings', 'sliders', '设置', '')}
    ${collections.length ? '<div class="nav-label">合集</div>' : ''}
    ${collections.map((item) => navItem(`#/library?collection=${encodeURIComponent(item.name)}`, 'layers', item.name, item.count)).join('')}
    ${tags.length ? '<div class="nav-label">标签</div>' : ''}
    ${tags.map((item) => navItem(`#/library?tag=${encodeURIComponent(item.name)}`, 'tag', item.name, item.count)).join('')}
  `;
}

function renderSidebar() {
  const nav = document.getElementById('nav');
  if (nav) nav.innerHTML = sidebarHtml();
  const health = state.health;
  const foot = document.getElementById('sidebar-foot');
  if (foot) {
    const offline = health?.offline ?? {};
    const offlineColor = offline.ready ? 'var(--ok)' : 'var(--warn)';
    foot.innerHTML = `
      <div class="stat-row"><span>影片</span><b>${health?.counts?.total ?? 0}</b></div>
      <div class="stat-row"><span>占用</span><b>${fmtBytes(health?.counts?.totalBytes ?? 0)}</b></div>
      <div class="stat-row" title="封面与简介都已在本地，断网也能看">
        <span>离线就绪</span>
        <b style="color:${offlineColor}">${offline.withPoster ?? 0}/${offline.total ?? 0} 封面</b>
      </div>
      <div class="stat-row"><span>ffprobe</span><b style="color:${health?.ffprobe?.ok ? 'var(--ok)' : 'var(--err)'}">${health?.ffprobe?.ok ? '就绪' : '缺失'}</b></div>
      <div class="stat-row"><span>TMDB</span><b style="color:${health?.tmdb?.configured ? 'var(--ok)' : 'var(--err)'}">${health?.tmdb?.configured ? '已配置' : '未配置'}</b></div>
    `;
  }
  syncNavActive();
}

/* ── 顶栏 ─────────────────────────────────────────────── */
function renderTopbar() {
  topbar.innerHTML = `
    <button class="btn icon menu-btn" data-act="app.menu" title="菜单">${icon('menu', 16)}</button>
    <div class="search">
      ${icon('search', 15)}
      <input id="search-input" type="search" placeholder="搜索片名 / 演员 / 标签 / 路径…" autocomplete="off" spellcheck="false" />
      <kbd>/</kbd>
    </div>
    <div class="topbar-spacer"></div>
    <div id="job-slot"></div>
    <button class="btn" data-act="app.export-json" title="导出整库 JSON">${icon('download', 14)}<span class="hide-sm">导出</span></button>
    <button class="btn primary" data-act="app.scan">${icon('refresh', 14)}扫描</button>
  `;

  const input = document.getElementById('search-input');
  input.value = state.filters.q;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filters.q = input.value.trim();
      state.movies.offset = 0;
      if (state.view !== 'library') navigate('library');
      else reloadLibrary();
    }, 240);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      state.filters.q = '';
      reloadLibrary();
    }
  });
}

function updateJobPill() {
  const slot = document.getElementById('job-slot');
  if (!slot) return;
  const job = state.activeJob;
  if (!job) {
    slot.innerHTML = '';
    return;
  }
  const running = job.status === 'running';
  const percent = running
    ? (Number(job.total) > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 8)
    : 100;
  const label = running
    ? `${job.phase ?? '处理中'}${Number(job.total) ? ` ${job.done}/${job.total}` : ''}`
    : job.status === 'done' ? '完成' : job.status === 'cancelled' ? '已取消' : '失败';
  slot.innerHTML = `
    <div class="progress-pill" title="${esc(job.current ?? job.message ?? '')}">
      <span class="spinner"></span>
      <div class="bar"><i style="width:${percent}%"></i></div>
      <span class="label">${esc(label)}</span>
      ${running ? '<button class="btn sm ghost" data-act="job.cancel" style="padding:0 4px">取消</button>' : ''}
    </div>`;
}

/* ── 任务跟踪 ─────────────────────────────────────────── */
async function trackJob(id, { onDone, silentError = false } = {}) {
  state.activeJob = { id, status: 'running', phase: '排队中', total: 0, done: 0 };
  updateJobPill();

  const tick = async () => {
    let job;
    try {
      job = await api.job(id);
    } catch (err) {
      state.activeJob = null;
      updateJobPill();
      if (!silentError) toast(err.message, 'err');
      return;
    }
    state.activeJob = job;
    updateJobPill();
    if (job.status === 'running') {
      setTimeout(tick, 550);
      return;
    }
    state.activeJob = null;
    setTimeout(updateJobPill, 1400);
    if (job.status === 'error') toast(job.message || '任务失败', 'err', 6000);
    else if (job.status === 'cancelled') toast('任务已取消');
    else onDone?.(job);
    refreshHealth().catch(() => {});
  };
  tick();
}

async function refreshHealth() {
  const health = await api.health();
  state.health = health;
  renderSidebar();
  return health;
}

/* ── 全局动作 ─────────────────────────────────────────── */
registerActions({
  'app.scan': async () => {
    const { id } = await api.scan();
    toast('开始扫描电影目录…');
    trackJob(id, {
      onDone: async (job) => {
        const result = job.result ?? {};
        const parts = [`新增 ${result.added ?? 0}`, `更新 ${result.updated ?? 0}`, `未变 ${result.unchanged ?? 0}`];
        if (result.skippedEpisodes) parts.push(`跳过剧集 ${result.skippedEpisodes}`);
        if (result.skippedIgnored) parts.push(`忽略 ${result.skippedIgnored}`);
        if (result.ignoredRemoved) parts.push(`清理已忽略 ${result.ignoredRemoved}`);
        if (result.missing) parts.push(`失踪 ${result.missing}`);
        if (result.probeFailed) parts.push(`探测失败 ${result.probeFailed}`);
        toast(`扫描完成：${parts.join('，')}`, 'ok', 5200);
        if (result.warnings?.length) console.warn('[扫描警告]', result.warnings);
        await refreshHealth();
        reloadLibrary();
      },
    });
  },
  'job.cancel': async () => {
    if (!state.activeJob?.id) return;
    await api.cancelJob(state.activeJob.id);
    toast('正在取消…');
  },
  'app.export-json': () => {
    window.location.href = api.exportUrl('json');
    toast('正在下载 JSON 导出', 'ok');
  },
  'app.menu': () => {
    sidebar.classList.toggle('open');
    let mask = document.querySelector('.sidebar-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'sidebar-mask';
      document.body.appendChild(mask);
      mask.addEventListener('click', () => {
        sidebar.classList.remove('open');
        mask.classList.remove('show');
      });
    }
    mask.classList.toggle('show', sidebar.classList.contains('open'));
  },
  'app.close-modal': async () => {
    const { hideModal } = await import('./modal.js');
    hideModal();
  },
});

/* ── 全局事件 ─────────────────────────────────────────── */
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const fn = actions.get(target.dataset.act);
  if (!fn) return;
  event.preventDefault();
  if (target.disabled) return;
  target.disabled = true;
  try {
    await fn(target, event);
  } catch (err) {
    toast(err?.message ?? String(err), 'err', 5200);
  } finally {
    target.disabled = false;
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target.closest('[data-change]');
  if (!target) return;
  const fn = actions.get(target.dataset.change);
  if (!fn) return;
  try {
    await fn(target, event);
  } catch (err) {
    toast(err?.message ?? String(err), 'err', 5200);
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-submit]');
  if (!form) return;
  event.preventDefault();
  const fn = actions.get(form.dataset.submit);
  if (!fn) return;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await fn(form, event);
  } catch (err) {
    toast(err?.message ?? String(err), 'err', 5200);
  } finally {
    if (button) button.disabled = false;
  }
});

// 海报：加载成功淡入，失败退回 CSS 占位（不出现裂图）
document.addEventListener('load', (event) => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.dataset.poster !== undefined) img.classList.add('loaded');
}, true);
document.addEventListener('error', (event) => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.dataset.poster !== undefined) img.remove();
}, true);

document.addEventListener('keydown', (event) => {
  const tagName = document.activeElement?.tagName;
  const typing = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
    event.preventDefault();
    document.getElementById('search-input')?.focus();
    return;
  }
  if (event.key === 'Escape') {
    if (!document.getElementById('modal-root').hidden) {
      import('./modal.js').then((m) => m.hideModal());
      return;
    }
    if (!document.getElementById('drawer').hidden) {
      closeDetail();
      return;
    }
    if (sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      document.querySelector('.sidebar-mask')?.classList.remove('show');
    }
  }
});

window.addEventListener('hashchange', applyRoute);

/* ── 启动 ─────────────────────────────────────────────── */
async function boot() {
  renderTopbar();
  try {
    const [health, configResponse] = await Promise.all([api.health(), api.getConfig()]);
    state.health = health;
    state.config = configResponse.config;
    state.presets = configResponse.presets ?? {};
    state.extensions = configResponse.extensions ?? [];
    state.envKey = Boolean(configResponse.envKey);
  } catch (err) {
    content.innerHTML = `
      <div class="empty">
        <h3>连不上本地服务</h3>
        <p>${esc(err.message)}</p>
        <p class="mono">在项目目录执行 npm start，然后刷新本页</p>
      </div>`;
    return;
  }
  renderSidebar();
  applyRoute();

  const empty = (state.health?.counts?.total ?? 0) === 0;
  if (empty && (state.config?.roots?.length ?? 0) === 0) {
    toast('先到「设置」添加电影根目录，再点右上角「扫描」', 'ok', 6000);
  }
}

setRuntime({
  navigate,
  openDetail: async (id) => {
    await openDetail(id);
  },
  closeDetail: (options) => {
    closeDetail(options);
    if (!options?.silent && parseRoute().name === 'movie') navigate('library');
  },
  reload: () => reloadLibrary(),
  refreshHealth,
  trackJob,
  refreshSidebar: renderSidebar,
});

boot();
