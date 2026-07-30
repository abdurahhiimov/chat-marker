#!/usr/bin/env python3
"""
highlights_mcp — MCP-сервер поверх выдержек из Chat Marker.

Даёт Claude искать по всему, что ты отметил маркером в браузере: по теме,
по источнику, по дате, по словам. И собирать подборки, из которых растут
конспекты.

Перед каждым запросом сервер сам забирает свежие выгрузки из ~/Downloads
и пересобирает библиотеку в Google Drive, если что-то изменилось.

Ставится через install.sh. Руками — только если что-то сломалось:

    python3 -m venv ~/.chatmarker/venv
    ~/.chatmarker/venv/bin/pip install "mcp[cli]" openpyxl

Конфиг Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):
    {
      "mcpServers": {
        "highlights": {
          "command": "/Users/<ты>/.chatmarker/venv/bin/python",
          "args": ["/Users/<ты>/.chatmarker/highlights_mcp.py"]
        }
      }
    }
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("highlights")

NO_TAG = "без темы"
TAG_RE = re.compile(r"#([^\W\d_][\w-]{1,39})", re.UNICODE)


# ---------------------------------------------------------------- источники

def _drive_roots() -> list[Path]:
    home = Path.home()
    out: list[Path] = []
    cloud = home / "Library" / "CloudStorage"
    if cloud.is_dir():
        for d in sorted(cloud.glob("GoogleDrive-*")):
            for inner in ("My Drive", "Мой диск"):
                if (d / inner).is_dir():
                    out.append(d / inner / "AI Highlights")
    for legacy in (home / "Google Drive" / "My Drive", home / "Google Drive"):
        if legacy.is_dir():
            out.append(legacy / "AI Highlights")
    return out


def _sources() -> list[Path]:
    """Все места, где могут лежать выдержки. Переопределяется HIGHLIGHTS_PATH."""
    env = os.environ.get("HIGHLIGHTS_PATH", "").strip()
    if env:
        return [Path(p).expanduser() for p in env.split(":") if p.strip()]
    out = [r / "00 Inbox" for r in _drive_roots()]
    out.append(Path.home() / "Downloads")
    return out


DEFAULT_PATH = ", ".join(str(p) for p in _sources())


def _files() -> list[Path]:
    found: list[Path] = []
    for p in _sources():
        try:
            if p.is_dir():
                for pat in ("highlights*.json", "выдержки*.json", "desktop*.json"):
                    found += list(p.glob(pat))
            elif p.exists() and p.suffix == ".json":
                found.append(p)
        except OSError:
            continue
    uniq = {f.resolve(): f for f in found}

    def mtime(f: Path) -> float:
        try:
            return f.stat().st_mtime
        except OSError:      # файл увезли, пока мы искали — не повод падать
            return 0.0

    return sorted((f for f in uniq.values() if mtime(f)), key=mtime, reverse=True)


_CACHE: dict[str, Any] = {"sig": None, "items": []}


def _load_raw() -> list[dict[str, Any]]:
    """Чтение с кэшем по mtime: на большой библиотеке полный репарс JSON
    на каждый вызов тула — секунды, а файлы меняются редко."""
    files = _files()
    try:
        sig = tuple((str(f), f.stat().st_mtime_ns, f.stat().st_size) for f in files)
    except OSError:
        sig = None
    if sig is not None and sig == _CACHE["sig"]:
        return _CACHE["items"]

    items = _read_files(files)
    if sig is not None:
        _CACHE["sig"] = sig
        _CACHE["items"] = items
    return items


def _read_files(files) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for h in (data if isinstance(data, list) else data.get("highlights", [])):
            hid = h.get("id")
            if not hid or hid in seen:
                continue
            seen.add(hid)
            out.append(h)
    out.sort(key=lambda h: h.get("createdAt", ""), reverse=True)
    return out


def _doc_topics() -> set[str]:
    """Темы, по которым ведётся живой документ: флаг ставится в браузере."""
    docs: set[str] = set()
    decided: set[str] = set()
    for f in _files():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for t in (data.get("tags", []) if isinstance(data, dict) else []):
            name = str(t.get("name") or "").strip().lower()
            if not name or name in decided:
                continue
            decided.add(name)
            if t.get("doc"):
                docs.add(name)
    return docs


# ---------------------------------------------------------------- автосборка

_LAST_SYNC = {"at": 0.0}
_COOLDOWN = 3.0


def _sync(force: bool = False) -> dict | None:
    now = time.monotonic()
    if not force and now - _LAST_SYNC["at"] < _COOLDOWN:
        return None
    _LAST_SYNC["at"] = now
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import library  # импорт отложен намеренно
        return library.run(do_ingest=True, force=force, quiet=True)
    except SystemExit:
        return None   # Google Drive ещё не готов
    except Exception:
        return None   # сборка не критична, поиск всё равно отработает


# ---------------------------------------------------------------- разбор

SPA_HOSTS = re.compile(r"(^|\.)(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|aistudio\.google\.com)$", re.I)


def fragment_url(h: dict) -> str:
    """Ссылка, которая откроет источник и прокрутит ровно к этому месту.

    Штатные текстовые фрагменты браузера: страница#:~:text=кусок
    Контекст не добавляем — начала и конца достаточно, а склейка соседних
    блоков в индексе делает префикс/суффикс ненадёжными.
    """
    url = (h.get("url") or "").split("#")[0]
    if not url:
        return ""
    try:
        from urllib.parse import urlparse, quote
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return ""          # javascript: и прочее из недоверенных выгрузок
        if SPA_HOSTS.search(parsed.hostname or ""):
            return url
    except Exception:
        return ""

    ex = re.sub(r"\s+", " ", (h.get("anchor") or {}).get("exact") or h.get("text") or "").strip()
    if not ex:
        return url

    enc = lambda t: quote(t, safe="").replace("-", "%2D")
    if len(ex) > 70:
        head = re.sub(r"\s\S*$", "", ex[:40])
        tail = re.sub(r"^\S*\s", "", ex[-40:])
        directive = f"{enc(head)},{enc(tail)}"
    else:
        directive = enc(ex)
    return f"{url}#:~:text={directive}"


def _tags(h: dict[str, Any]) -> list[str]:
    """Темы выдержки. Новый формат — поле tag, старый — хештеги в заметке."""
    raw = h.get("tag")
    if isinstance(raw, str) and raw.strip():
        return [raw.strip().lower()]
    slug = h.get("slug")
    if isinstance(slug, str) and slug.strip():
        return [slug.strip().lower()]
    many = h.get("tags")
    if isinstance(many, list) and many:
        return [str(t).strip().lower() for t in many if str(t).strip()]
    return sorted({m.group(1).lower() for m in TAG_RE.finditer(h.get("note") or "")})


def _local(iso: str) -> str:
    """Время выдержки в местном поясе — createdAt хранится в UTC."""
    try:
        dt = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
        return dt.astimezone().strftime("%Y-%m-%d %H:%M")
    except Exception:
        return (iso or "")[:16].replace("T", " ")


def _fmt(h: dict[str, Any], index: int | None = None) -> str:
    head = f"[{index}] " if index is not None else ""
    tags = _tags(h)
    label = " ".join("#" + t for t in tags) if tags else NO_TAG
    when = (h.get("createdAt") or "")[:10]
    lines = [
        f"{head}({label}, {when}) источник: {h.get('title') or h.get('conv')}",
        "> " + (h.get("text", "") or "").strip().replace("\n", "\n> "),
    ]
    if h.get("note"):
        lines.append(f"заметка: {h['note']}")
    fu = fragment_url(h)
    if fu:
        lines.append(f"к месту: {fu}")
    return "\n".join(lines)


# ---------------------------------------------------------------- инструменты

@mcp.tool()
def search_highlights(
    query: str = "",
    tag: str = "",
    source: str = "",
    site: str = "",
    since: str = "",
    untagged: bool = False,
    limit: int = 25,
) -> str:
    """Найти сохранённые выдержки — из AI-чатов, статей, любых страниц.

    query    — слова для поиска по тексту выдержки и заметке (регистр не важен);
    tag      — тема без решётки, например «найм»;
    source   — часть названия страницы или чата;
    site     — домен, например «stratechery.com»;
    since    — дата YYYY-MM-DD, вернуть только свежее;
    untagged — только те, что сохранены без темы;
    limit    — сколько максимум вернуть.
    """
    _sync()
    items = _load_raw()

    if tag:
        t = tag.lstrip("#").lower()
        items = [h for h in items if t in _tags(h)]
    if untagged:
        items = [h for h in items if not _tags(h)]
    if source:
        s = source.lower()
        items = [h for h in items if s in (h.get("title") or "").lower()]
    if site:
        d = site.lower()
        items = [h for h in items
                 if d in (h.get("host") or "").lower() or d in (h.get("url") or "").lower()]
    if since:
        items = [h for h in items if (h.get("createdAt") or "") >= since]
    if query:
        words = [w for w in re.split(r"\s+", query.lower()) if w]

        def hit(h: dict[str, Any]) -> bool:
            blob = ((h.get("text") or "") + " " + (h.get("note") or "")).lower()
            return all(w in blob for w in words)

        items = [h for h in items if hit(h)]

    if not items:
        return ("Ничего не нашлось. Возможно, выдержки ещё не выгружены из браузера — "
                f"нажми «Выгрузить в библиотеку» в боковой панели. Смотрю в: {DEFAULT_PATH}")

    shown = items[: max(1, limit)]
    header = f"Найдено {len(items)}, показываю {len(shown)}:\n"
    return header + "\n\n".join(_fmt(h, i + 1) for i, h in enumerate(shown))


@mcp.tool()
def list_topics() -> str:
    """Показать темы и сколько выдержек в каждой."""
    _sync()
    items = _load_raw()
    counts: dict[str, int] = {}
    untagged = 0
    for h in items:
        tg = _tags(h)
        if not tg:
            untagged += 1
        for t in tg:
            counts[t] = counts.get(t, 0) + 1
    if not counts and not untagged:
        return "Выдержек пока нет."
    if not counts:
        return f"Тем пока нет, без темы: {untagged}. Тема заводится в браузере при выделении."
    rows = sorted(counts.items(), key=lambda kv: -kv[1])
    docs = _doc_topics()
    body = "\n".join(f"{n:>3}  #{t}" + ("   📄 живой документ" if t in docs else "") for t, n in rows)
    return body + f"\n\nБез темы: {untagged}" + (
        "\n📄 — по теме собирается .docx в папке «06 Документы» Google Drive." if docs else "")


@mcp.tool()
def list_sources() -> str:
    """Показать, откуда взяты выдержки: страницы, статьи, чаты."""
    _sync()
    items = _load_raw()
    if not items:
        return "Выдержек пока нет."
    counts: dict[str, int] = {}
    latest: dict[str, str] = {}
    hosts: dict[str, int] = {}
    for h in items:
        key = h.get("title") or h.get("conv") or "?"
        counts[key] = counts.get(key, 0) + 1
        latest[key] = max(latest.get(key, ""), h.get("createdAt") or "")
        host = h.get("host") or ""
        if host:
            hosts[host] = hosts.get(host, 0) + 1
    rows = sorted(counts.items(), key=lambda kv: latest[kv[0]], reverse=True)
    body = "\n".join(f"{n:>3}  {title}  (последняя {latest[title][:10]})" for title, n in rows[:40])
    if hosts:
        top = ", ".join(f"{h} — {n}" for h, n in sorted(hosts.items(), key=lambda kv: -kv[1])[:10])
        body += f"\n\nПо сайтам: {top}"
    return body


@mcp.tool()
def refresh_library() -> str:
    """Принудительно забрать свежие выгрузки из загрузок и пересобрать библиотеку
    в Google Drive: темы, источники, индекс, таблицу и дашборд."""
    r = _sync(force=True)
    if r is None:
        return ("Не смог пересобрать. Скорее всего Google Drive ещё не готов — "
                "проверь, что приложение запущено и папка «AI Highlights» видна в Finder.")
    parts = []
    if r["moved"]:
        parts.append(f"принято выгрузок: {r['moved']}")
    if r["rebuilt"]:
        parts.append(f"собрано {r['items']} выдержек, {r['topics']} тем, {r['sources']} источников")
        if r.get("untagged"):
            parts.append(f"без темы: {r['untagged']}")
        if not r["xlsx"]:
            parts.append("таблицу не собрал — нет openpyxl")
    elif r.get("skipped"):
        parts.append("ничего не изменилось с прошлого раза")
    else:
        parts.append("выдержек пока нет")
    return "; ".join(parts) + f"\nПапка: {r['root']}"


@mcp.tool()
def get_topic_map(topic: str = "", limit: int = 60) -> str:
    """Показать выдержки темы в том порядке, в котором они были отмечены —
    с датой, позицией в документе и заметками. Это готовая последовательность
    размышления, из неё удобно собирать конспект.

    topic — тема без решётки; пусто — все выдержки подряд.
    """
    _sync()
    items = _load_raw()
    if topic:
        t = topic.lstrip("#").lower()
        items = [h for h in items if t in _tags(h)]
    items = sorted(items, key=lambda h: h.get("createdAt") or "")
    total = len(items)
    if not items:
        return f"По теме «{topic}» выдержек нет."
    shown = items[-max(1, limit):]        # хвост: свежие важнее для конспекта

    head = f"Тема «{topic or 'все'}», всего {total}"
    if len(shown) < total:
        head += (f". Показываю последние {len(shown)} по времени — начало темы не показано, "
                 f"для полной картины позови ещё раз с limit={total}.")
    else:
        head += ", все в порядке отметки:"
    lines = [head, ""]
    items = shown
    prev = None
    for i, h in enumerate(items, 1):
        when = _local(h.get("createdAt") or "")
        try:
            cur = datetime.fromisoformat((h.get("createdAt") or "").replace("Z", "+00:00"))
            if prev and (cur - prev).total_seconds() > 30 * 60:
                lines.append(f"    — перерыв, новый заход {when} —")
            prev = cur
        except Exception:
            pass
        pos = h.get("pos")
        where = f", {int(pos * 100)}% документа" if isinstance(pos, (int, float)) else ""
        lines.append(f"[{i}] {when} · {h.get('title') or ''}{where}")
        lines.append("    " + (h.get("text") or "").strip().replace("\n", " ")[:400])
        if h.get("note"):
            lines.append(f"    заметка: {h['note']}")
        fu = fragment_url(h)
        if fu:
            lines.append(f"    к месту: {fu}")
    return "\n".join(lines)


@mcp.tool()
def stats() -> str:
    """Сводка: сколько всего выдержек, как распределены по темам, сайтам и времени."""
    _sync()
    items = _load_raw()
    if not items:
        return f"Пусто. Смотрю в: {DEFAULT_PATH}"

    by_tag: dict[str, int] = {}
    by_month: dict[str, int] = {}
    by_host: dict[str, int] = {}
    with_note = untagged = 0
    for h in items:
        tg = _tags(h)
        if not tg:
            untagged += 1
        for t in tg:
            by_tag[t] = by_tag.get(t, 0) + 1
        month = (h.get("createdAt") or "")[:7]
        by_month[month] = by_month.get(month, 0) + 1
        host = h.get("host") or ""
        if host:
            by_host[host] = by_host.get(host, 0) + 1
        if h.get("note"):
            with_note += 1

    parts = [
        f"Всего выдержек: {len(items)} (с заметками: {with_note}, без темы: {untagged})",
        "По темам: " + (", ".join(f"#{k} — {v}" for k, v in sorted(by_tag.items(), key=lambda kv: -kv[1])[:15]) or "тем нет"),
    ]
    if by_host:
        parts.append("По сайтам: " + ", ".join(f"{k} — {v}" for k, v in sorted(by_host.items(), key=lambda kv: -kv[1])[:10]))
    parts.append("По месяцам: " + ", ".join(f"{k} — {v}" for k, v in sorted(by_month.items(), reverse=True)[:12]))
    parts.append("Файлы-источники: " + (", ".join(str(f) for f in _files()[:6]) or "нет"))
    return "\n".join(parts)


@mcp.tool()
def build_digest(topic: str, limit: int = 40) -> str:
    """Собрать выдержки по теме в один markdown-блок, готовый к переработке
    в конспект, черновик или заметку.

    topic — тема или просто слова; limit — сколько взять максимум.
    """
    _sync()
    items = _load_raw()
    t = topic.lstrip("#").lower().strip()

    exact = [h for h in items if t in _tags(h)]
    if exact:
        picked = exact
    else:
        words = [w for w in re.split(r"\s+", t) if w]
        picked = [
            h for h in items
            if all(w in ((h.get("text") or "") + " " + (h.get("note") or "") + " " +
                         (h.get("title") or "")).lower() for w in words)
        ] if words else items

    total = len(picked)
    picked = picked[: max(1, limit)]
    if not picked:
        return f"По теме «{topic}» выдержек не нашёл."

    by_src: dict[str, list[dict[str, Any]]] = {}
    for h in picked:
        by_src.setdefault(h.get("title") or h.get("conv") or "?", []).append(h)

    tail = (f"взято {len(picked)} свежих из {total} — для полного набора limit={total}"
            if len(picked) < total else f"всего {total}")
    out = [f"# Выдержки по теме: {topic}",
           f"_собрано {datetime.now():%Y-%m-%d}, {tail}_", ""]
    for src, hs in by_src.items():
        out.append(f"## {src}")
        url = next((h.get("url") for h in hs if h.get("url")), "")
        if url:
            out.append(f"[{url}]({url})\n")
        for h in hs:
            out.append("> " + (h.get("text") or "").strip().replace("\n", "\n> "))
            if h.get("note"):
                out.append(f"\n**Заметка:** {h['note']}")
            tg = _tags(h)
            out.append(f"\n`{' '.join('#' + x for x in tg) if tg else NO_TAG}`\n")
        out.append("")
    return "\n".join(out)


if __name__ == "__main__":
    mcp.run()
