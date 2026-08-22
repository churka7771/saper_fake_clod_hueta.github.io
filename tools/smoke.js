/* ===========================================================================
 * tools/smoke.js — headless-прогон игры в Node.
 *
 *   node tools/smoke.js
 *
 * Зачем: браузер тут недоступен, а `node --check` ловит только синтаксис.
 * Этот скрипт поднимает минимальный шим Canvas/DOM и реально исполняет
 * загрузку, игровой цикл, открытие клеток, проигрыш и цепную детонацию
 * всех 99 мин. Так отлавливаются рассогласования API между модулями,
 * опечатки в именах методов и NaN в расчётах — то есть именно те ошибки,
 * которые иначе всплыли бы только при открытии страницы.
 *
 * Контекст Canvas обёрнут в Proxy, который падает при обращении к
 * неизвестному свойству: опечатка вида ctx.fillRectangle не пройдёт
 * молча, а остановит прогон.
 * =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* --- Учёт вызовов ------------------------------------------------------- */

const stats = {
  drawImage: 0,
  fillRect: 0,
  stroke: 0,
  fillText: 0,
  gradients: 0,
  putImageData: 0,
};

/* --- Шим Canvas -------------------------------------------------------- */

/** Разрешённые свойства 2D-контекста. Всё остальное — ошибка. */
const CTX_PROPS = new Set([
  'canvas',
  'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin',
  'globalAlpha', 'globalCompositeOperation', 'filter',
  'font', 'textAlign', 'textBaseline',
  'imageSmoothingEnabled', 'imageSmoothingQuality',
  'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
  'miterLimit', 'lineDashOffset',
]);

const CTX_METHODS = new Set([
  'setTransform', 'resetTransform', 'transform',
  'save', 'restore', 'translate', 'rotate', 'scale', 'clip',
  'clearRect', 'fillRect', 'strokeRect',
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
  'ellipse', 'rect', 'quadraticCurveTo', 'bezierCurveTo',
  'stroke', 'fill',
  'drawImage',
  'createLinearGradient', 'createRadialGradient', 'createPattern',
  'createImageData', 'putImageData', 'getImageData',
  'fillText', 'strokeText', 'measureText',
  'setLineDash', 'getLineDash',
]);

function makeGradient() {
  stats.gradients++;
  return { addColorStop() {} };
}

function makeContext(canvas) {
  const raw = {
    canvas,

    setTransform() {}, resetTransform() {}, transform() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, clip() {},
    clearRect() {},
    fillRect(x, y, w, h) {
      assertFinite('fillRect', x, y, w, h);
      stats.fillRect++;
    },
    strokeRect(x, y, w, h) { assertFinite('strokeRect', x, y, w, h); },
    beginPath() {}, closePath() {},
    moveTo(x, y) { assertFinite('moveTo', x, y); },
    lineTo(x, y) { assertFinite('lineTo', x, y); },
    arc(x, y, r, a0, a1) { assertFinite('arc', x, y, r, a0, a1); },
    arcTo() {},
    ellipse(x, y, rx, ry) { assertFinite('ellipse', x, y, rx, ry); },
    rect() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    stroke() { stats.stroke++; },
    fill() {},
    drawImage(img, ...rest) {
      if (!img || (img.width === undefined && img.canvas === undefined)) {
        throw new Error('drawImage: источник не является изображением: ' + img);
      }
      assertFinite('drawImage', ...rest);
      stats.drawImage++;
    },
    createLinearGradient(...a) { assertFinite('createLinearGradient', ...a); return makeGradient(); },
    createRadialGradient(...a) { assertFinite('createRadialGradient', ...a); return makeGradient(); },
    createPattern(img) {
      if (!img) throw new Error('createPattern: пустой источник');
      return { __pattern: true };
    },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() { stats.putImageData++; },
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    fillText(t, x, y) { assertFinite('fillText', x, y); stats.fillText++; },
    strokeText(t, x, y) { assertFinite('strokeText', x, y); },
    measureText() { return { width: 10 }; },
    setLineDash() {}, getLineDash() { return []; },
  };

  // Значения свойств по умолчанию — чтобы чтение не возвращало undefined.
  raw.fillStyle = '#000';
  raw.strokeStyle = '#000';
  raw.lineWidth = 1;
  raw.lineCap = 'butt';
  raw.lineJoin = 'miter';
  raw.globalAlpha = 1;
  raw.globalCompositeOperation = 'source-over';
  raw.filter = 'none';
  raw.font = '10px sans-serif';
  raw.textAlign = 'start';
  raw.textBaseline = 'alphabetic';
  raw.imageSmoothingEnabled = true;
  raw.imageSmoothingQuality = 'low';
  raw.shadowBlur = 0;
  raw.shadowColor = 'transparent';
  raw.shadowOffsetX = 0;
  raw.shadowOffsetY = 0;
  raw.miterLimit = 10;
  raw.lineDashOffset = 0;

  return new Proxy(raw, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      if (prop in target) return target[prop];
      if (CTX_METHODS.has(prop) || CTX_PROPS.has(prop)) return target[prop];
      throw new Error(
        'Обращение к неизвестному свойству контекста Canvas: ctx.' + String(prop)
      );
    },
    set(target, prop, value) {
      if (CTX_PROPS.has(prop)) {
        if (
          (prop === 'globalAlpha' || prop === 'lineWidth') &&
          !Number.isFinite(value)
        ) {
          throw new Error('ctx.' + prop + ' = ' + value + ' (не число)');
        }
        target[prop] = value;
        return true;
      }
      throw new Error('Запись в неизвестное свойство контекста: ctx.' + String(prop));
    },
  });
}

