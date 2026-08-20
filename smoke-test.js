/**
 * みっちーの席くじ 🎲 — 自動スモークテスト
 * ------------------------------------------------------------
 * 実行方法: node tests/smoke-test.js
 * （GitHub Actions が push のたびに自動実行します。手元での実行は不要です）
 *
 * このテストは実際のブラウザの代わりに jsdom で index.html の
 * <script> 部分をまるごと実行し、以下を検証します：
 *   1. JS構文エラーが無いこと
 *   2. 全画面（開始/設定/レイアウト/くじ引き/結果）が全パターンで
 *      例外なくレンダリングできること
 *   3. 空席指定・空席解除・机間ドラッグを何度組み合わせても
 *      「1つの机の席数」設定が絶対に崩れないこと
 *   4. 保存/読み込みが、正常データはもちろん壊れたデータ・不正な
 *      JSONでも安全にフォールバックすること
 *   5. 隣同士グループが一括くじ引き・個別くじ引きの両方で
 *      正しく隣接した席に配置されること
 *   6. レイアウトのUndo（一つ前に戻す）が正しく機能すること
 *
 * 1つでも失敗すると非ゼロの終了コードで終わり、GitHub Actions が
 * 赤いバツ印で知らせてくれます。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

let totalTests = 0;
let failedTests = 0;
const failures = [];

function loadAppSource() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('index.html 内に <script> ブロックが見つかりません');
  let src = m[1];

  // アプリ内部の state / 主要関数をテストから呼べるよう window.__TEST__ に公開する。
  // 末尾の `render(); })();` を置き換えるだけなので、アプリ本体の挙動は変えない。
  const hook = `
  window.__TEST__ = {
    state: state, render: render, buildTables: buildTables, goTo: goTo, goBack: goBack,
    normalizeSeatCounts: normalizeSeatCounts, prepareBlanks: prepareBlanks,
    saveSetup: saveSetup, loadSavedSetup: loadSavedSetup, hasSavedSetup: hasSavedSetup,
    findSeatByNum: findSeatByNum, makeSeatVacant: makeSeatVacant, unmakeSeatVacant: unmakeSeatVacant,
    snapshotLayout: snapshotLayout, undoLayout: undoLayout, drawAllAtOnce: drawAllAtOnce,
    runLottery: runLottery, cleanPairGroups: cleanPairGroups, findGroupReservedSeat: findGroupReservedSeat,
    openFixedModal: openFixedModal, undoAssignment: undoAssignment, showConfirm: showConfirm,
    incrementRowSeatCount: incrementRowSeatCount, decrementRowSeatCount: decrementRowSeatCount,
    setTableCount: setTableCount, applyDeskSeatCounts: applyDeskSeatCounts,
    totalPhysicalSeatCount: totalPhysicalSeatCount, distributeSeats: distributeSeats,
    autoFillRowSeats: autoFillRowSeats,
    saveNamed: saveNamed, listNamedSaves: listNamedSaves, deleteNamedSave: deleteNamedSave,
    applyNamedSave: applyNamedSave, buildSetupSnapshot: buildSetupSnapshot,
    buildResultSnapshot: buildResultSnapshot
  };
})();
`;
  const replaced = src.replace(/\n  render\(\);\n\}\)\(\);/, hook);
  if (replaced === src) {
    throw new Error('テスト用フックの注入に失敗しました（index.html の末尾の形式が変わった可能性があります）');
  }
  return replaced;
}

function makeEnv(src) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="app"></div><canvas id="confetti-canvas"></canvas></body></html>',
    { url: 'https://example.com/', pretendToBeVisual: true }
  );
  const { window } = dom;
  window.navigator.vibrate = function () {};
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { clearRect(){}, save(){}, translate(){}, rotate(){}, fillRect(){}, restore(){} };
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  global.window = window;
  global.document = window.document;
  global.navigator = window.navigator;
  global.localStorage = window.localStorage; // jsdom純正のlocalStorageをそのまま使う
  global.requestAnimationFrame = function (fn) { return window.setTimeout(fn, 0); };
  window.matchMedia = window.matchMedia || function () {
    return { matches: false, addListener(){}, removeListener(){} };
  };
  window.eval(src);
  return { T: window.__TEST__, dom, window };
}

function test(label, fn) {
  totalTests++;
  const src = loadAppSource();
  const env = makeEnv(src);
  try {
    fn(env.T, env.window);
    process.stdout.write(`  \x1b[32mOK\x1b[0m   ${label}\n`);
  } catch (e) {
    failedTests++;
    failures.push({ label, error: e });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n        -> ${e.message}\n`);
  } finally {
    try { env.dom.window.close(); } catch (e2) { /* ignore */ }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ============================================================
 * 1. JS構文チェック
 * ========================================================== */
