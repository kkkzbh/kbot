import { genshinRoleKey } from '../service.js';
import type { GenshinGameRole } from '../types.js';

export interface GenshinBindPageOptions {
  qq: string;
  token?: string;
  submitPath?: string;
  statusPath?: string;
  qrImageDataUrl?: string;
  state?: 'qr' | 'error' | 'invalid' | 'success' | 'role_selection';
  message?: string;
  confirmCode?: string;
  role?: GenshinGameRole;
  roles?: GenshinGameRole[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderGenshinBindPage(options: GenshinBindPageOptions): string {
  const qq = escapeHtml(options.qq);
  const token = escapeHtml(options.token ?? '');
  const submitPath = escapeHtml(options.submitPath ?? '');
  const statusPath = escapeHtml(options.statusPath ?? '');
  const qrImageDataUrl = escapeHtml(options.qrImageDataUrl ?? '');
  const state = options.state ?? 'qr';
  const message = escapeHtml(options.message ?? '');
  const confirmCommand = escapeHtml(options.confirmCode ? `原神确认 ${options.confirmCode}` : '');
  const selectedRoleText = options.role ? `${options.role.nickname || '旅行者'} / UID ${options.role.uid} / ${options.role.regionName || options.role.region}` : '';

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>原神 UID 绑定 - QQ Bot</title>
    <style>
      :root {
        color-scheme: light;
        --text: #172033;
        --muted: #6f7b8d;
        --line: #d8dee8;
        --line-strong: #c8d0dc;
        --surface: #ffffff;
        --accent: #1f8a5b;
        --accent-deep: #137048;
        --danger: #b42318;
        --danger-bg: #fff1f0;
        --ok-bg: #e7f4ee;
        --hint-bg: #f4f8fb;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100svh;
        color: var(--text);
        background:
          linear-gradient(90deg, rgba(245, 250, 247, 0.94), rgba(255, 255, 255, 0.88) 48%, #ffffff 100%),
          radial-gradient(circle at 16% 20%, rgba(31, 138, 91, 0.18), transparent 30%),
          #f7fafc;
      }

      button, textarea, input { font: inherit; }

      .page {
        display: grid;
        grid-template-columns: minmax(360px, 0.9fr) minmax(520px, 1fr);
        min-height: 100svh;
      }

      .guide {
        display: flex;
        align-items: center;
        padding: clamp(36px, 7vw, 84px);
        background:
          linear-gradient(135deg, rgba(21, 84, 60, 0.08), rgba(255, 255, 255, 0.2)),
          linear-gradient(180deg, #f4faf7, #ffffff);
        border-right: 1px solid rgba(200, 208, 220, 0.72);
      }

      .guide-inner { max-width: 560px; }

      .eyebrow {
        margin: 0 0 18px;
        color: var(--accent);
        font-size: 15px;
        font-weight: 800;
      }

      h1 {
        margin: 0;
        color: #142034;
        font-size: clamp(34px, 4vw, 52px);
        font-weight: 780;
        letter-spacing: 0;
        line-height: 1.14;
      }

      .lead {
        margin: 24px 0 0;
        color: #324055;
        font-size: 18px;
        line-height: 1.75;
      }

      .steps {
        display: grid;
        gap: 14px;
        margin: 34px 0 0;
        padding: 0;
        list-style: none;
      }

      .steps li {
        display: grid;
        grid-template-columns: 34px 1fr;
        gap: 14px;
        align-items: start;
        color: #243247;
        font-size: 16px;
        line-height: 1.65;
      }

      .step-index {
        display: grid;
        width: 34px;
        height: 34px;
        place-items: center;
        border-radius: 50%;
        color: #ffffff;
        background: var(--accent);
        font-size: 15px;
        font-weight: 800;
      }

      a { color: var(--accent-deep); font-weight: 760; text-decoration: none; }
      a:hover { text-decoration: underline; }

      .panel {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        padding: clamp(32px, 6vw, 84px);
        background: rgba(255, 255, 255, 0.86);
      }

      .shell { width: min(100%, 660px); }

      .qq {
        margin: 0 0 18px;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }

      .notice {
        margin: 0 0 24px;
        padding: 15px 17px;
        border-radius: 10px;
        color: #1b2537;
        background: var(--ok-bg);
        font-size: 16px;
        line-height: 1.6;
      }

      .notice.is-error {
        color: var(--danger);
        background: var(--danger-bg);
      }

	      .form { display: grid; gap: 20px; }

	      .qr-card {
	        display: grid;
	        gap: 18px;
	        justify-items: center;
	        padding: 28px;
	        border: 1px solid rgba(31, 138, 91, 0.22);
	        border-radius: 16px;
	        background: #ffffff;
	      }

	      .qr-image {
	        display: block;
	        width: min(76vw, 280px);
	        aspect-ratio: 1;
	        border: 1px solid var(--line);
	        border-radius: 12px;
	        background: #ffffff;
	      }

      label {
        color: #1b2537;
        font-size: 18px;
        font-weight: 760;
        line-height: 1.35;
      }

      textarea {
        width: 100%;
        min-height: 280px;
        resize: vertical;
        border: 1px solid var(--line-strong);
        border-radius: 12px;
        outline: none;
        color: #1a2435;
        background: rgba(255, 255, 255, 0.94);
        padding: 18px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 14px;
        line-height: 1.6;
        transition: border-color 160ms ease, box-shadow 160ms ease;
      }

      textarea:focus {
        border-color: rgba(31, 138, 91, 0.7);
        box-shadow: 0 0 0 4px rgba(31, 138, 91, 0.12);
      }

      .role-list {
        display: grid;
        gap: 12px;
        margin: 0;
        padding: 0;
        border: 0;
      }

      .role-option {
        display: grid;
        grid-template-columns: 24px 1fr;
        gap: 14px;
        align-items: center;
        min-height: 68px;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #ffffff;
      }

      .role-name {
        display: block;
        color: #172033;
        font-size: 17px;
        font-weight: 780;
      }

      .role-meta {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 14px;
      }

      .hint {
        margin: 0;
        padding: 14px 16px;
        border-radius: 10px;
        color: #3d4b60;
        background: var(--hint-bg);
        font-size: 15px;
        line-height: 1.65;
      }

      .submit {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 52px;
        border: 0;
        border-radius: 9px;
        padding: 0 22px;
        color: #ffffff;
        background: var(--accent);
        font-weight: 780;
        cursor: pointer;
      }

      .submit:hover, .submit:focus-visible { background: var(--accent-deep); }
      .submit:focus-visible { outline: 2px solid rgba(31, 138, 91, 0.36); outline-offset: 2px; }

      .success-card {
        display: grid;
        gap: 18px;
        padding: 26px;
        border: 1px solid rgba(31, 138, 91, 0.24);
        border-radius: 16px;
        background: linear-gradient(180deg, #f3fbf7, #e5f4ed);
      }

      .success-title {
        margin: 0;
        color: #11263d;
        font-size: 24px;
        font-weight: 820;
        line-height: 1.25;
      }

      .success-text {
        margin: 0;
        color: #2c3c52;
        font-size: 17px;
        line-height: 1.7;
      }

      .confirm-command {
        display: block;
        padding: 16px 18px;
        border-radius: 12px;
        color: #0f5f3d;
        background: #ffffff;
        font-size: clamp(24px, 4vw, 36px);
        font-weight: 820;
        letter-spacing: 0.06em;
        line-height: 1.2;
        word-break: break-all;
      }

      .copy-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
      }

      .copy-status {
        min-height: 24px;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }

      @media (max-width: 920px) {
        .page { grid-template-columns: 1fr; }
        .guide {
          min-height: auto;
          border-right: 0;
          border-bottom: 1px solid rgba(200, 208, 220, 0.72);
        }
        .panel { padding-top: 28px; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="guide">
        <div class="guide-inner">
          <p class="eyebrow">Genshin CN UID Binding</p>
          <h1>原神 UID 绑定</h1>
	          <p class="lead">用于每日签到、兑换码和后续抽卡记录读取。请使用米游社 App 扫码确认，后端只保存必要登录字段。</p>
	          <ol class="steps">
	            <li><span class="step-index">1</span><span>打开米游社 App 的扫一扫。</span></li>
	            <li><span class="step-index">2</span><span>扫描本页面二维码并在 App 内确认登录。</span></li>
	            <li><span class="step-index">3</span><span>页面验证通过后选择 UID，随后回 QQ 私聊发送确认命令。</span></li>
	          </ol>
        </div>
      </section>
      <section class="panel">
        <div class="shell">
          ${qq ? `<p class="qq">当前绑定 QQ：${qq}</p>` : ''}
          ${message ? `<p class="notice ${state === 'error' || state === 'invalid' ? 'is-error' : ''}">${message}</p>` : ''}
	          ${renderState({ state, token, submitPath, statusPath, qrImageDataUrl, confirmCommand, selectedRoleText, roles: options.roles ?? [] })}
        </div>
      </section>
    </main>
    <script>
	      function bindCopyButton() {
	        const button = document.querySelector('[data-copy-command]');
	        const status = document.querySelector('[data-copy-status]');
	        if (!button || !status) return;
	        button.addEventListener('click', async () => {
	          try {
	            await navigator.clipboard.writeText(button.getAttribute('data-copy-command') || '');
	            status.textContent = '已复制';
	          } catch {
	            status.textContent = '复制失败，请手动选择确认命令';
	          }
	        });
	      }
	      bindCopyButton();

	      const qrCard = document.querySelector('[data-qr-status-path]');
	      if (qrCard) {
	        const path = qrCard.getAttribute('data-qr-status-path') || '';
	        const status = document.querySelector('[data-qr-status]');
	        const shell = document.querySelector('.shell');
	        let stopped = false;
	        const poll = async () => {
	          if (stopped) return;
	          try {
	            const response = await fetch(path, { headers: { accept: 'application/json' } });
	            const payload = await response.json();
	            if (!response.ok || payload.kind === 'error') {
	              stopped = true;
	              if (status) status.textContent = payload.message || '扫码状态查询失败，请重新发送“原神绑定”。';
	              return;
	            }
	            if (payload.kind === 'pending' || payload.kind === 'scanned') {
	              if (status) status.textContent = payload.message || '';
	              return;
	            }
	            if (payload.kind === 'role_selection') {
	              stopped = true;
	              window.location.reload();
	              return;
	            }
	            if (payload.kind === 'success') {
	              stopped = true;
	              if (shell && typeof payload.html === 'string') {
	                shell.innerHTML = payload.html;
	                bindCopyButton();
	              }
	            }
	          } catch {
	            if (status) status.textContent = '扫码状态查询失败，稍后会继续重试。';
	          }
	        };
	        poll();
	        window.setInterval(poll, 2200);
	      }
    </script>
  </body>
</html>`;
}

function renderState(options: {
  state: GenshinBindPageOptions['state'];
  token: string;
  submitPath: string;
  statusPath: string;
  qrImageDataUrl: string;
  confirmCommand: string;
  selectedRoleText: string;
  roles: GenshinGameRole[];
}): string {
  if (options.state === 'invalid') {
    return '<p class="hint">请回到 QQ 私聊重新发送“原神绑定”获取新链接。</p>';
  }
  if (options.state === 'error') {
    return '<p class="hint">请刷新当前绑定页重试；如果仍然失败，请回到 QQ 私聊重新发送“原神绑定”。</p>';
  }
  if (options.state === 'success') {
    return renderGenshinBindSuccessFragment(options.confirmCommand, options.selectedRoleText);
  }
  if (options.state === 'role_selection') {
    return renderRoleSelection(options.token, options.submitPath, options.roles);
  }
  return renderQrLogin(options.statusPath, options.qrImageDataUrl);
}

function renderQrLogin(statusPath: string, qrImageDataUrl: string): string {
  return `<section class="qr-card" data-qr-status-path="${statusPath}">
    <img class="qr-image" src="${qrImageDataUrl}" alt="米游社扫码登录二维码">
    <p class="hint" data-qr-status>请使用米游社 App 扫描二维码。</p>
  </section>`;
}

function renderRoleSelection(token: string, submitPath: string, roles: GenshinGameRole[]): string {
  const roleOptions = roles.map((role, index) => {
    const key = escapeHtml(genshinRoleKey(role));
    const name = escapeHtml(role.nickname || '旅行者');
    const meta = escapeHtml(`UID ${role.uid} / ${role.regionName || role.region}${role.level == null ? '' : ` / Lv.${role.level}`}`);
    return `<label class="role-option">
      <input type="radio" name="selectedRoleKey" value="${key}" ${index === 0 ? 'checked' : ''}>
      <span><span class="role-name">${name}</span><span class="role-meta">${meta}</span></span>
    </label>`;
  }).join('');
  return `<form class="form" method="post" action="${submitPath}">
    <input type="hidden" name="token" value="${token}">
    <fieldset class="role-list">
      <legend><label>选择要绑定的原神 UID</label></legend>
      ${roleOptions}
    </fieldset>
    <p class="hint">一个 QQ 用户默认绑定一个 UID，重新绑定会替换旧 UID。</p>
    <button class="submit" type="submit">确认 UID</button>
  </form>`;
}

export function renderGenshinBindSuccessFragment(confirmCommand: string, selectedRoleText: string): string {
  return `<section class="success-card">
    <h2 class="success-title">扫码验证通过</h2>
    <p class="success-text">已选择 ${escapeHtml(selectedRoleText)}。请回到 QQ 私聊发送下面的确认命令完成绑定。</p>
    <code class="confirm-command">${confirmCommand}</code>
    <div class="copy-row">
      <button class="submit" type="button" data-copy-command="${confirmCommand}">复制确认命令</button>
      <span class="copy-status" data-copy-status></span>
    </div>
  </section>`;
}
