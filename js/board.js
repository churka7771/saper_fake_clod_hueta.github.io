/* ===========================================================================
 * board.js — ЧИСТАЯ логика сапёра. Никакого рендера, DOM или Canvas.
 *
 * Отделено намеренно: этот файл грузится и в браузере, и в Node
 * (см. tests.html и tools/run-tests.js), поэтому логику можно
 * верифицировать в терминале без браузера.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS || (root.MS = {});
  var U = MS.util;

  /* --- Константы ------------------------------------------------------- */

  /** Состояние клетки. */
  var CELL = {
    HIDDEN: 0,
    REVEALED: 1,
    FLAGGED: 2,
    QUESTION: 3,
  };

  /** Состояние партии. */
  var PHASE = {
    /** Мины ещё не расставлены — ждём первый клик. */
    READY: 0,
    PLAYING: 1,
    /** Мина взорвана, идёт цепная детонация. */
    LOST: 2,
    WON: 3,
  };

  var PRESETS = {
    beginner: { w: 9, h: 9, mines: 10, label: 'Новичок' },
    intermediate: { w: 16, h: 16, mines: 40, label: 'Любитель' },
    expert: { w: 30, h: 16, mines: 99, label: 'Профи' },
  };

  /** Смещения 8 соседей. */
  var NX = [-1, 0, 1, -1, 1, -1, 0, 1];
  var NY = [-1, -1, -1, 0, 0, 1, 1, 1];

  /* --- Board ----------------------------------------------------------- */

  /**
   * @param {number} w  ширина в клетках
   * @param {number} h  высота в клетках
   * @param {number} mines  количество мин
   * @param {number} [seed] сид для расстановки мин (для тестов)
   */
  function Board(w, h, mines, seed) {
    this.w = Math.max(2, w | 0);
    this.h = Math.max(2, h | 0);
    this.size = this.w * this.h;

    // Мин не может быть больше, чем клеток минус одна:
    // иначе первый клик гарантированно на мине и игра невозможна.
    this.mines = U.clamp(mines | 0, 1, this.size - 1);

    this.seed = seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : seed >>> 0;
    this.rng = U.makeRng(this.seed);

    /* Данные клеток — плоские типизированные массивы.
       Индекс клетки = y * w + x. */
    this.mine = new Uint8Array(this.size);
    this.adj = new Uint8Array(this.size);
    this.state = new Uint8Array(this.size); // CELL.*

    /** Клетка уничтожена взрывом (дыра в поле). Только визуал. */
    this.destroyed = new Uint8Array(this.size);

    this.phase = PHASE.READY;
    this.minesPlaced = false;

    this.revealedCount = 0;
    this.flagCount = 0;

    /** Индекс мины, на которой проиграли. -1 если не проиграли. */
    this.explodedAt = -1;

    /** Клетки, ошибочно помеченные флагом (заполняется при проигрыше). */
    this.wrongFlags = [];

    /* Буферы для flood fill. Аллоцируются один раз, переиспользуются —
       открытие каскада не создаёт мусор. Посещённость помечается
       возрастающим токеном, поэтому очищать буфер между ходами не нужно. */
    this._queue = new Int32Array(this.size);
    this._depth = new Int32Array(this.size);
    this._visitToken = 0;
    this._visitStamp = new Int32Array(this.size);

    /**
     * Результат последнего reveal(): список открытых клеток с глубиной
     * каскада. Рендер использует depth для задержки анимации,
     * чтобы открытие расходилось волной.
     * Формат: [idx0, depth0, idx1, depth1, ...]
     */
    this.lastReveal = new Int32Array(this.size * 2);
    this.lastRevealCount = 0;
    this.lastRevealMaxDepth = 0;
  }

  Board.prototype.idx = function (x, y) {
    return y * this.w + x;
  };

  Board.prototype.xOf = function (idx) {
    return idx % this.w;
  };

  Board.prototype.yOf = function (idx) {
    return (idx / this.w) | 0;
  };

  Board.prototype.inBounds = function (x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  };

  /** Количество клеток без мин — столько нужно открыть для победы. */
  Board.prototype.safeCells = function () {
    return this.size - this.mines;
  };

  /**
   * Вызывает fn(neighborIdx, nx, ny) для каждого существующего соседа.
   * Инлайн-цикл вместо аллокации массива соседей.
   */
  Board.prototype.forEachNeighbor = function (idx, fn) {
    var x = idx % this.w;
    var y = (idx / this.w) | 0;
    for (var i = 0; i < 8; i++) {
      var nx = x + NX[i];
      var ny = y + NY[i];
      if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
      fn(ny * this.w + nx, nx, ny);
    }
  };

  /* --- Расстановка мин ------------------------------------------------- */

  /**
   * Расставляет мины, гарантируя что клетка `safeIdx` и, по возможности,
   * её 8 соседей свободны.
   *
   * Зачем: первый клик по одиночной цифре — это чистая лотерея.
   * Если освободить и соседей, первый клик всегда открывает каскад,
   * то есть даёт реальную информацию для игры.
   *
   * Если мин слишком много и 9 клеток освободить нельзя, откатываемся
   * к защите только самой клетки (классическое поведение).
   */
  Board.prototype.placeMines = function (safeIdx) {
    if (this.minesPlaced) return;

    var i;
    var excluded = [];
    var wantWideSafe = this.size - this.mines >= 9;

    excluded.push(safeIdx);
    if (wantWideSafe) {
      this.forEachNeighbor(safeIdx, function (n) {
        excluded.push(n);
      });
    }

    // Метим исключённые, чтобы не попали в пул кандидатов.
    var isExcluded = new Uint8Array(this.size);
    for (i = 0; i < excluded.length; i++) isExcluded[excluded[i]] = 1;

    // Пул кандидатов + частичный Фишер–Йетс.
    // Берём ровно `mines` первых элементов перемешивания — это даёт
    // равномерное распределение без повторных попыток («rejection sampling»
    // деградирует, когда мин почти столько же, сколько клеток).
    var pool = new Int32Array(this.size);
    var poolLen = 0;
    for (i = 0; i < this.size; i++) {
      if (!isExcluded[i]) pool[poolLen++] = i;
    }

    var count = Math.min(this.mines, poolLen);
    for (i = 0; i < count; i++) {
      var j = i + Math.floor(this.rng.next() * (poolLen - i));
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      this.mine[pool[i]] = 1;
    }

    // Если пул оказался меньше нужного числа мин (крайний случай:
    // мин почти столько же, сколько клеток), доставляем мины
    // в исключённых соседей, но НИКОГДА в саму safeIdx.
    if (count < this.mines) {
      for (i = 0; i < excluded.length && count < this.mines; i++) {
        var e = excluded[i];
        if (e === safeIdx || this.mine[e]) continue;
        this.mine[e] = 1;
        count++;
      }
    }

    this.mines = count;
    this._computeAdjacency();
    this.minesPlaced = true;
  };

  /** Считает число мин-соседей для каждой клетки. */
  Board.prototype._computeAdjacency = function () {
    var w = this.w,
      h = this.h;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var idx = y * w + x;
        if (this.mine[idx]) {
          this.adj[idx] = 0;
          continue;
        }
        var n = 0;
        for (var k = 0; k < 8; k++) {
          var nx = x + NX[k],
            ny = y + NY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (this.mine[ny * w + nx]) n++;
        }
        this.adj[idx] = n;
      }
    }
  };

  /* --- Открытие клеток ------------------------------------------------- */

  Board.prototype._resetLastReveal = function () {
    this.lastRevealCount = 0;
    this.lastRevealMaxDepth = 0;
  };

  Board.prototype._pushReveal = function (idx, depth) {
    var p = this.lastRevealCount * 2;
    this.lastReveal[p] = idx;
    this.lastReveal[p + 1] = depth;
    this.lastRevealCount++;
    if (depth > this.lastRevealMaxDepth) this.lastRevealMaxDepth = depth;
  };

  /**
   * Открывает клетку.
   *
   * @returns {object} результат:
   *   {ok, hitMine, revealed, won, firstClick}
   *   `revealed` — сколько клеток открылось (детали в lastReveal).
   */
  Board.prototype.reveal = function (x, y) {
    var res = {
      ok: false,
      hitMine: false,
      revealed: 0,
      won: false,
      firstClick: false,
    };

    if (this.phase === PHASE.LOST || this.phase === PHASE.WON) return res;
    if (!this.inBounds(x, y)) return res;

    var idx = this.idx(x, y);

    // Флаг защищает от случайного открытия — это осознанная
    // договорённость игрока с собой, её нельзя игнорировать.
    if (this.state[idx] === CELL.FLAGGED) return res;
    if (this.state[idx] === CELL.REVEALED) return res;

    this._resetLastReveal();

    if (!this.minesPlaced) {
      this.placeMines(idx);
      this.phase = PHASE.PLAYING;
      res.firstClick = true;
    }

    res.ok = true;

    if (this.mine[idx]) {
      this.state[idx] = CELL.REVEALED;
      this.explodedAt = idx;
      this.phase = PHASE.LOST;
      this._collectWrongFlags();
      res.hitMine = true;
      this._pushReveal(idx, 0);
      res.revealed = 1;
      return res;
    }

    var opened = this._floodFill(idx);
    res.revealed = opened;

    if (this.revealedCount >= this.safeCells()) {
      this.phase = PHASE.WON;
      this._flagAllMines();
      res.won = true;
    }

    return res;
  };

  /**
   * BFS-открытие от клетки. Пустые клетки (adj===0) продолжают волну,
   * клетки с цифрой открываются и волну останавливают.
   *
   * Пишет глубину волны в lastReveal — рендер по ней задерживает
   * анимацию, и каскад визуально расходится кольцами от курсора.
   */
  Board.prototype._floodFill = function (startIdx) {
    var w = this.w,
      h = this.h;
    var queue = this._queue;
    var depth = this._depth;
    var stamp = this._visitStamp;
    var token = ++this._visitToken;

    var head = 0,
      tail = 0;
    queue[tail] = startIdx;
    depth[startIdx] = 0;
    stamp[startIdx] = token;
    tail++;

    var opened = 0;

    while (head < tail) {
      var idx = queue[head];
      var d = depth[idx];
      head++;

      if (this.state[idx] === CELL.REVEALED) continue;
      // Флаг останавливает волну на этой клетке: игрок считает её миной,
      // не вскрываем автоматически.
      if (this.state[idx] === CELL.FLAGGED) continue;
      if (this.mine[idx]) continue;

      this.state[idx] = CELL.REVEALED;
      this.revealedCount++;
      opened++;
      this._pushReveal(idx, d);

      if (this.adj[idx] !== 0) continue;

      var x = idx % w;
      var y = (idx / w) | 0;
      for (var k = 0; k < 8; k++) {
        var nx = x + NX[k],
          ny = y + NY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var n = ny * w + nx;
        if (stamp[n] === token) continue;
        if (this.state[n] === CELL.REVEALED) continue;
        if (this.mine[n]) continue;
        stamp[n] = token;
        depth[n] = d + 1;
        queue[tail++] = n;
      }
    }

    return opened;
  };

  /* --- Флаги ----------------------------------------------------------- */

  /**
   * Циклически меняет метку: HIDDEN -> FLAGGED -> [QUESTION] -> HIDDEN.
   * @param {boolean} useQuestion включать ли промежуточный «?»
   */
  Board.prototype.cycleFlag = function (x, y, useQuestion) {
    if (this.phase === PHASE.LOST || this.phase === PHASE.WON) return null;
    if (!this.inBounds(x, y)) return null;

    var idx = this.idx(x, y);
    var st = this.state[idx];
    if (st === CELL.REVEALED) return null;

    var next;
    if (st === CELL.HIDDEN) {
      next = CELL.FLAGGED;
    } else if (st === CELL.FLAGGED) {
      next = useQuestion ? CELL.QUESTION : CELL.HIDDEN;
    } else {
      next = CELL.HIDDEN;
    }

    if (st === CELL.FLAGGED) this.flagCount--;
    if (next === CELL.FLAGGED) this.flagCount++;

    this.state[idx] = next;

    // Первый ход флагом тоже запускает партию (и таймер).
    if (this.phase === PHASE.READY) this.phase = PHASE.PLAYING;

    return { idx: idx, from: st, to: next };
  };

  /** Сколько мин осталось по мнению игрока (может быть отрицательным). */
  Board.prototype.minesRemaining = function () {
    return this.mines - this.flagCount;
  };

  /* --- Chording (открытие по цифре) ------------------------------------ */

  /**
   * Если на открытой цифре стоит ровно столько флагов, сколько она
   * показывает, открывает всех остальных соседей.
   *
   * Это ускоряет игру в разы, но наказывает за неверно поставленный
   * флаг — что честно.
   */
  Board.prototype.chord = function (x, y) {
    var res = { ok: false, hitMine: false, revealed: 0, won: false };
    if (this.phase !== PHASE.PLAYING) return res;
    if (!this.inBounds(x, y)) return res;

    var idx = this.idx(x, y);
    if (this.state[idx] !== CELL.REVEALED) return res;
    var need = this.adj[idx];
    if (need === 0) return res;

    var self = this;
    var flags = 0;
    var targets = [];
    this.forEachNeighbor(idx, function (n) {
      if (self.state[n] === CELL.FLAGGED) flags++;
      else if (self.state[n] === CELL.HIDDEN || self.state[n] === CELL.QUESTION) {
        targets.push(n);
      }
    });

    if (flags !== need || targets.length === 0) return res;

    res.ok = true;
    this._resetLastReveal();

    // Сначала проверяем все цели на мины: если хоть одна — проигрыш,
    // и взрывается именно она (а не «первая по индексу» после
    // частичного открытия). Порядок важен для корректного эпицентра.
    var hit = -1;
    for (var i = 0; i < targets.length; i++) {
      if (this.mine[targets[i]]) {
        hit = targets[i];
        break;
      }
    }

    if (hit >= 0) {
      this.state[hit] = CELL.REVEALED;
      this.explodedAt = hit;
      this.phase = PHASE.LOST;
      this._collectWrongFlags();
      this._pushReveal(hit, 0);
      res.hitMine = true;
      res.revealed = 1;
      return res;
    }

    // Открываем каждую цель через flood fill. lastReveal не сбрасывается
    // между целями, поэтому все открытые области попадают в один пакет
    // с сохранением глубины волны.
    var total = 0;
    for (var j = 0; j < targets.length; j++) {
      var t = targets[j];
      if (this.state[t] === CELL.REVEALED) continue;
      total += this._floodFill(t);
    }
    res.revealed = total;

    if (this.revealedCount >= this.safeCells()) {
      this.phase = PHASE.WON;
      this._flagAllMines();
      res.won = true;
    }

    return res;
  };

  /* --- Завершение партии ----------------------------------------------- */

  /** Собирает флаги, стоявшие не на минах — рендер их перечёркивает. */
  Board.prototype._collectWrongFlags = function () {
    this.wrongFlags.length = 0;
    for (var i = 0; i < this.size; i++) {
      if (this.state[i] === CELL.FLAGGED && !this.mine[i]) {
        this.wrongFlags.push(i);
      }
    }
  };

  /** При победе автоматически помечает все мины — приятная мелочь. */
  Board.prototype._flagAllMines = function () {
    for (var i = 0; i < this.size; i++) {
      if (this.mine[i] && this.state[i] !== CELL.FLAGGED) {
        this.state[i] = CELL.FLAGGED;
        this.flagCount++;
      }
    }
  };

  /** Список индексов всех мин — нужен для цепной детонации. */
  Board.prototype.allMines = function () {
    var out = [];
    for (var i = 0; i < this.size; i++) if (this.mine[i]) out.push(i);
    return out;
  };

  /* --- Отладка --------------------------------------------------------- */

  /**
   * Текстовый дамп поля. Используется в тестах для наглядных
   * сообщений об ошибках.
   *   '#' скрыта, 'F' флаг, '?' вопрос, '*' мина(открытая), '.' пусто, '1..8'
   */
  Board.prototype.toString = function (revealAll) {
    var lines = [];
    for (var y = 0; y < this.h; y++) {
      var row = '';
      for (var x = 0; x < this.w; x++) {
        var i = this.idx(x, y);
        var st = this.state[i];
        if (!revealAll && st === CELL.HIDDEN) row += '#';
        else if (!revealAll && st === CELL.FLAGGED) row += 'F';
        else if (!revealAll && st === CELL.QUESTION) row += '?';
        else if (this.mine[i]) row += '*';
        else if (this.adj[i] === 0) row += '.';
        else row += String(this.adj[i]);
      }
      lines.push(row);
    }
    return lines.join('\n');
  };

  /* --- Экспорт --------------------------------------------------------- */

  MS.CELL = CELL;
  MS.PHASE = PHASE;
  MS.PRESETS = PRESETS;
  MS.Board = Board;
  MS.NEIGHBOR_X = NX;
  MS.NEIGHBOR_Y = NY;
})(typeof window !== 'undefined' ? window : globalThis);
