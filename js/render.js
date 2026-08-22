/* ===========================================================================
 * render.js — слои, процедурные текстуры, отрисовка поля, bloom.
 *
 * Все системы рисуют в CSS-пикселях: масштаб под devicePixelRatio
 * задаётся один раз через setTransform на каждом слое. Это избавляет
 * остальной код от необходимости знать про DPR.
 *
 * Ключевые решения по производительности:
 *   - Слой bg перерисовывается только по dirty-флагу.
 *   - Слой damage не чистится никогда: накопленные разрушения бесплатны.
 *   - Текстура шума генерируется один раз в небольшой тайл и тиражируется
 *     паттерном. Попиксельный fBm на весь холст занял бы больше секунды.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;
  var CELL = MS.CELL;

  var R = (MS.render = {});

  /* --- Состояние ------------------------------------------------------- */

  var layers = {}; // bg, damage, main, fx -> {canvas, ctx}
  var fieldEl = null;

  var view = (R.view = {
    w: 0, // клеток по горизонтали
    h: 0,
    cell: 30, // CSS-пиксели на клетку
    cssW: 0,
    cssH: 0,
    dpr: 1,
  });

  var bgDirty = true;

  /*
   * Текстуры плиток. Хранятся вариантами: одна текстура на всё поле
   * превращает его в очевидно повторяющийся паттерн, что для «грязного
   * бетона» выглядит фальшиво. Четыре варианта со сдвинутым зерном
   * убирают это почти полностью и стоят четыре мелких канваса.
   */
  var TEX_VARIANTS = 4;
  var texHidden = null; // массив: закрытые плитки
  var texHiddenLit = null; // они же под курсором
  var texOpen = null; // открытые клетки
  var texCharred = null; // подпалённый вариант для осколков
  var noisePattern = null;

  /* Буферы для пост-обработки. */
  var lightBuf = null;
  var bloomA = null;
  var bloomB = null;
  var snapshot = null;
  var aberrBuf = null;

  /* --- Визуальное состояние плиток -------------------------------------- */

  /*
   * Отделено от логики: board знает только «открыта / закрыта», а рендер
   * держит момент появления, пружину подброса и подпалину. Так анимация
   * не протекает в правила игры.
   */
  var revealAt = null; // абсолютное время, когда плитка должна проявиться
  var revealDepth = null; // глубина в каскаде — задаёт питч звука
  var popped = null; // 1 = анимация появления уже началась
  var knockY = null; // смещение от удара, px
  var knockV = null; // скорость пружины
  var scorchLevel = null; // 0..1 закопчённость клетки
  var flagT = null; // 0..1 анимация установки флага

  var hoverIdx = -1;
  var clock = 0;

  /** Длительность «выскакивания» плитки при открытии. */
  var POP_DUR = 0.19;

  /* --- Палитра --------------------------------------------------------- */

  /*
   * Цвета цифр приглушены под грязный реализм: на бетоне это выглядит как
   * трафаретная краска, а не как неоновая подсветка. Читаемость при этом
   * сохранена — каждая цифра различима по тону, а не только по яркости.
   */
  var NUM_COLORS = [
    null,
    '#6f9bc4', // 1 — сталь
    '#8aa860', // 2 — олива
    '#c9705a', // 3 — кирпич
    '#8d84c4', // 4 — сизый
    '#b8704a', // 5 — ржавчина
    '#5fa89c', // 6 — патина
    '#cfc7ba', // 7 — кость
    '#8e8577', // 8 — пепел
  ];

  /* --- Инициализация ---------------------------------------------------- */

  R.init = function (field, ids) {
    fieldEl = field;
    for (var name in ids) {
      var c = document.getElementById(ids[name]);
      layers[name] = { canvas: c, ctx: c.getContext('2d') };
    }
    buildNoiseTile();
  };

  R.layer = function (name) {
    return layers[name];
  };

  R.ctx = function (name) {
    return layers[name].ctx;
  };

  R.tileTexture = function () {
    return texHidden[0];
  };

  R.tileTextureCharred = function () {
    return texCharred;
  };

  /**
   * Детерминированный выбор варианта текстуры по индексу клетки.
   * Хеш, а не idx % N: остаток по модулю дал бы регулярные диагонали,
   * которые глаз считывает не хуже прямого повтора.
   */
  function variantOf(idx) {
    var h = (idx * 374761393) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) % TEX_VARIANTS;
  }

  /* --- Раскладка -------------------------------------------------------- */

  /**
   * Подбирает размер клетки под доступное место и настраивает все слои.
   *
   * @param {object} board
   * @param {number} availW доступная ширина в CSS-пикселях
   * @param {number} availH доступная высота
   */
  R.layout = function (board, availW, availH) {
    view.w = board.w;
    view.h = board.h;

    /* Клетка меньше 18px делает цифры нечитаемыми, больше 46px —
       поле выглядит игрушечным. Внутри этих границ подбираем максимум,
       который влезает. */
    var byW = Math.floor(availW / board.w);
    var byH = Math.floor(availH / board.h);
    view.cell = U.clamp(Math.min(byW, byH), 18, 46);

    view.cssW = view.cell * board.w;
    view.cssH = view.cell * board.h;

    // DPR выше 2 не даёт заметного выигрыша, но кратно дорожает по пикселям.
    view.dpr = Math.min(root.devicePixelRatio || 1, 2);

    var pw = Math.round(view.cssW * view.dpr);
    var ph = Math.round(view.cssH * view.dpr);

    fieldEl.style.width = view.cssW + 'px';
    fieldEl.style.height = view.cssH + 'px';

    for (var name in layers) {
      var L = layers[name];
      L.canvas.width = pw;
      L.canvas.height = ph;
      L.canvas.style.width = view.cssW + 'px';
      L.canvas.style.height = view.cssH + 'px';
      // После смены размера трансформ сбрасывается — ставим заново.
      L.ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }

    buildTileTextures();
    buildBuffers(pw, ph);
    allocTileState(board.size);

    MS.debris.setFloor(view.cssH - view.cell * 0.15);
    bgDirty = true;
  };

  /**
   * Выделяет массивы визуального состояния плиток.
   *
   * Условие «только растём»: массивы никогда не сжимаются под меньшее поле.
   * Если бы они сжимались, любой порядок вызовов, при котором раскладка
   * пересчитана раньше сброса, приводил бы к чтению за границей —
   * а это не исключение, а тихий NaN, который дальше расползается
   * по координатам отрисовки.
   */
  function allocTileState(size) {
    if (revealAt && revealAt.length >= size) return;
    revealAt = new Float32Array(size);
    revealDepth = new Int32Array(size);
    popped = new Uint8Array(size);
    knockY = new Float32Array(size);
    knockV = new Float32Array(size);
    scorchLevel = new Float32Array(size);
    flagT = new Float32Array(size);
  }

  function buildBuffers(pw, ph) {
    lightBuf = makeCanvas(pw, ph);
    lightBuf.ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    // Bloom считается на 1/4 разрешения: размытие всё равно съедает детали,
    // а пикселей в 16 раз меньше.
    var bw = Math.max(1, Math.round(pw / 4));
    var bh = Math.max(1, Math.round(ph / 4));
    bloomA = makeCanvas(bw, bh);
    bloomB = makeCanvas(Math.max(1, bw >> 1), Math.max(1, bh >> 1));

    snapshot = makeCanvas(pw, ph);
    aberrBuf = makeCanvas(pw, ph);
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var o = { canvas: c, ctx: c.getContext('2d') };
    return o;
  }

  /* --- Процедурные текстуры -------------------------------------------- */

  /**
   * Тайл зерна. Генерируется попиксельно один раз в 128x128 и затем
   * тиражируется как паттерн — на весь холст попиксельный fBm стоил бы
   * секунды загрузки при нулевой разнице в результате.
   */
  function buildNoiseTile() {
    var S = 128;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');
    var img = g.createImageData(S, S);
    var d = img.data;

    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        /* Два масштаба шума: крупный даёт разводы и пятна цемента,
           мелкий — песчаное зерно. Один масштаб выглядит как ткань. */
        var coarse = U.fbm2(x * 0.035, y * 0.035, 3, 2.1, 0.55);
        var fine = U.noise2(x * 0.55, y * 0.55);
        var v = coarse * 0.62 + fine * 0.38;

        var i = (y * S + x) * 4;
        // Пишем в альфу: паттерн будет накладываться поверх базового цвета.
        var lum = v > 0 ? 255 : 0;
        d[i] = lum;
        d[i + 1] = lum;
        d[i + 2] = lum;
        d[i + 3] = Math.abs(v) * 46;
      }
    }

    g.putImageData(img, 0, 0);
    noisePattern = c;
  }

  /**
   * Рисует зерно поверх прямоугольника.
   *
   * @param {number} scale  во сколько раз увеличить зерно
   * @param {number} ox,oy  сдвиг паттерна — даёт разные варианты текстуры
   */
  function overlayGrain(ctx, x, y, w, h, alpha, scale, ox, oy) {
    var pat = ctx.createPattern(noisePattern, 'repeat');
    if (!pat) return;
    var s = scale || 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.translate(-(ox || 0), -(oy || 0));
    ctx.fillStyle = pat;
    ctx.fillRect(ox || 0, oy || 0, w / s, h / s);
    ctx.restore();
  }

  /** Текстуры плиток в разрешении устройства — чтобы не мылились. */
  function buildTileTextures() {
    var S = Math.max(8, Math.ceil(view.cell * view.dpr));
    texHidden = [];
    texHiddenLit = [];
    texOpen = [];

    for (var v = 0; v < TEX_VARIANTS; v++) {
      // Сдвиг по паттерну шума: каждый вариант берёт свой участок зерна.
      var ox = v * 37.5;
      var oy = v * 61.25;
      texHidden.push(renderHiddenTile(S, false, ox, oy));
      texHiddenLit.push(renderHiddenTile(S, true, ox, oy));
      texOpen.push(renderOpenTile(S, ox, oy));
    }

    texCharred = renderCharredTile(S);
    MS.particles.flushCache();
  }

  /**
   * Закрытая плитка: выпуклая бетонная пробка с фаской.
   * Свет условно падает сверху-слева, поэтому светлая фаска сверху,
   * тёмная снизу. Без этого поле выглядит как плоская таблица.
   */
  function renderHiddenTile(S, lit, ox, oy) {
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');

    var base = lit ? '#4e4942' : '#413c36';
    var top = lit ? '#5d574e' : '#4d473f';
    var bot = lit ? '#332f2a' : '#2a2723';

    var grad = g.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, top);
    grad.addColorStop(0.55, base);
    grad.addColorStop(1, bot);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);

    overlayGrain(g, 0, 0, S, S, lit ? 0.5 : 0.62, 1.1, ox, oy);

    var bev = Math.max(1, Math.round(S * 0.085));

    // Светлая фаска сверху и слева.
    g.fillStyle = lit ? 'rgba(196,182,160,0.30)' : 'rgba(168,156,138,0.20)';
    g.fillRect(0, 0, S, bev);
    g.fillRect(0, 0, bev, S);

    // Тёмная фаска снизу и справа.
    g.fillStyle = 'rgba(8,7,6,0.44)';
    g.fillRect(0, S - bev, S, bev);
    g.fillRect(S - bev, 0, bev, S);

    // Внешний контур: отделяет плитки друг от друга.
    g.strokeStyle = 'rgba(6,5,4,0.75)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);

    return c;
  }

  /**
   * Открытая клетка: углубление. Тени инвертированы относительно
   * закрытой плитки, поэтому открытая область читается как «вдавленная».
   */
  function renderOpenTile(S, ox, oy) {
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');

    var grad = g.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, '#1c1a17');
    grad.addColorStop(0.5, '#232019');
    grad.addColorStop(1, '#282419');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);

    overlayGrain(g, 0, 0, S, S, 0.4, 1.1, ox, oy);

    var bev = Math.max(1, Math.round(S * 0.07));
    // Тень сверху — от нависающего края лунки.
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 0, S, bev);
    g.fillRect(0, 0, bev, S);
    // Слабый отблеск снизу.
    g.fillStyle = 'rgba(120,110,96,0.10)';
    g.fillRect(0, S - bev, S, bev);

    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);

    return c;
  }

  /** Подпалённая плитка — источник текстуры для обломков у эпицентра. */
  function renderCharredTile(S) {
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');
    g.drawImage(texHidden[0], 0, 0);

    // Копоть неравномерна: пятна, а не ровный слой.
    var r = U.makeRng(0x5c07c4);
    g.globalCompositeOperation = 'source-over';
    for (var i = 0; i < 7; i++) {
      var x = r.next() * S;
      var y = r.next() * S;
      var rad = r.range(S * 0.15, S * 0.5);
      var grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, 'rgba(12,10,9,0.75)');
      grad.addColorStop(1, 'rgba(12,10,9,0)');
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    return c;
  }

  /* --- Фон -------------------------------------------------------------- */

  R.markBgDirty = function () {
    bgDirty = true;
  };

  /**
   * Фон — бетонная плита под плитками. Виден только там, где плитки
   * уничтожены, поэтому рисуется один раз и лежит без изменений.
   */
  R.drawBackground = function () {
    if (!bgDirty) return;
    var ctx = layers.bg.ctx;
    var W = view.cssW;
    var H = view.cssH;

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Базовая заливка с лёгким вертикальным перепадом освещения.
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#151310');
    grad.addColorStop(1, '#0d0b09');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    overlayGrain(ctx, 0, 0, W, H, 0.55, 3);

    /* Крупные пятна сырости и цементных разводов. Детерминированный RNG:
       при перерисовке фона рисунок не должен меняться. */
    var r = U.makeRng(0xb17ec0);
    for (var i = 0; i < 22; i++) {
      var x = r.next() * W;
      var y = r.next() * H;
      var rad = r.range(W * 0.04, W * 0.2);
      var g2 = ctx.createRadialGradient(x, y, 0, x, y, rad);
      var dark = r.bool(0.6);
      g2.addColorStop(0, dark ? 'rgba(0,0,0,0.30)' : 'rgba(90,82,70,0.10)');
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }

    // Затемнение по краям: поле «утоплено» в рамку.
    var edge = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, W, H);

    bgDirty = false;
  };

  /* --- Слой разрушений -------------------------------------------------- */

  /**
   * Слой damage накапливает необратимые следы. Он никогда не чистится,
   * поэтому сотня подпалин стоит столько же, сколько одна: ноль.
   */
  R.clearDamage = function () {
    var ctx = layers.damage.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layers.damage.canvas.width, layers.damage.canvas.height);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  };

  /**
   * Пятно копоти. Края рваные: рисуется несколько смещённых градиентов
   * вместо одного ровного круга, иначе подпалина выглядит как аккуратная
   * наклейка.
   */
  R.scorch = function (x, y, radius, strength) {
    var ctx = layers.damage.ctx;
    var r = U.rng;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    var blobs = 5;
    for (var i = 0; i < blobs; i++) {
      var ox = x + r.spread(radius * 0.35);
      var oy = y + r.spread(radius * 0.35);
      var rad = radius * r.range(0.5, 1.05);
      var g = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
      var a = strength * r.range(0.3, 0.6);
      g.addColorStop(0, 'rgba(10,8,7,' + a.toFixed(3) + ')');
      g.addColorStop(0.55, 'rgba(14,11,9,' + (a * 0.5).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(16,12,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(ox - rad, oy - rad, rad * 2, rad * 2);
    }

    /* Опалённое кольцо по краю: ржаво-оранжевый ободок вокруг черноты.
       Мелочь, которая сильно добавляет достоверности. */
    ctx.globalCompositeOperation = 'lighter';
    var ring = ctx.createRadialGradient(x, y, radius * 0.45, x, y, radius * 1.05);
    ring.addColorStop(0, 'rgba(0,0,0,0)');
    ring.addColorStop(0.6, 'rgba(96,42,14,' + (strength * 0.22).toFixed(3) + ')');
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ring;
    ctx.fillRect(x - radius * 1.1, y - radius * 1.1, radius * 2.2, radius * 2.2);

    ctx.restore();
  };

  /**
   * Выбивает плитку: на слое damage появляется тёмная лунка с рваным
   * краем. Сама плитка после этого перестаёт рисоваться на main, и
   * сквозь дыру видно бетонное основание.
   */
  R.punchHole = function (cellIdx) {
    var ctx = layers.damage.ctx;
    var cell = view.cell;
    var x = (cellIdx % view.w) * cell;
    var y = ((cellIdx / view.w) | 0) * cell;
    var r = U.rng;

    ctx.save();

    // Тень внутри лунки — глубина.
    var g = ctx.createRadialGradient(
      x + cell / 2, y + cell / 2, cell * 0.1,
      x + cell / 2, y + cell / 2, cell * 0.72
    );
    g.addColorStop(0, 'rgba(0,0,0,0.88)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = g;
    ctx.fillRect(x - cell * 0.25, y - cell * 0.25, cell * 1.5, cell * 1.5);

    /* Рваный контур пробоины: многоугольник со случайным радиусом.
       Ровная окружность читалась бы как отверстие под болт. */
    ctx.beginPath();
    var pts = 11;
    for (var i = 0; i < pts; i++) {
      var a = (i / pts) * U.TAU;
      var rad = cell * r.range(0.3, 0.52);
      var px = x + cell / 2 + Math.cos(a) * rad;
      var py = y + cell / 2 + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(4,3,3,0.92)';
    ctx.fill();

    // Обнажённая арматура по кромке — светлые сколы бетона.
    ctx.strokeStyle = 'rgba(120,108,92,0.28)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  };

  /* --- Управление состоянием плиток ------------------------------------- */

  /**
   * Ставит плитке время появления. Задержка берётся из глубины каскада,
   * поэтому открытие расходится волной от курсора, а не вспыхивает целиком.
   *
   * @param {number} depth глубина в каскаде — сохраняется для питча звука
   */
  R.scheduleReveal = function (cellIdx, delay, depth) {
    // Уже запланированную плитку не переносим: иначе chord, задевающий
    // одну область дважды, сбивал бы волну.
    if (popped[cellIdx]) return;
    var at = clock + delay;
    if (revealAt[cellIdx] > 0 && revealAt[cellIdx] <= at) return;
    revealAt[cellIdx] = at;
    revealDepth[cellIdx] = depth || 0;
  };

  /** Немедленное появление — для открытия поля в отладке. */
  R.revealNow = function (cellIdx) {
    revealAt[cellIdx] = clock;
    revealDepth[cellIdx] = 0;
  };

  R.setHover = function (idx) {
    hoverIdx = idx;
  };

  R.getHover = function () {
    return hoverIdx;
  };

  /** Импульс подброса плитки от взрыва — пружина вернёт её на место. */
  R.knock = function (cellIdx, strength) {
    knockV[cellIdx] -= strength;
  };

  R.addScorch = function (cellIdx, amount) {
    scorchLevel[cellIdx] = U.clamp01(scorchLevel[cellIdx] + amount);
  };

  R.flagPlanted = function (cellIdx) {
    flagT[cellIdx] = 0;
  };

  R.resetTiles = function (size) {
    allocTileState(size);
    for (var i = 0; i < size; i++) {
      revealAt[i] = 0;
      popped[i] = 0;
      knockY[i] = 0;
      knockV[i] = 0;
      scorchLevel[i] = 0;
      flagT[i] = 0;
    }
    hoverIdx = -1;
  };

  /* --- Обновление визуального состояния --------------------------------- */

  /**
   * @param {number} dt масштабированное время
   * @param {object} board
   * @param {function} onAppear колбэк(idx, x, y, depth) в момент проявления
   *        плитки — игра вешает на него пыль и звук
   */
  R.update = function (dt, board, onAppear) {
    clock += dt;

    var cell = view.cell;
    var size = board.size;

    for (var i = 0; i < size; i++) {
      /* Пружина подброса. Жёсткость и демпфирование подобраны так,
         чтобы плитка успевала вернуться примерно за 0.4 сек —
         дольше выглядит как желе, короче не читается. */
      if (knockV[i] !== 0 || knockY[i] !== 0) {
        knockV[i] += -knockY[i] * 320 * dt;
        knockV[i] *= Math.exp(-7 * dt);
        knockY[i] += knockV[i] * dt;
        if (Math.abs(knockY[i]) < 0.05 && Math.abs(knockV[i]) < 0.5) {
          knockY[i] = 0;
          knockV[i] = 0;
        }
      }

      if (flagT[i] < 1 && board.state[i] === CELL.FLAGGED) {
        flagT[i] = Math.min(1, flagT[i] + dt / 0.16);
      }

      // Момент, когда волна открытия доходит до плитки.
      if (
        !popped[i] &&
        board.state[i] === CELL.REVEALED &&
        revealAt[i] > 0 &&
        clock >= revealAt[i]
      ) {
        popped[i] = 1;
        if (onAppear) {
          onAppear(
            i,
            (i % view.w) * cell + cell / 2,
            ((i / view.w) | 0) * cell + cell / 2,
            revealDepth[i]
          );
        }
      }
    }
  };

  /* --- Отрисовка поля --------------------------------------------------- */

  /**
   * Основной слой: плитки, цифры, флаги, мины.
   *
   * @param {object} board
   * @param {boolean} showMines показывать ли мины (после проигрыша)
   */
  R.drawField = function (board, showMines) {
    var ctx = layers.main.ctx;
    var cell = view.cell;

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.cssW, view.cssH);
    ctx.imageSmoothingEnabled = true;

    var w = view.w;
    var size = board.size;

    for (var i = 0; i < size; i++) {
      // Уничтоженная плитка не рисуется: на её месте дыра в слое damage.
      if (board.destroyed[i]) continue;

      var x = (i % w) * cell;
      var y = ((i / w) | 0) * cell;
      var st = board.state[i];

      var appeared = popped[i];
      var isOpen = st === CELL.REVEALED && appeared;

      if (isOpen) {
        drawOpenCell(ctx, board, i, x, y, cell, showMines);
      } else {
        drawClosedCell(ctx, board, i, x, y, cell, st, showMines);
      }
    }
  };

  /** Открытая клетка: лунка, цифра, копоть. */
  function drawOpenCell(ctx, board, i, x, y, cell, showMines) {
    // Анимация появления: плитка проваливается внутрь и слегка
    // «доседает» — обратная пружина через outBack.
    var t = U.clamp01((clock - revealAt[i]) / POP_DUR);
    var ky = knockY[i];

    ctx.drawImage(texOpen[variantOf(i)], x, y + ky, cell, cell);

    if (board.mine[i] && showMines) {
      drawMine(ctx, x + cell / 2, y + cell / 2 + ky, cell, false);
    } else {
      var n = board.adj[i];
      if (n > 0) {
        /* Цифра выезжает вместе с плиткой: сначала крупнее и прозрачнее,
           затем садится в размер. Мгновенное появление цифры на фоне
           анимированной плитки выглядит рассинхроном. */
        var scale = t < 1 ? U.lerp(1.5, 1, U.ease.outBack(t, 2.2)) : 1;
        var alpha = t < 1 ? U.ease.outQuad(t) : 1;
        drawNumber(ctx, n, x + cell / 2, y + cell / 2 + ky, cell, scale, alpha);
      }
    }

    // Копоть поверх содержимого клетки.
    if (scorchLevel[i] > 0.01) {
      ctx.save();
      ctx.globalAlpha = scorchLevel[i] * 0.72;
      ctx.fillStyle = '#0a0807';
      ctx.fillRect(x, y + ky, cell, cell);
      ctx.restore();
    }
  }

  /** Закрытая плитка: пробка, флаг, вопрос, мина после проигрыша. */
  function drawClosedCell(ctx, board, i, x, y, cell, st, showMines) {
    var ky = knockY[i];
    var hovered = i === hoverIdx && st !== CELL.REVEALED;

    // Плитка под курсором чуть приподнята и подсвечена.
    var lift = hovered ? -1.5 : 0;
    var v = variantOf(i);
    ctx.drawImage(hovered ? texHiddenLit[v] : texHidden[v], x, y + ky + lift, cell, cell);

    if (scorchLevel[i] > 0.01) {
      ctx.save();
      ctx.globalAlpha = scorchLevel[i] * 0.6;
      ctx.fillStyle = '#0a0807';
      ctx.fillRect(x, y + ky + lift, cell, cell);
      ctx.restore();
    }

    var cx = x + cell / 2;
    var cy = y + cell / 2 + ky + lift;

    if (st === CELL.FLAGGED) {
      // Ошибочный флаг после проигрыша перечёркивается.
      var wrong = showMines && !board.mine[i];
      drawFlag(ctx, cx, cy, cell, flagT[i], wrong);
    } else if (st === CELL.QUESTION) {
      drawQuestion(ctx, cx, cy, cell);
    } else if (showMines && board.mine[i]) {
      // Непомеченные мины после проигрыша: приглушённые, ещё не взорванные.
      drawMine(ctx, cx, cy, cell, true);
    }
  }

  /* --- Элементы --------------------------------------------------------- */

  function drawNumber(ctx, n, cx, cy, cell, scale, alpha) {
    var size = cell * 0.6 * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold ' + size.toFixed(1) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Обводка: цифра читается на любой копоти и любом фоне.
    ctx.lineWidth = Math.max(1.5, cell * 0.075);
    ctx.strokeStyle = 'rgba(4,3,3,0.9)';
    ctx.strokeText(n, cx, cy + cell * 0.02);

    ctx.fillStyle = NUM_COLORS[n];
    ctx.fillText(n, cx, cy + cell * 0.02);
    ctx.restore();
  }

  var FONT = '"Consolas","Cascadia Mono",ui-monospace,monospace';

  /**
   * Мина: тёмная сфера с блеском и шипами.
   * @param {boolean} dormant приглушённая — ещё не взорвалась
   */
  function drawMine(ctx, cx, cy, cell, dormant) {
    var r = cell * 0.27;
    ctx.save();
    if (dormant) ctx.globalAlpha = 0.55;

    // Шипы.
    ctx.strokeStyle = dormant ? '#3a342c' : '#14100d';
    ctx.lineWidth = Math.max(1.2, cell * 0.055);
    ctx.lineCap = 'round';
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * U.TAU + Math.PI / 8;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72);
      ctx.lineTo(cx + Math.cos(a) * r * 1.42, cy + Math.sin(a) * r * 1.42);
      ctx.stroke();
    }

    // Корпус со смещённым блеском — читается как металлический шар.
    var g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    if (dormant) {
      g.addColorStop(0, '#4a443a');
      g.addColorStop(0.6, '#2a2620');
      g.addColorStop(1, '#141110');
    } else {
      g.addColorStop(0, '#5c5448');
      g.addColorStop(0.55, '#241f1a');
      g.addColorStop(1, '#0b0908');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, U.TAU);
    ctx.fill();

    // Точечный блик.
    ctx.fillStyle = dormant ? 'rgba(190,180,160,0.25)' : 'rgba(220,210,190,0.5)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.34, cy - r * 0.38, r * 0.2, 0, U.TAU);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Флаг: воткнутое в бетон полотнище на штыре.
   * @param {number} t 0..1 анимация установки
   * @param {boolean} wrong перечёркнуть — флаг стоял не на мине
   */
  function drawFlag(ctx, cx, cy, cell, t, wrong) {
    // Флаг втыкается сверху с перелётом — жест «вбил колышек».
    var p = U.ease.outBack(U.clamp01(t), 3);
    var drop = (1 - p) * cell * 0.5;

    ctx.save();
    ctx.globalAlpha = U.clamp01(t * 2);
    ctx.translate(cx, cy + drop);

    var h = cell * 0.34;
    var poleX = -cell * 0.06;

    // Штырь.
    ctx.strokeStyle = '#6b6358';
    ctx.lineWidth = Math.max(1.3, cell * 0.055);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(poleX, -h);
    ctx.lineTo(poleX, h * 0.78);
    ctx.stroke();

    // Основание — комок бетона у штыря.
    ctx.fillStyle = 'rgba(30,27,23,0.8)';
    ctx.beginPath();
    ctx.ellipse(poleX, h * 0.78, cell * 0.14, cell * 0.05, 0, 0, U.TAU);
    ctx.fill();

    // Полотнище: выцветшая красная тряпка, не яркий кумач.
    var fw = cell * 0.3;
    var fh = cell * 0.24;
    var g = ctx.createLinearGradient(poleX, -h, poleX + fw, -h + fh);
    g.addColorStop(0, wrong ? '#6b6b6b' : '#a83c28');
    g.addColorStop(1, wrong ? '#3f3f3f' : '#6e2416');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(poleX, -h);
    ctx.lineTo(poleX + fw, -h + fh * 0.42);
    // Провисание края — тряпка, а не жесть.
    ctx.lineTo(poleX + fw * 0.82, -h + fh * 0.62);
    ctx.lineTo(poleX, -h + fh);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 0.9;
    ctx.stroke();

    if (wrong) {
      // Крест: игрок ошибся именно здесь.
      ctx.strokeStyle = 'rgba(200,60,45,0.9)';
      ctx.lineWidth = Math.max(1.6, cell * 0.07);
      var d = cell * 0.26;
      ctx.beginPath();
      ctx.moveTo(-d, -d);
      ctx.lineTo(d, d);
      ctx.moveTo(d, -d);
      ctx.lineTo(-d, d);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawQuestion(ctx, cx, cy, cell) {
    ctx.save();
    ctx.font = 'bold ' + (cell * 0.56).toFixed(1) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(1.4, cell * 0.07);
    ctx.strokeStyle = 'rgba(4,3,3,0.85)';
    ctx.strokeText('?', cx, cy);
    ctx.fillStyle = '#9a917f';
    ctx.fillText('?', cx, cy);
    ctx.restore();
  }

  /* --- Свет и пост-обработка -------------------------------------------- */

  /** Готовит буфер света: очищает и отдаёт контекст системе огня. */
  R.beginLight = function () {
    var ctx = lightBuf.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, lightBuf.canvas.width, lightBuf.canvas.height);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    return ctx;
  };

  /**
   * Накладывает свет на слой main. Именно этот шаг заставляет плитки
   * вокруг пожара действительно подсвечиваться, а не просто иметь
   * рядом яркое пятно.
   */
  R.applyLight = function (alpha) {
    var ctx = layers.main.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha === undefined ? 0.85 : alpha;
    ctx.drawImage(lightBuf.canvas, 0, 0);
    ctx.restore();
  };

  /** Снимок main для эффектов, которым нужен исходник (искажения). */
  R.snapshotMain = function () {
    var ctx = snapshot.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, snapshot.canvas.width, snapshot.canvas.height);
    ctx.drawImage(layers.main.canvas, 0, 0);
    return snapshot.canvas;
  };

  R.snapshotCanvas = function () {
    return snapshot.canvas;
  };

  /** Очищает fx-слой перед кадром. */
  R.beginFx = function () {
    var ctx = layers.fx.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layers.fx.canvas.width, layers.fx.canvas.height);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    return ctx;
  };

  /**
   * Свечение: fx уменьшается вдвое дважды, размывается интерполяцией
   * при масштабировании и возвращается аддитивно. Настоящий гауссов
   * блюр тут не нужен — на огне и искрах разница неразличима, а стоимость
   * отличается на порядок.
   */
  R.applyBloom = function (strength) {
    var fx = layers.fx.canvas;
    var a = bloomA;
    var b = bloomB;

    a.ctx.setTransform(1, 0, 0, 1, 0, 0);
    a.ctx.clearRect(0, 0, a.canvas.width, a.canvas.height);
    a.ctx.imageSmoothingEnabled = true;
    a.ctx.drawImage(fx, 0, 0, a.canvas.width, a.canvas.height);

    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
    b.ctx.imageSmoothingEnabled = true;
    b.ctx.drawImage(a.canvas, 0, 0, b.canvas.width, b.canvas.height);

    // Второй проход обратно в A расширяет ядро размытия.
    a.ctx.globalAlpha = 0.6;
    a.ctx.drawImage(b.canvas, 0, 0, a.canvas.width, a.canvas.height);
    a.ctx.globalAlpha = 1;

    var ctx = layers.fx.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = strength;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(a.canvas, 0, 0, fx.width, fx.height);
    ctx.restore();
  };

  /* --- Зерно плёнки ----------------------------------------------------- */

  /**
   * Накладывает движущееся зерно на слой main.
   *
   * Смещение паттерна меняется каждый кадр — статичное зерно
   * воспринимается как грязь на экране, а не как свойство изображения.
   * Стоимость — одна заливка паттерном, поэтому эффект остаётся
   * включённым даже на пониженном качестве.
   */
  var grainOffset = 0;

  R.applyGrain = function (alpha) {
    var ctx = layers.main.ctx;
    var pat = ctx.createPattern(noisePattern, 'repeat');
    if (!pat) return;

    // Скачок на случайную позицию, а не плавный сдвиг: плавный
    // читался бы как «ползущая» текстура.
    grainOffset = (grainOffset + 37) % 128;
    var oy = (grainOffset * 7) % 128;

    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = alpha;
    ctx.translate(-grainOffset, -oy);
    ctx.fillStyle = pat;
    ctx.fillRect(grainOffset, oy, view.cssW, view.cssH);
    ctx.restore();
  };

  /* --- Хроматическая аберрация ------------------------------------------ */

  /**
   * Разводит цветовые каналы: красный смещается в одну сторону,
   * синий — в другую, зелёный остаётся на месте.
   *
   * В Canvas 2D нет доступа к отдельным каналам, поэтому каждый канал
   * выделяется умножением копии на чистый цвет ('multiply' с #f00
   * оставляет только красную составляющую), после чего три канала
   * складываются обратно аддитивно. Слой main при этом собирается
   * заново — именно поэтому результат корректен по яркости, а не
   * выглядит как подсветка поверх исходника.
   *
   * Шесть проходов по всему холсту — эффект дорогой, поэтому включается
   * только на полном качестве и только на пике тряски, где он длится
   * доли секунды.
   *
   * @param {number} offset смещение в CSS-пикселях
   */
  R.applyAberration = function (offset) {
    if (offset < 0.35) return;

    var src = R.snapshotMain();
    var ctx = layers.main.ctx;
    var ab = aberrBuf;
    var W = aberrBuf.canvas.width;
    var H = aberrBuf.canvas.height;
    var d = offset * view.dpr;

    // Собираем main с нуля из трёх смещённых каналов.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    // Каналы: [цвет-маска, сдвиг по X, сдвиг по Y]
    var channels = [
      ['#ff0000', d, 0],
      ['#00ff00', 0, 0],
      ['#0000ff', -d, 0],
    ];

    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      var actx = ab.ctx;
      actx.setTransform(1, 0, 0, 1, 0, 0);
      actx.globalCompositeOperation = 'source-over';
      actx.globalAlpha = 1;
      actx.clearRect(0, 0, W, H);
      actx.drawImage(src, 0, 0);
      // Умножение на чистый цвет гасит два других канала.
      actx.globalCompositeOperation = 'multiply';
      actx.fillStyle = ch[0];
      actx.fillRect(0, 0, W, H);

      ctx.drawImage(ab.canvas, ch[1], ch[2]);
    }

    ctx.restore();
  };

  /* --- Служебное -------------------------------------------------------- */

  R.clock = function () {
    return clock;
  };

  R.cellCenterX = function (idx) {
    return (idx % view.w) * view.cell + view.cell / 2;
  };

  R.cellCenterY = function (idx) {
    return ((idx / view.w) | 0) * view.cell + view.cell / 2;
  };

  /** Переводит координаты мыши в индекс клетки. -1 если вне поля. */
  R.hitTest = function (clientX, clientY, board) {
    var rect = layers.main.canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return -1;

    // rect может быть масштабирован тряской — приводим к логическим клеткам.
    var cx = Math.floor((x / rect.width) * board.w);
    var cy = Math.floor((y / rect.height) * board.h);
    if (cx < 0 || cy < 0 || cx >= board.w || cy >= board.h) return -1;
    return cy * board.w + cx;
  };
})(typeof window !== 'undefined' ? window : globalThis);
