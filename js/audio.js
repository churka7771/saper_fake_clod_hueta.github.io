/* ===========================================================================
 * audio.js — весь звук синтезируется на WebAudio. Ни одного аудиофайла.
 *
 * Причина не только в размере: параметрический звук можно привязать
 * к силе взрыва, глубине каскада и интенсивности огня, чего не даёт
 * набор заранее записанных сэмплов.
 *
 * AudioContext создаётся лениво, по первому жесту пользователя —
 * иначе браузер заблокирует его политикой автовоспроизведения.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  var ctx = null;
  var master = null;
  var noiseBuffer = null;

  /** Шина огня: один непрерывный источник, громкость следит за пожаром. */
  var fireBus = null;

  var enabled = U.storage.get('ms.sound', '1') === '1';
  var started = false;

  /* Ограничитель одновременных взрывов: цепная детонация 99 мин
     иначе сложится в стену клиппинга вместо серии ударов. */
  var lastBoomTime = 0;
  var boomsInWindow = 0;

  /* --- Инициализация --------------------------------------------------- */

  function ensureContext() {
    if (ctx) return true;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;

    try {
      ctx = new AC();
    } catch (e) {
      return false;
    }

    master = ctx.createGain();
    master.gain.value = 0.85;

    // Мягкий лимитер на выходе: держит цепную детонацию в рамках
    // и не даёт звуку захлебнуться.
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;

    master.connect(limiter);
    limiter.connect(ctx.destination);

    noiseBuffer = makeNoiseBuffer(2.0);
    buildFireBus();
    return true;
  }

  /** Буфер белого шума — основа всех «неприятных» звуков. */
  function makeNoiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var r = U.makeRng(0xfeed1234);
    for (var i = 0; i < len; i++) data[i] = r.next() * 2 - 1;
    return buf;
  }

  /** Кривая мягкого перегруза — добавляет взрыву «грязи». */
  function makeDistortionCurve(amount) {
    var n = 1024;
    var curve = new Float32Array(n);
    var k = amount;
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function noiseSource() {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    return src;
  }

  /* --- Шина огня ------------------------------------------------------- */

  /**
   * Огонь звучит одним зацикленным источником шума через полосовой фильтр
   * с медленной модуляцией. Спавнить отдельный звук на каждую горящую
   * клетку — верный способ получить кашу и сжечь CPU.
   */
  function buildFireBus() {
    var src = noiseSource();
    src.loop = true;

    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.7;

    // Медленное «дыхание» пламени.
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.7;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 420;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);

    var gain = ctx.createGain();
    gain.gain.value = 0;

    src.connect(bp);
    bp.connect(gain);
    gain.connect(master);

    src.start(0);
    lfo.start(0);

    fireBus = { gain: gain, filter: bp };
  }

  /* --- Публичное API --------------------------------------------------- */

  var A = (MS.audio = {});

  /** Вызывается из обработчика ввода: там разрешено создавать контекст. */
  A.unlock = function () {
    if (!enabled) return;
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
  };

  A.isEnabled = function () {
    return enabled;
  };

  A.toggle = function () {
    enabled = !enabled;
    U.storage.set('ms.sound', enabled ? '1' : '0');
    if (!enabled) {
      if (fireBus) fireBus.gain.gain.value = 0;
      if (master) master.gain.value = 0;
    } else {
      A.unlock();
      if (master) master.gain.value = 0.85;
    }
    return enabled;
  };

  function ready() {
    return enabled && started && ctx;
  }

  /* --- Открытие клетки -------------------------------------------------- */

  /**
   * Короткий сухой щелчок. Питч растёт с глубиной каскада, поэтому
   * большое открытие звучит восходящей волной, а не трещоткой.
   *
   * @param {number} depth глубина в каскаде
   */
  A.reveal = function (depth) {
    if (!ready()) return;
    var t = ctx.currentTime;

    // Питч насыщается: у глубины 40 и 400 звук не должен различаться.
    var norm = 1 - Math.exp(-(depth || 0) / 9);
    var freq = 320 + norm * 900;

    var src = noiseSource();
    src.playbackRate.value = 1.4;

    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 3.2;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);

    src.connect(bp);
    bp.connect(g);
    g.connect(master);

    src.start(t);
    src.stop(t + 0.07);
  };

  /* --- Флаг ------------------------------------------------------------- */

  /** Механический двойной клик: втыкание флажка в бетон. */
  A.flag = function (placing) {
    if (!ready()) return;
    var t = ctx.currentTime;

    var src = noiseSource();
    src.playbackRate.value = 2.1;

    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = placing ? 2400 : 1500;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(placing ? 0.075 : 0.045, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 0.05);

    // Низкий «тук» при установке — добавляет весомости.
    if (placing) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(190, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.05);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.06, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(og);
      og.connect(master);
      osc.start(t);
      osc.stop(t + 0.07);
    }
  };

  /* --- Взрыв ------------------------------------------------------------ */

  /**
   * Взрыв — три слоя:
   *   1. Транзиент: очень короткий яркий щелчок, даёт «удар».
   *   2. Тело: шум через lowpass, частота падает 4000 -> 80 Гц.
   *      Именно спад частоты читается ухом как «взрыв», а не «шипение».
   *   3. Саб: синус 90 -> 28 Гц, ощущается телом, а не слышится.
   *
   * @param {number} power 0..1 — сила, влияет на длительность и глубину саба
   */
  A.explosion = function (power) {
    if (!ready()) return;

    var t = ctx.currentTime;
    var p = U.clamp01(power === undefined ? 1 : power);

    /* Плотная серия взрывов складывается в шум. Считаем взрывы
       в окне 120 мс и притапливаем каждый следующий: серия остаётся
       различимой, а не превращается в одну стену. */
    if (t - lastBoomTime < 0.12) boomsInWindow++;
    else boomsInWindow = 0;
    lastBoomTime = t;
    var crowd = 1 / (1 + boomsInWindow * 0.55);

    var dur = 0.5 + p * 0.55;
    var vol = (0.16 + p * 0.3) * crowd;

    /* --- Тело --- */
    var body = noiseSource();
    body.playbackRate.value = 0.8 + p * 0.3;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3600 + p * 1800, t);
    lp.frequency.exponentialRampToValueAtTime(80, t + dur * 0.85);
    lp.Q.value = 1.1;

    var shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(6 + p * 14);
    shaper.oversample = '2x';

    var bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    body.connect(lp);
    lp.connect(shaper);
    shaper.connect(bodyGain);
    bodyGain.connect(master);
    body.start(t);
    body.stop(t + dur + 0.05);

    /* --- Транзиент --- */
    var click = noiseSource();
    click.playbackRate.value = 3;
    var chp = ctx.createBiquadFilter();
    chp.type = 'highpass';
    chp.frequency.value = 1800;
    var cg = ctx.createGain();
    cg.gain.setValueAtTime(0.14 * crowd * (0.5 + p * 0.5), t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    click.connect(chp);
    chp.connect(cg);
    cg.connect(master);
    click.start(t);
    click.stop(t + 0.06);

    /* --- Саб --- */
    var sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(95 + p * 30, t);
    sub.frequency.exponentialRampToValueAtTime(26, t + dur * 0.7);
    var sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime((0.22 + p * 0.2) * crowd, t + 0.014);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    sub.connect(sg);
    sg.connect(master);
    sub.start(t);
    sub.stop(t + dur);

    /* --- Осыпающиеся обломки --- */
    // Затухающий шумовой хвост поверх — читается как падающий щебень.
    var rubble = noiseSource();
    rubble.playbackRate.value = 1.6;
    var rbp = ctx.createBiquadFilter();
    rbp.type = 'bandpass';
    rbp.frequency.setValueAtTime(2600, t + 0.06);
    rbp.frequency.exponentialRampToValueAtTime(900, t + dur);
    rbp.Q.value = 1.4;
    var rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t + 0.06);
    rg.gain.exponentialRampToValueAtTime(0.05 * crowd, t + 0.13);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.1);
    rubble.connect(rbp);
    rbp.connect(rg);
    rg.connect(master);
    rubble.start(t + 0.06);
    rubble.stop(t + dur * 1.2);
  };

  /* --- Огонь ------------------------------------------------------------ */

  /**
   * Громкость шины огня следит за суммарной интенсивностью пожара.
   * Ramp, а не мгновенное присваивание — иначе слышны щелчки.
   *
   * @param {number} intensity суммарная интенсивность (клампится внутри)
   */
  A.setFire = function (intensity) {
    if (!ready() || !fireBus) return;
    var target = U.clamp01(intensity / 6) * 0.13;
    var t = ctx.currentTime;
    fireBus.gain.gain.cancelScheduledValues(t);
    fireBus.gain.gain.setTargetAtTime(target, t, 0.25);
    // Крупный пожар звучит ниже и «тяжелее».
    fireBus.filter.frequency.setTargetAtTime(
      1100 - U.clamp01(intensity / 6) * 380,
      t,
      0.4
    );
  };

  /* --- Финал партии ----------------------------------------------------- */

  /** Победа: короткий восходящий аккорд поверх шипения. */
  A.win = function () {
    if (!ready()) return;
    var t = ctx.currentTime;
    var notes = [392, 494, 587, 784]; // G4 B4 D5 G5
    for (var i = 0; i < notes.length; i++) {
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = notes[i];
      var g = ctx.createGain();
      var at = t + i * 0.075;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
      osc.connect(g);
      g.connect(master);
      osc.start(at);
      osc.stop(at + 0.6);
    }
  };

  /** Проигрыш: нисходящий гул, «выключение света». */
  A.lose = function () {
    if (!ready()) return;
    var t = ctx.currentTime + 0.05;
    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 1.5);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 1.5);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);

    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 1.8);
  };

  /** Глушит всё разом — при рестарте посреди цепной детонации. */
  A.panic = function () {
    if (!ctx) return;
    if (fireBus) {
      fireBus.gain.gain.cancelScheduledValues(ctx.currentTime);
      fireBus.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
