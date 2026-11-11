#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?Run in an isolated CI runner}"
archive="$RUNNER_TEMP/gitleaks_8.30.1_linux_x64.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --max-time 90 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz' -o "$archive"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$archive" | sha256sum --check --status
mkdir -p "$RUNNER_TEMP/lw-security-bin"
tar -xzf "$archive" -C "$RUNNER_TEMP/lw-security-bin" gitleaks
"$RUNNER_TEMP/lw-security-bin/gitleaks" version
