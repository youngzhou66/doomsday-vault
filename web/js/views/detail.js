/** 详情抽屉：元数据、技术参数、标签/合集、播放与刮削操作。 */
import { api } from '../api.js';
import { openMatchDialog } from '../match.js';
import { registerActions, runtime, state } from '../state.js';
import {
  copyText, esc, fmtBytes, fmtDate, fmtDuration, icon, posterMarkup, relTime, shortPath, stateBadge, toast,
} from '../util.js';

const drawer = document.getElementById('drawer');

function badgeList(movie) {
  const badges = [];
  if (movie.year) badges.push(`<span class="badge accent">${movie.year}</span>`);
  if (movie.durationSec) badges.push(`<span class="badge">${fmtDuration(movie.durationSec)}</span>`);
  if (movie.resolution) badges.push(`<span class="badge">${esc(movie.resolution)}</span>`);
  if (movie.hdr) badges.push(`<span class="badge hdr">${esc(movie.hdr)}</span>`);
  if (movie.vote) badges.push(`<span class="badge">★ ${Number(movie.vote).toFixed(1)}</span>`);
  if (movie.edition) badges.push(`<span class="badge">${esc(movie.edition)}</span>`);
  badges.push(stateBadge(movie));
  if (movie.watched) badges.push('<span class="badge ok">✓ 已看</span>');
  if (movie.missing) badges.push('<span class="badge err">文件缺失</span>');
  return badges.join('');
}

function tracksHtml(tracks, kind) {
  if (!tracks?.length) return '<p class="view-sub" style="margin:0">无</p>';
  return `<div class="tracklist">${tracks.map((track, index) => `
    <div class="track">
      <span class="idx">${index + 1}</span>
      <span>${esc(track.codec ?? '未知')}</span>
      ${kind === 'audio' ? `<span class="mono">${track.channels ? `${track.channels} 声道` : ''}${track.bitrate ? ` · ${Math.round(track.bitrate / 1000)} kbps` : ''}</span>` : ''}
      <span class="flag">${esc([track.language, track.title, track.forced ? '强制' : '', track.default ? '默认' : ''].filter(Boolean).join(' · ') || '—')}</span>
    </div>`).join('')}</div>`;
}

function customSourceLabel(source) {
  if (source === 'shell' || source === 'quicklook') return '系统缩略图';
  if (source === 'ffmpeg') return 'ffmpeg 截帧';
  if (source === 'browser') return '浏览器截帧';
  return '手动';
}

function probeHtml(movie) {
  const probe = movie.probe;
  if (!probe) {
    return `<div class="hint warn">
      ${icon('warn', 14)}
      <span>还没有技术参数。${movie.probeError ? `上次探测失败：${esc(movie.probeError)}` : '点下方「重新探测」用 ffprobe 提取时长/分辨率/音轨/字幕。'}</span>
    </div>`;
  }
  const video = probe.video ?? {};
  const rows = [
    ['容器', probe.container ?? '—'],
    ['时长', fmtDuration(probe.durationSec)],
    ['码率', probe.bitrate ? `${Math.round(probe.bitrate / 1000)} kbps` : '—'],
    ['分辨率', video.width && video.height ? `${video.width}×${video.height}` : '—'],
    ['帧率', video.fps ? `${video.fps} fps` : '—'],
    ['视频编码', [video.codec, video.profile, video.bitDepth ? `${video.bitDepth}bit` : ''].filter(Boolean).join(' ') || '—'],
    ['动态范围', video.hdr ?? 'SDR'],
    ['章节', probe.chapterCount ? `${probe.chapterCount} 个` : '—'],
  ];
  return `<dl class="kv" style="margin-bottom:10px">${rows.map(([key, value]) => `<dt>${key}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
}

