/** 想看清单：先把片子记下来，元数据从 TMDB 拉一次就缓存在本地。 */
import { api } from '../api.js';
import { hideModal, showModal } from '../modal.js';
import { registerActions, runtime, state } from '../state.js';
import { esc, icon, toast } from '../util.js';

const STATUS_LABEL = { wish: '想看', watched: '已看', owned: '已入库' };
const STATUS_BADGE = { wish: 'accent', watched: 'ok', owned: '' };
const FILTERS = [
  ['all', '全部'],
  ['wish', '想看'],
  ['watched', '已看'],
  ['owned', '已入库'],
];

let filter = 'all';
let items = [];
let pickTargetId = null;

function counts() {
  return {
    all: items.length,
    wish: items.filter((item) => item.status === 'wish').length,
    watched: items.filter((item) => item.status === 'watched').length,
    owned: items.filter((item) => item.status === 'owned' || item.owned).length,
  };
}

function posterHtml(item) {
  const fallback = `
    <span class="pf-mark">NO ART</span>
    <span class="pf-glyph">${icon('film', 22)}</span>
    <span class="pf-title">${esc(item.title)}</span>
    ${item.year ? `<span class="pf-year">${item.year}</span>` : ''}`;
  if (!item.hasPoster) return `<div class="poster"><div class="poster-fallback">${fallback}</div></div>`;
  return `<div class="poster">
    <img src="${api.watchlistPosterUrl(item.id)}" alt="" loading="lazy" data-watch-poster />
    <div class="poster-fallback" hidden>${fallback}</div>
  </div>`;
}

function cardHtml(item) {
  const status = item.owned && item.status === 'wish' ? 'owned' : item.status;
  const meta = [
    item.year ?? '—',
    item.runtimeMin ? `${item.runtimeMin} 分钟` : null,
    item.voteAverage ? `★ ${Number(item.voteAverage).toFixed(1)}` : null,
  ].filter(Boolean).join(' · ');
  return `
    <article class="panel wish-card" data-wish-id="${esc(item.id)}">
      ${posterHtml(item)}
      <div class="wish-body">
        <h4 class="wish-title" title="${esc(item.title)}">${esc(item.title)}</h4>
        <div class="wish-meta">${esc(meta)}</div>
        <div class="wish-badges">
          <span class="badge ${STATUS_BADGE[status] ?? ''}">${item.owned && item.status === 'wish' ? '已在库中' : STATUS_LABEL[status] ?? '想看'}</span>
          ${item.tmdbId ? `<span class="badge">TMDB ${item.tmdbId}</span>` : '<span class="badge err">未关联 TMDB</span>'}
        </div>
        <div class="wish-actions">
          <button class="btn sm" data-act="wish.status" data-id="${esc(item.id)}" data-status="${item.status === 'watched' ? 'wish' : 'watched'}"
            title="${item.status === 'watched' ? '改回想看' : '标记已看'}">${icon('check', 12)}${item.status === 'watched' ? '取消已看' : '已看'}</button>
          <button class="btn sm" data-act="wish.status" data-id="${esc(item.id)}" data-status="${item.status === 'owned' ? 'wish' : 'owned'}"
            title="${item.status === 'owned' ? '改回想看' : '标记为已入库'}">${icon('library', 12)}${item.status === 'owned' ? '取消入库' : '入库'}</button>
          ${item.tmdbId ? '' : `<button class="btn sm" data-act="wish.refresh" data-id="${esc(item.id)}" title="用片名搜一次 TMDB，补全元数据">${icon('refresh', 12)}补全</button>`}
          <button class="btn sm ghost" data-act="wish.remove" data-id="${esc(item.id)}" title="从清单删除">${icon('trash', 12)}</button>
        </div>
        ${item.note ? `<div class="wish-note">${esc(item.note)}</div>` : ''}
      </div>
    </article>`;
}

function filtered() {
  if (filter === 'all') return items;
  if (filter === 'owned') return items.filter((item) => item.status === 'owned' || item.owned);
  return items.filter((item) => item.status === filter);
}

function bodyHtml() {
  const list = filtered();
  if (!items.length) {
    return `<div class="empty"><h3>清单还是空的</h3>
      <p>点右上角「添加」，从 TMDB 搜一部；或者直接手动记个片名。</p>
      <button class="btn primary" data-act="wish.add">${icon('plus', 14)}添加想看的电影</button></div>`;
  }
  if (!list.length) return '<div class="empty"><h3>这个状态下没有条目</h3><p>换个筛选看看。</p></div>';
  return `<div class="wish-grid">${list.map(cardHtml).join('')}</div>`;
}