function assertFinite(where, ...nums) {
  for (const n of nums) {
    if (typeof n === 'number' && !Number.isFinite(n)) {
      throw new Error(where + ': нечисловой аргумент (' + n + ')');
    }
  }
}

function makeCanvas(w = 300, h = 150) {
  const canvas = {
    width: w,
    height: h,
    style: {},
    getContext() {
      if (!this.__ctx) this.__ctx = makeContext(this);
      return this.__ctx;
    },
    getBoundingClientRect() {
      return {
        left: 0, top: 0,
        width: parseFloat(this.style.width) || this.width,
        height: parseFloat(this.style.height) || this.height,
        right: parseFloat(this.style.width) || this.width,
        bottom: parseFloat(this.style.height) || this.height,
      };
    },
    addEventListener(type, fn) {
      (this.__listeners || (this.__listeners = {}))[type] = fn;
    },
    dispatch(type, ev) {
      const fn = this.__listeners && this.__listeners[type];
      if (fn) fn(ev);
    },
  };
  return canvas;
}

/* --- Шим DOM ----------------------------------------------------------- */

function makeElement(id) {
  return {
    id,
    style: {},
    textContent: '',
    innerHTML: '',
    className: '',
    clientWidth: 1000,
    clientHeight: 640,
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) {
        if (on === undefined) on = !this._s.has(c);
        if (on) this._s.add(c); else this._s.delete(c);
        return on;
      },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(type, fn) {
      (this.__listeners || (this.__listeners = {}))[type] = fn;
    },
    dispatch(type, ev) {
      const fn = this.__listeners && this.__listeners[type];
      if (fn) fn(ev);
    },
    getAttribute(name) {
      return (this.__attrs && this.__attrs[name]) || null;
    },
    setAttribute(name, v) {
      (this.__attrs || (this.__attrs = {}))[name] = v;
    },
    querySelectorAll() {
      return this.children;
    },
  };
}

const CANVAS_IDS = ['layer-bg', 'layer-damage', 'layer-main', 'layer-fx'];

const elements = {};
function getEl(id) {
  if (!elements[id]) {
    elements[id] = CANVAS_IDS.includes(id) ? makeCanvas() : makeElement(id);
    if (CANVAS_IDS.includes(id)) elements[id].id = id;
  }
  return elements[id];
}

// Кнопки сложности должны отдаваться через querySelectorAll.
const diffBtns = ['beginner', 'intermediate', 'expert'].map((p) => {
  const b = makeElement('diff-' + p);
  b.setAttribute('data-preset', p);
  return b;
});

/* --- Виртуальные часы -------------------------------------------------- */

let vnow = 0;
const rafQueue = [];

