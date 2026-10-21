/** 重复文件报告（只读，永不自动删除）。 */
import { api } from '../api.js';
import { registerActions, runtime, state } from '../state.js';
import { esc, fmtBytes, fmtDuration, icon, toast } from '../util.js';

function groupHtml(group, index) {
  return `
    <div class="panel">
      <div class="dupe-head">
        <h4>重复组 #${index + 1}</h4>
        <span class="badge">${group.count} 个文件</span>
        <span class="badge">${fmtBytes(group.size)} / 个</span>
        <span class="badge warn">可回收 ${fmtBytes(group.wastedBytes)}</span>
      </div>
      <div class="stack" style="margin-top:10px">
        ${group.files.map((file) => `
          <div class="dupe-file${file.keep ? ' keep' : ''}">
            ${file.keep ? icon('check', 14) : icon('copy', 14)}
            <div>
              <div>${esc(file.title)}${file.year ? ` <span class="mono">(${file.year})</span>` : ''}
                ${file.resolution ? `<span class="badge">${esc(file.resolution)}</span>` : ''}
                ${file.durationSec ? `<span class="badge">${fmtDuration(file.durationSec)}</span>` : ''}
              </div>
              <div class="df-path">${esc(file.path)}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn sm ghost" data-act="dupes.open" data-id="${esc(file.id)}">详情</button>
              <button class="btn sm ghost" data-act="dupes.reveal" data-id="${esc(file.id)}">定位</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="view-sub" style="margin-top:8px">绿色为建议保留（最早入库）；确认后可自行删除多余副本。</div>
    </div>`;
}

function nearHtml(group) {
  return `
    <div class="panel">
      <div class="dupe-head">
        <h4>${esc(group.title)}${group.year ? ` <span class="mono">(${group.year})</span>` : ''}</h4>
        <span class="badge warn">疑似同片不同版本</span>
      </div>
      <div class="stack" style="margin-top:10px">
        ${group.files.map((file) => `
          <div class="dupe-file">
            ${icon('film', 14)}
            <div>
              <div>${esc(file.resolution ?? '未知画质')} · ${fmtBytes(file.size)}${file.durationSec ? ` · ${fmtDuration(file.durationSec)}` : ''}</div>
              <div class="df-path">${esc(file.path)}</div>
            </div>
            <button class="btn sm ghost" data-act="dupes.open" data-id="${esc(file.id)}">详情</button>
          </div>`).join('')}
      </div>
    </div>`;
}

export function renderDupes(root) {
  const result = state.dupes;
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">重复文件</h1>
        <div class="view-sub" id="dupes-sub">${result ? `上次检测：${result.scanned ?? 0} 部影片` : '尚未检测'}</div>
      </div>
      <div class="spacer"></div>
      <button class="btn primary" data-act="dupes.run">${icon('copy', 14)}开始检测</button>
    </div>
    <div class="hint" style="margin-bottom:14px">${icon('shield', 14)}
      <span>检测方式：体积相同 → 首尾各 4MiB + 总体积计算快速指纹。结果仅供人工核对，本工具不会删除任何文件。</span>
    </div>
    <div id="dupes-body">${result ? bodyHtml(result) : placeholderHtml()}</div>
  `;
  if (!result) {
    // 服务端可能缓存了上次的检测结果，直接展示，省一次全量计算
    api.dupes().then((cached) => {
      if (!cached || !(cached.scanned > 0)) return;
      state.dupes = cached;
      const body = document.getElementById('dupes-body');
      const head = document.getElementById('dupes-sub');
      if (body) body.innerHTML = bodyHtml(cached);
      if (head) head.textContent = `上次检测：${cached.scanned} 部影片 · ${cached.groups?.length ?? 0} 组重复`;
    }).catch(() => {});
  }
}

function placeholderHtml() {
  return `<div class="empty">
    <h3>还没有检测过</h3>
    <p>检测会为同体积文件计算快速指纹，大文件也只需读首尾各 4MiB，几千部影片通常一分钟内跑完。</p>
    <button class="btn primary" data-act="dupes.run">开始检测</button>
  </div>`;
}

function bodyHtml(result) {
  const groups = result.groups ?? [];
  const near = result.nearGroups ?? [];
  if (!groups.length && !near.length) {
    return `<div class="empty">
      <h3>没有发现重复</h3>
      <p>已扫描 ${result.scanned ?? 0} 部影片，其中 ${result.candidates ?? 0} 部体积相同需要比对，未发现内容一致的副本。</p>
    </div>`;
  }
  return `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px">
      <div class="badge">扫描 ${result.scanned ?? 0} 部</div>
      <div class="badge">候选 ${result.candidates ?? 0} 部</div>
      <div class="badge">计算指纹 ${result.hashed ?? 0} 个</div>
      <div class="badge">复用缓存 ${result.reused ?? 0} 个</div>
      <div class="badge warn">浪费空间 ${fmtBytes(result.wastedBytes ?? 0)}</div>
    </div>
    <div class="stack">
      ${groups.map(groupHtml).join('')}
      ${near.length ? `<h3 class="section-title" style="margin-top:8px">疑似同片（不同体积/版本）</h3>` : ''}
      ${near.map(nearHtml).join('')}
    </div>`;
}

registerActions({
  'dupes.run': async () => {
    const { id } = await api.findDupes();
    toast('开始检测重复文件…');
    runtime.trackJob(id, {
      onDone: async (job) => {
        state.dupes = job.result;
        const count = job.result?.groups?.length ?? 0;
        toast(count ? `发现 ${count} 组重复文件` : '没有发现重复文件', 'ok', 5000);
        const body = document.getElementById('dupes-body');
        const head = document.getElementById('dupes-sub');
        if (body) body.innerHTML = bodyHtml(job.result ?? {});
        if (head) head.textContent = `检测于 ${new Date().toLocaleString('zh-CN')}`;
      },
    });
  },
  'dupes.open': (element) => runtime.openDetail(element.dataset.id),
  'dupes.reveal': async (element) => {
    await api.reveal(element.dataset.id);
  },
});
