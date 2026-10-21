/** 电影库主视图：网格/列表、筛选、分页、批量操作。 */
import { api } from '../api.js';
import { registerActions, runtime, setFilters, state } from '../state.js';
import {
  esc, fmtBytes, fmtDuration, icon, pendingDot, posterMarkup, stateBadge, toast,
} from '../util.js';

const SORT_OPTIONS = [
  ['addedAt', '入库时间'],
  ['title', '片名'],
  ['year', '年份'],
  ['size', '体积'],
  ['duration', '时长'],
  ['rating', '评分'],
  ['lastPlayedAt', '最近播放'],
  ['watchedAt', '标记时间'],
];

const STATE_OPTIONS = [
  ['', '全部状态'],
  ['pending', '待确认'],
  ['auto', '自动匹配'],
  ['confirmed', '已确认'],
  ['none', '未匹配'],
];

function headInfo() {
  const { filters } = state;
  if (filters.collection) return { title: `合集 · ${filters.collection}`, filtered: true };
  if (filters.tag) return { title: `标签 · ${filters.tag}`, filtered: true };
  if (filters.missing === 'yes') return { title: '仅缺失文件', filtered: true };
  if (filters.watched === 'no') return { title: '仅未看', filtered: true };
  if (filters.watched === 'yes') return { title: '仅已看', filtered: true };
  if (filters.state) {
    const label = STATE_OPTIONS.find(([value]) => value === filters.state)?.[1] ?? filters.state;
    return { title: `状态 · ${label}`, filtered: true };
  }
  if (filters.q) return { title: `搜索 · ${filters.q}`, filtered: true };
  return { title: '全部电影', filtered: false };
}

function option(value, label, current) {
  return `<option value="${esc(value)}"${String(current) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
}

function filtersHtml() {
  const { filters, health, config } = state;
  const resolutions = health?.facets?.resolutions ?? [];
  const roots = config?.roots ?? [];
  const watchedCount = health?.facets?.watched ?? 0;
  const unwatchedCount = health?.facets?.unwatched ?? 0;
  return `
    <div class="field"><span>排序</span>
      <select data-change="library.filter" data-key="sort">
        ${SORT_OPTIONS.map(([value, label]) => option(value, label, filters.sort)).join('')}
      </select>
    </div>
    <button class="btn sm" data-act="library.dir" title="切换升降序">${filters.dir === 'asc' ? '↑ 升序' : '↓ 降序'}</button>
    <div class="seg" title="点击筛选，再点一次取消">
      <button data-act="library.watched" data-value="no" class="${filters.watched === 'no' ? 'active' : ''}">${icon('clock', 12)}未看 ${unwatchedCount}</button>
      <button data-act="library.watched" data-value="yes" class="${filters.watched === 'yes' ? 'active' : ''}">${icon('check', 12)}已看 ${watchedCount}</button>
    </div>
    <div class="field"><span>状态</span>
      <select data-change="library.filter" data-key="state">
        ${STATE_OPTIONS.map(([value, label]) => option(value, label, filters.state)).join('')}
      </select>
    </div>
    <div class="field"><span>画质</span>
      <select data-change="library.filter" data-key="resolution">
        ${option('', '全部', filters.resolution)}
        ${resolutions.filter((item) => item.name !== '未知').map((item) => option(item.name, `${item.name} (${item.count})`, filters.resolution)).join('')}
      </select>
    </div>
    ${roots.length > 1 ? `<div class="field"><span>目录</span>
      <select data-change="library.filter" data-key="root">
        ${option('', '全部', filters.root)}
        ${roots.map((root) => option(root.id, root.label, filters.root)).join('')}
      </select>
    </div>` : ''}
  `;
}

export function renderLibrary(root) {
  const info = headInfo();
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">${esc(info.title)}</h1>
        <div class="view-sub" id="lib-count">读取中…</div>
      </div>
      <div class="spacer"></div>
      <div class="seg">
        <button data-act="library.view" data-mode="grid" class="${state.viewMode === 'grid' ? 'active' : ''}">${icon('grid', 13)}海报</button>
        <button data-act="library.view" data-mode="list" class="${state.viewMode === 'list' ? 'active' : ''}">${icon('list', 13)}列表</button>
      </div>
      <button class="btn" data-act="library.select-mode">${icon('check', 14)}${state.selectMode ? '退出选择' : '批量'}</button>
    </div>
    <div class="filters">${filtersHtml()}</div>
    ${coverHintHtml()}
    <div id="lib-body"><div class="empty"><h3>读取中…</h3></div></div>
    <div id="lib-bulk"></div>
  `;
  state.selected.clear();
  loadMovies();
}