console.log('\n=== 1. JS構文チェック ===');
totalTests++;
try {
  const src = loadAppSource();
  new Function(src);
  console.log('  \x1b[32mOK\x1b[0m   JS構文エラーなし');
} catch (e) {
  failedTests++;
  failures.push({ label: 'JS構文チェック', error: e });
  console.log(`  \x1b[31mFAIL\x1b[0m JS構文エラー: ${e.message}`);
}

/* ============================================================
 * 2. 全画面レンダリング（食事会/講演会 × 丸テーブル/長テーブル/シアター/スクール）
 * ========================================================== */
console.log('\n=== 2. 画面レンダリング ===');

test('開始画面', (T) => {
  T.state.step = 'start';
  T.render();
});

const layoutConfigs = [
  { name: '食事会/丸テーブル 2x4', ev: 'dining', shape: 'circle', tc: 2, tp: 8, sc: [4, 4] },
  { name: '食事会/長テーブル 3x5', ev: 'dining', shape: 'square', tc: 3, tp: 15, sc: [5, 5, 5] },
  { name: '食事会/丸テーブル 単一テーブル', ev: 'dining', shape: 'circle', tc: 1, tp: 6, sc: [6] },
  { name: '講演会/シアター形式 4x5', ev: 'lecture', shape: 'lecture', style: 'row', tc: 4, tp: 20, sc: [5, 5, 5, 5] },
  { name: '講演会/スクール形式 4机x2席', ev: 'lecture', shape: 'lecture', style: 'desk', tc: 4, tp: 8, sc: [2, 2, 2, 2], perDesk: 2 },
];
layoutConfigs.forEach((cfg) => {
  test(`座席レイアウト: ${cfg.name}`, (T) => {
    T.state.eventType = cfg.ev;
    T.state.shape = cfg.shape;
    if (cfg.style) T.state.lectureStyle = cfg.style;
    if (cfg.perDesk) T.state.deskSeatsPerTable = cfg.perDesk;
    T.state.tableCount = cfg.tc;
    T.state.totalParticipants = cfg.tp;
    T.state.seatCounts = cfg.sc.slice();
    T.buildTables();
    T.state.step = 'layout';
    T.render();
    const total = T.totalPhysicalSeatCount();
    const expected = cfg.sc.reduce((a, b) => a + b, 0);
    assert(total === expected, `席数不一致: got ${total} expected ${expected}`);
  });
});

/* ============================================================
 * 3. 空席指定・空席解除・机ドラッグの不変条件
 *    「1つの机に何席か」は何をしても絶対に変わらない
 * ========================================================== */
console.log('\n=== 3. 机の席数を守る不変条件 ===');

function checkAllDesksFullSize(T, perDesk) {
  const bad = [];
  T.state.tables.forEach((t, i) => {
    if (t.seats.length !== perDesk) bad.push(`机${i + 1}: ${t.seats.length}席 (期待値 ${perDesk})`);
  });
  return bad;
}

