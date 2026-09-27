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
    buildResultSnapshot: buildResultSnapshot,
    planPairGroups: planPairGroups, pickSeatForName: pickSeatForName,
    checkPairGroupsFeasible: checkPairGroupsFeasible
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
 * 8. 保存から開いても席の並びが崩れないこと（回帰テスト）
 *    以前は「名前を付けて保存」から開くと、別の机へ移動した席が消え、
 *    元の机に残った席が机の中央に重なって表示されていた。
 * ========================================================== */
console.log('\n=== 8. 保存から開いたときの席の並び ===');

function layoutSignature(T) {
  return T.state.tables.map((t) => ({
    index: t.index,
    seats: t.seats.map((s) => s.num),
    row: t.rowSeats ? t.rowSeats.map((s) => (s ? s.num : 0)) : null,
    sides: t.sides ? ['top', 'bottom', 'left', 'right'].map((k) => t.sides[k].map((s) => s.num)) : null,
    fixed: t.seats.map((s) => s.fixedName || null),
    vacant: t.seats.map((s) => !!s.forcedVacant),
    dxy: t.seats.map((s) => [s.dx || 0, s.dy || 0]),
  }));
}
function assertSeatsLinked(T) {
  const seen = {};
  T.state.tables.forEach((t, ti) => {
    t.seats.forEach((s) => {
      assert(!seen[s.num], `席番号${s.num}が重複しています`);
      seen[s.num] = true;
      if (t.rowSeats) assert(t.rowSeats.indexOf(s) !== -1, `机${t.index}: 席${s.num}が並び(rowSeats)に入っていません（中央に重なって表示される原因）`);
      if (t.sides) {
        const inSide = ['top', 'bottom', 'left', 'right'].some((k) => t.sides[k].indexOf(s) !== -1);
        assert(inSide, `テーブル${t.index}: 席${s.num}が上下左右のどこにも入っていません`);
      }
    });
  });
}
function assertNoOverlapInDom(document) {
  Array.from(document.querySelectorAll('.table-block')).forEach((block) => {
    const pos = {};
    Array.from(block.querySelectorAll('.cushion')).forEach((c) => {
      const key = c.style.left + ',' + c.style.top;
      assert(!pos[key], `同じ位置に席が重なっています (${key})`);
      pos[key] = true;
    });
  });
}
function setupSchool(T) {
  T.state.eventType = 'lecture';
  T.state.lectureStyle = 'desk';
  T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 4;
  T.state.deskColumns = 3;
  T.state.totalParticipants = 30;
  T.state.tableCount = 8;
  T.state.seatCounts = [4, 4, 4, 4, 4, 4, 4, 4];
  T.buildTables();
  T.state.step = 'layout';
}
function swapAcrossTables(T, numA, numB) {
  const a = T.findSeatByNum(numA), b = T.findSeatByNum(numB);
  const ta = T.state.tables.find((t) => t.seats.indexOf(a) !== -1);
  const tb = T.state.tables.find((t) => t.seats.indexOf(b) !== -1);
  ta.seats[ta.seats.indexOf(a)] = b; tb.seats[tb.seats.indexOf(b)] = a;
  if (ta.rowSeats) { ta.rowSeats[ta.rowSeats.indexOf(a)] = b; tb.rowSeats[tb.rowSeats.indexOf(b)] = a; }
  if (ta.sides) {
    ['top', 'bottom', 'left', 'right'].forEach((k) => {
      const ia = ta.sides[k].indexOf(a); if (ia !== -1) ta.sides[k][ia] = b;
    });
    ['top', 'bottom', 'left', 'right'].forEach((k) => {
      const ib = tb.sides[k].indexOf(b); if (ib !== -1 && tb.sides[k][ib] === b) tb.sides[k][ib] = a;
    });
  }
}

['setup', 'result'].forEach((kind) => {
  test(`スクール形式: 机をまたいで移動・空席指定した後、${kind === 'setup' ? '設定' : '座席結果'}を保存→開いても並びが同じ`, (T, window) => {
    window.localStorage.clear();
    setupSchool(T);
    T.findSeatByNum(5).fixedName = 'たなか';
    T.findSeatByNum(6).fixedName = 'かわた';
    T.findSeatByNum(7).fixedName = 'はまや';
    swapAcrossTables(T, 8, 17);      // 机2の8番と机5の17番を入れ替え
    T.makeSeatVacant(T.findSeatByNum(3)); // 空席指定（番号の入れ替えが起きる）
    if (kind === 'result') T.findSeatByNum(1).name = 'すずき';
    T.render();
    const before = JSON.stringify(layoutSignature(T));
    assert(T.saveNamed(kind, '回帰テスト'), 'saveNamedが失敗しました');
    // 全く別の状態にしてから開く
    T.state.tableCount = 2; T.state.seatCounts = [2, 2]; T.buildTables();
    T.applyNamedSave(kind, T.listNamedSaves(kind)[0].data);
    const after = JSON.stringify(layoutSignature(T));
    assert(before === after, `復元後の並びが保存前と違います\n保存前: ${before}\n復元後: ${after}`);
    assertSeatsLinked(T);
    assertNoOverlapInDom(window.document);
  });
});