function tagsSection(movie) {
  const tags = movie.tags ?? [];
  return `
    <div class="tag-editor">
      ${tags.map((tag) => `<span class="tag-chip">${esc(tag)}<button data-act="detail.remove-tag" data-tag="${esc(tag)}" title="移除">×</button></span>`).join('')}
      <form data-submit="detail.add-tag" style="display:inline-flex">
        <input class="tag-input" name="tag" placeholder="+ 标签" autocomplete="off" />
      </form>
    </div>`;
}

function collectionsSection(movie) {
  const items = movie.collections ?? [];
  return `
    <div class="tag-editor">
      ${items.map((name) => `<span class="tag-chip">${esc(name)}<button data-act="detail.remove-collection" data-name="${esc(name)}" title="移除">×</button></span>`).join('')}
      <form data-submit="detail.add-collection" style="display:inline-flex">
        <input class="tag-input" name="name" placeholder="+ 合集" autocomplete="off" />
      </form>
    </div>`;
}

function fileSection(movie) {
  const mates = movie.folderMates ?? [];
  return `
    <div class="path-box">
      <span>${esc(movie.path)}</span>
      <button class="btn sm" data-act="detail.copy-path" title="复制路径">${icon('link', 13)}</button>
      <button class="btn sm" data-act="detail.reveal" title="在文件夹中显示">${icon('reveal', 13)}</button>
    </div>
    <dl class="kv" style="margin-top:10px">
      <dt>体积</dt><dd>${fmtBytes(movie.size)}</dd>
      <dt>修改时间</dt><dd>${fmtDate(new Date(movie.mtimeMs ?? 0).toISOString())}</dd>
      <dt>入库时间</dt><dd>${fmtDate(movie.addedAt)}</dd>
      <dt>最近见到</dt><dd>${relTime(movie.lastSeenAt)}</dd>
      <dt>播放次数</dt><dd>${movie.playCount ?? 0}${movie.resumeSec ? ` · 续播点 ${Math.floor(movie.resumeSec / 60)} 分` : ''}</dd>
      ${movie.hash?.quick ? `<dt>指纹</dt><dd class="mono">${esc(String(movie.hash.quick).slice(0, 20))}…</dd>` : ''}
    </dl>
    ${mates.length ? `<div class="section-title" style="margin-top:14px">同一目录下的其它文件</div>
      <div class="stack">${mates.map((mate) => `
        <button class="track" data-act="detail.open-mate" data-id="${esc(mate.id)}" style="cursor:pointer;text-align:left">
          <span class="idx">▸</span><span>${esc(mate.fileName)}</span>
          <span class="flag">${fmtBytes(mate.size)}</span>
        </button>`).join('')}</div>` : ''}
  `;
}

