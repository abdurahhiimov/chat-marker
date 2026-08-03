--- chatmarker.lua — захват выделенного текста откуда угодно на маке.
---
--- Зачем: в десктопное приложение Claude нельзя поставить расширение,
--- поэтому маркера там не будет. Вместо него — глобальный хоткей:
--- выделил текст → нажал → кусок улетел в ту же базу, что и браузерные выдержки,
--- с пометкой, из какого приложения и окна он взят.
---
--- Хоткеи (⌃⌥⌘ — control+option+command):
---   ⌃⌥⌘1  формулировка (жёлтый)
---   ⌃⌥⌘2  идея (зелёный)
---   ⌃⌥⌘3  факт / метод (синий)
---   ⌃⌥⌘4  спорно / вернуться (красный)
---   ⌃⌥⌘N  захватить и сразу написать заметку
---   ⌃⌥⌘O  открыть папку с базой
---
--- Почему именно ⌃⌥⌘, а не что-то короче: Alt+1…4 уже заняты браузерным
--- маркером — он ловит их на странице. Сократишь эти хоткеи до Alt+цифра —
--- в браузере они перестанут доходить до маркера, и сломается непонятно что
--- непонятно почему. Три клавиши — осознанный минимум. Если меняешь,
--- выбирай сочетание, которого нет ни в браузере, ни в системе.

local M = {}

local HOME = os.getenv("HOME")
local APP_HOME = HOME .. "/.chatmarker"

--- Корень библиотеки в Google Drive. Путь пишет install.sh в root.txt,
--- потому что у Drive он длинный и содержит адрес почты.
local function libraryRoot()
  local f = io.open(APP_HOME .. "/root.txt", "r")
  if f then
    local p = (f:read("*l") or ""):gsub("%s+$", "")
    f:close()
    if p ~= "" then return p end
  end
  -- запасной вариант, если файла нет: ищем сами
  local out = hs.execute([[ls -d "$HOME/Library/CloudStorage/GoogleDrive-"*/"My Drive/AI Highlights" 2>/dev/null | head -1]])
  out = (out or ""):gsub("%s+$", "")
  if out ~= "" then return out end
  return HOME .. "/AI Highlights"
end

local ROOT = libraryRoot()
local INBOX = ROOT .. "/00 Inbox"
local JSON_FILE = INBOX .. "/desktop.json"
local MD_FILE = ROOT .. "/04 Черновики/Захвачено с десктопа.md"

local COLORS = {
  ["1"] = { id = "yellow", label = "формулировка" },
  ["2"] = { id = "green",  label = "идея" },
  ["3"] = { id = "blue",   label = "факт/метод" },
  ["4"] = { id = "red",    label = "спорно/todo" },
}

local function ensureVault()
  hs.execute("mkdir -p '" .. INBOX .. "' '" .. ROOT .. "/04 Черновики'")
end

--- Пересобираем библиотеку в фоне, чтобы захват не подвисал.
local function rebuild()
  local py = APP_HOME .. "/venv/bin/python"
  if not hs.fs.attributes(py) then return end
  hs.task.new(py, nil, { APP_HOME .. "/library.py", "--no-ingest" }):start()
end

local function readJson()
  local f = io.open(JSON_FILE, "r")
  if not f then return { highlights = {} } end
  local raw = f:read("*a")
  f:close()
  if not raw or raw == "" then return { highlights = {} } end
  local ok, data = pcall(hs.json.decode, raw)
  if not ok or type(data) ~= "table" or type(data.highlights) ~= "table" then
    return { highlights = {} }
  end
  return data
end

local function writeJson(data)
  local f = io.open(JSON_FILE, "w")
  if not f then
    hs.alert.show("Не смог записать " .. JSON_FILE)
    return false
  end
  f:write(hs.json.encode(data, true))
  f:close()
  return true
end

local function appendMd(entry)
  local f = io.open(MD_FILE, "a")
  if not f then return end
  f:write(string.format(
    "\n> %s\n\n`%s` · %s · %s\n%s\n---\n",
    entry.text:gsub("\n", "\n> "),
    entry.colorLabel,
    entry.title,
    entry.createdAt:sub(1, 16):gsub("T", " "),
    entry.note ~= "" and ("\n**Заметка:** " .. entry.note .. "\n") or ""
  ))
  f:close()
end

--- Копирует выделение, не ломая буфер обмена пользователя.
local function grabSelection()
  local before = hs.pasteboard.getContents()
  local marker = "\0__chatmarker__" .. tostring(hs.timer.absoluteTime())
  hs.pasteboard.setContents(marker)

  hs.eventtap.keyStroke({ "cmd" }, "c", 0)

  -- ждём, пока приложение положит текст в буфер (до ~0.6 сек)
  local text = nil
  for _ = 1, 12 do
    hs.timer.usleep(50000)
    local now = hs.pasteboard.getContents()
    if now and now ~= marker then
      text = now
      break
    end
  end

  hs.timer.doAfter(0.15, function()
    hs.pasteboard.setContents(before or "")
  end)

  return text
end

