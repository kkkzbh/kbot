#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/chatluna-package-manager.sh"

CHATLUNA_ROOT_DIR="${CHATLUNA_ROOT_DIR:-}"
MODE="${1:-build}"

if [[ "$MODE" != "build" && "$MODE" != "--check" ]]; then
  echo "[error] usage: ensure-chatluna-build.sh [--check]" >&2
  exit 2
fi

if [[ -z "$CHATLUNA_ROOT_DIR" ]]; then
  CHATLUNA_CORE_DIR="${CHATLUNA_CORE_DIR:-$ROOT_DIR/../chatluna/packages/core}"
  CHATLUNA_ROOT_DIR="$(cd -- "$CHATLUNA_CORE_DIR/../.." && pwd)"
fi

if [[ ! -d "$CHATLUNA_ROOT_DIR" ]]; then
  echo "[error] ChatLuna root directory not found: $CHATLUNA_ROOT_DIR" >&2
  exit 1
fi

mapfile -t BUILD_TARGETS < <(
  python3 - "$ROOT_DIR/package.json" "$CHATLUNA_ROOT_DIR" <<'PY'
from __future__ import annotations

import json
from pathlib import Path
import sys

qqbot_package_json = Path(sys.argv[1])
chatluna_root = Path(sys.argv[2])
linked_prefix = 'link:../chatluna/packages/'

def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))

qqbot_package = load_json(qqbot_package_json)
dependencies = qqbot_package.get('dependencies', {})
workspace_root = chatluna_root / 'packages'
workspace_packages: dict[str, Path] = {}
root_targets: list[Path] = []

for package_json_path in workspace_root.glob('*/package.json'):
    package_dir = package_json_path.parent
    package_data = load_json(package_json_path)
    package_name = package_data.get('name')
    if isinstance(package_name, str) and package_name:
        workspace_packages[package_name] = package_dir

def ensure_buildable_package_dir(package_dir: Path) -> None:
    src_dir = package_dir / 'src'
    package_json = package_dir / 'package.json'
    if not src_dir.is_dir() or not package_json.is_file():
        raise SystemExit(f'missing src or package.json for linked ChatLuna package: {package_dir}')

for _, spec in dependencies.items():
    if not isinstance(spec, str) or not spec.startswith(linked_prefix):
        continue

    relative_path = spec[len(linked_prefix):].strip('/')
    if not relative_path:
        continue

    package_dir = workspace_root / relative_path
    ensure_buildable_package_dir(package_dir)
    root_targets.append(package_dir)

ordered_packages: list[Path] = []
visiting: set[Path] = set()
visited: set[Path] = set()

def visit(package_dir: Path) -> None:
    if package_dir in visited:
        return

    if package_dir in visiting:
        raise SystemExit(f'cyclic ChatLuna workspace dependency detected: {package_dir}')

    ensure_buildable_package_dir(package_dir)
    package_data = load_json(package_dir / 'package.json')
    visiting.add(package_dir)

    local_dependency_names = [
        *package_data.get('dependencies', {}),
        *package_data.get('peerDependencies', {}),
    ]

    for dependency_name in local_dependency_names:
        dep_dir = workspace_packages.get(dependency_name)
        if dep_dir is None:
            continue
        dep_package_json = dep_dir / 'package.json'
        dep_src_dir = dep_dir / 'src'
        if dep_package_json.is_file() and dep_src_dir.is_dir():
            visit(dep_dir)

    visiting.remove(package_dir)
    visited.add(package_dir)
    ordered_packages.append(package_dir)

for package_dir in root_targets:
    visit(package_dir)

build_targets: list[str] = []

for package_dir in ordered_packages:
    src_dir = package_dir / 'src'
    lib_dir = package_dir / 'lib'
    package_json = package_dir / 'package.json'
    build_stamp = lib_dir / '.qqbot-build-stamp'

    src_files = [package_json, *src_dir.rglob('*')]
    runtime_files = [*lib_dir.rglob('*.cjs'), *lib_dir.rglob('*.mjs')]
    src_mtime = max((path.stat().st_mtime for path in src_files if path.is_file()), default=0)

    if (
        not lib_dir.is_dir()
        or not runtime_files
        or not build_stamp.is_file()
        or src_mtime > build_stamp.stat().st_mtime
    ):
        build_targets.append(package_dir.name)

for target in build_targets:
    print(target)
PY
)

if [[ "${#BUILD_TARGETS[@]}" -gt 0 ]]; then
  if [[ "$MODE" == "--check" ]]; then
    echo "[error] Linked ChatLuna packages need build: ${BUILD_TARGETS[*]}" >&2
    echo "[error] Run: pnpm build" >&2
    exit 1
  fi

  echo "[info] Building linked ChatLuna packages in dependency order: ${BUILD_TARGETS[*]}"
  for target in "${BUILD_TARGETS[@]}"; do
    chatluna_yarn_fast_build "$CHATLUNA_ROOT_DIR" "$target"
    target_lib_dir="$CHATLUNA_ROOT_DIR/packages/$target/lib"
    if [[ ! -d "$target_lib_dir" ]] || \
      ! find "$target_lib_dir" -type f \( -name '*.cjs' -o -name '*.mjs' \) -print -quit | grep -q .; then
      echo "[error] ChatLuna build did not produce runtime artifacts: $target" >&2
      exit 1
    fi
    touch "$target_lib_dir/.qqbot-build-stamp"
  done
else
  echo "[info] Linked ChatLuna packages are up to date."
fi
