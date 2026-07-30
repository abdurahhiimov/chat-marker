#!/bin/bash
# Убирает всё, что поставил install.sh. Базу с выдержками НЕ трогает.
set -uo pipefail

APP_HOME="$HOME/.chatmarker"
PLIST="$HOME/Library/LaunchAgents/com.chatmarker.sync.plist"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

echo "Снимаю агент слежения за загрузками…"
launchctl bootout "gui/$(id -u)/com.chatmarker.sync" >/dev/null 2>&1
launchctl unload "$PLIST" >/dev/null 2>&1
rm -f "$PLIST"
rm -rf "$HOME/Applications/ChatMarker Sync.app"

echo "Убираю сервер из конфига Claude Desktop…"
# Свой питон надёжнее системного: на чистом маке python3 — заглушка,
# которая откроет окно установки Xcode вместо работы.
PY="$APP_HOME/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 2>/dev/null || true)"

if [ -f "$CLAUDE_CFG" ] && [ -z "$PY" ]; then
  echo "  ! питона нет — убери \"highlights\" из конфига руками:"
  echo "    $CLAUDE_CFG"
elif [ -f "$CLAUDE_CFG" ]; then
  cp "$CLAUDE_CFG" "$CLAUDE_CFG.backup-$(date +%Y%m%d-%H%M%S)"
  "$PY" - "$CLAUDE_CFG" <<'PYEOF'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
try:
    cfg = json.loads(p.read_text(encoding="utf-8"))
except Exception:
    sys.exit(0)
cfg.get("mcpServers", {}).pop("highlights", None)
p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
print("  готово")
PYEOF
fi

echo "Убираю строку из конфига Hammerspoon…"
INIT="$HOME/.hammerspoon/init.lua"
if [ -f "$INIT" ]; then
  # grep -v возвращает 1, если строк не осталось — файл всё равно нужно заменить
  grep -v 'require("chatmarker")' "$INIT" > "$INIT.tmp" || true
  mv "$INIT.tmp" "$INIT"
fi
rm -f "$HOME/.hammerspoon/chatmarker.lua"

echo "Удаляю ~/.chatmarker…"
rm -rf "$APP_HOME"

cat <<EOF

Готово. Удалено: служебная папка, свой питон, фоновый агент, запись в конфиге Claude.

Осталось руками, если нужно:
  · удалить скрипт в Tampermonkey (иконка расширения → Панель управления)
  · папка «Документы/Chat Marker» — просмотрщик и мануал, я её не трогаю
  · библиотека выдержек тоже на месте: «AI Highlights»

EOF
