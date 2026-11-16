/**
 * 清单条目的详情抽屉（本地没有文件的那种）。
 *
 * 与本地影片的详情页共用一个 #drawer 容器，但不复用 detail.js：
 * 那边依赖 probe / path / 播放器等只有本地文件才有的字段。
 */
import { api } from '../api.js';
import { registerActions } from '../state.js';
import { esc, fmtDate, icon, toast } from '../util.js';

const drawer = document.getElementById('drawer');
let current = null;
let onChange = null;
let lastFocus = null;

function badgeList(item) {
  const badges = [];
  if (item.year) badges.push(`<span class="badge accent">${item.year}</span>`);
  if (item.runtimeMin) badges.push(`<span class="badge">${item.runtimeMin} 分钟</span>`);
  if (item.voteAverage) badges.push(`<span class="badge">★ ${Number(item.voteAverage).toFixed(1)}</span>`);
  badges.push(`<span class="badge ${item.status === 'watched' ? 'ok' : 'accent'}">${item.status === 'watched' ? '已看' : '想看'}</span>`);
  if (item.ownedBy?.length) badges.push('<span class="badge ok">已在库中</span>');
  if (!item.tmdbId) badges.push('<span class="badge err">未关联 TMDB</span>');
  return badges.join('');
}

function posterBlock(item) {
  const fallback = `<div class="poster-fallback"${item.posterUrl ? ' hidden' : ''}>
      <span class="pf-mark">NO ART</span>
      <span class="pf-glyph">${icon('film', 22)}</span>
      <span class="pf-title">${esc(item.title)}</span>
      ${item.year ? `<span class="pf-year">${item.year}</span>` : ''}
    </div>`;
  if (!item.posterUrl) return `<div class="poster">${fallback}</div>`;
  return `<div class="poster"><img src="${item.posterUrl}" alt="" data-drawer-poster />${fallback}</div>`;
}

/** 图片加载成功后淡入；失败则显示占位。 */
function bindPoster() {
  const img = drawer?.querySelector('[data-drawer-poster]');
  if (!img) return;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    img.remove();
    const fallback = drawer.querySelector('.poster .poster-fallback');
    if (fallback) fallback.hidden = false;
  });
}

function drawerHtml(item) {
  const otherStatus = item.status === 'watched' ? 'wish' : 'watched';
  const otherLabel = otherStatus === 'watched' ? '移入已看电影' : '移回想看';
  const genres = (item.genres ?? []).map((name) => `<span class="badge">${esc(name)}</span>`).join('');
  return `
    <button class="drawer-close" data-act="wish-detail.close" title="关闭">✕</button>
    <div class="drawer-head">
      ${posterBlock(item)}
      <div class="head-info">
        <h2>${esc(item.title)}</h2>
        ${item.originalTitle && item.originalTitle !== item.title ? `<div class="view-sub">${esc(item.originalTitle)}</div>` : ''}
        <div class="badges">${badgeList(item)}${genres}</div>
      </div>
    </div>
    <div class="drawer-body">
      <div class="drawer-actions">
        <button class="btn primary" data-act="wish-detail.status" data-status="${otherStatus}">${icon('check', 14)}${otherLabel}</button>
        ${item.tmdbId ? `<a class="btn" href="https://www.themoviedb.org/movie/${item.tmdbId}" target="_blank" rel="noreferrer">${icon('link', 14)}TMDB 页面</a>` : `<button class="btn" data-act="wish-detail.refresh">${icon('refresh', 14)}用片名补全</button>`}
        ${item.ownedBy?.length ? `<button class="btn" data-act="wish-detail.open-local" data-movie="${esc(item.ownedBy[0].id)}">${icon('library', 14)}去已有电影看</button>` : ''}
        <button class="btn danger" data-act="wish-detail.remove">${icon('trash', 14)}从清单删除</button>
      </div>

      ${item.overview ? `<div class="section"><h3 class="section-title">简介</h3><p class="overview">${esc(item.overview)}</p></div>` : ''}

      <div class="section">
        <h3 class="section-title">元数据</h3>
        <dl class="kv">
          <dt>原本片名</dt><dd>${esc(item.originalTitle ?? '—')}</dd>
          <dt>年份 / 片长</dt><dd>${item.year ?? '—'}${item.runtimeMin ? ` · ${item.runtimeMin} 分钟` : ''}</dd>
          <dt>评分</dt><dd>${item.voteAverage ? `★ ${Number(item.voteAverage).toFixed(1)} / 10` : '—'}</dd>
          <dt>类型</dt><dd>${esc((item.genres ?? []).join('、') || '—')}</dd>
          ${item.directors?.length ? `<dt>导演</dt><dd>${esc(item.directors.join('、'))}</dd>` : ''}
          <dt>TMDB</dt><dd>${item.tmdbId ? `<a href="https://www.themoviedb.org/movie/${item.tmdbId}" target="_blank" rel="noreferrer" style="color:var(--accent)">${item.tmdbId}</a>` : '未关联'}</dd>
          <dt>观看状态</dt><dd>${item.status === 'watched' ? `<span style="color:var(--ok)">已看</span> · ${fmtDate(item.watchedAt)}` : `<span style="color:var(--accent)">想看</span> · ${fmtDate(item.wishAt)}`}</dd>
          <dt>来源</dt><dd>清单（本地没有文件）${item.fetchedAt ? ` · 元数据缓存于 ${fmtDate(item.fetchedAt)}` : ' · 手动添加'}</dd>
          ${item.ownedBy?.length ? `<dt>本地文件</dt><dd><span style="color:var(--ok)">已有 ${item.ownedBy.length} 份</span></dd>` : ''}
        </dl>
      </div>

      <div class="section">
        <h3 class="section-title">备注</h3>
        <textarea class="notes" id="wish-note" placeholder="为什么想看 / 在哪看的…">${esc(item.note ?? '')}</textarea>
        <div style="margin-top:8px">
          <button class="btn sm" data-act="wish-detail.save-note">${icon('save', 13)}保存备注</button>
        </div>
      </div>
    </div>`;
}

