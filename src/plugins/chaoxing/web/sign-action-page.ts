import type { ChaoxingSignActionPageState } from '../sign-action-service.js';
import { signTypeLabel, type ChaoxingSignType } from '../sign-service.js';

export interface RenderChaoxingSignActionPageProps {
  token: string;
  submitPath: string;
  nonce: string;
  state?: ChaoxingSignActionPageState;
  message?: string;
}

export function renderChaoxingSignActionPage(props: RenderChaoxingSignActionPageProps): string {
  const action = props.state?.action;
  const metadata = props.state?.metadata;
  const active = action?.status === 'created';
  const status = action?.status ?? 'invalid';
  const title = action?.activityTitle || '学习通签到';
  const message = props.message || action?.errorMessage || terminalMessage(props.state);
  const clientConfig = JSON.stringify({
    token: props.token,
    submitPath: props.submitPath,
    signType: action?.signType ?? '',
    needsLocation: Boolean(metadata?.targetLocation && action?.signType === 'qrcode'),
  }).replace(/</gu, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#647089;--line:#dce3ef;--blue:#2367e8;--blue2:#1552c2;--soft:#eef4ff;--ok:#087f5b;--warn:#b45309;--bad:#b42318}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 10% 0,#dfeaff 0,transparent 34%),linear-gradient(160deg,#f8faff,#edf2f8);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;color:var(--ink)}
    main{width:min(100% - 28px,620px);margin:0 auto;padding:28px 0 calc(36px + env(safe-area-inset-bottom))}.card{background:rgba(255,255,255,.94);border:1px solid rgba(210,220,236,.9);border-radius:24px;box-shadow:0 18px 50px rgba(39,65,105,.14);overflow:hidden}
    header{padding:24px 24px 20px;background:linear-gradient(135deg,#1c5ddd,#337cf5);color:#fff}.eyebrow{font-size:13px;opacity:.82;letter-spacing:.08em}.title{font-size:25px;font-weight:750;margin:8px 0 4px;overflow-wrap:anywhere}.course{font-size:14px;opacity:.88}.body{padding:22px 24px 26px}.row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}.pill{font-size:13px;padding:6px 10px;border-radius:999px;background:var(--soft);color:#285cae}.deadline{color:var(--muted);font-size:13px;padding-top:7px}
    .notice,.target,.status{border-radius:14px;padding:13px 14px;font-size:14px;line-height:1.55;margin:14px 0}.notice{background:#fff7e8;color:#7c4700;border:1px solid #f3d39d}.target{background:#f1f7ff;color:#244a7c;border:1px solid #cfe0fa}.status{background:#f5f7fb;border:1px solid var(--line);color:var(--ink)}.status.error{background:#fff2f0;border-color:#ffc9c2;color:var(--bad)}
    label{display:block;font-weight:650;margin:18px 0 8px}input[type=text],textarea{width:100%;border:1px solid #cbd5e4;border-radius:13px;padding:13px 14px;font:inherit;color:var(--ink);background:#fff}textarea{min-height:88px;resize:vertical}.file{display:block;width:100%;padding:15px;border:1px dashed #9cb5d8;border-radius:14px;background:#f8fbff}
    .camera{margin-top:16px;padding:14px;border:1px solid var(--line);border-radius:16px;background:#0d1422}.camera video{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:12px;background:#070b12}.camera canvas{display:none}.camera-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.camera-actions button{margin-top:10px}.camera-actions .wide{grid-column:1/-1}
    .gesture-board{display:block;width:min(100%,360px);margin:16px auto 8px;border-radius:20px;background:linear-gradient(145deg,#f2f6fd,#e5edf9);touch-action:none;user-select:none}.gesture-board line{stroke:var(--blue);stroke-width:14;stroke-linecap:round;opacity:.68}.gesture-board circle{fill:#fff;stroke:#8096b8;stroke-width:5}.gesture-board circle.selected{fill:var(--blue);stroke:#164fae}.gesture-board text{font-size:22px;font-weight:750;fill:#58708f;text-anchor:middle;dominant-baseline:central;pointer-events:none}.gesture-board circle.selected+text{fill:#fff}.gesture-sequence{display:block;min-height:24px;text-align:center;color:var(--muted);font-size:14px}.gesture-actions{display:grid;grid-template-columns:1fr 2fr;gap:10px}.gesture-actions button{margin-top:10px}
    button{width:100%;border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:700;cursor:pointer;background:var(--blue);color:#fff;margin-top:12px}button:hover{background:var(--blue2)}button.secondary{background:#edf2fa;color:#29466d}button:disabled{opacity:.56;cursor:wait}.hint{color:var(--muted);font-size:13px;line-height:1.6;margin:9px 0}.terminal{text-align:center;padding:22px 2px}.terminal .mark{font-size:42px}.footer{margin-top:18px;color:var(--muted);font-size:12px;line-height:1.65;text-align:center}
  </style>
</head>
<body>
<main>
  <section class="card">
    <header><div class="eyebrow">CHAOXING SIGN ACTION</div><div class="title">${escapeHtml(title)}</div><div class="course">${escapeHtml(action?.courseName || '活动级签到链接')}</div></header>
    <div class="body">
      ${action ? `<div class="row"><span class="pill">${escapeHtml(signTypeLabel(action.signType as ChaoxingSignType))}</span><span class="pill">活动 ID ${escapeHtml(action.activityId)}</span><span class="deadline">链接有效至 ${escapeHtml(formatDate(action.expiresAt))}</span></div>` : ''}
      <div class="notice">持有此链接的人可以为该绑定账号完成本次签到。请只转发给可信任的现场协助者；页面不会显示账号、学号或登录信息。</div>
      ${metadata?.targetLocation ? `<div class="target"><strong>签到范围</strong><br>${escapeHtml(metadata.targetLocation.text)}<br>距离目标点 ${Math.round(metadata.targetLocation.rangeMeters)} 米内</div>` : ''}
      <div id="status" class="status${props.message ? ' error' : ''}" ${message ? '' : 'hidden'}>${escapeHtml(message)}</div>
      ${active ? actionForm(action.signType as ChaoxingSignType, Boolean(metadata?.dynamicQr)) : terminal(status)}
      ${active ? '<button id="share" type="button" class="secondary">转发此签到链接</button>' : ''}
    </div>
  </section>
  <div class="footer">服务端会实时复查活动、提交签到，并以学习通官方签到状态确认结果。链接只对应当前活动，成功后自动失效。</div>
</main>
<script nonce="${escapeHtml(props.nonce)}">
const cfg=${clientConfig};
const statusBox=document.getElementById('status');
const buttons=()=>[...document.querySelectorAll('button')];
let pageBusy=false;
function show(message,error=true){statusBox.textContent=message;statusBox.hidden=false;statusBox.classList.toggle('error',error)}
function busy(value){pageBusy=value;buttons().forEach(button=>button.disabled=value);if(!value){syncCameraControls();syncGesture()}}
async function currentLocation(){
  if(!navigator.geolocation)throw new Error('当前浏览器不支持定位。');
  return await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(
    ({coords})=>resolve({latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy}),
    ()=>reject(new Error('无法获取当前位置，请允许浏览器定位权限后重试。')),
    {enableHighAccuracy:true,timeout:15000,maximumAge:0}
  ));
}
async function submitJson(payload){
  const response=await fetch(cfg.submitPath,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:cfg.token,...payload})});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.message||'签到提交失败。');return data;
}
async function submitImage(file,location){
  if(!file)throw new Error('请先拍摄或选择图片。');
  const query=new URLSearchParams({token:cfg.token});
  if(location)Object.entries(location).forEach(([key,value])=>query.set(key,String(value)));
  const response=await fetch(cfg.submitPath+'?'+query,{method:'POST',headers:{'content-type':file.type,'x-file-name':encodeURIComponent(file.name||'capture.jpg')},body:file});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.message||'签到提交失败。');return data;
}
let cameraStream=null;
const cameraVideo=document.getElementById('qr-video');
const cameraCanvas=document.getElementById('qr-canvas');
const cameraStart=document.getElementById('qr-camera-start');
const cameraCapture=document.getElementById('qr-camera-capture');
const cameraStop=document.getElementById('qr-camera-stop');
function syncCameraControls(){if(cameraStart)cameraStart.disabled=pageBusy||Boolean(cameraStream);if(cameraCapture)cameraCapture.disabled=pageBusy||!cameraStream;if(cameraStop)cameraStop.disabled=pageBusy||!cameraStream}
function stopCamera(){if(cameraStream){cameraStream.getTracks().forEach(track=>track.stop());cameraStream=null}if(cameraVideo)cameraVideo.srcObject=null;syncCameraControls()}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器无法直接调用摄像头，请使用支持 HTTPS 摄像头权限的浏览器。');
  stopCamera();
  try{
    cameraStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
    cameraVideo.srcObject=cameraStream;
    await cameraVideo.play();
    syncCameraControls();
  }catch(error){
    stopCamera();
    if(error?.name==='NotAllowedError')throw new Error('摄像头权限被拒绝，请在浏览器设置中允许后重试。');
    if(error?.name==='NotFoundError')throw new Error('没有检测到可用摄像头。');
    throw new Error('无法启动摄像头，请检查浏览器权限和设备占用情况。');
  }
}
async function captureCameraFrame(){
  if(!cameraStream||!cameraVideo?.videoWidth||!cameraVideo?.videoHeight)throw new Error('摄像头画面尚未准备好，请稍候重试。');
  cameraCanvas.width=cameraVideo.videoWidth;
  cameraCanvas.height=cameraVideo.videoHeight;
  cameraCanvas.getContext('2d').drawImage(cameraVideo,0,0,cameraCanvas.width,cameraCanvas.height);
  return await new Promise((resolve,reject)=>cameraCanvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法读取当前摄像头画面。')),'image/jpeg',.92));
}
const gestureBoard=document.getElementById('gesture-board');
const gestureLines=document.getElementById('gesture-lines');
const gestureSequence=document.getElementById('gesture-sequence');
const gestureSubmit=document.getElementById('gesture-submit');
const gesturePoints={1:[50,50],2:[150,50],3:[250,50],4:[50,150],5:[150,150],6:[250,150],7:[50,250],8:[150,250],9:[250,250]};
let gesturePattern=[];
let gestureDrawing=false;
function syncGesture(){
  if(!gestureBoard)return;
  gestureBoard.querySelectorAll('circle[data-point]').forEach(node=>node.classList.toggle('selected',gesturePattern.includes(Number(node.dataset.point))));
  gestureLines.replaceChildren();
  for(let index=1;index<gesturePattern.length;index+=1){const [x1,y1]=gesturePoints[gesturePattern[index-1]];const [x2,y2]=gesturePoints[gesturePattern[index]];const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',x1);line.setAttribute('y1',y1);line.setAttribute('x2',x2);line.setAttribute('y2',y2);gestureLines.append(line)}
  gestureSequence.textContent=gesturePattern.length?'连接顺序：'+gesturePattern.join(' → '):'请从任意圆点开始连续绘制';
  gestureSubmit.disabled=pageBusy||gesturePattern.length<4;
}
function resetGesture(){gesturePattern=[];syncGesture()}
function appendGesturePoint(point){
  if(!point||gesturePattern.includes(point))return;
  const previous=gesturePattern.at(-1);
  if(previous){const previousRow=Math.floor((previous-1)/3),previousColumn=(previous-1)%3;const row=Math.floor((point-1)/3),column=(point-1)%3;if((previousRow+row)%2===0&&(previousColumn+column)%2===0){const middle=(previousRow+row)/2*3+(previousColumn+column)/2+1;if(middle!==previous&&middle!==point&&!gesturePattern.includes(middle))gesturePattern.push(middle)}}
  gesturePattern.push(point);syncGesture();
}
function gesturePointAt(event){
  const bounds=gestureBoard.getBoundingClientRect();
  const x=(event.clientX-bounds.left)*300/bounds.width;
  const y=(event.clientY-bounds.top)*300/bounds.height;
  let nearest=0,distance=34;
  for(const [key,[pointX,pointY]] of Object.entries(gesturePoints)){const current=Math.hypot(x-pointX,y-pointY);if(current<distance){nearest=Number(key);distance=current}}
  return nearest;
}
async function run(operation){busy(true);show('正在实时校验并提交，请勿重复操作。',false);try{const data=await operation();show(data.message||'签到完成。',false);setTimeout(()=>location.reload(),800)}catch(error){show(error instanceof Error?error.message:String(error),true);busy(false)}}
document.getElementById('normal-form')?.addEventListener('submit',event=>{event.preventDefault();void run(()=>submitJson({}))});
document.getElementById('code-form')?.addEventListener('submit',event=>{event.preventDefault();const signCode=document.getElementById('sign-code').value;void run(()=>submitJson({signCode}))});
document.getElementById('gesture-form')?.addEventListener('submit',event=>{event.preventDefault();if(gesturePattern.length<4){show('手势至少需要连接 4 个圆点。',true);return}void run(()=>submitJson({signCode:gesturePattern.join('')}))});
document.getElementById('gesture-clear')?.addEventListener('click',resetGesture);
gestureBoard?.addEventListener('pointerdown',event=>{const point=gesturePointAt(event);if(!point)return;event.preventDefault();resetGesture();gestureDrawing=true;gestureBoard.setPointerCapture(event.pointerId);appendGesturePoint(point)});
gestureBoard?.addEventListener('pointermove',event=>{if(!gestureDrawing)return;event.preventDefault();appendGesturePoint(gesturePointAt(event))});
gestureBoard?.addEventListener('pointerup',event=>{if(!gestureDrawing)return;event.preventDefault();appendGesturePoint(gesturePointAt(event));gestureDrawing=false;gestureBoard.releasePointerCapture(event.pointerId)});
gestureBoard?.addEventListener('pointercancel',()=>{gestureDrawing=false});
document.getElementById('location-form')?.addEventListener('submit',event=>{event.preventDefault();void run(async()=>submitJson(await currentLocation()))});
document.getElementById('qr-text-form')?.addEventListener('submit',event=>{event.preventDefault();void run(async()=>submitJson({qrText:document.getElementById('qr-text').value,...(cfg.needsLocation?await currentLocation():{})}))});
cameraStart?.addEventListener('click',()=>{busy(true);show('正在请求摄像头权限。',false);void startCamera().then(()=>show('摄像头已开启，请将二维码完整放入画面。',false)).catch(error=>show(error instanceof Error?error.message:String(error),true)).finally(()=>{busy(false);syncCameraControls()})});
cameraStop?.addEventListener('click',()=>{stopCamera();show('摄像头已关闭。',false)});
cameraCapture?.addEventListener('click',()=>{void run(async()=>{const frame=await captureCameraFrame();const data=await submitImage(frame,cfg.needsLocation?await currentLocation():undefined);stopCamera();return data})});
document.getElementById('photo-form')?.addEventListener('submit',event=>{event.preventDefault();void run(()=>submitImage(document.getElementById('photo').files[0]))});
document.getElementById('share')?.addEventListener('click',async()=>{try{if(navigator.share)await navigator.share({title:document.title,url:location.href});else await navigator.clipboard.writeText(location.href);show('链接已准备好，可以发送给现场协助者。',false)}catch(error){if(error?.name!=='AbortError')show('无法自动复制，请从地址栏复制链接。',true)}});
window.addEventListener('pagehide',stopCamera);
syncCameraControls();
syncGesture();
</script>
</body></html>`;
}

function actionForm(signType: ChaoxingSignType, dynamicQr: boolean): string {
  if (signType === 'normal') return '<form id="normal-form"><p class="hint">确认后将为此活动提交普通签到。</p><button type="submit">确认签到</button></form>';
  if (signType === 'gesture') return `<form id="gesture-form"><p class="hint">按照教师展示的形状，在九宫格上按住并连续滑动；跨过中间圆点时会自动补入。</p><svg id="gesture-board" class="gesture-board" viewBox="0 0 300 300" role="application" aria-label="九宫格手势板"><g id="gesture-lines"></g>${gestureNodes()}</svg><output id="gesture-sequence" class="gesture-sequence" aria-live="polite">请从任意圆点开始连续绘制</output><div class="gesture-actions"><button id="gesture-clear" type="button" class="secondary">清除重画</button><button id="gesture-submit" type="submit" disabled>校验手势并签到</button></div></form>`;
  if (signType === 'code') return '<form id="code-form"><label for="sign-code">签到码</label><input id="sign-code" name="signCode" type="text" autocomplete="off" required maxlength="128" inputmode="numeric"><button type="submit">校验并签到</button></form>';
  if (signType === 'location') return '<form id="location-form"><p class="hint">请由位于签到范围内的人打开本页。点击后浏览器会获取当前真实位置。</p><button type="submit">获取现场位置并签到</button></form>';
  if (signType === 'photo') return '<form id="photo-form"><label for="photo">现场照片</label><input class="file" id="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required><p class="hint">照片会直接上传到绑定账号的学习通云盘并用于本次签到。</p><button type="submit">拍照并签到</button></form>';
  if (signType === 'qrcode') {
    return `<p class="hint">${dynamicQr ? '这是动态二维码，请使用后置摄像头对准教师当前正在展示的码并立即提交。' : '请使用后置摄像头对准教师展示的签到二维码。'}</p><section class="camera" aria-label="二维码摄像头"><video id="qr-video" autoplay playsinline muted></video><canvas id="qr-canvas"></canvas><div class="camera-actions"><button id="qr-camera-start" type="button" class="wide">打开后置摄像头</button><button id="qr-camera-capture" type="button" disabled>扫描当前画面并签到</button><button id="qr-camera-stop" type="button" class="secondary" disabled>关闭摄像头</button></div></section><form id="qr-text-form"><label for="qr-text">粘贴二维码内容</label><textarea id="qr-text" maxlength="4096" placeholder="也可以粘贴扫码得到的完整 URL 或 SIGNIN 内容"></textarea><button type="submit" class="secondary">使用二维码内容签到</button></form>`;
  }
  return '<div class="terminal"><div class="mark">!</div><p>当前签到类型无法处理。</p></div>';
}

function gestureNodes(): string {
  return [
    [1, 50, 50], [2, 150, 50], [3, 250, 50],
    [4, 50, 150], [5, 150, 150], [6, 250, 150],
    [7, 50, 250], [8, 150, 250], [9, 250, 250],
  ].map(([point, x, y]) => `<circle data-point="${point}" cx="${x}" cy="${y}" r="30"></circle><text x="${x}" y="${y}">${point}</text>`).join('');
}

function terminal(status: string): string {
  if (status === 'completed') return '<div class="terminal"><div class="mark">✓</div><h2>签到已确认</h2><p class="hint">官方状态已复核，链接不能再次提交。</p></div>';
  if (status === 'submitting') return '<div class="terminal"><div class="mark">…</div><h2>正在提交</h2><p class="hint">请稍后刷新本页查看官方复核结果。</p></div>';
  if (status === 'uncertain') return '<div class="terminal"><div class="mark">?</div><h2>结果需要核对</h2><p class="hint">请求已到达提交阶段，系统已锁定链接以防重复签到。</p></div>';
  return '<div class="terminal"><div class="mark">×</div><h2>链接不可用</h2></div>';
}

function terminalMessage(state: ChaoxingSignActionPageState | undefined): string {
  if (!state) return '';
  if (state.action.resultMessage) return state.action.resultMessage;
  if (state.action.status === 'submitting') return '签到请求正在处理中。';
  return '';
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
