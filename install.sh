#!/bin/bash
# Установщик Chat Marker для macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/abdurahhiimov/chat-marker/main/install.sh | bash
#
# или, если папка уже скачана:  bash install.sh
#
# Ничего не требует заранее: если питона на маке нет, ставит свой, в свою папку,
# без brew и без пароля администратора. Повторный запуск безопасен.

set -uo pipefail

REPO_TAR="https://github.com/abdurahhiimov/chat-marker/archive/refs/heads/main.tar.gz"
RAW_USERJS="https://raw.githubusercontent.com/abdurahhiimov/chat-marker/main/chat-marker.user.js"

APP_HOME="$HOME/.chatmarker"
VISIBLE="$HOME/Documents/Chat Marker"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PY_MIN="3.10"

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m•\033[0m %s\n" "$*"; }
die()  { printf "\n\033[31m✗ %s\033[0m\n\n" "$*"; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Скрипт для macOS. На Windows и Linux работает только браузерная часть."

printf "\n\033[1mChat Marker\033[0m — установка\n"
printf "Займёт минуту-две. Пароль администратора не понадобится.\n"

# ------------------------------------------------------------------ 0. откуда файлы

KIT=""
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  D="$(cd "$(dirname "$SELF")" && pwd)"
  [ -f "$D/chat-marker.user.js" ] && KIT="$D"
fi

CLEANUP=""
if [ -z "$KIT" ]; then
  say "0. Качаю файлы"
  TMP="$(mktemp -d)" || die "Не смог создать временную папку."
  CLEANUP="$TMP"
  if curl -fsSL "$REPO_TAR" | tar xz -C "$TMP" 2>/dev/null; then
    KIT="$(find "$TMP" -maxdepth 2 -name chat-marker.user.js -print -quit)"
    KIT="$(dirname "$KIT")"
  fi
  [ -n "$KIT" ] && [ -f "$KIT/chat-marker.user.js" ] || die "Не смог скачать файлы. Проверь интернет и попробуй ещё раз."
  ok "Скачано"
fi

cleanup() { [ -n "$CLEANUP" ] && rm -rf "$CLEANUP"; }
trap cleanup EXIT

mkdir -p "$APP_HOME"

# ------------------------------------------------------------------ 1. python

say "1. Python"

py_ok() { [ -x "$1" ] && "$1" -c 'import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)' >/dev/null 2>&1; }

PY=""
# Системный python3 трогаем, только если инструменты разработчика уже стоят:
# иначе /usr/bin/python3 — заглушка, которая молча откроет окно установки Xcode.
if xcode-select -p >/dev/null 2>&1; then
  SYS="$(command -v python3 2>/dev/null || true)"
  py_ok "$SYS" && PY="$SYS"
fi
if [ -z "$PY" ]; then
  for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 "$APP_HOME/python/bin/python3"; do
    if py_ok "$c"; then PY="$c"; break; fi
  done
fi

if [ -n "$PY" ]; then
  ok "Нашёл питон: $("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])') ($PY)"
else
  warn "Питона нет — ставлю свой, в $APP_HOME, ни на что в системе не влияет"
  UV="$APP_HOME/bin/uv"
  if [ ! -x "$UV" ]; then
    curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR="$APP_HOME/bin" UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1
  fi
  [ -x "$UV" ] || die "Не смог скачать установщик питона.

