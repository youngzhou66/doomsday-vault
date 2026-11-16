/**
 * 观看状态视图：想看 / 已看电影。
 *
 * 这两个页面是「状态维度」的汇总，同时包含两种来源：
 *   - library   本地有文件，在详情页标了想看/已看（同时仍在「已有电影」里）
 *   - watchlist 本地没有文件，直接从 TMDB 加进清单的
 *
 * 「已有电影」是「来源维度」（本地有没有文件），所以同一部片子会同时出现在两个页面，
 * 这是设计如此，不是重复数据。
 */
import { api } from '../api.js';
import { hideModal, showModal } from '../modal.js';
import { registerActions, runtime, state } from '../state.js';
import { esc, fmtBytes, icon, toast } from '../util.js';

const PAGES = {
  wish: {
    title: '想看',
    hint: '汇总所有「想看」的片子：本地已有的（在「已有电影」详情页点「想看」）+ 从 TMDB 加进清单的。',
    emptyTitle: '还没有想看标记',
    emptyHint: '在「已有电影」的详情页点「想看」，或者点右上角从 TMDB 添加一部。',
    addTitle: '添加想看的电影',
    otherStatus: 'watched',
    toggleLabel: '已看',
    toggleTitle: '看过了，移到「已看电影」',
  },
  watched: {
    title: '已看电影',
    hint: '汇总所有「看过」的片子：本地已看的（同时仍在「已有电影」里）+ 看过但本地没留、从 TMDB 加进清单的。',
    emptyTitle: '还没有已看标记',
    emptyHint: '在「已有电影」的详情页点「已看」，或者点右上角补一部看过但本地没留的片子。',
    addTitle: '添加已看的电影',
    otherStatus: 'wish',
    toggleLabel: '改回想看',
    toggleTitle: '其实还没看，移回「想看」',
  },
};

let page = 'wish';
let items = [];
let pickTargetId = null;

function config() {
  return PAGES[page];
}

function posterHtml(item) {
  const fallback = `
    <span class="pf-mark">NO ART</span>
    <span class="pf-glyph">${icon('film', 22)}</span>
    <span class="pf-title">${esc(item.title)}</span>
    ${item.year ? `<span class="pf-year">${item.year}</span>` : ''}`;
  if (!item.posterUrl) return `<div class="poster"><div class="poster-fallback">${fallback}</div></div>`;
  return `<div class="poster">
    <img src="${item.posterUrl}" alt="" loading="lazy" data-watch-poster />
    <div class="poster-fallback" hidden>${fallback}</div>
  </div>`;
}

function cardHtml(item) {
  const cfg = config();
  const meta = [
    item.year ?? '—',
    item.runtimeMin ? `${item.runtimeMin} 分钟` : null,
    item.voteAverage ? `★ ${Number(item.voteAverage).toFixed(1)}` : null,
    item.hasFile && item.resolution ? item.resolution : null,
    item.hasFile && item.size ? fmtBytes(item.size) : null,
  ].filter(Boolean).join(' · ');

  const badges = [
    item.hasFile ? '<span class="badge ok">本地文件</span>' : '<span class="badge">清单</span>',
    `<span class="badge accent">${item.status === 'watched' ? '已看' : '想看'}</span>`,
    item.tmdbId ? `<span class="badge">TMDB ${item.tmdbId}</span>` : '<span class="badge err">未关联 TMDB</span>',
  ].join('');

  const actions = item.source === 'library'
    ? `<button class="btn sm" data-act="collection.toggle" data-id="${esc(item.id)}" data-source="library" data-status="${cfg.otherStatus}"
         title="${esc(cfg.toggleTitle)}">${icon('check', 12)}${esc(cfg.toggleLabel)}</button>
       <button class="btn sm ghost" data-act="collection.open" data-id="${esc(item.id)}" title="打开详情">${icon('reveal', 12)}详情</button>`
    : `<button class="btn sm" data-act="collection.toggle" data-id="${esc(item.id)}" data-source="watchlist" data-status="${cfg.otherStatus}"
         title="${esc(cfg.toggleTitle)}">${icon('check', 12)}${esc(cfg.toggleLabel)}</button>
       ${item.tmdbId ? '' : `<button class="btn sm" data-act="wish.refresh" data-id="${esc(item.id)}" title="用片名搜一次 TMDB，补全元数据">${icon('refresh', 12)}补全</button>`}
       <button class="btn sm ghost" data-act="wish.remove" data-id="${esc(item.id)}" title="从清单删除">${icon('trash', 12)}</button>`;

  return `
    <article class="panel wish-card" data-id="${esc(item.id)}" data-source="${item.source}">
      ${posterHtml(item)}
      <div class="wish-body">
        <h4 class="wish-title" title="${esc(item.title)}">${esc(item.title)}</h4>
        <div class="wish-meta">${esc(meta)}</div>
        <div class="wish-badges">${badges}</div>
        <div class="wish-actions">${actions}</div>
        ${item.note ? `<div class="wish-note">${esc(item.note)}</div>` : ''}
      </div>
    </article>`;
}