function drawerHtml(movie) {
  const overview = movie.tmdb?.overview || '';
  const original = movie.tmdb?.originalTitle && movie.tmdb.originalTitle !== movie.title
    ? `<div class="orig">${esc(movie.tmdb.originalTitle)}</div>` : '';
  const genres = (movie.genres ?? []).slice(0, 4).map((name) => `<span class="badge">${esc(name)}</span>`).join('');
  return `
    <button class="drawer-close" data-act="detail.close" title="关闭 (Esc)">✕</button>
    ${movie.hasBackdrop ? `<div class="drawer-backdrop"><img src="/api/movies/${encodeURIComponent(movie.id)}/poster?kind=backdrop" alt="" /></div>` : ''}
    <div class="drawer-head">
      <div class="poster">${posterMarkup(movie, { lazy: false })}</div>
      <div class="head-info">
        <h2>${esc(movie.title)}</h2>
        ${original}
        <div class="badges">${badgeList(movie)}${genres}</div>
      </div>
    </div>
    <div class="drawer-body">
      <div id="player-slot"></div>
      <div class="drawer-actions">
        <button class="btn primary" data-act="detail.play">${icon('play', 14)}本地播放器</button>
        <button class="btn" data-act="detail.browser">${icon('monitor', 14)}浏览器播放</button>
        <button class="btn ${movie.watched ? '' : 'primary'}" data-act="detail.toggle-watched" title="${movie.watched ? '改为未看' : '标记为已看'}">
          ${icon(movie.watched ? 'refresh' : 'check', 14)}${movie.watched ? '标记为未看' : '标记为已看'}
        </button>
        <button class="btn" data-act="detail.scrape">${icon('refresh', 14)}重新刮削</button>
        <button class="btn" data-act="detail.match">${icon('link', 14)}手动匹配</button>
        ${movie.matchState === 'pending' || movie.matchState === 'none'
          ? `<button class="btn" data-act="detail.confirm">${icon('check', 14)}确认</button>`
          : ''}
        <button class="btn" data-act="detail.probe">${icon('film', 14)}重新探测</button>
        ${movie.hasCustomPoster
          ? `<button class="btn" data-act="detail.capture">${icon('refresh', 14)}重新截取封面</button>
             <button class="btn ghost" data-act="detail.clear-capture">${icon('trash', 14)}取消自定义封面</button>`
          : `<button class="btn" data-act="detail.capture">${icon('film', 14)}截取封面</button>`}
      </div>

      ${overview ? `<div class="section"><h3 class="section-title">简介</h3><p class="overview">${esc(overview)}</p></div>` : ''}

      ${movie.tmdb?.tagline ? `<div class="section"><p class="overview" style="color:var(--muted);font-style:italic">“${esc(movie.tmdb.tagline)}”</p></div>` : ''}

      <div class="section">
        <h3 class="section-title">技术参数</h3>
        ${probeHtml(movie)}
      </div>

      ${movie.probe ? `
      <div class="section">
        <h3 class="section-title">音轨 ${movie.probe.audio?.length ? `(${movie.probe.audio.length})` : ''}</h3>
        ${tracksHtml(movie.probe.audio, 'audio')}
      </div>
      <div class="section">
        <h3 class="section-title">字幕 ${movie.probe.subtitles?.length ? `(${movie.probe.subtitles.length})` : ''}</h3>
        ${tracksHtml(movie.probe.subtitles, 'subtitle')}
      </div>` : ''}

      <div class="section">
        <h3 class="section-title">标签</h3>
        ${tagsSection(movie)}
      </div>

      <div class="section">
        <h3 class="section-title">合集</h3>
        ${collectionsSection(movie)}
      </div>

      <div class="section">
        <h3 class="section-title">备注</h3>
        <textarea class="notes" id="detail-notes" placeholder="私人笔记：观影感受、版本差异、字幕来源…">${esc(movie.notes ?? '')}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px">
          <button class="btn sm" data-act="detail.save-notes">${icon('save', 13)}保存备注</button>
        </div>
      </div>

      <div class="section">
        <h3 class="section-title">文件</h3>
        ${fileSection(movie)}
      </div>

      <div class="section">
        <h3 class="section-title">元数据</h3>
        <dl class="kv">
          <dt>片名解析</dt><dd>${esc(movie.parsed?.title ?? '—')} ${movie.parsed?.year ? `(${movie.parsed.year})` : ''}</dd>
          <dt>解析来源</dt><dd>${movie.parsed?.titleSource === 'folder' ? '目录名' : '文件名'}${movie.parsed?.group ? ` · ${esc(movie.parsed.group)}` : ''}</dd>
          <dt>TMDB</dt><dd>${movie.tmdb?.id ? `<a href="https://www.themoviedb.org/movie/${movie.tmdb.id}" target="_blank" rel="noreferrer" style="color:var(--accent)">${movie.tmdb.id}</a>${movie.tmdb.matchScore ? ` · 匹配度 ${Math.round(movie.tmdb.matchScore * 100)}%` : ''}` : '未匹配'}</dd>
          <dt>观看状态</dt><dd>${movie.watched
            ? `<span style="color:var(--ok)">已看</span> · ${fmtDate(movie.watchedAt)}`
            : '未看'}${movie.playCount ? ` · 播放 ${movie.playCount} 次` : ''}</dd>
          <dt>封面来源</dt><dd>${movie.customPoster
            ? `自定义截帧（${esc(customSourceLabel(movie.customPoster.source))}${movie.customPoster.width ? ` · ${movie.customPoster.width}×${movie.customPoster.height ?? '?'}` : ''}）`
            : movie.localArt?.poster
              ? `本地文件 <span class="mono">${esc(movie.localArt.poster)}</span>`
              : movie.tmdb?.posterPath ? 'TMDB 缓存图' : '<span style="color:var(--muted)">无（可截帧、放 poster.jpg 到目录，或配置 TMDB 后刮削）</span>'}</dd>
          ${movie.tmdb?.imdbId ? `<dt>IMDb</dt><dd class="mono">${esc(movie.tmdb.imdbId)}</dd>` : ''}
          ${movie.tmdb?.directors?.length ? `<dt>导演</dt><dd>${esc(movie.tmdb.directors.join('、'))}</dd>` : ''}
          ${movie.tmdb?.cast?.length ? `<dt>主演</dt><dd>${esc(movie.tmdb.cast.slice(0, 5).map((person) => person.name).join('、'))}</dd>` : ''}
          ${movie.tmdb?.fetchedAt ? `<dt>刮削时间</dt><dd>${relTime(movie.tmdb.fetchedAt)}</dd>` : ''}
          ${movie.matchError ? `<dt>匹配错误</dt><dd style="color:var(--err)">${esc(movie.matchError)}</dd>` : ''}
        </dl>
      </div>

      <div class="section" style="border-top:1px solid var(--line-soft);padding-top:14px">
        <button class="btn sm danger" data-act="detail.remove">${icon('trash', 13)}从库中移除（不删文件）</button>
      </div>
    </div>`;
}

