/** 待确认队列：解析结果复核 + 单条/批量刮削。 */
import { api } from '../api.js';
import { openMatchDialog } from '../match.js';
import { registerActions, runtime, state } from '../state.js';
import { esc, fmtBytes, icon, toast } from '../util.js';

function itemHtml(movie) {
  return `
    <div class="panel queue-item" data-queue-id="${esc(movie.id)}">
      <div class="mini-poster">${movie.hasPoster
        ? `<img src="/api/movies/${encodeURIComponent(movie.id)}/poster" alt="" loading="lazy" />`
        : 'NO ART'}</div>
      <div class="qi-main">
        <h4>
          ${esc(movie.title)}
          ${movie.year ? `<span class="badge accent">${movie.year}</span>` : '<span class="badge err">无年份</span>'}
          ${movie.resolution ? `<span class="badge">${esc(movie.resolution)}</span>` : ''}
          ${movie.size ? `<span class="badge">${fmtBytes(movie.size)}</span>` : ''}
          ${movie.matchState === 'none' ? '<span class="badge err">上次未匹配</span>' : ''}
        </h4>
        <div class="qi-path">${esc(movie.path)}</div>
        <div class="view-sub">搜索词：<span class="mono">${esc(movie.searchQuery ?? '')}</span>
          ${movie.matchError ? ` · <span style="color:var(--err)">${esc(movie.matchError)}</span>` : ''}</div>
        <div class="qi-actions">
          <button class="btn sm primary" data-act="queue.scrape" data-id="${esc(movie.id)}">${icon('refresh', 13)}刮削</button>
          <button class="btn sm" data-act="queue.match" data-id="${esc(movie.id)}">${icon('link', 13)}手动匹配</button>
          <button class="btn sm" data-act="queue.confirm" data-id="${esc(movie.id)}">${icon('check', 13)}确认解析</button>
          <button class="btn sm ghost" data-act="queue.ignore" data-id="${esc(movie.id)}">忽略</button>
          <button class="btn sm ghost" data-act="queue.open" data-id="${esc(movie.id)}">详情</button>
        </div>
      </div>
    </div>`;
}

export function renderQueue(root) {
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">待确认</h1>
        <div class="view-sub" id="queue-count">读取中…</div>
      </div>
      <div class="spacer"></div>
      <button class="btn" data-act="queue.refresh">${icon('refresh', 13)}刷新</button>
      <button class="btn primary" data-act="queue.scrape-all">${icon('film', 13)}全部刮削</button>
    </div>
    <div class="hint" style="margin-bottom:14px">${icon('info', 14)}
      <span>这里列出「文件名/目录名已解析、但尚未确认元数据」的影片。刮削失败或选错的会自动落到「未匹配」，可在库里重新设为待确认。</span>
    </div>
    <div id="queue-body" class="stack"><div class="empty"><h3>读取中…</h3></div></div>
  `;
  loadQueue();
}

async function loadQueue() {
  const body = document.getElementById('queue-body');
  const countNode = document.getElementById('queue-count');
  try {
    const result = await api.queue({ limit: state.queue.limit, offset: 0 });
    state.queue.items = result.items;
    state.queue.total = result.total;
    if (countNode) countNode.textContent = result.total ? `${result.total} 部等待确认` : '全部确认完毕';
    if (!body) return;
    if (!result.total) {
      body.innerHTML = `<div class="empty">
        <h3>没有待确认的影片</h3>
        <p>扫描新目录后，未匹配元数据的影片会出现在这里。也可以到库里把「未匹配」的条目重新设为待确认。</p>
        <button class="btn" data-act="app.scan">${icon('refresh', 13)}扫描目录</button>
      </div>`;
      return;
    }
    body.innerHTML = result.items.map(itemHtml).join('');
    if (result.total > result.items.length) {
      body.insertAdjacentHTML('beforeend', `
        <div style="display:flex;justify-content:center">
          <button class="btn" data-act="queue.more">加载更多（${result.items.length}/${result.total}）</button>
        </div>`);
    }
  } catch (err) {
    if (body) body.innerHTML = `<div class="empty"><h3>加载失败</h3><p>${esc(err.message)}</p></div>`;
  }
}

function find(id) {
  return state.queue.items.find((movie) => movie.id === id);
}

registerActions({
  'queue.refresh': () => loadQueue(),
  'queue.more': async () => {
    const more = await api.queue({ limit: 40, offset: state.queue.items.length });
    state.queue.items = [...state.queue.items, ...more.items];
    const body = document.getElementById('queue-body');
    if (body) body.innerHTML = state.queue.items.map(itemHtml).join('');
  },
  'queue.scrape': async (element) => {
    const movie = find(element.dataset.id);
    if (!movie) return;
    element.textContent = '刮削中…';
    const result = await api.scrape(movie.id);
    if (result.matched) toast(`已匹配：${result.movie.tmdb?.title ?? movie.title}`, 'ok');
    else toast(`未匹配：${result.reason ?? '无候选'}`, 'err', 4800);
    await runtime.refreshHealth();
    await loadQueue();
  },
  'queue.match': (element) => {
    const movie = find(element.dataset.id);
    if (!movie) return;
    state.matchTarget = { id: movie.id };
    openMatchDialog(movie, () => {
      loadQueue();
      runtime.refreshHealth();
    });
  },
  'queue.confirm': async (element) => {
    await api.patchMovie(element.dataset.id, { matchState: 'confirmed' });
    toast('已确认', 'ok');
    await runtime.refreshHealth();
    await loadQueue();
  },
  'queue.ignore': async (element) => {
    await api.patchMovie(element.dataset.id, { matchState: 'none' });
    toast('已移出队列（标记为未匹配）', 'ok');
    await runtime.refreshHealth();
    await loadQueue();
  },
  'queue.open': (element) => runtime.openDetail(element.dataset.id),
  'queue.scrape-all': async () => {
    if (!state.health?.tmdb?.configured) throw new Error('还未配置 TMDB API Key，请到「设置 → 元数据」填写');
    const { id } = await api.scrapeQueue({});
    toast('开始批量刮削…');
    runtime.trackJob(id, {
      onDone: async (job) => {
        const result = job.result ?? {};
        toast(`刮削完成：成功 ${result.matched ?? 0}，未匹配 ${result.failed ?? 0}`, 'ok', 5000);
        await runtime.refreshHealth();
        await loadQueue();
      },
    });
  },
});
