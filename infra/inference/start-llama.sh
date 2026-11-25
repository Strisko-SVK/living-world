#!/bin/sh
# Run only under the operator-managed systemd service. No eval or shell expansion
# of model names. The HTTP listener is intentionally private and fixed.
set -eu
umask 077

: "${LW_LLAMA_MODEL:?Missing approved model artifact}"
: "${LW_LLAMA_ALIAS:?Missing approved model alias}"
bin="${LW_LLAMA_BIN:-/home/livingworld/raon-probe/llama.cpp/build/bin/llama-server}"
context="${LW_LLAMA_CONTEXT:-4096}"
threads="${LW_LLAMA_THREADS:-4}"
batch_threads="${LW_LLAMA_BATCH_THREADS:-4}"
parallel="${LW_LLAMA_PARALLEL:-1}"
temp="${LW_LLAMA_TEMPERATURE:-0.7}"
top_p="${LW_LLAMA_TOP_P:-0.8}"
top_k="${LW_LLAMA_TOP_K:-20}"
min_p="${LW_LLAMA_MIN_P:-0}"
presence="${LW_LLAMA_PRESENCE_PENALTY:-1.5}"
thinking="${LW_LLAMA_THINKING:-false}"
no_mmproj="${LW_LLAMA_NO_MMPROJ:-true}"

case "$LW_LLAMA_MODEL" in
  *[!a-zA-Z0-9._:/-]*|"") echo "Invalid model reference" >&2; exit 1 ;;
esac
case "$LW_LLAMA_ALIAS" in
  *[!a-zA-Z0-9._:-]*|"") echo "Invalid model alias" >&2; exit 1 ;;
esac
for value in "$context" "$threads" "$batch_threads" "$parallel" "$top_k"; do
  case "$value" in
    ""|*[!0-9]*) echo "Invalid integer inference setting" >&2; exit 1 ;;
  esac
  [ "$value" -ge 1 ] || { echo "Non-positive inference setting" >&2; exit 1; }
done
for value in "$temp" "$top_p" "$min_p" "$presence"; do
  printf '%s' "$value" | grep -Eq '^-?[0-9]+([.][0-9]+)?$' || {
    echo "Invalid decimal inference setting" >&2
    exit 1
  }
done
[ -x "$bin" ] || { echo "llama-server binary is missing or not executable" >&2; exit 1; }

case "$thinking" in
  true) chat_template='{"enable_thinking":true}' ;;
  false) chat_template='{"enable_thinking":false}' ;;
  *) echo "Invalid thinking setting" >&2; exit 1 ;;
esac
case "$no_mmproj" in
  true|false) ;;
  *) echo "Invalid multimodal setting" >&2; exit 1 ;;
esac

set -- -hf "$LW_LLAMA_MODEL" \
  --host 127.0.0.1 --port 8000 \
  --alias "$LW_LLAMA_ALIAS" \
  --ctx-size "$context" --threads "$threads" \
  --threads-batch "$batch_threads" --parallel "$parallel" \
  --temp "$temp" --top-p "$top_p" --top-k "$top_k" --min-p "$min_p" \
  --presence-penalty "$presence" --chat-template-kwargs "$chat_template"
if [ "$no_mmproj" = true ]; then
  set -- "$@" --no-mmproj
fi
exec "$bin" "$@"
