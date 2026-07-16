export interface GenshinStatusVerificationPageOptions {
  state: 'pending' | 'success' | 'error' | 'invalid';
  token?: string;
  submitPath?: string;
  gt?: string;
  challenge?: string;
  message?: string;
}

export function renderGenshinStatusVerificationPage(options: GenshinStatusVerificationPageOptions): string {
  const message = escapeHtml(options.message ?? '');
  const pending = options.state === 'pending';
  const config = safeJson({
    token: options.token ?? '',
    submitPath: options.submitPath ?? '',
    gt: options.gt ?? '',
    challenge: options.challenge ?? '',
  });
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>原神实时便笺验证</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
        --ink: #172033;
        --muted: #667085;
        --gold: #b68a42;
        --gold-deep: #8f6728;
        --line: rgba(182, 138, 66, 0.28);
      }
      * { box-sizing: border-box; }
      body {
        display: grid;
        min-height: 100svh;
        margin: 0;
        place-items: center;
        padding: 24px;
        color: var(--ink);
        background:
          radial-gradient(circle at 18% 12%, rgba(124, 189, 200, 0.24), transparent 34%),
          radial-gradient(circle at 84% 88%, rgba(223, 181, 106, 0.25), transparent 38%),
          linear-gradient(145deg, #edf6f6, #f8f4eb 54%, #f3ead9);
      }
      .card {
        width: min(100%, 520px);
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.8);
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 28px 80px rgba(48, 58, 75, 0.16);
        backdrop-filter: blur(18px);
      }
      .hero {
        padding: 30px 32px 26px;
        color: #fff;
        background:
          linear-gradient(120deg, rgba(20, 53, 77, 0.96), rgba(38, 91, 105, 0.9)),
          #173b51;
      }
      .eyebrow { margin: 0 0 9px; color: #f2d69c; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(27px, 7vw, 36px); line-height: 1.2; }
      .hero p { margin: 12px 0 0; color: rgba(255, 255, 255, 0.78); line-height: 1.7; }
      .content { display: grid; gap: 20px; padding: 30px 32px 34px; }
      .notice { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.75; }
      .notice strong { color: var(--ink); }
      .captcha-shell { min-height: 48px; padding: 16px; border: 1px solid var(--line); border-radius: 14px; background: #fffdf8; }
      .status { min-height: 24px; margin: 0; color: var(--gold-deep); font-size: 14px; line-height: 1.65; }
      .verify-button { min-height: 48px; border: 0; border-radius: 12px; color: #fff; background: linear-gradient(135deg, var(--gold), var(--gold-deep)); font: inherit; font-weight: 800; cursor: pointer; }
      .verify-button:disabled { cursor: wait; opacity: .58; }
      .result { padding: 20px; border: 1px solid var(--line); border-radius: 15px; background: #fffaf0; }
      .result h2 { margin: 0 0 10px; font-size: 21px; }
      .result p { margin: 0; color: var(--muted); line-height: 1.75; }
      .error { color: #a43b32; background: #fff4f2; border-color: rgba(164, 59, 50, .24); }
      @media (max-width: 520px) { .hero, .content { padding-left: 22px; padding-right: 22px; } }
    </style>
    ${pending ? '<script src="https://static.geetest.com/static/js/gt.0.5.2.js"></script>' : ''}
  </head>
  <body>
    <main class="card">
      <header class="hero">
        <p class="eyebrow">Genshin Daily Note</p>
        <h1>实时便笺安全验证</h1>
        <p>该验证由米游社提供，用于确认本次状态查询由本人发起。</p>
      </header>
      <section class="content">
        ${renderState(options, message)}
      </section>
    </main>
    ${pending ? `<script>
      const config = ${config};
      const status = document.querySelector('[data-status]');
      const form = document.querySelector('[data-form]');
      const validateInput = document.querySelector('[data-validate]');
      const verifyButton = document.querySelector('[data-verify]');
      function fail(message) { if (status) status.textContent = message; }
      if (typeof window.initGeetest !== 'function') {
        fail('验证组件加载失败，请检查网络后刷新页面。');
      } else {
        window.initGeetest({
          gt: config.gt,
          challenge: config.challenge,
          protocol: 'https://',
          offline: false,
          new_captcha: true,
          product: 'bind',
          api_server: 'api.geetest.com',
          lang: 'zh-cn'
        }, (captcha) => {
          captcha.onReady(() => {
            verifyButton.disabled = false;
            verifyButton.addEventListener('click', () => captcha.verify());
            fail('验证组件已就绪。');
            captcha.verify();
          });
          captcha.onError(() => fail('验证组件出现错误，请刷新页面重试。'));
          captcha.onSuccess(() => {
            const result = captcha.getValidate();
            if (!result || !result.geetest_validate) {
              fail('未取得有效验证结果，请重新验证。');
              return;
            }
            validateInput.value = result.geetest_validate;
            fail('验证通过，正在提交…');
            form.submit();
          });
        });
      }
    </script>` : ''}
  </body>
</html>`;
}

function renderState(options: GenshinStatusVerificationPageOptions, message: string): string {
  if (options.state === 'pending') {
    const submitPath = escapeHtml(options.submitPath ?? '');
    const token = escapeHtml(options.token ?? '');
    return `<p class="notice"><strong>请完成本次验证。</strong>验证通过后回到 QQ，再发送“原神状态”。链接 10 分钟内有效。</p>
      <button class="verify-button" type="button" data-verify disabled>开始人机验证</button>
      <p class="status" data-status>正在加载验证组件…</p>
      <form method="post" action="${submitPath}" data-form>
        <input type="hidden" name="token" value="${token}">
        <input type="hidden" name="validate" value="" data-validate>
      </form>`;
  }
  if (options.state === 'success') {
    return '<section class="result"><h2>验证完成</h2><p>请回到 QQ，重新发送“原神状态”。机器人会继续查询并返回状态卡片。</p></section>';
  }
  return `<section class="result error"><h2>${options.state === 'invalid' ? '链接无效' : '验证未完成'}</h2><p>${message || '请回到 QQ 重新发送“原神状态”获取新的验证链接。'}</p></section>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}