function close() {
  if (!drawer) return;
  drawer.hidden = true;
  drawer.innerHTML = '';
  current = null;
  onChange = null;
  lastFocus?.focus?.();
}

/** @param {object} item /api/collection 返回的条目 @param {{onChange?: Function}} [options] */
export function openWatchDetail(item, options = {}) {
  if (!drawer) return;
  current = item;
  onChange = options.onChange ?? null;
  lastFocus = document.activeElement;
  drawer.hidden = false;
  drawer.innerHTML = drawerHtml(item);
  const scroller = drawer.querySelector('.drawer-body');
  if (scroller) scroller.scrollTop = 0;
  bindPoster();
}

function rerender(next) {
  current = next;
  // 滚动容器是 .drawer-body
  const scroller = drawer.querySelector('.drawer-body');
  const scroll = scroller ? scroller.scrollTop : 0;
  drawer.innerHTML = drawerHtml(next);
  const nextScroller = drawer.querySelector('.drawer-body');
  if (nextScroller) nextScroller.scrollTop = scroll;
  bindPoster();
}

registerActions({
  'wish-detail.close': () => close(),
  'wish-detail.status': async (element) => {
    if (!current) return;
    const status = element.dataset.status;
    const result = await api.patchWatchlist(current.id, { status });
    // 状态变了，这条不再属于当前页面
    close();
    await onChange?.();
    toast(status === 'watched' ? '已移到「已看电影」' : '已移回「想看」', 'ok');
    return result;
  },
  'wish-detail.refresh': async () => {
    if (!current) return;
    toast('正在用片名搜索 TMDB…');
    try {
      const result = await api.refreshWatchlist(current.id);
      if (result.needPick) {
        toast(`自动匹配没把握：${result.reason ?? '需要手动选择'}（回到列表点「补全」挑选）`, 'err', 6000);
        return;
      }
      rerender({ ...current, ...result.item, posterUrl: result.item.tmdbId ? api.watchlistPosterUrl(result.item.id) : null, ownedBy: current.ownedBy ?? [] });
      await onChange?.();
      toast(`已补全：${result.item.title}`, 'ok');
    } catch (err) {
      toast(`补全失败：${err.message}`, 'err', 6000);
    }
  },
  'wish-detail.open-local': (element) => {
    close();
    const movieId = element.dataset.movie;
    if (movieId) import('./detail.js').then((module) => module.openDetail(movieId));
  },
  'wish-detail.remove': async () => {
    if (!current) return;
    if (!window.confirm(`从清单里移除「${current.title}」？\n（本地文件不受影响）`)) return;
    await api.deleteFromWatchlist(current.id);
    close();
    await onChange?.();
    toast('已移除', 'ok');
  },
  'wish-detail.save-note': async () => {
    if (!current) return;
    const value = document.getElementById('wish-note')?.value ?? '';
    const result = await api.patchWatchlist(current.id, { note: value });
    current = { ...current, note: result.item.note };
    toast('备注已保存', 'ok');
  },
});