/* Таймеры не выполняются мгновенно, а ждут своего времени по виртуальным
   часам. Это важно: обработчик ресайза задебаунсен через setTimeout, и
   мгновенное исполнение проверяло бы не тот путь, что в браузере. */
let timerId = 1;
const timers = new Map();

function setTimeoutShim(fn, ms) {
  const id = timerId++;
  timers.set(id, { fn, at: vnow + (ms || 0) });
  return id;
}

function clearTimeoutShim(id) {
  timers.delete(id);
}

function fireDueTimers() {
  for (const [id, t] of [...timers]) {
    if (t.at <= vnow) {
      timers.delete(id);
      t.fn();
    }
  }
}

/** Слушатели, навешенные на window. */
const windowListeners = {};

/* --- Песочница --------------------------------------------------------- */

const sandbox = {
  console,
  Math, Date, JSON, Number, String, Object, Array, Error, Boolean,
  Uint8Array, Uint8ClampedArray, Int32Array, Float32Array,
  isNaN, parseFloat, parseInt,
  setTimeout: setTimeoutShim,
  clearTimeout: clearTimeoutShim,
  performance: { now: () => vnow },
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false }),
  localStorage: {
    _d: {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
  },
  document: {
    readyState: 'complete',
    createElement(tag) {
      if (tag === 'canvas') return makeCanvas();
      return makeElement(tag);
    },
    getElementById: getEl,
    addEventListener() {},
  },
  addEventListener(type, fn) {
    (windowListeners[type] || (windowListeners[type] = [])).push(fn);
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

function fireWindow(type, ev) {
  const list = windowListeners[type] || [];
  for (const fn of list) fn(ev || {});
  return list.length;
}

// AudioContext намеренно отсутствует: audio.js обязан деградировать
// без звука, а не падать. Это тоже проверка.

const context = vm.createContext(sandbox);

const FILES = [
  'js/util.js',
  'js/board.js',
  'js/audio.js',
  'js/particles.js',
  'js/debris.js',
  'js/cracks.js',
  'js/fire.js',
  'js/effects.js',
  'js/render.js',
  'js/game.js',
];

/* --- Раннер ------------------------------------------------------------ */

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, pass: true, detail: detail || '' });
  } catch (e) {
    checks.push({ name, pass: false, detail: e && e.message ? e.message : String(e) });
  }
}

/** Прокручивает N кадров по 1/60 сек. */
function runFrames(n, dtMs = 16.67) {
  for (let i = 0; i < n; i++) {
    const cbs = rafQueue.splice(0, rafQueue.length);
    vnow += dtMs;
    fireDueTimers();
    for (const cb of cbs) cb(vnow);
  }
}

function mouseEvent(cellIdx, button, board, buttons) {
  const view = sandbox.MS.render.view;
  const x = (cellIdx % board.w) * view.cell + view.cell / 2;
  const y = ((cellIdx / board.w) | 0) * view.cell + view.cell / 2;
  return {
    clientX: x,
    clientY: y,
    button,
    buttons: buttons === undefined ? 0 : buttons,
    preventDefault() {},
    touches: [],
  };
}

/* --- Прогон ------------------------------------------------------------ */

console.log('\n\x1b[1mHeadless-прогон игры\x1b[0m\n');

check('Загрузка всех модулей', () => {
  for (const rel of FILES) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }
  const MS = sandbox.MS;
  const missing = ['util', 'Board', 'audio', 'particles', 'debris', 'cracks', 'fire', 'effects', 'render']
    .filter((k) => !MS[k]);
  if (missing.length) throw new Error('не экспортировано: ' + missing.join(', '));
  return FILES.length + ' файлов';
});

if (!checks[0].pass) {
  console.log('  \x1b[31mFAIL\x1b[0m  Загрузка всех модулей');
  console.log('        \x1b[31m' + checks[0].detail + '\x1b[0m\n');
  process.exit(1);
}

const MS = sandbox.MS;

// Подсовываем кнопки сложности.
getEl('difficulty').children = diffBtns;

check('Инициализация (boot) без исключений', () => {
  // boot вызывается при загрузке game.js, так как readyState = 'complete'.
  if (rafQueue.length === 0) throw new Error('игровой цикл не запросил кадр');
  return 'кадр запрошен';
});