export async function openDetail(id) {
  drawer.hidden = false;
  drawer.innerHTML = '<div class="empty" style="margin:20px"><h3>读取中…</h3></div>';
  try {
    const movie = await api.movie(id);
    state.currentMovie = movie;
    drawer.innerHTML = drawerHtml(movie);
    drawer.scrollTop = 0;
  } catch (err) {
    drawer.innerHTML = `<div class="empty" style="margin:20px"><h3>读取失败</h3><p>${esc(err.message)}</p>
      <button class="btn" data-act="detail.close">关闭</button></div>`;
    throw err;
  }
}

export function closeDetail() {
  drawer.hidden = true;
  drawer.innerHTML = '';
  state.currentMovie = null;
}

async function refresh() {
  if (state.currentMovie) await openDetail(state.currentMovie.id);
}

/* ── 浏览器截帧（服务端没有 ffmpeg / 系统缩略图时的兜底） ──── */
/**
 * 用 <video> + canvas 截一帧，回传 dataURL。
 * 能不能成功取决于浏览器能否解码这个容器/编码（MP4/H.264 一般可以）。
 */
async function captureInBrowser(movie, { percent = 20, width = 500 } = {}) {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.width = '320px';
  video.src = api.streamUrl(movie.id);
  document.body.appendChild(video);

  const waitFor = (event, message, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onFail = () => {
      cleanup();
      reject(new Error('浏览器无法解码这个文件'));
    };
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener(event, onDone);
      video.removeEventListener('error', onFail);
    }
    video.addEventListener(event, onDone, { once: true });
    video.addEventListener('error', onFail, { once: true });
  });

  try {
    await waitFor('loadedmetadata', '读取视频超时，浏览器可能不支持这个容器');
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
    const target = Math.min(Math.max((duration * percent) / 100, 1), Math.max(duration - 1, 1));

    const seeked = waitFor('seeked', '定位视频超时');
    video.currentTime = target;
    await seeked;

    const videoWidth = video.videoWidth || width;
    const videoHeight = video.videoHeight || Math.round(width * 1.5);
    const outWidth = Math.min(width, videoWidth);
    const outHeight = Math.round((outWidth * videoHeight) / videoWidth);

    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, outWidth, outHeight);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (!dataUrl.startsWith('data:image/')) throw new Error('截帧失败：画布为空');

    return await api.capturePoster(movie.id, { dataUrl });
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

