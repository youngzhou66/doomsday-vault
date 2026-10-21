/** TMDB 手动匹配对话框（详情页与待确认队列共用）。 */
import { api } from './api.js';
import { hideModal, showModal } from './modal.js';
import { registerActions, runtime, state } from './state.js';
import { esc, icon, toast } from './util.js';

let onPicked = null;

function candidatesHtml(result) {
  if (!result.results?.length) return '<div class="view-sub">没有搜到候选，换个关键词试试</div>';
  return result.results.map((candidate) => `
    <button class="candidate" data-act="match.pick" data-tmdb="${candidate.id}">
      <span class="c-poster">${candidate.posterPath ? `<img src="${api.tmdbImageUrl(candidate.posterPath, 'w92')}" alt="" loading="lazy" />` : ''}</span>
      <span>
        <span class="c-title">${esc(candidate.title)}</span>
        <span class="c-sub">${candidate.year ?? '—'}${candidate.originalTitle && candidate.originalTitle !== candidate.title ? ` · ${esc(candidate.originalTitle)}` : ''}</span>
      </span>
      <span class="c-score">${Math.round((candidate.score ?? 0) * 100)}%</span>
    </button>`).join('');
}

/**
 * 打开匹配对话框。
 * @param {object} movie 电影记录（需含 parsed）
 * @param {() => void} [callback] 匹配成功后的回调
 */
export function openMatchDialog(movie, callback) {
  onPicked = callback ?? null;
  const query = movie.parsed?.year ? `${movie.parsed.title} ${movie.parsed.year}` : movie.parsed?.title ?? '';
  showModal({
    title: '手动匹配 TMDB',
    body: `
      <form class="search-line" data-submit="match.search">
        <input name="q" value="${esc(query)}" placeholder="片名，或 片名 年份" autocomplete="off" />
        <button class="btn primary" type="submit">搜索</button>
      </form>
      <div class="hint" style="margin-bottom:10px">${icon('info', 14)}
        <span>当前解析：<span class="mono">${esc(movie.parsed?.title ?? '—')}${movie.parsed?.year ? ` (${movie.parsed.year})` : ''}</span></span>
      </div>
      <div id="match-results" class="candidates"><div class="view-sub">输入关键词后回车搜索</div></div>
    `,
    footer: '<span class="view-sub">选中后会写入元数据并缓存海报，之后可离线浏览</span>',
  });
}

registerActions({
  'match.search': async (form) => {
    const query = form.querySelector('input[name="q"]').value.trim();
    if (!query) return;
    const box = document.getElementById('match-results');
    if (box) box.innerHTML = '<div class="view-sub">搜索中…</div>';
    const year = Number(query.match(/\b(19|20)\d{2}\b/)?.[0]) || undefined;
    const result = await api.tmdbSearch(query, year);
    if (box) box.innerHTML = candidatesHtml(result);
  },
  'match.pick': async (element) => {
    const tmdbId = Number(element.dataset.tmdb);
    const movieId = state.matchTarget?.id;
    if (!movieId) return;
    hideModal();
    toast('正在写入元数据…');
    const result = await api.match(movieId, tmdbId);
    toast(`已匹配：${result.movie.title} (${result.movie.year ?? '—'})`, 'ok');
    await runtime.refreshHealth();
    await onPicked?.();
  },
});
