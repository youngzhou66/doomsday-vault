/** 极简模态框容器（手动匹配、批量标签等共用）。 */

const root = document.getElementById('modal-root');

export function showModal({ title, body = '', footer = '', onMount } = {}) {
  if (!root) return null;
  root.hidden = false;
  root.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="${title ? title.replace(/"/g, '') : '对话框'}">
      <div class="modal-head">
        <h3>${title ?? ''}</h3>
        <button class="btn icon ghost" data-act="app.close-modal" title="关闭">✕</button>
      </div>
      <div class="modal-body" id="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot" id="modal-foot">${footer}</div>` : ''}
    </div>`;
  // 注意：不要在这里 stopPropagation —— 弹窗内的 data-act 按钮依赖全局事件代理。
  // 点击空白关闭由下方 root 的监听器用 event.target === root 判断。
  onMount?.(root);
  return root;
}

export function hideModal() {
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
}

export function setModalBody(html) {
  const body = document.getElementById('modal-body');
  if (body) body.innerHTML = html;
}

export function isModalOpen() {
  return Boolean(root && !root.hidden);
}

// 点空白处关闭
root?.addEventListener('click', (event) => {
  if (event.target === root) hideModal();
});
