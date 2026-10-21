/** 设置：目录、扫描、元数据、播放器、数据维护。 */
import { api } from '../api.js';
import { registerActions, runtime, state } from '../state.js';
import { esc, fmtBytes, fmtDate, icon, toast } from '../util.js';

const content = () => document.getElementById('content');

function card(title, subtitle, bodyHtml, actionsHtml = '') {
  return `
    <section class="panel">
      <div class="dupe-head" style="margin-bottom:12px">
        <div>
          <h3 style="margin:0;font-size:14.5px">${title}</h3>
          ${subtitle ? `<div class="view-sub" style="margin-top:2px">${subtitle}</div>` : ''}
        </div>
        ${actionsHtml ? `<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">${actionsHtml}</div>` : ''}
      </div>
      ${bodyHtml}
    </section>`;
}

function row(label, controlHtml, hint = '') {
  return `
    <div class="form-row">
      <label>${label}</label>
      ${controlHtml}
      ${hint ? `<div class="sub">${hint}</div>` : ''}
    </div>`;
}

function rootRowHtml(root) {
  const missing = root.exists === false;
  return `
    <div class="root-row">
      <div>
        <div class="rr-label">
          ${esc(root.label)}
          <span class="badge mono">depth ${root.depth}</span>
          ${root.exists === true ? `<span class="badge ok">可访问</span>` : ''}
          ${missing ? '<span class="badge err">路径不存在</span>' : ''}
          ${root.enabled === false ? '<span class="badge">已停用</span>' : ''}
        </div>
        <div class="rr-path">${esc(root.path)}${root.movies !== undefined ? ` · ${root.movies} 部` : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${missing ? `<button class="btn sm primary" data-act="settings.relocate" data-id="${esc(root.id)}" title="换盘符/移动位置后，把记录路径一起改过来">${icon('folder', 13)}重新定位</button>` : ''}
        <label class="check" title="启用/停用（停用后扫描会跳过）">
          <input type="checkbox" ${root.enabled ? 'checked' : ''} data-change="settings.root-toggle" data-id="${esc(root.id)}" /> 启用
        </label>
        <input type="number" min="0" max="99" value="${root.depth}" title="扫描深度：0=仅本层，1=每部电影一个目录" data-change="settings.root-depth" data-id="${esc(root.id)}" />
        <button class="btn sm danger" data-act="settings.delete-root" data-id="${esc(root.id)}" data-label="${esc(root.label)}">移除</button>
      </div>
    </div>`;
}

function rootsCard() {
  const roots = state.config?.roots ?? [];
  const list = roots.length
    ? roots.map(rootRowHtml).join('')
    : '<div class="hint">还没有配置目录。添加后点右上角「扫描」开始入库。</div>';

  return card('电影目录', '每个根目录下的视频文件会被登记；推荐「一部电影一个目录」的布局',
    `<div class="stack" style="margin-bottom:14px" id="roots-list">${list}</div>
     <div class="hint" style="margin-bottom:12px">
       ${icon('info', 14)}
       <span>把库放到移动硬盘上时，如果盘符变了（E: → F:），这里会标「路径不存在」，
       点「<strong>重新定位</strong>」选新位置即可——记录路径会一起改写，标签/已看/备注都保留，不用重新扫描。</span>
     </div>
     <form data-submit="settings.add-root">
       <div class="form-grid">
         ${row('目录绝对路径', '<input type="text" name="path" placeholder="D:\\\\电影" required />')}
         ${row('显示名称（可选）', '<input type="text" name="label" placeholder="例如：主片库" />')}
         ${row('扫描深度', '<input type="number" name="depth" min="0" max="99" value="1" />', '0=只扫该目录本层；1=再进一层（适合一片一目录）')}
       </div>
       <div class="settings-actions">
         <button class="btn primary" type="submit">${icon('plus', 13)}添加目录</button>
         <button class="btn" type="button" data-act="settings.validate-root">${icon('folder', 13)}检查路径</button>
         <span class="view-sub" id="root-validate"></span>
       </div>
     </form>`);
}

function scanCard() {
  const scan = state.config?.scan ?? {};
  return card('扫描规则', '只读扫描本地文件，不会移动、改名或删除任何视频',
    `<form data-submit="settings.save-scan">
      <div class="form-grid">
        ${row('最小文件体积（MB）', `<input type="number" name="minSizeMB" min="0" step="1" value="${Math.round((scan.minSizeBytes ?? 0) / 1024 / 1024)}" />`, '小于该体积的文件跳过，避免样片/花絮碎片')}
        ${row('探测并发数', `<input type="number" name="probeConcurrency" min="1" max="12" value="${scan.probeConcurrency ?? 3}" />`, 'ffprobe 同时运行的数量，机械硬盘建议 1–2')}
        ${row('视频扩展名', `<input type="text" name="extensions" value="${esc((scan.extensions ?? []).join(', '))}" />`, '逗号分隔，含点')}
        ${row('忽略目录名', `<input type="text" name="ignoreDirs" value="${esc((scan.ignoreDirs ?? []).join(', '))}" />`, '子目录名命中则不下钻')}
        ${row('忽略文件名后缀', `<input type="text" name="ignoreSuffixes" value="${esc((scan.ignoreSuffixes ?? []).join(', '))}" placeholder="-trailer, sample, 预告" />`, '看名字不看扩展名：The.Godfather.1972-trailer.mkv 命中 -trailer 就跳过；逗号分隔，大小写不敏感')}
      </div>
      <div class="form-grid" style="margin-top:12px">
        ${row('忽略路径正则', `<textarea name="ignorePatterns" rows="2" placeholder="每行一条，例如 \\\\sample\\\\">${esc((scan.ignorePatterns ?? []).join('\n'))}</textarea>`, '按绝对路径匹配，命中即跳过')}
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin:14px 0 4px">
        <label class="check"><input type="checkbox" name="probe" ${scan.probe !== false ? 'checked' : ''} /> 用 ffprobe 提取技术参数</label>
        <label class="check"><input type="checkbox" name="includeEpisodes" ${scan.includeEpisodes ? 'checked' : ''} /> 把剧集文件也收进库</label>
      </div>
      <div class="settings-actions">
        <button class="btn primary" type="submit">${icon('save', 13)}保存扫描规则</button>
      </div>
    </form>`);
}

function tmdbCard() {
  const tmdb = state.config?.tmdb ?? {};
  const masked = tmdb.apiKeyMasked || '';
  const keyHint = state.envKey
    ? '检测到环境变量 TMDB_API_KEY，已优先使用它（此处可留空）'
    : (tmdb.apiKeySet ? `已保存：${esc(masked)}（留空表示不修改）` : '在 themoviedb.org → 设置 → API 申请免费 Key');
  return card('TMDB 元数据', '刮削结果与海报会缓存到 data/cache，之后完全离线可用',
    `<div class="hint" style="margin-bottom:12px">
      ${icon('info', 14)}
      <span>不配 Key 也能有封面：把 <code>poster.jpg</code> / <code>folder.jpg</code> 放进电影文件夹，
      重新扫描后直接当封面用（本地图优先于 TMDB 海报）。Key 只用于自动抓取简介、评分、演员和海报。</span>
    </div>
    <form data-submit="settings.save-tmdb">
      <div class="form-grid">
        ${row('API Key', `<input type="password" name="apiKey" value="" placeholder="${tmdb.apiKeySet ? '已配置，留空不修改' : '32 位十六进制，或 eyJ 开头的令牌'}" autocomplete="off" />`,
          `${keyHint} · <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" style="color:var(--accent)">免费申请地址</a>`)}
        ${row('元数据语言', `<input type="text" name="language" value="${esc(tmdb.language ?? 'zh-CN')}" />`, '如 zh-CN / en-US / ja-JP')}
        ${row('海报语言', `<select name="posterLanguage">
          ${[
            ['follow', '跟随元数据语言'],
            ['original', '原语言（外语片用原版海报）'],
            ['en-US', '英语'],
            ['zh-CN', '中文'],
            ['ja-JP', '日语'],
            ['ko-KR', '韩语'],
          ].map(([value, label]) => `<option value="${value}" ${(tmdb.posterLanguage ?? 'follow') === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>`, 'TMDB 为同一部片准备了不同语言的本地化海报；「跟随元数据语言」会用中文版封面')}
        ${row('兜底语言', `<input type="text" name="fallbackLanguage" value="${esc(tmdb.fallbackLanguage ?? 'en-US')}" />`, '中文搜不到时用该语言再搜一次')}
        ${row('缓存天数', `<input type="number" name="cacheDays" min="0" max="3650" value="${tmdb.cacheDays ?? 30}" />`, '0 表示不读缓存（仍会写入）')}
        ${row('最低匹配分', `<input type="number" name="minScore" min="0" max="1" step="0.05" value="${tmdb.minScore ?? 0.4}" />`, '低于该分数的候选进入「待确认」而不是自动采用')}
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin:14px 0 4px">
        <label class="check"><input type="checkbox" name="autoScrape" ${tmdb.autoScrape ? 'checked' : ''} /> 扫描时自动刮削新片</label>
      </div>
      <div class="settings-actions">
        <button class="btn primary" type="submit">${icon('save', 13)}保存元数据配置</button>
        <button class="btn" type="button" data-act="settings.test-tmdb">${icon('link', 13)}测试连接</button>
        <button class="btn" type="button" data-act="settings.diagnose">${icon('shield', 13)}网络诊断</button>
        <button class="btn" type="button" data-act="settings.clear-key">清除已保存的 Key</button>
        <span class="view-sub" id="tmdb-test-result"></span>
      </div>
      <div id="network-diagnose-result"></div>
    </form>`);
}

function thumbCard() {
  const health = state.health ?? {};
  const ffmpeg = health.ffmpeg ?? {};
  const shell = health.shellThumb ?? {};
  const thumb = state.config?.thumb ?? {};
  return card('封面截帧', 'TMDB 没有封面的片子，从视频里抓一帧当封面',
    `<div class="hint" style="margin-bottom:12px">
      ${icon('info', 14)}
      <span>取图顺序：<b>系统缩略图</b>（和资源管理器显示的一致，零依赖）→ <b>ffmpeg 截帧</b>（任意编码）→ <b>浏览器截帧</b>（能解码的 MP4 等）。
      截图存在 <code>data/cache/posters/</code>，优先级高于本地图和 TMDB 海报。</span>
    </div>
    <dl class="kv" style="margin-bottom:12px">
      <dt>系统缩略图</dt><dd>${shell.supported
        ? '<span style="color:var(--ok)">可用</span>（能否出图取决于系统解码器；Windows 默认不解 MKV/HEVC）'
        : '<span style="color:var(--muted)">当前平台不支持</span>'}</dd>
      <dt>ffmpeg</dt><dd>${ffmpeg.ok
        ? `<span style="color:var(--ok)">${esc(ffmpeg.version ?? 'ok')}</span>`
        : `<span style="color:var(--err)">${esc(ffmpeg.error ?? '未检测')}</span>`}</dd>
      <dt>截帧位置</dt><dd>视频 ${thumb.offsetPercent ?? 20}% 处 · 封面宽 ${thumb.width ?? 500}px</dd>
    </dl>
    <form data-submit="settings.save-thumb">
      <div class="form-grid">
        ${row('ffmpeg 路径', `<input type="text" name="ffmpegPath" value="${esc(thumb.ffmpegPath ?? 'ffmpeg')}" placeholder="ffmpeg 或 D:\\ffmpeg\\bin\\ffmpeg.exe" />`, '装在 PATH 里填 ffmpeg 即可；装完点「重新检测」')}
        ${row('截帧位置（%）', `<input type="number" name="offsetPercent" min="0" max="95" value="${thumb.offsetPercent ?? 20}" />`, '避开片头黑屏，20% 比较稳')}
        ${row('封面宽度（px）', `<input type="number" name="width" min="120" max="2000" value="${thumb.width ?? 500}" />`, '500 足够列表和详情使用')}
      </div>
      <div class="settings-actions">
        <button class="btn primary" type="submit">${icon('save', 13)}保存截帧设置</button>
        <button class="btn" type="button" data-act="settings.detect-ffmpeg">${icon('refresh', 13)}重新检测 ffmpeg</button>
        <button class="btn" type="button" data-act="settings.capture-missing">${icon('film', 13)}为缺封面的影片批量截取</button>
      </div>
    </form>`);
}

function playerCard() {
  const player = state.config?.player ?? {};
  const presets = state.presets ?? {};
  return card('本地播放器', '扫描/刮削都离线可用，播放交给系统里已装的播放器',
    `<form data-submit="settings.save-player">
      <div class="form-grid">
        ${row('播放器', `<select name="preset">
          ${Object.entries(presets).map(([key, preset]) => `<option value="${esc(key)}" ${player.preset === key ? 'selected' : ''}>${esc(preset.label)}</option>`).join('')}
        </select>`, '「自动」会依次尝试 mpv、VLC、PotPlayer，找不到就交给系统默认程序')}
        ${row('自定义命令（可选）', `<input type="text" name="command" value="${esc(player.command ?? '')}" placeholder="mpv --fullscreen --start={time} {file}" />`, '占位符：{file} 文件绝对路径，{time} 续播秒数（为 0 时整段参数丢弃）')}
      </div>
      <div class="settings-actions">
        <button class="btn primary" type="submit">${icon('save', 13)}保存播放器设置</button>
      </div>
    </form>`);
}

function offlineCard() {
  const health = state.health ?? {};
  const offline = health.offline ?? {};
  const ready = offline.ready;
  return card('离线与缓存', '这个工具本身不依赖外网：数据、封面、技术参数都在本地',
    `<div class="hint" style="margin-bottom:12px">
      ${icon('shield', 14)}
      <span>断网后仍然可用：浏览/搜索/筛选/标签/合集/已看标记、详情元数据与封面、ffprobe 技术参数、本地播放、导出/备份/校验。
      只有<strong>首次刮削、重新刮削、手动匹配搜索</strong>这几件事需要联网。</span>
    </div>
    <dl class="kv" style="margin-bottom:12px">
      <dt>离线就绪</dt><dd>${ready
        ? '<span style="color:var(--ok)">全部影片都有本地封面与元数据</span>'
        : `<span style="color:var(--warn)">${offline.withPoster ?? 0}/${offline.total ?? 0} 有封面 · ${offline.withMetadata ?? 0}/${offline.total ?? 0} 有元数据</span>`}</dd>
      <dt>技术参数</dt><dd>${offline.withProbe ?? 0}/${offline.total ?? 0} 部已探测</dd>
      <dt>缓存目录</dt><dd class="mono">${esc(health.dataDir ?? '')}\\cache</dd>
    </dl>
    <div class="settings-actions">
      <button class="btn" data-act="settings.offline-check">${icon('check', 13)}检查离线完整性</button>
      <button class="btn" data-act="settings.backup">${icon('shield', 13)}备份（含封面缓存）</button>
    </div>
    <div id="offline-detail"></div>`);
}

function dataCard() {
  const health = state.health ?? {};
  const ffprobe = health.ffprobe ?? {};
  return card('数据与维护', '库数据 = data 目录里的两个 JSON，可直接拷到另一台机器',
    `<dl class="kv" style="margin-bottom:14px">
      <dt>数据目录</dt><dd class="mono">${esc(health.dataDir ?? '—')}</dd>
      <dt>影库规模</dt><dd>${health.counts?.total ?? 0} 部 · ${fmtBytes(health.counts?.totalBytes ?? 0)} · 缺失 ${health.counts?.missing ?? 0}</dd>
      <dt>ffprobe</dt><dd>${ffprobe.ok ? `<span style="color:var(--ok)">${esc(ffprobe.version ?? 'ok')}</span><br/><span class="mono">${esc(ffprobe.path ?? '')}</span>` : `<span style="color:var(--err)">${esc(ffprobe.error ?? '不可用')}</span>`}</dd>
      <dt>运行环境</dt><dd>Node ${esc(health.node ?? '?')} · ${esc(health.platform ?? '?')}</dd>
    </dl>
    <div class="settings-actions" style="margin-bottom:16px">
      <a class="btn" href="${api.exportUrl('json')}" download>${icon('download', 13)}导出 JSON</a>
      <a class="btn" href="${api.exportUrl('csv')}" download>${icon('download', 13)}导出 CSV</a>
      <button class="btn" data-act="settings.export-disk">${icon('save', 13)}写入 data/exports</button>
      <button class="btn" data-act="settings.backup">${icon('shield', 13)}立即备份</button>
      <button class="btn" data-act="settings.verify-shallow">${icon('check', 13)}校验文件</button>
      <button class="btn" data-act="settings.verify-deep">${icon('check', 13)}深度校验</button>
      <button class="btn" data-act="settings.detect-ffprobe">${icon('refresh', 13)}重新检测 ffprobe</button>
    </div>
    <div id="verify-result"></div>
    <div class="form-row" style="margin-top:16px">
      <label>从 JSON 导入（合并到当前库）</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="file" id="import-file" accept=".json,application/json" style="max-width:280px" />
        <button class="btn" data-act="settings.import">${icon('save', 13)}导入</button>
      </div>
      <div class="sub">用于迁移或合并别的机器导出的库；同 id 记录会被覆盖，其余保留。</div>
    </div>
    <div class="section-title" style="margin-top:18px">备份历史</div>
    <div id="backups-list" class="stack"><div class="view-sub">读取中…</div></div>`);
}

function aboutCard() {
  return card('关于与边界', '',
    `<p class="overview">
      本工具只处理<strong>你已合法拥有或已获授权</strong>的本地视频文件：它读取文件名与 ffprobe 元数据，
      向 TMDB 查询公开的影片资料，并调用你机器上已安装的播放器播放。它不包含、也不会实现
      影视资源搜索、自动下载、破解或绕过版权保护的任何功能。
    </p>
    <p class="overview" style="margin-top:8px">
      数据可迁移：整个 <span class="mono">data/</span> 目录（config.json + library.json + cache/）拷到新机器即可继续用；
      换机器后视频路径若变化，重新扫描一次会把新路径登记进来，标签、合集、备注按 id 保留。
    </p>`);
}

export function renderSettings(root) {
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">设置</h1>
        <div class="view-sub">所有配置只写入本地 data/config.json · 不上传任何数据</div>
      </div>
    </div>
    <div class="settings">
      ${rootsCard()}
      ${scanCard()}
      ${tmdbCard()}
      ${thumbCard()}
      ${playerCard()}
      ${offlineCard()}
      ${dataCard()}
      ${aboutCard()}
    </div>`;
  loadBackups();
  loadRootsMeta();
}

/** 补上「目录是否存在」的实时信息（配置里只有路径，没有探测结果）。 */
async function loadRootsMeta() {
  const box = document.getElementById('roots-list');
  if (!box) return;
  try {
    const roots = await api.roots();
    if (!roots.length) return;
    box.innerHTML = roots.map(rootRowHtml).join('');
  } catch {
    // 读不到就保持静态渲染
  }
}

async function refreshAll() {
  const [health, configResponse] = await Promise.all([api.health(), api.getConfig()]);
  state.health = health;
  state.config = configResponse.config;
  state.presets = configResponse.presets ?? {};
  state.extensions = configResponse.extensions ?? [];
  state.envKey = Boolean(configResponse.envKey);
  runtime.refreshSidebar();
  renderSettings(content());
}

async function loadBackups() {
  const box = document.getElementById('backups-list');
  if (!box) return;
  try {
    const backups = await api.backups();
    box.innerHTML = backups.length
      ? backups.map((item) => `
        <div class="root-row">
          <div>
            <div class="rr-label">${esc(item.name)}</div>
            <div class="rr-path">${item.movies} 条记录 · ${fmtBytes(item.bytes)} · ${fmtDate(item.createdAt)}</div>
          </div>
          <span class="badge ok">可恢复</span>
        </div>`).join('')
      : '<div class="view-sub">还没有备份。点上方「立即备份」生成快照。</div>';
  } catch (err) {
    box.innerHTML = `<div class="view-sub">读取备份失败：${esc(err.message)}</div>`;
  }
}

registerActions({
  'settings.add-root': async (form) => {
    const path = form.elements.path.value.trim();
    const label = form.elements.label.value.trim();
    const depth = Number(form.elements.depth.value) || 0;
    if (!path) throw new Error('请填写目录路径');
    await api.addRoot(path, { label, depth });
    toast('目录已添加，可以开始扫描', 'ok');
    await refreshAll();
  },
  'settings.validate-root': async (element) => {
    const form = element.closest('form');
    const path = form.elements.path.value.trim();
    if (!path) throw new Error('请先填写目录路径');
    const result = await api.validateRoot(path);
    const box = document.getElementById('root-validate');
    if (!box) return;
    box.innerHTML = result.isDirectory
      ? `<span style="color:var(--ok)">目录可用：本层 ${result.videos} 个视频、${result.subdirs} 个子目录</span>`
      : '<span style="color:var(--err)">目录不存在或不是文件夹</span>';
  },
  'settings.root-toggle': async (element) => {
    await api.patchRoot(element.dataset.id, { enabled: element.checked });
    const root = state.config.roots.find((item) => item.id === element.dataset.id);
    if (root) root.enabled = element.checked;
    toast(element.checked ? '已启用该目录' : '已停用该目录（扫描会跳过）', 'ok');
  },
  'settings.root-depth': async (element) => {
    const depth = Number(element.value) || 0;
    await api.patchRoot(element.dataset.id, { depth });
    const root = state.config.roots.find((item) => item.id === element.dataset.id);
    if (root) root.depth = depth;
    toast(`扫描深度已设为 ${depth}`, 'ok');
  },
  'settings.relocate': async (element) => {
    const rootId = element.dataset.id;
    // 先在其它盘符里找同名目录，找不到再让用户手填
    let target = null;
    try {
      const suggestions = await api.rootSuggest();
      const match = suggestions.find((item) => item.rootId === rootId);
      if (match?.candidates?.length === 1) {
        target = match.candidates[0];
        if (!window.confirm(`找到候选目录：\n${target}\n\n把记录路径改到这里吗？`)) return;
      } else if (match?.candidates?.length > 1) {
        target = window.prompt(`找到多个候选目录，请填写一个：\n${match.candidates.join('\n')}`, match.candidates[0]);
      }
    } catch {
      // 建议接口失败就退回手动输入
    }
    if (!target) {
      target = window.prompt('输入这个根目录的新路径（例如 F:\\电影）：', '');
    }
    if (!target?.trim()) return;
    const result = await api.relocateRoot(rootId, target.trim());
    if (result.unchanged) {
      toast('路径没有变化', 'ok');
      return;
    }
    toast(result.note ?? `已重定位 ${result.changed} 条记录`, 'ok', 6000);
    if (result.skipped?.length) toast(`有 ${result.skipped.length} 条因目标已存在而跳过`, 'err', 6000);
    await refreshAll();
    await runtime.refreshHealth();
  },
  'settings.delete-root': async (element) => {
    if (!window.confirm(`移除目录「${element.dataset.label}」？\n已入库的记录会保留（下次扫描会标记为缺失）。`)) return;
    await api.deleteRoot(element.dataset.id);
    toast('目录已移除', 'ok');
    await refreshAll();
  },
  'settings.save-scan': async (form) => {
    const elements = form.elements;
    await api.saveConfig({
      scan: {
        minSizeBytes: Math.max(0, Number(elements.minSizeMB.value) || 0) * 1024 * 1024,
        probeConcurrency: Number(elements.probeConcurrency.value) || 3,
        extensions: elements.extensions.value.split(/[,，\s]+/).filter(Boolean),
        ignoreDirs: elements.ignoreDirs.value.split(/[,，]+/).map((text) => text.trim()).filter(Boolean),
        ignoreSuffixes: elements.ignoreSuffixes.value.split(/[,，、;；\n]+/).map((text) => text.trim()).filter(Boolean),
        ignorePatterns: elements.ignorePatterns.value.split('\n').map((text) => text.trim()).filter(Boolean),
        probe: elements.probe.checked,
        includeEpisodes: elements.includeEpisodes.checked,
      },
    });
    toast('扫描规则已保存', 'ok');
    await refreshAll();
  },
  'settings.save-tmdb': async (form) => {
    const elements = form.elements;
    const previousPosterLanguage = state.config?.tmdb?.posterLanguage ?? 'follow';
    const patch = {
      tmdb: {
        language: elements.language.value.trim() || 'zh-CN',
        posterLanguage: elements.posterLanguage.value,
        fallbackLanguage: elements.fallbackLanguage.value.trim() || 'en-US',
        cacheDays: Number(elements.cacheDays.value) || 0,
        minScore: Math.min(Math.max(Number(elements.minScore.value) || 0.4, 0), 1),
        autoScrape: elements.autoScrape.checked,
      },
    };
    const key = elements.apiKey.value.trim();
    if (key) patch.tmdb.apiKey = key;
    await api.saveConfig(patch);
    const posterChanged = patch.tmdb.posterLanguage !== previousPosterLanguage;
    toast(
      posterChanged
        ? '已保存。海报语言变了，需要重新刮削（或点各影片的「重新刮削」）才会换图'
        : (key ? '元数据配置已保存（Key 已更新）' : '元数据配置已保存'),
      'ok',
      posterChanged ? 6000 : 3200,
    );
    await refreshAll();
  },
  'settings.test-tmdb': async () => {
    const slot = document.getElementById('tmdb-test-result');
    if (slot) slot.textContent = '测试中…';
    try {
      const result = await api.tmdbTest();
      const sample = result.sample ? `，示例：${result.sample.title}（${result.sample.year ?? '—'}）` : '';
      const via = result.resolvedVia ? ` · 网络：${result.resolvedVia}` : '';
      const auth = result.authLabel ? ` · 凭据：${result.authLabel}` : '';
      if (slot) {
        slot.innerHTML = `<span style="color:var(--ok)">${esc(result.message)}${esc(sample)} · ${result.elapsedMs}ms${esc(auth)}${esc(via)}</span>`;
      }
      toast(`TMDB 连接正常${sample}`, 'ok', 4600);
    } catch (err) {
      if (slot) slot.innerHTML = `<span style="color:var(--err)">${esc(err.message)}</span>`;
      throw err;
    }
  },
  'settings.offline-check': async () => {
    const slot = document.getElementById('offline-detail');
    if (slot) slot.innerHTML = '<div class="view-sub" style="margin-top:8px">检查中…</div>';
    const report = await api.offlineStatus();
    const rows = [];
    for (const [key, label] of [['tmdbJson', '刮削缓存 JSON'], ['images', '海报/背景图'], ['posters', '自定义封面']]) {
      const item = report.cache?.[key] ?? { files: 0, bytes: 0 };
      rows.push(`<dt>${label}</dt><dd>${item.files} 个文件 · ${fmtBytes(item.bytes)}</dd>`);
    }
    const gapHtml = (list, empty) => (list?.length
      ? `<div class="stack" style="margin-top:6px">${list.slice(0, 12).map((item) => `
          <div class="dupe-file">
            ${icon('warn', 14)}
            <div><div>${esc(item.title)}${item.year ? ` <span class="mono">(${item.year})</span>` : ''}</div>
            <div class="df-path">${esc(item.reason)}</div></div>
          </div>`).join('')}</div>${list.length > 12 ? `<div class="view-sub">还有 ${list.length - 12} 条…</div>` : ''}`
      : `<div class="view-sub" style="margin-top:4px">${empty}</div>`);

    if (slot) {
      slot.innerHTML = `
        <div class="panel" style="margin-top:12px;background:var(--panel-2)">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
            ${report.ready ? '<span class="badge ok">断网可用</span>' : '<span class="badge warn">有缺口</span>'}
            <span class="badge">${report.withPoster}/${report.total} 有封面</span>
            <span class="badge">${report.withMetadata}/${report.total} 有元数据</span>
            <span class="badge">外部资源 ${report.externalAssets?.length ?? 0} 个</span>
          </div>
          <dl class="kv">${rows.join('')}</dl>
          <div class="section-title" style="margin-top:14px">缺元数据（断网时只能看到文件名解析）</div>
          ${gapHtml(report.missingMetadata, '无')}
          <div class="section-title" style="margin-top:14px">缺封面（断网时显示占位卡）</div>
          ${gapHtml(report.missingPoster, '无')}
        </div>`;
    }
    toast(report.ready ? '全部影片都能离线查看' : '可离线查看，但还有条目缺元数据/封面', report.ready ? 'ok' : 'err', 5200);
  },
  'settings.diagnose': async () => {
    const slot = document.getElementById('network-diagnose-result');
    if (slot) slot.innerHTML = '<div class="view-sub" style="margin-top:8px">诊断中…</div>';
    const report = await api.networkDiagnose();
    const rows = (report.hosts ?? []).map((entry) => `
      <div class="dupe-file" style="margin-top:6px">
        <span class="mono">${esc(entry.host)}</span>
        <div>
          <div>系统 DNS：<span class="mono">${esc((entry.systemDns ?? []).map((item) => item.address).join(', ') || '无记录')}</span></div>
          <div class="df-path">实际使用：${esc((entry.useIps ?? []).map((item) => item.address).join(', ') || '无')} · 策略 ${esc(entry.via ?? '—')}</div>
        </div>
        <span class="badge ${entry.tcpOk ? 'ok' : 'err'}">${entry.tcpOk ? '可连通' : '不可达'}</span>
      </div>`).join('');
    const httpsBadge = report.https?.ok
      ? `<span class="badge ok">HTTPS ${report.https.status}</span>`
      : `<span class="badge err">HTTPS 不可用</span>`;
    if (slot) {
      slot.innerHTML = `
        <div class="panel" style="margin-top:10px;background:var(--panel-2)">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${httpsBadge}
            ${report.poisoned ? '<span class="badge warn">DNS 被污染</span>' : '<span class="badge ok">DNS 正常</span>'}
            <span class="view-sub">${esc(report.summary ?? '')}</span>
          </div>
          ${rows}
        </div>`;
    }
    toast(report.ok ? '网络可用，TMDB 能连上' : 'TMDB 仍不可达，见诊断结果', report.ok ? 'ok' : 'err', 6000);
  },
  'settings.save-thumb': async (form) => {
    const elements = form.elements;
    await api.saveConfig({
      thumb: {
        ffmpegPath: elements.ffmpegPath.value.trim() || 'ffmpeg',
        offsetPercent: Number(elements.offsetPercent.value) || 0,
        width: Number(elements.width.value) || 500,
      },
    });
    toast('截帧设置已保存', 'ok');
    await refreshAll();
  },
  'settings.detect-ffmpeg': async () => {
    const result = await api.detectFfmpeg();
    state.health.ffmpeg = result;
    toast(result.ok ? `ffmpeg 可用：${result.version}` : '仍未找到 ffmpeg，可先用系统缩略图或浏览器截帧', result.ok ? 'ok' : 'err', 5200);
    renderSettings(content());
  },
  'settings.capture-missing': async () => {
    const { id, total } = await api.captureMissingPosters();
    if (!total) {
      toast('所有影片都已有封面', 'ok');
      return;
    }
    toast(`开始为 ${total} 部缺封面的影片截取…`);
    runtime.trackJob(id, {
      onDone: async (job) => {
        const result = job.result ?? {};
        const failed = result.failed ?? [];
        toast(
          `截取完成：成功 ${result.succeeded ?? 0} / ${result.total ?? 0}`
          + (failed.length ? `，${failed.length} 部失败（多是缺解码器，装 FFmpeg 可解决）` : ''),
          failed.length ? 'err' : 'ok',
          7000,
        );
        await runtime.refreshHealth();
        renderSettings(content());
      },
    });
  },
  'settings.clear-key': async () => {
    if (!window.confirm('清除本地保存的 TMDB API Key？')) return;
    await api.saveConfig({ tmdb: { apiKey: '' } });
    toast('已清除 Key', 'ok');
    await refreshAll();
  },
  'settings.save-player': async (form) => {
    await api.saveConfig({
      player: {
        preset: form.elements.preset.value,
        command: form.elements.command.value.trim(),
      },
    });
    toast('播放器设置已保存', 'ok');
    await refreshAll();
  },
  'settings.export-disk': async () => {
    const result = await api.exportToDisk('json');
    toast(`已写入 ${result.file}（${fmtBytes(result.bytes)}）`, 'ok', 5000);
  },
  'settings.backup': async () => {
    const result = await api.backup();
    const cache = result.manifest?.cache;
    toast(
      `备份完成：${result.dir}${cache?.files ? `（含 ${cache.files} 个缓存文件 ${fmtBytes(cache.bytes)}）` : ''}`,
      'ok',
      6500,
    );
    await loadBackups();
  },
  'settings.verify-shallow': async () => {
    const { id } = await api.verify(false);
    runtime.trackJob(id, {
      onDone: (job) => renderVerify(job.result),
    });
  },
  'settings.verify-deep': async () => {
    const { id } = await api.verify(true);
    runtime.trackJob(id, {
      onDone: (job) => renderVerify(job.result),
    });
  },
  'settings.detect-ffprobe': async () => {
    const result = await api.detectFfprobe();
    state.health.ffprobe = result;
    toast(result.ok ? `已找到 ffprobe：${result.version}` : '仍然没找到 ffprobe', result.ok ? 'ok' : 'err', 5000);
    renderSettings(content());
  },
  'settings.import': async () => {
    const input = document.getElementById('import-file');
    const file = input?.files?.[0];
    if (!file) throw new Error('请先选择一个 JSON 文件');
    const text = await file.text();
    const parsed = JSON.parse(text);
    const movies = Array.isArray(parsed) ? parsed : parsed.movies;
    if (!Array.isArray(movies)) throw new Error('文件里没有 movies 数组');
    const result = await api.importLibrary(movies);
    toast(`导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`, 'ok', 5000);
    await runtime.refreshHealth();
    await refreshAll();
  },
});

function renderVerify(result) {
  const box = document.getElementById('verify-result');
  if (!box || !result) return;
  const problems = result.issues ?? [];
  const dataFiles = result.dataFiles ?? [];
  const badData = dataFiles.filter((item) => !item.ok);
  box.innerHTML = `
    <div class="panel" style="background:var(--panel-2);margin-bottom:10px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <span class="badge ${result.missing || result.sizeMismatch || result.hashMismatch ? 'warn' : 'ok'}">
          ${result.missing || result.sizeMismatch || result.hashMismatch ? '发现问题' : '全部通过'}
        </span>
        <span class="badge">检查 ${result.checked} 部</span>
        <span class="badge ok">正常 ${result.ok}</span>
        ${result.missing ? `<span class="badge err">缺失 ${result.missing}</span>` : ''}
        ${result.sizeMismatch ? `<span class="badge err">体积变化 ${result.sizeMismatch}</span>` : ''}
        ${result.hashMismatch ? `<span class="badge err">指纹不符 ${result.hashMismatch}</span>` : ''}
        ${result.deep ? `<span class="badge">深度校验 ${result.hashChecked} 个指纹</span>` : ''}
        ${badData.length ? `<span class="badge err">JSON 损坏 ${badData.length}</span>` : '<span class="badge ok">数据文件正常</span>'}
      </div>
      ${problems.length ? `<div class="stack">${problems.slice(0, 12).map((issue) => `
        <div class="dupe-file">
          ${icon('warn', 14)}
          <div><div>${esc(issue.message)}</div><div class="df-path">${esc(issue.path)}</div></div>
        </div>`).join('')}</div>
        ${result.issueCount > 12 ? `<div class="view-sub" style="margin-top:6px">还有 ${result.issueCount - 12} 条未显示…</div>` : ''}`
      : '<div class="view-sub">没有发现问题。</div>'}
    </div>`;
}
