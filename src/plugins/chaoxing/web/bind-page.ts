export interface ChaoxingBindPageOptions {
  qq: string;
  token?: string;
  state: 'qr' | 'scanned' | 'pending' | 'success' | 'error' | 'invalid';
  imageDataUrl?: string;
  statusPath?: string;
  passwordSubmitPath?: string;
  confirmCode?: string;
  message?: string;
}

export function renderChaoxingBindPage(options: ChaoxingBindPageOptions): string {
  const qq = escapeHtml(options.qq);
  const token = escapeHtml(options.token ?? '');
  const state = options.state;
  const statusPath = JSON.stringify(options.statusPath ?? '');
  const submitPath = escapeHtml(options.passwordSubmitPath ?? '');
  const image = escapeHtml(options.imageDataUrl ?? '');
  const message = escapeHtml(options.message ?? '');
  const confirmCommand = escapeHtml(options.confirmCode ? `学习通确认 ${options.confirmCode}` : '');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>学习通绑定</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, "Noto Sans SC", "Microsoft YaHei", sans-serif; --blue:#3978f6; --text:#162033; --muted:#657188; --line:#dce3ee; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100svh; color:var(--text); background:linear-gradient(135deg,#eef4ff,#fff 48%,#f6f8fc); }
    main { width:min(1040px,calc(100% - 32px)); margin:0 auto; padding:48px 0; display:grid; grid-template-columns:1fr 1fr; gap:28px; }
    section { min-width:0; padding:32px; border:1px solid rgba(220,227,238,.92); border-radius:20px; background:rgba(255,255,255,.94); box-shadow:0 18px 60px rgba(42,65,110,.08); }
    h1,h2 { margin:0; } h1 { font-size:32px; } h2 { font-size:21px; }
    .lead,.muted { color:var(--muted); line-height:1.7; } .lead { margin:14px 0 28px; }
    .qr { display:block; width:min(100%,300px); margin:20px auto; border:1px solid var(--line); border-radius:14px; }
    .status { min-height:52px; padding:14px 16px; border-radius:12px; background:#f1f6ff; color:#244b9a; line-height:1.55; }
    .success { background:#eaf8f0; color:#17623b; }
    .error { background:#fff0ef; color:#a52a22; }
    code { display:block; margin-top:16px; padding:15px; border-radius:10px; background:#132039; color:#fff; font-size:17px; overflow-wrap:anywhere; }
    form { display:grid; gap:15px; margin-top:22px; }
    label { display:grid; gap:7px; font-weight:700; }
    input[type=text],input[type=password] { width:100%; border:1px solid var(--line); border-radius:10px; padding:12px 13px; font:inherit; outline:none; }
    input:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(57,120,246,.12); }
    .consent { grid-template-columns:20px 1fr; align-items:start; font-weight:500; color:#3f4b60; line-height:1.5; }
    button { border:0; border-radius:10px; padding:13px 18px; color:#fff; background:var(--blue); font:inherit; font-weight:800; cursor:pointer; }
    @media (max-width:760px) { main { grid-template-columns:1fr; padding:20px 0; } section { padding:24px; } }
  </style>
</head>
<body>
<main>
  <section>
    <h1>绑定学习通</h1>
    <p class="lead">QQ：${qq || '未知'}。推荐使用学习通 App 扫码；页面仅保存登录 Cookie。扫码会话过期后需要重新绑定。</p>
    ${renderPrimaryState(state, image, message, confirmCommand)}
  </section>
  <section>
    <h2>密码登录与自动续期</h2>
    <p class="muted">需要后台长期执行提醒、签到监听或刷课时，可授权机器人加密保存账号密码。凭据使用独立 KEK 加密。</p>
    ${state === 'success' ? '<p class="muted">本次登录已经完成，请回到 QQ 确认绑定。</p>' : `
    <form method="post" action="${submitPath}">
      <input type="hidden" name="token" value="${token}">
      <label>账号<input type="text" name="username" autocomplete="username" required></label>
      <label>密码<input type="password" name="password" autocomplete="current-password" required></label>
      <label class="consent"><input type="checkbox" name="persistCredentialConsent" value="yes"><span>可选：我授权机器人加密保存学习通账号密码，仅用于登录态自动续期。未勾选时只保存本次登录 Cookie。</span></label>
      <button type="submit">使用密码登录</button>
    </form>`}
  </section>
</main>
${renderPollingScript(state, statusPath)}
</body>
</html>`;
}

function renderPrimaryState(state: ChaoxingBindPageOptions['state'], image: string, message: string, confirmCommand: string): string {
  if (state === 'success') return `<div class="status success">登录成功。回到发起绑定的 QQ 会话发送：</div><code>${confirmCommand}</code>`;
  if (state === 'invalid') return `<div class="status error">${message || '绑定链接无效或已经过期。'}</div>`;
  if (state === 'error') return `<div class="status error">${message || '登录失败，请重试。'}</div>`;
  const text = state === 'scanned' ? '已扫码，请在学习通 App 内确认登录。' : state === 'pending' ? '正在验证登录，请稍候。' : '使用学习通 App 扫描二维码。';
  return `${image ? `<img class="qr" src="${image}" alt="学习通登录二维码">` : ''}<div class="status" id="bind-status">${message || text}</div>`;
}

function renderPollingScript(state: ChaoxingBindPageOptions['state'], statusPath: string): string {
  if (!['qr', 'scanned', 'pending'].includes(state) || statusPath === '""') return '';
  return `<script>
  const statusNode = document.getElementById('bind-status');
  async function poll() {
    try {
      const response = await fetch(${statusPath}, { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok || data.kind === 'error') { statusNode.textContent = data.message || '二维码状态查询失败。'; return; }
      if (data.kind === 'success') { window.location.reload(); return; }
      statusNode.textContent = data.message || '等待扫码确认。';
      setTimeout(poll, 2500);
    } catch { statusNode.textContent = '网络暂时不可用，正在重试。'; setTimeout(poll, 4000); }
  }
  setTimeout(poll, 1200);
  </script>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