test('机の人数固定: 空席指定/解除/ドラッグ40回 (4机x2席、参加者8人)', (T, window) => {
  T.state.eventType = 'lecture';
  T.state.lectureStyle = 'desk';
  T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 2;
  T.state.deskColumns = 3;
  T.state.totalParticipants = 8;
  T.state.tableCount = 4;
  T.state.seatCounts = [2, 2, 2, 2];
  T.buildTables();
  T.state.step = 'layout';

  function clickVacantFor(num) {
    const seat = T.findSeatByNum(num);
    if (!seat) return;
    T.openFixedModal(seat);
    const btn = document.querySelector('.modal-vacant-btn');
    if (btn) btn.onclick();
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) document.body.removeChild(overlay);
  }
  function clickReleaseFor(num) {
    const seat = T.findSeatByNum(num);
    if (!seat) return;
    T.openFixedModal(seat);
    const btn = document.querySelector('.modal-vacant-release-btn');
    if (btn) btn.onclick();
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) document.body.removeChild(overlay);
  }
  // jsdomのバージョンによって window.PointerEvent がコンストラクタとして
  // 使えたり使えなかったりするため、常に動く素の Event + 手動プロパティ付与
  // という方式でポインターイベントを合成する（アプリ側は ev.clientX / ev.pointerId /
  // ev.pointerType をプロパティとして読むだけなので、これで十分再現できる）。
  function makePointerEvent(type, props) {
    const ev = new window.Event(type, { bubbles: true });
    Object.keys(props).forEach((k) => { try { ev[k] = props[k]; } catch (e) { /* ignore */ } });
    return ev;
  }
  function dragBetweenRandomDesks() {
    T.render();
    const cushions = Array.from(document.querySelectorAll('.cushion'));
    const blocks = Array.from(document.querySelectorAll('.table-block'));
    if (cushions.length < 2 || blocks.length < 1) return;
    const src = cushions[Math.floor(Math.random() * cushions.length)];
    const target = blocks[Math.floor(Math.random() * blocks.length)];
    document.elementFromPoint = function () { return target; };
    src.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100, pointerId: 1, pointerType: 'mouse' }));
    for (let i = 0; i < 5; i++) {
      src.dispatchEvent(makePointerEvent('pointermove', { clientX: 100 + i * 20, clientY: 100, pointerId: 1, pointerType: 'mouse' }));
    }
    src.dispatchEvent(makePointerEvent('pointerup', { clientX: 200, clientY: 100, pointerId: 1, pointerType: 'mouse' }));
  }

  for (let round = 0; round < 40; round++) {
    const action = Math.random();
    if (action < 0.4) {
      clickVacantFor(1 + Math.floor(Math.random() * 8));
    } else if (action < 0.6) {
      const vacantSeats = [];
      T.state.tables.forEach((t) => t.seats.forEach((s) => { if (s.num > T.state.totalParticipants) vacantSeats.push(s.num); }));
      if (vacantSeats.length) clickReleaseFor(vacantSeats[Math.floor(Math.random() * vacantSeats.length)]);
    } else {
      dragBetweenRandomDesks();
    }
    const violations = checkAllDesksFullSize(T, 2);
    assert(violations.length === 0, `机の人数が崩れました (round ${round}): ${violations.join(', ')}`);
  }
});

test('席番号の重複が発生しないこと (空席指定/解除 200回ランダム試行)', (T) => {
  T.state.eventType = 'dining';
  T.state.shape = 'circle';
  T.state.tableCount = 4;
  T.state.totalParticipants = 16;
  T.state.seatCounts = [4, 4, 4, 4];
  T.buildTables();

  for (let round = 0; round < 200; round++) {
    const allSeats = [];
    T.state.tables.forEach((t) => t.seats.forEach((s) => allSeats.push(s)));
    const pick = allSeats[Math.floor(Math.random() * allSeats.length)];
    if (Math.random() < 0.7) T.makeSeatVacant(pick); else T.unmakeSeatVacant(pick);

    const seen = {};
    T.state.tables.forEach((t) => t.seats.forEach((s) => {
      assert(!seen[s.num], `席番号 ${s.num} が重複しました (round ${round})`);
      seen[s.num] = true;
    }));
  }
});

/* ============================================================
 * 4. 保存/読み込み（正常・壊れたデータ・不正JSON）
 * ========================================================== */
console.log('\n=== 4. 保存・読み込み ===');

test('保存 -> 読み込みの往復（実データ・固定名・隣同士グループ含む）', (T) => {
  T.state.eventType = 'lecture';
  T.state.lectureStyle = 'desk';
  T.state.shape = 'lecture';
  T.state.deskColumns = 4;
  T.state.deskSeatsPerTable = 3;
  T.state.tableCount = 5;
  T.state.totalParticipants = 15;
  T.state.seatCounts = [3, 3, 3, 3, 3];
  T.buildTables();
  T.state.presetNamesText = 'A\nB\nC';
  T.state.pairGroups = [['A', 'B']];
  T.state.tables[0].seats[0].fixedName = 'こていさん';
  T.saveSetup();

  T.state.tableCount = 999;
  T.state.totalParticipants = 999;
  T.state.pairGroups = [];
  const ok = T.loadSavedSetup('lecture');
  assert(ok === true, '読み込みに失敗しました');
  assert(T.state.tableCount === 5, `tableCountが復元されていません: ${T.state.tableCount}`);
  assert(T.state.totalParticipants === 15, 'totalParticipantsが復元されていません');
  assert(JSON.stringify(T.state.pairGroups) === JSON.stringify([['A', 'B']]), '隣同士グループが復元されていません');
  const fixedSeat = T.state.tables[0].seats.find((s) => s.fixedName === 'こていさん');
  assert(!!fixedSeat, '固定名が復元されていません');
});