test('シアター形式: 通路の設定と列ごとの通路削除も保存→開くで戻る', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'row'; T.state.shape = 'lecture';
  T.state.totalParticipants = 18; T.state.tableCount = 3; T.state.seatCounts = [6, 6, 6];
  T.buildTables();
  T.state.step = 'layout';
  T.state.aisleEvery = 3;
  T.state.tables[1].removedAisles = { 1: true };
  swapAcrossTables(T, 2, 14);
  T.render();
  const before = JSON.stringify(layoutSignature(T));
  T.saveNamed('setup', '通路テスト');
  T.state.aisleEvery = 0; T.buildTables();
  T.applyNamedSave('setup', T.listNamedSaves('setup')[0].data);
  assert(T.state.aisleEvery === 3, `通路の間隔が戻っていません: ${T.state.aisleEvery}`);
  assert(T.state.tables[1].removedAisles && T.state.tables[1].removedAisles[1], '列ごとの通路削除が戻っていません');
  assert(JSON.stringify(layoutSignature(T)) === before, '復元後の並びが保存前と違います');
  assertSeatsLinked(T);
});

test('長テーブル: テーブルをまたいで移動した席が保存→開くで上下左右ごと戻る', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining'; T.state.shape = 'square';
  T.state.totalParticipants = 12; T.state.tableCount = 2; T.state.seatCounts = [6, 6];
  T.buildTables();
  T.state.step = 'layout';
  swapAcrossTables(T, 2, 9);
  T.render();
  const before = JSON.stringify(layoutSignature(T));
  T.saveNamed('setup', '長テーブル');
  T.buildTables();
  T.applyNamedSave('setup', T.listNamedSaves('setup')[0].data);
  assert(JSON.stringify(layoutSignature(T)) === before, '復元後の並びが保存前と違います');
  assertSeatsLinked(T);
});

test('丸テーブル: ドラッグで動かした位置とテーブル移動が保存→開くで戻る', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining'; T.state.shape = 'circle';
  T.state.totalParticipants = 8; T.state.tableCount = 2; T.state.seatCounts = [4, 4];
  T.buildTables();
  T.state.step = 'layout';
  swapAcrossTables(T, 1, 5);
  T.findSeatByNum(2).dx = 12; T.findSeatByNum(2).dy = -7;
  const before = JSON.stringify(layoutSignature(T));
  T.saveNamed('setup', '丸テーブル');
  T.buildTables();
  T.applyNamedSave('setup', T.listNamedSaves('setup')[0].data);
  assert(JSON.stringify(layoutSignature(T)) === before, '復元後の並びが保存前と違います');
});

test('旧形式の保存データ(seatList無し)でも、移動した席が中央に重ならない', (T, window) => {
  window.localStorage.clear();
  setupSchool(T);
  swapAcrossTables(T, 8, 17);
  T.render();
  const data = T.buildSetupSnapshot();
  delete data.aisleEvery; delete data.podiumOffset;
  data.tables.forEach((t) => { delete t.seatList; delete t.id; delete t.index; delete t.removedAisles; });
  T.buildTables();
  T.applyNamedSave('setup', data);
  assertSeatsLinked(T);
  assertNoOverlapInDom(window.document);
  const desk2 = T.state.tables[1].rowSeats.map((s) => (s ? s.num : 0));
  assert(desk2.indexOf(17) !== -1 && desk2.indexOf(8) === -1, `机2の並びが違います: ${desk2}`);
});

test('「一つ前に戻す」の後も席オブジェクトのつながりが保たれる', (T) => {
  setupSchool(T);
  T.snapshotLayout();
  swapAcrossTables(T, 8, 17);
  assert(T.undoLayout() === true, 'undoLayoutが失敗しました');
  assertSeatsLinked(T);
});