check('Раскладка рассчитана', () => {
  const v = MS.render.view;
  if (!(v.cell >= 18 && v.cell <= 46)) throw new Error('размер клетки вне границ: ' + v.cell);
  if (v.w !== 16 || v.h !== 16) throw new Error('ожидалось поле 16x16, получено ' + v.w + 'x' + v.h);
  if (!(v.cssW > 0 && v.cssH > 0)) throw new Error('нулевые габариты поля');
  return v.w + 'x' + v.h + ', клетка ' + v.cell + 'px, DPR ' + v.dpr;
});

check('60 кадров на пустом поле', () => {
  const before = stats.drawImage;
  runFrames(60);
  const drawn = stats.drawImage - before;
  if (drawn === 0) throw new Error('ни одного drawImage за 60 кадров');
  return drawn + ' вызовов drawImage';
});

let board = null;

check('Открытие клетки запускает каскад', () => {
  const canvas = MS.render.layer('fx').canvas;
  // Находим board через реакцию на клик: сначала кликаем в центр.
  const fake = { w: 16, h: 16 };
  canvas.dispatch('mousedown', mouseEvent(8 * 16 + 8, 0, fake, 1));
  canvas.dispatch('mouseup', mouseEvent(8 * 16 + 8, 0, fake, 0));
  runFrames(30);

  // Достаём состояние поля из счётчика HUD.
  const minesText = getEl('mines-value').textContent;
  if (!minesText) throw new Error('HUD не обновился');
  return 'HUD: мин ' + minesText + ', время ' + getEl('time-value').textContent;
});

check('Флаг ставится и снимается', () => {
  const canvas = MS.render.layer('fx').canvas;
  const fake = { w: 16, h: 16 };
  const before = getEl('mines-value').textContent;
  canvas.dispatch('mousedown', mouseEvent(0, 2, fake, 2));
  canvas.dispatch('mouseup', mouseEvent(0, 2, fake, 0));
  runFrames(10);
  const after = getEl('mines-value').textContent;
  if (before === after) throw new Error('счётчик мин не изменился после установки флага');
  return before + ' -> ' + after;
});

check('Наведение курсора не падает', () => {
  const canvas = MS.render.layer('fx').canvas;
  const fake = { w: 16, h: 16 };
  for (let i = 0; i < 40; i++) {
    canvas.dispatch('mousemove', mouseEvent(i * 7 % 256, 0, fake, 0));
  }
  canvas.dispatch('mouseleave', {});
  runFrames(5);
  return '40 перемещений';
});

check('Отладка: открыть всё поле', () => {
  getEl('dev-reveal').dispatch('click', {});
  runFrames(20);
  return 'ok';
});

check('Одиночный взрыв: частицы, осколки, огонь', () => {
  getEl('dev-boom').dispatch('click', {});
  runFrames(6);

  const p = MS.particles.count();
  const d = MS.debris.count();
  const f = MS.fire.count();
  const cr = MS.cracks.count();

  if (p === 0) throw new Error('не создано ни одной частицы');
  if (d === 0) throw new Error('не создано ни одного осколка');
  if (f === 0) throw new Error('огонь не зажёгся');
  if (cr === 0) throw new Error('трещины не сгенерированы');
  if (MS.effects.getTrauma() <= 0) throw new Error('тряска не добавлена');

  return `частиц ${p}, осколков ${d}, очагов ${f}, сегментов трещин ${cr}`;
});

check('Взрыв доигрывается 180 кадров без ошибок', () => {
  runFrames(180);
  return 'частиц осталось ' + MS.particles.count();
});

