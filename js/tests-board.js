/* ===========================================================================
 * tests-board.js — проверки чистой логики сапёра.
 *
 * Один и тот же файл запускается:
 *   - в терминале:  node tools/run-tests.js
 *   - в браузере:   tests.html
 *
 * Без фреймворков: минимальный набор ассертов, понятный вывод.
 * =========================================================================== */
(function (root) {
  'use strict';

  var MS = root.MS;
  var CELL = MS.CELL;
  var PHASE = MS.PHASE;
  var Board = MS.Board;

  /* --- Мини-раннер ----------------------------------------------------- */

  function Runner() {
    this.results = [];
    this.current = null;
  }

  Runner.prototype.test = function (name, fn) {
    var rec = { name: name, pass: true, errors: [], asserts: 0 };
    this.current = rec;
    try {
      fn(this);
    } catch (e) {
      rec.pass = false;
      rec.errors.push('ИСКЛЮЧЕНИЕ: ' + (e && e.message ? e.message : String(e)));
    }
    this.current = null;
    this.results.push(rec);
    return rec;
  };

  Runner.prototype.ok = function (cond, msg) {
    this.current.asserts++;
    if (!cond) {
      this.current.pass = false;
      // Больше 5 однотипных ошибок не нужны — они мешают читать вывод.
      if (this.current.errors.length < 5) this.current.errors.push(msg);
      else if (this.current.errors.length === 5) {
        this.current.errors.push('… (остальные ошибки подавлены)');
      }
    }
    return cond;
  };

  Runner.prototype.eq = function (actual, expected, msg) {
    return this.ok(
      actual === expected,
      msg + ' (получено ' + actual + ', ожидалось ' + expected + ')'
    );
  };

  Runner.prototype.summary = function () {
    var passed = 0,
      failed = 0,
      asserts = 0;
    for (var i = 0; i < this.results.length; i++) {
      asserts += this.results[i].asserts;
      if (this.results[i].pass) passed++;
      else failed++;
    }
    return { passed: passed, failed: failed, asserts: asserts, total: this.results.length };
  };

  /* --- Помощники ------------------------------------------------------- */

  /** Независимый пересчёт соседних мин — «второе мнение» для adj. */
  function bruteAdj(b, x, y) {
    var n = 0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h) continue;
        if (b.mine[ny * b.w + nx]) n++;
      }
    }
    return n;
  }

  function countMines(b) {
    var n = 0;
    for (var i = 0; i < b.size; i++) n += b.mine[i];
    return n;
  }

  /**
   * Играет партию «идеально»: открывает все безопасные клетки.
   * Возвращает финальную фазу. Используется для проверки победы.
   */
  function playPerfect(b, firstX, firstY) {
    b.reveal(firstX, firstY);
    var guard = 0;
    while (b.phase === PHASE.PLAYING && guard++ < b.size * 2) {
      var found = -1;
      for (var i = 0; i < b.size; i++) {
        if (!b.mine[i] && b.state[i] !== CELL.REVEALED) {
          found = i;
          break;
        }
      }
      if (found < 0) break;
      b.reveal(b.xOf(found), b.yOf(found));
    }
    return b.phase;
  }

  /* --- Тесты ----------------------------------------------------------- */

  function runAll() {
    var r = new Runner();

    /* ---------------------------------------------------------------- */
    r.test('Конструктор: размеры и зажим числа мин', function (t) {
      var b = new Board(9, 9, 10, 1);
      t.eq(b.w, 9, 'ширина');
      t.eq(b.h, 9, 'высота');
      t.eq(b.size, 81, 'всего клеток');
      t.eq(b.mines, 10, 'мин');
      t.eq(b.phase, PHASE.READY, 'начальная фаза READY');
      t.eq(b.minesPlaced, false, 'мины ещё не расставлены');

      // Мин не может быть >= числа клеток: иначе играть невозможно.
      var over = new Board(3, 3, 999, 1);
      t.ok(over.mines <= over.size - 1, 'число мин зажато до size-1');

      var under = new Board(3, 3, -5, 1);
      t.ok(under.mines >= 1, 'число мин не меньше 1');
    });

    /* ---------------------------------------------------------------- */
    r.test('Индексация: idx/xOf/yOf согласованы', function (t) {
      var b = new Board(7, 5, 5, 2);
      for (var y = 0; y < b.h; y++) {
        for (var x = 0; x < b.w; x++) {
          var i = b.idx(x, y);
          t.ok(b.xOf(i) === x && b.yOf(i) === y, 'обратимость для ' + x + ',' + y);
        }
      }
      t.eq(b.inBounds(-1, 0), false, 'x=-1 вне поля');
      t.eq(b.inBounds(0, -1), false, 'y=-1 вне поля');
      t.eq(b.inBounds(7, 0), false, 'x=w вне поля');
      t.eq(b.inBounds(0, 5), false, 'y=h вне поля');
      t.eq(b.inBounds(6, 4), true, 'угол внутри поля');
    });

    /* ---------------------------------------------------------------- */
    r.test('Соседи: количество на углах, краях и в центре', function (t) {
      var b = new Board(5, 5, 3, 3);
      function countNeighbors(x, y) {
        var n = 0;
        b.forEachNeighbor(b.idx(x, y), function () {
          n++;
        });
        return n;
      }
      t.eq(countNeighbors(0, 0), 3, 'угол — 3 соседа');
      t.eq(countNeighbors(4, 0), 3, 'угол — 3 соседа');
      t.eq(countNeighbors(0, 4), 3, 'угол — 3 соседа');
      t.eq(countNeighbors(4, 4), 3, 'угол — 3 соседа');
      t.eq(countNeighbors(2, 0), 5, 'край — 5 соседей');
      t.eq(countNeighbors(0, 2), 5, 'край — 5 соседей');
      t.eq(countNeighbors(2, 2), 8, 'центр — 8 соседей');

      // Соседи должны быть уникальны.
      var seen = {};
      var dupes = 0;
      b.forEachNeighbor(b.idx(2, 2), function (n) {
        if (seen[n]) dupes++;
        seen[n] = 1;
      });
      t.eq(dupes, 0, 'нет дублей среди соседей');
    });

    /* ---------------------------------------------------------------- */
    r.test('Расстановка: точное число мин на 300 сидах', function (t) {
      for (var s = 1; s <= 300; s++) {
        var b = new Board(12, 10, 25, s);
        b.reveal(5, 5);
        var actual = countMines(b);
        if (!t.eq(actual, b.mines, 'сид ' + s + ': число мин на поле')) break;
        if (!t.eq(b.mines, 25, 'сид ' + s + ': запрошенное число мин сохранено')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Безопасность первого клика: 500 сидов, клетка и 8 соседей чисты', function (t) {
      for (var s = 1; s <= 500; s++) {
        var b = new Board(9, 9, 10, s);
        // Специально кликаем в угол — там соседей меньше,
        // это чаще ловит ошибки с выходом за границы.
        var cx = s % 3 === 0 ? 0 : s % 3 === 1 ? 8 : 4;
        var cy = s % 2 === 0 ? 0 : 4;
        var res = b.reveal(cx, cy);

        if (!t.eq(res.hitMine, false, 'сид ' + s + ': первый клик не на мине')) break;
        if (!t.eq(res.firstClick, true, 'сид ' + s + ': помечен как первый клик')) break;

        var idx = b.idx(cx, cy);
        if (!t.eq(b.mine[idx], 0, 'сид ' + s + ': сама клетка без мины')) break;

        var bad = 0;
        b.forEachNeighbor(idx, function (n) {
          if (b.mine[n]) bad++;
        });
        if (!t.eq(bad, 0, 'сид ' + s + ': соседи первого клика без мин')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Первый клик всегда открывает каскад (>1 клетки)', function (t) {
      // Следствие безопасной зоны 3x3: клетка первого клика имеет adj=0,
      // значит flood fill обязан раскрыть больше одной клетки.
      for (var s = 1; s <= 200; s++) {
        var b = new Board(10, 10, 15, s);
        var res = b.reveal(4, 4);
        if (!t.ok(res.revealed > 1, 'сид ' + s + ': открылось ' + res.revealed + ' клеток')) break;
        if (!t.eq(b.adj[b.idx(4, 4)], 0, 'сид ' + s + ': клетка первого клика пустая')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Тесное поле: безопасна только сама клетка, мин ровно size-1', function (t) {
      // Крайний случай: 3x3 и 8 мин. Освободить 3x3 невозможно,
      // должен сработать откат к защите только самой клетки.
      var b = new Board(3, 3, 8, 7);
      var res = b.reveal(1, 1);
      t.eq(res.hitMine, false, 'первый клик всё равно безопасен');
      t.eq(countMines(b), 8, 'все 8 мин расставлены');
      t.eq(b.mine[b.idx(1, 1)], 0, 'центр свободен');
      t.eq(b.adj[b.idx(1, 1)], 8, 'центр окружён 8 минами');
      t.eq(b.phase, PHASE.WON, 'открыв единственную безопасную клетку — победа');
    });

    /* ---------------------------------------------------------------- */
    r.test('Подсчёт соседних мин совпадает с независимым пересчётом', function (t) {
      for (var s = 1; s <= 100; s++) {
        var b = new Board(14, 11, 30, s * 13);
        b.reveal(7, 5);
        var mismatch = 0;
        for (var y = 0; y < b.h; y++) {
          for (var x = 0; x < b.w; x++) {
            var i = b.idx(x, y);
            if (b.mine[i]) continue;
            if (b.adj[i] !== bruteAdj(b, x, y)) mismatch++;
          }
        }
        if (!t.eq(mismatch, 0, 'сид ' + s + ': расхождений в adj')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Flood fill: не открывает мины и полностью раскрывает нули', function (t) {
      for (var s = 1; s <= 200; s++) {
        var b = new Board(16, 16, 40, s * 7 + 1);
        b.reveal(8, 8);

        var revealedMines = 0;
        var incompleteZeros = 0;

        for (var i = 0; i < b.size; i++) {
          if (b.state[i] !== CELL.REVEALED) continue;
          if (b.mine[i]) revealedMines++;

          // Инвариант: если открыта пустая клетка, все её соседи
          // тоже обязаны быть открыты. Иначе каскад остановился рано.
          if (b.adj[i] === 0) {
            b.forEachNeighbor(i, function (n) {
              if (b.state[n] !== CELL.REVEALED) incompleteZeros++;
            });
          }
        }

        if (!t.eq(revealedMines, 0, 'сид ' + s + ': открытых мин')) break;
        if (!t.eq(incompleteZeros, 0, 'сид ' + s + ': необойдённых соседей у пустых клеток')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Flood fill: глубина волны корректна', function (t) {
      for (var s = 1; s <= 80; s++) {
        var b = new Board(20, 20, 20, s * 53 + 4242);
        var res = b.reveal(10, 10);
        if (!t.ok(res.revealed > 1, 'сид ' + s + ': каскад открылся')) break;

        // Глубина стартовой клетки — 0, и она первая в пакете.
        if (!t.eq(b.lastReveal[0], b.idx(10, 10), 'сид ' + s + ': первая в пакете — клетка клика')) break;
        if (!t.eq(b.lastReveal[1], 0, 'сид ' + s + ': её глубина 0')) break;

        // BFS обязан выдавать неубывающую глубину.
        var prev = 0;
        var nonMonotonic = 0;
        var depthOf = {};
        for (var k = 0; k < b.lastRevealCount; k++) {
          var idx = b.lastReveal[k * 2];
          var d = b.lastReveal[k * 2 + 1];
          if (d < prev) nonMonotonic++;
          prev = d;
          depthOf[idx] = d;
        }
        if (!t.eq(nonMonotonic, 0, 'сид ' + s + ': глубина не убывает по ходу пакета')) break;
        if (!t.eq(b.lastRevealCount, res.revealed, 'сид ' + s + ': размер пакета равен числу открытых')) break;

        /* Инварианты глубины различаются для пустых клеток и цифр,
           потому что цифры — листья волны: они попадают в очередь,
           но сами её не продолжают.

           Цифра получает глубину от первой (самой близкой) пустой
           клетки, которая её обнаружила. Более глубокая пустая клетка,
           тоже соседняя с ней, застаёт её уже посещённой — поэтому
           разница глубин с цифрой может быть больше 1, и это нормально.

           Отсюда:
             пустая <-> пустая  :  |d1 - d2| <= 1  (ребро в обе стороны)
             пустая  -> цифра   :  d[цифра] <= d[пустая] + 1  (ребро односторонне) */
        var zeroToZero = 0;
        var zeroToNumber = 0;
        for (var key in depthOf) {
          var ci = +key;
          if (b.adj[ci] !== 0) continue; // волну продолжают только пустые
          (function (cell, cd) {
            b.forEachNeighbor(cell, function (n) {
              if (depthOf[n] === undefined) return;
              if (b.adj[n] === 0) {
                if (Math.abs(depthOf[n] - cd) > 1) zeroToZero++;
              } else if (depthOf[n] > cd + 1) {
                zeroToNumber++;
              }
            });
          })(ci, depthOf[ci]);
        }
        if (!t.eq(zeroToZero, 0, 'сид ' + s + ': смежные пустые отличаются по глубине максимум на 1')) break;
        if (!t.eq(zeroToNumber, 0, 'сид ' + s + ': цифра не глубже чем на 1 от обнаружившей её пустой')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Флаг блокирует открытие и останавливает каскад', function (t) {
      var b = new Board(12, 12, 10, 555);
      b.reveal(0, 0); // запускаем партию и расставляем мины

      // Ищем закрытую пустую клетку рядом с открытой областью.
      var target = -1;
      for (var i = 0; i < b.size; i++) {
        if (b.state[i] === CELL.HIDDEN && !b.mine[i] && b.adj[i] === 0) {
          target = i;
          break;
        }
      }

      if (target < 0) {
        t.ok(true, 'подходящей клетки нет — тест неприменим на этом сиде');
        return;
      }

      b.cycleFlag(b.xOf(target), b.yOf(target), false);
      t.eq(b.state[target], CELL.FLAGGED, 'флаг поставлен');

      var res = b.reveal(b.xOf(target), b.yOf(target));
      t.eq(res.ok, false, 'клик по флагу игнорируется');
      t.eq(b.state[target], CELL.FLAGGED, 'состояние не изменилось');

      // Каскад из соседней клетки не должен вскрыть флаг.
      var neighborOpened = false;
      b.forEachNeighbor(target, function (n) {
        if (!b.mine[n] && b.state[n] === CELL.HIDDEN) {
          b.reveal(b.xOf(n), b.yOf(n));
          neighborOpened = true;
        }
      });
      if (neighborOpened) {
        t.eq(b.state[target], CELL.FLAGGED, 'каскад не вскрыл флаг');
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Циклы метки и счётчик флагов', function (t) {
      var b = new Board(8, 8, 10, 99);

      // Без «вопроса»: HIDDEN -> FLAGGED -> HIDDEN
      b.cycleFlag(0, 0, false);
      t.eq(b.state[0], CELL.FLAGGED, 'поставлен флаг');
      t.eq(b.flagCount, 1, 'счётчик флагов = 1');
      t.eq(b.minesRemaining(), 9, 'осталось мин по счётчику');

      b.cycleFlag(0, 0, false);
      t.eq(b.state[0], CELL.HIDDEN, 'флаг снят');
      t.eq(b.flagCount, 0, 'счётчик флагов = 0');

      // С «вопросом»: HIDDEN -> FLAGGED -> QUESTION -> HIDDEN
      b.cycleFlag(1, 1, true);
      t.eq(b.state[b.idx(1, 1)], CELL.FLAGGED, 'флаг');
      t.eq(b.flagCount, 1, 'флаг учтён');
      b.cycleFlag(1, 1, true);
      t.eq(b.state[b.idx(1, 1)], CELL.QUESTION, 'вопрос');
      t.eq(b.flagCount, 0, 'вопрос не считается флагом');
      b.cycleFlag(1, 1, true);
      t.eq(b.state[b.idx(1, 1)], CELL.HIDDEN, 'снято');

      // Счётчик может уйти в минус — это нормально, игрок ошибается.
      var b2 = new Board(8, 8, 2, 100);
      b2.cycleFlag(0, 0, false);
      b2.cycleFlag(1, 0, false);
      b2.cycleFlag(2, 0, false);
      t.eq(b2.minesRemaining(), -1, 'перебор флагов даёт отрицательный остаток');

      // Флаг на открытой клетке невозможен.
      var b3 = new Board(9, 9, 10, 11);
      b3.reveal(4, 4);
      var opened = -1;
      for (var i = 0; i < b3.size; i++) {
        if (b3.state[i] === CELL.REVEALED) {
          opened = i;
          break;
        }
      }
      var before = b3.flagCount;
      var chg = b3.cycleFlag(b3.xOf(opened), b3.yOf(opened), false);
      t.eq(chg, null, 'метка на открытой клетке отклонена');
      t.eq(b3.flagCount, before, 'счётчик не изменился');
    });

    /* ---------------------------------------------------------------- */
    r.test('Первый ход флагом запускает партию', function (t) {
      var b = new Board(9, 9, 10, 31);
      t.eq(b.phase, PHASE.READY, 'до хода READY');
      b.cycleFlag(3, 3, false);
      t.eq(b.phase, PHASE.PLAYING, 'после флага PLAYING');
      t.eq(b.minesPlaced, false, 'но мины ещё не расставлены');

      // Первый клик по другой клетке всё равно обязан быть безопасным.
      var res = b.reveal(6, 6);
      t.eq(res.firstClick, true, 'клик считается первым');
      t.eq(res.hitMine, false, 'и безопасен');
      t.eq(b.mine[b.idx(6, 6)], 0, 'мины под ним нет');
    });

    /* ---------------------------------------------------------------- */
    r.test('Проигрыш: фаза, эпицентр, ошибочные флаги', function (t) {
      var b = new Board(12, 12, 20, 8080);
      b.reveal(6, 6);

      var mineIdx = -1;
      for (var i = 0; i < b.size; i++) {
        if (b.mine[i]) {
          mineIdx = i;
          break;
        }
      }

      // Ставим заведомо неверный флаг на безопасную закрытую клетку.
      var wrongIdx = -1;
      for (var j = 0; j < b.size; j++) {
        if (!b.mine[j] && b.state[j] === CELL.HIDDEN) {
          wrongIdx = j;
          break;
        }
      }
      if (wrongIdx >= 0) b.cycleFlag(b.xOf(wrongIdx), b.yOf(wrongIdx), false);

      var res = b.reveal(b.xOf(mineIdx), b.yOf(mineIdx));
      t.eq(res.hitMine, true, 'попадание по мине зафиксировано');
      t.eq(b.phase, PHASE.LOST, 'фаза LOST');
      t.eq(b.explodedAt, mineIdx, 'эпицентр = взорванная мина');
      t.eq(b.lastRevealCount, 1, 'в пакете только сама мина');

      if (wrongIdx >= 0) {
        var found = false;
        for (var k = 0; k < b.wrongFlags.length; k++) {
          if (b.wrongFlags[k] === wrongIdx) found = true;
        }
        t.ok(found, 'ошибочный флаг попал в wrongFlags');
      }

      // После проигрыша ходы не принимаются.
      var after = b.reveal(0, 0);
      t.eq(after.ok, false, 'открытие после проигрыша отклонено');
      t.eq(b.cycleFlag(0, 1, false), null, 'метка после проигрыша отклонена');
    });

    /* ---------------------------------------------------------------- */
    r.test('Победа: открытие всех безопасных клеток', function (t) {
      for (var s = 1; s <= 60; s++) {
        var b = new Board(10, 8, 12, s * 17);
        var phase = playPerfect(b, 5, 4);

        if (!t.eq(phase, PHASE.WON, 'сид ' + s + ': фаза после идеальной игры')) break;
        if (!t.eq(b.revealedCount, b.safeCells(), 'сид ' + s + ': открыты все безопасные')) break;

        // При победе все мины должны быть автоматически помечены.
        var unflagged = 0;
        for (var i = 0; i < b.size; i++) {
          if (b.mine[i] && b.state[i] !== CELL.FLAGGED) unflagged++;
        }
        if (!t.eq(unflagged, 0, 'сид ' + s + ': непомеченных мин')) break;
        if (!t.eq(b.minesRemaining(), 0, 'сид ' + s + ': счётчик мин обнулён')) break;
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Открытая клетка не открывается дважды', function (t) {
      var b = new Board(10, 10, 10, 246);
      var first = b.reveal(5, 5);
      var countAfterFirst = b.revealedCount;
      t.ok(first.revealed > 0, 'первое открытие сработало');

      var second = b.reveal(5, 5);
      t.eq(second.ok, false, 'повторный клик отклонён');
      t.eq(b.revealedCount, countAfterFirst, 'счётчик открытых не изменился');
    });

    /* ---------------------------------------------------------------- */
    r.test('Chord: срабатывает при верных флагах', function (t) {
      var b = new Board(14, 14, 25, 1234);
      b.reveal(7, 7);

      // Ищем открытую цифру, все мины-соседи которой можно пометить.
      var target = -1;
      for (var i = 0; i < b.size; i++) {
        if (b.state[i] !== CELL.REVEALED || b.adj[i] === 0) continue;
        var hiddenNeighbors = 0;
        b.forEachNeighbor(i, function (n) {
          if (b.state[n] === CELL.HIDDEN) hiddenNeighbors++;
        });
        if (hiddenNeighbors > b.adj[i]) {
          target = i;
          break;
        }
      }

      if (target < 0) {
        t.ok(true, 'подходящей цифры нет — тест неприменим на этом сиде');
        return;
      }

      // Chord до расстановки флагов не должен ничего делать.
      var early = b.chord(b.xOf(target), b.yOf(target));
      t.eq(early.ok, false, 'chord без нужного числа флагов не срабатывает');

      // Помечаем ровно мины-соседи.
      b.forEachNeighbor(target, function (n) {
        if (b.mine[n] && b.state[n] === CELL.HIDDEN) {
          b.cycleFlag(b.xOf(n), b.yOf(n), false);
        }
      });

      var res = b.chord(b.xOf(target), b.yOf(target));
      t.eq(res.ok, true, 'chord сработал');
      t.eq(res.hitMine, false, 'при верных флагах мина не вскрыта');
      t.ok(res.revealed > 0, 'открылись клетки: ' + res.revealed);
      t.eq(b.lastRevealCount, res.revealed, 'пакет соответствует числу открытых');

      // Все не-минные соседи обязаны быть открыты.
      var stillHidden = 0;
      b.forEachNeighbor(target, function (n) {
        if (!b.mine[n] && b.state[n] === CELL.HIDDEN) stillHidden++;
      });
      t.eq(stillHidden, 0, 'все безопасные соседи открыты');
    });

    /* ---------------------------------------------------------------- */
    r.test('Chord: неверный флаг ведёт к взрыву верной мины', function (t) {
      var b = new Board(14, 14, 25, 777);
      b.reveal(7, 7);

      // Цифра, у которой есть и мина, и безопасная клетка в закрытых соседях.
      var target = -1,
        mineN = -1,
        safeN = -1;
      for (var i = 0; i < b.size && target < 0; i++) {
        if (b.state[i] !== CELL.REVEALED || b.adj[i] === 0) continue;
        var m = -1,
          s2 = -1,
          hidden = 0;
        b.forEachNeighbor(i, function (n) {
          if (b.state[n] !== CELL.HIDDEN) return;
          hidden++;
          if (b.mine[n]) {
            if (m < 0) m = n;
          } else if (s2 < 0) s2 = n;
        });
        if (m >= 0 && s2 >= 0 && hidden > b.adj[i]) {
          target = i;
          mineN = m;
          safeN = s2;
        }
      }

      if (target < 0) {
        t.ok(true, 'подходящей конфигурации нет — тест неприменим');
        return;
      }

      // Ставим нужное количество флагов, но один из них — заведомо неверный.
      var placed = 0;
      var need = b.adj[target];
      b.cycleFlag(b.xOf(safeN), b.yOf(safeN), false);
      placed++;
      b.forEachNeighbor(target, function (n) {
        if (placed >= need) return;
        if (n === safeN || n === mineN) return;
        if (b.state[n] !== CELL.HIDDEN) return;
        b.cycleFlag(b.xOf(n), b.yOf(n), false);
        placed++;
      });

      if (placed < need) {
        t.ok(true, 'не удалось набрать нужное число флагов — тест неприменим');
        return;
      }

      var res = b.chord(b.xOf(target), b.yOf(target));
      t.eq(res.ok, true, 'chord запустился');
      t.eq(res.hitMine, true, 'неверный флаг привёл к взрыву');
      t.eq(b.phase, PHASE.LOST, 'фаза LOST');
      t.ok(b.mine[b.explodedAt] === 1, 'эпицентр — настоящая мина');
      t.eq(b.lastRevealCount, 1, 'в пакете только взорванная мина');
    });

    /* ---------------------------------------------------------------- */
    r.test('Chord: игнорирует нули и закрытые клетки', function (t) {
      var b = new Board(12, 12, 15, 31337);
      b.reveal(6, 6);

      // Открытая пустая клетка: chord бессмысленен.
      var zero = -1,
        hidden = -1;
      for (var i = 0; i < b.size; i++) {
        if (zero < 0 && b.state[i] === CELL.REVEALED && b.adj[i] === 0) zero = i;
        if (hidden < 0 && b.state[i] === CELL.HIDDEN) hidden = i;
      }
      if (zero >= 0) {
        t.eq(b.chord(b.xOf(zero), b.yOf(zero)).ok, false, 'chord по нулю отклонён');
      }
      if (hidden >= 0) {
        t.eq(
          b.chord(b.xOf(hidden), b.yOf(hidden)).ok,
          false,
          'chord по закрытой клетке отклонён'
        );
      }
      t.eq(b.chord(-1, -1).ok, false, 'chord вне поля отклонён');
    });

    /* ---------------------------------------------------------------- */
    r.test('Детерминизм: одинаковый сид даёт одинаковое поле', function (t) {
      var a = new Board(16, 16, 40, 0xc0ffee);
      var b = new Board(16, 16, 40, 0xc0ffee);
      a.reveal(8, 8);
      b.reveal(8, 8);

      var diff = 0;
      for (var i = 0; i < a.size; i++) {
        if (a.mine[i] !== b.mine[i]) diff++;
      }
      t.eq(diff, 0, 'расстановка мин идентична');
      t.eq(a.revealedCount, b.revealedCount, 'каскад открыл столько же клеток');

      // Другой сид должен дать другое поле (иначе RNG не работает).
      var c = new Board(16, 16, 40, 0xbadf00d);
      c.reveal(8, 8);
      var diff2 = 0;
      for (var j = 0; j < a.size; j++) {
        if (a.mine[j] !== c.mine[j]) diff2++;
      }
      t.ok(diff2 > 0, 'другой сид даёт другую расстановку (различий: ' + diff2 + ')');
    });

    /* ---------------------------------------------------------------- */
    r.test('Клики вне поля безопасны', function (t) {
      var b = new Board(8, 8, 10, 5);
      t.eq(b.reveal(-1, 0).ok, false, 'x=-1');
      t.eq(b.reveal(0, -1).ok, false, 'y=-1');
      t.eq(b.reveal(8, 0).ok, false, 'x=w');
      t.eq(b.reveal(0, 8).ok, false, 'y=h');
      t.eq(b.reveal(999, 999).ok, false, 'далеко за полем');
      t.eq(b.cycleFlag(-5, -5, false), null, 'метка вне поля');
      t.eq(b.phase, PHASE.READY, 'фаза не изменилась');
      t.eq(b.minesPlaced, false, 'мины не расставлены');
    });

    /* ---------------------------------------------------------------- */
    r.test('allMines(): полный и точный список', function (t) {
      var b = new Board(10, 10, 17, 61);
      b.reveal(5, 5);
      var list = b.allMines();
      t.eq(list.length, 17, 'длина списка равна числу мин');

      var allAreMines = true;
      for (var i = 0; i < list.length; i++) {
        if (!b.mine[list[i]]) allAreMines = false;
      }
      t.ok(allAreMines, 'все элементы — действительно мины');

      // Уникальность.
      var seen = {};
      var dupes = 0;
      for (var j = 0; j < list.length; j++) {
        if (seen[list[j]]) dupes++;
        seen[list[j]] = 1;
      }
      t.eq(dupes, 0, 'нет повторов');
    });

    /* ---------------------------------------------------------------- */
    r.test('Все три пресета сложности играбельны', function (t) {
      var names = ['beginner', 'intermediate', 'expert'];
      for (var i = 0; i < names.length; i++) {
        var p = MS.PRESETS[names[i]];
        t.ok(!!p, names[i] + ': пресет существует');
        var b = new Board(p.w, p.h, p.mines, 1000 + i);
        var res = b.reveal((p.w / 2) | 0, (p.h / 2) | 0);
        t.eq(res.hitMine, false, names[i] + ': первый клик безопасен');
        t.eq(countMines(b), p.mines, names[i] + ': число мин верное');
        t.ok(b.safeCells() > 0, names[i] + ': есть что открывать');
        t.ok(p.mines < p.w * p.h, names[i] + ': мин меньше числа клеток');
      }
    });

    /* ---------------------------------------------------------------- */
    r.test('Нагрузка: Профи 30x16x99 на 100 сидах без сбоев', function (t) {
      // Это самый тяжёлый пресет. Проверяем, что инварианты держатся
      // на нём же — именно тут ломаются граничные случаи.
      for (var s = 1; s <= 100; s++) {
        var b = new Board(30, 16, 99, s * 31 + 5);
        var res = b.reveal(15, 8);
        if (!t.eq(res.hitMine, false, 'сид ' + s + ': безопасный старт')) break;
        if (!t.eq(countMines(b), 99, 'сид ' + s + ': 99 мин')) break;

        var revealedMines = 0;
        for (var i = 0; i < b.size; i++) {
          if (b.state[i] === CELL.REVEALED && b.mine[i]) revealedMines++;
        }
        if (!t.eq(revealedMines, 0, 'сид ' + s + ': мины не открыты')) break;

        var phase = playPerfect(b, 15, 8);
        if (!t.eq(phase, PHASE.WON, 'сид ' + s + ': идеальная игра приводит к победе')) break;
      }
    });

    return r;
  }

  /* --- Экспорт --------------------------------------------------------- */

  MS.tests = { runAll: runAll, Runner: Runner };
})(typeof window !== 'undefined' ? window : globalThis);