function renderBody() {
  const body = document.getElementById('wish-body');
  if (!body) return;
  body.innerHTML = bodyHtml();
  // 海报加载失败时退回占位卡
  for (const img of body.querySelectorAll('[data-watch-poster]')) {
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => {
      img.remove();
      const fallback = img.parentElement?.querySelector('.poster-fallback');
      if (fallback) fallback.hidden = false;
    });
  }
  const countNode = document.getElementById('wish-count');
  if (countNode) {
    const c = counts();
    countNode.textContent = `共 ${c.all} 条 · 想看 ${c.wish} · 已看 ${c.watched} · 已在库 ${c.owned}`;
  }
  const filtersNode = document.getElementById('wish-filters');
  if (filtersNode) {
    const c = counts();
    filtersNode.innerHTML = FILTERS.map(([key, label]) => `
      <button data-act="wish.filter" data-key="${key}" class="${filter === key ? 'active' : ''}">${label} ${c[key] ?? 0}</button>`).join('');
  }
}

export function renderWatchlist(root) {
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">想看</h1>
        <div class="view-sub" id="wish-count">读取中…</div>
      </div>
      <div class="spacer"></div>
      <div class="seg" id="wish-filters"></div>
      <button class="btn primary" data-act="wish.add">${icon('plus', 13)}添加</button>
    </div>
    <div class="hint" style="margin-bottom:14px">${icon('info', 14)}
      <span>这里放「还没下载 / 还没整理」的片子。从 TMDB 加进来会把标题、年份、评分、简介和海报缓存在本地，断网也能看；本地有了文件后，右边会显示「已在库中」。</span>
    </div>
    <div id="wish-body"><div class="empty"><h3>读取中…</h3></div></div>`;
  filter = 'all';
  loadWatchlist();
}

async function loadWatchlist() {
  try {
    const result = await api.watchlist();
    items = result.items ?? [];
    renderBody();
    await runtime.refreshHealth();
  } catch (err) {
    const body = document.getElementById('wish-body');
    if (body) body.innerHTML = `<div class="empty"><h3>读取失败</h3><p>${esc(err.message)}</p></div>`;
  }
}

/* ── 添加对话框 ───────────────────────────────────────── */
function candidatesHtml(results, action = 'wish.pick') {
  if (!results?.length) return '<div class="view-sub">没搜到，换个关键词试试</div>';
  return results.map((candidate) => `
    <button class="candidate" data-act="${action}" data-tmdb="${candidate.id}">
      <span class="c-poster">${candidate.posterPath ? `<img src="${api.tmdbImageUrl(candidate.posterPath, 'w92')}" alt="" loading="lazy" />` : ''}</span>
      <span>
        <span class="c-title">${esc(candidate.title)}</span>
        <span class="c-sub">${candidate.year ?? '—'}${candidate.originalTitle && candidate.originalTitle !== candidate.title ? ` · ${esc(candidate.originalTitle)}` : ''}</span>
      </span>
      <span class="c-score">${Math.round((candidate.score ?? 0) * 100)}%</span>
    </button>`).join('');
}

/** 补全时人工挑一个 TMDB 条目。 */
function openPickDialog(itemId, candidates, reason) {
  pickTargetId = itemId;
  showModal({
    title: '选择对应的 TMDB 条目',
    body: `
      <div class="hint" style="margin-bottom:10px">${icon('info', 14)}
        <span>${esc(reason ?? '自动匹配没把握')}，从下面挑一个：</span>
      </div>
      <div class="candidates">${candidatesHtml(candidates, 'wish.link')}</div>`,
    footer: '<span class="view-sub">选中后会缓存元数据与海报；挑错了可以再点「补全」重来</span>',
  });
}

function openAddDialog() {
  const hasKey = state.health?.tmdb?.configured !== false;
  showModal({
    title: '添加想看的电影',
    body: `
      <form class="search-line" data-submit="wish.search">
        <input name="q" placeholder="片名，或 片名 年份" autocomplete="off" ${hasKey ? '' : 'disabled'} />
        <button class="btn primary" type="submit" ${hasKey ? '' : 'disabled'}>搜索 TMDB</button>
      </form>
      ${hasKey ? '' : '<div class="hint warn" style="margin-bottom:10px">' + icon('warn', 14) + '<span>还没配置 TMDB API Key，只能手动记片名。</span></div>'}
      <div id="wish-results" class="candidates"><div class="view-sub">输入片名后回车搜索</div></div>
      <div class="section-title" style="margin-top:14px">手动添加（不联网）</div>
      <form class="search-line" data-submit="wish.manual">
        <input name="title" placeholder="片名" autocomplete="off" />
        <input name="year" placeholder="年份（可选）" inputmode="numeric" style="max-width:120px" />
        <button class="btn" type="submit">加入清单</button>
      </form>`,
    footer: '<span class="view-sub">从 TMDB 添加时会顺带缓存海报；没有网络也能手动记片名，之后再补全</span>',
  });
}

async function addByTmdb(tmdbId) {  try {
    const result = await api.addToWatchlist({ tmdbId });
    hideModal();
    toast(result.existed ? '这部电影已经清单里了' : `已加入：${result.item.title}`, result.existed ? '' : 'ok');
    await loadWatchlist();
  } catch (err) {
    toast(`加入失败：${err.message}`, 'err', 6000);
  }
}

registerActions({
  'wish.add': () => openAddDialog(),
  'wish.filter': (element) => {
    filter = element.dataset.key ?? 'all';
    renderBody();
  },
  'wish.search': async (form) => {
    const input = form.querySelector('input[name="q"]');
    const query = input?.value.trim();
    if (!query) return;
    const box = document.getElementById('wish-results');
    if (box) box.innerHTML = '<div class="view-sub">搜索中…</div>';
    try {
      const year = Number(query.match(/\b(19|20)\d{2}\b/)?.[0]) || undefined;
      const result = await api.tmdbSearch(query, year);
      if (box) box.innerHTML = candidatesHtml(result.results);
    } catch (err) {
      if (box) box.innerHTML = `<div class="view-sub" style="color:var(--err)">${esc(err.message)}</div>`;
    }
  },
  'wish.pick': async (element) => {
    const tmdbId = Number(element.dataset.tmdb);
    if (!tmdbId) return;
    element.disabled = true;
    element.innerHTML = `${element.innerHTML}<span class="c-score">加入中…</span>`;
    await addByTmdb(tmdbId);
  },
  'wish.manual': async (form) => {
    const title = form.querySelector('input[name="title"]')?.value.trim();
    const year = form.querySelector('input[name="year"]')?.value.trim();
    if (!title) {
      toast('请填片名', 'err');
      return;
    }
    try {
      const result = await api.addToWatchlist({ title, year: Number(year) || null });
      hideModal();
      toast(result.existed ? '这部电影已经清单里了' : `已加入：${result.item.title}`, result.existed ? '' : 'ok');
      await loadWatchlist();
    } catch (err) {
      toast(`加入失败：${err.message}`, 'err', 6000);
    }
  },
  'wish.status': async (element) => {
    const id = element.dataset.id;
    const status = element.dataset.status;
    try {
      const result = await api.patchWatchlist(id, { status });
      items = items.map((item) => (item.id === id ? result.item : item));
      renderBody();
      toast(`已标记为「${STATUS_LABEL[status] ?? status}」`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  'wish.refresh': async (element) => {
    const id = element.dataset.id;
    element.disabled = true;
    toast('正在用片名搜索 TMDB…');
    try {
      const result = await api.refreshWatchlist(id);
      if (result.needPick) {
        // 自动匹配没把握：把候选交给用户挑
        openPickDialog(id, result.candidates ?? [], result.reason);
        element.disabled = false;
        return;
      }
      await loadWatchlist();
      toast(`已补全：${result.item.title}`, 'ok');
    } catch (err) {
      element.disabled = false;
      toast(`补全失败：${err.message}`, 'err', 6000);
    }
  },
  'wish.link': async (element) => {
    const tmdbId = Number(element.dataset.tmdb);
    const id = pickTargetId;
    if (!tmdbId || !id) return;
    element.disabled = true;
    try {
      const result = await api.linkWatchlist(id, tmdbId);
      hideModal();
      await loadWatchlist();
      toast(`已关联：${result.item.title}`, 'ok');
    } catch (err) {
      element.disabled = false;
      toast(`关联失败：${err.message}`, 'err', 6000);
    }
  },
  'wish.remove': async (element) => {
    const item = items.find((entry) => entry.id === element.dataset.id);
    if (!item) return;
    if (!window.confirm(`从想看清单里移除「${item.title}」？`)) return;
    try {
      await api.deleteFromWatchlist(item.id);
      items = items.filter((entry) => entry.id !== item.id);
      renderBody();
      await runtime.refreshHealth();
      toast('已移除', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  },
});