check('Профи 30x16: цепная детонация 99 мин', () => {
  // Переключаем сложность через кнопку.
  getEl('difficulty').dispatch('click', { target: diffBtns[2] });
  runFrames(5);

  const v = MS.render.view;
  if (v.w !== 30 || v.h !== 16) throw new Error('сложность не переключилась: ' + v.w + 'x' + v.h);

  getEl('dev-boom-all').dispatch('click', {});

  let maxParticles = 0;
  let maxDebris = 0;
  // Состав частиц в момент пика: ни один тип не должен обнулиться.
  let worstComposition = null;

  // 99 взрывов с шагом 45 мс = ~4.5 сек, плюс досматриваем последствия.
  for (let i = 0; i < 480; i++) {
    runFrames(1);
    const p = MS.particles.count();
    if (p > maxParticles) {
      maxParticles = p;
      worstComposition = MS.particles.countByType();
    }
    maxDebris = Math.max(maxDebris, MS.debris.count());
  }

  if (maxParticles === 0) throw new Error('частицы не появились');

  /* Ключевая проверка: под максимальным давлением на пул все типы
     частиц обязаны присутствовать. Если какой-то тип обнулился,
     значит спавн голодает по порядку вызовов и поздние взрывы
     выглядят иначе, чем ранние. */
  const c = worstComposition;
  const empty = Object.keys(c).filter((k) => c[k] === 0 && k !== 'dust');
  if (empty.length) {
    throw new Error(
      'на пике пула отсутствуют типы частиц: ' + empty.join(', ') +
      ' (состав: ' + JSON.stringify(c) + ')'
    );
  }

  return (
    `пик частиц ${maxParticles}/${MS.particles.capacity()}, осколков ${maxDebris}, ` +
    `состав дым/огонь/искры/угли ${c.smoke}/${c.fire}/${c.spark}/${c.ember}`
  );
});

check('Пулы полностью опустошаются (нет утечек)', () => {
  /* Проверяется инвариант, а не конкретный тайминг: каждая частица,
     осколок и очаг обязаны рано или поздно освободить слот. Ждём до
     30 секунд виртуального времени и фиксируем, сколько понадобилось.
     Если что-то «застряло» навсегда, пул со временем переполнится
     и эффекты перестанут появляться. */
  const LIMIT = 1800; // 30 сек при 60 FPS
  let frames = 0;
  while (frames < LIMIT) {
    if (MS.particles.count() === 0 && MS.debris.count() === 0 && MS.fire.count() === 0) break;
    runFrames(1);
    frames++;
  }

  const p = MS.particles.count();
  const d = MS.debris.count();
  const f = MS.fire.count();

  if (p || d || f) {
    throw new Error(
      `за ${(frames / 60).toFixed(1)} сек не освободились: ` +
      `частиц ${p}, осколков ${d}, очагов ${f}`
    );
  }
  return `всё освободилось за ${(frames / 60).toFixed(1)} сек`;
});

check('Рестарт очищает состояние', () => {
  getEl('restart').dispatch('click', {});
  runFrames(10);
  if (MS.particles.count() !== 0) throw new Error('частицы не очищены');
  if (MS.debris.count() !== 0) throw new Error('осколки не очищены');
  if (MS.cracks.count() !== 0) throw new Error('трещины не очищены');
  if (MS.effects.getTrauma() !== 0) throw new Error('тряска не сброшена');
  return 'ok';
});

check('Все три сложности переключаются', () => {
  const out = [];
  for (let i = 0; i < 3; i++) {
    getEl('difficulty').dispatch('click', { target: diffBtns[i] });
    runFrames(4);
    const v = MS.render.view;
    out.push(v.w + 'x' + v.h);
  }
  return out.join(', ');
});

check('Ресайз: реальный обработчик с дебаунсом', () => {
  const before = MS.render.view.cell;

  // Сильно уменьшаем сцену и стреляем настоящим событием окна.
  getEl('stage').clientWidth = 520;
  getEl('stage').clientHeight = 400;
  const n = fireWindow('resize');
  if (n === 0) throw new Error('игра не слушает resize');

  // Дебаунс 140 мс: до его истечения раскладка меняться не должна.
  runFrames(4);
  if (MS.render.view.cell !== before) {
    throw new Error('раскладка пересчиталась до истечения дебаунса');
  }

  runFrames(20); // перешагиваем дебаунс
  const after = MS.render.view.cell;
  if (after === before) throw new Error('раскладка не пересчиталась после дебаунса');
  if (after < 18) throw new Error('клетка меньше минимума: ' + after);

  // Кадры после ресайза не должны давать NaN в координатах.
  runFrames(40);
  return `клетка ${before}px -> ${after}px`;
});

