export interface BindPageOptions {
  backgroundImagePath: string;
  qq: string;
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
        --accent-soft: #e7f4ee;
        --icon: #95a1b3;
        --shadow: 0 22px 80px rgba(31, 48, 76, 0.08);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        min-height: 100%;
      }

      body {
        margin: 0;
        min-height: 100svh;
        color: var(--text);
        background:
          linear-gradient(90deg, rgba(232, 241, 247, 0.9), rgba(255, 255, 255, 0.88) 45%, #ffffff 64%),
          #f7fafc;
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
        pointer-events: none;
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
        margin-bottom: 52px;
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

      .form {
        display: grid;
        gap: 26px;
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

      .control-action {
        position: absolute;
        right: 22px;
        display: grid;
        width: 22px;
        height: 22px;
        place-items: center;
        color: var(--icon);
      }

      input {
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
        letter-spacing: 0;
        pointer-events: none;
      }

      .submit {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 74px;
        margin-top: 8px;
        border: 0;
        border-radius: 11px;
        color: #ffffff;
        background: linear-gradient(180deg, #2c9668, var(--accent-deep));
        box-shadow: 0 16px 34px rgba(31, 138, 91, 0.22);
        font-size: 21px;
        font-weight: 760;
        letter-spacing: 0;
        cursor: default;
      }

      .security {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: 16px;
        margin-top: 44px;
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
          background:
            linear-gradient(180deg, rgba(244, 249, 252, 0.94), rgba(255, 255, 255, 0.96) 34%, #ffffff 100%);
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
          margin-bottom: 36px;
          text-align: center;
        }

        .headline-icon {
          width: 54px;
          height: 54px;
        }

        h1 {
          font-size: 30px;
        }

        .form {
          gap: 21px;
        }

        label {
          font-size: 16px;
        }

        input {
          height: 60px;
          border-radius: 10px;
          padding-right: 52px;
          padding-left: 54px;
          font-size: 16px;
        }

        .control-icon {
          left: 18px;
          width: 20px;
          height: 20px;
        }

        .control-action {
          right: 18px;
          width: 20px;
          height: 20px;
        }

        .qq-badge {
          left: 16px;
          width: 26px;
          height: 26px;
          font-size: 9px;
        }

        .submit {
          height: 62px;
          font-size: 18px;
        }

        .security {
          justify-content: flex-start;
          margin-top: 32px;
        }

        .security-text {
          font-size: 14px;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="visual" aria-hidden="true">
      </section>
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

          <form class="form" autocomplete="on">
            <div class="field">
              <label for="student-id">教务账号</label>
              <div class="control">
                <span class="control-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                    <path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                    <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.9"/>
                  </svg>
                </span>
                <input id="student-id" name="studentId" type="text" inputmode="numeric" autocomplete="username" placeholder="请输入教务系统账号">
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
                <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入教务系统密码">
                <span class="control-action" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                    <path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
                    <path d="m4 4 16 16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                  </svg>
                </span>
              </div>
            </div>

            <div class="field">
              <label for="qq">绑定 QQ 号</label>
              <div class="control">
                <span class="qq-badge" aria-hidden="true">QQ</span>
                <input id="qq" name="qq" type="text" value="${qq}" readonly>
              </div>
            </div>

            <button class="submit" type="button">绑定教务</button>
          </form>

          <section class="security" aria-label="安全说明">
            <span class="security-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="34" height="34" fill="none">
                <path d="M16 4 26 8v7.5C26 22.2 22 27 16 29 10 27 6 22.2 6 15.5V8l10-4Z" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/>
                <path d="m11 16 3.3 3.3L21.5 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <p class="security-title">密码不存储</p>
              <p class="security-text">仅用于本次登录验证，验证完成后立即丢弃。</p>
            </div>
          </section>
        </div>
      </section>
    </main>
  </body>
</html>`;
}