Проверь интернет и запусти ещё раз. Если не помогает, поставь питон вручную
с python.org (кнопка «Download for macOS»), потом запусти установку заново."

  # Держим питон внутри своей папки: удаление сносит всё одним движением
  # и не задевает ничего системного.
  export UV_PYTHON_INSTALL_DIR="$APP_HOME/python"
  "$UV" python install 3.12 >/dev/null 2>&1
  PY="$("$UV" python find 3.12 2>/dev/null || true)"
  if ! py_ok "$PY"; then
    for c in "$APP_HOME"/python/*/bin/python3; do py_ok "$c" && PY="$c" && break; done
  fi
  py_ok "$PY" || die "Питон скачался, но не запускается. Покажи мне вывод этой команды:
    $UV python install 3.12"
  ok "Питон 3.12 поставлен (только для Chat Marker, системный не тронут)"
fi

# ------------------------------------------------------------------ 2. окружение

say "2. Рабочее окружение"

cp "$KIT/scripts/library.py"        "$APP_HOME/" || die "Не смог скопировать library.py"
cp "$KIT/scripts/highlights_mcp.py" "$APP_HOME/"
cp "$KIT/scripts/sync-downloads.sh" "$APP_HOME/"
cp "$KIT/scripts/fix-agent.sh"      "$APP_HOME/"
cp "$KIT/scripts/diagnose-agent.sh" "$APP_HOME/"
chmod +x "$APP_HOME"/*.sh

VPY="$APP_HOME/venv/bin/python"
if [ ! -x "$VPY" ]; then
  "$PY" -m venv "$APP_HOME/venv" >/dev/null 2>&1 || die "Не смог создать окружение в $APP_HOME/venv"
fi
"$APP_HOME/venv/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1

# Claude Desktop есть не у всех — mcp тянем только если он реально нужен.
HAS_CLAUDE=""
if [ -d "/Applications/Claude.app" ] || [ -d "$HOME/Applications/Claude.app" ] \
   || [ -d "$HOME/Library/Application Support/Claude" ]; then
  HAS_CLAUDE="yes"
fi

DEPS="openpyxl python-docx"
[ -n "$HAS_CLAUDE" ] && DEPS="$DEPS mcp[cli]"
# shellcheck disable=SC2086
if "$APP_HOME/venv/bin/pip" install --quiet $DEPS >/dev/null 2>&1; then
  ok "Библиотеки поставлены ($DEPS)"
else
  warn "Не всё поставилось. Таблица и .docx могут не собраться."
  warn "Руками: $APP_HOME/venv/bin/pip install $DEPS"
fi

# ------------------------------------------------------------------ 3. где библиотека

say "3. Папка библиотеки"

ROOT="${CHATMARKER_ROOT:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$APP_HOME" && "$VPY" -c 'from library import find_drive_root; print(find_drive_root())' 2>/dev/null)"
fi
if [ -z "$ROOT" ]; then
  ROOT="$HOME/Documents/AI Highlights"
  warn "Google Drive не нашёл — библиотека будет лежать локально:"
  warn "$ROOT"
  warn "Поставишь Drive потом — просто запусти установку ещё раз, всё переедет."
else
  ok "Библиотека: $ROOT"
fi
printf '%s\n' "$ROOT" > "$APP_HOME/root.txt"

if CHATMARKER_ROOT="$ROOT" "$VPY" "$APP_HOME/library.py" --no-ingest >/dev/null 2>&1; then
  ok "Структура папок создана"
else
  warn "Структуру создать не вышло — библиотека соберётся при первой выгрузке"
fi

# ------------------------------------------------------------------ 4. видимая папка

say "4. Папка «Chat Marker» в Документах"

mkdir -p "$VISIBLE"
cp "$KIT/chat-marker.user.js" "$VISIBLE/"
cp "$KIT/Просмотр выдержек.html" "$VISIBLE/" 2>/dev/null
cp "$KIT/docs/Chat Marker — мануал.html" "$VISIBLE/" 2>/dev/null
cp "$KIT/chat-marker.user.js" "$APP_HOME/"

cat > "$VISIBLE/Прочти меня.txt" <<EOF
Chat Marker
===========

Просмотр выдержек.html
    Двойной клик. Перетащи внутрь highlights.json из «Загрузок» —
    увидишь все выделения с поиском и фильтрами. Ничего не требует.

Chat Marker — мануал.html
    Двойной клик. Подробно: что умеет, как пользоваться.

chat-marker.user.js
    Сам скрипт для браузера. Ставится через Tampermonkey,
    см. мануал, раздел про установку.

Библиотека: $ROOT
Служебная папка: $APP_HOME
Обновить: bash $APP_HOME/update.sh
Удалить:  bash $APP_HOME/uninstall.sh
EOF
ok "$VISIBLE"

# ------------------------------------------------------------------ 5. Claude Desktop

say "5. Claude Desktop"

if [ -n "$HAS_CLAUDE" ]; then
  mkdir -p "$(dirname "$CLAUDE_CFG")"
  [ -f "$CLAUDE_CFG" ] && cp "$CLAUDE_CFG" "$CLAUDE_CFG.backup-$(date +%Y%m%d-%H%M%S)"
  ROOT="$ROOT" APP_HOME="$APP_HOME" CLAUDE_CFG="$CLAUDE_CFG" HOME_DIR="$HOME" \
  "$VPY" <<'PYEOF'
import json, os
from pathlib import Path

cfg_path = Path(os.environ["CLAUDE_CFG"])
app, root, home = os.environ["APP_HOME"], os.environ["ROOT"], os.environ["HOME_DIR"]

cfg = {}
if cfg_path.exists():
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        print("  • старый конфиг не читается, пишу новый (бэкап рядом)")
if not isinstance(cfg, dict):
    cfg = {}

cfg.setdefault("mcpServers", {})
cfg["mcpServers"]["highlights"] = {
    "command": f"{app}/venv/bin/python",
    "args": [f"{app}/highlights_mcp.py"],
    "env": {
        "HIGHLIGHTS_PATH": f"{root}/00 Inbox:{home}/Downloads",
        "CHATMARKER_ROOT": root,
    },
}
cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
print("  \033[32m✓\033[0m Сервер highlights прописан, чужие серверы не тронуты")
PYEOF
else
  warn "Claude Desktop не установлен — пропускаю."
  warn "Поставишь потом (claude.ai/download) — запусти установку ещё раз."
fi

# ------------------------------------------------------------------ 6. автосборка

say "6. Автосборка при выгрузке"

if bash "$APP_HOME/fix-agent.sh" >/dev/null 2>&1; then
  ok "Фоновый агент установлен (доступ выдашь в конце, см. ниже)"
else
  warn "Агент не встал — не страшно, библиотека соберётся при запросе к Claude"
fi

# ------------------------------------------------------------------ 7. хоткей

say "7. Хоткей вне браузера (по желанию)"

if [ -d "/Applications/Hammerspoon.app" ]; then
  mkdir -p "$HOME/.hammerspoon"
  cp "$KIT/extras/hammerspoon/chatmarker.lua" "$HOME/.hammerspoon/chatmarker.lua" 2>/dev/null
  INIT="$HOME/.hammerspoon/init.lua"
  touch "$INIT"
  grep -q 'chatmarker' "$INIT" || printf '\nrequire("chatmarker")\n' >> "$INIT"
  ok "Hammerspoon настроен — открой его и нажми Reload Config"
else
  warn "Hammerspoon не стоит — выделять можно только в браузере. Этого хватает."
fi

# ------------------------------------------------------------------ 8. обновление и удаление

cp "$KIT/scripts/uninstall.sh" "$APP_HOME/uninstall.sh" 2>/dev/null
cat > "$APP_HOME/update.sh" <<EOF
#!/bin/bash
# Обновляет Chat Marker до свежей версии.
curl -fsSL https://raw.githubusercontent.com/abdurahhiimov/chat-marker/main/install.sh | bash
EOF
chmod +x "$APP_HOME/update.sh" "$APP_HOME/uninstall.sh" 2>/dev/null

# ------------------------------------------------------------------ итог

cat <<EOF

────────────────────────────────────────────────────────────
Готово. Осталось только браузер — это руками, за минуту.

1. Поставь Tampermonkey:  https://tampermonkey.net
   (кнопка Chrome → Install → Добавить расширение)

2. Включи для него режим разработчика:
   chrome://extensions → верхний правый угол → «Режим разработчика»
   Без этого Chrome не даст расширению запускать скрипты.

3. Поставь сам скрипт — открой ссылку, Tampermonkey сам предложит:
   $RAW_USERJS
   Нажми «Install» (или «Установить»).

4. Зайди на claude.ai или любую статью, перезагрузи страницу.
   Внизу справа появится круглая кнопка. Выдели текст мышкой —
   всплывёт панель с цветами.
EOF

if [ -n "$HAS_CLAUDE" ]; then
cat <<EOF

5. Перезапусти Claude Desktop через Cmd+Q (закрыть окно — мало).
   Проверь: спроси «покажи статистику по моим выдержкам».

6. Чтобы выгрузки уезжали в библиотеку сами:
   Системные настройки → Конфиденциальность и безопасность →
   Полный доступ к диску → «+» → Cmd+Shift+G → ~/Applications
   → выбери «ChatMarker Sync». Пропустишь — тоже работает,
   просто сборка случится в момент запроса к Claude.
EOF
fi

cat <<EOF

Твоя папка:   $VISIBLE
Библиотека:   $ROOT
────────────────────────────────────────────────────────────

EOF

open "$VISIBLE" 2>/dev/null
exit 0