/* ============================================================
 * 9. 講演会の隣同士グループ（固定席・空席固定・通路があっても離れない）
 * ========================================================== */
console.log('\n=== 9. 講演会の隣同士グループ ===');

// アプリの実装とは独立に「隣同士か」を判定する
function groupSeatsAdjacent(T, group) {
  const where = [];
  T.state.tables.forEach((t) => {
    t.seats.forEach((s) => {
      const o = s.fixedName || s.name;
      if (o && group.indexOf(o) !== -1) where.push({ t, s });
    });
  });
  if (where.length !== group.length) return `メンバー全員の席が見つかりません (${where.length}/${group.length})`;
  const tbl = where[0].t;
  if (T.state.lectureStyle === 'desk') {
    // 机ごとに席が続いていること。複数の机なら、同じ列(縦)で連続する前後の机で、
    // 前後の机どうしの区間が真ん前・真後ろで重なっていること。左右の机はNG。
    const cols = T.state.deskColumns;
    const byDesk = {};
    where.forEach((w) => {
      const di = T.state.tables.indexOf(w.t);
      (byDesk[di] = byDesk[di] || []).push((w.t.rowSeats || w.t.seats).indexOf(w.s));
    });
    const desks = Object.keys(byDesk).map(Number).sort((a, b) => a - b);
    const ranges = desks.map((d) => {
      const idx = byDesk[d].sort((a, b) => a - b);
      for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return null;
      return [idx[0], idx[idx.length - 1]];
    });
    for (let i = 0; i < desks.length; i++) {
      if (!ranges[i]) return `机${T.state.tables[desks[i]].index}の中で席が続いていません (位置 ${byDesk[desks[i]]})`;
      if (i > 0) {
        if (desks[i] - desks[i - 1] !== cols) return `前後に並んだ机ではありません (机の位置 ${desks}, 1行${cols}台)`;
        if (ranges[i][0] > ranges[i - 1][1] || ranges[i][1] < ranges[i - 1][0]) return `前後の机で真ん前・真後ろになっていません (${JSON.stringify(ranges)})`;
      }
    }
    return null;
  }
  if (where.some((w) => w.t !== tbl)) return `別の列に分かれています: ${where.map((w) => w.s.num)}`;
  const idx = where.map((w) => tbl.rowSeats.indexOf(w.s)).sort((a, b) => a - b);
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] !== idx[i - 1] + 1) return `列の中で離れています (位置 ${idx})`;
    const ae = T.state.aisleEvery || 0;
    if (ae > 0 && idx[i] % ae === 0) {
      const aisleNo = idx[i] / ae - 1;
      if (!(tbl.removedAisles || {})[aisleNo]) return `通路をはさんでいます (位置 ${idx})`;
    }
  }
  return null;
}
function shuffled(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function drawOneByOne(T, names) {
  shuffled(names).forEach((name) => {
    const free = [];
    T.state.tables.forEach((t) => t.seats.forEach((s) => {
      if (!s.fixedName && !s.name && s.num <= T.state.totalParticipants) free.push(s.num);
    }));
    const pick = T.pickSeatForName(name, free);
    const seat = T.findSeatByNum(pick.seatNum);
    seat.name = name;
    T.state.participants.push({ id: 'p' + name, name, fixed: false, assigned: true, seatNum: seat.num });
  });
}
function drawAllViaUi(T) {
  T.drawAllAtOnce();
  const yes = document.querySelector('.modal-overlay .modal-delete');
  assert(!!yes, '一括くじ引きの確認ダイアログが出ませんでした');
  yes.click();
}
// シアター形式 3列×6席、3席ごとに通路。列1: 2番=講師(固定)、5番=空席固定
function setupTheaterWithFixed(T) {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'row'; T.state.shape = 'lecture';
  T.state.totalParticipants = 18; T.state.tableCount = 3; T.state.seatCounts = [6, 6, 6];
  T.buildTables();
  T.state.aisleEvery = 3;
  T.state.step = 'layout';
  T.findSeatByNum(2).fixedName = '講師';
  T.makeSeatVacant(T.findSeatByNum(5));
  const names = ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
  T.state.presetNamesText = names.join('\n');
  T.prepareBlanks();
  return names.filter((n) => n !== '講師');
}

test('一括くじ引き: 固定席の講師と同じグループの人が講師の隣になる (40回)', (T) => {
  for (let r = 0; r < 40; r++) {
    setupTheaterWithFixed(T);
    T.state.pairGroups = [['講師', 'A'], ['B', 'C', 'D']];
    drawAllViaUi(T);
    T.state.pairGroups.forEach((g) => {
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} グループ[${g}]: ${err}`);
    });
  }
});

test('1人ずつくじ引き: 固定席・空席固定・通路があってもグループが離れない (60回)', (T) => {
  for (let r = 0; r < 60; r++) {
    const guests = setupTheaterWithFixed(T);
    T.state.pairGroups = [['講師', 'A'], ['B', 'C', 'D'], ['E', 'F']];
    drawOneByOne(T, guests);
    T.state.pairGroups.forEach((g) => {
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} グループ[${g}]: ${err}`);
    });
    const seated = T.state.participants.length;
    assert(seated === guests.length + 1, `全員に席が割り当てられていません: ${seated}`);
  }
});

