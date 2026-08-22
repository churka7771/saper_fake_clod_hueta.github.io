/* ===========================================================================
 * debris.js — осколки разрушенных плиток.
 *
 * Каждая уничтоженная плитка режется сеткой 3x3 на 9 фрагментов. Фрагмент
 * несёт вырезку из текстуры плитки, поэтому обломки выглядят как куски
 * именно этой поверхности, а не как абстрактные квадраты.
 *
 * Физика намеренно простая: гравитация, сопротивление воздуха, отскок от
 * нижней границы поля с потерей энергии. Столкновений между осколками нет —
 * при 600 активных фрагментах их никто не заметит, а стоимость выросла бы
 * квадратично.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  var CAPACITY = 700;

  /** Сколько фрагментов по каждой оси. 3x3 = 9 осколков на плитку. */
  var GRID = 3;

  var dx = new Float32Array(CAPACITY);
  var dy = new Float32Array(CAPACITY);
  var dvx = new Float32Array(CAPACITY);
  var dvy = new Float32Array(CAPACITY);
  var drot = new Float32Array(CAPACITY);
  var dvrot = new Float32Array(CAPACITY);
  var dlife = new Float32Array(CAPACITY);
  var dmax = new Float32Array(CAPACITY);

  /* Вырезка из текстуры плитки — в пикселях текстуры. */
  var dsx = new Float32Array(CAPACITY);
  var dsy = new Float32Array(CAPACITY);
  var dsw = new Float32Array(CAPACITY);
  var dsh = new Float32Array(CAPACITY);

  /** Затемнение осколка: обломки в глубине разлёта темнее. */
  var dshade = new Float32Array(CAPACITY);
  var dalive = new Uint8Array(CAPACITY);
  /** 0 — обычная плитка, 1 — обломок с подпалиной. */
  var dcharred = new Uint8Array(CAPACITY);

  var pool = new U.Freelist(CAPACITY);
  var rng = U.rng;

  /** Граница «пола», ниже которой осколки отскакивают. Ставит игра. */
  var floorY = 1e9;
  var bounceLoss = 0.42; // сколько скорости остаётся после удара

  var Debris = (MS.debris = {});

  Debris.setFloor = function (y) {
    floorY = y;
  };

  Debris.clear = function () {
    for (var i = 0; i < CAPACITY; i++) dalive[i] = 0;
    pool.reset();
  };

  Debris.count = function () {
    return pool.usedCount();
  };

  Debris.capacity = function () {
    return CAPACITY;
  };

  Debris.headroom = function () {
    return pool.freeCount;
  };

  /**
   * Разбивает плитку на осколки.
   *
   * @param {number} tileX  левый край плитки в CSS-пикселях
   * @param {number} tileY  верхний край плитки
   * @param {number} cell   размер плитки
   * @param {number} ex     X эпицентра взрыва
   * @param {number} ey     Y эпицентра
   * @param {number} power  0..1 сила
   * @param {number} texSize размер текстуры плитки в пикселях
   * @param {number} [density] 0..1 доля спавнящихся фрагментов (для качества)
   */
  Debris.shatter = function (tileX, tileY, cell, ex, ey, power, texSize, density) {
    var frag = cell / GRID;
    var texFrag = texSize / GRID;
    var dens = density === undefined ? 1 : density;

    for (var gy = 0; gy < GRID; gy++) {
      for (var gx = 0; gx < GRID; gx++) {
        if (dens < 1 && rng.next() > dens) continue;

        var i = pool.alloc();
        if (i < 0) return; // пул кончился — остальные фрагменты просто не рождаются

        // Центр фрагмента в мировых координатах.
        var cxp = tileX + (gx + 0.5) * frag;
        var cyp = tileY + (gy + 0.5) * frag;

        /* Импульс направлен от эпицентра и падает с расстоянием.
           +0.6 клетки в знаменателе не даёт скорости уйти в бесконечность,
           когда фрагмент оказался ровно в центре взрыва. */
        var vx = cxp - ex;
        var vy = cyp - ey;
        var d = Math.sqrt(vx * vx + vy * vy);
        var falloff = cell / (d + cell * 0.6);

        if (d < 0.001) {
          // Фрагмент точно в эпицентре — направление выбираем случайно.
          var a = rng.angle();
          vx = Math.cos(a);
          vy = Math.sin(a);
        } else {
          vx /= d;
          vy /= d;
        }

        var speed = rng.range(190, 520) * (0.45 + power * 0.75) * falloff;

        dalive[i] = 1;
        dx[i] = cxp;
        dy[i] = cyp;
        dvx[i] = vx * speed + rng.spread(70);
        // Смещение вверх: осколки должны подлетать, а не расползаться.
        dvy[i] = vy * speed + rng.spread(70) - rng.range(60, 240) * (0.4 + power * 0.6);
        drot[i] = rng.spread(0.4);
        dvrot[i] = rng.spread(11) * (0.5 + power * 0.6);
        dlife[i] = dmax[i] = rng.range(1.5, 3.4);

        dsx[i] = gx * texFrag;
        dsy[i] = gy * texFrag;
        dsw[i] = texFrag;
        dsh[i] = texFrag;

        dshade[i] = rng.range(0.45, 1);
        dcharred[i] = rng.bool(0.55) ? 1 : 0;
      }
    }
  };

  /**
   * Мелкая крошка без текстуры — для трещин и вторичных обвалов.
   * Дешевле полноценного осколка и даёт ощущение осыпающегося бетона.
   */
  Debris.chips = function (x, y, n, cell, texSize, power) {
    var texFrag = texSize / GRID;
    for (var k = 0; k < n; k++) {
      var i = pool.alloc();
      if (i < 0) return;
      var a = rng.angle();
      var sp = rng.range(40, 210) * (0.5 + (power || 0.5));

      dalive[i] = 1;
      dx[i] = x + rng.spread(cell * 0.3);
      dy[i] = y + rng.spread(cell * 0.3);
      dvx[i] = Math.cos(a) * sp;
      dvy[i] = Math.sin(a) * sp - rng.range(40, 150);
      drot[i] = rng.angle();
      dvrot[i] = rng.spread(14);
      dlife[i] = dmax[i] = rng.range(0.8, 1.9);

      // Берём случайный маленький кусочек текстуры.
      var s = texFrag * rng.range(0.25, 0.5);
      dsx[i] = rng.range(0, texSize - s);
      dsy[i] = rng.range(0, texSize - s);
      dsw[i] = s;
      dsh[i] = s;

      dshade[i] = rng.range(0.35, 0.8);
      dcharred[i] = 1;
    }
  };

  /**
   * @param {number} dt масштабированное время
   * @param {function} [onImpact] колбэк(x, y, speed) при ударе о пол —
   *        игра вешает на него пыль от падения
   */
  Debris.update = function (dt, onImpact) {
    if (dt <= 0) return;

    var GRAVITY = 1250;

    for (var i = 0; i < CAPACITY; i++) {
      if (!dalive[i]) continue;

      dlife[i] -= dt;
      if (dlife[i] <= 0) {
        dalive[i] = 0;
        pool.release(i);
        continue;
      }

      // Сопротивление воздуха слабое: бетон тяжёлый.
      var damp = Math.exp(-0.9 * dt);
      dvx[i] *= damp;
      dvy[i] = dvy[i] * damp + GRAVITY * dt;

      dx[i] += dvx[i] * dt;
      dy[i] += dvy[i] * dt;
      drot[i] += dvrot[i] * dt;

      // Отскок от нижней границы поля.
      if (dy[i] >= floorY && dvy[i] > 0) {
        var impactSpeed = dvy[i];
        dy[i] = floorY;
        dvy[i] = -dvy[i] * bounceLoss;
        dvx[i] *= 0.72;
        dvrot[i] *= 0.55;

        // Слишком слабый отскок — гасим, иначе осколок дрожит на полу.
        if (Math.abs(dvy[i]) < 34) {
          dvy[i] = 0;
          dvx[i] *= 0.5;
          dvrot[i] *= 0.3;
          // Лежащий осколок быстрее исчезает: он больше не интересен.
          if (dlife[i] > 0.7) dlife[i] = 0.7;
        } else if (onImpact && impactSpeed > 180) {
          onImpact(dx[i], dy[i], impactSpeed);
        }
      }
    }
  };

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} tex текстура плитки
   * @param {HTMLCanvasElement} texCharred подпалённая версия текстуры
   * @param {number} cell размер плитки в CSS-пикселях
   */
  Debris.draw = function (ctx, tex, texCharred, cell) {
    if (pool.usedCount() === 0) return;

    var frag = cell / GRID;

    ctx.save();

    for (var i = 0; i < CAPACITY; i++) {
      if (!dalive[i]) continue;

      var age = 1 - dlife[i] / dmax[i];
      // Исчезают только в последней трети жизни — до этого полностью видны.
      var alpha = age < 0.66 ? 1 : 1 - (age - 0.66) / 0.34;
      if (alpha <= 0.01) continue;

      var img = dcharred[i] ? texCharred : tex;
      // Масштаб фрагмента: у крошки вырезка меньше, чем у осколка плитки.
      var w = (dsw[i] / (tex.width / GRID)) * frag;
      var h = (dsh[i] / (tex.height / GRID)) * frag;

      ctx.globalAlpha = alpha;
      ctx.translate(dx[i], dy[i]);
      ctx.rotate(drot[i]);
      ctx.drawImage(img, dsx[i], dsy[i], dsw[i], dsh[i], -w / 2, -h / 2, w, h);

      /* Затемнение поверх вырезки: разлёт становится читаемым по глубине,
         иначе куча осколков выглядит плоским пятном. */
      if (dshade[i] < 1) {
        ctx.globalAlpha = alpha * (1 - dshade[i]) * 0.75;
        ctx.fillStyle = '#0b0908';
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }

      ctx.rotate(-drot[i]);
      ctx.translate(-dx[i], -dy[i]);
    }

    ctx.restore();
  };

  Debris.GRID = GRID;
})(typeof window !== 'undefined' ? window : globalThis);
