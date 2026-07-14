export interface CampusAppBridgePageOptions {
  providerLabel: string;
  token?: string;
  submitPath?: string;
  returnPath?: string;
  state?: 'ready' | 'invalid';
  message?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderCampusAppBridgePage(options: CampusAppBridgePageOptions): string {
  const state = options.state ?? 'ready';
  const title = `${options.providerLabel} App 授权`;
  const body = state === 'invalid'
    ? `<p class="status error">${escapeHtml(options.message ?? '授权链接无效。')}</p>`
    : `<p class="lead">请确认本页由志愿汇 App 的“扫一扫”打开，然后点击授权。页面只会把一次性临时码提交给 QQBot，不会显示或保存该临时码。</p>
       <button type="button" data-start-bridge>调用志愿汇 App 授权</button>
       <p class="status" data-bridge-status aria-live="polite">等待调用 App Bridge。</p>
       <details><summary>测试结果说明</summary><ul><li>提示“未检测到 Bridge”：扫码页面被外部浏览器打开，或 QQBot 域名未获准使用 Bridge。</li><li>提示“未收到回调”：Bridge 方法可调用，但 App 没有返回临时码。</li><li>验证成功后会自动进入带复制按钮的二课确认页面。</li></ul></details>`;

  const script = state === 'ready'
    ? `<script>
    (() => {
      const token = ${JSON.stringify(options.token ?? '')};
      const submitPath = ${JSON.stringify(options.submitPath ?? '')};
      const returnPath = ${JSON.stringify(options.returnPath ?? '')};
      const button = document.querySelector('[data-start-bridge]');
      const status = document.querySelector('[data-bridge-status]');
      let waiting = false;
      let callbackReceived = false;
      let timeoutId;

      const setStatus = (message, isError = false) => {
        status.textContent = message;
        status.classList.toggle('error', isError);
      };

      const finishAttempt = () => {
        waiting = false;
        button.disabled = false;
        if (timeoutId) window.clearTimeout(timeoutId);
      };

      window.getTempUserCodeCallback = async (code) => {
        callbackReceived = true;
        if (typeof code !== 'string' || !code.trim()) {
          finishAttempt();
          setStatus('志愿汇 App 返回了空的临时码。', true);
          return;
        }
        setStatus('已收到 App 回调，正在验证二课账号。');
        try {
          const response = await fetch(submitPath, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ token, code }).toString(),
          });
          const payload = await response.json();
          if (!response.ok || payload.ok !== true) throw new Error(payload.message || '二课授权验证失败。');
          setStatus('授权验证成功，正在进入确认页面。');
          window.location.replace(returnPath);
        } catch (error) {
          finishAttempt();
          setStatus(error instanceof Error ? error.message : '二课授权验证失败。', true);
        }
      };

      button.addEventListener('click', () => {
        if (waiting) return;
        waiting = true;
        callbackReceived = false;
        button.disabled = true;
        setStatus('正在调用志愿汇 App Bridge。');
        try {
          if (window.android && typeof window.android.getTempUserCode === 'function') {
            window.android.getTempUserCode();
          } else if (window.webkit?.messageHandlers?.getTempUserCode) {
            window.webkit.messageHandlers.getTempUserCode.postMessage('');
          } else if (window.harmony && typeof window.harmony.getTempUserCode === 'function') {
            window.harmony.getTempUserCode();
          } else {
            finishAttempt();
            setStatus('未检测到志愿汇 getTempUserCode Bridge。请确认使用志愿汇“扫一扫”打开，QQBot 域名也可能未获授权。', true);
            return;
          }
          timeoutId = window.setTimeout(() => {
            if (callbackReceived) return;
            finishAttempt();
            setStatus('Bridge 已调用，但 8 秒内未收到 getTempUserCodeCallback。', true);
          }, 8000);
        } catch (error) {
          finishAttempt();
          setStatus(error instanceof Error ? error.message : '调用志愿汇 App Bridge 失败。', true);
        }
      });
    })();
  </script>`
    : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,"Noto Sans SC","Microsoft YaHei",sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0;padding:24px 14px}.card{width:min(620px,100%);margin:auto;padding:26px;border:1px solid #dce2eb;border-radius:18px;background:#fff;box-shadow:0 16px 50px rgba(20,32,52,.08)}h1{margin:0 0 10px;font-size:27px}.lead,details{color:#5f6d82;line-height:1.7}button{width:100%;min-height:50px;border:0;border-radius:12px;background:#176b4b;color:#fff;font:inherit;font-weight:800;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.status{margin:16px 0 0;padding:15px;border-radius:12px;background:#eef3f8;line-height:1.6}.status.error{background:#fff0ef;color:#a8241b}details{margin-top:20px}li+li{margin-top:8px}@media(max-width:520px){body{padding:12px}.card{padding:20px}}
  </style></head><body><main class="card"><h1>${escapeHtml(title)}</h1>${body}</main>${script}</body></html>`;
}
