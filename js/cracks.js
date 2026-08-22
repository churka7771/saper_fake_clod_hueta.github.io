/* ===========================================================================
 * cracks.js — процедурные трещины от эпицентра взрыва.
 *
 * Трещина строится как случайное блуждание наружу с небольшим отклонением
 * угла на каждом шаге и вероятностью ветвления. Ключевой момент — трещины
 * не появляются мгновенно: они прорастают за ~350 мс, и глаз успевает
 * прочитать направление распространения.
 *
 * Готовые сегменты пишутся в слой damage и остаются там навсегда,
 * не стоя ни одного миллисекунды в последующих кадрах.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  /* Сегменты всех активных трещин лежат в одном плоском массиве.
     Каждый сегмент: x0, y0, x1, y1, время появления, толщина.

     Ёмкость рассчитана на цепную детонацию: один взрыв даёт ~600
     сегментов, а на Профи их 99. Полную историю столько взрывов не
     удержит, поэтому при переполнении буфер уплотняется — уже
     отрисованные сегменты выбрасываются (они навсегда остались
     в слое damage и больше не нужны). */
  var MAX_SEGMENTS = 20000;
  var sx0 = new Float32Array(MAX_SEGMENTS);
  var sy0 = new Float32Array(MAX_SEGMENTS);
  var sx1 = new Float32Array(MAX_SEGMENTS);
  var sy1 = new Float32Array(MAX_SEGMENTS);
  var sat = new Float32Array(MAX_SEGMENTS); // когда сегмент должен проявиться
  var sw = new Float32Array(MAX_SEGMENTS);
  var sdrawn = new Uint8Array(MAX_SEGMENTS);

  var segCount = 0;
  /** Индекс первого ещё не отрисованного сегмента — сегменты идут по времени. */
  var drawCursor = 0;
  var clock = 0;
  /** Сколько сегментов выброшено уплотнением — для статистики. */
  var discarded = 0;

  var rng = U.rng;

  var Cracks = (MS.cracks = {});

  Cracks.clear = function () {
    segCount = 0;
    drawCursor = 0;
    clock = 0;
    discarded = 0;
    for (var i = 0; i < MAX_SEGMENTS; i++) sdrawn[i] = 0;
  };

  Cracks.count = function () {
    return segCount;
  };

  Cracks.pending = function () {
    return segCount - drawCursor;
  };

  Cracks.discarded = function () {
    return discarded;
  };

  /**
   * Выбрасывает уже отрисованные сегменты, сдвигая непрорисованный
   * хвост в начало буфера.
   *
   * Плата за это — при смене размера окна перерисуются только те
   * трещины, что ещё не проявились. Осознанный компромисс: ресайз
   * посреди детонации — редкость, а пропавшие трещины всё равно
   * лежали бы под слоями более поздней копоти.
   */
  function compact() {
    var tail = segCount - drawCursor;
    if (drawCursor === 0) return false; // нечего выбрасывать

    for (var i = 0; i < tail; i++) {
      var src = drawCursor + i;
      sx0[i] = sx0[src];
      sy0[i] = sy0[src];
      sx1[i] = sx1[src];
      sy1[i] = sy1[src];
      sat[i] = sat[src];
      sw[i] = sw[src];
      sdrawn[i] = sdrawn[src];
    }

    discarded += drawCursor;
    segCount = tail;
    drawCursor = 0;
    return true;
  }

  function pushSegment(x0, y0, x1, y1, at, width) {
    if (segCount >= MAX_SEGMENTS && !compact()) return false;
    if (segCount >= MAX_SEGMENTS) return false;
    var i = segCount++;
    sx0[i] = x0;
    sy0[i] = y0;
    sx1[i] = x1;
    sy1[i] = y1;
    sat[i] = at;
    sw[i] = width;
    sdrawn[i] = 0;
    return true;
  }

  /**
   * Одна ветвь трещины: блуждание от точки в заданном направлении.
   *
   * @param {number} x,y       старт
   * @param {number} angle     начальное направление
   * @param {number} length    полная длина в пикселях
   * @param {number} width     толщина линии
   * @param {number} startAt   время появления первого сегмента
   * @param {number} speed     px/сек — с какой скоростью прорастает
   * @param {number} depth     глубина рекурсии ветвления
   */
  function walk(x, y, angle, length, width, startAt, speed, depth) {
    /* Шаг 7px: на глаз неотличимо от 5.5px, но сегментов на четверть
       меньше. При 99 взрывах эта разница определяет, доживут ли
       трещины последних взрывов до буфера. */
    var step = 7;
    var travelled = 0;
    var cx = x;
    var cy = y;
    var a = angle;
    var t = startAt;

    while (travelled < length) {
      // Отклонение на каждом шаге. Трещина в бетоне идёт почти прямо,
      // но с постоянным мелким рысканьем.
      a += rng.spread(0.38);

      var seg = Math.min(step, length - travelled);
      var nx = cx + Math.cos(a) * seg;
      var ny = cy + Math.sin(a) * seg;

      // Толщина падает к концу трещины — она «выдыхается».
      var w = width * (1 - (travelled / length) * 0.65);
      if (!pushSegment(cx, cy, nx, ny, t, w)) return;

      cx = nx;
      cy = ny;
      travelled += seg;
      t += seg / speed;

      /* Ветвление. Ограничение по глубине обязательно: без него
         рекурсия съедает весь бюджет сегментов на одном взрыве. */
      if (depth > 0 && travelled > length * 0.15 && rng.bool(0.09)) {
        var side = rng.bool() ? 1 : -1;
        walk(
          cx,
          cy,
          a + side * rng.range(0.5, 1.15),
          length * rng.range(0.28, 0.5),
          w * 0.7,
          t,
          speed * 1.15,
          depth - 1
        );
      }
    }
  }

  /**
   * Создаёт систему трещин от точки взрыва.
   *
   * @param {number} x,y    эпицентр
   * @param {number} power  0..1
   * @param {number} cell   размер клетки — задаёт масштаб трещин
   * @param {number} [quality] 0..1 — множитель числа лучей
   */
  Cracks.spawn = function (x, y, power, cell, quality) {
    var q = quality === undefined ? 1 : quality;
    var rays = Math.max(3, Math.round((7 + power * 8) * q));
    var baseLen = cell * (1.4 + power * 3.2);
    var speed = cell * 26; // прорастание: ~350 мс на полную длину

    // Стартовые углы распределены по кругу с разбросом, а не строго
    // равномерно — иначе рисунок выглядит как звёздочка из клипарта.
    var base = rng.angle();
    for (var i = 0; i < rays; i++) {
      var a = base + (i / rays) * U.TAU + rng.spread(0.5);
      walk(
        x + Math.cos(a) * cell * 0.2,
        y + Math.sin(a) * cell * 0.2,
        a,
        baseLen * rng.range(0.55, 1.35),
        (1 + power * 1.3) * rng.range(0.7, 1.25),
        clock,
        speed,
        2
      );
    }
  };

  /**
   * Дорисовывает сегменты, чьё время пришло, прямо в слой damage.
   *
   * Вызывается с немасштабированным dt: прорастание трещин не должно
   * замедляться вместе с slow-mo, иначе они отстают от разлёта осколков.
   *
   * @param {number} dt
   * @param {CanvasRenderingContext2D} ctx контекст слоя damage
   */
  Cracks.update = function (dt, ctx) {
    clock += dt;
    if (drawCursor >= segCount) return;

    ctx.save();
    ctx.lineCap = 'round';

    var drew = 0;
    for (var i = drawCursor; i < segCount; i++) {
      if (sat[i] > clock) {
        /* Сегменты добавлялись не строго по возрастанию времени
           (ветви уходят вперёд родителя), поэтому нельзя просто
           оборваться — продолжаем искать готовые. */
        continue;
      }
      if (sdrawn[i]) continue;

      /* Трещина рисуется двумя линиями: тёмная — сама щель,
         светлая со смещением на 1px — блик на её кромке.
         Это даёт ощущение глубины на плоской картинке. */
      ctx.strokeStyle = 'rgba(9,7,6,0.82)';
      ctx.lineWidth = sw[i];
      ctx.beginPath();
      ctx.moveTo(sx0[i], sy0[i]);
      ctx.lineTo(sx1[i], sy1[i]);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(150,138,120,0.16)';
      ctx.lineWidth = sw[i] * 0.6;
      ctx.beginPath();
      ctx.moveTo(sx0[i] + 0.8, sy0[i] + 0.8);
      ctx.lineTo(sx1[i] + 0.8, sy1[i] + 0.8);
      ctx.stroke();

      sdrawn[i] = 1;
      drew++;
    }

    ctx.restore();

    // Продвигаем курсор через непрерывный отрисованный префикс.
    while (drawCursor < segCount && sdrawn[drawCursor]) drawCursor++;

    return drew;
  };

  /**
   * Перерисовывает все уже проявившиеся трещины заново.
   * Нужно при смене размера поля: слой damage при этом обнуляется.
   */
  Cracks.redrawAll = function (ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    for (var i = 0; i < segCount; i++) {
      if (sat[i] > clock) continue;
      ctx.strokeStyle = 'rgba(9,7,6,0.82)';
      ctx.lineWidth = sw[i];
      ctx.beginPath();
      ctx.moveTo(sx0[i], sy0[i]);
      ctx.lineTo(sx1[i], sy1[i]);
      ctx.stroke();
      sdrawn[i] = 1;
    }
    ctx.restore();
    drawCursor = 0;
    while (drawCursor < segCount && sdrawn[drawCursor]) drawCursor++;
  };
})(typeof window !== 'undefined' ? window : globalThis);
