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
    expect(content).toContain("platform: ${{ env.CHATLUNA_PLATFORM || 'siliconflow' }}");
    expect(content).toContain("maxContextRatio: ${{ +env.CHATLUNA_MAX_CONTEXT_RATIO || 0.35 }}");
    expect(content).toContain('chatluna-agent:computer-agent: {}');
  });

  it('keeps compose focused on pmhq and voice-asr only', () => {
    const content = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8');

    expect(content).toContain(
      'network_mode: "pasta:-t,${PMHQ_BIND_HOST:-127.0.0.1}/${PMHQ_PORT:-13000}:13000"',
    );
    expect(content).toContain('voice-asr:');
    expect(content).toContain('"127.0.0.1:${VOICE_ASR_PORT:-5161}:8080"');
    expect(content).toContain('ENABLE_HEADLESS: "${ENABLE_HEADLESS:-false}"');
    expect(content).toContain('VOICE_ASR_PORT: "8080"');
    expect(content).toContain('VOICE_ASR_MAX_SECONDS: "${QQ_VOICE_INPUT_MAX_SECONDS:-60}"');
    expect(content).not.toContain('ENABLE_HEADLESS: ${ENABLE_HEADLESS:-false}');
    expect(content).not.toContain('VOICE_ASR_PORT: 8080');
    expect(content).toContain('./data/voice/asr:/data/voice/asr:Z');
    expect(content).not.toContain('"${PMHQ_BIND_HOST:-127.0.0.1}:${PMHQ_PORT:-13000}:13000"');
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
    expect(content).toContain('LLBOT_RUNTIME_DIR=/opt/qqbot/shared/llbot-runtime');
    expect(content).toContain('LLONEBOT_DATA_DIR=/opt/qqbot/shared/llonebot');
    expect(content).toContain('Set AUTO_LOGIN_QQ only if this server should use QQ quick-login by default.');
    expect(content).not.toContain('LLBOT_IMAGE=');
    expect(content).not.toContain('LLBOT_TAG=');
    expect(content).not.toContain('PMHQ_HOST=');
    expect(content).not.toContain('pmhq:13000');
  });

  it('ships local systemd templates for pmhq, llbot and koishi', () => {
    const pmhqService = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-pmhq.service.example'),
      'utf8',
    );
    const llbotService = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-llbot.service.example'),
      'utf8',
    );
    const koishiService = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-koishi.service.example'),
      'utf8',
    );

    expect(pmhqService).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/podman-pmhq-service.sh up');
    expect(pmhqService).toContain('ExecStop=/home/kkkzbh/code/qqbot/scripts/podman-pmhq-service.sh stop');
    expect(llbotService).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/run-llbot-host.sh');
    expect(llbotService).toContain('After=network-online.target qqbot-pmhq.service');
    expect(koishiService).toContain('After=network-online.target qqbot-llbot.service');
    expect(koishiService).toContain('Wants=network-online.target qqbot-llbot.service');
    expect(koishiService).toContain('PartOf=qqbot.target qqbot-llbot.service');
  });

  it('bridges llbot home to the pmhq qq mount and removes legacy cni artifacts before pmhq startup', () => {
    const llbotScript = readFileSync(resolve(process.cwd(), 'scripts/run-llbot-host.sh'), 'utf8');
    const pmhqScript = readFileSync(resolve(process.cwd(), 'scripts/podman-pmhq-service.sh'), 'utf8');

    expect(llbotScript).toContain('export QQBOT_HOST_HOME="${HOST_HOME}"');
    expect(llbotScript).toContain('export HOME="${LLBOT_RUNTIME_DIR}/.host-home"');
    expect(pmhqScript).toContain('remove_legacy_cni_artifacts');
    expect(pmhqScript).toContain('podman network rm qqbot-stack_default qqbot-stack_app_network');
    expect(pmhqScript).toContain('rm -f /etc/cni/net.d/qqbot-stack_default.conflist /etc/cni/net.d/qqbot-stack_app_network.conflist');
    expect(pmhqScript).toContain('host_login_network_ready');
    expect(pmhqScript).toContain('pmhq_container_has_default_route');
    expect(pmhqScript).toContain('pmhq_container_can_reach_login_network');
    expect(pmhqScript).toContain('remove_unusable_pmhq_container');
  });

  it('ships a laptop-local TTS env template and user service example', () => {
    const envTemplate = readFileSync(resolve(process.cwd(), 'config/voice-tts.local.example'), 'utf8');
    const serviceTemplate = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-voice-tts.service.example'),
      'utf8',
    );

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
    expect(serviceTemplate).toContain(
      'Environment=QQBOT_VOICE_TTS_ENV_FILE=/home/kkkzbh/code/qqbot/config/voice-tts.local.env',
    );
    expect(serviceTemplate).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/run-voice-tts-local.sh');
    expect(serviceTemplate).not.toContain('tailscaled.service');
  });

  it('ships a dedicated tailnet publisher template instead of rebinding the model process', () => {
    const envTemplate = readFileSync(resolve(process.cwd(), 'config/voice-tts.tailnet.example'), 'utf8');
    const serviceTemplate = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-voice-tts-tailnet.service.example'),
      'utf8',
    );

    expect(envTemplate).toContain('VOICE_TTS_TAILNET_PORT=5162');
    expect(envTemplate).toContain('VOICE_TTS_LOCAL_UPSTREAM_HOST=127.0.0.1');
    expect(serviceTemplate).toContain('qqbot-voice-tts.service');
    expect(serviceTemplate).toContain('QQBOT_VOICE_TTS_TAILNET_ENV_FILE=/home/kkkzbh/code/qqbot/config/voice-tts.tailnet.env');
    expect(serviceTemplate).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/publish-voice-tts-tailnet.sh apply');
    expect(serviceTemplate).toContain('ExecStop=/home/kkkzbh/code/qqbot/scripts/publish-voice-tts-tailnet.sh clear');
  });

  it('keeps the sakiko preset free of runtime transport protocol text and deprecated tag contracts', () => {
    const content = readFileSync(resolve(process.cwd(), 'data/chathub/presets/sakiko.yml'), 'utf8');

    expect(content).not.toContain('# 回复组织原则');
    expect(content).not.toContain('你的最终回复只输出一个合法的 ReplyPlan JSON 对象本身');
    expect(content).not.toContain('普通聊天也要写成 ReplyPlan');
    expect(content).not.toContain('voice.content 只写你要说的话');
    expect(content).not.toContain('<qqbot-multiline>');
    expect(content).not.toContain('<qqbot-voice>');
  });

  it('deploys through a release bundle and renders server units from tracked scripts', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');
    const renderer = readFileSync(resolve(process.cwd(), 'scripts/deploy/render-systemd-units.mjs'), 'utf8');
    const installer = readFileSync(resolve(process.cwd(), 'scripts/deploy/install-release.sh'), 'utf8');
    const prereqs = readFileSync(resolve(process.cwd(), 'scripts/deploy/verify-host-prereqs.sh'), 'utf8');

    expect(workflow).toContain('environment:');
    expect(workflow).toContain('name: production');
    expect(workflow).toContain('node ./scripts/ci/write-build-manifest.mjs --output artifacts/build-manifest.json');
    expect(workflow).toContain('bash ./scripts/ci/create-deploy-bundle.sh');
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
    expect(workflow).toContain('webfactory/ssh-agent@e83874834305fe9a4a2997156cb26c5de65a8555');
    expect(workflow).toContain('SSH_KNOWN_HOSTS: ${{ secrets.QQBOT_SSH_KNOWN_HOSTS }}');
    expect(workflow).toContain('bash "${QQBOT_REMOTE_INSTALL_TMP}/qqbot/scripts/deploy/install-release.sh"');
    expect(workflow).not.toContain('ssh-keyscan');
    expect(workflow).not.toContain('apt-get install');
    expect(workflow).not.toContain('cat > "${USER_SYSTEMD_DIR}/qqbot-pmhq.service"');

    expect(renderer).toContain("writeUnit(\n  systemdDir,\n  'qqbot-pmhq.service'");
    expect(renderer).toContain("writeUnit(\n  systemdDir,\n  'qqbot-llbot.service'");
    expect(renderer).toContain("writeUnit(\n  systemdDir,\n  'qqbot-koishi.service'");
    expect(renderer).toContain('EnvironmentFile=${envServer}');
    expect(renderer).toContain('EnvironmentFile=-${envRuntime}');
    expect(renderer).toContain('Environment=QQBOT_ENV_BASE_FILE=${envServer}');
    expect(renderer).toContain('Environment=QQBOT_ENV_OVERRIDE_FILE=${envRuntime}');
    expect(renderer).toContain('Environment=CHATLUNA_PRESET_DIRS=${shared}/presets:${app}/data/chathub/presets');
    expect(renderer).toContain('PartOf=qqbot.target qqbot-llbot.service');
    expect(renderer).toContain('podman rm -f qqbot-voice-asr >/dev/null 2>&1 || true');
    expect(renderer).toContain('./scripts/podman-pmhq-service.sh up');
    expect(renderer).toContain('./scripts/run-llbot-host.sh');
    expect(renderer).toContain('Wants=qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service');

    expect(installer).toContain('bash "${APP_DIR}/scripts/deploy/verify-host-prereqs.sh"');
    expect(installer).toContain('bash "${APP_DIR}/scripts/prepare-server-runtime-layer.sh"');
    expect(installer).toContain('ln -sfn "${APP_DIR}" "${CURRENT_LINK}"');
    expect(installer).toContain('bash "${CURRENT_LINK}/scripts/verify-qqbot-host-runtime.sh"');
    expect(installer).toContain('QQBOT_DEPLOY_DRY_RUN');
    expect(installer).toContain('QQBOT_SERVER_ENV_FILE="${SHARED_DIR}/.env.server"');

    expect(prereqs).toContain('corepack or npm');
    expect(prereqs).toContain('chromium-headless/google-chrome');
    expect(prereqs).toContain('/usr/lib64/chromium-browser/headless_shell');
    expect(prereqs).toContain('require_cmd podman');
    expect(prereqs).toContain('require_cmd podman-compose');
    expect(prereqs).not.toContain('podman compose version');
    expect(prereqs).not.toContain('apt-get');
  });

  it('ships a dedicated pmhq compose helper for the host topology', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/podman-pmhq-service.sh'), 'utf8');

    expect(content).toContain('Usage: $0 up|stop|restart');
    expect(content).toContain('COMPOSE_CMD="podman-compose"');
    expect(content).toContain('"${COMPOSE_CMD}" -f "${COMPOSE_FILE}" "$@"');
    expect(content).toContain('compose up -d pmhq');
    expect(content).toContain('compose stop pmhq');
    expect(content).not.toContain('QQBOT_PODMAN_COMPOSE_BIN');
    expect(content).not.toContain('podman)" "compose');
    expect(content).toContain('remove_legacy_llbot_container');
    expect(content).toContain('QQBOT_PMHQ_LOGIN_NETWORK_PROBE_URL');
    expect(content).toContain('wait_for "host login network is reachable"');
    expect(content).toContain('wait_for "${PMHQ_CONTAINER} outbound network is ready"');
    expect(content).not.toContain('compose up -d llbot');
  });

  it('ships a host runtime verifier for pmhq, llbot and koishi wiring', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/verify-qqbot-host-runtime.sh'), 'utf8');

    expect(content).toContain('wait_until "${PMHQ_CONTAINER} is running"');
    expect(content).toContain('wait_until "${PMHQ_CONTAINER} has a default route"');
    expect(content).toContain('wait_until "${PMHQ_CONTAINER} can reach QQ login network"');
    expect(content).toContain('wait_until "pmhq health endpoint is reachable"');
    expect(content).toContain('wait_until "llbot webui is reachable"');
    expect(content).toContain('wait_until "${LLBOT_UNIT} completes PMHQ WebSocket handshake"');
    expect(content).toContain('wait_until "koishi can reach llbot websocket"');
    expect(content).toContain('journalctl -u "${LLBOT_UNIT}"');
    expect(content).toContain('systemctl is-active --quiet "${unit}"');
    expect(content).toContain('new WebSocket(process.argv[1])');
  });

  it('ships a one-shot server login recovery helper for pmhq and llbot services', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/server-recover-qq-login.sh'), 'utf8');

    expect(content).toContain('Usage: $0 prepare|restore');
    expect(content).toContain('AUTO_LOGIN_QQ_ORIG=');
    expect(content).toContain('systemctl stop qqbot.target');
    expect(content).toContain('systemctl start qqbot-pmhq.service');
    expect(content).toContain('systemctl start qqbot-llbot.service');
    expect(content).toContain('${ROOT_DIR}/scripts/verify-qqbot-host-runtime.sh');
    expect(content).toContain('AUTO_LOGIN_QQ is temporarily cleared in ${ENV_FILE}.');
    expect(content).toContain('systemctl restart qqbot.target');
    expect(content).toContain('set_auto_login_value');
  });

  it('ships a runtime layer migration script that seeds env, presets and llbot dirs into the shared dir', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/prepare-server-runtime-layer.sh'), 'utf8');

    expect(content).toContain('RUNTIME_ENV_FILE="${SHARED_DIR}/.env.runtime"');
    expect(content).toContain('RUNTIME_PRESET_DIR="${SHARED_DIR}/presets"');
    expect(content).toContain('RUNTIME_LLBOT_DIR="${SHARED_DIR}/llonebot"');
    expect(content).toContain('RUNTIME_LLBOT_RUNTIME_DIR="${SHARED_DIR}/llbot-runtime"');
    expect(content).toContain('LEGACY_LLBOT_DIR="${APP_DIR}/data/llonebot"');
    expect(content).toContain('SEED_MARKER_FILE="${SHARED_DIR}/.runtime-layer.seeded"');
    expect(content).toContain('cp -a "${LEGACY_LLBOT_DIR}/." "${RUNTIME_LLBOT_DIR}/"');
    expect(content).toContain("keyMatches = [...sourceText.matchAll(/key:\\s*'([^']+)'/g)]");
    expect(content).toContain("find \"${BUNDLED_PRESET_DIR}\" -maxdepth 1 -type f");
    expect(content).toContain('mkdir -p "${SHARED_DIR}" "${RUNTIME_PRESET_DIR}" "${RUNTIME_LLBOT_DIR}" "${RUNTIME_LLBOT_RUNTIME_DIR}"');
    expect(content).toContain('upsert_env_value "LLONEBOT_DATA_DIR" "${RUNTIME_LLBOT_DIR}"');
    expect(content).toContain('upsert_env_value "LLBOT_RUNTIME_DIR" "${RUNTIME_LLBOT_RUNTIME_DIR}"');
  });

  it('ships a server voice env validator that rejects empty or loopback TTS settings', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/validate-server-voice-env.mjs'), 'utf8');

    expect(content).toContain("QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_BASE_URL is empty.");
    expect(content).toContain("QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_API_KEY is empty.");
    expect(content).toContain('server QQ_VOICE_TTS_BASE_URL must point to laptop Tailnet TTS, not 127.0.0.1/localhost.');
    expect(content).toContain('server deploy does not support QQ_VOICE_INPUT_ENABLED=true.');
  });

  it('lets stickers sync resolve local env first and server env second', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/stickers-sync.mjs'), 'utf8');

    expect(content).toContain("path.resolve(ROOT_DIR, '.env.local')");
    expect(content).toContain("path.resolve(ROOT_DIR, '.env.server')");
    expect(content).not.toContain("path.resolve(ROOT_DIR, '.env')");
  });
});
