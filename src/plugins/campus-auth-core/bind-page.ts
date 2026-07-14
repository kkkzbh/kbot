import type { CampusAuthMethod, CampusAuthMethodView, CampusAuthProviderId } from './types.js';

export interface CampusBindPageOptions {
  providerId?: CampusAuthProviderId;
  providerLabel: string;
  qqUserId: string;
  token?: string;
  submitPath?: string;
  methods?: CampusAuthMethodView[];
  selectedMethod?: CampusAuthMethod;
  submittedFields?: Readonly<Record<string, string>>;
  state: 'form' | 'pending' | 'verified' | 'invalid';
  confirmCommand?: string;
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

function renderField(
  field: CampusAuthMethodView['fields'][number],
  methodId: string,
  submittedFields?: Readonly<Record<string, string>>,
): string {
  const name = escapeHtml(field.name);
  if (field.type === 'hidden') return `<input type="hidden" name="${name}" value="${escapeHtml(field.value ?? '')}">`;
  if (field.type === 'checkbox') {
    const checked = submittedFields?.[field.name] === 'yes' || submittedFields?.[field.name] === 'true';
    return `<label class="check"><input type="checkbox" name="${name}" value="yes" ${field.required ? 'required' : ''}${checked ? ' checked' : ''}><span>${escapeHtml(field.label)}</span></label>${field.help ? `<p class="help">${escapeHtml(field.help)}</p>` : ''}`;
  }
  const inputType = field.type === 'password' ? 'password' : 'text';
  const value = escapeHtml(field.type === 'text' ? submittedFields?.[field.name] ?? field.value ?? '' : '');
  const autocomplete = escapeHtml(field.autocomplete ?? (field.type === 'password' ? 'current-password' : 'off'));
  const image = field.type === 'captcha' && field.imageDataUrl
    ? `<img class="captcha" src="${escapeHtml(field.imageDataUrl)}" alt="图形验证码">`
    : '';
  return `<label for="${methodId}-${name}">${escapeHtml(field.label)}</label><div class="field-row"><input id="${methodId}-${name}" name="${name}" type="${inputType}" value="${value}" autocomplete="${autocomplete}" ${field.required ? 'required' : ''}>${image}</div>${field.help ? `<p class="help">${escapeHtml(field.help)}</p>` : ''}`;
}

function renderMethods(
  methods: CampusAuthMethodView[],
  selectedMethod?: CampusAuthMethod,
  submittedFields?: Readonly<Record<string, string>>,
): string {
  const activeMethod = methods.some((method) => method.id === selectedMethod) ? selectedMethod : methods[0]?.id;
  return methods.map((method) => {
    const id = escapeHtml(method.id);
    return `<section class="method" data-method="${id}">
      <label class="method-choice"><input type="radio" name="method" value="${id}" ${method.id === activeMethod ? 'checked' : ''}><span><strong>${escapeHtml(method.label)}</strong><small>${escapeHtml(method.description)}</small></span></label>
      <div class="method-fields">${method.fields.map((field) => renderField(field, id, method.id === activeMethod ? submittedFields : undefined)).join('')}</div>
    </section>`;
  }).join('');
}

export function renderCampusBindPage(options: CampusBindPageOptions): string {
  const title = `${options.providerLabel}绑定`;
  const body = options.state === 'form'
    ? `${options.message ? `<p class="notice error">${escapeHtml(options.message)}</p>` : ''}<p class="lead">请选择绑定方式。敏感信息只会提交到 QQBot 绑定服务。</p>
       <form method="post" action="${escapeHtml(options.submitPath ?? '')}" autocomplete="off">
         <input type="hidden" name="token" value="${escapeHtml(options.token ?? '')}">
         ${renderMethods(options.methods ?? [], options.selectedMethod, options.submittedFields)}
         <button type="submit">验证并生成确认码</button>
       </form>`
    : options.state === 'pending'
      ? '<p class="notice">登录正在验证，请稍候刷新页面。</p>'
      : options.state === 'verified'
        ? `<p class="notice ok">登录验证成功。</p><p>请回到发起绑定的 QQ 会话发送：</p><pre data-confirm-command>${escapeHtml(options.confirmCommand ?? '')}</pre><div class="copy-actions"><button class="copy-button" type="button" data-copy-confirm-command data-copy-text="${escapeHtml(options.confirmCommand ?? '')}">复制确认消息</button><span class="copy-status" data-copy-status aria-live="polite"></span></div>`
        : `<p class="notice error">${escapeHtml(options.message ?? '绑定链接无效。')}</p>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,"Noto Sans SC","Microsoft YaHei",sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0;padding:28px 16px}.card{width:min(720px,100%);margin:auto;background:#fff;border:1px solid #dce2eb;border-radius:18px;padding:28px;box-shadow:0 16px 50px rgba(20,32,52,.08)}h1{margin:0 0 8px;font-size:28px}.meta,.lead,.help,small{color:#687487}.meta{margin:0 0 24px}.method{border:1px solid #d9e0e9;border-radius:14px;padding:16px;margin:14px 0}.method-choice{display:flex;gap:12px;cursor:pointer}.method-choice span{display:grid;gap:4px}.method-choice small{font-size:14px}.method-fields{display:grid;gap:8px;margin:16px 0 0 28px}.method-fields>label:not(.check){font-weight:700}.field-row{display:flex;gap:10px;align-items:center}input[type=text],input[type=password]{width:100%;min-height:44px;border:1px solid #cbd4df;border-radius:10px;padding:10px 12px;font:inherit}.captcha{width:120px;height:50px;object-fit:contain;border:1px solid #d9e0e9;border-radius:8px}.check{display:flex;gap:10px;align-items:flex-start}.help{margin:0;font-size:13px;line-height:1.6}button{width:100%;min-height:48px;border:0;border-radius:12px;background:#176b4b;color:#fff;font:inherit;font-weight:800;margin-top:12px;cursor:pointer}.notice{padding:16px;border-radius:12px;background:#eef3f8}.notice.ok{background:#e7f4ee;color:#12663f}.notice.error{background:#fff0ef;color:#a8241b}pre{white-space:pre-wrap;padding:16px;border-radius:12px;background:#172033;color:#fff;font-size:18px}.copy-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.copy-button{width:auto;margin-top:0;padding:0 18px}.copy-status{min-height:24px;color:#687487}.method:not(.active) .method-fields{display:none}@media(max-width:520px){body{padding:12px}.card{padding:20px}.method-fields{margin-left:0}.field-row{align-items:stretch;flex-direction:column}.captcha{width:100%;height:64px}}
  </style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p class="meta">绑定 QQ：${escapeHtml(options.qqUserId || '未知')}</p>${body}</main><script>
  const sections=[...document.querySelectorAll('.method')];function sync(){const selected=document.querySelector('input[name=method]:checked')?.value;for(const section of sections){const active=section.dataset.method===selected;section.classList.toggle('active',active);for(const input of section.querySelectorAll('.method-fields input'))input.disabled=!active}}for(const radio of document.querySelectorAll('input[name=method]'))radio.addEventListener('change',sync);sync();const copyButton=document.querySelector('[data-copy-confirm-command]');const copyStatus=document.querySelector('[data-copy-status]');if(copyButton&&copyStatus){copyButton.addEventListener('click',async()=>{try{const text=copyButton.getAttribute('data-copy-text')||'';if(!text||!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(text);copyStatus.textContent='已复制确认消息'}catch{copyStatus.textContent='复制失败，请手动选择上方命令'}})}
  </script></body></html>`;
}