/* ── 浏览器播放 ───────────────────────────────────────── */
function mountBrowserPlayer() {
  const movie = state.currentMovie;
  const slot = document.getElementById('player-slot');
  if (!movie || !slot) return;
  if (slot.dataset.open === '1') {
    slot.innerHTML = '';
    slot.dataset.open = '0';
    return;
  }
  slot.dataset.open = '1';
  slot.innerHTML = `
    <div class="player-wrap">
      <video id="browser-video" controls playsinline preload="metadata" src="${api.streamUrl(movie.id)}"></video>
    </div>
    <div class="hint" style="margin-bottom:12px">${icon('info', 14)}
      <span>浏览器只能播放 MP4/H.264 等受支持编码；MKV/HEVC/DTS 通常无法播放，请用「本地播放器」。进度会自动记录。</span>
    </div>`;
  const video = document.getElementById('browser-video');
  if (!video) return;
  video.addEventListener('loadedmetadata', () => {
    if (movie.resumeSec > 5 && movie.resumeSec < video.duration - 10) video.currentTime = movie.resumeSec;
  });
  let lastSaved = 0;
  const save = async () => {
    const position = Math.floor(video.currentTime || 0);
    if (!position || Math.abs(position - lastSaved) < 5) return;
    lastSaved = position;
    try {
      await api.patchMovie(movie.id, { resumeSec: position });
      state.currentMovie.resumeSec = position;
    } catch {
      // 进度保存失败不打扰用户
    }
  };
  video.addEventListener('timeupdate', () => {
    if (Math.floor(video.currentTime) % 15 === 0) save();
  });
  video.addEventListener('pause', save);
  video.addEventListener('error', () => {
    toast('浏览器无法解码这个文件，请用本地播放器', 'err', 5000);
  });
}

