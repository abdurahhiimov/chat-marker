#!/bin/bash
# Разбирается, почему фоновый агент не переносит выгрузки из загрузок.
# Ничего не ломает, только читает и пробует. Запускать:
#     bash ~/Downloads/diagnose-agent.sh

set -uo pipefail

APP_HOME="$HOME/.chatmarker"
LABEL="com.chatmarker.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

hdr()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$*"; }
info() { printf "  \033[90m·\033[0m %s\n" "$*"; }

VERDICT=""

printf "\n\033[1mChat Marker — почему не переносятся выгрузки\033[0m\n"

# ---------------------------------------------------------------- 1. файлы

hdr "1. Что на месте"

for f in "$APP_HOME/library.py" "$APP_HOME/highlights_mcp.py" "$APP_HOME/venv/bin/python" "$APP_HOME/root.txt"; do
  [ -e "$f" ] && ok "$(basename "$f")" || bad "нет: $f"
done

if [ -f "$APP_HOME/root.txt" ]; then
  ROOT="$(cat "$APP_HOME/root.txt")"
  info "библиотека: $ROOT"
  [ -d "$ROOT" ] && ok "папка библиотеки существует" || bad "папки библиотеки нет"
fi

hdr "2. Что лежит в загрузках"
PENDING=0
for f in "$HOME/Downloads"/highlights*.json "$HOME/Downloads"/выдержки*.json; do
  [ -e "$f" ] || continue
  PENDING=$((PENDING + 1))
  ok "$(basename "$f") ($(stat -f%z "$f" 2>/dev/null || echo "?") байт)"
done
[ "$PENDING" -eq 0 ] && info "выгрузок в ~/Downloads нет — переносить нечего"

# ---------------------------------------------------------------- 3. агент

hdr "3. Агент launchd"

if [ -f "$PLIST" ]; then
  ok "plist на месте"
else
  bad "plist не создан — install.sh до этого шага не дошёл"
  VERDICT="no-plist"
fi

if ! command -v launchctl >/dev/null 2>&1; then
  bad "launchctl недоступен — это точно macOS?"
  PRINT="Could not find service"
else
  PRINT="$(launchctl print "gui/$UID_NUM/$LABEL" 2>&1)"
fi
if echo "$PRINT" | grep -q "Could not find service"; then
  bad "агент НЕ загружен в launchd"
  [ -z "$VERDICT" ] && VERDICT="not-loaded"
else
  ok "агент зарегистрирован"
  STATE="$(echo "$PRINT"  | awk -F' = ' '/^\tstate/ {print $2; exit}')"
  LASTEXIT="$(echo "$PRINT" | awk -F' = ' '/last exit code/ {print $2; exit}')"
  RUNS="$(echo "$PRINT" | awk -F' = ' '/runs/ {print $2; exit}')"
  info "состояние: ${STATE:-неизвестно}, запусков: ${RUNS:-0}, последний код выхода: ${LASTEXIT:-нет}"
  if [ "${RUNS:-0}" = "0" ]; then
    bad "агент ни разу не запускался — macOS его не будит"
    [ -z "$VERDICT" ] && VERDICT="never-ran"
  fi
  case "${LASTEXIT:-}" in
    ""|0) ;;
    *) bad "последний запуск завершился с ошибкой ($LASTEXIT)"; [ -z "$VERDICT" ] && VERDICT="exit-error" ;;
  esac
fi

hdr "4. Лог агента"
if [ -s "$APP_HOME/sync.log" ]; then
  info "последние строки:"
  tail -8 "$APP_HOME/sync.log" | sed 's/^/     /'
else
  info "лог пуст или отсутствует — агент ничего не писал"
fi

# ---------------------------------------------------------------- 5. руками

hdr "5. Пробую сделать то же самое руками"

PY="$APP_HOME/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

MANUAL="$("$PY" "$APP_HOME/library.py" 2>&1)"
MANUAL_CODE=$?
echo "$MANUAL" | sed 's/^/     /'

if [ $MANUAL_CODE -eq 0 ]; then
  ok "вручную всё работает"
  if echo "$MANUAL" | grep -q "принято выгрузок"; then
    ok "и файл только что переехал в библиотеку"
  fi
else
  bad "вручную тоже падает — дело не в правах, а в самом скрипте"
  VERDICT="script-broken"
fi

# ---------------------------------------------------------------- вывод

hdr "Вывод"

case "$VERDICT" in
  script-broken)
    echo "  Проблема в скрипте, не в системе. Скинь мне вывод пятого раздела целиком."
    ;;
  no-plist|not-loaded)
    echo "  Агент не зарегистрирован в системе. Чинится перезагрузкой агента —"
    echo "  запусти fix-agent.sh, он пересоберёт его современным способом."
    ;;
  never-ran|exit-error)
    echo "  Агент есть, но либо не просыпается, либо падает. Два вероятных повода:"
    echo "    · macOS не разрешил фоновый элемент (Настройки → Основные → Элементы входа)"
    echo "    · у агента нет доступа к папке «Загрузки» (это и есть Full Disk Access)"
    echo "  Запусти fix-agent.sh — он пересоберёт агента так, чтобы права"
    echo "  можно было выдать одной понятной строкой, а не всему bash разом."
    ;;
  *)
    if [ "$PENDING" -eq 0 ] && [ -n "$(ls -A "${ROOT:-/nonexistent}/00 Inbox" 2>/dev/null)" ]; then
      echo "  Похоже, всё в порядке: загрузки пусты, библиотека наполнена."
    else
      echo "  Явной поломки не вижу. Скинь мне вывод целиком, разберёмся по деталям."
    fi
    ;;
esac

echo