test('シアター形式: 通路をはさんだ席は「隣」にしない (40回)', (T) => {
  for (let r = 0; r < 40; r++) {
    T.state.eventType = 'lecture'; T.state.lectureStyle = 'row'; T.state.shape = 'lecture';
    T.state.totalParticipants = 12; T.state.tableCount = 2; T.state.seatCounts = [6, 6];
    T.buildTables();
    T.state.aisleEvery = 3;
    T.state.step = 'layout';
    T.state.presetNamesText = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'W', 'X', 'Y', 'Z'].join('\n');
    T.state.pairGroups = [['A', 'B'], ['C', 'D'], ['E', 'F'], ['G', 'H']];
    T.prepareBlanks();
    drawAllViaUi(T);
    T.state.pairGroups.forEach((g) => {
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} グループ[${g}]: ${err}`);
    });
  }
});

test('スクール形式: 固定席と空席固定があっても1人ずつくじ引きで同じ机になる (60回)', (T) => {
  for (let r = 0; r < 60; r++) {
    T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
    T.state.deskSeatsPerTable = 2; T.state.deskColumns = 3;
    T.state.totalParticipants = 10; T.state.tableCount = 6; T.state.seatCounts = [2, 2, 2, 2, 2, 2];
    T.buildTables();
    T.state.step = 'layout';
    T.findSeatByNum(1).fixedName = '講師';
    T.makeSeatVacant(T.findSeatByNum(4));
    const names = ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    T.state.presetNamesText = names.join('\n');
    T.state.pairGroups = [['A', 'B'], ['C', 'D'], ['E', 'F']];
    T.prepareBlanks();
    drawOneByOne(T, names.filter((n) => n !== '講師'));
    T.state.pairGroups.forEach((g) => {
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} グループ[${g}]: ${err}`);
    });
  }
});

/* ============================================================
 * 10. 隣同士にできないグループは、設定（座席レイアウト）の時点で警告する
 * ========================================================== */
console.log('\n=== 10. 隣同士グループの設定時チェック ===');

function setupDesks(T, desks, perDesk, people, names) {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = perDesk; T.state.deskColumns = 3;
  T.state.totalParticipants = people; T.state.tableCount = desks;
  T.state.seatCounts = Array(desks).fill(perDesk);
  T.buildTables();
  T.state.presetNamesText = names.join('\n');
  T.state.step = 'layout';
}
function warningText(document) {
  const w = document.querySelector('.pair-group-warning');
  return w ? w.textContent : null;
}

test('問題ない設定では警告が出ない', (T) => {
  setupDesks(T, 3, 2, 6, ['A', 'B', 'C', 'D', 'E', 'F']);
  T.state.pairGroups = [['A', 'B'], ['C', 'D']];
  T.render();
  assert(warningText(document) === null, `警告が出てしまいました: ${warningText(document)}`);
});

test('机に入りきらない人数のグループは、レイアウト画面で名前付きの警告が出る', (T) => {
  setupDesks(T, 3, 2, 6, ['A', 'B', 'C', 'D', 'E', 'F']);
  T.state.pairGroups = [['A', 'B', 'C']];
  T.render();
  const txt = warningText(document);
  assert(txt && txt.indexOf('「A・B・C」') !== -1, `警告が出ていないか、グループ名がありません: ${txt}`);
});