/* ── 动作 ─────────────────────────────────────────────── */
registerActions({
  'detail.close': () => runtime.closeDetail(),
  'detail.play': async () => {
    const movie = state.currentMovie;
    const result = await api.open(movie.id);
    if (result.ok) toast(`已调用 ${result.label}${result.command ? `：${shortPath(result.command, 60)}` : ''}`, 'ok', 4200);
    else toast(`播放失败：${result.error}`, 'err', 6000);
  },
  'detail.browser': () => mountBrowserPlayer(),
  'detail.reveal': async () => {
    const result = await api.reveal(state.currentMovie.id);
    if (!result.ok) throw new Error('无法打开文件管理器');
  },
  'detail.copy-path': async () => {
    const ok = await copyText(state.currentMovie.path);
    toast(ok ? '路径已复制' : '复制失败，请手动选择', ok ? 'ok' : 'err');
  },
  'detail.scrape': async () => {
    const result = await api.scrape(state.currentMovie.id, true);
    if (result.matched) {
      toast(`刮削成功：${result.movie.tmdb?.title ?? ''}（${Math.round((result.score ?? 0) * 100)}%）`, 'ok');
    } else {
      toast(`未匹配：${result.reason ?? '无候选'}`, 'err', 5000);
    }
    await refresh();
    await runtime.refreshHealth();
  },
  'detail.match': () => {
    state.matchTarget = { id: state.currentMovie.id };
    openMatchDialog(state.currentMovie, refresh);
  },
  'detail.capture': async () => {
    const movie = state.currentMovie;
    toast('正在截取封面…');
    let result = null;
    let serverError = null;
    try {
      // 服务端：系统缩略图 → ffmpeg
      result = await api.capturePoster(movie.id);
    } catch (err) {
      serverError = err;
    }

    if (!result) {
      // 服务端拿不到画面 → 用浏览器解码截帧（能播的格式就能截）
      try {
        toast('系统缩略图/ffmpeg 不可用，尝试浏览器截帧…');
        result = await captureInBrowser(movie);
      } catch (browserError) {
        const hint = state.health?.ffmpeg?.ok
          ? ''
          : '（本机未安装 FFmpeg，装好后 MKV/HEVC 也能截帧）';
        throw new Error(`${serverError?.message ?? '无法截取封面'}；浏览器也无法解码：${browserError.message}${hint}`);
      }
    }

    const source = result.customPoster?.source ?? 'manual';
    toast(`封面已更新（${customSourceLabel(source)}）`, 'ok', 4000);
    await refresh();
    await runtime.refreshHealth();
  },
  'detail.clear-capture': async () => {
    await api.clearPoster(state.currentMovie.id);
    toast('已取消自定义封面', 'ok');
    await refresh();
    await runtime.refreshHealth();
  },
  'detail.toggle-watched': async () => {
    const movie = state.currentMovie;
    const next = !movie.watched;
    const updated = await api.patchMovie(movie.id, { watched: next });
    state.currentMovie = updated;
    drawer.innerHTML = drawerHtml(updated);
    toast(next ? '已标记为已看' : '已改回未看', 'ok');
    await runtime.refreshHealth();
    runtime.reload();
  },
  'detail.confirm': async () => {
    await api.patchMovie(state.currentMovie.id, { matchState: 'confirmed' });
    toast('已确认匹配', 'ok');
    await refresh();
    await runtime.refreshHealth();
  },
  'detail.probe': async () => {
    const updated = await api.probe(state.currentMovie.id);
    state.currentMovie = updated;
    drawer.innerHTML = drawerHtml(updated);
    toast('探测完成', 'ok');
  },
  'detail.add-tag': async (form) => {
    const input = form.querySelector('input[name="tag"]');
    const tag = input.value.trim();
    if (!tag) return;
    const movie = state.currentMovie;
    const tags = [...new Set([...(movie.tags ?? []), tag])];
    const updated = await api.patchMovie(movie.id, { tags });
    state.currentMovie = updated;
    drawer.innerHTML = drawerHtml(updated);
    await runtime.refreshHealth();
  },
  'detail.remove-tag': async (element) => {
    const movie = state.currentMovie;
    const tags = (movie.tags ?? []).filter((tag) => tag !== element.dataset.tag);
    const updated = await api.patchMovie(movie.id, { tags });
    state.currentMovie = updated;
    drawer.innerHTML = drawerHtml(updated);
    await runtime.refreshHealth();
  },
  'detail.add-collection': async (form) => {
    const input = form.querySelector('input[name="name"]');
    const name = input.value.trim();
    if (!name) return;
    const movie = state.currentMovie;
    const collections = [...new Set([...(movie.collections ?? []), name])];
    const updated = await api.patchMovie(movie.id, { collections });
    state.currentMovie = updated;
    drawer.innerHTML = drawerHtml(updated);
    await runtime.refreshHealth();
  },
  'detail.remove-collection': async (element) => {
    const movie = state.currentMovie;
    const collections = (movie.collections ?? []).filter((name) => name !== element.dataset.name);
    const updated = await api.patchMovie(movie.id, { collections });
    state.currentMovie = updated;
    drawer.innerHTML = drawerHtml(updated);
    await runtime.refreshHealth();
  },
  'detail.save-notes': async () => {
    const area = document.getElementById('detail-notes');
    const updated = await api.patchMovie(state.currentMovie.id, { notes: area.value });
    state.currentMovie.notes = updated.notes;
    toast('备注已保存', 'ok');
  },
  'detail.open-mate': async (element) => {
    await openDetail(element.dataset.id);
  },
  'detail.remove': async () => {
    if (!window.confirm('从库中移除这条记录？磁盘文件不会被删除。')) return;
    await api.deleteMovie(state.currentMovie.id);
    toast('已移除记录', 'ok');
    runtime.closeDetail();
    runtime.reload();
    await runtime.refreshHealth();
  },
});
