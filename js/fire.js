/* ===========================================================================
 * fire.js — горящие клетки: пламя, динамический свет, тепловое искажение.
 *
 * Три части, по убыванию заметности:
 *   1. Свет. Каждый очаг подсвечивает соседние плитки мерцающим пятном.
 *      Именно это связывает огонь с полем — без света пламя выглядит
 *      наклейкой поверх картинки.
 *   2. Пламя. Аддитивные языки, эмиссия пропорциональна интенсивности.
 *   3. Тепловое искажение. Самый дорогой эффект, включается только
 *      при высоком качестве.
 *
 * Огонь здесь чисто визуальный: он не распространяется по полю и не
 * влияет на правила. Так и было решено — механику это не ломает.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  var MAX_FIRES = 220;

  var fcell = new Int32Array(MAX_FIRES); // индекс клетки
  var fx = new Float32Array(MAX_FIRES);
  var fy = new Float32Array(MAX_FIRES);
  var fint = new Float32Array(MAX_FIRES); // текущая интенсивность 0..1
  var ffuel = new Float32Array(MAX_FIRES); // остаток топлива, сек
  var fmaxFuel = new Float32Array(MAX_FIRES);
  var fseed = new Float32Array(MAX_FIRES); // фаза мерцания
  var femit = new Float32Array(MAX_FIRES); // накопитель дробной эмиссии
  var falive = new Uint8Array(MAX_FIRES);

  var pool = new U.Freelist(MAX_FIRES);
  var rng = U.rng;

  /** Кэш индекса клетки -> слот, чтобы не поджигать одну клетку дважды. */
  var byCell = {};

  var totalIntensity = 0;
  var clock = 0;

  /* Габариты пожара — по ним ограничивается тепловое искажение,
     чтобы не сканировать весь холст. */
  var bbox = { x0: 0, y0: 0, x1: 0, y1: 0, valid: false };

  var Fire = (MS.fire = {});

  Fire.clear = function () {
    for (var i = 0; i < MAX_FIRES; i++) falive[i] = 0;
    pool.reset();
    byCell = {};
    totalIntensity = 0;
    bbox.valid = false;
  };

  Fire.count = function () {
    return pool.usedCount();
  };

  Fire.totalIntensity = function () {
    return totalIntensity;
  };

  Fire.bbox = function () {
    return bbox;
  };

  /**
   * Поджигает клетку. Повторный вызов на горящей клетке не создаёт
   * второй очаг, а подкидывает топлива — так цепная детонация рядом
   * усиливает существующий пожар вместо наложения дублей.
   *
   * @param {number} cellIdx
   * @param {number} x,y   центр клетки в CSS-пикселях
   * @param {number} power 0..1
   */
  Fire.ignite = function (cellIdx, x, y, power) {
    var p = U.clamp01(power === undefined ? 1 : power);
    var existing = byCell[cellIdx];

    if (existing !== undefined && falive[existing]) {
      ffuel[existing] = Math.min(ffuel[existing] + 1.5 + p * 3, 14);
      fmaxFuel[existing] = Math.max(fmaxFuel[existing], ffuel[existing]);
      fint[existing] = Math.min(1, fint[existing] + p * 0.4);
      return existing;
    }

    var i = pool.alloc();
    if (i < 0) return -1;

    falive[i] = 1;
    fcell[i] = cellIdx;
    fx[i] = x;
    fy[i] = y;
    fint[i] = 0.25 + p * 0.5;
    ffuel[i] = fmaxFuel[i] = rng.range(2.6, 6.5) * (0.6 + p * 0.7);
    fseed[i] = rng.next() * 100;
    femit[i] = 0;
    byCell[cellIdx] = i;
    return i;
  };

  /**
   * @param {number} dt      масштабированное время
   * @param {number} quality 0..1 — режет число частиц пламени
   */
  Fire.update = function (dt, quality) {
    clock += dt;
    if (dt <= 0) return;

    var q = quality === undefined ? 1 : quality;
    var sum = 0;
    var any = false;
    var x0 = 1e9,
      y0 = 1e9,
      x1 = -1e9,
      y1 = -1e9;

    var particles = MS.particles;

    /* Резерв пула под взрывы.
     *
     * Пламя эмитируется непрерывно, взрывы — вспышками. Без резерва
     * горящее поле забивает пул ровным потоком языков пламени, и на
     * очередной взрыв слотов уже не остаётся: искры и дым от него
     * просто не рождаются. Взрыв важнее — он событие, а пламя фон. */
    var budget = Math.max(0, particles.headroom() - 1400);

    /* Скорость эмиссии на очаг падает с ростом их числа.
     *
     * Сто горящих клеток визуально перекрывают друг друга, и полная
     * плотность на каждую не добавляет ничего, кроме расхода пула.
     * Корневое масштабирование сохраняет вид одиночного костра
     * и удерживает бюджет на выжженном поле. */
    var count = pool.usedCount();
    var rate = 46 * U.clamp(Math.sqrt(20 / Math.max(1, count)), 0.3, 1);

    for (var i = 0; i < MAX_FIRES; i++) {
      if (!falive[i]) continue;

      ffuel[i] -= dt;

      if (ffuel[i] <= 0) {
        // Затухание: интенсивность падает, очаг умирает.
        fint[i] = U.decay(fint[i], 0.9, dt);
        if (fint[i] < 0.02) {
          falive[i] = 0;
          pool.release(i);
          if (byCell[fcell[i]] === i) delete byCell[fcell[i]];
          continue;
        }
      } else {
        /* Пока есть топливо, интенсивность колеблется вокруг уровня,
           заданного остатком топлива. Пламя не горит ровно. */
        var fuelRatio = ffuel[i] / fmaxFuel[i];
        var target = 0.35 + fuelRatio * 0.65;
        var wobble = U.noise1(clock * 2.4 + fseed[i]) * 0.16;
        fint[i] += (target + wobble - fint[i]) * Math.min(1, dt * 5);
        fint[i] = U.clamp01(fint[i]);
      }

      sum += fint[i];
      any = true;

      if (fx[i] < x0) x0 = fx[i];
      if (fy[i] < y0) y0 = fy[i];
      if (fx[i] > x1) x1 = fx[i];
      if (fy[i] > y1) y1 = fy[i];

      /* Эмиссия языков пламени. Дробный остаток накапливается, поэтому
         слабый огонь испускает частицу раз в несколько кадров, а не
         округляется в ноль и не исчезает. */
      if (budget > 0) {
        femit[i] += fint[i] * rate * q * dt;
        var n = Math.floor(femit[i]);
        if (n > 0) {
          femit[i] -= n;
          if (n > 5) n = 5;
          for (var k = 0; k < n && budget > 0; k++) {
            particles.flame(fx[i], fy[i], fint[i]);
            budget--;
          }
        }
      }

      // Редкий дым от очага — держит вертикальный след над пожаром.
      if (budget > 0 && rng.next() < fint[i] * dt * 5.5) {
        particles.smoke(fx[i], fy[i] - 2, 1, 0.25, 3);
        budget--;
      }
    }

    totalIntensity = sum;

    bbox.valid = any;
    if (any) {
      bbox.x0 = x0;
      bbox.y0 = y0;
      bbox.x1 = x1;
      bbox.y1 = y1;
    }
  };

  /* --- Свет ------------------------------------------------------------ */

  /*
   * Спрайт светового пятна. Предрендерен: createRadialGradient на каждый
   * очаг в каждом кадре — заметная статья расхода при 100+ очагах.
   */
  var LIGHT_SIZE = 128;
  var lightSprite = null;

  function buildLightSprite() {
    var c = document.createElement('canvas');
    c.width = c.height = LIGHT_SIZE;
    var g = c.getContext('2d');
    var h = LIGHT_SIZE / 2;
    var grad = g.createRadialGradient(h, h, 0, h, h, h);
    // Тёплый свет: ядро почти белое, периферия уходит в глубокий оранжевый.
    grad.addColorStop(0.0, 'rgba(255,214,150,0.95)');
    grad.addColorStop(0.25, 'rgba(255,158,70,0.55)');
    grad.addColorStop(0.55, 'rgba(206,92,30,0.24)');
    grad.addColorStop(1.0, 'rgba(120,40,10,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, LIGHT_SIZE, LIGHT_SIZE);
    return c;
  }

  Fire.init = function () {
    lightSprite = buildLightSprite();
  };

  /**
   * Рисует световые пятна. Вызывается для отдельного light-буфера,
   * который потом накладывается на слой main аддитивно — так свет
   * ложится ПОД частицы пламени и подсвечивает именно плитки.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cell размер клетки — задаёт радиус свечения
   */
  Fire.drawLight = function (ctx, cell) {
    if (pool.usedCount() === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (var i = 0; i < MAX_FIRES; i++) {
      if (!falive[i]) continue;

      /* Мерцание — два несинхронных шума. Один медленный (дыхание
         пламени), второй быстрый (дрожание). Одна синусоида дала бы
         механическую пульсацию, которую глаз сразу опознаёт как фальшь. */
      var slow = U.noise1(clock * 3.1 + fseed[i]);
      var fast = U.noise1(clock * 11.5 + fseed[i] * 2.3);
      var flicker = 0.78 + slow * 0.17 + fast * 0.09;

      var radius = cell * (1.5 + fint[i] * 1.5) * flicker;
      var alpha = fint[i] * 0.85 * flicker;
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = U.clamp01(alpha);
      // Небольшое смещение вверх: источник света — тело пламени,
      // а не основание клетки.
      var cy = fy[i] - cell * 0.15;
      ctx.drawImage(lightSprite, fx[i] - radius, cy - radius, radius * 2, radius * 2);
    }

    ctx.restore();
  };

  /* --- Тепловое искажение ---------------------------------------------- */

  /**
   * Горизонтальный сдвиг полос над зоной пожара. Полосы по 4 CSS-пикселя:
   * попиксельная обработка тут не нужна, а стоила бы в 4 раза дороже.
   *
   * Источник и цель — один и тот же холст, поэтому копируем полосу
   * из буфера, а не из холста напрямую.
   *
   * @param {CanvasRenderingContext2D} ctx    целевой контекст (main)
   * @param {HTMLCanvasElement} snapshot      копия main до искажения
   * @param {number} cell
   * @param {number} strength                 множитель силы
   */
  Fire.drawHeatDistortion = function (ctx, snapshot, cell, strength) {
    if (!bbox.valid || totalIntensity < 0.15) return;

    var BAND = 4;
    var pad = cell * 2.5;

    // Искажение поднимается высоко над огнём: горячий воздух идёт вверх.
    var y0 = Math.max(0, bbox.y0 - cell * 4.5);
    var y1 = Math.min(snapshot.height, bbox.y1 + pad);
    var x0 = Math.max(0, bbox.x0 - pad);
    var x1 = Math.min(snapshot.width, bbox.x1 + pad);
    var w = x1 - x0;
    if (w <= 0 || y1 <= y0) return;

    var amp = U.clamp(totalIntensity * 0.9, 0.4, 3.4) * (strength || 1);

    ctx.save();
    for (var y = y0; y < y1; y += BAND) {
      /* Смещение зависит от высоты и времени. Затухание по высоте:
         у самого пламени дрожь сильнее, выше — рассеивается. */
      var heightFade = 1 - U.clamp01((bbox.y1 - y) / (cell * 7));
      var offset =
        (Math.sin(y * 0.13 + clock * 5.2) * 0.6 + U.noise1(y * 0.07 + clock * 3.4) * 0.4) *
        amp *
        (0.35 + heightFade * 0.65);

      var h = Math.min(BAND, y1 - y);
      ctx.drawImage(snapshot, x0, y, w, h, x0 + offset, y, w, h);
    }
    ctx.restore();
  };

  /** Список горящих клеток — игра рисует по ним подпалины. */
  Fire.forEach = function (fn) {
    for (var i = 0; i < MAX_FIRES; i++) {
      if (falive[i]) fn(fcell[i], fx[i], fy[i], fint[i]);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
