/**
 * 登录页（服务端直接渲染，不依赖主应用的前端资源）。
 * 只用一个内联样式表，避免未登录时还要去加载 JS/CSS。
 */

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230d0f13'/%3E%3Ccircle cx='16' cy='16' r='8.5' fill='none' stroke='%23e0a458' stroke-width='1.6'/%3E%3Ccircle cx='16' cy='16' r='2' fill='%23e0a458'/%3E%3Cpath d='M16 5v3M16 24v3M5 16h3M24 16h3' stroke='%23e0a458' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E";

const LOGO = `<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
  <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="1.3"/>
  <circle cx="16" cy="16" r="2.3" fill="currentColor"/>
  <path d="M16 2.5v5M16 24.5v5M2.5 16h5M24.5 16h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;

/** 只允许站内相对路径，防止被拿去做开放重定向。 */
export function safeNext(value, fallback = '/') {
  const text = String(value ?? '').trim();
  if (!text.startsWith('/') || text.startsWith('//')) return fallback;
  if (text.includes('\n') || text.includes('\r')) return fallback;
  return text;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {{next?: string, user?: string, appName?: string}} options
 */
export function renderLoginPage({ next = '/', user = '', appName = '末日电影库' } = {}) {
  const target = escapeHtml(safeNext(next));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="robots" content="noindex,nofollow" />
<title>登录 · ${escapeHtml(appName)}</title>
<link rel="icon" href="${FAVICON}" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  :root {
    --bg: #0a0b0d;
    --panel: #13151b;
    --line: #252a35;
    --text: #e8e9ee;
    --dim: #b3b9c7;
    --muted: #7e8697;
    --accent: #e0a458;
    --accent-2: #f0bd7c;
  }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: grid;
    place-items: center;
    padding: 24px 16px;
    overflow: hidden;
  }

  /* 背景：金色径向微光 + 胶片孔 + 颗粒 */
  .bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
  .bg::before {
    content: "";
    position: absolute;
    width: min(1100px, 130vw);
    height: min(1100px, 130vw);
    left: 50%; top: -38%;
    transform: translateX(-50%);
    background: radial-gradient(circle at 50% 50%, rgba(224, 164, 88, 0.16) 0%, rgba(224, 164, 88, 0.05) 34%, transparent 62%);
    filter: blur(6px);
  }
  .bg::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      repeating-linear-gradient(90deg, rgba(255,255,255,0.028) 0 2px, transparent 2px 26px);
    mask-image: radial-gradient(circle at 50% 45%, #000 0%, transparent 78%);
  }
  .reel {
    position: absolute; top: 0; bottom: 0; width: 34px;
    background-image: repeating-linear-gradient(180deg, rgba(224,164,88,0.13) 0 10px, transparent 10px 30px);
    opacity: 0.55;
  }
  .reel.left { left: 0; }
  .reel.right { right: 0; }

  /* 登录卡片 */
  .shell { position: relative; z-index: 1; width: min(462px, 92vw); }
  .brand { display: flex; align-items: center; gap: 12px; margin: 0 4px 20px; color: var(--accent); }
  .brand-name { font-size: 17px; font-weight: 640; letter-spacing: 0.02em; color: var(--text); }
  .brand-sub {
    font: 9.5px/1.4 ui-monospace, Consolas, monospace;
    letter-spacing: 0.24em; color: var(--muted); margin-top: 3px;
  }

  .card {
    position: relative;
    background: linear-gradient(180deg, rgba(24, 27, 35, 0.94) 0%, rgba(16, 18, 24, 0.97) 100%);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 30px 30px 20px;
    box-shadow: 0 30px 70px rgba(0, 0, 0, 0.62), 0 1px 0 rgba(255, 255, 255, 0.04) inset;
    backdrop-filter: blur(10px);
  }
  .card::before {
    content: "";
    position: absolute; left: 22px; right: 22px; top: -1px; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(224, 164, 88, 0.75), transparent);
  }
  .eyebrow {
    display: flex; align-items: center; gap: 8px;
    font: 9.5px/1 ui-monospace, Consolas, monospace;
    letter-spacing: 0.28em; text-transform: uppercase;
    color: rgba(224, 164, 88, 0.85); margin-bottom: 12px;
  }
  .eyebrow::before {
    content: ""; width: 18px; height: 1px;
    background: linear-gradient(90deg, rgba(224,164,88,0.9), transparent);
  }
  h1 { margin: 0 0 6px; font-size: 23px; font-weight: 660; letter-spacing: 0.01em; }
  .lead { margin: 0 0 24px; color: var(--muted); font-size: 12.5px; }

  label { display: block; margin-bottom: 15px; }
  .label-text {
    display: block; margin-bottom: 7px;
    font: 10.5px/1 ui-monospace, Consolas, monospace;
    letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted);
  }
  .field { position: relative; display: block; }
  .field-icon {
    position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
    width: 16px; height: 16px; color: #5b6272;
    fill: none; stroke: currentColor; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round;
    pointer-events: none; transition: color 0.15s;
  }
  .field:focus-within .field-icon { color: rgba(224, 164, 88, 0.85); }
  input {
    width: 100%; height: 44px; padding: 0 12px 0 38px;
    background: #0d0f14; color: var(--text);
    border: 1px solid var(--line); border-radius: 10px;
    font: inherit; outline: none;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  input:hover { border-color: #303644; }
  input:focus {
    border-color: rgba(224, 164, 88, 0.55);
    box-shadow: 0 0 0 3px rgba(224, 164, 88, 0.13);
    background: #0f1218;
  }
  .pw input { padding-right: 58px; }
  .eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    height: 30px; padding: 0 10px;
    background: transparent; color: var(--muted);
    border: 1px solid transparent; border-radius: 7px;
    font: 11px/1 inherit; cursor: pointer;
  }
  .eye:hover { color: var(--dim); border-color: var(--line); }

  .error {
    display: flex; gap: 8px; align-items: flex-start;
    margin: 0 0 14px; padding: 10px 12px;
    background: rgba(198, 88, 84, 0.12);
    border: 1px solid rgba(198, 88, 84, 0.36);
    border-radius: 9px; color: #f0aca7; font-size: 12.5px;
    animation: shake 0.32s ease;
  }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    75% { transform: translateX(4px); }
  }

  .submit {
    width: 100%; height: 44px; margin-top: 4px;
    border: 0; border-radius: 10px; cursor: pointer;
    background: linear-gradient(180deg, var(--accent-2) 0%, #d9974a 100%);
    color: #1a1206; font: 600 14px/1 inherit; letter-spacing: 0.02em;
    box-shadow: 0 8px 22px rgba(224, 164, 88, 0.22), 0 1px 0 rgba(255, 255, 255, 0.35) inset;
    transition: transform 0.12s, filter 0.15s, box-shadow 0.15s;
  }
  .submit:hover { filter: brightness(1.06); box-shadow: 0 10px 26px rgba(224, 164, 88, 0.3); }
  .submit:active { transform: translateY(1px); }
  .submit[disabled] { filter: grayscale(0.35) brightness(0.8); cursor: default; box-shadow: none; }

  .foot {
    margin-top: 20px; padding-top: 14px;
    border-top: 1px solid var(--line);
    display: flex; justify-content: space-between; gap: 12px;
    font: 10.5px/1.5 ui-monospace, Consolas, monospace;
    color: #5f6675; letter-spacing: 0.04em;
  }
  .foot .dot { color: rgba(224, 164, 88, 0.6); }

  @media (max-width: 420px) {
    .card { padding: 24px 20px 18px; border-radius: 16px; }
    h1 { font-size: 20px; }
    .reel { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
  <div class="bg" aria-hidden="true"><div class="reel left"></div><div class="reel right"></div></div>

  <main class="shell">
    <div class="brand">
      ${LOGO}
      <div>
        <div class="brand-name">${escapeHtml(appName)}</div>
        <div class="brand-sub">DOOMSDAY VAULT · LOCAL</div>
      </div>
    </div>

    <section class="card">
      <div class="eyebrow">Private Access</div>
      <h1>登录</h1>
      <p class="lead">这是你的私人片库，验证通过后继续。</p>

      <form id="form" autocomplete="on" novalidate>
        <label>
          <span class="label-text">用户名</span>
          <span class="field">
            <svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20c0-3.5 3.3-6 7.2-6s7.2 2.5 7.2 6"/></svg>
            <input id="username" name="username" value="${escapeHtml(user)}" autocomplete="username" autocapitalize="off" spellcheck="false" required />
          </span>
        </label>
        <label>
          <span class="label-text">密码</span>
          <span class="field pw">
            <svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.6" width="14" height="9.4" rx="2.2"/><path d="M8.6 10.6V7.9a3.4 3.4 0 0 1 6.8 0v2.7"/></svg>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
            <button class="eye" id="eye" type="button" aria-label="显示密码">显示</button>
          </span>
        </label>
        <div class="error" id="error" hidden><span id="error-text"></span></div>
        <button class="submit" id="submit" type="submit">进入片库</button>
      </form>

      <div class="foot">
        <span>数据只存在这台机器</span>
        <span class="dot">●</span>
        <span>断网可用</span>
      </div>
    </section>
  </main>

  <script>
    (function () {
      var form = document.getElementById('form');
      var errorBox = document.getElementById('error');
      var errorText = document.getElementById('error-text');
      var submit = document.getElementById('submit');
      var password = document.getElementById('password');
      var username = document.getElementById('username');
      var eye = document.getElementById('eye');
      var nextTarget = ${JSON.stringify(target)};

      function showError(message) {
        errorText.textContent = message;
        errorBox.hidden = false;
        errorBox.style.animation = 'none';
        void errorBox.offsetWidth;
        errorBox.style.animation = '';
      }

      eye.addEventListener('click', function () {
        var visible = password.type === 'text';
        password.type = visible ? 'password' : 'text';
        eye.textContent = visible ? '显示' : '隐藏';
        password.focus();
      });

      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        errorBox.hidden = true;
        var user = username.value.trim();
        var pass = password.value;
        if (!user || !pass) {
          showError('用户名和密码都要填');
          return;
        }
        submit.disabled = true;
        submit.textContent = '验证中…';
        try {
          var response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
          });
          if (response.ok) {
            submit.textContent = '进入…';
            location.replace(nextTarget);
            return;
          }
          var payload = await response.json().catch(function () { return {}; });
          var message = (payload.error && payload.error.message) || '登录失败';
          if (response.status === 429) message = message || '尝试次数过多，请稍后再试';
          showError(message);
        } catch (err) {
          showError('网络错误：' + (err && err.message ? err.message : '无法连接服务'));
        } finally {
          submit.disabled = false;
          submit.textContent = '进入片库';
        }
      });

      (username.value ? password : username).focus();
    })();
  </script>
</body>
</html>`;
}