test('固定席で隣がふさがると警告が出て、固定を外すと消える', (T) => {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'row'; T.state.shape = 'lecture';
  T.state.totalParticipants = 6; T.state.tableCount = 2; T.state.seatCounts = [3, 3];
  T.buildTables();
  T.state.aisleEvery = 0;
  T.state.presetNamesText = ['講師', 'A', 'X', 'Y', 'B', 'C'].join('\n');
  T.state.step = 'layout';
  T.state.pairGroups = [['講師', 'A']];
  T.findSeatByNum(2).fixedName = '講師';
  T.findSeatByNum(1).fixedName = 'X';
  T.findSeatByNum(3).fixedName = 'Y';
  T.render();
  const txt = warningText(document);
  assert(txt && txt.indexOf('「講師・A」') !== -1, `講師の両隣がふさがっているのに警告が出ません: ${txt}`);
  T.findSeatByNum(3).fixedName = null;
  T.render();
  assert(warningText(document) === null, '固定を外したのに警告が消えません');
});

test('全員固定席のグループが離れた席に固定されていたら警告が出る', (T) => {
  setupDesks(T, 3, 2, 6, ['A', 'B', 'C', 'D', 'E', 'F']);
  T.state.pairGroups = [['A', 'B']];
  T.findSeatByNum(1).fixedName = 'A';
  T.findSeatByNum(5).fixedName = 'B';
  T.render();
  assert(warningText(document), '別の机に固定されたグループなのに警告が出ません');
});

test('1つずつなら座れるが全グループ同時は無理なときも警告が出る', (T) => {
  setupDesks(T, 3, 2, 6, ['A', 'B', 'C', 'D', 'X', 'Y']);
  T.state.pairGroups = [['A', 'B'], ['C', 'D']];
  T.findSeatByNum(1).fixedName = 'X';
  T.findSeatByNum(3).fixedName = 'Y';
  const res = T.checkPairGroupsFeasible();
  assert(!res.ok && res.combined, `全体としては無理と判定されていません: ${JSON.stringify(res)}`);
  T.render();
  assert(warningText(document), '警告が出ません');
});

test('警告が出ているときに「くじ引きをはじめる」を押すと確認が出る', (T) => {
  setupDesks(T, 3, 2, 6, ['A', 'B', 'C', 'D', 'E', 'F']);
  T.state.pairGroups = [['A', 'B', 'C']];
  T.render();
  const startBtn = Array.from(document.querySelectorAll('.bottom-nav .primary-btn')).find((b) => b.textContent.indexOf('くじ引きをはじめる') !== -1);
  assert(startBtn, '「くじ引きをはじめる」ボタンが見つかりません');
  startBtn.click();
  const confirmBox = document.querySelector('.modal-overlay');
  assert(confirmBox && confirmBox.textContent.indexOf('隣同士にできないグループ') !== -1, '確認ダイアログが出ません');
  assert(T.state.step === 'layout', 'OKを押す前に画面が進んでしまいました');
  confirmBox.querySelector('.modal-delete').click();
  assert(T.state.step === 'draw', `OK後にくじ引き画面へ進みません: ${T.state.step}`);
});

/* ============================================================
 * 11. スクール形式：机に入りきらないグループは前後の机まで（左右はNG）
 * ========================================================== */
console.log('\n=== 11. 机に入りきらないグループ（前後の机） ===');

function deskIdxOf(T, name) {
  return T.state.tables.findIndex((t) => t.seats.some((s) => (s.fixedName || s.name) === name));
}

test('2人机に4人グループ: 前後2つの机に分かれて座る・左右にはまたがない (一括 40回)', (T) => {
  for (let r = 0; r < 40; r++) {
    setupDesks(T, 9, 2, 18, 'ABCDEFGHIJKLMNOPQR'.split(''));
    T.state.pairGroups = [['A', 'B', 'C', 'D']];
    T.prepareBlanks();
    T.render();
    assert(warningText(document) === null, `前後の机に座れるのに警告が出ました: ${warningText(document)}`);
    drawAllViaUi(T);
    const err = groupSeatsAdjacent(T, ['A', 'B', 'C', 'D']);
    assert(!err, `回${r}: ${err}`);
    const desks = new Set(['A', 'B', 'C', 'D'].map((n) => deskIdxOf(T, n)));
    assert(desks.size === 2, `回${r}: 机2つにおさまっていません (${[...desks]})`);
  }
});

