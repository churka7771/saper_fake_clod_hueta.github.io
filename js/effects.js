/* ===========================================================================
 * effects.js — экранные эффекты: тряска, ударные волны, вспышка, slow-mo.
 *
 * Модель тряски — «trauma»: взрывы накидывают травму в общий счётчик,
 * который экспоненциально гаснет. Смещение считается как trauma², что даёт
 * резкий удар с быстрым спадом вместо ровного затухающего колебания.
 * Один счётчик на всю сцену естественным образом складывает серию взрывов.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  var E = (MS.effects = {});

  /* --- Тряска ---------------------------------------------------------- */

  var trauma = 0;
  var shakeX = 0;
  var shakeY = 0;
  var shakeRot = 0;

  /** Максимальная амплитуда в CSS-пикселях при trauma = 1. */
  var MAX_SHAKE = 26;
  var MAX_ROT = 0.016;

  /** Уважение к prefers-reduced-motion: считывается один раз при старте. */
  var reducedMotion = false;

  E.init = function () {
    try {
      reducedMotion =
        root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      reducedMotion = false;
    }
  };

  E.isReducedMotion = function () {
    return reducedMotion;
  };

  /**
   * Добавляет травму. Клампится в 1, поэтому цепная детонация
   * не улетает в неконтролируемую болтанку.
   */
  E.addTrauma = function (amount) {
    if (reducedMotion) return;
    trauma = U.clamp01(trauma + amount);
  };

  E.getTrauma = function () {
    return trauma;
  };

  E.shakeOffsetX = function () {
    return shakeX;
  };
  E.shakeOffsetY = function () {
    return shakeY;
  };

  /* --- Замедление времени ---------------------------------------------- */

  var timeScale = 1;
  var slowTarget = 1;
  var slowHold = 0;

  /**
   * Кратковременное замедление на момент взрыва: удар «читается»,
   * прежде чем разлёт уйдёт в полную скорость.
   *
   * @param {number} scale насколько замедлить (0..1)
   * @param {number} hold  сколько держать, сек
   */
  E.slowMo = function (scale, hold) {
    if (reducedMotion) return;
    // Не отменяем более сильное замедление более слабым.
    if (scale < slowTarget) {
      slowTarget = scale;
      timeScale = scale;
    }
    slowHold = Math.max(slowHold, hold);
  };

  E.timeScale = function () {
    return timeScale;
  };

  /* --- Вспышка --------------------------------------------------------- */

  var flashValue = 0;
  var flashEl = null;

  E.bindFlash = function (el) {
    flashEl = el;
  };

  /** @param {number} amount 0..1 */
  E.flash = function (amount) {
    if (reducedMotion) return;
    if (amount > flashValue) flashValue = U.clamp01(amount);
  };

  /* --- Ударные волны --------------------------------------------------- */

  var MAX_WAVES = 24;
  var wx = new Float32Array(MAX_WAVES);
  var wy = new Float32Array(MAX_WAVES);
  var wr = new Float32Array(MAX_WAVES); // текущий радиус
  var wmax = new Float32Array(MAX_WAVES); // радиус, на котором волна гаснет
  var wspeed = new Float32Array(MAX_WAVES);
  var wpower = new Float32Array(MAX_WAVES);
  var walive = new Uint8Array(MAX_WAVES);

  /**
   * @param {number} x,y   эпицентр
   * @param {number} power 0..1
   * @param {number} maxR  максимальный радиус
   */
  E.shockwave = function (x, y, power, maxR) {
    for (var i = 0; i < MAX_WAVES; i++) {
      if (walive[i]) continue;
      walive[i] = 1;
      wx[i] = x;
      wy[i] = y;
      wr[i] = 0;
      wmax[i] = maxR;
      wspeed[i] = 620 + power * 700;
      wpower[i] = power;
      return i;
    }
    // Все слоты заняты — волна просто не рождается. При таком
    // количестве одновременных волн одной больше или меньше незаметно.
    return -1;
  };

  E.waveCount = function () {
    var n = 0;
    for (var i = 0; i < MAX_WAVES; i++) if (walive[i]) n++;
    return n;
  };

  /* --- Обновление ------------------------------------------------------ */

  /**
   * @param {number} dt   НЕмасштабированное время
   * @param {number} time абсолютное время для шума тряски
   */
  E.update = function (dt, time) {
    /* --- тряска --- */
    if (trauma > 0.0001) {
      trauma = U.decay(trauma, 0.9, dt);
      if (trauma < 0.0005) trauma = 0;

      /* Квадрат травмы: короткий жёсткий удар вместо длинного качания.
         Смещение берётся из связного шума — белый шум выглядел бы
         как стробоскоп, а не как сотрясение. */
      var t2 = trauma * trauma;
      shakeX = U.noise1(time * 27) * MAX_SHAKE * t2;
      shakeY = U.noise1(time * 27 + 53.7) * MAX_SHAKE * t2;
      shakeRot = U.noise1(time * 19 + 128.3) * MAX_ROT * t2;
    } else {
      shakeX = shakeY = shakeRot = 0;
    }

    /* --- замедление --- */
    if (slowHold > 0) {
      slowHold -= dt;
    } else if (timeScale < 1) {
      // Возврат к нормальной скорости — плавный, за ~0.6 сек.
      timeScale += dt / 0.6;
      if (timeScale >= 1) {
        timeScale = 1;
        slowTarget = 1;
      }
    }

    /* --- вспышка --- */
    if (flashValue > 0) {
      // Гаснет очень быстро: вспышка должна ослеплять, а не заливать экран.
      flashValue = U.decay(flashValue, 0.72, dt);
      if (flashValue < 0.004) flashValue = 0;
      if (flashEl) flashEl.style.opacity = flashValue.toFixed(3);
    } else if (flashEl && flashEl.style.opacity !== '0') {
      flashEl.style.opacity = '0';
    }

    /* --- ударные волны --- */
    for (var i = 0; i < MAX_WAVES; i++) {
      if (!walive[i]) continue;
      wr[i] += wspeed[i] * dt;
      // Волна замедляется по мере расширения.
      wspeed[i] *= Math.exp(-1.5 * dt);
      if (wr[i] >= wmax[i]) walive[i] = 0;
    }
  };

  /** Применяет тряску к контейнеру. Трансформ композитится на GPU. */
  E.applyShake = function (el) {
    if (!el) return;
    if (shakeX === 0 && shakeY === 0 && shakeRot === 0) {
      if (el.style.transform !== '') el.style.transform = '';
      return;
    }
    el.style.transform =
      'translate3d(' +
      shakeX.toFixed(2) +
      'px,' +
      shakeY.toFixed(2) +
      'px,0) rotate(' +
      shakeRot.toFixed(4) +
      'rad)';
  };

  /* --- Отрисовка ударных волн ------------------------------------------ */

  /**
   * Светящееся кольцо на fx-слое.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  E.drawWaves = function (ctx) {
    var active = false;
    for (var i = 0; i < MAX_WAVES; i++) if (walive[i]) { active = true; break; }
    if (!active) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (var j = 0; j < MAX_WAVES; j++) {
      if (!walive[j]) continue;

      var progress = wr[j] / wmax[j];
      // Кольцо гаснет быстрее, чем расширяется: пик яркости — в начале.
      var alpha = (1 - progress) * (1 - progress) * (0.32 + wpower[j] * 0.4);
      if (alpha <= 0.006) continue;

      // Фронт утолщается по мере расширения — так волна «размывается».
      var thickness = (2 + wpower[j] * 3) * (1 + progress * 3.5);

      ctx.strokeStyle = U.rgba(255, 228 - progress * 90, 190 - progress * 120, alpha);
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.arc(wx[j], wy[j], wr[j], 0, U.TAU);
      ctx.stroke();

      // Внутреннее тонкое кольцо — уплотнение сразу за фронтом.
      if (progress < 0.5) {
        ctx.strokeStyle = U.rgba(255, 255, 245, alpha * 0.5);
        ctx.lineWidth = thickness * 0.35;
        ctx.beginPath();
        ctx.arc(wx[j], wy[j], wr[j] * 0.86, 0, U.TAU);
        ctx.stroke();
      }
    }

    ctx.restore();
  };

  /**
   * Геометрическое искажение по фронту волны: содержимое холста
   * растягивается радиально наружу.
   *
   * Реализовано кольцевыми секторами (24 штуки) через drawImage с
   * клипом — это единственный способ получить подобие радиального
   * смещения в Canvas 2D без попиксельной обработки.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} snapshot копия холста до искажения
   */
  E.drawWaveDistortion = function (ctx, snapshot) {
    var SECTORS = 24;
    var step = U.TAU / SECTORS;

    for (var j = 0; j < MAX_WAVES; j++) {
      if (!walive[j]) continue;

      var progress = wr[j] / wmax[j];
      if (progress > 0.75) continue; // на исходе искажать уже нечего

      var push = (1 - progress) * (1 - progress) * (5 + wpower[j] * 11);
      if (push < 0.4) continue;

      var band = 22 + wpower[j] * 26;
      var inner = Math.max(0, wr[j] - band * 0.5);
      var outer = wr[j] + band * 0.5;

      for (var s = 0; s < SECTORS; s++) {
        var a0 = s * step;
        var a1 = a0 + step * 1.06; // перекрытие, чтобы не было щелей

        ctx.save();
        ctx.beginPath();
        ctx.arc(wx[j], wy[j], outer, a0, a1);
        ctx.arc(wx[j], wy[j], inner, a1, a0, true);
        ctx.closePath();
        ctx.clip();

        // Сдвигаем содержимое от центра по нормали сектора.
        var mid = (a0 + a1) * 0.5;
        ctx.drawImage(snapshot, Math.cos(mid) * push, Math.sin(mid) * push);
        ctx.restore();
      }
    }
  };

  /* --- Сброс ----------------------------------------------------------- */

  E.reset = function () {
    trauma = 0;
    shakeX = shakeY = shakeRot = 0;
    timeScale = 1;
    slowTarget = 1;
    slowHold = 0;
    flashValue = 0;
    if (flashEl) flashEl.style.opacity = '0';
    for (var i = 0; i < MAX_WAVES; i++) walive[i] = 0;
  };
})(typeof window !== 'undefined' ? window : globalThis);
