/* ===========================================================================
 * particles.js — пул частиц на плоских Float32Array.
 *
 * Почему не массив объектов: цепная детонация 99 мин порождает десятки
 * тысяч частиц за секунду. Объекты дали бы постоянные аллокации и
 * рывки от сборщика мусора именно в тот момент, когда нужен плавный кадр.
 * Здесь в горячем цикле не создаётся ни одного объекта.
 *
 * Отрисовка сгруппирована по режиму наложения: сначала весь дым
 * (source-over), затем всё светящееся (lighter). Два переключения
 * состояния контекста на кадр вместо одного на частицу.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  /** Тип частицы. Порядок важен: определяет группу наложения. */
  var P = {
    SMOKE: 0,
    DUST: 1,
    // ↑ source-over   ↓ lighter
    FIRE: 2,
    SPARK: 3,
    EMBER: 4,
  };

  /** Первый тип, который рисуется аддитивно. */
  var FIRST_ADDITIVE = P.FIRE;

  var CAPACITY = 5000;

  /* --- Хранилище ------------------------------------------------------- */

  var px = new Float32Array(CAPACITY);
  var py = new Float32Array(CAPACITY);
  var pvx = new Float32Array(CAPACITY);
  var pvy = new Float32Array(CAPACITY);
  var plife = new Float32Array(CAPACITY); // остаток жизни, сек
  var pmax = new Float32Array(CAPACITY); // полная жизнь, сек
  var psize = new Float32Array(CAPACITY);
  var pgrow = new Float32Array(CAPACITY); // прирост размера, px/сек
  var prot = new Float32Array(CAPACITY);
  var pvrot = new Float32Array(CAPACITY);
  var pdrag = new Float32Array(CAPACITY);
  var pgrav = new Float32Array(CAPACITY);
  var pseed = new Float32Array(CAPACITY); // индивидуальная фаза мерцания
  var ptype = new Uint8Array(CAPACITY);
  var palive = new Uint8Array(CAPACITY);

  var pool = new U.Freelist(CAPACITY);

  /** Живые индексы, сгруппированные по типу для батчинга отрисовки. */
  var order = new Int32Array(CAPACITY);
  var orderLen = 0;
  var orderDirty = true;

  var rng = U.rng;
  var col = { r: 0, g: 0, b: 0 };

  /* --- Цветовые градиенты --------------------------------------------- */

  /* Огонь: от белого ядра через оранжевый к тёмно-красному и в дым.
     Так выглядит реальное остывание горячих газов. */
  var RAMP_FIRE = [
    [0.0, 255, 248, 224],
    [0.12, 255, 224, 150],
    [0.3, 255, 160, 52],
    [0.55, 226, 88, 24],
    [0.78, 128, 40, 16],
    [1.0, 34, 22, 18],
  ];

  var RAMP_SPARK = [
    [0.0, 255, 252, 236],
    [0.25, 255, 226, 150],
    [0.6, 255, 150, 50],
    [1.0, 150, 44, 12],
  ];

  var RAMP_EMBER = [
    [0.0, 255, 200, 120],
    [0.4, 236, 122, 40],
    [0.75, 150, 52, 18],
    [1.0, 60, 24, 14],
  ];

  /* Дым: бетонная пыль светлее пороховой гари, поэтому старт серый,
     а не чёрный — иначе на тёмном фоне дым просто не виден. */
  var RAMP_SMOKE = [
    [0.0, 96, 88, 80],
    [0.35, 74, 68, 62],
    [1.0, 38, 35, 32],
  ];

  var RAMP_DUST = [
    [0.0, 150, 140, 126],
    [0.5, 116, 107, 96],
    [1.0, 70, 65, 58],
  ];

  /* --- Спрайты --------------------------------------------------------- */

  /*
   * Радиальные градиенты предрендерены в offscreen-канвасы.
   * Создавать createRadialGradient на каждую частицу — самый
   * дорогой способ рисовать частицы в Canvas 2D.
   * Спрайты белые: цвет накладывается через globalAlpha + композит.
   */
  var SPRITE_SIZE = 64;
  var spriteSoft = null; // мягкая клякса — дым, огонь
  var spriteHard = null; // плотное ядро — угли

  function buildSprites() {
    spriteSoft = makeRadialSprite([
      [0.0, 'rgba(255,255,255,1)'],
      [0.35, 'rgba(255,255,255,0.55)'],
      [1.0, 'rgba(255,255,255,0)'],
    ]);
    spriteHard = makeRadialSprite([
      [0.0, 'rgba(255,255,255,1)'],
      [0.55, 'rgba(255,255,255,0.85)'],
      [0.8, 'rgba(255,255,255,0.25)'],
      [1.0, 'rgba(255,255,255,0)'],
    ]);
  }

  function makeRadialSprite(stops) {
    var c = document.createElement('canvas');
    c.width = c.height = SPRITE_SIZE;
    var g = c.getContext('2d');
    var half = SPRITE_SIZE / 2;
    var grad = g.createRadialGradient(half, half, 0, half, half, half);
    for (var i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    return c;
  }

  /* --- Аллокация ------------------------------------------------------- */

  /**
   * Берёт слот из пула.
   * При переполнении возвращает -1: вызывающая сторона просто
   * пропускает спавн. Отбирать слот у живой частицы хуже —
   * это визуально «мигает» на самых зрелищных моментах.
   */
  function alloc() {
    var i = pool.alloc();
    if (i < 0) return -1;
    palive[i] = 1;
    orderDirty = true;
    return i;
  }

  function kill(i) {
    palive[i] = 0;
    pool.release(i);
    orderDirty = true;
  }

  /* --- Эмиттеры -------------------------------------------------------- */

  var Particles = (MS.particles = {});

  Particles.TYPE = P;

  Particles.init = function () {
    buildSprites();
  };

  Particles.clear = function () {
    for (var i = 0; i < CAPACITY; i++) palive[i] = 0;
    pool.reset();
    orderLen = 0;
    orderDirty = true;
  };

  Particles.count = function () {
    return pool.usedCount();
  };

  Particles.capacity = function () {
    return CAPACITY;
  };

  /** Сколько ещё можно заспавнить без переполнения. */
  Particles.headroom = function () {
    return pool.freeCount;
  };

  /**
   * Количество живых частиц по типам.
   * Нужно для проверки, что под давлением пула не вырождается состав:
   * взрыв без дыма или без искр выглядит принципиально иначе.
   */
  var typeCounts = new Int32Array(5);
  Particles.countByType = function () {
    for (var t = 0; t < 5; t++) typeCounts[t] = 0;
    for (var i = 0; i < CAPACITY; i++) {
      if (palive[i]) typeCounts[ptype[i]]++;
    }
    return {
      smoke: typeCounts[P.SMOKE],
      dust: typeCounts[P.DUST],
      fire: typeCounts[P.FIRE],
      spark: typeCounts[P.SPARK],
      ember: typeCounts[P.EMBER],
    };
  };

  /**
   * Пыль при обычном открытии плитки: бетонная крошка из-под неё.
   * Мелкий, но важный эффект — без него открытие ощущается «плоским».
   */
  Particles.dust = function (x, y, n, spread) {
    var s = spread || 10;
    for (var k = 0; k < n; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = rng.angle();
      var sp = rng.range(8, 34);
      ptype[i] = P.DUST;
      px[i] = x + rng.spread(s);
      py[i] = y + rng.spread(s);
      pvx[i] = Math.cos(a) * sp;
      pvy[i] = Math.sin(a) * sp - rng.range(4, 22);
      plife[i] = pmax[i] = rng.range(0.28, 0.6);
      psize[i] = rng.range(1.6, 4.2);
      pgrow[i] = rng.range(3, 9);
      prot[i] = 0;
      pvrot[i] = 0;
      pdrag[i] = 3.4;
      pgrav[i] = 46;
      pseed[i] = rng.next() * 100;
    }
  };

  /**
   * Искры: быстрые, лёгкие, с трассером. Рисуются линией по вектору
   * скорости, поэтому читаются как летящие, а не как точки.
   */
  Particles.sparks = function (x, y, n, power) {
    var p = power === undefined ? 1 : power;
    for (var k = 0; k < n; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = rng.angle();
      // Квадрат случайной величины смещает распределение к медленным
      // искрам: несколько быстрых улетают далеко, основная масса
      // остаётся у эпицентра. Так выглядит настоящий разлёт.
      var sp = rng.range(60, 620) * (0.55 + p * 0.65) * (0.35 + rng.next() * rng.next());
      ptype[i] = P.SPARK;
      px[i] = x + rng.spread(3);
      py[i] = y + rng.spread(3);
      pvx[i] = Math.cos(a) * sp;
      pvy[i] = Math.sin(a) * sp;
      plife[i] = pmax[i] = rng.range(0.22, 0.75) * (0.7 + p * 0.5);
      psize[i] = rng.range(0.9, 2.3);
      pgrow[i] = -0.7;
      prot[i] = 0;
      pvrot[i] = 0;
      pdrag[i] = rng.range(1.4, 3.2);
      pgrav[i] = rng.range(230, 460);
      pseed[i] = rng.next() * 100;
    }
  };

  /**
   * Угли: медленные, живут долго, мерцают. К концу жизни всплывают —
   * восходящий поток от нагретого бетона.
   */
  Particles.embers = function (x, y, n, power) {
    var p = power === undefined ? 1 : power;
    for (var k = 0; k < n; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = rng.angle();
      var sp = rng.range(20, 150) * (0.6 + p * 0.5);
      ptype[i] = P.EMBER;
      px[i] = x + rng.spread(5);
      py[i] = y + rng.spread(5);
      pvx[i] = Math.cos(a) * sp;
      pvy[i] = Math.sin(a) * sp - rng.range(10, 50);
      plife[i] = pmax[i] = rng.range(0.9, 2.4);
      psize[i] = rng.range(1.1, 2.8);
      pgrow[i] = -0.25;
      prot[i] = 0;
      pvrot[i] = 0;
      pdrag[i] = rng.range(0.9, 1.9);
      // Отрицательная гравитация: угли всплывают в тёплом воздухе.
      pgrav[i] = rng.range(-26, 34);
      pseed[i] = rng.next() * 100;
    }
  };

  /**
   * Огненный шар: крупные аддитивные кляксы, быстро остывающие в дым.
   * Ядро тесное и короткоживущее, периферия — медленнее и шире.
   */
  Particles.fireball = function (x, y, n, power, radius) {
    var p = power === undefined ? 1 : power;
    var r = radius === undefined ? 12 : radius;
    for (var k = 0; k < n; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = rng.angle();
      var dr = rng.next() * r;
      var sp = rng.range(30, 190) * (0.5 + p * 0.7);
      ptype[i] = P.FIRE;
      px[i] = x + Math.cos(a) * dr;
      py[i] = y + Math.sin(a) * dr;
      pvx[i] = Math.cos(a) * sp;
      pvy[i] = Math.sin(a) * sp - rng.range(0, 60);
      plife[i] = pmax[i] = rng.range(0.2, 0.6) * (0.75 + p * 0.5);
      psize[i] = rng.range(7, 20) * (0.6 + p * 0.6);
      pgrow[i] = rng.range(20, 75);
      prot[i] = rng.angle();
      pvrot[i] = rng.spread(2.5);
      pdrag[i] = rng.range(2.2, 4.5);
      pgrav[i] = rng.range(-70, -14); // горячий газ поднимается
      pseed[i] = rng.next() * 100;
    }
  };

  /**
   * Дым: живёт долго, разрастается, дрейфует вверх и в сторону.
   * Именно он держит «след» взрыва после того, как огонь потух.
   */
  Particles.smoke = function (x, y, n, power, radius) {
    var p = power === undefined ? 1 : power;
    var r = radius === undefined ? 10 : radius;
    for (var k = 0; k < n; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = rng.angle();
      var dr = rng.next() * r;
      var sp = rng.range(10, 80) * (0.5 + p * 0.6);
      ptype[i] = P.SMOKE;
      px[i] = x + Math.cos(a) * dr;
      py[i] = y + Math.sin(a) * dr;
      pvx[i] = Math.cos(a) * sp;
      pvy[i] = Math.sin(a) * sp - rng.range(14, 66);
      plife[i] = pmax[i] = rng.range(1.1, 2.9) * (0.8 + p * 0.5);
      psize[i] = rng.range(10, 26) * (0.6 + p * 0.5);
      pgrow[i] = rng.range(16, 46);
      prot[i] = rng.angle();
      pvrot[i] = rng.spread(0.9);
      pdrag[i] = rng.range(0.8, 1.7);
      pgrav[i] = rng.range(-40, -12);
      pseed[i] = rng.next() * 100;
    }
  };

  /** Одиночный язык пламени — используется системой огня каждый кадр. */
  Particles.flame = function (x, y, intensity) {
    var i = alloc();
    if (i < 0) return;
    var q = U.clamp01(intensity);
    ptype[i] = P.FIRE;
    px[i] = x + rng.spread(3.5);
    py[i] = y + rng.spread(2.5);
    pvx[i] = rng.spread(16);
    pvy[i] = -rng.range(28, 76) * (0.5 + q * 0.7);
    plife[i] = pmax[i] = rng.range(0.24, 0.52);
    psize[i] = rng.range(3.2, 8) * (0.55 + q * 0.7);
    pgrow[i] = rng.range(6, 20);
    prot[i] = rng.angle();
    pvrot[i] = rng.spread(1.6);
    pdrag[i] = 1.7;
    pgrav[i] = -rng.range(30, 78);
    pseed[i] = rng.next() * 100;
  };

  /* --- Обновление ------------------------------------------------------ */

  /**
   * @param {number} dt масштабированное время (учитывает slow-mo)
   * @param {number} time абсолютное время для турбулентности
   */
  Particles.update = function (dt, time) {
    if (dt <= 0) return;

    for (var i = 0; i < CAPACITY; i++) {
      if (!palive[i]) continue;

      plife[i] -= dt;
      if (plife[i] <= 0) {
        kill(i);
        continue;
      }

      var t = ptype[i];

      /* Турбулентность применяется только к огню и дыму: именно она
         превращает симметричные кляксы в живые клубы. Искрам она не
         нужна — они летят по баллистике. */
      if (t === P.FIRE || t === P.SMOKE) {
        var nx = U.noise2(px[i] * 0.02 + time * 0.55, py[i] * 0.02);
        var ny = U.noise2(px[i] * 0.02, py[i] * 0.02 + time * 0.45 + 31.7);
        var turb = t === P.FIRE ? 190 : 96;
        pvx[i] += nx * turb * dt;
        pvy[i] += ny * turb * 0.45 * dt;
      }

      // Сопротивление воздуха: экспоненциальное, кадронезависимое.
      var damp = Math.exp(-pdrag[i] * dt);
      pvx[i] *= damp;
      pvy[i] *= damp;
      pvy[i] += pgrav[i] * dt;

      px[i] += pvx[i] * dt;
      py[i] += pvy[i] * dt;

      psize[i] += pgrow[i] * dt;
      if (psize[i] < 0.35) {
        kill(i);
        continue;
      }

      prot[i] += pvrot[i] * dt;
    }
  };

  /* --- Отрисовка ------------------------------------------------------- */

  /**
   * Пересобирает порядок обхода так, чтобы частицы шли группами по типу.
   * Это позволяет переключить globalCompositeOperation ровно один раз
   * на границе между дымом и светящимися частицами.
   */
  function rebuildOrder() {
    orderLen = 0;
    for (var t = 0; t <= P.EMBER; t++) {
      for (var i = 0; i < CAPACITY; i++) {
        if (palive[i] && ptype[i] === t) order[orderLen++] = i;
      }
    }
    orderDirty = false;
  }

  function rampFor(t) {
    switch (t) {
      case P.FIRE:
        return RAMP_FIRE;
      case P.SPARK:
        return RAMP_SPARK;
      case P.EMBER:
        return RAMP_EMBER;
      case P.SMOKE:
        return RAMP_SMOKE;
      default:
        return RAMP_DUST;
    }
  }

  /**
   * Рисует все частицы в координатах поля (CSS-пиксели).
   * Контекст должен быть уже настроен вызывающей стороной.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} time абсолютное время для мерцания
   */
  Particles.draw = function (ctx, time) {
    // Порядок пересобирается только когда состав пула изменился.
    // На кадрах без спавна и смертей это бесплатно.
    if (orderDirty) rebuildOrder();
    if (orderLen === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    var additiveStarted = false;

    for (var k = 0; k < orderLen; k++) {
      var i = order[k];
      if (!palive[i]) continue;

      var t = ptype[i];

      // Единственное переключение композита за кадр.
      if (!additiveStarted && t >= FIRST_ADDITIVE) {
        ctx.globalCompositeOperation = 'lighter';
        additiveStarted = true;
      }

      var age = 1 - plife[i] / pmax[i]; // 0 = только родилась
      U.sampleRamp(rampFor(t), age, col);

      var s = psize[i];

      if (t === P.SPARK) {
        /* Искра рисуется отрезком по вектору скорости. Длина зависит
           от скорости — быстрая искра вытягивается в трассер,
           медленная становится точкой. */
        var sp = Math.sqrt(pvx[i] * pvx[i] + pvy[i] * pvy[i]);
        var len = U.clamp(sp * 0.022, 1.2, 16);
        var inv = sp > 0.001 ? 1 / sp : 0;
        var tx = pvx[i] * inv;
        var ty = pvy[i] * inv;

        // Мерцание: искры дробятся и на глаз пульсируют.
        var flick = 0.72 + 0.28 * Math.sin(time * 42 + pseed[i] * 6.3);
        var a = (1 - age) * flick;

        ctx.strokeStyle = U.rgba(col.r, col.g, col.b, a);
        ctx.lineWidth = s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px[i], py[i]);
        ctx.lineTo(px[i] - tx * len, py[i] - ty * len);
        ctx.stroke();
        continue;
      }

      var alpha;
      var sprite = spriteSoft;

      if (t === P.EMBER) {
        // Пульсация угля: тлеет неровно.
        var pulse = 0.55 + 0.45 * Math.sin(time * 9 + pseed[i] * 5.1);
        alpha = (1 - age) * (0.5 + 0.5 * pulse);
        sprite = spriteHard;
      } else if (t === P.FIRE) {
        // Огонь ярче всего в первой трети жизни, потом быстро гаснет.
        alpha = (age < 0.3 ? 0.85 : 0.85 * (1 - (age - 0.3) / 0.7)) * 0.9;
      } else if (t === P.SMOKE) {
        // Дым проявляется плавно, иначе «выскакивает» из ниоткуда.
        alpha = U.ease.pulse(age) * 0.34;
      } else {
        alpha = (1 - age) * 0.5;
      }

      if (alpha <= 0.004) continue;

      ctx.globalAlpha = alpha;
      drawTinted(ctx, sprite, px[i], py[i], s, prot[i], col);
    }

    ctx.restore();
  };

  /*
   * Тонирование спрайта.
   *
   * В Canvas 2D нет дешёвого способа перекрасить изображение, поэтому
   * держим по одному кэшированному тонированному спрайту на «ведро»
   * цвета. Квантование цвета до 5 бит на канал даёт максимум несколько
   * десятков вариантов за партию — все они переиспользуются.
   */
  var tintCache = {};
  var tintCanvasPool = [];

  function getTinted(sprite, r, g, b) {
    // Квантование: 32 уровня на канал. Глаз разницы не увидит,
    // а кэш остаётся маленьким.
    var qr = (r >> 3) << 3;
    var qg = (g >> 3) << 3;
    var qb = (b >> 3) << 3;
    var key = (sprite === spriteHard ? 'h' : 's') + qr + '_' + qg + '_' + qb;

    var cached = tintCache[key];
    if (cached) return cached;

    var c = tintCanvasPool.pop();
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = SPRITE_SIZE;
    }
    var cx = c.getContext('2d');
    cx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    cx.globalCompositeOperation = 'source-over';
    cx.drawImage(sprite, 0, 0);
    // Красим, сохраняя альфу спрайта.
    cx.globalCompositeOperation = 'source-in';
    cx.fillStyle = 'rgb(' + qr + ',' + qg + ',' + qb + ')';
    cx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

    tintCache[key] = c;
    return c;
  }

  function drawTinted(ctx, sprite, x, y, size, rot, c) {
    var img = getTinted(sprite, c.r | 0, c.g | 0, c.b | 0);
    var d = size * 2;

    if (rot === 0) {
      ctx.drawImage(img, x - size, y - size, d, d);
      return;
    }
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.drawImage(img, -size, -size, d, d);
    ctx.rotate(-rot);
    ctx.translate(-x, -y);
  }

  /** Сбрасывает кэш тонированных спрайтов (например, при смене темы). */
  Particles.flushCache = function () {
    for (var k in tintCache) {
      tintCanvasPool.push(tintCache[k]);
    }
    tintCache = {};
  };
})(typeof window !== 'undefined' ? window : globalThis);
