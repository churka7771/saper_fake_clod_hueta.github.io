/* ===========================================================================
 * game.js — состояние партии, ввод, игровой цикл, цепная детонация.
 *
 * Здесь сходятся все системы. Модуль отвечает за три вещи:
 *   1. Порядок кадра: что обновляется и что рисуется, в каком порядке.
 *   2. Бюджет качества: при просадке FPS урезается количество частиц,
 *      но не количество событий — взрывы происходят все.
 *   3. Перевод игровых событий в эффекты: открытие -> пыль, мина -> взрыв.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS;
  var U = MS.util;
  var CELL = MS.CELL;
  var PHASE = MS.PHASE;

  var R = MS.render;
  var E = MS.effects;
  var P = MS.particles;
  var D = MS.debris;
  var F = MS.fire;
  var C = MS.cracks;
  var A = MS.audio;

  /* --- Состояние -------------------------------------------------------- */

  var board = null;
  var presetName = U.storage.get('ms.preset', 'intermediate');
  if (!MS.PRESETS[presetName]) presetName = 'intermediate';

  var running = false;
  var lastFrame = 0;
  var absTime = 0; // абсолютное немасштабированное время

  var startedAt = 0; // момент первого хода
  var elapsed = 0; // длительность партии, сек
  var timerActive = false;

  /** Очередь отложенных детонаций: [cellIdx, время, ...]. */
  var boomQueue = [];
  var boomCursor = 0;

  /** Задержка перед показом финального экрана, чтобы досмотреть взрывы. */
  var endcardAt = -1;

  /* Средний FPS и уровень качества. */
  var frameAccum = 0;
  var frameCount = 0;
  var fps = 60;
  var frameMs = 0;
  var quality = 1;

  var showMines = false;

  /* --- DOM -------------------------------------------------------------- */

  var el = {};

  function cacheDom() {
    el.stage = document.getElementById('stage');
    el.shaker = document.getElementById('shaker');
    el.field = document.getElementById('field');
    el.mines = document.getElementById('mines-value');
    el.time = document.getElementById('time-value');
    el.restart = document.getElementById('restart');
    el.difficulty = document.getElementById('difficulty');
    el.mute = document.getElementById('mute');
    el.flash = document.getElementById('flash');
    el.endcard = document.getElementById('endcard');
    el.endTitle = document.getElementById('end-title');
    el.endStats = document.getElementById('end-stats');
    el.endAgain = document.getElementById('end-again');
    el.dev = document.getElementById('devpanel');
    el.devFps = document.getElementById('dev-fps');
    el.devFrame = document.getElementById('dev-frame');
    el.devParticles = document.getElementById('dev-particles');
    el.devDebris = document.getElementById('dev-debris');
    el.devFire = document.getElementById('dev-fire');
    el.devQuality = document.getElementById('dev-quality');
  }

  /* --- Новая партия ----------------------------------------------------- */

  function newGame() {
    var p = MS.PRESETS[presetName];
    board = new MS.Board(p.w, p.h, p.mines);

    running = true;
    showMines = false;
    elapsed = 0;
    timerActive = false;
    startedAt = 0;
    boomQueue.length = 0;
    boomCursor = 0;
    endcardAt = -1;

    P.clear();
    D.clear();
    F.clear();
    C.clear();
    E.reset();
    A.panic();

    layout();
    R.resetTiles(board.size);
    R.clearDamage();
    R.markBgDirty();

    el.endcard.className = '';
    updateHud();
  }

  function layout() {
    // Оставляем запас под падинг сцены, чтобы поле не липло к краям.
    var availW = el.stage.clientWidth - 36;
    var availH = el.stage.clientHeight - 36;
    R.layout(board, Math.max(120, availW), Math.max(120, availH));
  }

  /* --- HUD -------------------------------------------------------------- */

  function updateHud() {
    var left = board.minesRemaining();
    var text = left < 0 ? '-' + pad(Math.abs(left)) : pad(left);
    if (el.mines.textContent !== text) el.mines.textContent = text;

    if (left < 0) el.mines.classList.add('over');
    else el.mines.classList.remove('over');

    var t = U.formatTime(elapsed);
    if (el.time.textContent !== t) el.time.textContent = t;
  }

  function pad(n) {
    return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n);
  }

  function syncDifficultyButtons() {
    var btns = el.difficulty.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-preset') === presetName) {
        btns[i].classList.add('active');
      } else {
        btns[i].classList.remove('active');
      }
    }
  }

  /* --- Ход: открытие ---------------------------------------------------- */

  function doReveal(idx) {
    if (!running || board.phase === PHASE.LOST || board.phase === PHASE.WON) return;

    var x = board.xOf(idx);
    var y = board.yOf(idx);
    var res = board.reveal(x, y);
    if (!res.ok) return;

    startTimer();

    if (res.hitMine) {
      onLoss(board.explodedAt);
      return;
    }

    scheduleRevealWave();

    if (res.won) onWin();
    updateHud();
  }

  function doChord(idx) {
    if (!running || board.phase !== PHASE.PLAYING) return;
    var res = board.chord(board.xOf(idx), board.yOf(idx));
    if (!res.ok) return;

    if (res.hitMine) {
      onLoss(board.explodedAt);
      return;
    }

    scheduleRevealWave();
    if (res.won) onWin();
    updateHud();
  }

  /**
   * Переносит пакет открытых клеток в анимацию, используя глубину каскада
   * как задержку. Именно это превращает открытие большой области из
   * мгновенной вспышки в расходящуюся волну.
   */
  function scheduleRevealWave() {
    var n = board.lastRevealCount;
    /* Шаг задержки уменьшается на больших каскадах: при 300 клетках
       фиксированные 28 мс на кольцо дали бы почти 3 секунды ожидания. */
    var maxDepth = board.lastRevealMaxDepth;
    var step = maxDepth > 14 ? 0.42 / Math.max(1, maxDepth) : 0.028;

    for (var k = 0; k < n; k++) {
      var idx = board.lastReveal[k * 2];
      var depth = board.lastReveal[k * 2 + 1];
      R.scheduleReveal(idx, depth * step, depth);
    }
  }

  function doFlag(idx) {
    if (!running || board.phase === PHASE.LOST || board.phase === PHASE.WON) return;
    var chg = board.cycleFlag(board.xOf(idx), board.yOf(idx), true);
    if (!chg) return;

    startTimer();

    if (chg.to === CELL.FLAGGED) {
      R.flagPlanted(idx);
      A.flag(true);
      // Небольшая пыль от втыкания штыря в бетон.
      P.dust(R.cellCenterX(idx), R.cellCenterY(idx) + R.view.cell * 0.28, 3, 3);
    } else {
      A.flag(false);
    }

    updateHud();
  }

  function startTimer() {
    if (timerActive) return;
    timerActive = true;
    startedAt = absTime;
  }

  /* --- Момент проявления плитки ----------------------------------------- */

  /**
   * Вызывается рендером, когда волна открытия доходит до плитки.
   * Здесь плитка «физически» вылетает: пыль, звук, лёгкий толчок.
   *
   * @param {number} depth глубина в каскаде — задаёт питч щелчка
   */
  function onTileAppear(idx, cx, cy, depth) {
    var cell = R.view.cell;

    // Пыль из-под снятой плитки. На низком качестве урезается.
    var n = quality >= 1 ? 4 : quality >= 0.6 ? 2 : 1;
    P.dust(cx, cy, n, cell * 0.3);

    /* Звук нужен не каждой плитке: каскад на 200 клеток превратился бы
       в неразборчивый треск. Озвучиваем цифры (они несут информацию)
       и каждую четвёртую пустую клетку — ритм волны сохраняется,
       а плотность щелчков остаётся терпимой.

       Питч растёт с глубиной каскада, поэтому большое открытие
       звучит как восходящая волна, расходящаяся от курсора. */
    if (board.adj[idx] > 0 || (idx & 3) === 0) {
      A.reveal(depth);
    }
  }

  /* --- Проигрыш и цепная детонация -------------------------------------- */

  function onLoss(epicenter) {
    board.phase = PHASE.LOST;
    showMines = true;
    timerActive = false;
    A.lose();

    // Взрыв под курсором — немедленно, на полную силу, с замедлением.
    detonate(epicenter, 1, true);

    /* Остальные мины детонируют волной от эпицентра. Задержка растёт
       с расстоянием, поэтому по полю проходит фронт, а не хаос.
       Это главный визуальный момент всей игры. */
    var mines = board.allMines();
    var ex = R.cellCenterX(epicenter);
    var ey = R.cellCenterY(epicenter);
    var cell = R.view.cell;

    var items = [];
    for (var i = 0; i < mines.length; i++) {
      var m = mines[i];
      if (m === epicenter) continue;
      var d = U.dist(ex, ey, R.cellCenterX(m), R.cellCenterY(m)) / cell;
      items.push({ idx: m, d: d });
    }
    items.sort(function (a, b) {
      return a.d - b.d;
    });

    boomQueue.length = 0;
    boomCursor = 0;
    var last = 0;
    for (var j = 0; j < items.length; j++) {
      // 55 мс на клетку расстояния + разброс, чтобы фронт не был линейкой.
      var t = absTime + 0.18 + items[j].d * 0.055 + U.rng.range(0, 0.06);
      boomQueue.push(items[j].idx, t);
      if (t > last) last = t;
    }

    // Финальный экран — после того, как отгремит последний взрыв.
    endcardAt = last + 1.3;
  }

  /**
   * Полный взрыв в клетке: свет, звук, частицы, разрушение, огонь.
   *
   * @param {number} idx
   * @param {number} power 0..1
   * @param {boolean} primary первый взрыв (ошибка игрока) или звено цепи
   */
  function detonate(idx, power, primary) {
    var cell = R.view.cell;
    var x = R.cellCenterX(idx);
    var y = R.cellCenterY(idx);

    /* Плотность эффектов = качество × запас пула.
     *
     * Без учёта давления на пул происходит следующее: при цепной
     * детонации первые взрывы забивают пул целиком, а у последующих
     * alloc() начинает возвращать -1. Спавн идёт по порядку вызовов,
     * поэтому огненный шар успевает родиться, а дым — уже нет.
     * В итоге поздние взрывы выглядят иначе, чем ранние, причём
     * теряется именно дым, который держит вид после взрыва.
     *
     * Учёт давления заранее и равномерно прореживает ВСЕ типы частиц,
     * так что каждый взрыв остаётся полноценным по составу.
     */
    var pressure = P.count() / P.capacity();
    var q = quality * (1 - pressure * 0.72);
    // Даже в самой гуще взрыв обязан быть виден.
    if (q < 0.18) q = 0.18;

    /* --- звук и экран ---
     *
     * Экранные эффекты у первого взрыва и у звеньев цепи принципиально
     * разной силы, и это не «на глаз», а из арифметики затухания.
     *
     * Тряска гаснет как ×0.9 за кадр. Звенья цепи идут каждые ~50 мс,
     * то есть каждые три кадра. Если каждое добавляет 0.42, счётчик
     * травмы упирается в 1 и держится там все пять секунд детонации:
     * 26 пикселей тряски без остановки. Играть и смотреть невозможно.
     * При вкладе 0.13 равновесие выходит около 0.48, а смещение — это
     * квадрат травмы, то есть примерно 6 пикселей. Получается ровный
     * гул под серией взрывов вместо болтанки.
     *
     * Та же логика у вспышки: 0.12 на звено даёт равновесие около 0.19
     * вместо залитого белым экрана.
     *
     * Замедление времени вообще принадлежит только первому взрыву.
     * Это драматическая пауза на моменте ошибки. Если его продлевать
     * каждым звеном, вся цепочка играет в замедленной съёмке, при том
     * что очередь детонаций живёт по реальным часам — взрывы уходят
     * вперёд, а частицы от них ещё еле ползут.
     */
    A.explosion(power);
    if (primary) {
      E.addTrauma(0.5);
      E.flash(0.55);
      E.slowMo(0.3, 0.14);
    } else {
      E.addTrauma(0.13 * power);
      E.flash(0.12 * power);
    }
    E.shockwave(x, y, power, cell * (5 + power * 7));

    /* --- частицы --- */
    P.fireball(x, y, Math.round(26 * power * q) + 2, power, cell * 0.45);
    P.sparks(x, y, Math.round(52 * power * q) + 3, power);
    P.embers(x, y, Math.round(16 * power * q) + 1, power);
    P.smoke(x, y, Math.round(18 * power * q) + 2, power, cell * 0.4);

    /* --- разрушение --- */
    board.destroyed[idx] = 1;
    R.punchHole(idx);
    R.scorch(x, y, cell * (1.5 + power * 1.4), 0.85 * power);
    C.spawn(x, y, power, cell, quality);

    var texSize = R.tileTexture().width;
    // Осколки тоже прореживаются по заполненности своего пула.
    var dPressure = D.count() / D.capacity();
    var dq = Math.max(0.25, quality * (1 - dPressure * 0.6));
    D.shatter(
      (idx % board.w) * cell,
      ((idx / board.w) | 0) * cell,
      cell,
      x, y,
      power,
      texSize,
      dq
    );

    /* --- соседи --- */
    // Радиус поражения ~1.6 клетки: соседние плитки подбрасывает,
    // пачкает копотью, а часть из них разлетается осколками.
    var radius = cell * (1.3 + power * 0.8);
    board.forEachNeighbor(idx, function (n) {
      var nx = R.cellCenterX(n);
      var ny = R.cellCenterY(n);
      var d = U.dist(x, y, nx, ny);
      var falloff = U.clamp01(1 - d / radius);
      if (falloff <= 0) return;

      R.knock(n, 5 + falloff * 16 * power);
      R.addScorch(n, falloff * 0.5 * power);

      // Часть соседей осыпается крошкой.
      if (!board.destroyed[n] && U.rng.bool(falloff * 0.45 * power)) {
        D.chips(nx, ny, Math.round(3 * q) + 1, cell, texSize, power * falloff);
      }
    });

    // Дальние клетки только трясёт — без копоти и осколков.
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
        var cx2 = (idx % board.w) + dx;
        var cy2 = ((idx / board.w) | 0) + dy;
        if (cx2 < 0 || cy2 < 0 || cx2 >= board.w || cy2 >= board.h) continue;
        R.knock(cy2 * board.w + cx2, 2 + power * 4);
      }
    }

    /* --- огонь --- */
    F.ignite(idx, x, y, power);
    // Иногда занимается и соседняя клетка — пожар выглядит неровным.
    board.forEachNeighbor(idx, function (n) {
      if (U.rng.bool(0.32 * power)) {
        F.ignite(n, R.cellCenterX(n), R.cellCenterY(n), power * 0.55);
      }
    });
  }

  /** Разбирает очередь отложенных детонаций. */
  function processBoomQueue() {
    while (boomCursor < boomQueue.length && boomQueue[boomCursor + 1] <= absTime) {
      var idx = boomQueue[boomCursor];
      boomCursor += 2;
      if (board.destroyed[idx]) continue;
      // Цепные взрывы слабее первого: иначе экран не успокаивается.
      detonate(idx, U.rng.range(0.62, 0.9), false);
    }
  }

  /* --- Победа ----------------------------------------------------------- */

  function onWin() {
    timerActive = false;
    A.win();
    saveBestTime();

    // Все обезвреженные мины дают короткую искру — «отбой».
    var mines = board.allMines();
    for (var i = 0; i < mines.length; i++) {
      P.sparks(R.cellCenterX(mines[i]), R.cellCenterY(mines[i]), 5, 0.25);
    }
    E.flash(0.14);
    endcardAt = absTime + 0.9;
  }

  /* --- Рекорды ---------------------------------------------------------- */

  function bestKey() {
    return 'ms.best.' + presetName;
  }

  function getBestTime() {
    var v = parseFloat(U.storage.get(bestKey(), ''));
    return isNaN(v) ? null : v;
  }

  function saveBestTime() {
    var prev = getBestTime();
    if (prev === null || elapsed < prev) {
      U.storage.set(bestKey(), elapsed.toFixed(1));
      return true;
    }
    return false;
  }

  /* --- Финальный экран -------------------------------------------------- */

  function showEndcard() {
    var won = board.phase === PHASE.WON;
    el.endcard.className = 'show ' + (won ? 'won' : 'lost');
    el.endTitle.textContent = won ? 'Разминировано' : 'Подрыв';

    var best = getBestTime();
    var opened = board.revealedCount;
    var total = board.safeCells();
    var lines = [];

    if (won) {
      lines.push('Время: <b>' + U.formatTime(elapsed) + '</b>');
      if (best !== null) {
        lines.push(
          elapsed <= best
            ? 'Новый рекорд'
            : 'Лучшее: <b>' + U.formatTime(best) + '</b>'
        );
      }
    } else {
      lines.push('Открыто: <b>' + opened + ' / ' + total + '</b>');
      lines.push('Прогресс: <b>' + Math.round((opened / total) * 100) + '%</b>');
      lines.push('Время: <b>' + U.formatTime(elapsed) + '</b>');
    }

    el.endStats.innerHTML = lines.join('<br>');
  }

  /* --- Игровой цикл ----------------------------------------------------- */

  function frame(now) {
    root.requestAnimationFrame(frame);

    var t0 = now;
    if (!lastFrame) lastFrame = now;

    /* Ограничение dt: после переключения таба now прыгает на секунды,
       и физика без клампа выбросила бы все осколки за пределы поля. */
    var dt = Math.min((now - lastFrame) / 1000, 1 / 30);
    lastFrame = now;
    absTime += dt;

    // Масштабированное время для всего, что должно замедляться.
    var sdt = dt * E.timeScale();

    if (timerActive) elapsed = absTime - startedAt;

    /* --- обновление --- */
    E.update(dt, absTime);
    processBoomQueue();

    R.update(sdt, board, onTileAppear);
    P.update(sdt, absTime);
    D.update(sdt, onDebrisImpact);
    F.update(sdt, quality);
    A.setFire(F.totalIntensity());

    /* Горящие клетки постепенно обугливаются. Копоть копится в
       визуальном состоянии плитки, поэтому след от пожара остаётся
       и после того, как пламя погасло. */
    if (F.count() > 0) {
      F.forEach(function (cellIdx, fx, fy, intensity) {
        R.addScorch(cellIdx, intensity * sdt * 0.42);
      });
    }

    // Трещины растут в реальном времени: замедленные, они отставали бы
    // от разлёта осколков и выглядели отдельным эффектом.
    C.update(dt, R.ctx('damage'));

    if (endcardAt > 0 && absTime >= endcardAt) {
      endcardAt = -1;
      showEndcard();
    }

    /* --- отрисовка --- */
    draw();

    E.applyShake(el.shaker);
    updateHud();

    /* --- метрики --- */
    frameMs = (root.performance.now() - t0) || frameMs;
    trackQuality(dt);
    if (devVisible) updateDevPanel();
  }

  function draw() {
    R.drawBackground();

    /* --- слой main --- */
    R.drawField(board, showMines);

    // Свет от огня ложится на плитки ПОД частицами пламени —
    // иначе подсветка соседних клеток не читается.
    var fireOn = F.count() > 0;
    if (fireOn) {
      var lctx = R.beginLight();
      F.drawLight(lctx, R.view.cell);
      R.applyLight(0.9);
    }

    // Осколки — поверх плиток и света.
    D.draw(R.ctx('main'), R.tileTexture(), R.tileTextureCharred(), R.view.cell);

    /* Тепловое искажение и искажение ударной волны требуют снимка холста.
       Оба дороги, поэтому включаются только на полном качестве. */
    if (quality >= 1) {
      var needSnapshot = (fireOn && F.totalIntensity() > 0.15) || E.waveCount() > 0;
      if (needSnapshot) {
        var snap = R.snapshotMain();
        var mctx = R.ctx('main');
        E.drawWaveDistortion(mctx, snap);
        F.drawHeatDistortion(mctx, snap, R.view.cell, 1);
      }

      /* Хроматическая аберрация — самый дорогой эффект в игре: шесть
         проходов по холсту. Оправдана только на пике тряски, где живёт
         доли секунды и читается как удар по камере. */
      var trauma = E.getTrauma();
      if (trauma > 0.15) {
        R.applyAberration(trauma * trauma * 5);
      }
    }

    // Зерно — последним по слою main, поверх всего остального.
    // Дёшево, поэтому работает на любом качестве.
    R.applyGrain(quality >= 1 ? 0.055 : 0.04);

    /* --- слой fx --- */
    var fctx = R.beginFx();
    P.draw(fctx, R.clock());
    E.drawWaves(fctx);

    // Свечение только когда есть чему светиться.
    if (quality >= 0.6 && (P.count() > 0 || E.waveCount() > 0)) {
      R.applyBloom(quality >= 1 ? 0.55 : 0.4);
    }
  }

  /** Осколок ударился о низ поля — маленький выброс пыли. */
  function onDebrisImpact(x, y, speed) {
    if (quality < 0.6) return;
    var n = speed > 500 ? 3 : 2;
    P.dust(x, y, n, 3);
  }

  /* --- Адаптивное качество ---------------------------------------------- */

  /**
   * Следит за FPS и понижает качество при просадке.
   *
   * Принципиально: урезается только ПЛОТНОСТЬ эффектов (число частиц,
   * осколков, лучей трещин, наличие искажений). Сами события —
   * взрывы, разрушения, огонь — не отменяются никогда. Иначе на слабой
   * машине игра теряла бы не кадры, а содержание.
   */
  function trackQuality(dt) {
    frameAccum += dt;
    frameCount++;
    if (frameAccum < 0.5) return;

    fps = frameCount / frameAccum;
    frameAccum = 0;
    frameCount = 0;

    // Гистерезис: без него качество дёргается туда-обратно на границе.
    if (fps < 42 && quality > 0.35) {
      quality = quality >= 1 ? 0.6 : 0.35;
    } else if (fps > 55 && quality < 1) {
      quality = quality <= 0.35 ? 0.6 : 1;
    }
  }

  /* --- Dev-панель ------------------------------------------------------- */

  var devVisible = false;

  function toggleDev() {
    devVisible = !devVisible;
    el.dev.classList.toggle('show', devVisible);
  }

  function updateDevPanel() {
    el.devFps.textContent = fps.toFixed(0);
    el.devFrame.textContent = frameMs.toFixed(1) + ' мс';
    el.devParticles.textContent = P.count() + ' / ' + P.capacity();
    el.devDebris.textContent = D.count();
    el.devFire.textContent = F.count() + ' (' + F.totalIntensity().toFixed(1) + ')';
    el.devQuality.textContent = quality.toFixed(2);
  }

  function devBoomRandom() {
    if (!board.minesPlaced) board.placeMines(0);
    var mines = board.allMines();
    var candidates = [];
    for (var i = 0; i < mines.length; i++) {
      if (!board.destroyed[mines[i]]) candidates.push(mines[i]);
    }
    if (candidates.length === 0) return;
    detonate(candidates[(Math.random() * candidates.length) | 0], 1, true);
  }

  function devBoomAll() {
    if (!board.minesPlaced) board.placeMines(0);
    showMines = true;
    var mines = board.allMines();
    boomQueue.length = 0;
    boomCursor = 0;
    for (var i = 0; i < mines.length; i++) {
      if (board.destroyed[mines[i]]) continue;
      boomQueue.push(mines[i], absTime + i * 0.045 + U.rng.range(0, 0.04));
    }
  }

  function devRevealAll() {
    if (!board.minesPlaced) board.placeMines(0);
    for (var i = 0; i < board.size; i++) {
      if (board.mine[i] || board.state[i] === CELL.REVEALED) continue;
      board.state[i] = CELL.REVEALED;
      board.revealedCount++;
      R.revealNow(i);
    }
    showMines = true;
    updateHud();
  }

  /* --- Ввод ------------------------------------------------------------- */

  /** Отслеживание зажатых кнопок для chord двумя клавишами одновременно. */
  var buttonsDown = 0;

  function bindInput() {
    var canvas = R.layer('fx').canvas;
    // fx-слой лежит сверху, поэтому именно он получает события.
    // Остальные слои для мыши прозрачны.
    canvas.style.pointerEvents = 'auto';

    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    canvas.addEventListener('mousemove', function (e) {
      var idx = R.hitTest(e.clientX, e.clientY, board);
      R.setHover(idx);
    });

    canvas.addEventListener('mouseleave', function () {
      R.setHover(-1);
    });

    canvas.addEventListener('mousedown', function (e) {
      A.unlock();
      buttonsDown = e.buttons;
    });

    canvas.addEventListener('mouseup', function (e) {
      var idx = R.hitTest(e.clientX, e.clientY, board);
      if (idx < 0) return;

      /* Обе кнопки зажаты одновременно — классический chord.
         Проверяем состояние ДО отпускания: e.buttons здесь уже
         не содержит отпущенную кнопку. */
      var wasBoth = (buttonsDown & 1) && (buttonsDown & 2);
      buttonsDown = e.buttons;

      if (wasBoth || e.button === 1) {
        doChord(idx);
        return;
      }

      if (e.button === 0) doReveal(idx);
      else if (e.button === 2) doFlag(idx);
    });

    // Тач: тап открывает, долгое нажатие ставит флаг.
    var touchTimer = null;
    var touchIdx = -1;
    var touchFlagged = false;

    canvas.addEventListener(
      'touchstart',
      function (e) {
        A.unlock();
        if (e.touches.length !== 1) return;
        e.preventDefault();
        var t = e.touches[0];
        touchIdx = R.hitTest(t.clientX, t.clientY, board);
        touchFlagged = false;
        R.setHover(touchIdx);

        touchTimer = root.setTimeout(function () {
          if (touchIdx >= 0) {
            doFlag(touchIdx);
            touchFlagged = true;
          }
        }, 320);
      },
      { passive: false }
    );

    canvas.addEventListener('touchend', function (e) {
      if (touchTimer) root.clearTimeout(touchTimer);
      touchTimer = null;
      if (touchIdx >= 0 && !touchFlagged) doReveal(touchIdx);
      touchIdx = -1;
      R.setHover(-1);
      e.preventDefault();
    });

    canvas.addEventListener('touchmove', function () {
      // Палец сдвинулся — отменяем долгое нажатие.
      if (touchTimer) {
        root.clearTimeout(touchTimer);
        touchTimer = null;
      }
      touchIdx = -1;
    });

    /* --- клавиатура --- */
    root.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var k = e.key;

      if (k === 'r' || k === 'R' || k === 'к' || k === 'К') {
        newGame();
        return;
      }
      if (k === '1') setPreset('beginner');
      else if (k === '2') setPreset('intermediate');
      else if (k === '3') setPreset('expert');
      else if (k === 'm' || k === 'M' || k === 'ь' || k === 'Ь') toggleMute();
      else if (k === '`' || k === '~' || k === 'ё' || k === 'Ё') toggleDev();
    });

    /* --- HUD --- */
    el.restart.addEventListener('click', function () {
      A.unlock();
      newGame();
    });

    el.endAgain.addEventListener('click', function () {
      newGame();
    });

    el.difficulty.addEventListener('click', function (e) {
      var p = e.target.getAttribute && e.target.getAttribute('data-preset');
      if (p) {
        A.unlock();
        setPreset(p);
      }
    });

    el.mute.addEventListener('click', toggleMute);

    document.getElementById('dev-boom').addEventListener('click', devBoomRandom);
    document.getElementById('dev-boom-all').addEventListener('click', devBoomAll);
    document.getElementById('dev-reveal').addEventListener('click', devRevealAll);

    /* --- ресайз --- */
    var resizeTimer = null;
    root.addEventListener('resize', function () {
      // Дебаунс: пересборка текстур на каждый пиксель перетаскивания окна
      // заметно тормозит.
      if (resizeTimer) root.clearTimeout(resizeTimer);
      resizeTimer = root.setTimeout(onResize, 140);
    });
  }

  /**
   * Пересчёт раскладки. Слой damage при смене размера обнуляется,
   * поэтому накопленные разрушения перерисовываются заново.
   */
  function onResize() {
    layout();
    R.clearDamage();
    R.markBgDirty();

    // Восстанавливаем дыры и подпалины в новом масштабе.
    for (var i = 0; i < board.size; i++) {
      if (board.destroyed[i]) {
        R.punchHole(i);
        R.scorch(R.cellCenterX(i), R.cellCenterY(i), R.view.cell * 2, 0.7);
      }
    }
    C.redrawAll(R.ctx('damage'));
  }

  function setPreset(name) {
    if (!MS.PRESETS[name]) return;
    presetName = name;
    U.storage.set('ms.preset', name);
    syncDifficultyButtons();
    newGame();
  }

  function toggleMute() {
    var on = A.toggle();
    el.mute.textContent = on ? '\u266A' : '\u2715';
    el.mute.classList.toggle('active', !on);
  }

  /* --- Запуск ----------------------------------------------------------- */

  function boot() {
    cacheDom();

    R.init(el.field, {
      bg: 'layer-bg',
      damage: 'layer-damage',
      main: 'layer-main',
      fx: 'layer-fx',
    });

    E.init();
    E.bindFlash(el.flash);
    P.init();
    F.init();

    // При включённом prefers-reduced-motion сразу снижаем плотность:
    // такие настройки обычно ставят не только из-за укачивания,
    // но и на слабых машинах.
    if (E.isReducedMotion()) quality = 0.6;

    syncDifficultyButtons();
    el.mute.textContent = A.isEnabled() ? '\u266A' : '\u2715';
    el.mute.classList.toggle('active', !A.isEnabled());

    newGame();
    bindInput();

    root.requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
