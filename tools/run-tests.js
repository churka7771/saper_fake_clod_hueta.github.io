/* ===========================================================================
 * tools/run-tests.js — прогон логики сапёра в терминале.
 *
 *   node tools/run-tests.js
 *
 * Классические скрипты игры грузятся через vm в общий контекст, где роль
 * `window` играет обычный объект. Так один и тот же код тестируется
 * и в Node, и в браузере, без сборки и без дублирования тестов.
 * =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Порядок важен: util -> board -> tests.
const FILES = ['js/util.js', 'js/board.js', 'js/tests-board.js'];

const sandbox = {
  console,
  Math,
  Date,
  JSON,
  Uint8Array,
  Int32Array,
  Float32Array,
  Number,
  String,
  Object,
  Array,
  Error,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.error(`Не найден файл: ${rel}`);
    process.exit(1);
  }
  const code = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(code, { filename: rel }).runInContext(context);
  } catch (err) {
    console.error(`Ошибка загрузки ${rel}:\n${err.stack}`);
    process.exit(1);
  }
}

const MS = sandbox.MS;
if (!MS || !MS.tests) {
  console.error('MS.tests не найден — проверь js/tests-board.js');
  process.exit(1);
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const started = Date.now();
const runner = MS.tests.runAll();
const elapsed = Date.now() - started;
const sum = runner.summary();

console.log(`\n${BOLD}Логика сапёра — проверки${RESET}\n`);

for (const rec of runner.results) {
  if (rec.pass) {
    console.log(`  ${GREEN}PASS${RESET}  ${rec.name} ${DIM}(${rec.asserts})${RESET}`);
  } else {
    console.log(`  ${RED}FAIL${RESET}  ${rec.name} ${DIM}(${rec.asserts})${RESET}`);
    for (const e of rec.errors) console.log(`        ${RED}${e}${RESET}`);
  }
}

const color = sum.failed === 0 ? GREEN : RED;
console.log(
  `\n${color}${BOLD}${sum.passed}/${sum.total} тестов пройдено${RESET}` +
    ` ${DIM}· ${sum.asserts} проверок · ${elapsed} мс${RESET}\n`
);

process.exit(sum.failed === 0 ? 0 : 1);
