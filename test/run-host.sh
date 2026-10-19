#!/usr/bin/env bash
set -euo pipefail
code_binary="$(realpath "$1")"
vsix_path="$(realpath "$2")"
result_dir="$(realpath -m "$3")"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$result_dir"
if [[ -e "$result_dir/profile" ]]; then
  echo "Use a fresh result directory for the restart test" >&2
  exit 1
fi
export XDG_DATA_HOME="$result_dir/keyring-data"
mkdir -p "$XDG_DATA_HOME"
printf 'synthetic-keyring-password' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
code_args=(--no-sandbox --disable-gpu --disable-dev-shm-usage
  --user-data-dir "$result_dir/profile" --extensions-dir "$result_dir/extensions")
if [[ "${VRATA_HOST_VERSION:-}" != 1.104.0 ]]; then
  code_args+=(--shared-data-dir "$result_dir/shared")
fi
"$(dirname "$code_binary")/bin/code" "${code_args[@]}" --install-extension "$vsix_path"
for phase in write read; do
  VRATA_HOST_PHASE="$phase" VRATA_HOST_RESULT="$result_dir/$phase.json" \
    timeout 90 "$code_binary" "${code_args[@]}" --password-store=gnome-libsecret \
    --extensionDevelopmentPath "$repo_dir/test/host-extension" \
    --skip-welcome --skip-release-notes >"$result_dir/$phase.log" 2>&1
  node -e 'const r=require(process.argv[1]); if(r.passed!==true) process.exit(1); console.log(JSON.stringify(r))' "$result_dir/$phase.json"
done