test('壊れた保存データ（項目欠落）でもクラッシュせず安全なデフォルトに復旧する', (T, window) => {
  window.localStorage.setItem('mitchieSeatLottery.savedSetup.dining.v1', JSON.stringify({ eventType: 'dining', tables: [] }));
  const ok = T.loadSavedSetup('dining');
  assert(ok === true, '読み込みが失敗として扱われました');
  assert(T.state.tableCount === 2, `フォールバックのtableCountが違います: ${T.state.tableCount}`);
  assert(T.state.totalParticipants === 8, 'フォールバックのtotalParticipantsが違います');
  T.state.step = 'layout';
  T.render(); // ここで例外が出ないことも確認
});

test('不正なJSON文字列の保存データでも例外を投げずfalseを返す', (T, window) => {
  window.localStorage.setItem('mitchieSeatLottery.savedSetup.dining.v1', '{not valid json!!');
  let threw = false;
  let ok;
  try { ok = T.loadSavedSetup('dining'); } catch (e) { threw = true; }
  assert(!threw, 'loadSavedSetupが例外を投げました（try/catchで捕捉されるべき）');
  assert(ok === false, `不正データなのにtrueが返りました: ${ok}`);
});

/* ============================================================
 * 5. 隣同士グループ
 * ========================================================== */
console.log('\n=== 5. 隣同士グループ ===');

test('一括くじ引きで複数の隣同士グループが独立して隣接配置される', (T) => {
  T.state.eventType = 'dining';
  T.state.shape = 'square';
  T.state.tableCount = 3;
  T.state.totalParticipants = 12;
  T.state.seatCounts = [4, 4, 4];
  T.buildTables();
  T.state.presetNamesText = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].join('\n');
  T.state.pairGroups = [['A', 'B'], ['C', 'D']];
  T.prepareBlanks();
  T.drawAllAtOnce();
  const yesBtn = document.querySelector('.modal-overlay .modal-delete');
  assert(!!yesBtn, '一括くじ引きの確認ダイアログが表示されませんでした');
  yesBtn.click();

  const assignedCount = T.state.participants.filter((p) => p.assigned).length;
  assert(assignedCount === 12, `全員に席が割り当てられていません: ${assignedCount}/12`);
});

/* ============================================================
 * 6. レイアウトのUndo
 * ========================================================== */
console.log('\n=== 6. Undo（一つ前に戻す） ===');

test('空席指定をUndoで元に戻せる', (T) => {
  T.state.eventType = 'lecture';
  T.state.lectureStyle = 'row';
  T.state.shape = 'lecture';
  T.state.tableCount = 3;
  T.state.totalParticipants = 15;
  T.state.seatCounts = [5, 5, 5];
  T.buildTables();
  T.state.step = 'layout';

  const before = JSON.stringify(T.state.tables.map((t) => t.seats.map((s) => s.num)));
  const seat = T.findSeatByNum(3);
  T.snapshotLayout();
  T.makeSeatVacant(seat);
  const afterVacant = JSON.stringify(T.state.tables.map((t) => t.seats.map((s) => s.num)));
  assert(before !== afterVacant, '空席指定で状態が変化していません');

  const ok = T.undoLayout();
  assert(ok === true, 'undoLayoutがfalseを返しました');
  const restored = JSON.stringify(T.state.tables.map((t) => t.seats.map((s) => s.num)));
  assert(restored === before, 'Undoで元の状態に戻っていません');
});

test('Undo履歴が空のときは何も起きず安全にfalseを返す', (T) => {
  T.state.eventType = 'dining';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  const ok = T.undoLayout();
  assert(ok === false, '履歴が無いのにtrueが返りました');
});

/* ============================================================
 * 7. 名前を付けて保存（設定 / 座席結果）
 * ========================================================== */
console.log('\n=== 7. 名前を付けて保存 ===');

