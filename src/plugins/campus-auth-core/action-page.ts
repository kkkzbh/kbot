import type { CampusLocationActionPrepared } from './types.js';

export interface CampusLocationActionPageProps {
  providerLabel: string;
  token?: string;
  preparePath?: string;
  commitPath?: string;
  state: 'locate' | 'pending' | 'ready' | 'completed' | 'invalid';
  prepared?: CampusLocationActionPrepared;
  message?: string;
}

export function renderCampusLocationActionPage(props: CampusLocationActionPageProps): string {
  const title = props.prepared?.title || props.providerLabel;
  const details = props.prepared?.details ?? [];
  const content = props.state === 'locate'
    ? `<p>请授权浏览器读取手机当前定位。系统会校验活动、操作类型和签到范围。</p>
       ${messageBlock(props.message)}
       ${locationForm(props.preparePath, props.token, '获取定位并校验')}`
    : props.state === 'ready'
      ? `<div class="summary"><h2>${escapeHtml(title)}</h2>${details.map((item) => `<p>${escapeHtml(item)}</p>`).join('')}</div>
         ${messageBlock(props.message)}
         <p class="warning">确认后将立即执行${escapeHtml(props.prepared?.actionLabel ?? '操作')}。提交时会再次读取定位并复核活动范围。</p>
         ${locationForm(props.commitPath, props.token, `确认${props.prepared?.actionLabel ?? '提交'}`, true)}`
      : props.state === 'pending'
        ? '<p>正在校验或提交，请稍候……</p><script>setTimeout(function(){location.reload()},1200)</script>'
        : props.state === 'completed'
          ? `<div class="success"><h2>操作完成</h2><p>${escapeHtml(props.message ?? '已完成。')}</p></div>`
          : `<div class="error"><h2>链接不可用</h2><p>${escapeHtml(props.message ?? '请回到机器人重新发起。')}</p></div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(props.providerLabel)}定位确认</title>
  <style>
    :root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f7fb;color:#172033}
    body{margin:0;padding:24px 16px}.card{max-width:560px;margin:5vh auto;background:#fff;border:1px solid #dce5f1;border-radius:18px;padding:24px;box-shadow:0 12px 32px #31577d18}
    h1{font-size:22px;margin:0 0 8px}h2{font-size:18px;margin:0 0 12px}p{line-height:1.65;margin:10px 0}.muted{color:#66758b;font-size:14px}.summary,.success,.error{border-radius:12px;padding:16px;background:#f5f8fc}.success{background:#edf9f1;color:#176739}.error,.message{background:#fff2f1;color:#a12b22}.message{border-radius:10px;padding:10px 12px}.warning{color:#7b4c08;background:#fff8e8;border-radius:10px;padding:10px 12px}
    button{width:100%;border:0;border-radius:11px;padding:13px 16px;margin-top:14px;background:#287cf5;color:#fff;font-size:16px;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:wait}#client-error{color:#a12b22}
  </style>
</head>
<body><main class="card"><h1>${escapeHtml(props.providerLabel)}定位确认</h1><p class="muted">一次性链接 · 坐标不写入数据库 · 请勿转发</p>${content}</main>
<script>
for(const form of document.querySelectorAll('form[data-location-form]')){
  form.addEventListener('submit',function(event){
    event.preventDefault();
    const button=form.querySelector('button');
    const error=document.getElementById('client-error');
    button.disabled=true;button.textContent='正在获取定位…';error.textContent='';
    if(!navigator.geolocation){error.textContent='当前浏览器不支持定位，请使用手机系统浏览器打开。';button.disabled=false;return}
    navigator.geolocation.getCurrentPosition(function(position){
      form.elements.latitude.value=String(position.coords.latitude);
      form.elements.longitude.value=String(position.coords.longitude);
      form.elements.accuracy.value=String(position.coords.accuracy);
      button.textContent='正在提交…';form.submit();
    },function(locationError){
      const messages={1:'定位权限被拒绝，请在浏览器设置中允许定位。',2:'暂时无法获取位置，请确认手机定位服务已开启。',3:'获取定位超时，请到开阔位置后重试。'};
      error.textContent=messages[locationError.code]||'获取定位失败，请重试。';button.disabled=false;button.textContent=button.dataset.label;
    },{enableHighAccuracy:true,maximumAge:0,timeout:15000});
  });
}
</script></body></html>`;
}

function locationForm(path: string | undefined, token: string | undefined, label: string, commit = false): string {
  if (!path || !token) return '';
  return `<form method="post" action="${escapeHtml(path)}" data-location-form>
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="hidden" name="latitude"><input type="hidden" name="longitude"><input type="hidden" name="accuracy">
    <p id="client-error" role="alert"></p>
    <button type="submit" data-label="${escapeHtml(label)}"${commit ? ' class="commit"' : ''}>${escapeHtml(label)}</button>
  </form>`;
}

function messageBlock(message: string | undefined): string {
  return message ? `<p class="message">${escapeHtml(message)}</p>` : '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}