/**
 * 封面相关的说明条：只在「可能让人困惑」的时候出现，可永久关闭。
 * 1) 没配 TMDB —— 说明封面从哪来、本地图怎么用；
 * 2) 配了 TMDB 但队列里还有未刮削的片子 —— 提醒去刮。
 */
function coverHintHtml() {
  const health = state.health;
  if (!health) return '';
  const dismissedTmdb = localStorage.getItem('dmv.hideTmdbHint') === '1';
  const dismissedQueue = localStorage.getItem('dmv.hideQueueHint') === '1';

  if (!health.tmdb?.configured && !dismissedTmdb) {
    return `
      <div class="hint" style="margin-bottom:14px">
        ${icon('info', 14)}
        <span>封面和简介来自 TMDB，目前还没配置 API Key。两条路：去「设置 → 元数据」填一个免费 Key 自动抓取；
        或者直接把 <code>poster.jpg</code> / <code>folder.jpg</code> 放进电影文件夹，扫描后立刻当封面。</span>
        <span class="hint-actions">
          <button class="btn sm" data-act="library.hint-settings">去设置</button>
          <button class="btn sm ghost" data-act="library.hint-dismiss" data-key="dmv.hideTmdbHint">知道了</button>
        </span>
      </div>`;
  }
  if (health.tmdb?.configured && (health.counts?.pending ?? 0) > 0 && !dismissedQueue) {
    return `
      <div class="hint" style="margin-bottom:14px">
        ${icon('film', 14)}
        <span>还有 <b>${health.counts.pending}</b> 部影片没刮削，所以暂时没有封面和简介。</span>
        <span class="hint-actions">
          <button class="btn sm" data-act="library.hint-queue">去待确认</button>
          <button class="btn sm ghost" data-act="library.hint-dismiss" data-key="dmv.hideQueueHint">知道了</button>
        </span>
      </div>`;
  }
  return '';
}