function bodyHtml() {
  const cfg = config();
  if (!items.length) {
    return `<div class="empty"><h3>${esc(cfg.emptyTitle)}</h3>
      <p>${esc(cfg.emptyHint)}</p>
      <button class="btn primary" data-act="wish.add">${icon('plus', 14)}${esc(cfg.addTitle)}</button></div>`;
  }
  return `<div class="wish-grid">${items.map(cardHtml).join('')}</div>`;
}

function renderBody() {
  const body = document.getElementById('wish-body');
  if (!body) return;
  body.innerHTML = bodyHtml();
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
    const local = items.filter((item) => item.hasFile).length;
    countNode.textContent = `共 ${items.length} 部 · 本地 ${local} · 清单 ${items.length - local}`;
  }
}

export function renderCollection(root, options = {}) {
  page = options.status === 'watched' ? 'watched' : 'wish';
  const cfg = config();
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">${esc(cfg.title)}</h1>
        <div class="view-sub" id="wish-count">读取中…</div>
      </div>
      <div class="spacer"></div>
      <button class="btn primary" data-act="wish.add">${icon('plus', 13)}从 TMDB 添加</button>
    </div>
    <div class="hint" style="margin-bottom:14px">${icon('info', 14)}
      <span>${esc(cfg.hint)}</span>
    </div>
    <div id="wish-body"><div class="empty"><h3>读取中…</h3></div></div>`;
  loadCollection();
}

async function loadCollection() {
  try {
    const result = await api.collection(config().status === 'watched' ? 'watched' : 'wish');
    items = result.items ?? [];
    renderBody();
    await runtime.refreshHealth();
  } catch (err) {
    const body = document.getElementById('wish-body');
    if (body) body.innerHTML = `<div class="empty"><h3>读取失败</h3><p>${esc(err.message)}</p></div>`;
  }
}

/* ── 添加对话框（只往清单里加，本地影片用详情页标记） ──── */
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
  const cfg = config();
  const hasKey = state.health?.tmdb?.configured !== false;
  showModal({
    title: cfg.addTitle,
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
        <button class="btn" type="submit">加入${esc(cfg.title)}</button>
      </form>`,
    footer: '<span class="view-sub">从 TMDB 添加时会顺带缓存海报；本地已有的片子请在「已有电影」详情页标记状态，不在这里重复添加</span>',
  });
}

async function addByTmdb(tmdbId) {
  const status = config().status;
  try {
    const result = await api.addToWatchlist({ tmdbId, status });
    hideModal();
    toast(result.existed ? '这部电影已经在清单里了' : `已加入${config().title}：${result.item.title}`, result.existed ? '' : 'ok');
    await loadCollection();
  } catch (err) {
    toast(`加入失败：${err.message}`, 'err', 6000);
  }
}

registerActions({
  'wish.add': () => openAddDialog(),
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
      const result = await api.addToWatchlist({ title, year: Number(year) || null, status: config().status });
      hideModal();
      toast(result.existed ? '这部电影已经在清单里了' : `已加入：${result.item.title}`, result.existed ? '' : 'ok');
      await loadCollection();
    } catch (err) {
      toast(`加入失败：${err.message}`, 'err', 6000);
    }
  },
  /** 本地影片改观看状态；清单条目只需改 status */
  'collection.toggle': async (element) => {
    const id = element.dataset.id;
    const source = element.dataset.source;
    const status = element.dataset.status;
    element.disabled = true;
    try {
      if (source === 'library') {
        await api.patchMovie(id, status === 'watched' ? { watched: true } : { wish: true });
      } else {
        await api.patchWatchlist(id, { status });
      }
      items = items.filter((item) => !(item.id === id && item.source === source));
      renderBody();
      await runtime.refreshHealth();
      toast(status === 'watched' ? '已标记为已看' : '已移回想看', 'ok');
    } catch (err) {
      element.disabled = false;
      toast(err.message, 'err');
    }
  },
  'collection.open': (element) => runtime.openDetail(element.dataset.id),
  'wish.refresh': async (element) => {
    const id = element.dataset.id;
    element.disabled = true;
    toast('正在用片名搜索 TMDB…');
    try {
      const result = await api.refreshWatchlist(id);
      if (result.needPick) {
        openPickDialog(id, result.candidates ?? [], result.reason);
        element.disabled = false;
        return;
      }
      await loadCollection();
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
      await loadCollection();
      toast(`已关联：${result.item.title}`, 'ok');
    } catch (err) {
      element.disabled = false;
      toast(`关联失败：${err.message}`, 'err', 6000);
    }
  },
  'wish.remove': async (element) => {
    const item = items.find((entry) => entry.id === element.dataset.id && entry.source === 'watchlist');
    if (!item) return;
    if (!window.confirm(`从清单里移除「${item.title}」？\n（本地文件不受影响）`)) return;
    try {
      await api.deleteFromWatchlist(item.id);
      items = items.filter((entry) => !(entry.id === item.id && entry.source === 'watchlist'));
      renderBody();
      await runtime.refreshHealth();
      toast('已移除', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  },
});
