#!/usr/bin/env bash
[[ -d "$HOME/wg-verify/tmp" ]] && export TMPDIR="$HOME/wg-verify/tmp"
for dir in "${PLAYWRIGHT_BROWSERS_PATH:-}" "$HOME/.cache/ms-playwright" /opt/pw-browsers; do
  [[ -n "$dir" ]] && compgen -G "$dir/chromium*" >/dev/null && { export PLAYWRIGHT_BROWSERS_PATH="$dir"; break; }
done
if [[ -d "$HOME/wg-verify/libs" ]]; then
  LD_LIBRARY_PATH="$(find "$HOME/wg-verify/libs" -name '*.so*' -printf '%h\n' | sort -u | paste -sd:)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LD_LIBRARY_PATH
fi