test('設定を名前を付けて保存 -> 一覧に出る -> 開くと復元される', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining';
  T.state.shape = 'square';
  T.state.tableCount = 2;
  T.state.totalParticipants = 8;
  T.state.seatCounts = [4, 4];
  T.buildTables();
  const seat1 = T.findSeatByNum(1);
  seat1.fixedName = 'ゆい';
  const ok = T.saveNamed('setup', '文化祭2026');
  assert(ok === true, 'saveNamedがfalseを返しました');

  const list = T.listNamedSaves('setup');
  assert(list.length === 1, `一覧の件数が違います: ${list.length}`);
  assert(list[0].name === '文化祭2026（設定）', `保存名に(設定)が付いていません: ${list[0].name}`);

  // 別の状態に変えてから、保存した内容を開いて復元されるか確認
  T.state.tableCount = 1;
  T.state.totalParticipants = 2;
  T.state.seatCounts = [2];
  T.buildTables();
  T.applyNamedSave('setup', list[0].data);
  assert(T.state.tables.length === 2, `復元後のテーブル数が違います: ${T.state.tables.length}`);
  assert(T.state.step === 'layout', `復元後のstepが違います: ${T.state.step}`);
  const restoredSeat1 = T.findSeatByNum(1);
  assert(restoredSeat1.fixedName === 'ゆい', '固定名が復元されていません');
});

test('座席結果を名前を付けて保存 -> 開くと参加者の名前ごと復元される', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining';
  T.state.shape = 'circle';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  const names = ['あ', 'か', 'さ', 'た'];
  T.state.tables[0].seats.forEach((s, i) => { s.name = names[i]; });
  T.state.participants = T.state.tables[0].seats.map((s, i) => (
    { id: 'x' + i, name: names[i], fixed: false, assigned: true, seatNum: s.num }
  ));
  T.saveNamed('result', '運動会2026');

  const list = T.listNamedSaves('result');
  assert(list.length === 1, `一覧の件数が違います: ${list.length}`);
  assert(list[0].name === '運動会2026（座席結果）', `保存名に(座席結果)が付いていません: ${list[0].name}`);

  T.state.step = 'setup';
  T.applyNamedSave('result', list[0].data);
  assert(T.state.step === 'result', `復元後のstepがresultになっていません: ${T.state.step}`);
  const restoredNames = T.state.tables[0].seats.map((s) => s.name);
  assert(JSON.stringify(restoredNames) === JSON.stringify(names), `復元後の名前が違います: ${restoredNames}`);
});

test('保存は20件を超えると古いものから切り捨てられる', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  for (let i = 1; i <= 25; i++) {
    T.saveNamed('setup', `保存${i}`);
  }
  const list = T.listNamedSaves('setup');
  assert(list.length === 20, `20件に切り詰められていません: ${list.length}`);
  assert(list[0].name === '保存25（設定）', `最新が先頭に来ていません: ${list[0].name}`);
});

test('保存を削除すると一覧から消える', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  T.saveNamed('setup', '削除テスト');
  const before = T.listNamedSaves('setup');
  assert(before.length === 1, '保存直後の件数が違います');
  T.deleteNamedSave('setup', before[0].id);
  const after = T.listNamedSaves('setup');
  assert(after.length === 0, `削除後も残っています: ${after.length}`);
});

test('食事会・講演会それぞれの保存が、種別指定なしで横断して一覧に出る', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining';
  T.state.shape = 'square';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  T.saveNamed('setup', '食事会テスト');

  T.state.eventType = 'lecture';
  T.state.lectureStyle = 'row';
  T.state.shape = 'lecture';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  T.saveNamed('setup', '講演会テスト');

  const combined = T.listNamedSaves('setup'); // eventType未指定 = 横断一覧
  assert(combined.length === 2, `横断一覧の件数が違います: ${combined.length}`);
  const names = combined.map((item) => item.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['講演会テスト（設定）', '食事会テスト（設定）']),
    `横断一覧の中身が違います: ${names}`
  );
});

test('壊れた保存データ（data欠落）でも復元処理が例外を投げない', (T) => {
  T.state.eventType = 'dining';
  T.state.tableCount = 1;
  T.state.totalParticipants = 4;
  T.state.seatCounts = [4];
  T.buildTables();
  let threw = false;
  try {
    T.applyNamedSave('setup', { tables: null });
  } catch (e) { threw = true; }
  assert(!threw, 'applyNamedSaveが壊れたデータで例外を投げました（try/catchで捕捉されるべき）');
});

/* ============================================================
 * 結果サマリー
 * ========================================================== */
console.log('\n' + '='.repeat(50));
console.log(`テスト結果: ${totalTests - failedTests} / ${totalTests} 件 成功`);
if (failedTests > 0) {
  console.log(`\n\x1b[31m失敗したテスト (${failedTests}件):\x1b[0m`);
  failures.forEach((f) => console.log(`  - ${f.label}: ${f.error.message}`));
  console.log('='.repeat(50));
  process.exit(1);
} else {
  console.log('\x1b[32mすべてのテストに合格しました 🎉\x1b[0m');
  console.log('='.repeat(50));
  process.exit(0);
}