test('2人机に4人グループ: 1人ずつくじ引きでも前後の机 (60回)', (T) => {
  for (let r = 0; r < 60; r++) {
    setupDesks(T, 9, 2, 18, 'ABCDEFGHIJKLMNOPQR'.split(''));
    T.findSeatByNum(3).fixedName = 'R';
    T.state.pairGroups = [['A', 'B', 'C', 'D'], ['E', 'F']];
    T.prepareBlanks();
    drawOneByOne(T, 'ABCDEFGHIJKLMNOPQ'.split(''));
    [['A', 'B', 'C', 'D'], ['E', 'F']].forEach((g) => {
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} グループ[${g}]: ${err}`);
    });
    // 2人グループは机に入りきるので、前後にまたがってはいけない
    assert(deskIdxOf(T, 'E') === deskIdxOf(T, 'F'), `回${r}: 机に入りきる2人グループが別の机になりました`);
  }
});

test('前後に机が無い（1行だけ）なら、入りきらないグループは警告', (T) => {
  setupDesks(T, 3, 2, 6, ['A', 'B', 'C', 'D', 'E', 'F']);
  T.state.pairGroups = [['A', 'B', 'C']];
  T.render();
  assert(warningText(document), '1行3台の机で3人グループなのに警告が出ません（左右の机は不可のため）');
});

/* ============================================================
 * 12. 全体点検で見つかった不具合の回帰テスト
 * ========================================================== */
console.log('\n=== 12. 全体点検の回帰テスト ===');

test('空席指定/解除をくり返し、空の机が消えた後でも席番号・机番号が重複しない (1人机 300回)', (T) => {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 1; T.state.deskColumns = 3;
  T.state.totalParticipants = 6; T.state.tableCount = 6; T.state.seatCounts = [1, 1, 1, 1, 1, 1];
  T.buildTables();
  T.state.step = 'layout';
  for (let i = 0; i < 300; i++) {
    const seats = [];
    T.state.tables.forEach((t) => t.seats.forEach((x) => seats.push(x)));
    const seat = seats[Math.floor(Math.random() * seats.length)];
    if (Math.random() < 0.6) T.makeSeatVacant(seat); else T.unmakeSeatVacant(seat);
    T.render(); // ここで空の机が自動で消える
    const nums = [], ids = [], labels = [];
    T.state.tables.forEach((t) => { ids.push(t.id); labels.push(t.index); t.seats.forEach((x) => nums.push(x.num)); });
    assert(new Set(nums).size === nums.length, `回${i}: 席番号が重複しました ${nums}`);
    assert(new Set(ids).size === ids.length, `回${i}: 机のidが重複しました ${ids}`);
    assert(new Set(labels).size === labels.length, `回${i}: 机の番号が重複しました ${labels}`);
    for (let n = 1; n <= 6; n++) assert(nums.indexOf(n) !== -1, `回${i}: 席${n}が無くなりました`);
  }
});

test('同じ名前を別の席に固定しようとすると確認が出て、OKなら移動する', (T) => {
  T.state.eventType = 'dining'; T.state.shape = 'circle';
  T.state.totalParticipants = 4; T.state.tableCount = 1; T.state.seatCounts = [4];
  T.buildTables();
  T.state.step = 'layout';
  T.findSeatByNum(1).fixedName = 'ゆい';
  T.openFixedModal(T.findSeatByNum(3));
  document.querySelector('.modal-overlay .modal-input').value = 'ゆい';
  document.querySelector('.modal-overlay .modal-save').onclick();
  const confirmBox = document.querySelector('.modal-overlay');
  assert(confirmBox && confirmBox.textContent.indexOf('席 1 に固定されています') !== -1, '重複の確認が出ません');
  assert(T.findSeatByNum(3).fixedName !== 'ゆい', 'OK前に固定されてしまいました');
  confirmBox.querySelector('.modal-delete').click();
  assert(T.findSeatByNum(3).fixedName === 'ゆい', '移動先に固定されていません');
  assert(!T.findSeatByNum(1).fixedName, '元の席の固定が残っています（2席に同じ人）');
});

test('くじ引きの後にレイアウトへ戻って「くじ引きをはじめる」→確認→前回の名前が消えて最初から', (T) => {
  T.state.eventType = 'dining'; T.state.shape = 'circle';
  T.state.totalParticipants = 4; T.state.tableCount = 1; T.state.seatCounts = [4];
  T.buildTables();
  T.state.presetNamesText = ['講師', 'A', 'B', 'C'].join('\n');
  T.findSeatByNum(1).fixedName = '講師';
  T.prepareBlanks();
  T.findSeatByNum(2).name = 'A';
  T.state.participants.push({ id: 'a', name: 'A', fixed: false, assigned: true, seatNum: 2 });
  T.state.step = 'layout';
  T.render();
  const startBtn = Array.from(document.querySelectorAll('.bottom-nav .primary-btn')).find((b) => b.textContent.indexOf('くじ引きをはじめる') !== -1);
  startBtn.click();
  const confirmBox = document.querySelector('.modal-overlay');
  assert(confirmBox && confirmBox.textContent.indexOf('リセット') !== -1, 'リセットの確認が出ません');
  confirmBox.querySelector('.modal-delete').click();
  assert(!T.findSeatByNum(2).name, '前回くじの名前が席に残っています');
  assert(T.state.participants.length === 1 && T.state.participants[0].name === '講師', '参加者一覧が固定席の人だけになっていません');
  assert(T.state.step === 'draw', `くじ引き画面に進みません: ${T.state.step}`);
});

/* ============================================================
 * 13. 以前の不具合の時期に保存されたデータ・不整合な状態からの自動修復
 * ========================================================== */
console.log('\n=== 13. 壊れた保存データからの修復 ===');

test('以前の不具合で席が並びから外れた保存データを開いても、席が消えず重ならない（新旧形式）', (T, window) => {
  ['new', 'old'].forEach((fmt) => {
    setupSchool(T);
    T.state.totalParticipants = 32;
    const data = T.buildSetupSnapshot();
    data.tables[1].rowOrder = [5, 6, 7, 0]; // 8番がどの並びにも無い（スクショの状態）
    data.tables[1].fixedNamesByNum = { 5: 'あかさ', 6: 'たなさ', 7: 'まやら' };
    if (fmt === 'old') data.tables.forEach((t) => { delete t.seatList; delete t.id; delete t.index; });
    T.applyNamedSave('setup', data);
    const nums = [];
    T.state.tables.forEach((t) => t.seats.forEach((x) => nums.push(x.num)));
    for (let n = 1; n <= 32; n++) assert(nums.indexOf(n) !== -1, `${fmt}: 席${n}が消えました`);
    assertSeatsLinked(T);
    assertNoOverlapInDom(window.document);
    const desk2 = T.state.tables[1].rowSeats.map((x) => (x ? x.num : 0));
    assert(desk2.join() === '5,6,7,8', `${fmt}: 机2の並びが戻っていません: ${desk2}`);
  });
});

test('どんな経路でも、並びに無い席は描画前に並びへ戻る（机・長テーブル）', (T, window) => {
  setupSchool(T);
  const d2 = T.state.tables[1];
  d2.rowSeats[3] = null; // 8番を並びから外す（seatsには残す）
  T.render();
  assertSeatsLinked(T);
  assertNoOverlapInDom(window.document);

  T.state.eventType = 'dining'; T.state.shape = 'square';
  T.state.totalParticipants = 8; T.state.tableCount = 1; T.state.seatCounts = [8];
  T.buildTables();
  T.state.step = 'layout';
  const t0 = T.state.tables[0];
  const gone = t0.sides.top.pop();
  T.render();
  assertSeatsLinked(T);
  assert(['top', 'bottom', 'left', 'right'].some((k) => t0.sides[k].indexOf(gone) !== -1), '長テーブルの席が辺に戻っていません');
});

/* ============================================================
 * 14. スクール形式：机の中でも席が続いていること（スクショの5人グループ）
 * ========================================================== */
console.log('\n=== 14. 机の中でも隣同士 ===');

function setupTenDesks(T, fixed) {
  const names = Array.from({ length: 40 }, (_, i) => 'P' + i);
  const grp = ['松永', '鈴木', '藤井', '田中', '佐藤'];
  grp.forEach((g, i) => { names[i] = g; });
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 4; T.state.deskColumns = 3;
  T.state.totalParticipants = 40; T.state.tableCount = 10; T.state.seatCounts = Array(10).fill(4);
  T.buildTables();
  T.state.step = 'layout';
  if (fixed) { T.findSeatByNum(5).fixedName = 'P5'; T.findSeatByNum(6).fixedName = 'P6'; T.findSeatByNum(7).fixedName = 'P7'; }
  T.state.presetNamesText = names.join('\n');
  T.state.pairGroups = [grp];
  T.prepareBlanks();
  return names.filter((n) => !fixed || ['P5', 'P6', 'P7'].indexOf(n) === -1);
}

[false, true].forEach((fixed) => {
  test(`4人机に5人グループ${fixed ? '（固定席あり）' : ''}: 一括くじ引きで机の中も前後も隣同士 (40回)`, (T) => {
    for (let r = 0; r < 40; r++) {
      setupTenDesks(T, fixed);
      T.render();
      assert(warningText(document) === null, `警告が出てしまいました: ${warningText(document)}`);
      drawAllViaUi(T);
      const err = groupSeatsAdjacent(T, ['松永', '鈴木', '藤井', '田中', '佐藤']);
      assert(!err, `回${r}: ${err}`);
    }
  });
  test(`4人机に5人グループ${fixed ? '（固定席あり）' : ''}: 1人ずつくじ引きでも隣同士 (40回)`, (T) => {
    for (let r = 0; r < 40; r++) {
      const guests = setupTenDesks(T, fixed);
      drawOneByOne(T, guests);
      const err = groupSeatsAdjacent(T, ['松永', '鈴木', '藤井', '田中', '佐藤']);
      assert(!err, `回${r}: ${err}`);
    }
  });
});

test('4人机に3人グループは、1つの机の中で続いた席に座る (1人ずつ 60回)', (T) => {
  for (let r = 0; r < 60; r++) {
    setupDesks(T, 6, 4, 24, Array.from({ length: 24 }, (_, i) => 'Q' + i));
    T.state.pairGroups = [['Q0', 'Q1', 'Q2'], ['Q3', 'Q4']];
    T.prepareBlanks();
    drawOneByOne(T, Array.from({ length: 24 }, (_, i) => 'Q' + i));
    [['Q0', 'Q1', 'Q2'], ['Q3', 'Q4']].forEach((g) => {
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} [${g}]: ${err}`);
      const desks = new Set(g.map((n) => deskIdxOf(T, n)));
      assert(desks.size === 1, `回${r} [${g}]: 1つの机に入るのに分かれました`);
    });
  }
});

