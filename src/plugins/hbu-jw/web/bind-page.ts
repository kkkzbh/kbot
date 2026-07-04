export interface BindPageOptions {
  backgroundImagePath: string;
  qq: string;
  token?: string;
  submitPath?: string;
  username?: string;
  persistCredentialConsent?: boolean;
  state?: 'form' | 'error' | 'invalid' | 'success';
  message?: string;
  confirmCode?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderBindPage(options: BindPageOptions): string {
  const backgroundImagePath = escapeHtml(options.backgroundImagePath);
  const qq = escapeHtml(options.qq);
  const token = escapeHtml(options.token ?? '');
  const submitPath = escapeHtml(options.submitPath ?? '');
  const username = escapeHtml(options.username ?? '');
  const state = options.state ?? 'form';
  const message = escapeHtml(options.message ?? '');
  const confirmCode = escapeHtml(options.confirmCode ?? '');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>教务系统账号绑定 - QQ Bot</title>
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
        --icon: #95a1b3;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100svh;
        color: var(--text);
        background: #f7fafc;
      }

      button,
      input {
        font: inherit;
      }

      .page {
        position: relative;
        display: grid;
        grid-template-columns: minmax(420px, 1fr) minmax(520px, 0.96fr);
        min-height: 100svh;
        overflow: hidden;
      }

      .visual {
        position: relative;
        min-height: 100svh;
        background:
          linear-gradient(90deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.32) 58%, rgba(255, 255, 255, 0.92) 100%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.82) 100%),
          url("${backgroundImagePath}") center / cover no-repeat;
      }

      .visual::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.62) 68%, #ffffff 100%),
          radial-gradient(circle at 35% 54%, rgba(255, 255, 255, 0) 0 34%, rgba(255, 255, 255, 0.46) 76%, rgba(255, 255, 255, 0.78) 100%);
      }

      .panel {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        padding: clamp(40px, 8vw, 96px);
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.66), #ffffff 19%);
      }

      .form-shell {
        width: min(100%, 640px);
        margin-top: -8px;
      }

      .headline {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 26px;
        margin-bottom: 42px;
      }

      .headline-icon {
        display: grid;
        width: 64px;
        height: 64px;
        place-items: center;
        color: var(--accent);
      }

      h1 {
        margin: 0;
        color: #142034;
        font-size: clamp(34px, 3.4vw, 48px);
        font-weight: 760;
        letter-spacing: 0;
        line-height: 1.15;
      }

      .notice {
        margin: 0 0 26px;
        padding: 16px 18px;
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

      .success-card {
        display: grid;
        gap: 18px;
        padding: 26px;
        border: 1px solid rgba(31, 138, 91, 0.24);
        border-radius: 16px;
        background: linear-gradient(180deg, #f3fbf7, #e5f4ed);
        box-shadow: 0 18px 48px rgba(31, 138, 91, 0.12);
      }

      .success-heading {
        display: flex;
        gap: 16px;
        align-items: center;
      }

      .success-icon {
        display: grid;
        flex: 0 0 auto;
        width: 46px;
        height: 46px;
        place-items: center;
        border-radius: 50%;
        color: #ffffff;
        background: var(--accent);
      }

      .success-title {
        margin: 0;
        color: #11263d;
        font-size: 24px;
        font-weight: 800;
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
        margin-top: 8px;
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

      .confirm-code {
        display: block;
        margin-top: 10px;
        color: #0f5f3d;
        font-size: 30px;
        font-weight: 800;
        letter-spacing: 0.08em;
      }

      .form {
        display: grid;
        gap: 24px;
      }

      .field {
        display: grid;
        gap: 12px;
      }

      label {
        color: #1b2537;
        font-size: 18px;
        font-weight: 700;
        line-height: 1.3;
      }

      .control {
        position: relative;
        display: flex;
        align-items: center;
      }

      .control-icon {
        position: absolute;
        left: 22px;
        display: grid;
        width: 22px;
        height: 22px;
        place-items: center;
        color: var(--icon);
        pointer-events: none;
      }

      .password-toggle {
        position: absolute;
        right: 18px;
        display: grid;
        width: 36px;
        height: 36px;
        place-items: center;
        border: 0;
        border-radius: 8px;
        color: var(--icon);
        background: transparent;
        cursor: pointer;
      }

      .password-toggle:hover,
      .password-toggle:focus-visible {
        color: var(--accent);
        background: rgba(31, 138, 91, 0.08);
      }

      .password-toggle:focus-visible {
        outline: 2px solid rgba(31, 138, 91, 0.36);
        outline-offset: 2px;
      }

      .password-toggle svg[hidden] {
        display: none;
      }

      input[type="text"],
      input[type="password"] {
        width: 100%;
        height: 70px;
        border: 1px solid var(--line-strong);
        border-radius: 12px;
        outline: none;
        color: #1a2435;
        background: rgba(255, 255, 255, 0.9);
        padding: 0 60px 0 62px;
        font-size: 18px;
        line-height: 1;
        transition:
          border-color 160ms ease,
          box-shadow 160ms ease,
          background 160ms ease;
      }

      input::placeholder {
        color: #9ba6b7;
      }

      input:focus {
        border-color: rgba(31, 138, 91, 0.65);
        background: #ffffff;
        box-shadow: 0 0 0 4px rgba(31, 138, 91, 0.1);
      }

      input[readonly] {
        color: #172033;
        cursor: default;
      }

      .qq-badge {
        position: absolute;
        left: 20px;
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 1px solid #f0c74d;
        border-radius: 50%;
        color: #101827;
        background: linear-gradient(180deg, #ffe680, #f7bd37);
        font-size: 10px;
        font-weight: 800;
      }

      .consent {
        display: grid;
        grid-template-columns: 22px 1fr;
        gap: 12px;
        align-items: start;
        color: #2f3b4f;
        font-size: 15px;
        line-height: 1.6;
      }

      .consent input {
        width: 20px;
        height: 20px;
        margin: 2px 0 0;
        accent-color: var(--accent);
      }

      .submit {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 74px;
        margin-top: 4px;
        border: 0;
        border-radius: 11px;
        color: #ffffff;
        background: linear-gradient(180deg, #2c9668, var(--accent-deep));
        box-shadow: 0 16px 34px rgba(31, 138, 91, 0.22);
        font-size: 21px;
        font-weight: 760;
        cursor: pointer;
      }

      .security {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: 16px;
        margin-top: 38px;
        color: #1c2a3d;
      }

      .security-icon {
        display: grid;
        flex: 0 0 auto;
        width: 34px;
        height: 34px;
        place-items: center;
        color: var(--accent);
      }

      .security-title {
        margin: 0;
        font-size: 18px;
        font-weight: 760;
        line-height: 1.3;
      }

      .security-text {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }

      @media (max-width: 980px) {
        .page {
          grid-template-columns: 1fr;
          min-height: 100svh;
        }

        .visual {
          position: absolute;
          inset: 0;
          min-height: auto;
          opacity: 0.2;
        }

        .panel {
          min-height: 100svh;
          padding: 48px 24px;
          background: rgba(255, 255, 255, 0.8);
        }
      }

      @media (max-width: 620px) {
        .panel {
          align-items: flex-start;
          padding: 42px 18px;
        }

        .headline {
          flex-direction: column;
          gap: 14px;
          margin-bottom: 32px;
          text-align: center;
        }

        h1 {
          font-size: 30px;
        }

        input[type="text"],
        input[type="password"] {
          height: 60px;
          border-radius: 10px;
          padding-right: 52px;
          padding-left: 54px;
          font-size: 16px;
        }

        .submit {
          height: 62px;
          font-size: 18px;
        }

        .security {
          justify-content: flex-start;
          margin-top: 32px;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="visual" aria-hidden="true"></section>
      <section class="panel">
        <div class="form-shell">
          <header class="headline">
            <span class="headline-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" width="64" height="64" fill="none">
                <path d="M32 6 52 14v15c0 13.6-8.1 24.5-20 29C20.1 53.5 12 42.6 12 29V14L32 6Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
                <path d="m23 32 6 6 13-15" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <h1>教务系统账号绑定</h1>
          </header>

          ${renderStateBlock(state, message, qq, confirmCode)}
          ${state === 'success' || state === 'invalid' ? '' : renderForm({ qq, token, submitPath, username, persistCredentialConsent: options.persistCredentialConsent ?? false })}

          <section class="security" aria-label="安全说明">
            <span class="security-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="34" height="34" fill="none">
                <path d="M16 4 26 8v7.5C26 22.2 22 27 16 29 10 27 6 22.2 6 15.5V8l10-4Z" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/>
                <path d="m11 16 3.3 3.3L21.5 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <p class="security-title">密码加密保存</p>
              <p class="security-text">仅用于教务 session 自动刷新，解绑时会撤销保存的凭据。</p>
            </div>
          </section>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderStateBlock(state: 'form' | 'error' | 'invalid' | 'success', message: string, qq: string, confirmCode: string): string {
  if (state === 'success') {
    return `<section class="success-card" aria-live="polite">
              <div class="success-heading">
                <span class="success-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
                    <path d="m5 12 4 4 10-10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </span>
                <div>
                  <p class="success-title">教务登录验证成功</p>
                  <p class="success-text">你可以直接关闭这个页面。</p>
                </div>
              </div>
              <p class="success-text">
                请回到刚才发起绑定的聊天，由 QQ ${qq} 发送下面这条消息完成绑定：
                <span class="confirm-command">教务确认 ${confirmCode}</span>
              </p>
            </section>`;
  }
  if (state === 'error' || state === 'invalid') {
    return `<p class="notice is-error">${message}</p>`;
  }
  return '';
}

function renderForm(options: { qq: string; token: string; submitPath: string; username: string; persistCredentialConsent: boolean }): string {
  return `<form class="form" method="post" action="${options.submitPath}" autocomplete="on">
            <input type="hidden" name="token" value="${options.token}">
            <div class="field">
              <label for="username">教务账号</label>
              <div class="control">
                <span class="control-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                    <path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                    <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.9"/>
                  </svg>
                </span>
                <input id="username" name="username" type="text" inputmode="numeric" autocomplete="username" value="${options.username}" placeholder="请输入教务系统账号" required>
              </div>
            </div>

            <div class="field">
              <label for="password">教务密码</label>
              <div class="control">
                <span class="control-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                    <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.9"/>
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                  </svg>
                </span>
                <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入教务系统密码" required>
                <button class="password-toggle" type="button" data-password-toggle aria-label="显示密码" aria-pressed="false">
                  <svg data-eye-open viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
                    <path d="M3 12s3.4-5.5 9-5.5S21 12 21 12s-3.4 5.5-9 5.5S3 12 3 12Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
                    <circle cx="12" cy="12" r="2.4" stroke="currentColor" stroke-width="1.9"/>
                  </svg>
                  <svg data-eye-closed viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true" hidden>
                    <path d="M3 12s3.4-5.5 9-5.5S21 12 21 12s-3.4 5.5-9 5.5S3 12 3 12Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
                    <path d="M4 4 20 20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
            </div>

            <div class="field">
              <label for="qq">绑定 QQ 号</label>
              <div class="control">
                <span class="qq-badge" aria-hidden="true">QQ</span>
                <input id="qq" name="qqDisplay" type="text" value="${options.qq}" readonly>
              </div>
            </div>

            <label class="consent">
              <input type="checkbox" name="persistCredentialConsent" value="yes" required${options.persistCredentialConsent ? ' checked' : ''}>
              <span>我授权机器人加密保存教务账号密码，仅用于教务登录态失效后的自动重新登录。</span>
            </label>

            <button class="submit" type="submit">绑定教务</button>
          </form>
          <script>
            (() => {
              const password = document.getElementById('password');
              const toggle = document.querySelector('[data-password-toggle]');
              const eyeOpen = toggle?.querySelector('[data-eye-open]');
              const eyeClosed = toggle?.querySelector('[data-eye-closed]');
              if (!password || !toggle || !eyeOpen || !eyeClosed) return;
              toggle.addEventListener('click', () => {
                const nextVisible = password.type === 'password';
                password.type = nextVisible ? 'text' : 'password';
                toggle.setAttribute('aria-pressed', String(nextVisible));
                toggle.setAttribute('aria-label', nextVisible ? '隐藏密码' : '显示密码');
                eyeOpen.toggleAttribute('hidden', nextVisible);
                eyeClosed.toggleAttribute('hidden', !nextVisible);
              });
            })();
          </script>`;
}
