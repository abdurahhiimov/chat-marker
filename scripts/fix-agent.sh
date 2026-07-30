#!/bin/bash
# Пересобирает фоновый агент так, чтобы доступ к папке «Загрузки»
# можно было выдать одному понятному пункту, а не всему bash разом.
#
# Что делает:
#   1. собирает крошечное приложение «ChatMarker Sync.app» — оно только
#      запускает сборку библиотеки и больше ничего не умеет;
#   2. подписывает его локально, чтобы система запомнила выданное право;
#   3. перевешивает агента launchd на это приложение современным способом;
#   4. печатает, что именно перетащить в Full Disk Access.
#
# Запускать: bash fix-agent.sh

set -uo pipefail

APP_HOME="$HOME/.chatmarker"
LABEL="com.chatmarker.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APPDIR="$HOME/Applications/ChatMarker Sync.app"
EXE="$APPDIR/Contents/MacOS/ChatMarkerSync"
UID_NUM="$(id -u)"

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
die()  { printf "\n\033[31m✗ %s\033[0m\n\n" "$*"; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Скрипт для macOS."
[ -f "$APP_HOME/library.py" ] || die "Не нашёл ~/.chatmarker/library.py — сначала запусти install.sh"

# ---------------------------------------------------------------- 1. приложение

say "1. Собираю приложение-запускалку"

mkdir -p "$APPDIR/Contents/MacOS"

cat > "$APPDIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>ChatMarkerSync</string>
    <key>CFBundleIdentifier</key><string>com.chatmarker.sync</string>
    <key>CFBundleName</key><string>ChatMarker Sync</string>
    <key>CFBundleDisplayName</key><string>ChatMarker Sync</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSUIElement</key><true/>
    <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
EOF

TMPBASE="$(mktemp -t chatmarker)"
SRC="$TMPBASE.c"
cat > "$SRC" <<'EOF'
/* Запускает сборку библиотеки. Больше ничего не делает.
   Отдельный бинарник нужен затем, чтобы macOS выдавала доступ к «Загрузкам»
   именно этому приложению, а не всем скриптам на машине. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>

extern char **environ;

int main(void) {
    const char *home = getenv("HOME");
    if (home == NULL) return 2;

    /* корень библиотеки берём из root.txt — тот же, что выбрал install.sh,
       иначе при двух Google-аккаунтах агент и MCP собирали бы разные папки */
    char rootfile[1024], rootbuf[1024];
    snprintf(rootfile, sizeof rootfile, "%s/.chatmarker/root.txt", home);
    FILE *rf = fopen(rootfile, "r");
    if (rf) {
        if (fgets(rootbuf, sizeof rootbuf, rf)) {
            rootbuf[strcspn(rootbuf, "\n")] = 0;
            if (rootbuf[0]) setenv("CHATMARKER_ROOT", rootbuf, 0);
        }
        fclose(rf);
    }

    char py[1024], venv[1024], script[1024];
    snprintf(venv,   sizeof venv,   "%s/.chatmarker/venv/bin/python", home);
    snprintf(script, sizeof script, "%s/.chatmarker/library.py",      home);

    if (access(venv, X_OK) == 0) {
        snprintf(py, sizeof py, "%s", venv);
    } else if (access("/opt/homebrew/bin/python3", X_OK) == 0) {
        snprintf(py, sizeof py, "/opt/homebrew/bin/python3");
    } else {
        snprintf(py, sizeof py, "/usr/bin/python3");
    }

    char *args[] = { py, script, "--quiet", NULL };
    pid_t pid;
    if (posix_spawn(&pid, args[0], NULL, NULL, args, environ) != 0) {
        perror("posix_spawn");
        return 3;
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return 4;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
EOF

COMPILED=0
if command -v clang >/dev/null 2>&1 && clang -O2 -o "$EXE" "$SRC" 2>/dev/null; then
  COMPILED=1
  ok "бинарник собран"
else
  warn "clang недоступен — делаю запускалку скриптом"
  cat > "$EXE" <<'EOF'
#!/bin/bash
PY="$HOME/.chatmarker/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
if [ -z "${CHATMARKER_ROOT:-}" ] && [ -s "$HOME/.chatmarker/root.txt" ]; then
  CHATMARKER_ROOT="$(head -n1 "$HOME/.chatmarker/root.txt")"
  export CHATMARKER_ROOT
fi
exec "$PY" "$HOME/.chatmarker/library.py" --quiet
EOF
fi
chmod +x "$EXE"
rm -f "$SRC" "$TMPBASE"

# ---------------------------------------------------------------- 2. подпись

say "2. Подписываю локально"

if command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$APPDIR" >/dev/null 2>&1; then
  ok "подписано (система запомнит выданное право)"
else
  warn "подписать не вышло — право придётся выдать заново, если приложение пересоберётся"
fi

# ---------------------------------------------------------------- 3. агент

say "3. Перевешиваю агента"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$EXE</string></array>
    <key>WatchPaths</key>
    <array><string>$HOME/Downloads</string></array>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$APP_HOME/sync.log</string>
    <key>StandardErrorPath</key><string>$APP_HOME/sync.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1
launchctl unload "$PLIST" >/dev/null 2>&1

if launchctl bootstrap "gui/$UID_NUM" "$PLIST" >/dev/null 2>&1; then
  ok "агент зарегистрирован"
elif launchctl load "$PLIST" >/dev/null 2>&1; then
  ok "агент зарегистрирован (старым способом)"
else
  warn "launchctl не принял агента — покажи мне вывод: launchctl print gui/$UID_NUM/$LABEL"
fi

launchctl enable "gui/$UID_NUM/$LABEL" >/dev/null 2>&1
launchctl kickstart -k "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 && ok "запустил пробный прогон"

# ---------------------------------------------------------------- 4. права

say "4. Осталось выдать доступ — один раз"

cat <<EOF

  Открой:  Настройки системы → Конфиденциальность и безопасность
           → Полный доступ к диску

  Нажми «+», в окне выбора нажми Cmd+Shift+G и вставь путь:

      ~/Applications

  Выбери «ChatMarker Sync» и включи для него переключатель.

  Это приложение умеет ровно одно: прочитать выгрузку из загрузок
  и разложить её по папкам в Google Drive. Ничего другого в нём нет
  ($([ $COMPILED = 1 ] && echo "исходник на C, полсотни строк, собран прямо сейчас" || echo "три строки на bash")).

  Заодно проверь: Настройки → Основные → Элементы входа →
  раздел «Разрешить в фоновом режиме». Там должен быть включён
  ChatMarker Sync. macOS иногда добавляет фоновые элементы выключенными.

EOF

say "5. Как проверить, что заработало"

cat <<'EOF'

  Выгрузи .json из боковой панели в браузере и подожди секунд десять.
  Файл должен исчезнуть из загрузок, а в папке библиотеки — обновиться
  «Индекс.md». Если не произошло:

      tail -20 ~/.chatmarker/sync.log

  И скинь мне, что там.

EOF
