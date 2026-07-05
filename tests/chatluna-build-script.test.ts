import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chatluna build script dependency closure', () => {
  it('builds local workspace peer dependencies before dependent linked packages', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/ensure-chatluna-build.sh'), 'utf8');

    expect(content).toContain('local_dependency_names = [');
    expect(content).toContain("*package_data.get('dependencies', {}),");
    expect(content).toContain("*package_data.get('peerDependencies', {}),");
    expect(content).toContain('visit(dep_dir)');
    expect(content).toContain('for target in "${BUILD_TARGETS[@]}"');
    expect(content).toContain('chatluna_yarn_fast_build "$CHATLUNA_ROOT_DIR" "$target"');
    expect(content).not.toContain('chatluna_yarn_fast_build "$CHATLUNA_ROOT_DIR" "${BUILD_TARGETS[@]}"');
  });

  it('supports a check-only mode for service startup preflight', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/ensure-chatluna-build.sh'), 'utf8');

    expect(content).toContain('MODE="${1:-build}"');
    expect(content).toContain('if [[ "$MODE" == "--check" ]]');
    expect(content).toContain('Linked ChatLuna packages need build');
    expect(content).toContain('Run: pnpm build');
  });

  it('runs the package manager declared by the linked ChatLuna checkout or CI input', () => {
    const helper = readFileSync(resolve(process.cwd(), 'scripts/lib/chatluna-package-manager.sh'), 'utf8');
    const action = readFileSync(resolve(process.cwd(), '.github/actions/setup-qqbot-workspace/action.yml'), 'utf8');
    const buildScript = readFileSync(resolve(process.cwd(), 'scripts/ensure-chatluna-build.sh'), 'utf8');

    expect(helper).toContain('pkg.packageManager');
    expect(helper).toContain('CHATLUNA_YARN_VERSION');
    expect(helper).toContain('COREPACK_ENABLE_PROJECT_SPEC=0 corepack "yarn@${yarn_version}" "$@"');
    expect(helper).toContain('corepack "yarn@${yarn_version}" "$@"');
    expect(helper).toContain('npm exec --yes "@yarnpkg/cli-dist@${yarn_version}" -- "$@"');
    expect(helper).toContain('install --frozen-lockfile');
    expect(helper).toContain('install --no-immutable');
    expect(helper).toContain('install --immutable');
    expect(action).toContain('yarn-version:');
    expect(action).toContain('CHATLUNA_YARN_VERSION: ${{ inputs.yarn-version }}');
    expect(action.match(/CHATLUNA_YARN_VERSION: \$\{\{ inputs\.yarn-version \}\}/g)).toHaveLength(2);
    expect(buildScript).toContain('chatluna_yarn_fast_build "$CHATLUNA_ROOT_DIR" "$target"');
    expect(buildScript).not.toContain('yarn@1.22.22');
  });
});
