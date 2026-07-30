#!/bin/bash
# Забирает свежую выгрузку из ~/Downloads в Google Drive и пересобирает библиотеку.
# Вызывается автоматически (launchd следит за папкой загрузок), но можно и руками.

set -uo pipefail

APP_HOME="${CHATMARKER_HOME:-$HOME/.chatmarker}"
PY="$APP_HOME/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

# корень библиотеки — тот же, что выбрала установка
if [ -z "${CHATMARKER_ROOT:-}" ] && [ -s "$APP_HOME/root.txt" ]; then
  CHATMARKER_ROOT="$(head -n1 "$APP_HOME/root.txt")"
  export CHATMARKER_ROOT
fi

# есть ли вообще что переносить — чтобы не будить сборку на каждый чих в загрузках.
# Без массивов: штатный bash на маке — 3.2, там пустой массив под set -u падает.
PENDING=0
for f in "$HOME/Downloads"/highlights*.json "$HOME/Downloads"/выдержки*.json; do
  [ -e "$f" ] && PENDING=1
done
[ "$PENDING" -eq 0 ] && exit 0

out="$("$PY" "$APP_HOME/library.py" 2>&1)"
echo "$out"

if echo "$out" | grep -q "собрано:"; then
  count="$(echo "$out" | sed -n 's/.*собрано: \([0-9]*\) выдержек.*/\1/p')"
  osascript -e "display notification \"В библиотеке ${count:-?} выдержек\" with title \"Chat Marker\"" 2>/dev/null || true
fi

exit 0