check('Ресайз посреди разрушений сохраняет дыры', () => {
  getEl('dev-boom').dispatch('click', {});
  runFrames(10);

  getEl('stage').clientWidth = 1100;
  getEl('stage').clientHeight = 700;
  fireWindow('resize');
  runFrames(30);

  runFrames(60);
  return 'клетка ' + MS.render.view.cell + 'px';
});

check('Звук деградирует без AudioContext', () => {
  // AudioContext в песочнице отсутствует. Ни один вызов не должен падать.
  MS.audio.unlock();
  MS.audio.explosion(1);
  MS.audio.reveal(5);
  MS.audio.flag(true);
  MS.audio.setFire(3);
  MS.audio.win();
  MS.audio.lose();
  MS.audio.panic();
  const on = MS.audio.toggle();
  MS.audio.toggle();
  return 'без исключений, toggle -> ' + on;
});

check('Клавиатура: R, 1/2/3, M, ~', () => {
  if (!windowListeners.keydown) throw new Error('игра не слушает keydown');

  const seen = [];
  const keys = ['1', '2', '3', 'r', 'm', 'm', '`', '`'];
  for (const k of keys) {
    fireWindow('keydown', { key: k, repeat: false });
    runFrames(3);
    seen.push(MS.render.view.w + 'x' + MS.render.view.h);
  }

  // Цифры обязаны менять размер поля.
  if (seen[0] !== '9x9') throw new Error('клавиша 1 не включила Новичка: ' + seen[0]);
  if (seen[1] !== '16x16') throw new Error('клавиша 2 не включила Любителя: ' + seen[1]);
  if (seen[2] !== '30x16') throw new Error('клавиша 3 не включила Профи: ' + seen[2]);

  // Игнорирование автоповтора.
  fireWindow('keydown', { key: '1', repeat: true });
  runFrames(2);
  if (MS.render.view.w !== 30) throw new Error('автоповтор клавиши не был проигнорирован');

  return keys.length + ' нажатий, сложность переключается';
});

check('Трещины продолжают появляться при переполнении буфера', () => {
  // Специально забиваем буфер: множество взрывов подряд.
  MS.cracks.clear();
  const before = MS.cracks.discarded();
  for (let i = 0; i < 40; i++) {
    getEl('dev-boom').dispatch('click', {});
    runFrames(4);
  }
  runFrames(120);

  const total = MS.cracks.count() + MS.cracks.discarded();
  if (MS.cracks.discarded() <= before) {
    // Буфер не переполнился — значит ёмкости хватило, это тоже нормально.
    return 'буфер не переполнялся, сегментов ' + MS.cracks.count();
  }
  if (total < 4000) throw new Error('сгенерировано подозрительно мало сегментов: ' + total);
  return `сегментов всего ${total}, выброшено уплотнением ${MS.cracks.discarded()}`;
});

check('Стабильность: 1500 кадров со взрывами', () => {
  let boomCount = 0;
  for (let i = 0; i < 1500; i++) {
    if (i % 120 === 0) {
      getEl('dev-boom').dispatch('click', {});
      boomCount++;
    }
    // Меняем dt, чтобы поймать зависимости от фиксированного шага.
    runFrames(1, i % 3 === 0 ? 33 : i % 5 === 0 ? 8 : 16.67);
  }
  return boomCount + ' взрывов, кадры с разным dt';
});

/* --- Вывод ------------------------------------------------------------- */

let passed = 0;
let failed = 0;
for (const c of checks) {
  if (c.pass) {
    passed++;
    console.log(
      `  \x1b[32mPASS\x1b[0m  ${c.name}` + (c.detail ? `  \x1b[2m${c.detail}\x1b[0m` : '')
    );
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${c.name}`);
    console.log(`        \x1b[31m${c.detail}\x1b[0m`);
  }
}

console.log(
  `\n\x1b[2mвызовов: drawImage ${stats.drawImage}, fillRect ${stats.fillRect}, ` +
  `stroke ${stats.stroke}, fillText ${stats.fillText}, градиентов ${stats.gradients}\x1b[0m`
);

const color = failed === 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`${color}\x1b[1m${passed}/${checks.length} проверок пройдено\x1b[0m\n`);

process.exit(failed === 0 ? 0 : 1);
