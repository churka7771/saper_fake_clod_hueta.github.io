/* ===========================================================================
 * util.js — базовые утилиты: RNG, математика, easing, шум, пулы.
 * Классический скрипт (без ES-модулей), чтобы работать с file://
 * Грузится ПЕРВЫМ. Всё вешается на глобальный namespace MS.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = (MS.util = {});

  /* --- Математика ------------------------------------------------------ */

  var TAU = Math.PI * 2;
  U.TAU = TAU;

  U.clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };

  U.clamp01 = function (v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  U.lerp = function (a, b, t) {
    return a + (b - a) * t;
  };

  /** Обратная интерполяция: где v лежит между a и b (0..1). */
  U.invLerp = function (a, b, v) {
    if (a === b) return 0;
    return U.clamp01((v - a) / (b - a));
  };

  /** Плавное отображение x из [i0,i1] в [o0,o1] с зажимом. */
  U.remap = function (x, i0, i1, o0, o1) {
    return U.lerp(o0, o1, U.invLerp(i0, i1, x));
  };

  /**
   * Кадронезависимое экспоненциальное затухание.
   * `rate` — какая доля значения остаётся за 1/60 секунды.
   * Позволяет писать decay(v, 0.92, dt) и получать одинаковый
   * результат при любом FPS.
   */
  U.decay = function (value, rate, dt) {
    return value * Math.pow(rate, dt * 60);
  };

  U.dist = function (x0, y0, x1, y1) {
    var dx = x1 - x0,
      dy = y1 - y0;
    return Math.sqrt(dx * dx + dy * dy);
  };

  U.dist2 = function (x0, y0, x1, y1) {
    var dx = x1 - x0,
      dy = y1 - y0;
    return dx * dx + dy * dy;
  };

  /* --- Easing ---------------------------------------------------------- */

  var ease = (U.ease = {});

  ease.linear = function (t) {
    return t;
  };
  ease.inQuad = function (t) {
    return t * t;
  };
  ease.outQuad = function (t) {
    return t * (2 - t);
  };
  ease.inCubic = function (t) {
    return t * t * t;
  };
  ease.outCubic = function (t) {
    var u = t - 1;
    return u * u * u + 1;
  };
  ease.inOutCubic = function (t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  ease.outQuart = function (t) {
    return 1 - Math.pow(1 - t, 4);
  };
  ease.outQuint = function (t) {
    return 1 - Math.pow(1 - t, 5);
  };
  ease.outExpo = function (t) {
    return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  };

  /** Перелёт за цель и возврат — для «pop» плиток. */
  ease.outBack = function (t, overshoot) {
    var s = overshoot === undefined ? 1.70158 : overshoot;
    var u = t - 1;
    return 1 + (s + 1) * u * u * u + s * u * u;
  };

  /** Затухающая пружина. Используется для подброса плиток взрывом. */
  ease.outElastic = function (t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var p = 0.3;
    return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * TAU) / p) + 1;
  };

  /**
   * Импульс: 0 -> 1 -> 0. Пик в t=0.5.
   * Удобно для вспышек и однократных всплесков.
   */
  ease.pulse = function (t) {
    if (t <= 0 || t >= 1) return 0;
    return Math.sin(t * Math.PI);
  };

  /* --- Детерминированный RNG (mulberry32) ------------------------------ */

  /**
   * Сид-RNG. Нужен для воспроизводимости в тестах и для того,
   * чтобы процедурные текстуры/трещины можно было повторить.
   */
  U.makeRng = function (seed) {
    var s = seed >>> 0;
    if (s === 0) s = 0x9e3779b9;
    function next() {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      /** [0,1) */
      next: next,
      /** [lo,hi) */
      range: function (lo, hi) {
        return lo + next() * (hi - lo);
      },
      /** Целое [lo,hi] включительно. */
      int: function (lo, hi) {
        return Math.floor(lo + next() * (hi - lo + 1));
      },
      /** Симметричный разброс: [-m, +m) */
      spread: function (m) {
        return (next() * 2 - 1) * m;
      },
      bool: function (p) {
        return next() < (p === undefined ? 0.5 : p);
      },
      pick: function (arr) {
        return arr[Math.floor(next() * arr.length)];
      },
      /** Случайное направление как [cos, sin]. */
      angle: function () {
        return next() * TAU;
      },
      reseed: function (n) {
        s = n >>> 0 || 0x9e3779b9;
      },
    };
  };

  /** Общий RNG для визуальных эффектов — детерминизм тут не нужен. */
  U.rng = U.makeRng((Math.random() * 0xffffffff) >>> 0);

  /* --- Value noise ----------------------------------------------------- */

  /**
   * 1D value-noise с кубической интерполяцией.
   * Используется для тряски экрана: даёт связное «дрожание»,
   * в отличие от белого шума, который выглядит как стробоскоп.
   */
  var NOISE_SIZE = 256;
  var NOISE_MASK = NOISE_SIZE - 1;
  var noiseTable = new Float32Array(NOISE_SIZE);
  (function initNoise() {
    var r = U.makeRng(0x1337beef);
    for (var i = 0; i < NOISE_SIZE; i++) noiseTable[i] = r.next() * 2 - 1;
  })();

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  /** 1D шум, результат примерно в [-1,1]. */
  U.noise1 = function (x) {
    var i = Math.floor(x);
    var f = x - i;
    var a = noiseTable[i & NOISE_MASK];
    var b = noiseTable[(i + 1) & NOISE_MASK];
    return U.lerp(a, b, smoothstep(f));
  };

  /** 2D value-noise на базе той же таблицы, [-1,1]. */
  U.noise2 = function (x, y) {
    var xi = Math.floor(x),
      yi = Math.floor(y);
    var xf = x - xi,
      yf = y - yi;
    var sx = smoothstep(xf),
      sy = smoothstep(yf);

    function at(ix, iy) {
      var h = (ix * 374761393 + iy * 668265263) | 0;
      h = (h ^ (h >>> 13)) * 1274126177;
      return noiseTable[(h ^ (h >>> 16)) & NOISE_MASK];
    }

    var n00 = at(xi, yi),
      n10 = at(xi + 1, yi);
    var n01 = at(xi, yi + 1),
      n11 = at(xi + 1, yi + 1);
    return U.lerp(U.lerp(n00, n10, sx), U.lerp(n01, n11, sx), sy);
  };

  /** Фрактальный шум (fBm). Для текстуры бетона и турбулентности огня. */
  U.fbm2 = function (x, y, octaves, lacunarity, gain) {
    var oct = octaves || 4;
    var lac = lacunarity || 2;
    var g = gain === undefined ? 0.5 : gain;
    var sum = 0,
      amp = 1,
      norm = 0,
      fx = x,
      fy = y;
    for (var i = 0; i < oct; i++) {
      sum += U.noise2(fx, fy) * amp;
      norm += amp;
      amp *= g;
      fx *= lac;
      fy *= lac;
    }
    return norm > 0 ? sum / norm : 0;
  };

  /* --- Цвет ------------------------------------------------------------ */

  /**
   * Градиент по контрольным точкам вида [pos, r, g, b].
   * Возвращает {r,g,b} в 0..255. Без аллокаций — пишет в out.
   */
  U.sampleRamp = function (ramp, t, out) {
    var o = out || { r: 0, g: 0, b: 0 };
    var n = ramp.length;
    if (n === 0) return o;
    t = U.clamp01(t);
    if (t <= ramp[0][0]) {
      o.r = ramp[0][1];
      o.g = ramp[0][2];
      o.b = ramp[0][3];
      return o;
    }
    var last = ramp[n - 1];
    if (t >= last[0]) {
      o.r = last[1];
      o.g = last[2];
      o.b = last[3];
      return o;
    }
    for (var i = 0; i < n - 1; i++) {
      var a = ramp[i],
        b = ramp[i + 1];
      if (t >= a[0] && t <= b[0]) {
        var lt = (t - a[0]) / (b[0] - a[0] || 1);
        o.r = a[1] + (b[1] - a[1]) * lt;
        o.g = a[2] + (b[2] - a[2]) * lt;
        o.b = a[3] + (b[3] - a[3]) * lt;
        return o;
      }
    }
    return o;
  };

  U.rgba = function (r, g, b, a) {
    return (
      'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')'
    );
  };

  /* --- Пул индексов (freelist) ----------------------------------------- */

  /**
   * Аллокатор слотов для систем частиц на плоских массивах.
   * Держит стек свободных индексов в Int32Array — ноль аллокаций
   * и никакого мусора для GC в горячем цикле.
   *
   * Стратегия при переполнении задаётся вызывающей стороной:
   * alloc() возвращает -1, и система сама решает — пропустить
   * спавн или переиспользовать самую старую частицу.
   */
  U.Freelist = function (capacity) {
    this.capacity = capacity;
    this.free = new Int32Array(capacity);
    this.freeCount = capacity;
    for (var i = 0; i < capacity; i++) {
      // Заполняем в обратном порядке, чтобы pop() выдавал 0,1,2...
      this.free[i] = capacity - 1 - i;
    }
  };

  U.Freelist.prototype.alloc = function () {
    if (this.freeCount === 0) return -1;
    return this.free[--this.freeCount];
  };

  U.Freelist.prototype.release = function (idx) {
    if (this.freeCount >= this.capacity) return;
    this.free[this.freeCount++] = idx;
  };

  U.Freelist.prototype.reset = function () {
    this.freeCount = this.capacity;
    for (var i = 0; i < this.capacity; i++) {
      this.free[i] = this.capacity - 1 - i;
    }
  };

  U.Freelist.prototype.usedCount = function () {
    return this.capacity - this.freeCount;
  };

  /* --- Прочее ---------------------------------------------------------- */

  /** Форматирование секунд в M:SS для HUD. */
  U.formatTime = function (seconds) {
    var s = Math.max(0, Math.floor(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  };

  /** Безопасный localStorage — в некоторых конфигурациях file:// он бросает. */
  U.storage = {
    get: function (key, fallback) {
      try {
        var v = root.localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        root.localStorage.setItem(key, String(value));
        return true;
      } catch (e) {
        return false;
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