local function iso8601()
  -- локальное время в формате, который понимает остальная часть системы
  return os.date("!%Y-%m-%dT%H:%M:%S") .. ".000Z"
end

local function uid()
  return string.format("hs%x%x", math.random(0, 0xffffff), math.floor(hs.timer.absoluteTime() % 0xffff))
end

--- Кодирует путь для file://-ссылки. Работает побайтово, поэтому кириллица
--- в имени файла кодируется корректно (по байту UTF-8 за раз).
local function encodePath(p)
  return (p:gsub("[^%w%-%._~/]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

--- «Просмотр» пишет номер страницы прямо в заголовок окна:
---   «ОТЧЕТ.pdf – Страница 10 из 111»
--- Парсим номер, а путь к файлу спрашиваем у Preview через AppleScript.
--- Получается ссылка «к месту» для десктопных выдержек — file://…#page=N,
--- дашборд открывает её в браузере ровно на нужной странице.
local function placeLink(app, winTitle)
  local page = winTitle:match("[Сс]траница (%d+)") or winTitle:match("[Pp]age (%d+)")
  if not page then return "", nil end

  local url = ""
  if app and app:bundleID() == "com.apple.Preview" then
    local ok, path = pcall(function()
      local good, result = hs.osascript.applescript(
        'tell application "Preview" to get path of front document')
      return good and result or nil
    end)
    if ok and type(path) == "string" and path ~= "" then
      url = "file://" .. encodePath(path) .. "#page=" .. page
    end
  end
  return url, tonumber(page)
end

--- Два нажатия подряд на одном выделении — почти всегда случайность,
--- а не желание сохранить дважды.
local lastCapture = { text = nil, app = nil, at = 0 }

local function capture(colorId, colorLabel, withNote)
  local text = grabSelection()
  if not text or text:gsub("%s", "") == "" then
    hs.alert.show("Сначала выдели текст")
    return
  end

  local app = hs.application.frontmostApplication()
  local appName = app and app:name() or "неизвестно"

  local nowSec = hs.timer.secondsSinceEpoch()
  if text == lastCapture.text and appName == lastCapture.app
     and (nowSec - lastCapture.at) < 3 then
    hs.alert.show("Уже сохранено", 0.6)
    return
  end
  lastCapture = { text = text, app = appName, at = nowSec }

  local win = hs.window.focusedWindow()
  local winTitle = win and win:title() or ""
  local title = winTitle ~= "" and (appName .. " — " .. winTitle) or appName
  local url, page = placeLink(app, winTitle)

  local note = ""
  if withNote then
    -- hs.dialog активирует Hammerspoon: если открыта консоль, она вылезет
    -- поверх всего экрана. Прячем её заранее.
    if hs.console.hswindow() then hs.closeConsole() end
    local button, input = hs.dialog.textPrompt(
      "Заметка к выдержке",
      text:sub(1, 160) .. (#text > 160 and "…" or "") .. "\n\nСлово с решёткой, например #найм, соберёт выдержку в тему.",
      "", "Сохранить", "Без заметки"
    )
    if button == "Сохранить" then note = input or "" end
  end

  ensureVault()
  local entry = {
    id = uid(),
    conv = "desktop::" .. appName,
    site = "desktop",
    url = url,
    page = page,
    title = title,
    color = colorId,
    colorLabel = colorLabel,
    note = note,
    text = text,
    createdAt = iso8601(),
  }

  local db = readJson()
  table.insert(db.highlights, entry)
  if writeJson(db) then
    appendMd(entry)
    rebuild()
    hs.alert.show("✎ " .. colorLabel .. " · " .. appName, 0.8)
  end
end

--- Физические коды клавиш (ANSI). Буквенные имена ломаются на неанглийской
--- раскладке: hs.keycode не находит 'n' в русской раскладке, сыплет
--- предупреждения и вешает хоткей на «т». Коды от раскладки не зависят.
local KEYCODES = { ["1"] = 18, ["2"] = 19, ["3"] = 20, ["4"] = 21, n = 45, o = 31 }

function M.start()
  math.randomseed(os.time())
  ensureVault()

  -- Без «Универсального доступа» хоткеи молча не работают — ни звука, ни плашки.
  -- Проверяем сразу и просим права системным диалогом, чтобы не гадать.
  if not hs.accessibilityState(true) then
    hs.alert.show(
      "Chat Marker: дай Hammerspoon «Универсальный доступ»\n" ..
      "Настройки → Конфиденциальность и безопасность → Универсальный доступ.\n" ..
      "Без этого хоткеи захвата не работают.", 6)
  end

  local mods = { "ctrl", "alt", "cmd" }
  for key, c in pairs(COLORS) do
    hs.hotkey.bind(mods, KEYCODES[key], function() capture(c.id, c.label, false) end)
  end
  hs.hotkey.bind(mods, KEYCODES.n, function() capture("yellow", "формулировка", true) end)
  hs.hotkey.bind(mods, KEYCODES.o, function() hs.execute("open '" .. ROOT .. "'") end)

  print("[chatmarker] хоткеи повешены, библиотека: " .. ROOT)
end

M.start()
return M
