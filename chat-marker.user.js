// ==UserScript==
// @name         Chat Marker — маркер и заметки на любой странице
// @namespace    aziz.chatmarker
// @version      1.2.1
// @description  Выделяй текст маркером на любом сайте, вешай тему и стиль, ищи по всей базе, выгружай в библиотеку.
// @author       Aziz
// @homepageURL  https://github.com/abdurahhiimov/chat-marker
// @supportURL   https://github.com/abdurahhiimov/chat-marker/issues
// @updateURL    https://raw.githubusercontent.com/abdurahhiimov/chat-marker/main/chat-marker.user.js
// @downloadURL  https://raw.githubusercontent.com/abdurahhiimov/chat-marker/main/chat-marker.user.js
// @match        *://*/*
// @exclude      *://docs.google.com/*
// @exclude      *://mail.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM.setValue
// @grant        GM.getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Модель простая: есть теги, у каждого свой цвет. Выделяешь текст — выбираешь тег,
 * выделение красится в его цвет. Нет нужного тега — создаёшь на месте, за два клика.
 *
 * Хранилище: если менеджер даёт GM-хранилище (Tampermonkey даёт), база одна на все
 * сайты сразу. Без него пришлось бы держать отдельную базу на каждом домене —
 * скрипт про это честно предупредит в панели.
 */