/* ============================================================
 * 15. 座席結果を開いて、続きのくじ引きができる
 * ========================================================== */
console.log('\n=== 15. 座席結果から続きのくじ引き ===');

test('途中まで引いた座席結果を保存→開く→「もう一度くじ引き画面へ」で続きが引ける', (T, window) => {
  window.localStorage.clear();
  const names = ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 4; T.state.deskColumns = 2;
  T.state.totalParticipants = 8; T.state.tableCount = 2; T.state.seatCounts = [4, 4];
  T.buildTables();
  T.state.presetNamesText = names.join('\n');
  T.state.pairGroups = [];
  T.findSeatByNum(1).fixedName = '講師';
  T.state.step = 'layout';
  T.prepareBlanks();
  // 3人だけ引いた状態
  ['A', 'B', 'C'].forEach((n) => {
    const free = [];
    T.state.tables.forEach((t) => t.seats.forEach((s) => { if (!s.fixedName && !s.name) free.push(s.num); }));
    const seat = T.findSeatByNum(T.pickSeatForName(n, free).seatNum);
    seat.name = n;
    T.state.participants.push({ id: n, name: n, fixed: false, assigned: true, seatNum: seat.num });
  });
  T.state.step = 'result';
  T.saveNamed('result', '途中');

  // 別の状態にしてから開く
  T.state.step = 'start'; T.state.participants = []; T.state.blankTotal = undefined; T.buildTables();
  T.applyNamedSave('result', T.listNamedSaves('result')[0].data);
  assert(T.state.step === 'result', `結果画面で開いていません: ${T.state.step}`);

  const again = Array.from(document.querySelectorAll('#app .primary-btn')).find((b) => b.textContent.indexOf('もう一度くじ引き画面へ') !== -1);
  assert(again, '「もう一度くじ引き画面へ」ボタンがありません');
  again.onclick();
  assert(T.state.step === 'draw', `くじ引き画面ではなく ${T.state.step} になりました`);
  const header = document.querySelector('#app .draw-header').textContent;
  assert(header.indexOf('4 / 8') !== -1, `決定済みの人数表示が違います: ${header}`);

  // 残り4人を一括で引いて、全員そろう
  T.drawAllAtOnce();
  document.querySelector('.modal-overlay .modal-delete').click();
  const assigned = T.state.participants.filter((p) => p.assigned);
  assert(assigned.length === 8, `全員に席が割り当てられていません: ${assigned.length}/8`);
  ['A', 'B', 'C'].forEach((n) => {
    assert(assigned.filter((p) => p.name === n).length === 1, `${n}さんが二重に割り当てられています`);
  });
  const seatNames = [];
  T.state.tables.forEach((t) => t.seats.forEach((s) => { const o = s.fixedName || s.name; if (o) seatNames.push(o); }));
  assert(new Set(seatNames).size === 8, `席の名前が重複・不足しています: ${seatNames}`);

  // くじ引き画面から戻るとレイアウト画面
  T.state.step = 'draw'; T.state.history = ['start', 'setup', 'layout'];
  T.goBack();
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