export async function loadMovies({ append = false } = {}) {
  const box = state.movies;
  if (box.loading) return;
  box.loading = true;
  if (!append) box.offset = 0;
  try {
    const result = await api.movies({ ...state.filters, limit: box.limit, offset: box.offset });
    box.total = result.total;
    box.items = append ? [...box.items, ...result.items] : result.items;
    box.offset = box.items.length;
    renderBody();
    updateCount();
  } catch (err) {
    const body = document.getElementById('lib-body');
    if (body) body.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(err.message)}</p></div>`;
  } finally {
    box.loading = false;
  }
}

export function reloadLibrary() {
  state.selected.clear();
  renderBulkBar();
  return loadMovies();
}

function updateCount() {
  const node = document.getElementById('lib-count');
  if (!node) return;
  const { total, items } = state.movies;
  const bytes = items.reduce((sum, movie) => sum + (Number(movie.size) || 0), 0);
  node.textContent = `共 ${total} 部 · 已加载 ${items.length} 部 · ${fmtBytes(bytes)}`;
}

function cardHtml(movie) {
  const selected = state.selected.has(movie.id) ? ' selected' : '';
  return `
    <article class="card${movie.missing ? ' card-missing' : ''}${selected}" data-act="library.card" data-id="${esc(movie.id)}" tabindex="0" role="button" title="${esc(movie.title)}">
      <div class="poster">
        ${posterMarkup(movie)}
        ${pendingDot(movie)}
        ${movie.watched ? `<span class="card-watched" title="已看">${icon('check', 11)}</span>` : ''}
        <span class="card-check">${icon('check', 12)}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${esc(movie.title)}</div>
        <div class="card-meta">
          <span>${movie.year ?? '—'}</span>
          <span class="dot"></span>
          <span>${esc(movie.resolution ?? '未知画质')}</span>
          ${movie.size ? `<span class="dot"></span><span>${fmtBytes(movie.size)}</span>` : ''}
        </div>
      </div>
    </article>`;
}

function rowHtml(movie) {
  return `
    <div class="table-row${state.selected.has(movie.id) ? ' selected' : ''}" data-act="library.card" data-id="${esc(movie.id)}" role="button" tabindex="0">
      <div class="tr-title">
        ${movie.missing ? '<span class="badge err">缺失</span>' : ''}
        ${movie.watched ? '<span class="badge ok">已看</span>' : ''}
        <span title="${esc(movie.path)}">${esc(movie.title)}</span>
      </div>
      <div class="mono">${movie.year ?? '—'}</div>
      <div class="mono">${esc(movie.resolution ?? '—')}</div>
      <div class="mono">${fmtBytes(movie.size)}</div>
      <div class="mono">${fmtDuration(movie.durationSec)}</div>
      <div>${stateBadge(movie)}</div>
    </div>`;
}

function renderBody() {
  const body = document.getElementById('lib-body');
  if (!body) return;
  const { items, total } = state.movies;

  if (!total && !items.length) {
    const hasAny = (state.health?.counts?.total ?? 0) > 0;
    body.innerHTML = hasAny
      ? `<div class="empty">
           <h3>没有匹配的影片</h3>
           <p>当前筛选条件下没有结果，试试清除筛选或换一个关键词。</p>
           <button class="btn" data-act="library.reset">清除筛选</button>
         </div>`
      : `<div class="empty">
           <h3>库还是空的</h3>
           <p>1）到「设置 → 电影目录」添加一个根目录（例如 <code>D:\\电影</code>）；<br/>
              2）点右上角「扫描」，程序会按「一片一目录」的结构登记视频文件。</p>
           <button class="btn primary" data-act="library.goto-settings">去设置</button>
         </div>`;
    return;
  }

  const gridCls = `grid${state.selectMode ? ' select-mode' : ''}`;
  const list = state.viewMode === 'grid'
    ? `<div class="${gridCls}">${items.map(cardHtml).join('')}</div>`
    : `<div class="table">
         <div class="table-head"><div>片名</div><div>年份</div><div>画质</div><div>体积</div><div>时长</div><div>状态</div></div>
         ${items.map(rowHtml).join('')}
       </div>`;

  const more = items.length < total
    ? `<div style="display:flex;justify-content:center;margin-top:22px">
         <button class="btn" data-act="library.more">加载更多（${items.length}/${total}）</button>
       </div>`
    : '';

  body.innerHTML = list + more;
  renderBulkBar();
}

function renderBulkBar() {
  const slot = document.getElementById('lib-bulk');
  if (!slot) return;
  if (!state.selectMode && !state.selected.size) {
    slot.innerHTML = '';
    return;
  }
  const count = state.selected.size;
  slot.innerHTML = `
    <div class="bulk-bar">
      <span class="bulk-count">已选 <b>${count}</b> 部</span>
      <button class="btn sm" data-act="library.bulk-tag" ${count ? '' : 'disabled'}>${icon('tag', 13)}加标签</button>
      <button class="btn sm" data-act="library.bulk-collection" ${count ? '' : 'disabled'}>${icon('layers', 13)}加合集</button>
      <button class="btn sm" data-act="library.bulk-watched" data-value="watched" ${count ? '' : 'disabled'}>${icon('check', 13)}标记已看</button>
      <button class="btn sm" data-act="library.bulk-watched" data-value="unwatched" ${count ? '' : 'disabled'}>${icon('clock', 13)}标记未看</button>
      <button class="btn sm" data-act="library.bulk-confirm" ${count ? '' : 'disabled'}>${icon('check', 13)}确认匹配</button>
      <button class="btn sm danger" data-act="library.bulk-remove" ${count ? '' : 'disabled'}>${icon('trash', 13)}移出库</button>
      <button class="btn sm ghost" data-act="library.clear-selection" ${count ? '' : 'disabled'}>清空</button>
    </div>`;
}

function toggleSelection(movieId) {
  if (state.selected.has(movieId)) state.selected.delete(movieId);
  else state.selected.add(movieId);
  const node = document.querySelector(`[data-act="library.card"][data-id="${CSS.escape(movieId)}"]`);
  if (node) node.classList.toggle('selected', state.selected.has(movieId));
  renderBulkBar();
}

function selectedIds() {
  return [...state.selected];
}

registerActions({
  'library.view': (element) => {
    const mode = element.dataset.mode === 'list' ? 'list' : 'grid';
    state.viewMode = mode;
    localStorage.setItem('dmv.viewMode', mode);
    for (const button of document.querySelectorAll('[data-act="library.view"]')) {
      button.classList.toggle('active', button.dataset.mode === mode);
    }
    renderBody();
  },
  'library.select-mode': () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    const button = document.querySelector('[data-act="library.select-mode"]');
    if (button) button.innerHTML = `${icon('check', 14)}${state.selectMode ? '退出选择' : '批量'}`;
    renderBody();
  },
  'library.card': (element) => {
    const movieId = element.dataset.id;
    if (state.selectMode) toggleSelection(movieId);
    else runtime.openDetail(movieId);
  },
  'library.filter': (element) => {
    const key = element.dataset.key;
    setFilters({ [key]: element.value });
    loadMovies();
  },
  'library.dir': () => {
    setFilters({ dir: state.filters.dir === 'asc' ? 'desc' : 'asc' });
    const button = document.querySelector('[data-act="library.dir"]');
    if (button) button.textContent = state.filters.dir === 'asc' ? '↑ 升序' : '↓ 降序';
    loadMovies();
  },
  'library.watched': (element) => {
    const value = element.dataset.value;
    setFilters({ watched: state.filters.watched === value ? '' : value });
    const filtersBox = document.querySelector('.filters');
    if (filtersBox) filtersBox.innerHTML = filtersHtml();
    document.querySelector('.view-title').textContent = headInfo().title;
    loadMovies();
  },
  'library.reset': () => {
    const q = state.filters.q;
    state.filters = {
      q, sort: 'addedAt', dir: 'desc', state: '', resolution: '',
      tag: '', collection: '', root: '', kind: '', missing: '', watched: '',
    };
    const filtersBox = document.querySelector('.filters');
    if (filtersBox) filtersBox.innerHTML = filtersHtml();
    loadMovies();
  },
  'library.more': () => loadMovies({ append: true }),
  'library.hint-settings': () => runtime.navigate('settings'),
  'library.hint-queue': () => runtime.navigate('queue'),
  'library.hint-dismiss': (element) => {
    localStorage.setItem(element.dataset.key ?? 'dmv.hideTmdbHint', '1');
    element.closest('.hint')?.remove();
  },
  'library.goto-settings': () => runtime.navigate('settings'),
  'library.clear-selection': () => {
    state.selected.clear();
    renderBody();
  },
  'library.bulk-tag': async () => {
    const tag = window.prompt('给选中的影片添加标签：', '');
    if (!tag?.trim()) return;
    await api.bulk(selectedIds(), 'addTag', tag.trim());
    toast(`已添加标签「${tag.trim()}」`, 'ok');
    state.selected.clear();
    await runtime.refreshHealth();
    loadMovies();
  },
  'library.bulk-collection': async () => {
    const name = window.prompt('归入合集：', '');
    if (!name?.trim()) return;
    await api.bulk(selectedIds(), 'addCollection', name.trim());
    toast(`已归入合集「${name.trim()}」`, 'ok');
    state.selected.clear();
    await runtime.refreshHealth();
    loadMovies();
  },
  'library.bulk-watched': async (element) => {
    const action = element.dataset.value === 'unwatched' ? 'unwatched' : 'watched';
    const count = selectedIds().length;
    await api.bulk(selectedIds(), action);
    toast(action === 'watched' ? `已把 ${count} 部标记为已看` : `已把 ${count} 部标记为未看`, 'ok');
    state.selected.clear();
    await runtime.refreshHealth();
    loadMovies();
  },
  'library.bulk-confirm': async () => {
    await api.bulk(selectedIds(), 'confirm');
    toast('已标记为已确认', 'ok');
    state.selected.clear();
    await runtime.refreshHealth();
    loadMovies();
  },
  'library.bulk-remove': async () => {
    const ids = selectedIds();
    if (!window.confirm(`从库中移除 ${ids.length} 条记录？（不会删除磁盘文件）`)) return;
    await api.bulk(ids, 'remove');
    toast('已从库中移除', 'ok');
    state.selected.clear();
    await runtime.refreshHealth();
    loadMovies();
  },
});
