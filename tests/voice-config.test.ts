import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('qq voice config wiring', () => {
  it('loads the qq-voice plugin before group trigger and chatluna', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    const voiceIndex = content.indexOf('./dist/plugins/reply:voice:');
    const triggerIndex = content.indexOf('./dist/plugins/triggers/group-natural:natural-trigger:');
    const chatlunaIndex = content.indexOf('chatluna:0qm1bk:');
    const agentIndex = content.indexOf('chatluna-agent:computer-agent:');
    const commonIndex = content.indexOf('chatluna-plugin-common:qf1a6x:');

    expect(voiceIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeGreaterThan(voiceIndex);
    expect(chatlunaIndex).toBeGreaterThan(triggerIndex);
    expect(commonIndex).toBeGreaterThan(chatlunaIndex);
    expect(agentIndex).toBeGreaterThan(commonIndex);

    expect(content).toContain("asrBaseUrl: ${{ env.QQ_VOICE_ASR_BASE_URL || '' }}");
    expect(content).toContain("ttsBaseUrl: ${{ env.QQ_VOICE_TTS_BASE_URL || '' }}");
    expect(content).toContain('voiceOutputLanguage: ${{ env.QQ_VOICE_OUTPUT_LANGUAGE }}');
    expect(content).toContain('replyInterruptCollectWindowMs: ${{ +env.QQBOT_REPLY_COLLECT_WINDOW_MS || 400 }}');
    expect(content).toContain('replyInterruptMaxPendingInputs: ${{ +env.QQBOT_REPLY_MAX_PENDING_INPUTS || 8 }}');
    expect(content).toContain("naturalTriggerEnabled: ${{ env.CHAT_NATURAL_TRIGGER_ENABLED === 'true' }}");
    expect(content).toContain("naturalTriggerGroups: ${{ env.CHAT_NATURAL_TRIGGER_GROUPS || '' }}");
    expect(content).toContain("enabled: ${{ env.CHAT_NATURAL_TRIGGER_ENABLED === 'true' }}");
    expect(content).toContain('aliases:');
    expect(content).toContain("env.CHAT_NATURAL_TRIGGER_ALIASES || '祥子,祥,丰川,丰川祥子,saki,saki酱,sakiko'");
    expect(content).toContain('voiceTranscribeTimeoutMs: ${{ +env.QQ_VOICE_TRANSCRIBE_TIMEOUT_MS || 45000 }}');
    expect(content).toContain("maxJobsPerUser: ${{ +env.TASK_AUTOMATION_MAX_TASKS_PER_USER || 20 }}");
    expect(content).not.toContain('maxTasksPerUser:');
    expect(content).not.toContain('maxInjectTotalBytes:');
    expect(content).not.toContain('maxPdfPreviewPagesPerFile:');
    expect(content).not.toContain('historyWindow: ${{ +env.QQBOT_ATTACHMENT_HISTORY_WINDOW || 80 }}');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_REQUEST_BODY_BYTES');
    expect(content).toContain('chatluna-agent:computer-agent: {}');
  });

  it('keeps the local compose health contract for pmhq and voice-asr', () => {
    const content = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8');

    expect(content).toContain('"${PMHQ_BIND_HOST:-127.0.0.1}:${PMHQ_PORT:-13000}:13000"');
    expect(content).toContain('restart: "no"');
    expect(content).not.toContain('network_mode: "pasta:');
    expect(content).toContain('voice-asr:');
    expect(content).toContain('"127.0.0.1:${VOICE_ASR_PORT:-5161}:8080"');
    expect(content).toContain('ENABLE_HEADLESS: "${ENABLE_HEADLESS:-false}"');
    expect(content).toContain('VOICE_ASR_PORT: "8080"');
    expect(content).toContain('VOICE_ASR_MAX_SECONDS: "${QQ_VOICE_INPUT_MAX_SECONDS:-60}"');
    expect(content).not.toContain('ENABLE_HEADLESS: ${ENABLE_HEADLESS:-false}');
    expect(content).not.toContain('VOICE_ASR_PORT: 8080');
    expect(content).toContain('./data/voice/asr:/data/voice/asr:Z');
    expect(content).not.toContain('\n  llbot:\n');
    expect(content).not.toContain('qqbot-stack_app_network');
    expect(content).not.toContain('pmhq_host:');
    expect(content).not.toContain('LLBOT_IMAGE');
    expect(content).not.toContain('LLBOT_TAG');
    expect(content).not.toContain('command: ["/startup.sh"]');
  });

  it('documents local host-llbot env vars in .env.example', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162');
    expect(content).toContain('QQ_VOICE_OUTPUT_LANGUAGE=zh');
    expect(content).toContain('CHAT_NATURAL_TRIGGER_ENABLED=false');
    expect(content).toContain('QQBOT_ATTACHMENT_REPLAY_MAX_REFS=5');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_INJECT_TOTAL_BYTES');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_PDF_PREVIEW_PAGES_PER_FILE');
    expect(content).not.toContain('QQBOT_ATTACHMENT_HISTORY_WINDOW');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_REQUEST_BODY_BYTES');
    expect(content).toContain('MEMORY_MAX_FACTS=8');
    expect(content).toContain('MEMORY_MAX_EPISODES=8');
    expect(content).toContain('PMHQ_BIND_HOST=127.0.0.1');
    expect(content).toContain('PMHQ_PORT=13000');
    expect(content).toContain('LLBOT_VERSION=7.12.15');
    expect(content).toContain('LLBOT_RUNTIME_DIR=./.runtime/llbot');
    expect(content).toContain('LLONEBOT_DATA_DIR=./.runtime/llonebot');
    expect(content).not.toContain('LLBOT_IMAGE=');
    expect(content).not.toContain('LLBOT_TAG=');
    expect(content).not.toContain('PMHQ_HOST=');
  });

  it('ships a server env template with host llbot defaults', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.server.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_INPUT_ENABLED=false');
    expect(content).toContain('QQ_VOICE_OUTPUT_ENABLED=false');
    expect(content).toContain('QQ_VOICE_OUTPUT_LANGUAGE=zh');
    expect(content).toContain('CHAT_NATURAL_TRIGGER_ENABLED=false');
    expect(content).toContain('QQBOT_ATTACHMENT_REPLAY_MAX_REFS=5');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_INJECT_TOTAL_BYTES');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_PDF_PREVIEW_PAGES_PER_FILE');
    expect(content).not.toContain('QQBOT_ATTACHMENT_HISTORY_WINDOW');
    expect(content).not.toContain('QQBOT_ATTACHMENT_MAX_REQUEST_BODY_BYTES');
    expect(content).toContain('MEMORY_MAX_FACTS=8');
    expect(content).toContain('MEMORY_MAX_EPISODES=8');
    expect(content).toContain('PMHQ_BIND_HOST=127.0.0.1');
    expect(content).toContain('PMHQ_PORT=13000');
    expect(content).toContain('LLBOT_VERSION=7.12.15');
    expect(content).toContain('LLBOT_RUNTIME_DIR=/opt/qqbot/data/llbot-runtime');
    expect(content).toContain('LLONEBOT_DATA_DIR=/opt/qqbot/data/llonebot');
    expect(content).toContain('Set AUTO_LOGIN_QQ only if this server should use QQ quick-login by default.');
    expect(content).not.toContain('LLBOT_IMAGE=');
    expect(content).not.toContain('LLBOT_TAG=');
    expect(content).not.toContain('PMHQ_HOST=');
    expect(content).not.toContain('pmhq:13000');
  });

  it('bridges llbot home to its isolated runtime directory', () => {
    const llbotScript = readFileSync(resolve(process.cwd(), 'scripts/run-llbot-host.sh'), 'utf8');

    expect(llbotScript).toContain('export QQBOT_HOST_HOME="${HOST_HOME}"');
    expect(llbotScript).toContain('export HOME="${LLBOT_RUNTIME_DIR}/.host-home"');
  });

  it('ships a laptop-local TTS env template', () => {
    const envTemplate = readFileSync(resolve(process.cwd(), 'config/voice-tts.local.example'), 'utf8');

    expect(envTemplate).toContain('VOICE_TTS_HOST=127.0.0.1');
    expect(envTemplate).toContain('VOICE_TTS_DEVICE=cuda');
    expect(envTemplate).toContain('VOICE_TTS_UPSTREAM_ROOT=/home/kkkzbh/code/qqbot/.runtime/gpt-sovits-upstream');
    expect(envTemplate).toContain(
      'VOICE_TTS_GPT_WEIGHTS=/home/kkkzbh/code/qqbot/data/voice/tts-local/models/sakiko_v2pp-e15.ckpt',
    );
    expect(envTemplate).toContain(
      'VOICE_TTS_REF_BLACK=/home/kkkzbh/code/qqbot/data/voice/tts-local/references/black_sakiko.wav',
    );
    expect(envTemplate).toContain('VOICE_TTS_MAX_TEXT_CHARS=200');
    expect(envTemplate).toContain('VOICE_TTS_PROMPT_LANG=all_ja');
    expect(envTemplate).toContain('VOICE_TTS_TEXT_LANG=all_zh');
  });

  it('ships a dedicated tailnet publisher config instead of rebinding the model process', () => {
    const envTemplate = readFileSync(resolve(process.cwd(), 'config/voice-tts.tailnet.example'), 'utf8');
    const publisher = readFileSync(resolve(process.cwd(), 'scripts/publish-voice-tts-tailnet.sh'), 'utf8');

    expect(envTemplate).toContain('VOICE_TTS_TAILNET_PORT=5162');
    expect(envTemplate).toContain('VOICE_TTS_LOCAL_UPSTREAM_HOST=127.0.0.1');
    expect(publisher).toContain('publish-voice-tts-tailnet.sh apply');
    expect(publisher).toContain('publish-voice-tts-tailnet.sh clear');
    expect(publisher).toContain('tailscale serve');
  });

  it('keeps the sakiko preset free of runtime transport protocol text and deprecated tag contracts', () => {
    const content = readFileSync(resolve(process.cwd(), 'data/chathub/role-presets/sakiko.yml'), 'utf8');

    expect(content).not.toContain('# 回复组织原则');
    expect(content).not.toContain('你的最终回复只输出一个合法的 ReplyPlan JSON 对象本身');
    expect(content).not.toContain('普通聊天也要写成 ReplyPlan');
    expect(content).not.toContain('voice.content 只写你要说的话');
    expect(content).not.toContain('<qqbot-multiline>');
    expect(content).not.toContain('<qqbot-voice>');
  });


  it('ships a server voice env validator that rejects empty or loopback TTS settings', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/validate-server-voice-env.mjs'), 'utf8');

    expect(content).toContain("QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_BASE_URL is empty.");
    expect(content).toContain("QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_API_KEY is empty.");
    expect(content).toContain('server QQ_VOICE_TTS_BASE_URL must point to laptop Tailnet TTS, not 127.0.0.1/localhost.');
    expect(content).toContain('server runtime does not support QQ_VOICE_INPUT_ENABLED=true.');
  });

  it('lets stickers sync resolve local env first and server env second', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/stickers-sync.mjs'), 'utf8');
    const localIndex = content.indexOf("path.resolve(rootDir, '.env.local')");
    const serverIndex = content.indexOf("path.resolve(rootDir, '.env.server')");

    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(serverIndex).toBeGreaterThan(localIndex);
    expect(content).not.toContain("path.resolve(rootDir, '.env')");
  });
});
