import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const functionBody = (content: string, name: string) => {
  const start = content.indexOf(`${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = content.indexOf('\n}\n\n', start);
  expect(end).toBeGreaterThan(start);

  return content.slice(start, end + 3);
};

describe('production deploy contract', () => {
  it('keeps deploy split into build, prepare, activate, and verify phases', () => {
    const workflow = readProjectFile('.github/workflows/deploy.yml');

    expect(workflow).toMatch(/^  build-release:/m);
    expect(workflow).toMatch(/^  prepare-production:/m);
    expect(workflow).toMatch(/^  activate-production:/m);
    expect(workflow).toMatch(/^  verify-production:/m);
    expect(workflow).toMatch(/restart_scope:[\s\S]*default: koishi/);
    expect(workflow).toMatch(/verify_scope:[\s\S]*default: koishi/);
    expect(workflow).toContain('install-release.sh" prepare');
    expect(workflow).toContain(' activate $(printf');
    expect(workflow).toContain(' verify $(printf');
    expect(workflow).not.toContain('install-release.sh "${REMOTE_BUNDLE}"');
    expect(workflow).not.toContain('systemctl restart qqbot.target');
  });

  it('requires CI-built artifacts before server prepare', () => {
    const bundler = readProjectFile('scripts/ci/create-deploy-bundle.sh');
    const installer = readProjectFile('scripts/deploy/install-release.sh');
    const prepare = functionBody(installer, 'prepare_release');

    expect(bundler).toContain('if [[ ! -d "${ROOT_DIR}/dist" ]]; then');
    expect(bundler).toContain('cp -a "${ROOT_DIR}/dist" "${STAGING_DIR}/qqbot/dist"');
    expect(prepare).toContain('missing qqbot/dist');
    expect(prepare).not.toMatch(/\bpnpm\s+build\b/);
    expect(prepare).toContain('ensure-chatluna-build.sh" --check');
    expect(installer).not.toContain('install-release.sh <qqbot-release.tar.gz>');
  });

  it('activates only prepared releases and restarts by explicit scope', () => {
    const installer = readProjectFile('scripts/deploy/install-release.sh');
    const activate = functionBody(installer, 'activate_release');
    const restart = functionBody(installer, 'restart_scope');

    expect(activate).toContain('release is not prepared');
    expect(activate).toContain('ln -sfn "${app_dir}" "${CURRENT_LINK}"');
    expect(activate).toContain('restart_scope "${DEPLOY_SCOPE}"');
    expect(restart).toContain('systemctl restart qqbot-koishi.service');
    expect(restart).toContain('systemctl restart "${SYSTEMD_TARGET}"');
  });

  it('keeps koishi verification independent from full PMHQ and LLBot checks', () => {
    const verifier = readProjectFile('scripts/verify-qqbot-host-runtime.sh');
    const prereqs = readProjectFile('scripts/deploy/verify-host-prereqs.sh');

    expect(prereqs.indexOf('if [[ "${SCOPE}" == "full" ]]; then')).toBeLessThan(
      prereqs.indexOf('require_cmd podman'),
    );
    expect(verifier).toContain('wait_until "${KOISHI_UNIT} is active"');
    expect(verifier).toContain('wait_until "koishi http endpoint is reachable"');
    expect(verifier.indexOf('if [[ "${SCOPE}" == "koishi" ]]; then')).toBeLessThan(
      verifier.indexOf('wait_until "${PMHQ_CONTAINER} is running"'),
    );
    expect(verifier).toContain('wait_until "${LLBOT_UNIT} completes PMHQ WebSocket handshake"');
    expect(verifier).toContain('wait_until "koishi can reach llbot websocket"');
  });
});