(function () {
  'use strict';

  /* ================================================================== *
   * КОНСТАНТЫ
   * ================================================================== */

  const K = {
    db: 'chatmarker.db.v2',
    tags: 'chatmarker.tags.v2',
    settings: 'chatmarker.settings.v2',
    legacyDb: 'chatmarker.v1',
  };

  /* Жёлтый закреплён за «без темы» и в палитре тем не встречается —
     увидел жёлтое, значит это неразобранное. */
  const NO_TAG_COLOR = '#ffd54f';
  const PALETTE = [
    '#81c784', '#64b5f6', '#ef9a9a', '#ce93d8',
    '#4db6ac', '#f06292', '#ffb74d', '#a1887f',
    '#90a4ae', '#9fa8da',
  ];
  const CONTEXT_LEN = 40;
  const RESCAN_DEBOUNCE = 900;
  const DRAFT_COLOR = '#7aa2ff';

  const MARKER_SVG = "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor'"
    + " stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>"
    + "<path d='M15 4.5l4.5 4.5-8 8H7v-4.5z'/><path d='M4 20.5h7'/></svg>";

  const DOC_SVG = "<svg viewBox='0 0 24 24' width='13' height='13' fill='none' stroke='currentColor'"
    + " stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>"
    + "<path d='M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z'/>"
    + "<path d='M13 3v6h6M9 13h6M9 17h4'/></svg>";

  const TRASH_SVG = "<svg viewBox='0 0 24 24' width='13' height='13' fill='none' stroke='currentColor'"
    + " stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>"
    + "<path d='M4 7h16M10 11v6M14 11v6'/>"
    + "<path d='M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2'/></svg>";

  const ERASER_SVG = "<svg viewBox='0 0 24 24' width='13' height='13' fill='none' stroke='currentColor'"
    + " stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>"
    + "<path d='M8.5 20.5H20'/><path d='M13 5.5l6 6-7.5 7.5H7L3.5 15.5z'/></svg>";

  /* Цветовое колесо: восемь секторов и светлая сердцевина. Понятнее,
     чем безымянный кружок, и сразу читается как «выбрать цвет». */
  const WHEEL_SVG = (() => {
    const cols = ['#ef5350','#ffa726','#ffd54f','#81c784','#4db6ac','#64b5f6','#7e57c2','#ec407a'];
    const r = 9, cx = 12, cy = 12;
    const seg = cols.map((c, i) => {
      const a0 = (i / 8) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / 8) * 2 * Math.PI - Math.PI / 2;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      return `<path d='M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z' fill='${c}'/>`;
    }).join('');
    return `<svg viewBox='0 0 24 24' width='17' height='17'>${seg}<circle cx='12' cy='12' r='3.6' fill='#f5efe6'/></svg>`;
  })();

  /* Стили выделения. Курсив и настоящий жирный на странице невозможны:
   * ::highlight() умеет только цвет, заливку, подчёркивание, тень и обводку.
   * Поэтому «жирный» подделываем тенью, а курсив живёт только в библиотеке. */
  /* Цвет — это всегда заливка. Жирный, подчёркивание и зачёркивание —
     независимые переключатели поверх неё, как в любом текстовом редакторе.
     Сами они цвета не несут: подчёркивание и зачёркивание рисуются цветом
     текста самой страницы, жирный просто утолщает шрифт. */
  const FORMATS = [
    { id: 'b', label: 'Жирный',       html: "<b style='font-weight:800'>B</b>" },
    { id: 'u', label: 'Подчёркнутый', html: "<u>U</u>" },
    { id: 's', label: 'Зачёркнутый',  html: "<s>S</s>" },
  ];

  /* Быстрые темы, которые предлагаются всегда, даже на пустой базе. */
  /* ================================================================== *
   * ХРАНИЛИЩЕ
   * ================================================================== */

  const GM_SYNC = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';
  const GM_ASYNC = !GM_SYNC && typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function';
  const SHARED = GM_SYNC || GM_ASYNC;   // одна база на все сайты или по базе на домен

  const store = {
    read(key, fallback) {
      try {
        let raw = null;
        if (GM_SYNC) raw = GM_getValue(key, null);
        if (raw == null) raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        console.warn('[ChatMarker] чтение хранилища:', e);
        return fallback;
      }
    },
    write(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (GM_SYNC) GM_setValue(key, raw);
        else if (GM_ASYNC) Promise.resolve(GM.setValue(key, raw)).catch(() => {});
      } catch { /* зеркало не критично */ }
      try { localStorage.setItem(key, raw); } catch { /* переполнение — переживём */ }
    },
    async pullAsync(key) {
      if (!GM_ASYNC || typeof GM.getValue !== 'function') return null;
      try {
        const raw = await GM.getValue(key, null);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
  };

  let DB = store.read(K.db, null);
  let TAGS = store.read(K.tags, null);
  let SET = Object.assign(
    { panelOpen: false, showFab: true, lastTag: null, lastExportCount: 0, limit: 10000 },
    store.read(K.settings, {})
  );

  /* ---------------- кольцевой буфер ------------------------------------
   * Браузер — рабочий буфер, а не архив. Когда выдержек становится больше
   * лимита, самые старые вытесняются — но ТОЛЬКО те, что уже уехали
   * в библиотеку. Невыгруженное не трогаем никогда, даже сверх лимита.
   */
  function prune() {
    const limit = Math.max(100, SET.limit || 10000);
    if (DB.highlights.length <= limit) return 0;

    // старые сверху: сортируем по дате и выбрасываем выгруженные
    const order = DB.highlights
      .map((h, i) => ({ i, at: h.createdAt || '', exp: !!h.exp }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const drop = new Set();
    let need = DB.highlights.length - limit;
    for (const o of order) {
      if (need <= 0) break;
      if (!o.exp) continue;           // не выгружено — не трогаем
      drop.add(o.i); need--;
    }
    if (!drop.size) return 0;

    DB.highlights = DB.highlights.filter((_, i) => !drop.has(i));
    return drop.size;
  }

  const saveDB = () => store.write(K.db, DB);
  const saveTags = () => store.write(K.tags, TAGS);
  const saveSet = () => store.write(K.settings, SET);

  /* ---------------- перенос старой базы (цвета-смыслы -> теги) -------- */

  const LEGACY_TAGS = {
    yellow: { name: 'формулировка', color: '#ffd54f' },
    green:  { name: 'идея',         color: '#81c784' },
    blue:   { name: 'факт',         color: '#64b5f6' },
    red:    { name: 'спорно',       color: '#ef9a9a' },
  };

  /** Старые записи: взаимоисключающий style и флаг quote → набор форматов. */
  function upgradeFormats() {
    let touched = 0;
    for (const h of DB.highlights) {
      if (Array.isArray(h.fmt)) continue;
      const f = [];
      if (h.style === 'bold') f.push('b');
      if (h.style === 'under') f.push('u');
      if (h.style === 'strike') f.push('s');
      h.fmt = f;
      delete h.style; delete h.quote;
      if (!h.color || h.color === '#b0b3ba') h.color = h.tag ? h.color : NO_TAG_COLOR;
      touched++;
    }
    if (touched) saveDB();
    return touched;
  }

  function migrate() {
    if (DB && TAGS) return false;
    DB = DB || { highlights: [] };
    TAGS = TAGS || { list: [] };

    const old = store.read(K.legacyDb, null);
    if (!old || !Array.isArray(old.highlights) || !old.highlights.length) return false;

    for (const h of old.highlights) {
      // если в заметке был хештег — он и становится тегом, иначе берём смысл цвета
      const fromNote = (String(h.note || '').match(/#([^\W\d_][\w-]{1,39})/u) || [])[1];
      const legacy = LEGACY_TAGS[h.color] || LEGACY_TAGS.yellow;
      const name = (fromNote || legacy.name).toLowerCase();
      const tag = ensureTag(name, legacy.color);
      DB.highlights.push({
        id: h.id,
        conv: h.conv,
        url: h.url,
        title: h.title,
        tag: tag.name,
        color: tag.color,
        note: h.note || '',
        anchor: h.anchor,
        text: h.text,
        createdAt: h.createdAt,
      });
    }
    saveDB(); saveTags();
    console.log('[ChatMarker] перенесено из старой базы:', DB.highlights.length);
    return true;
  }

  /* ================================================================== *
   * ТЕГИ
   * ================================================================== */

  function tagByName(name) {
    const n = String(name || '').toLowerCase();
    return TAGS.list.find(t => t.name === n) || null;
  }

  function nextColor() {
    const used = new Set(TAGS.list.map(t => t.color));
    return PALETTE.find(c => !used.has(c)) || PALETTE[TAGS.list.length % PALETTE.length];
  }

  function ensureTag(name, color) {
    const n = String(name || '').trim().toLowerCase().replace(/^#/, '');
    if (!n) return null;
    let t = tagByName(n);
    if (!t) {
      t = { name: n, color: color || nextColor(), createdAt: new Date().toISOString(), usedAt: 0 };
      TAGS.list.push(t);
      if (TAGS.deleted) delete TAGS.deleted[n];
      saveTags();
    } else if (color && t.color !== color) {
      t.color = color;
      saveTags();
    }
    return t;
  }

  /** «Вести документ по теме» — флаг живёт на самой теме и уезжает в выгрузке,
      сборщик библиотеки по нему делает .docx в папке «06 Документы». */
  function toggleTagDoc(name) {
    const t = tagByName(name);
    if (!t) return false;
    t.doc = !t.doc;
    saveTags();
    return !!t.doc;
  }

  /** Удаление темы. Выдержки либо остаются без темы, либо уходят вместе с ней —
      решаем в момент удаления, кнопка одна. */
  /* Надгробия. Выгрузка — полный дамп браузера, и по ней не отличить
     «пользователь удалил» от «вытеснено буфером». Поэтому удаления помним
     отдельно: библиотека по этому списку удаляет у себя, а вытесненное — нет. */
  const TOMB_KEEP = 2000;

  function bury(id) {
    DB.deleted = DB.deleted || {};
    DB.deleted[id] = Date.now();
    const keys = Object.keys(DB.deleted);
    if (keys.length > TOMB_KEEP) {
      keys.sort((a, b) => DB.deleted[a] - DB.deleted[b]);
      for (const k of keys.slice(0, keys.length - TOMB_KEEP)) delete DB.deleted[k];
    }
  }

  function buryTag(name) {
    TAGS.deleted = TAGS.deleted || {};
    TAGS.deleted[String(name || '').toLowerCase()] = Date.now();
  }

  function removeTag(name, withItems) {
    const n = String(name || '').toLowerCase();
    TAGS.list = TAGS.list.filter(t => t.name !== n);
    buryTag(n);
    saveTags();

    if (withItems) {
      for (const h of DB.highlights) if ((h.tag || '').toLowerCase() === n) bury(h.id);
      DB.highlights = DB.highlights.filter(h => (h.tag || '').toLowerCase() !== n);
    } else {
      for (const h of DB.highlights) {
        if ((h.tag || '').toLowerCase() !== n) continue;
        h.tag = null;
        h.slug = null;
        h.color = NO_TAG_COLOR;
      }
    }
    saveDB();

    panel.pinned.delete(n);
    if (panel.current === n) panel.current = null;
    if (SET.lastTag === n) { SET.lastTag = null; saveSet(); }
    ensureColorStyles();
    repaint();
  }

  function touchTag(name) {
    const t = tagByName(name);
    if (t) { t.usedAt = Date.now(); saveTags(); }
    SET.lastTag = name || null;
    saveSet();
  }

  /** Теги по свежести использования — то, что чаще всего под рукой. */
  function recentTags() {
    return TAGS.list.slice().sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  }

  function tagCounts() {
    const c = new Map();
    for (const h of DB.highlights) if (h.tag) c.set(h.tag, (c.get(h.tag) || 0) + 1);
    return c;
  }

  /* ================================================================== *
   * УТИЛИТЫ
   * ================================================================== */

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmtDate = iso => {
    try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return iso; }
  };

  const pageKey = () => location.hostname + '::' + location.pathname;

  /* Данные из хранилища и импорта — недоверенные: то, что уходит в атрибуты
     и в <style>, пропускаем через фильтр, а не через веру в лучшее. */
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const safeColor = c => (typeof c === 'string' && HEX_RE.test(c)) ? c : NO_TAG_COLOR;

  /* Ссылка на точное место в источнике — штатные текстовые фрагменты браузера.
   * Формат: страница#:~:text=перед-,точный кусок,-после
   * Браузер сам прокрутит к месту и подсветит его. У нас все три части
   * уже лежат в якоре, так что это чистая перепаковка данных. */
  const SPA_HOSTS = /(^|\.)(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|aistudio\.google\.com)$/i;

  function fragmentUrl(h) {
    const base = (h.url || '').split('#')[0];
    if (!base || !h.anchor) return '';
    try {
      const u = new URL(base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';   // javascript: и прочее
      // в чатах контент подгружается после перехода — фрагмент не сработает
      if (SPA_HOSTS.test(u.hostname)) return base;
    } catch { return ''; }

    const enc = t => encodeURIComponent(String(t)).replace(/-/g, '%2D');
    const ex = String(h.anchor.exact || '').replace(/\s+/g, ' ').trim();
    if (!ex) return base;

    /* Контекст (префикс и суффикс) сюда сознательно не идёт.
       Наш индекс склеивает соседние блоки без пробела, поэтому суффикс
       часто выглядит как «.Следующий абзац» — в реальном тексте страницы
       такого нет, и браузер не находит место. Начала и конца куска хватает:
       он должен целиком лежать в пределах блока, а сам диапазон блоки
       пересекать может. */
    let dir;
    if (ex.length > 70) {
      const head = ex.slice(0, 40).replace(/\s\S*$/, '');
      const tail = ex.slice(-40).replace(/^\S*\s/, '');
      dir = enc(head) + ',' + enc(tail);
    } else {
      dir = enc(ex);
    }
    return base + '#:~:text=' + dir;
  }

  function pageTitle() {
    const t = (document.title || '').trim();
    return t || location.hostname + location.pathname;
  }

  /* ================================================================== *
   * ИНДЕКС ТЕКСТА СТРАНИЦЫ
   * Весь видимый текст в одну строку + карта символ → текстовый узел.
   * Никаких селекторов конкретного сайта, поэтому работает где угодно.
   * ================================================================== */

  let textIndex = null;

  function buildTextIndex() {
    const root = document.body;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('#cm-root, script, style, noscript, textarea, svg')) return NodeFilter.FILTER_REJECT;
        if (p.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let buf = '', n;
    while ((n = walker.nextNode())) {
      const start = buf.length;
      buf += n.nodeValue;
      nodes.push({ node: n, start, end: buf.length });
    }
    textIndex = { text: buf, nodes };
    return textIndex;
  }

  function locateChar(idx) {
    if (!textIndex) return null;
    const { nodes } = textIndex;
    let lo = 0, hi = nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, e = nodes[mid];
      if (idx < e.start) hi = mid - 1;
      else if (idx >= e.end) lo = mid + 1;
      else return { node: e.node, offset: idx - e.start };
    }
    return null;
  }

  function rangeFromChars(start, end) {
    const a = locateChar(start), b = locateChar(end - 1);
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset + 1);
      return r;
    } catch { return null; }
  }

  function charOffsetOfPoint(node, offset) {
    if (!textIndex) return -1;
    const e = textIndex.nodes.find(x => x.node === node);
    return e ? e.start + offset : -1;
  }

  /* ---------------- якорь: текст + контекст (W3C text-quote) ---------- */

  function makeAnchor(range) {
    if (!textIndex) buildTextIndex();
    const s = charOffsetOfPoint(range.startContainer, range.startOffset);
    const e = charOffsetOfPoint(range.endContainer, range.endOffset);
    if (s < 0 || e < 0 || e <= s) return null;
    const T = textIndex.text;
    return {
      exact: T.slice(s, e),
      prefix: T.slice(Math.max(0, s - CONTEXT_LEN), s),
      suffix: T.slice(e, Math.min(T.length, e + CONTEXT_LEN)),
    };
  }

  const cpl = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const csl = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[a.length-1-i] === b[b.length-1-i]) i++; return i; };

  function resolveAnchor(anchor) {
    if (!textIndex) buildTextIndex();
    const T = textIndex.text, needle = anchor && anchor.exact;
    if (!needle) return null;
    const hits = [];
    let i = T.indexOf(needle);
    while (i !== -1 && hits.length < 200) { hits.push(i); i = T.indexOf(needle, i + 1); }
    if (!hits.length) return null;
    if (hits.length === 1) return { start: hits[0], end: hits[0] + needle.length };
    let best = hits[0], bestScore = -1;
    for (const h of hits) {
      const pre = T.slice(Math.max(0, h - CONTEXT_LEN), h);
      const suf = T.slice(h + needle.length, h + needle.length + CONTEXT_LEN);
      const score = csl(pre, anchor.prefix || '') + cpl(suf, anchor.suffix || '');
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return { start: best, end: best + needle.length };
  }

  /* ================================================================== *
   * ОТРИСОВКА  (CSS Custom Highlight API — DOM не трогаем вообще)
   * ================================================================== */

  const HAS_API = typeof CSS !== 'undefined' && CSS.highlights;
  let painted = [];              // [{id, range, start, end}]
  let paintedNames = new Set();  // какие регистры сейчас заняты
  const styleEl = document.createElement('style');

  const colorKey = hex => 'cm' + String(hex).replace(/[^0-9a-f]/gi, '').toLowerCase();

  /** Правило ::highlight() для цвета и набора форматов.
   *  fmt — строка из букв b, u, s в этом порядке. */
  function styleRule(hex, fmt) {
    const out = [`background-color: ${hex}80;`];
    if (fmt.includes('b')) out.push('text-shadow: 0 0 .45px currentColor, 0 0 .45px currentColor;');
    const lines = [];
    if (fmt.includes('u')) lines.push('underline');
    if (fmt.includes('s')) lines.push('line-through');
    if (lines.length) {
      out.push(`text-decoration-line: ${lines.join(' ')};`);
      out.push('text-decoration-color: currentColor;');
      out.push('text-decoration-thickness: 2px;');
      out.push('text-underline-offset: 3px;');
    }
    return out.join(' ');
  }

  const FMT_COMBOS = ['', 'b', 'u', 's', 'bu', 'bs', 'us', 'bus'];

  /** Набор форматов выдержки в виде строки-ключа. */
  function fmtKey(h) {
    const f = (h && h.fmt) || [];
    return ['b', 'u', 's'].filter(x => f.includes(x)).join('');
  }

  let styleSig = null;

  function ensureColorStyles() {
    const colors = new Set([NO_TAG_COLOR, DRAFT_COLOR,
                            ...TAGS.list.map(t => safeColor(t.color)),
                            ...PALETTE,
                            ...DB.highlights.map(h => safeColor(h.color))]);
    // Перегенерация <style> заставляет браузер пересчитать стили всей страницы.
    // На длинной переписке это и есть те самые залипания, поэтому делаем это
    // только когда набор цветов действительно изменился.
    const sig = [...colors].sort().join(',');
    if (sig === styleSig) return;
    styleSig = sig;
    let css = BASE_CSS;
    for (const hex of colors) {
      const k = colorKey(hex);
      for (const f of FMT_COMBOS) {
        const n = f || 'x';
        css += `\n::highlight(${k}${n}) { ${styleRule(hex, f)} }`;
        // отдельный набор для живого превью — настоящие выделения не затрагиваем
        css += `\n::highlight(p${k}${n}) { ${styleRule(hex, f)} }`;
      }
    }
    css += `\n::highlight(cm-draft) { background-color: ${DRAFT_COLOR}66; text-decoration: underline solid ${DRAFT_COLOR}; text-underline-offset: 3px; }`;
    css += `\n::highlight(cm-active) { background-color: #fff; color: #000; }`;
    styleEl.textContent = css;
  }

  const orphans = new Set();   // не нашлись на этой странице — рантайм, не данные

  function repaint() {
    if (!HAS_API) return;
    const key = pageKey();
    const mine = DB.highlights.filter(h => h.conv === key);
    painted = [];
    orphans.clear();

    for (const name of paintedNames) CSS.highlights.delete(name);
    paintedNames = new Set();
    if (!mine.length) return;

    buildTextIndex();
    const buckets = new Map();
    for (const h of mine) {
      const pos = resolveAnchor(h.anchor);
      if (!pos) { orphans.add(h.id); continue; }
      const range = rangeFromChars(pos.start, pos.end);
      if (!range) { orphans.add(h.id); continue; }
      painted.push({ id: h.id, range, start: pos.start, end: pos.end });
      const name = colorKey(h.color || NO_TAG_COLOR) + (fmtKey(h) || 'x');
      if (!buckets.has(name)) buckets.set(name, []);
      buckets.get(name).push(range);
    }
    for (const [name, ranges] of buckets) {
      CSS.highlights.set(name, new Highlight(...ranges));
      paintedNames.add(name);
    }
  }

  let lastRepaint = 0;
  let repaintQueued = null;
  let repaintWhenVisible = false;   // вкладка спрятана — перерисуем на возврате

  const runRepaint = () => {
    const go = () => {
      lastRepaint = Date.now();
      repaint();
      renderPanel();
    };
    if (document.hidden) { repaintWhenVisible = true; return; }
    const wait = 1500 - (Date.now() - lastRepaint);
    if (wait > 0) {                       // отбросить нельзя: мутации уже были,
      if (repaintQueued) return;          // выделения могут стоять по старым местам
      repaintQueued = setTimeout(() => { repaintQueued = null; runRepaint(); }, wait + 50);
      return;
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1200 });
    else go();
  };
  const repaintSoon = debounce(runRepaint, RESCAN_DEBOUNCE);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && repaintWhenVisible) { repaintWhenVisible = false; runRepaint(); }
  });

  /* ================================================================== *
   * СТИЛИ
   * ================================================================== */

  const BASE_CSS = `
    #cm-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
               font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
               color: #e8e8ec; }
    #cm-root * { box-sizing: border-box; }
    #cm-root button, #cm-root input, #cm-root textarea { font: inherit; }
    #cm-root button { cursor: pointer; }
    #cm-root [hidden] { display: none !important; }

    /* Матовое стекло: полупрозрачный фон с размытием, крупные скругления,
       тонкая светлая кромка. Одна база для всплывашки, карточки и панели. */
    /* Жидкое стекло: сильное размытие, лёгкая осветляющая плёнка,
       яркий блик по верхней кромке и мягкая тень под стеклом. */
    .cm-pop, .cm-panel, .cm-card {
      background:
        linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.04) 45%, rgba(255,255,255,.015)),
        rgba(18, 19, 24, .38);
      -webkit-backdrop-filter: blur(30px) saturate(165%);
      backdrop-filter: blur(30px) saturate(165%);
      border: 1px solid rgba(255,255,255,.16);
      box-shadow:
        0 24px 60px rgba(0,0,0,.42),
        0 2px 10px rgba(0,0,0,.22),
        inset 0 1px 0 rgba(255,255,255,.34),
        inset 0 -1px 0 rgba(255,255,255,.07);
    }
    .cm-pop { position: absolute; pointer-events: auto; border-radius: 22px; padding: 11px; min-width: 320px; }

    /* Всплывашка живёт поверх текста доли секунды — ей прозрачность к лицу.
       Панель и карточка заметки — рабочие поверхности: на белой странице сквозь
       них ничего просвечивать не должно, иначе текст не прочитать. */
    .cm-panel, .cm-card {
      background:
        linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.028) 45%, rgba(255,255,255,.012)),
        rgba(13, 14, 18, .95);
      -webkit-backdrop-filter: blur(34px) saturate(150%);
      backdrop-filter: blur(34px) saturate(150%);
    }

    .cm-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; max-width: 470px; }
    .cm-chip { display: inline-flex; align-items: center; gap: 7px; height: 31px; padding: 0 13px;
               border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
               background: linear-gradient(180deg, rgba(255,255,255,.13), rgba(255,255,255,.05));
               color: #f0f0f4; font-size: 13px; transition: background .14s, transform .12s;
               box-shadow: inset 0 1px 0 rgba(255,255,255,.18); }
    .cm-chip:hover { background: linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,.1)); }
    .cm-chip:active { transform: scale(.97); }
    .cm-chip .dot { width: 9px; height: 9px; border-radius: 50%; flex: none;
                    box-shadow: 0 0 0 3px rgba(255,255,255,.07); }
    .cm-chip.ghost { color: #a9abb3; }
    .cm-chip.danger { color: #ff9c9c; }
    .cm-chip.wide { padding: 0 15px; }
    .cm-chip.go { background: rgba(90,124,255,.9); color: #fff; border-color: transparent; }
    .cm-chip.go:hover { background: rgba(104,138,255,1); }

    .cm-new { display: flex; flex-direction: column; gap: 8px; padding: 3px; }
    .cm-row1 { display: flex; gap: 7px; align-items: center; }
    .cm-new input[type=text] { flex: 1; min-width: 215px; height: 32px; padding: 0 12px;
                               border-radius: 10px; border: 1px solid rgba(255,255,255,.1);
                               background: rgba(0,0,0,.28); color: #ecedf1; outline: none; }
    .cm-new input[type=text]:focus { border-color: rgba(120,150,255,.65);
                                     box-shadow: 0 0 0 3px rgba(90,124,255,.18); }

    .cm-hint { display: flex; gap: 7px; align-items: center; font-size: 11.5px; color: #91939b;
               padding: 0 3px; }
    .cm-hint code { background: rgba(0,0,0,.3); border-radius: 6px; padding: 2px 7px; color: #a8bcff; }
    .cm-hint button { background: none; border: 0; color: #8b8d95; font-size: 11.5px; padding: 0; }
    .cm-hint button:hover { color: #fff; }

    .cm-pal { display: flex; gap: 6px; padding: 8px 2px 2px; flex-wrap: wrap; max-width: 420px; }
    .cm-pal i { width: 22px; height: 22px; border-radius: 7px; cursor: pointer; display: block;
                border: 2px solid transparent; transition: transform .12s; }
    .cm-pal i:hover { transform: scale(1.12); }
    .cm-pal i.on { border-color: #fff; }


    .cm-styles { display: flex; gap: 6px; margin-top: 9px; padding-top: 9px;
                 border-top: 1px solid rgba(255,255,255,.09); align-items: center;
                 justify-content: flex-start; }
    .cm-st { width: 32px; height: 30px; border-radius: 11px; border: 1px solid rgba(255,255,255,.13);
             background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,.04));
             color: #dcdde2; font-size: 13px; line-height: 1;
             display: inline-flex; align-items: center; justify-content: center;
             box-shadow: inset 0 1px 0 rgba(255,255,255,.16); }
    .cm-swatch span { width: 17px; height: 17px; border-radius: 6px; display: block;
                      box-shadow: 0 0 0 1px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.4); }
    .cm-del { width: auto; padding: 0 11px; gap: 6px; color: #ff6b6b;
              border-color: rgba(255,90,90,.34); font-size: 12px; font-weight: 600;
              background: linear-gradient(180deg, rgba(255,90,90,.2), rgba(255,90,90,.07));
              margin-left: auto; }
    .cm-del:hover { background: linear-gradient(180deg, rgba(255,90,90,.34), rgba(255,90,90,.14));
                    color: #fff; }
    /* «Выделить» — отдельная широкая жёлтая кнопка на всю ширину окна */
    .cm-chip.mark { display: flex; width: 100%; height: 38px; justify-content: center; gap: 9px;
                    font-size: 13.5px; font-weight: 600; color: #2a2205; border-radius: 13px;
                    border-color: rgba(255,255,255,.28); letter-spacing: .01em;
                    background: linear-gradient(180deg, rgba(255,225,120,.96), rgba(250,200,60,.86));
                    box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 4px 14px rgba(240,190,40,.22); }
    .cm-chip.mark:hover { background: linear-gradient(180deg, rgba(255,232,145,1), rgba(252,210,80,.95)); }
    .cm-chip.mark svg { opacity: .75; }
    .cm-chips.row2 { margin-top: 7px; }
    .cm-chips.row2 .dots { margin-left: auto; }
    .cm-chip.dots { font-size: 17px; line-height: 1; padding: 0 13px; letter-spacing: 1px; }

    .cm-all { display: flex; flex-direction: column; gap: 8px; padding: 3px; }
    .cm-all input[type=text] { flex: 1; min-width: 230px; height: 32px; padding: 0 12px;
                               border-radius: 10px; border: 1px solid rgba(255,255,255,.12);
                               background: rgba(0,0,0,.3); color: #ecedf1; outline: none; }
    .cm-rows { max-height: 232px; overflow-y: auto; display: flex; flex-direction: column;
               gap: 2px; padding: 3px; border-radius: 13px; background: rgba(0,0,0,.22);
               border: 1px solid rgba(255,255,255,.07); scrollbar-width: thin; }
    .cm-rows::-webkit-scrollbar { width: 8px; }
    .cm-rows::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 8px; }
    .cm-row { display: flex; align-items: center; gap: 10px; width: 100%; height: 34px;
              padding: 0 11px; border: 0; border-radius: 9px; background: none; color: #e9e9ee;
              font-size: 13px; text-align: left; }
    .cm-row:hover { background: rgba(255,255,255,.11); }
    .cm-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cm-row .ct { color: #8e9099; font-size: 11.5px; }
    .cm-empty { color: #9a9ca4; font-size: 12px; padding: 14px 6px; text-align: center; }
    .cm-st.on { background: rgba(90,124,255,.85); color: #fff; border-color: transparent; }
    .cm-st:hover { color: #fff; background: rgba(255,255,255,.13); }
    .cm-st.on:hover { background: rgba(104,138,255,1); }
    .cm-sep { width: 1px; height: 18px; background: rgba(255,255,255,.1); margin: 0 3px; }

    .cm-card { width: 390px; max-width: 92vw; border-radius: 22px; }
    .cm-card .quote { background: rgba(0,0,0,.26); border-radius: 11px; padding: 10px 12px;
                      max-height: 150px; overflow: auto; white-space: pre-wrap; margin-bottom: 10px;
                      font-size: 12.5px; }
    .cm-card textarea { width: 100%; min-height: 66px; resize: vertical; padding: 9px 11px;
                        border-radius: 10px; border: 1px solid rgba(255,255,255,.1);
                        background: rgba(0,0,0,.28); color: #ecedf1; outline: none; }
    .cm-card .row { display: flex; gap: 7px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
    .cm-card .row .grow { flex: 1; }

    .cm-fab { position: absolute; right: 14px; bottom: 88px; pointer-events: auto;
              width: 38px; height: 38px; border-radius: 50%;
              border: 1px solid rgba(255,255,255,.18);
              background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.05)), rgba(22,23,28,.5);
              -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
              color: #d8d9de; font-size: 14px; opacity: .4;
              transition: opacity .15s, transform .15s; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
    .cm-fab:active { transform: scale(.94); }
    .cm-fab:hover { opacity: 1; }
    .cm-fab.has { opacity: .9; }
    .cm-fab b { position: absolute; top: -6px; right: -6px; min-width: 17px; height: 17px;
                border-radius: 9px; background: #5b8cff; color: #fff; font-size: 10px;
                line-height: 17px; padding: 0 4px; font-weight: 700; }

    .cm-panel { position: absolute; top: 12px; right: 12px; bottom: 12px; width: 400px;
                max-width: calc(100vw - 24px); pointer-events: auto; border-radius: 26px;
                display: flex; flex-direction: column; overflow: hidden; }
    .cm-panel header { padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); display: flex;
                       align-items: center; gap: 8px; }
    .cm-panel header h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .cm-x { background: none; border: none; color: #92949c; font-size: 17px; padding: 0 4px; }
    .cm-tools { padding: 11px 16px; border-bottom: 1px solid rgba(255,255,255,.08); display: flex;
                flex-direction: column; gap: 8px; }
    .cm-tools input[type=text] { width: 100%; height: 34px; padding: 0 12px; border-radius: 11px;
                                 border: 1px solid rgba(255,255,255,.1); background: rgba(0,0,0,.26);
                                 color: #e8e8ec; outline: none; }
    .cm-filters { display: flex; gap: 5px; flex-wrap: wrap; }
    .cm-f { border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.05); color: #c8c9cf;
            border-radius: 999px; padding: 4px 11px; font-size: 11.5px; display: inline-flex;
            align-items: center; gap: 6px; }
    .cm-f.on { background: rgba(255,255,255,.16); color: #fff; border-color: rgba(255,255,255,.2); }
    .cm-f .dot { width: 8px; height: 8px; border-radius: 50%; }

    .cm-box { width: 15px; height: 15px; border-radius: 5px; border: 1.5px solid rgba(255,255,255,.3);
              display: inline-flex; align-items: center; justify-content: center; font-size: 10px;
              color: transparent; margin-left: 2px; }
    .cm-box.pin { background: #5a7cff; border-color: #5a7cff; color: #fff; }
    .cm-panel .cm-rows { max-height: 200px; overflow-y: auto; display: flex; flex-direction: column;
                         gap: 2px; margin-top: 8px; padding: 3px; border-radius: 12px;
                         background: rgba(0,0,0,.24); border: 1px solid rgba(255,255,255,.07); }
    .cm-panel .cm-row { display: flex; align-items: center; gap: 9px; width: 100%; height: 32px;
                        padding: 0 10px; border: 0; border-radius: 8px; background: none;
                        color: #e9e9ee; font-size: 12.5px; text-align: left; }
    .cm-panel .cm-row:hover { background: rgba(255,255,255,.1); }
    .cm-panel .cm-row { cursor: pointer; }
    .cm-panel .cm-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cm-panel .cm-row .ct { color: #8b8d96; font-size: 11px; }
    .cm-panel .cm-row .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .cm-doc { width: 24px; height: 22px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12);
              background: rgba(255,255,255,.05); color: #8b8d96; display: inline-flex;
              align-items: center; justify-content: center; flex: none; }
    .cm-doc:hover { background: rgba(255,255,255,.12); color: #dcdde3; }
    .cm-doc.on { background: rgba(90,124,255,.9); border-color: transparent; color: #fff; }
    .cm-f .docmark { color: #9fb2ff; display: inline-flex; }
    .cm-hint { color: #8b8d96; font-size: 11px; margin: 6px 4px 0; display: flex;
               align-items: center; gap: 6px; }
    .cm-trash { width: 24px; height: 22px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12);
                background: rgba(255,255,255,.05); color: #9a9ca4; display: inline-flex;
                align-items: center; justify-content: center; flex: none; }
    .cm-trash:hover { background: rgba(255,86,86,.2); border-color: rgba(255,86,86,.45); color: #ff8a8a; }
    .cm-panel .cm-row.kill { background: rgba(255,86,86,.13); cursor: default; gap: 6px; padding: 0 6px 0 10px; }
    .cm-panel .cm-row.kill .nm { font-size: 12px; color: #ffc9c9; flex: 1 1 auto; min-width: 30px; }
    .cm-mini { height: 22px; padding: 0 9px; border-radius: 7px; font-size: 11.5px; flex: none;
               border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.08); color: #e9e9ee; }
    .cm-mini:hover { background: rgba(255,255,255,.16); }
    .cm-mini.danger { border-color: rgba(255,86,86,.45); background: rgba(255,86,86,.22); color: #ffd3d3; }
    .cm-mini.danger:hover { background: rgba(255,86,86,.34); }
    .cm-mini.ghost { background: none; color: #9a9ca4; border-color: transparent; padding: 0 6px; }
    .cm-list { flex: 1; overflow: auto; padding: 8px 10px 24px; }
    .cm-group { font-size: 11px; color: #7c7e86; margin: 13px 4px 6px; text-transform: uppercase;
                letter-spacing: .04em; }
    .cm-item { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.07);
               border-left: 3px solid #555; border-radius: 13px; padding: 10px 12px; margin-bottom: 8px; }
    .cm-item.orphan { opacity: .5; }
    .cm-item .q { white-space: pre-wrap; word-break: break-word; max-height: 5.8em; overflow: hidden;
                  font-size: 12.5px; }
    .cm-item .n { margin-top: 6px; font-size: 12px; color: #ffd8a4; white-space: pre-wrap; }
    .cm-item .m { margin-top: 7px; display: flex; gap: 9px; align-items: center; font-size: 11px;
                  color: #7c7e86; flex-wrap: wrap; }
    .cm-item .m button, .cm-item .m a { background: none; border: none; color: #8c8e96; padding: 0;
                                        text-decoration: none; }
    .cm-item .m button:hover, .cm-item .m a:hover { color: #fff; text-decoration: underline; }

    .cm-actions { padding: 11px 16px; border-top: 1px solid rgba(255,255,255,.08); display: flex;
                  gap: 6px; flex-wrap: wrap; }
    .cm-actions button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.09);
                         color: #dbdce1; border-radius: 10px; padding: 7px 11px; font-size: 12px; }
    .cm-actions button:hover { background: rgba(255,255,255,.14); color: #fff; }
    .cm-actions button.primary { background: rgba(90,124,255,.9); border-color: transparent; color: #fff; }

    .cm-note-line { padding: 0 14px 10px; font-size: 11px; color: #b08a3c; }
    .cm-note-line.as-btn { background: none; border: 0; text-align: left; cursor: pointer;
                           text-decoration: underline dotted; text-underline-offset: 3px; }
    .cm-note-line.as-btn:hover { color: #ffd28a; }
    .cm-toast { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
                background: rgba(28,29,34,.82); -webkit-backdrop-filter: blur(20px);
                backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,.12);
                padding: 9px 17px; border-radius: 999px; pointer-events: none;
                box-shadow: 0 10px 30px rgba(0,0,0,.4); }
  `;

  /* ================================================================== *
   * КАРКАС UI
   * ================================================================== */

  const root = document.createElement('div');
  root.id = 'cm-root';
  const barHost = document.createElement('div');
  const cardHost = document.createElement('div');
  const panelHost = document.createElement('div');
  const toastHost = document.createElement('div');
  const fab = document.createElement('button');
  fab.className = 'cm-fab';
  fab.title = 'Выдержки (Alt+H)';
  fab.innerHTML = '✎<b>0</b>';

  function mount() {
    document.head.appendChild(styleEl);
    ensureColorStyles();
    root.append(barHost, cardHost, panelHost, toastHost, fab);
    document.body.appendChild(root);
    fab.addEventListener('click', () => togglePanel());
  }

  /* Стили живут в <head>, интерфейс — в <body>. Одностраничные приложения,
     которые переписывают <head> при переходах (LinkedIn так делает), могут
     снести стили, оставив интерфейс на месте — и тогда вся панель, которая
     всегда в DOM и прячется только стилями, вываливается на страницу голым
     текстом. Проверка дешёвая, поэтому проверяем. */
  function keepShellAlive() {
    // textContent переживает открепление — цветовые правила вернутся вместе с ним
    if (!styleEl.isConnected && document.head) document.head.appendChild(styleEl);
    if (!root.isConnected && document.body) document.body.appendChild(root);
  }

  function toast(msg) {
    toastHost.innerHTML = `<div class="cm-toast">${esc(msg)}</div>`;
    setTimeout(() => { toastHost.innerHTML = ''; }, 1700);
  }

  function place(el, rect) {
    const w = el.offsetWidth || 320, h = el.offsetHeight || 60;
    const vw = window.innerWidth, vh = window.innerHeight;
    // над выделением, а если сверху не помещается — под ним
    let top = rect.top - h - 10;
    if (top < 8) top = rect.bottom + 10;
    // и в любом случае не выпускаем за пределы экрана
    top = Math.max(8, Math.min(top, vh - h - 8));
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    el.style.top = top + 'px';
    el.style.left = left + 'px';
  }

  /* ================================================================== *
   * ПАНЕЛЬКА ПРИ ВЫДЕЛЕНИИ
   * ================================================================== */

  let pending = null;   // {anchor, range, rect, overlap:[], style}
  let barMode = 'tags'; // tags | search | new | all
  let draftTag = null;  // черновик новой темы в режиме new

  /** Держим выделенный кусок подсвеченным, пока идёт выбор темы.
   *  Иначе после клика в панельку системное выделение слетает
   *  и непонятно, что именно ты взял. */
  function paintDraft(range) {
    if (!HAS_API) return;
    try { CSS.highlights.set('cm-draft', new Highlight(range)); } catch { /* ok */ }
  }
  function clearDraft() {
    if (HAS_API) CSS.highlights.delete('cm-draft');
  }

  function closeBar() {
    const wasOpen = !!pending;
    barHost.innerHTML = '';
    pending = null; barMode = 'tags'; draftTag = null;
    clearPreview(); clearDraft();
    if (wasOpen) repaintSoon();   // observer молчал, пока шёл выбор — догоняем
  }

  function overlappingIds(startChar, endChar) {
    return painted.filter(p => p.start < endChar && p.end > startChar).map(p => p.id);
  }

  function showBar() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return closeBar();
    const range = sel.getRangeAt(0);
    if (range.startContainer.parentElement && range.startContainer.parentElement.closest('#cm-root')) return closeBar();
    const text = sel.toString();
    if (!text || text.trim().length < 2) return closeBar();

    buildTextIndex();
    const anchor = makeAnchor(range);
    if (!anchor) return closeBar();

    const s = charOffsetOfPoint(range.startContainer, range.startOffset);
    const e = charOffsetOfPoint(range.endContainer, range.endOffset);
    const total = (textIndex && textIndex.text.length) || 1;
    pending = {
      anchor,
      idx: s,
      pos: Math.round((s / total) * 1000) / 1000,
      range: range.cloneRange(),
      rect: range.getBoundingClientRect(),
      overlap: overlappingIds(s, e),
      fmt: [],
      color: null,        // null — цвет ещё не выбран, берём у темы
    };
    paintDraft(pending.range);
    // всегда начинаем с обычного ряда: «Выделить» доступно и на пустой базе,
    // а новая тема заводится плюсом в нижнем ряду
    barMode = 'tags';
    draftTag = null;
    renderBar();
  }

  /* ---------------- подсказки для новой темы ------------------------- */

  /* ---------------- хэштег из названия -------------------------------- */

  /** Латиница остаётся латиницей, кириллица — кириллицей: как написал, так и будет. */
  function slugify(name) {
    return String(name || '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',
    э:'e',ю:'yu',я:'ya' };
  function translit(s) {
    return slugify(String(s).toLowerCase().split('').map(c => (c in TRANSLIT ? TRANSLIT[c] : c)).join(''));
  }

  /* ---------------- отрисовка панельки -------------------------------- */

  let previewName = null;

  /** Живое превью: кусок сразу показан выбранным цветом и форматами,
   *  ещё до сохранения. Отдельные регистры — настоящие выделения не трогаем. */
  function previewDraft() {
    if (!pending || !HAS_API) return;
    if (previewName) { CSS.highlights.delete(previewName); previewName = null; }
    CSS.highlights.delete('cm-draft');
    ensureColorStyles();
    previewName = 'p' + colorKey(pendingColor()) + (fmtKey(pending) || 'x');
    try { CSS.highlights.set(previewName, new Highlight(pending.range)); } catch { /* ok */ }
  }

  function clearPreview() {
    if (previewName && HAS_API) CSS.highlights.delete(previewName);
    previewName = null;
  }

  /** Какой цвет сейчас показывать: явно выбранный, цвет создаваемой темы,
   *  цвет последней использованной темы или жёлтый «без темы». */
  function pendingColor() {
    if (pending && pending.color) return pending.color;
    if (draftTag && draftTag.color) return draftTag.color;
    if (barMode === 'new') return nextColor();
    const last = SET.lastTag && tagByName(SET.lastTag);
    return (last && last.color) || NO_TAG_COLOR;
  }

  /** Нижний ряд — функции: цвет, форматы, создание темы и удаление.
   *  Он не меняется никогда: что бы ни происходило сверху, органы
   *  управления остаются на месте. */
  function formatRow() {
    const on = id => (pending.fmt || []).includes(id) ? 'on' : '';
    return `<div class="cm-styles">
      <button class="cm-st cm-swatch" data-act="palette" title="Цвет выделения">
        <span style="background:${pendingColor()}"></span></button>
      <span class="cm-sep"></span>
      ${FORMATS.map(f => `<button class="cm-st ${on(f.id)}" data-fmt="${f.id}" title="${f.label}">${f.html}</button>`).join('')}
      <span class="cm-sep"></span>
      <button class="cm-st ${barMode === 'new' ? 'on' : ''}" data-act="new" title="Новая тема">＋</button>
      ${pending.overlap.length
        ? '<button class="cm-st cm-del" data-act="unmark" title="Убрать выделение">' + ERASER_SVG + 'delete</button>'
        : ''}
    </div>
    <div class="cm-pal" data-role="pal" hidden>
      ${PALETTE.map(c => `<i data-c="${c}" style="background:${c}" class="${c === pendingColor() ? 'on' : ''}"></i>`).join('')}
    </div>`;
  }

  /** Список найденных тем — обновляется отдельно от поля ввода,
   *  иначе каретка прыгала бы на каждой букве. */
  function searchResults(q) {
    const found = recentTags().filter(t => t.name.includes(String(q || '').toLowerCase())).slice(0, 8);
    if (!found.length) return '<span style="color:#9a9ca4;font-size:12px">ничего не нашлось — Enter создаст новую</span>';
    return found.map(t => `<button class="cm-chip" data-tag="${esc(t.name)}">
        <i class="dot" style="background:${safeColor(t.color)}"></i>${esc(t.name)}</button>`).join('');
  }

  function tagChip(t, counts) {
    return `<button class="cm-chip" data-tag="${esc(t.name)}">
      <i class="dot" style="background:${safeColor(t.color)}"></i>${esc(t.name)}${counts.get(t.name) ? `<span style="opacity:.45">${counts.get(t.name)}</span>` : ''}
    </button>`;
  }

  /** Прокручиваемый список всех тем — как перечень в настройках мака.
   *  Клик по строке сразу сохраняет выдержку под эту тему. */
  function tagList(tags, counts) {
    if (!tags.length) return '<div class="cm-empty">тем пока нет</div>';
    return `<div class="cm-rows">
      ${tags.map(t => `<button class="cm-row" data-tag="${esc(t.name)}">
          <i class="dot" style="background:${safeColor(t.color)}"></i>
          <span class="nm">${esc(t.name)}</span>
          <span class="ct">${counts.get(t.name) || 0}</span>
        </button>`).join('')}
    </div>`;
  }

  function renderBar() {
    if (!pending) return;
    const tags = recentTags();
    const counts = tagCounts();
    let top = '';

    if (barMode === 'new') {
      const name = (draftTag && draftTag.name) || '';
      const slug = (draftTag && draftTag.slug) || translit(name);
      top = `
        <div class="cm-new">
          <div class="cm-row1">
            <input type="text" data-role="tagname" placeholder="Название новой темы" value="${esc(name)}" autocomplete="off">
            <button class="cm-chip go" data-act="create">Сохранить</button>
            <button class="cm-chip ghost" data-act="cancel">Отмена</button>
          </div>
          ${name ? `<div class="cm-hint">тег <code data-role="slug">#${esc(slug)}</code>
              <button data-act="editslug">изменить</button></div>` : ''}
        </div>`;
    } else if (barMode === 'search') {
      const q = (draftTag && draftTag.q) || '';
      top = `
        <div class="cm-new">
          <div class="cm-row1">
            <input type="text" data-role="find" placeholder="Тема…" value="${esc(q)}" autocomplete="off">
            <button class="cm-chip ghost" data-act="less">закрыть</button>
          </div>
          <div class="cm-chips" data-role="results">${searchResults(q)}</div>
        </div>`;
    } else if (barMode === 'all') {
      top = `<div class="cm-all">
          <div class="cm-row1">
            <input type="text" data-role="find" placeholder="Найти тему…" autocomplete="off">
            <button class="cm-chip ghost" data-act="less">закрыть</button>
          </div>
          <div data-role="results">${tagList(tags, counts)}</div>
        </div>`;
    } else {
      // Первая строка — крупная жёлтая кнопка «Выделить».
      // Вторая — две последние темы и многоточие, прижатое вправо.
      top = `
        <button class="cm-chip mark" data-act="plain" title="Просто выделить, без темы">
          ${MARKER_SVG}Выделить</button>
        ${tags.length ? `<div class="cm-chips row2">
          ${tags.slice(0, 2).map(t => tagChip(t, counts)).join('')}
          ${tags.length > 2 ? '<button class="cm-chip ghost dots" data-act="all" title="Все темы">⋯</button>' : ''}
        </div>` : ''}`;
    }

    barHost.innerHTML = `<div class="cm-pop">${top}${formatRow()}</div>`;
    const pop = barHost.firstElementChild;
    place(pop, pending.rect);
    previewDraft();

    const input = pop.querySelector('input');
    if (!input) return;

    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    requestAnimationFrame(() => place(pop, pending.rect));

    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); barMode = 'tags'; draftTag = null; return renderBar(); }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (barMode === 'new') return createAndApply();
      const q = input.value.trim().toLowerCase();
      const hit = recentTags().find(t => t.name === q) || recentTags().find(t => t.name.includes(q));
      if (hit) return applyTag(hit.name);
      draftTag = { name: q, slug: translit(q) };
      barMode = 'new';
      renderBar();
    });

    input.addEventListener('input', ev => {
      const v = ev.target.value;
      if (barMode === 'all') {
        const box = pop.querySelector('[data-role=results]');
        const q = v.trim().toLowerCase();
        if (box) box.innerHTML = tagList(recentTags().filter(t => t.name.includes(q)), tagCounts());
        return;
      }
      if (barMode === 'search') {
        draftTag = { q: v };
        const box = pop.querySelector('[data-role=results]');
        if (box) box.innerHTML = searchResults(v);
        return;
      }
      // имя запоминаем сразу, иначе клик по формату стирал бы набранное
      draftTag = Object.assign({}, draftTag, { name: v, slug: translit(v) });
      const hint = pop.querySelector('[data-role=slug]');
      if (hint) hint.textContent = '#' + draftTag.slug;
      else renderBar();
    });
  }

  function createAndApply() {
    const name = ((draftTag && draftTag.name) || '').trim();
    if (!name) return toast('Впиши название темы');
    const color = (pending && pending.color) || nextColor();
    const t = ensureTag(name, color);
    if (t) t.slug = draftTag.slug || translit(t.name);
    saveTags(); ensureColorStyles();
    applyTag(t.name);
  }

  barHost.addEventListener('mousedown', e => {
    if (!e.target.closest('input')) e.preventDefault();   // не рвём выделение
  });

  barHost.addEventListener('click', e => {
    const sw = e.target.closest('.cm-pal i');
    if (sw) {
      pending.color = sw.dataset.c;
      if (draftTag) draftTag.color = sw.dataset.c;
      renderBar();
      const pal = barHost.querySelector('[data-role=pal]');
      if (pal) pal.hidden = false;      // палитра остаётся открытой, цвет видно сразу
      return;
    }
    const b = e.target.closest('button');
    if (!b || !pending) return;

    if (b.dataset.fmt) {
      const set = new Set(pending.fmt || []);
      set.has(b.dataset.fmt) ? set.delete(b.dataset.fmt) : set.add(b.dataset.fmt);
      pending.fmt = [...set];
      return renderBar();
    }
    if (b.dataset.tag) return applyTag(b.dataset.tag);

    switch (b.dataset.act) {
      case 'all':     barMode = 'all'; return renderBar();
      case 'less':    barMode = 'tags'; return renderBar();
      case 'new':     barMode = 'new'; return renderBar();
      case 'cancel':  barMode = 'tags'; draftTag = null; return renderBar();
      case 'plain':   return applyTag(null);
      case 'create':  return createAndApply();
      case 'palette': {
        const pal = barHost.querySelector('[data-role=pal]');
        if (pal) pal.hidden = !pal.hidden;
        return;
      }
      case 'editslug': {
        draftTag = Object.assign({ name: '' }, draftTag);
        const v = prompt('Тег темы — по нему Claude её находит', draftTag.slug || '');
        if (v && v.trim()) draftTag.slug = slugify(v);
        return renderBar();
      }
      case 'unmark':  return unmarkSelection();
    }
  });

  function clearSelection() {
    const s = window.getSelection();
    if (s) s.removeAllRanges();
  }

  /* ---------------- снятие выделения по кусочку -----------------------
   * Выделил внутри уже размеченного текста и нажал «убрать» — вырезается
   * ровно пересечение, а не всё выделение целиком. Что осталось слева
   * и справа, остаётся размеченным и получает свои якоря.
   */
  const MIN_PIECE = 3;

  function anchorAt(start, end) {
    const T = textIndex.text;
    return {
      exact: T.slice(start, end),
      prefix: T.slice(Math.max(0, start - CONTEXT_LEN), start),
      suffix: T.slice(end, Math.min(T.length, end + CONTEXT_LEN)),
    };
  }

  function piece(h, start, end) {
    const a = anchorAt(start, end);
    const total = (textIndex && textIndex.text.length) || 1;
    return Object.assign({}, h, {
      id: uid(),
      anchor: a,
      text: a.exact,
      idx: start,
      pos: Math.round((start / total) * 1000) / 1000,
      exp: false,          // кусок изменился — его надо выгрузить заново
    });
  }

  function unmarkSelection() {
    if (!pending || !pending.overlap.length) return;
    buildTextIndex();     // свежий индекс: пока панелька была открыта, страница могла измениться

    const selPos = resolveAnchor(pending.anchor);
    const selStart = selPos ? selPos.start : pending.idx;
    const selEnd = selPos ? selPos.end : pending.idx + pending.anchor.exact.length;
    const key = pageKey();

    let removed = 0, trimmed = 0, split = 0;
    const next = [];

    for (const h of DB.highlights) {
      if (h.conv !== key) { next.push(h); continue; }
      const hit = resolveAnchor(h.anchor);   // тоже по свежему индексу, не по painted
      if (!hit || hit.end <= selStart || hit.start >= selEnd) { next.push(h); continue; }

      const left = selStart - hit.start;     // сколько остаётся слева
      const right = hit.end - selEnd;        // сколько остаётся справа

      bury(h.id);          // исходный кусок в любом из исходов прекращает существовать
      if (left < MIN_PIECE && right < MIN_PIECE) { removed++; continue; }
      if (left >= MIN_PIECE && right >= MIN_PIECE) {
        next.push(piece(h, hit.start, selStart));
        next.push(piece(h, selEnd, hit.end));
        split++;
        continue;
      }
      next.push(left >= MIN_PIECE ? piece(h, hit.start, selStart) : piece(h, selEnd, hit.end));
      trimmed++;
    }

    DB.highlights = next;
    saveDB(); closeBar(); clearSelection(); repaint(); renderPanel();

    const parts = [];
    if (removed) parts.push(`убрано целиком: ${removed}`);
    if (trimmed) parts.push(`обрезано: ${trimmed}`);
    if (split) parts.push(`разрезано надвое: ${split}`);
    toast(parts.join(', ') || 'Ничего не изменилось');
  }

  function applyTag(tagName) {
    if (!pending) return;
    const tag = tagName ? ensureTag(tagName) : null;
    const h = {
      id: uid(),
      conv: pageKey(),
      host: location.hostname,
      url: location.href,
      title: pageTitle(),
      tag: tag ? tag.name : '',
      slug: tag ? (tag.slug || slugify(tag.name)) : '',
      color: tag ? (pending.color || tag.color) : NO_TAG_COLOR,
      fmt: (pending.fmt || []).slice(),
      note: '',
      anchor: pending.anchor,
      text: pending.anchor.exact,
      // где в документе: доля прокрутки и номер символа. Из этого потом
      // строится последовательность выделений по мере чтения.
      pos: pending.pos,
      idx: pending.idx,
      createdAt: new Date().toISOString(),
    };
    DB.highlights.push(h);
    const dropped = prune();
    saveDB();
    if (dropped) toast(`Буфер полон — вытеснено старых (уже в библиотеке): ${dropped}`);
    if (tag) touchTag(tag.name);
    ensureColorStyles();
    closeBar(); clearSelection();
    repaint(); renderPanel();
    if (!dropped) toast(tag ? '✓ ' + tag.name : '✓ сохранено');
  }

  document.addEventListener('selectionchange', debounce(() => {
    // Пока идёт диалог (создание темы, подтверждение, поиск) панельку не трогаем:
    // фокус в поле ввода сам снимает выделение страницы, и без этой проверки
    // окно закрывалось бы прямо под руками. Закрыть можно кликом мимо или Esc.
    if (pending && barMode !== 'tags') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { closeBar(); return; }
    showBar();
  }, 130));

  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#cm-root')) { closeBar(); closeCard(); }
  });

  /* ================================================================== *
   * КЛИК ПО СУЩЕСТВУЮЩЕМУ ВЫДЕЛЕНИЮ
   * ================================================================== */

  document.addEventListener('click', e => {
    if (e.target.closest('#cm-root')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) { e.preventDefault(); e.stopPropagation(); openCard(hit.id, hit.range.getBoundingClientRect()); }
  }, true);

  function hitTest(x, y) {
    if (!painted.length) return null;
    if (!textIndex) buildTextIndex();
    let node, offset;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; offset = p.offset;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; offset = r.startOffset;
    } else return null;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const idx = charOffsetOfPoint(node, offset);
    if (idx < 0) return null;
    return painted.find(p => idx >= p.start && idx < p.end) || null;
  }

  /* ================================================================== *
   * КАРТОЧКА ВЫДЕРЖКИ
   * ================================================================== */

  let cardId = null;

  function closeCard() { cardHost.innerHTML = ''; cardId = null; }

  function openCard(id, rect) {
    const h = DB.highlights.find(x => x.id === id);
    if (!h) return;
    cardId = id;
    const tags = recentTags();

    cardHost.innerHTML = `
      <div class="cm-pop cm-card">
        <div class="quote">${esc(h.text)}</div>
        <div class="cm-chips" style="margin-bottom:9px">
          ${tags.map(t => `<button class="cm-chip" data-tag="${esc(t.name)}"
              style="${t.name === h.tag ? 'outline:2px solid #fff;outline-offset:1px' : ''}">
              <i class="dot" style="background:${safeColor(t.color)}"></i>${esc(t.name)}</button>`).join('')}
          <button class="cm-chip ghost" data-act="new">＋</button>
          <button class="cm-chip ghost" data-tag="" style="${!h.tag ? 'outline:2px solid #fff;outline-offset:1px' : ''}">без темы</button>
        </div>
        <div class="cm-styles" style="border:0;margin:0 0 9px;padding:0">
          <button class="cm-st cm-swatch" data-act="palette" title="Цвет выделения">
            <span style="background:${safeColor(h.color)}"></span></button>
          <span class="cm-sep"></span>
          ${FORMATS.map(f => `<button class="cm-st ${(h.fmt || []).includes(f.id) ? 'on' : ''}" data-fmt="${f.id}" title="${f.label}">${f.html}</button>`).join('')}
        </div>
        <div class="cm-pal" data-role="pal" hidden style="margin-bottom:9px">
          ${PALETTE.map(c => `<i data-c="${c}" style="background:${c}" class="${c === h.color ? 'on' : ''}"></i>`).join('')}
        </div>
        <textarea placeholder="Заметка: зачем это, что с этим делать">${esc(h.note || '')}</textarea>
        <div class="row">
          <button class="cm-chip" data-act="save">Сохранить</button>
          <button class="cm-chip" data-act="copy">Копировать</button>
          <button class="cm-chip" data-act="src">К источнику ↗</button>
          <span class="grow"></span>
          <button class="cm-chip danger" data-act="del">Убрать выделение</button>
        </div>
      </div>`;

    const pop = cardHost.firstElementChild;
    place(pop, rect);
    const ta = pop.querySelector('textarea');

    pop.addEventListener('mousedown', ev => ev.stopPropagation());
    pop.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') closeCard();
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { saveCard(); }
    });

    pop.addEventListener('click', ev => {
      const sw = ev.target.closest('.cm-pal i');
      if (sw) {
        ev.stopPropagation();
        h.color = sw.dataset.c; h.note = ta.value;
        saveDB(); ensureColorStyles(); repaint(); renderPanel(); openCard(id, rect);
        return;
      }
      const b = ev.target.closest('button');
      if (!b) return;
      ev.stopPropagation();

      if (b.dataset.fmt) {
        const set = new Set(h.fmt || []);
        set.has(b.dataset.fmt) ? set.delete(b.dataset.fmt) : set.add(b.dataset.fmt);
        h.fmt = [...set]; h.note = ta.value;
        saveDB(); repaint(); renderPanel(); openCard(id, rect);
        return;
      }
      if (b.dataset.act === 'palette') {
        const pal = pop.querySelector('[data-role=pal]');
        if (pal) pal.hidden = !pal.hidden;
        return;
      }
      if (b.dataset.tag !== undefined && !b.dataset.act) {
        const name = b.dataset.tag;
        h.note = ta.value;
        setTag(h, name);
        openCard(id, rect);
        return;
      }
      switch (b.dataset.act) {
        case 'new': {
          const name = prompt('Название новой темы');
          if (name && name.trim()) {
            const t = ensureTag(name.trim());
            h.note = ta.value;
            setTag(h, t.name);
            ensureColorStyles();
            openCard(id, rect);
          }
          return;
        }
        case 'save': return saveCard();
        case 'copy':
          navigator.clipboard.writeText(asMarkdown([h])).then(() => toast('Скопировано'), () => toast('Не вышло скопировать'));
          return;
        case 'src':
          window.open(fragmentUrl(h), '_blank', 'noopener');
          return;
        case 'del':
          bury(id);
          DB.highlights = DB.highlights.filter(x => x.id !== id);
          saveDB(); closeCard(); repaint(); renderPanel();
          return toast('Выделение убрано');
      }
    });

    function saveCard() {
      h.note = ta.value;
      saveDB(); closeCard(); repaint(); renderPanel();
      toast('Сохранено');
    }

    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function setTag(h, name) {
    const t = name ? ensureTag(name) : null;
    h.tag = t ? t.name : '';
    h.color = t ? t.color : NO_TAG_COLOR;
    saveDB();
    if (t) touchTag(t.name);
    repaint(); renderPanel();
  }

  /* ================================================================== *
   * БОКОВАЯ ПАНЕЛЬ
   * ================================================================== */

  /* Фильтр тем такой же, как в дашборде: клик переключает,
     галочка закрепляет, закреплённые складываются. */
  const panel = { open: false, q: '', current: null, pinned: new Set(), scope: 'all',
                  menu: false, kill: null };

  function panelTags() {
    const set = new Set(panel.pinned);
    if (panel.current !== null) set.add(panel.current);
    return set;
  }

  function togglePanel(force) {
    panel.open = force !== undefined ? force : !panel.open;
    SET.panelOpen = panel.open; saveSet();
    renderPanel();
  }

  function visible() {
    const key = pageKey();
    let list = DB.highlights.slice().reverse();
    if (panel.scope === 'page') list = list.filter(h => h.conv === key);
    const on = panelTags();
    if (on.size) list = list.filter(h => on.has(h.tag || ''));
    const q = panel.q.trim().toLowerCase();
    if (q) list = list.filter(h =>
      (h.text || '').toLowerCase().includes(q) ||
      (h.note || '').toLowerCase().includes(q) ||
      (h.title || '').toLowerCase().includes(q));
    return list;
  }

  function panelListHtml(list, key) {
    const groups = new Map();
    for (const h of list) {
      const g = h.conv === key ? '📍 эта страница' : (h.title || h.conv);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(h);
    }
    return [...groups.entries()].map(([g, items]) => `
            <div class="cm-group">${esc(g)} · ${items.length}</div>
            ${items.map(h => `
              <div class="cm-item ${orphans.has(h.id) ? 'orphan' : ''}" style="border-left-color:${safeColor(h.color)}">
                <div class="q">${esc(h.text)}</div>
                ${h.note ? `<div class="n">✎ ${esc(h.note)}</div>` : ''}
                <div class="m">
                  ${h.tag ? `<span style="color:${safeColor(h.color)}">#${esc(h.tag)}</span>` : ''}
                  <span>${esc(fmtDate(h.createdAt))}</span>
                  ${h.conv === key ? `<button data-goto="${esc(h.id)}">к месту</button>` : ''}
                  <a href="${esc(fragmentUrl(h))}" target="_blank" rel="noopener" title="Откроет источник и прокрутит ровно к этому месту">источник ↗</a>
                  <button data-edit="${esc(h.id)}">заметка</button>
                  <button data-copy="${esc(h.id)}">копия</button>
                  <button data-del="${esc(h.id)}">убрать</button>
                </div>
              </div>`).join('')}
          `).join('') || '<div style="color:#6e7078;padding:22px 4px">Пока пусто. Выдели текст на любой странице — появится маркер.</div>';
  }

  /* Поиск обновляет только список: пересборка всей панели убивала бы фокус
     и каретку в поле ввода на каждой паузе набора. */
  function refreshPanelList() {
    const listEl = panelHost.querySelector('.cm-list');
    if (!listEl) return renderPanel();
    const list = visible();
    listEl.innerHTML = panelListHtml(list, pageKey());
    const h2 = panelHost.querySelector('.cm-panel header h2');
    if (h2) h2.textContent = `Выдержки · ${list.length}`;
  }

  function renderPanel() {
    const total = DB.highlights.length;
    fab.querySelector('b').textContent = total;
    fab.classList.toggle('has', DB.highlights.some(h => h.conv === pageKey()));
    fab.style.display = (SET.showFab && !panel.open) ? '' : 'none';

    if (!panel.open) { panelHost.innerHTML = ''; return; }

    // пока человек печатает в поиске, полную пересборку не делаем —
    // она пересоздала бы input и выбросила фокус с кареткой
    const qEl = panelHost.querySelector('[data-role=q]');
    if (qEl && document.activeElement === qEl) return refreshPanelList();

    const list = visible();
    const key = pageKey();
    const counts = tagCounts();
    const pendingExport = unexported();

    panelHost.innerHTML = `
      <aside class="cm-panel">
        <header>
          <h2>Выдержки · ${list.length}</h2>
          <button class="cm-x" data-act="close">✕</button>
        </header>
        <div class="cm-tools">
          <input type="text" placeholder="Поиск по тексту, заметкам, страницам" value="${esc(panel.q)}" data-role="q">
          <div class="cm-filters">
            <button class="cm-f ${panel.scope === 'all' ? 'on' : ''}" data-scope="all">Везде</button>
            <button class="cm-f ${panel.scope === 'page' ? 'on' : ''}" data-scope="page">Эта страница</button>
            <button class="cm-f ${panelTags().size ? '' : 'on'}" data-act="allTags">Все темы</button>
          </div>
          <div class="cm-filters">
            <button class="cm-f ${panelTags().has('') ? 'on' : ''}" data-tag="">
              <i class="dot" style="background:${NO_TAG_COLOR}"></i>Выделить
              <span class="cm-box ${panel.pinned.has('') ? 'pin' : ''}" data-pin="">✓</span></button>
            ${recentTags().slice(0, 5).map(t => `<button class="cm-f ${panelTags().has(t.name) ? 'on' : ''}" data-tag="${esc(t.name)}">
                <i class="dot" style="background:${safeColor(t.color)}"></i>${esc(t.name)} ${counts.get(t.name) || 0}
                ${t.doc ? `<span class="docmark" title="По теме ведётся документ">${DOC_SVG}</span>` : ''}
                <span class="cm-box ${panel.pinned.has(t.name) ? 'pin' : ''}" data-pin="${esc(t.name)}">✓</span></button>`).join('')}
            ${recentTags().length ? `<button class="cm-f" data-act="menu" title="Все темы и документы" style="font-size:15px;letter-spacing:1px">⋯</button>` : ''}
          </div>
          ${panel.menu ? `<div class="cm-rows">
            ${recentTags().map(t => panel.kill === t.name ? `
              <div class="cm-row kill" title="Удалить тему «${esc(t.name)}»">
                <span class="nm">«${esc(t.name)}»</span>
                <button class="cm-mini" data-killtag="${esc(t.name)}">убрать тему</button>
                ${counts.get(t.name) ? `<button class="cm-mini danger" data-killall="${esc(t.name)}">и ${counts.get(t.name)} шт.</button>` : ''}
                <button class="cm-mini ghost" data-act="killno">✕</button>
              </div>` : `
              <div class="cm-row" data-tag="${esc(t.name)}">
                <i class="dot" style="background:${safeColor(t.color)}"></i>
                <span class="nm">${esc(t.name)}</span><span class="ct">${counts.get(t.name) || 0}</span>
                <button class="cm-doc ${t.doc ? 'on' : ''}" data-doc="${esc(t.name)}"
                        title="${t.doc ? 'Документ по теме ведётся — выключить' : 'Вести документ по этой теме'}">${DOC_SVG}</button>
                <button class="cm-trash" data-trash="${esc(t.name)}" title="Удалить тему">${TRASH_SVG}</button>
                <span class="cm-box ${panel.pinned.has(t.name) ? 'pin' : ''}" data-pin="${esc(t.name)}">✓</span>
              </div>`).join('')}
          </div>
          <div class="cm-hint">${DOC_SVG} — живой .docx в папке «06 Документы» &nbsp;·&nbsp; ${TRASH_SVG} — удалить тему</div>` : ''}
        </div>
        <div class="cm-list">${panelListHtml(list, key)}</div>
        ${pendingExport > 0 ? `<button class="cm-note-line as-btn" data-act="dl-json">${pendingExport} шт. ещё не уехало — выгрузить сейчас</button>` : ''}
        ${!SHARED ? `<div class="cm-note-line">Менеджер скриптов не даёт общее хранилище — база отдельная для каждого сайта. Выгружай почаще.</div>` : ''}
        <div class="cm-actions">
          <button class="primary" data-act="dl-json">Выгрузить в библиотеку</button>
          <button data-act="paste">В поле ввода ${list.length ? '· ' + list.length : ''}</button>
          <button data-act="md">Копировать MD</button>
          <button data-act="dl-md">Скачать .md</button>
          <button data-act="import">Импорт</button>
          <button data-act="limit">Буфер ${total}/${SET.limit || 10000}</button>
          <button data-act="fab">${SET.showFab ? 'Скрыть кнопку' : 'Показать кнопку'}</button>
        </div>
      </aside>`;

    const el = panelHost.querySelector('.cm-panel');
    const q = el.querySelector('[data-role=q]');
    q.addEventListener('input', debounce(ev => { panel.q = ev.target.value; refreshPanelList(); }, 150));
    q.addEventListener('keydown', ev => ev.stopPropagation());

    el.addEventListener('click', ev => {
      const pin = ev.target.closest('[data-pin]');
      if (pin) {
        ev.stopPropagation();
        const t = pin.dataset.pin;
        panel.pinned.has(t) ? panel.pinned.delete(t) : panel.pinned.add(t);
        if (panel.current === t) panel.current = null;
        return renderPanel();
      }
      const trash = ev.target.closest('[data-trash]');
      if (trash) {
        ev.stopPropagation();
        panel.kill = panel.kill === trash.dataset.trash ? null : trash.dataset.trash;
        return renderPanel();
      }
      const killOne = ev.target.closest('[data-killtag]');
      if (killOne) {
        ev.stopPropagation();
        const name = killOne.dataset.killtag;
        const n = tagCounts().get(name) || 0;
        panel.kill = null;
        removeTag(name, false);
        renderPanel();
        return toast(n ? `Тема «${name}» удалена, ${n} шт. без темы` : `Тема «${name}» удалена`);
      }
      const killAll = ev.target.closest('[data-killall]');
      if (killAll) {
        ev.stopPropagation();
        const name = killAll.dataset.killall;
        const n = tagCounts().get(name) || 0;
        panel.kill = null;
        removeTag(name, true);
        renderPanel();
        return toast(`Тема «${name}» и ${n} выдержек удалены`);
      }
      const docBtn = ev.target.closest('[data-doc]');
      if (docBtn) {
        ev.stopPropagation();
        const name = docBtn.dataset.doc;
        const on = toggleTagDoc(name);
        renderPanel();
        return toast(on ? `Документ по теме «${name}» соберётся при следующей выгрузке`
                        : `Документ по теме «${name}» больше не ведётся`);
      }
      const b = ev.target.closest('button') || ev.target.closest('.cm-row');
      if (!b) return;
      if (b.dataset.scope) { panel.scope = b.dataset.scope; return renderPanel(); }
      if (b.dataset.tag !== undefined && !b.dataset.act && !b.dataset.edit) {
        const t = b.dataset.tag;
        panel.current = panel.current === t ? null : t;
        panel.menu = false;
        return renderPanel();
      }
      if (b.dataset.goto) return goTo(b.dataset.goto);
      if (b.dataset.edit) {
        const p = painted.find(x => x.id === b.dataset.edit);
        return openCard(b.dataset.edit, p ? p.range.getBoundingClientRect()
                                          : { top: 120, bottom: 160, left: window.innerWidth / 2 - 190, width: 380 });
      }
      if (b.dataset.copy) {
        const h = DB.highlights.find(x => x.id === b.dataset.copy);
        return navigator.clipboard.writeText(asMarkdown([h])).then(() => toast('Скопировано'), () => {});
      }
      if (b.dataset.del) {
        bury(b.dataset.del);
        DB.highlights = DB.highlights.filter(x => x.id !== b.dataset.del);
        saveDB(); repaint(); renderPanel();
        return toast('Убрано');
      }
      switch (b.dataset.act) {
        case 'close': return togglePanel(false);
        case 'allTags': panel.current = null; panel.pinned.clear(); panel.menu = false; return renderPanel();
        case 'menu': panel.menu = !panel.menu; panel.kill = null; return renderPanel();
        case 'killno': panel.kill = null; return renderPanel();
        case 'md': return navigator.clipboard.writeText(asMarkdown(visible())).then(() => toast('Markdown в буфере'), () => {});
        case 'dl-md': return download('highlights.md', asMarkdown(visible()), 'text/markdown');
        case 'dl-json': {
          exportLibrary();
          return toast('Выгружено — файл сам уедет в библиотеку');
        }
        case 'paste': {
          const list = visible();
          if (!list.length) return toast('Нечего вставлять');
          const md = asMarkdown(list);
          if (md.length > 60000) return toast('Слишком много — сузь фильтр');
          return insertIntoComposer(md, list.length);
        }
        case 'limit': {
          const v = prompt('Сколько выдержек держать в браузере?\n\nСтарые сверх лимита вытесняются, но только те, что уже уехали в библиотеку.', String(SET.limit || 10000));
          const n = parseInt(v, 10);
          if (n >= 100) { SET.limit = n; saveSet(); prune(); saveDB(); repaint(); renderPanel(); }
          return;
        }
        case 'import': return importJson();
        case 'fab': SET.showFab = !SET.showFab; saveSet(); return renderPanel();
      }
    });
  }

  function goTo(id) {
    repaint();
    const p = painted.find(x => x.id === id);
    if (!p) return toast('Не нашёл это место — возможно, страница ещё не прогрузилась');
    const rect = p.range.getBoundingClientRect();
    window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: 'smooth' });
    if (HAS_API) {
      CSS.highlights.set('cm-active', new Highlight(p.range));
      setTimeout(() => CSS.highlights.delete('cm-active'), 1300);
    }
  }

  /* ================================================================== *
   * ЭКСПОРТ
   * ================================================================== */

  /** Как выдержка выглядит в тексте: цитата в ёлочках и курсивом, стили — разметкой. */
  function styledText(h) {
    let t = (h.text || '').trim();
    const f = h.fmt || [];
    if (f.includes('b')) t = `**${t}**`;
    if (f.includes('u')) t = `<u>${t}</u>`;
    if (f.includes('s')) t = `~~${t}~~`;
    return t;
  }

  function asMarkdown(list) {
    const by = new Map();
    for (const h of list) {
      if (!h) continue;
      if (!by.has(h.conv)) by.set(h.conv, []);
      by.get(h.conv).push(h);
    }
    let out = '';
    for (const [, items] of by) {
      const f = items[0];
      out += `\n## ${f.title}\n${f.url ? `[${f.url}](${f.url})\n` : ''}\n`;
      for (const h of items.slice().reverse()) {
        out += `> ${styledText(h).replace(/\n/g, '\n> ')}\n\n`;
        out += `${h.tag ? '`#' + (h.slug || h.tag) + '`' : '`без темы`'} · ${fmtDate(h.createdAt)}\n`;
        if (h.note) out += `\n**Заметка:** ${h.note}\n`;
        const fu = fragmentUrl(h);
        if (fu) out += `\n[к месту в источнике](${fu})\n`;
        out += '\n---\n\n';
      }
    }
    return out.trim() + '\n';
  }

  /* ---------------- мост в любую нейросеть ----------------------------
   * MCP работает только там, где его встроили. А поле ввода есть везде:
   * ChatGPT, Gemini, Perplexity, что угодно. Поэтому подборку по теме
   * можно просто положить в композер той страницы, где ты сейчас стоишь.
   */
  function findComposer() {
    const cands = [...document.querySelectorAll('[contenteditable="true"], textarea')]
      .filter(el => {
        if (el.closest('#cm-root')) return false;
        // offsetParent тут не годится: у fixed-элементов он null, а поле ввода
        // в чатах почти всегда именно fixed
        if (!el.getClientRects().length) return false;
        const r = el.getBoundingClientRect();
        return r.width > 180 && r.height > 18;
      });
    if (!cands.length) return null;
    // самый нижний на экране — обычно это и есть поле ввода
    return cands.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }

  function insertIntoComposer(text, count) {
    const box = findComposer();
    if (!box) {
      navigator.clipboard.writeText(text).then(() => toast('Поля ввода нет — подборка в буфере обмена'), () => {});
      return;
    }
    box.focus();

    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, box.value + (box.value ? '\n\n' : '') + text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      toast(`Вставлено выдержек: ${count}`);
      return;
    }

    // contenteditable: ставим каретку в конец, иначе вставлять некуда
    const before = box.textContent || '';
    try {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(box);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('insertText', false, (before ? '\n\n' : '') + text);
    } catch { /* ниже подстрахуемся */ }

    if ((box.textContent || '') === before) {
      // редактор не принял команду — кладём узлами и сообщаем ему об изменении
      try {
        for (const line of ((before ? '\n\n' : '') + text).split('\n')) {
          box.appendChild(document.createTextNode(line));
          box.appendChild(document.createElement('br'));
        }
        box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch { /* совсем никак */ }
    }

    if ((box.textContent || '') === before) {
      navigator.clipboard.writeText(text).then(() => toast('Редактор не принял вставку — подборка в буфере обмена'), () => {});
      return;
    }
    toast(`Вставлено выдержек: ${count}`);
  }

  const unexported = () => DB.highlights.filter(h => !h.exp).length;

  function exportLibrary() {
    download('highlights.json',
      JSON.stringify({
        version: 3,
        tags: TAGS.list,
        deletedTags: Object.keys(TAGS.deleted || {}),
        highlights: DB.highlights,
        deleted: Object.keys(DB.deleted || {}),
      }, null, 2),
      'application/json');
    // всё, что уехало, помечаем — только такие потом можно вытеснять
    for (const h of DB.highlights) h.exp = true;
    SET.lastExportCount = DB.highlights.length;
    SET.lastAutoExport = Date.now();
    saveDB(); saveSet(); renderPanel();
  }

  /* Автовыгрузка: раз в 10 минут, только если есть невыгруженное.
     Метка времени лежит в общих настройках, так что несколько вкладок не будут
     качать хором; а даже если две совпадут — слияние в библиотеке идемпотентно. */
  const AUTO_EXPORT_MS = 10 * 60 * 1000;

  function autoExportTick() {
    if (document.hidden) return;
    if (!unexported()) return;
    SET = Object.assign(SET, store.read(K.settings, {}));   // свежая метка от других вкладок
    if (Date.now() - (SET.lastAutoExport || 0) < AUTO_EXPORT_MS - 15000) return;
    exportLibrary();
    toast('Автовыгрузка в библиотеку');
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function importJson() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          for (const t of (data.tags || [])) ensureTag(t.name, t.color);
          const have = new Set(DB.highlights.map(h => h.id));
          let added = 0;
          for (const h of (data.highlights || [])) {
            if (h && h.id && !have.has(h.id)) { DB.highlights.push(h); added++; }
          }
          saveDB(); ensureColorStyles(); repaint(); renderPanel();
          toast(`Добавлено: ${added}`);
        } catch { toast('Файл не разобрался'); }
      };
      r.readAsText(f);
    };
    input.click();
  }

  /* ================================================================== *
   * КЛАВИАТУРА
   * ================================================================== */

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeBar(); closeCard(); return; }

    /* Панелька открыта и ты просто начал печатать — значит ищешь тему.
       Кнопки при этом никуда не делись: мышь и клавиатура работают вместе. */
    if (pending && barMode === 'tags' && !e.altKey && !e.metaKey && !e.ctrlKey &&
        e.key.length === 1 && /\p{L}/u.test(e.key) &&
        !(e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]'))) {
      e.preventDefault();
      barMode = 'search';
      draftTag = { q: e.key };
      renderBar();
      return;
    }

    if (!e.altKey || e.metaKey || e.ctrlKey) return;

    // на маке Alt+буква даёт спецсимвол («˙»), поэтому смотрим на физическую
    // клавишу e.code, а e.key оставляем как запасной путь
    if (e.code === 'KeyH' || e.key.toLowerCase() === 'h') { e.preventDefault(); return togglePanel(); }

    const n = /^Digit[1-9]$/.test(e.code) ? +e.code.slice(5) : parseInt(e.key, 10);
    if (n >= 1 && n <= 9) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        if (!pending) showBar();
        const t = recentTags()[n - 1];
        if (t && pending) { e.preventDefault(); applyTag(t.name); }
      }
    }
  });

  /* ================================================================== *
   * НАБЛЮДЕНИЕ ЗА СТРАНИЦЕЙ
   * ================================================================== */

  function watch() {
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) { lastPath = location.pathname; repaintSoon(); }
      keepShellAlive();
    }, 800);

    /* characterData сознательно не слушаем: пока Claude печатает ответ,
       он срабатывает тысячи раз в секунду. Достаточно появления и исчезновения
       узлов, а перерисовку откладываем до момента, когда браузер свободен. */
    new MutationObserver(muts => {
      for (const m of muts) {
        const t = m.target;
        if (t && t.closest && t.closest('#cm-root')) continue;
        if (pending) return;                 // идёт выбор темы — не мешаем
        return repaintSoon();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ================================================================== *
   * СИНХРОНИЗАЦИЯ МЕЖДУ ВКЛАДКАМИ
   * ================================================================== *
   * Каждая вкладка держит базу в памяти. Без этого блока вкладка, открытая
   * до изменения тем, жила бы со старым списком — и при первом же сохранении
   * записывала бы его обратно, воскрешая удалённое. Поэтому: слушаем чужие
   * записи в общее хранилище, а на возврат во вкладку перечитываем базу.
   */

  let sharedSig = null;

  function refreshFromShared() {
    if (!GM_SYNC) return;
    try {
      const rawTags = GM_getValue(K.tags, null);
      const rawDb = GM_getValue(K.db, null);
      const sig = (rawTags || '') + '\u0000' + (rawDb || '');
      if (sig === sharedSig) return;
      sharedSig = sig;

      if (rawTags) {
        const t = JSON.parse(rawTags);
        if (t && Array.isArray(t.list)) TAGS = t;
      }
      if (rawDb) {
        const d = JSON.parse(rawDb);
        if (d && Array.isArray(d.highlights)) DB = d;
      }
      try { localStorage.setItem(K.tags, rawTags || ''); localStorage.setItem(K.db, rawDb || ''); } catch {}
      ensureColorStyles();
      repaint();
      renderPanel();
      if (pending) renderBar();     // панелька открыта — обновим и её список тем
    } catch { /* чужая запись битая — переживём до следующей */ }
  }

  function watchShared() {
    if (!GM_SYNC) return;
    sharedSig = (GM_getValue(K.tags, null) || '') + '\u0000' + (GM_getValue(K.db, null) || '');

    // мгновенно: другая вкладка записала — эта узнала
    if (typeof GM_addValueChangeListener === 'function') {
      try {
        for (const key of [K.tags, K.db]) {
          GM_addValueChangeListener(key, (_name, _old, _val, remote) => {
            if (remote) refreshFromShared();
          });
        }
      } catch { /* нет поддержки — остаётся фокус */ }
    }

    // запасной путь: вернулся во вкладку — перечитали
    const wake = debounce(refreshFromShared, 200);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  }

  /* ================================================================== *
   * СТАРТ
   * ================================================================== */

  function boot() {
    if (!document.body) return setTimeout(boot, 300);

    DB = DB || { highlights: [] };
    TAGS = TAGS || { list: [] };
    if (!Array.isArray(DB.highlights)) DB = { highlights: [] };
    if (!Array.isArray(TAGS.list)) TAGS = { list: [] };

    const migrated = migrate();
    upgradeFormats();

    mount();
    panel.open = !!SET.panelOpen;
    repaint();
    renderPanel();
    watch();
    watchShared();
    setInterval(autoExportTick, 60 * 1000);

    if (migrated) toast(`Перенесено из старой базы: ${DB.highlights.length}`);
    if (!HAS_API) console.warn('[ChatMarker] нет CSS Custom Highlight API — нужен Chrome 105+ или Safari 17.2+');
    console.log('[ChatMarker] 1.2.0 ·', SHARED ? 'общая база на все сайты' : 'база на каждый сайт своя');

    // Safari: GM-хранилище только асинхронное, поднимаем базу вдогонку
    if (GM_ASYNC && !DB.highlights.length) {
      store.pullAsync(K.db).then(d => {
        if (d && Array.isArray(d.highlights) && d.highlights.length) {
          DB = d;
          store.pullAsync(K.tags).then(t => { if (t) TAGS = t; ensureColorStyles(); repaint(); renderPanel(); });
        }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
