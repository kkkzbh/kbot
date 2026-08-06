import type { HbuJwSmsDevicePlatform } from '../types.js';

export interface AutomationPageOptions {
  platform: HbuJwSmsDevicePlatform;
  publicBaseUrl: string;
  ingestPath: string;
}

export function renderAutomationPage(options: AutomationPageOptions): string {
  const isIos = options.platform === 'ios';
  const platformName = isIos ? 'iPhone' : 'Android';
  const steps = isIos
    ? [
        '打开“快捷指令” →“自动化”→右上角“+”→“信息”。',
        '条件选择“信息包含”，填写“河北大学”；运行方式选择“立即运行”。',
        '在执行动作中搜索并添加“获取 URL 内容”。',
        'URL 粘贴下方回调地址；方法选择 POST；请求正文选择 JSON。',
        '新增字段 message，值选择“快捷指令输入”，然后保存自动化。',
      ]
    : [
        '安装一款支持 SMS → Webhook 的短信转发应用，并授予读取短信和后台运行权限。',
        '触发条件填写“河北大学”，仅转发包含该关键词的短信。',
        'Webhook 方法选择 POST，URL 粘贴下方回调地址。',
        '请求正文使用 JSON，字段名 message，字段值选择完整短信正文变量。',
        '关闭电池优化对该应用的限制，并发送测试请求确认返回 ok。',
      ];
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${platformName} 教务验证码自动化</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Noto Sans SC", sans-serif; color: #172033; background: #f3f7f5; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100svh; padding: 28px 16px; background: radial-gradient(circle at top, #dcefe6, #f7faf8 45%); }
      main { width: min(720px, 100%); margin: 0 auto; padding: clamp(24px, 6vw, 48px); border: 1px solid #d9e5df; border-radius: 22px; background: rgba(255,255,255,.95); box-shadow: 0 24px 70px rgba(27, 73, 51, .12); }
      .eyebrow { margin: 0 0 10px; color: #16714b; font-size: 14px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0; color: #142034; font-size: clamp(28px, 7vw, 42px); line-height: 1.15; }
      .lede { margin: 18px 0 26px; color: #596779; line-height: 1.7; }
      .callback { display: grid; gap: 12px; padding: 18px; border-radius: 14px; background: #edf7f2; }
      .callback label { color: #164f38; font-weight: 800; }
      code { display: block; overflow-wrap: anywhere; padding: 14px; border: 1px solid #c9ded3; border-radius: 10px; color: #143c2c; background: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.55; }
      button, .open { min-height: 48px; border: 0; border-radius: 10px; padding: 0 18px; color: #fff; background: #16714b; font-weight: 760; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; }
      .open { color: #16603f; background: #dcefe6; }
      .status { min-height: 24px; color: #596779; font-size: 14px; }
      h2 { margin: 30px 0 14px; font-size: 20px; }
      ol { margin: 0; padding-left: 24px; color: #344256; }
      li { padding: 7px 0; line-height: 1.65; }
      .warning { margin: 26px 0 0; padding: 14px 16px; border-left: 4px solid #16714b; color: #445265; background: #f4f8f6; line-height: 1.65; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">HBU JW · SMS Automation</p>
      <h1>${platformName} 验证码自动转发</h1>
      <p class="lede">学校发送验证码后，设备只转发短信正文；服务器提取唯一六位数字并提交到当前等待中的 CAS 登录事务。无需填写手机号。</p>
      <section class="callback">
        <label>专属回调地址</label>
        <code data-callback>正在生成…</code>
        <div class="actions">
          <button type="button" data-copy>复制回调地址</button>
          ${isIos ? '<a class="open" href="shortcuts://">打开快捷指令</a>' : ''}
        </div>
        <div class="status" data-status aria-live="polite"></div>
      </section>
      <h2>首次配置步骤</h2>
      <ol>${steps.map((step) => `<li>${step}</li>`).join('')}</ol>
      <p class="warning">回调地址等同于设备密钥，请勿转发给其他人。服务器不保存短信正文和验证码日志；没有等待中的教务登录事务时，请求会被拒绝。</p>
    </main>
    <script>
      const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
      const callback = token && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? ${JSON.stringify(options.publicBaseUrl + options.ingestPath + '/')} + token
        : '';
      const output = document.querySelector('[data-callback]');
      const copy = document.querySelector('[data-copy]');
      const status = document.querySelector('[data-status]');
      if (!callback) {
        output.textContent = '配置链接无效，请重新发送“教务自动化”。';
        copy.disabled = true;
      } else {
        output.textContent = callback;
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          status.textContent = '正在复制…';
          try {
            await navigator.clipboard.writeText(callback);
            status.textContent = '回调地址已复制。';
          } catch {
            status.textContent = '复制失败，请长按上方地址手动复制。';
          } finally {
            copy.disabled = false;
          }
        });
      }
    </script>
  </body>
</html>`;
}
