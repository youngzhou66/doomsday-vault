/** 通用工具：转义、格式化、图标、Toast。 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义，所有来自文件名/TMDB/用户输入的内容都必须经过它。 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

/** 体积：1.2 GiB */
export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** 时长：2 小时 15 分 / 48 分钟 */
export function fmtDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return '—';
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (!hours) return `${minutes} 分钟`;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

/** 秒 -> mm:ss / hh:mm:ss */
export function fmtClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** ISO -> 2026-10-17 */
export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 相对时间：3 天前 */
export function relTime(iso) {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Date.now() - time;
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return fmtDate(iso);
}

/** 截断长路径，中间用省略号。 */
export function shortPath(fullPath, max = 72) {
  const text = String(fullPath ?? '');
  if (text.length <= max) return text;
  const head = Math.ceil((max - 3) * 0.45);
  const tail = max - 3 - head;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function debounce(fn, wait = 260) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function unique(list) {
  return [...new Set((list ?? []).filter(Boolean))];
}

/** 简单确认框（原生 confirm 足够，且无额外依赖）。 */
export function confirmAction(message) {
  return window.confirm(message);
}

let toastCounter = 0;

/** 底部提示。type: info | ok | err */
export function toast(message, type = 'info', timeout = 3200) {
  const root = document.getElementById('toasts');
  if (!root) return;
  toastCounter += 1;
  const id = `toast-${toastCounter}`;
  const node = document.createElement('div');
  node.className = `toast ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''}`;
  node.id = id;
  node.innerHTML = `<span class="dot"></span><span>${esc(message)}</span>`;
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/** 复制文本到剪贴板，返回是否成功。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/* ── 图标（24×24 stroke） ───────────────────────────── */
const ICON_PATHS = {
  library: '<rect x="3" y="4" width="7" height="16" rx="1.2"/><rect x="14" y="4" width="7" height="16" rx="1.2"/>',
  queue: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
  tag: '<path d="M3.5 12.2 11 4.7a2 2 0 0 1 1.4-.6H19a1.5 1.5 0 0 1 1.5 1.5v6.6a2 2 0 0 1-.6 1.4l-7.5 7.5a2 2 0 0 1-2.8 0l-6.1-6.1a2 2 0 0 1 0-2.8Z"/><circle cx="16" cy="8" r="1.3"/>',
  layers: '<path d="m12 3 8.5 4.8L12 12.6 3.5 7.8 12 3Z"/><path d="m4 12 8 4.5 8-4.5"/><path d="m4 16.2 8 4.5 8-4.5"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.4h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  play: '<path d="M8 5.5v13l11-6.5-11-6.5Z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16.5V20"/>',
  reveal: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-.8 4.5"/><path d="M20 4.5V11h-6"/>',
  link: '<path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
  trash: '<path d="M4.5 7h15M9 7V5h6v2M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L18 7"/><path d="M10.5 11v6M13.5 11v6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  filter: '<path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8L4 5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  save: '<path d="M5 4h11l3 3v13H5V4Z"/><path d="M8 4v5h7V4M8 14h8v6H8v-6Z"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4-3 7.2-7 8.5-4-1.3-7-4.5-7-8.5V6l7-2.5Z"/><path d="m9 12 2 2 4-4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.6"/><path d="M8 4.5v15M16 4.5v15M3.5 9.5h4.5M3.5 14.5h4.5M16 9.5h4.5M16 14.5h4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="m12 4 2.4 5.1 5.6.7-4.1 3.9 1.1 5.5-5-2.8-5 2.8 1.1-5.5L4 9.8l5.6-.7L12 4Z"/>',
  warn: '<path d="M12 4 21 19.5H3L12 4Z"/><path d="M12 9.5v4.5M12 16.8v.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8.2v.2"/>',
};

/** 生成内联 SVG 图标。 */
export function icon(name, size = 16) {
  const path = ICON_PATHS[name] ?? ICON_PATHS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/** 由字符串生成稳定的色相，用于无海报时的占位底色。 */
export function titleHue(text) {
  let hash = 0;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
}

/** 海报/占位图标记。缺图时保留 CSS 占位，不产生裂图。 */
export function posterMarkup(movie, { lazy = true } = {}) {
  const tint = titleHue(movie.title);
  const fallback = `<div class="poster-fallback" style="--tint:${tint}"><span class="pf-mark">NO ART</span><span class="pf-glyph">${icon('film', 38)}</span></div>`;
  if (!movie.hasPoster) return fallback;
  return `${fallback}<img src="/api/movies/${encodeURIComponent(movie.id)}/poster" alt="" ${lazy ? 'loading="lazy"' : ''} data-poster />`;
}

/** 卡片右上角状态点。 */
export function pendingDot(movie) {
  return movie.matchState === 'pending' || movie.matchState === 'none' ? '<span class="card-pending" title="待确认"></span>' : '';
}

export function stateBadge(movie) {
  if (movie.matchState === 'confirmed') return '<span class="badge ok">已确认</span>';
  if (movie.matchState === 'auto') return '<span class="badge accent">自动匹配</span>';
  if (movie.matchState === 'none') return '<span class="badge err">未匹配</span>';
  return '<span class="badge warn">待确认</span>';
}
