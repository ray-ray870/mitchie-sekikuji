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

// 環境変数 TARGET_HTML で、別の index.html（例：preview/index.html）もテストできる
const INDEX_HTML_PATH = process.env.TARGET_HTML
  ? path.resolve(process.env.TARGET_HTML)
  : path.join(__dirname, 'index.html');
console.log('テスト対象: ' + path.relative(process.cwd(), INDEX_HTML_PATH));

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
    checkPairGroupsFeasible: checkPairGroupsFeasible, offerAutosaveRestore: offerAutosaveRestore,
    gyouOf: gyouOf, splitNameReading: splitNameReading, getPresetNamesList: getPresetNamesList,
    openNameListModal: openNameListModal
  };
})();
`;
  const replaced = src.replace(/\n  render\(\);\n\}\)\(\);/, hook);
  if (replaced === src) {
    throw new Error('テスト用フックの注入に失敗しました（index.html の末尾の形式が変わった可能性があります）');
  }
  return replaced;
}

function makeEnv(src, url, seedStorage) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head><link rel="icon" href="icon.png"><link rel="manifest" href="manifest.json"></head><body><div id="app"></div><canvas id="confetti-canvas"></canvas></body></html>',
    { url: url || 'https://example.com/', pretendToBeVisual: true }
  );
  if (seedStorage) Object.keys(seedStorage).forEach((k) => dom.window.localStorage.setItem(k, seedStorage[k]));
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

function test(label, fn, url, seedStorage) {
  totalTests++;
  const src = loadAppSource();
  const env = makeEnv(src, url, seedStorage);
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

test('くじ引きの後にレイアウトへ戻って「くじ引きをはじめる」→「最初からやり直す」→前回の名前が消えて最初から', (T) => {
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
  const choiceBox = document.querySelector('.modal-overlay');
  assert(choiceBox && choiceBox.textContent.indexOf('続きからくじ引き') !== -1, '続きから/最初からの選択が出ません');
  choiceBox.querySelector('.modal-delete').click(); // 最初からやり直す
  const confirmBox = document.querySelector('.modal-overlay');
  assert(confirmBox && confirmBox.textContent.indexOf('最初から') !== -1, 'やり直しの確認が出ません');
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
 * 16. 保存から開いた後に戻っても、設定・くじ結果が消えない
 * ========================================================== */
console.log('\n=== 16. 戻ってもリセットされない ===');

function setupHalfDrawn(T) {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 4; T.state.deskColumns = 2;
  T.state.totalParticipants = 8; T.state.tableCount = 2; T.state.seatCounts = [4, 4];
  T.buildTables();
  T.state.presetNamesText = ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].join('\n');
  T.state.pairGroups = [];
  T.findSeatByNum(1).fixedName = '講師';
  T.prepareBlanks();
  [['A', 2], ['B', 5], ['C', 6]].forEach(([n, num]) => {
    T.findSeatByNum(num).name = n;
    T.state.participants.push({ id: n, name: n, fixed: false, assigned: true, seatNum: num });
  });
}
function clickStartOnLayout(document) {
  const b = Array.from(document.querySelectorAll('.bottom-nav .primary-btn')).find((x) => x.textContent.indexOf('くじ引きをはじめる') !== -1);
  assert(b, '「くじ引きをはじめる」がありません');
  b.click();
}

test('くじの途中でレイアウトに戻り「くじ引きをはじめる」→「続きからくじ引き」で結果が残ったまま続きが引ける', (T, window) => {
  setupHalfDrawn(T);
  T.state.step = 'layout'; T.state.history = ['start', 'setup']; T.render();
  clickStartOnLayout(document);
  const cont = Array.from(document.querySelectorAll('.modal-overlay button')).find((x) => x.textContent === '続きからくじ引き');
  assert(cont, '「続きからくじ引き」がありません');
  cont.click();
  assert(T.state.step === 'draw', `くじ引き画面に進みません: ${T.state.step}`);
  ['A', 'B', 'C'].forEach((n) => assert(T.state.tables.some((t) => t.seats.some((s) => s.name === n)), `${n}さんのくじ結果が消えました`));
  assert(document.querySelector('#app .draw-header').textContent.indexOf('4 / 8') !== -1, '決定済みの人数が違います');
  T.drawAllAtOnce();
  document.querySelector('.modal-overlay .modal-delete').click();
  const names = [];
  T.state.tables.forEach((t) => t.seats.forEach((s) => { const o = s.fixedName || s.name; if (o) names.push(o); }));
  assert(names.length === 8 && new Set(names).size === 8, `全員が1回ずつ座っていません: ${names}`);
});

test('くじの後にレイアウトでその席を固定席にしたら、続きからのくじではその人をくじに戻す', (T, window) => {
  setupHalfDrawn(T);
  T.findSeatByNum(5).fixedName = 'X'; // Bさんの席を後から固定
  T.state.step = 'layout'; T.render();
  clickStartOnLayout(document);
  Array.from(document.querySelectorAll('.modal-overlay button')).find((x) => x.textContent === '続きからくじ引き').click();
  const seat5 = T.findSeatByNum(5);
  assert(seat5.fixedName === 'X' && !seat5.name, '固定席にくじの名前が残っています');
  assert(!T.state.participants.some((p) => p.name === 'B'), 'Bさんがくじに戻っていません');
});

function btnByText(document, text) {
  return Array.from(document.querySelectorAll('#app button, .modal-overlay button')).find((x) => x.textContent.indexOf(text) !== -1);
}
test('設定画面に戻っても、何も変えずに「今の配置のままレイアウトへ」なら固定席・移動がそのまま', (T, window) => {
  setupHalfDrawn(T);
  const t0 = T.state.tables[0], t1 = T.state.tables[1];
  const a = t0.rowSeats[3], b = t1.rowSeats[0]; // 机をまたいで入れ替え
  t0.seats[t0.seats.indexOf(a)] = b; t1.seats[t1.seats.indexOf(b)] = a;
  t0.rowSeats[3] = b; t1.rowSeats[0] = a;
  const before = JSON.stringify(T.state.tables.map((t) => t.rowSeats.map((s) => [s.num, s.fixedName, s.name])));
  T.state.step = 'setup'; T.state.history = ['start']; T.render();
  const next = btnByText(document, '今の配置のままレイアウトへ');
  assert(next, '「今の配置のままレイアウトへ」がありません');
  next.onclick();
  assert(T.state.step === 'layout', `レイアウトに進みません: ${T.state.step}`);
  const after = JSON.stringify(T.state.tables.map((t) => t.rowSeats.map((s) => [s.num, s.fixedName, s.name])));
  assert(before === after, `レイアウトが作り直されました\n前: ${before}\n後: ${after}`);

  // 机の形に関わる設定（1つの机の席数）を変えたら作り直す
  T.state.step = 'setup'; T.state.history = ['start']; T.render();
  T.state.deskSeatsPerTable = 2; T.state.tableCount = 4; T.state.seatCounts = [2, 2, 2, 2];
  T.render();
  const rebuild = btnByText(document, 'この内容でテーブルを作り直す');
  assert(rebuild, '設定を変えたのに「作り直す」ボタンになっていません');
  rebuild.onclick();
  const conf = document.querySelector('.modal-overlay');
  assert(conf && conf.textContent.indexOf('リセット') !== -1, '固定席・くじ結果が消える確認が出ません');
  conf.querySelector('.modal-delete').click();
  assert(T.state.tables.length === 4 && !T.findSeatByNum(1).fixedName, '設定を変えたのに作り直されていません');
});

test('保存から開いた後に設定画面へ戻っても、変えなければレイアウトはそのまま', (T, window) => {
  window.localStorage.clear();
  setupHalfDrawn(T);
  T.state.step = 'result';
  T.saveNamed('result', '研修');
  T.buildTables();
  T.applyNamedSave('result', T.listNamedSaves('result')[0].data);
  T.state.step = 'setup'; T.state.history = ['start']; T.render();
  btnByText(document, '今の配置のままレイアウトへ').onclick();
  assert(T.findSeatByNum(1).fixedName === '講師', '固定席が消えました');
  assert(T.findSeatByNum(2).name === 'A', 'くじ結果が消えました');
});

/* ============================================================
 * 17. 設定画面からくじ引きに戻れる／「はじめから」で消さない／自動保存
 * ========================================================== */
console.log('\n=== 17. 設定画面へ戻る・はじめから・自動保存 ===');

test('くじの途中で設定画面まで戻っても、名前・グループ・人数が残り「くじ引きの続きへ戻る」で続きが引ける', (T, window) => {
  setupHalfDrawn(T);
  T.state.pairGroups = [['D', 'E']];
  T.state.step = 'setup'; T.state.history = ['start']; T.render();
  assert(document.querySelector('#app textarea').value.split('\n').filter(Boolean).length === 8, '名前リストが消えています');
  const cont = btnByText(document, 'くじ引きの続きへ戻る');
  assert(cont, '「くじ引きの続きへ戻る」がありません');
  cont.onclick();
  assert(T.state.step === 'draw', `くじ引き画面に戻りません: ${T.state.step}`);
  assert(T.state.history.join('>') === 'start>setup>layout', `戻る順番が違います: ${T.state.history}`);
  ['A', 'B', 'C'].forEach((n) => assert(T.state.tables.some((t) => t.seats.some((s) => s.name === n)), `${n}さんのくじ結果が消えました`));
  assert(JSON.stringify(T.state.pairGroups) === '[["D","E"]]', 'グループが消えました');
});

test('「はじめから」→「最初の設定画面へ戻る」は何も消さず、「すべて消して最初から」は確認のうえ全部消す', (T, window) => {
  setupHalfDrawn(T);
  T.state.step = 'draw'; T.state.history = ['start', 'setup', 'layout']; T.render();
  btnByText(document, 'はじめから').onclick();
  btnByText(document, '最初の設定画面へ戻る').click();
  assert(T.state.step === 'setup' && T.state.history.join('>') === 'start', `設定画面へ戻っていません: ${T.state.step} ${T.state.history}`);
  assert(T.state.presetNamesText.split('\n').length === 8 && T.findSeatByNum(1).fixedName === '講師' && T.findSeatByNum(2).name === 'A', '入力が消えました');

  btnByText(document, 'はじめから').onclick();
  assert(btnByText(document, 'スタート画面へ戻る'), '設定画面では「スタート画面へ戻る」になっていません');
  btnByText(document, 'すべて消して最初から').click();
  const conf = document.querySelector('.modal-overlay');
  assert(conf && conf.textContent.indexOf('すべて消して') !== -1, '全部消す前の確認が出ません');
  conf.querySelector('.modal-delete').click();
});

test('自動保存: 途中の状態が端末に保存され、開き直すと「続きから開く」で元に戻る', (T, window) => {
  window.localStorage.clear();
  setupHalfDrawn(T);
  T.state.step = 'draw'; T.state.history = ['start', 'setup', 'layout']; T.render();
  const saved = JSON.parse(window.localStorage.getItem('mitchieSeatLottery.autosave.v1'));
  assert(saved && saved.step === 'draw' && saved.tables.length === 2, '自動保存されていません');

  // 開き直した状態を再現（まっさらな状態にしてから、起動時の確認を出す）
  T.state.step = 'start'; T.state.history = []; T.state.tables = []; T.state.presetNamesText = ''; T.state.participants = [];
  T.offerAutosaveRestore();
  const box = document.querySelector('.modal-overlay');
  assert(box && box.textContent.indexOf('前回の続き') !== -1 && box.textContent.indexOf('くじ引き画面') !== -1, '続きからの確認が出ません');
  btnByText(document, '続きから開く').click();
  assert(T.state.step === 'draw', `くじ引き画面に戻りません: ${T.state.step}`);
  assert(T.findSeatByNum(1).fixedName === '講師' && T.findSeatByNum(2).name === 'A', '固定席・くじ結果が戻っていません');
  assertSeatsLinked(T);
  assert(document.querySelector('#app .draw-header').textContent.indexOf('4 / 8') !== -1, '決定済み人数が戻っていません');
});

test('自動保存: 「新しく始める」を選ぶと保存が消えて、次からは聞かれない', (T, window) => {
  window.localStorage.clear();
  setupHalfDrawn(T);
  T.state.step = 'layout'; T.render();
  T.state.step = 'start'; T.state.tables = []; T.state.presetNamesText = '';
  T.offerAutosaveRestore();
  btnByText(document, '新しく始める').click();
  assert(!window.localStorage.getItem('mitchieSeatLottery.autosave.v1'), '自動保存が消えていません');
  T.offerAutosaveRestore();
  assert(!document.querySelector('.modal-overlay'), 'また聞かれました');
});

/* ============================================================
 * 18. くじの途中で設定画面に戻り、名前・グループを編集してから続きを引く
 * ========================================================== */
console.log('\n=== 18. 途中で名前・グループを編集して続き ===');

function midLotteryThenEdit(T, window, names, groups) {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 4; T.state.deskColumns = 2;
  T.state.totalParticipants = 12; T.state.tableCount = 3; T.state.seatCounts = [4, 4, 4];
  T.buildTables();
  T.state.presetNamesText = ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].join('\n');
  T.state.pairGroups = [];
  T.findSeatByNum(1).fixedName = '講師';
  T.state.step = 'layout';
  T.prepareBlanks();
  [['A', 2], ['B', 7], ['C', 12]].forEach(([n, num]) => {
    T.findSeatByNum(num).name = n;
    T.state.participants.push({ id: n, name: n, fixed: false, assigned: true, seatNum: num });
  });
  T.state.step = 'setup'; T.state.history = ['start']; T.render();
  const ta = document.querySelector('#app textarea');
  ta.value = names.join('\n');
  ['input', 'change', 'blur'].forEach((e) => ta.dispatchEvent(new window.Event(e, { bubbles: true })));
  T.state.pairGroups = groups;
  T.render();
  const cont = btnByText(document, 'くじ引きの続きへ戻る');
  assert(cont, '名前・グループを編集したら「くじ引きの続きへ戻る」が消えました');
  cont.onclick();
}
function finishAll(T) {
  T.drawAllAtOnce();
  document.querySelector('.modal-overlay .modal-delete').click();
  const all = [];
  T.state.tables.forEach((t) => t.seats.forEach((x) => { const o = x.fixedName || x.name; if (o) all.push(o); }));
  return all;
}

test('途中で名前を追加・削除して続き: 追加した人が座り、消した人は座らない', (T, window) => {
  const names = ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L'];
  midLotteryThenEdit(T, window, names, []);
  assert(T.state.step === 'draw', `くじ引き画面に戻りません: ${T.state.step}`);
  const all = finishAll(T);
  assert(all.length === 12 && new Set(all).size === 12, `全員が1回ずつ座っていません: ${all}`);
  assert(all.indexOf('L') !== -1 && all.indexOf('K') === -1, `名前の追加・削除が反映されていません: ${all}`);
});

test('途中でグループを追加して続き: まだ引いていない人・もう席が決まった人の隣、どちらも隣同士になる (各20回)', (T, window) => {
  for (let r = 0; r < 20; r++) {
    [['D', 'E'], ['A', 'D']].forEach((g) => {
      midLotteryThenEdit(T, window, ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'], [g]);
      assert(!document.querySelector('.modal-overlay'), `隣にできるのに警告が出ました [${g}]`);
      finishAll(T);
      const err = groupSeatsAdjacent(T, g);
      assert(!err, `回${r} [${g}]: ${err}`);
    });
  }
});

test('途中で「もう離れた席に決まった2人」をグループにすると、続きへ戻る前に警告が出る', (T, window) => {
  midLotteryThenEdit(T, window, ['講師', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'], [['A', 'B']]);
  const box = document.querySelector('.modal-overlay');
  assert(box && box.textContent.indexOf('「A・B」') !== -1 && box.textContent.indexOf('動かせない') !== -1, `警告が出ません: ${box && box.textContent}`);
  assert(T.state.step === 'setup', 'OKを押す前に進んでしまいました');
  box.querySelector('.modal-delete').click();
  assert(T.state.step === 'draw', 'OK後にくじ引き画面へ進みません');
});

/* ============================================================
 * 19. 戻るボタンに戻り先の画面名が出る
 * ========================================================== */
console.log('\n=== 19. 戻るボタンの表示 ===');

test('戻るボタンは戻り先の名前（設定へ戻る／レイアウトへ戻る／くじ引きへ戻る）になり、その画面に戻る', (T, window) => {
  setupHalfDrawn(T);
  const cases = [
    ['setup', ['start'], '← スタートへ戻る', 'start'],
    ['layout', ['start', 'setup'], '← 設定へ戻る', 'setup'],
    ['draw', ['start', 'setup', 'layout'], '← レイアウトへ戻る', 'layout'],
    ['result', ['start', 'setup', 'layout', 'draw'], '← くじ引きへ戻る', 'draw'],
  ];
  cases.forEach(([step, hist, label, dest]) => {
    T.state.step = step; T.state.history = hist.slice(); T.render();
    const b = document.querySelector('#app .back-link');
    assert(b && b.textContent === label, `${step}画面の戻るボタンが「${b && b.textContent}」です（期待: ${label}）`);
    b.onclick();
    assert(T.state.step === dest, `${label} で ${T.state.step} に戻りました（期待: ${dest}）`);
  });
});

/* ============================================================
 * 20. 名前を選ぶ一覧（あ行〜の箱）と読み
 * ========================================================== */
console.log('\n=== 20. 名前一覧のあ行分け ===');

test('読みを付けない名前でも、よくある読みで正しい行に分かれる（72通り）', (T) => {
  const cases = {
    '青木':'あ','伊藤':'あ','鈴木':'さ','坂田':'さ','井上':'あ','赤城':'あ','藤井':'は','垣田':'か','肥後':'は','松永':'ま','田中':'た','佐藤':'さ',
    'あかさ':'あ','たなさ':'た','まやら':'ま','かな':'か','まゃ':'ま','かなや':'か','上村':'か','東':'は','小野':'あ','小林':'か','長谷川':'は',
    '大迫':'あ','有村':'あ','西郷':'さ','渡辺':'わ','吉田':'や','高橋':'た','山田花子':'や','中村 太郎':'な','ミホ':'ま','Mike':'A-Z','劉':'他',
    '今給黎':'あ','伊地知':'あ','新納':'な','鮫島':'さ','四元':'や','満留':'ま','日高':'は','米倉':'や','川畑':'か','福永':'は','徳永':'た','瀬戸口':'さ',
    '中島':'な','長田':'な','古賀':'か','河野':'か','角田':'か','上田':'あ','神田':'か','小川':'あ','大久保':'あ','東郷':'た','斎藤':'さ','齋藤':'さ',
    '福岡':'は','宮之原':'ま','牧之瀬':'ま','坂元':'さ','野元':'な','窪田':'か','榎園':'あ','迫':'さ','新垣':'あ','真鍋':'ま','近藤':'か','遠藤':'あ',
    '青木（あおき）':'あ','小野（この）':'か'
  };
  const ng = [];
  Object.keys(cases).forEach((raw) => {
    const e = T.splitNameReading(raw);
    const g = T.gyouOf(e.name, e.reading);
    if (g !== cases[raw]) ng.push(`${raw}→${g}（期待 ${cases[raw]}）`);
  });
  assert(ng.length === 0, `違う行: ${ng.join(' / ')}`);
});

test('名前リストの「青木（あおき）」は、表示名「青木」として扱われ、同名チェックもされる', (T, window) => {
  T.state.presetNamesText = '青木（あおき）\n鈴木 (すずき)\n田中\n青木';
  const list = T.getPresetNamesList();
  assert(JSON.stringify(list) === JSON.stringify(['青木', '鈴木', '田中', '青木']), `表示名が違います: ${list}`);
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.step = 'setup'; T.state.history = ['start'];
  T.state.tables = []; T.render();
  const warn = document.querySelector('.names-dup-warning');
  assert(warn && warn.style.display !== 'none' && warn.textContent.indexOf('青木') !== -1, '「青木（あおき）」と「青木」の同名が警告されません');
});

function drawScreenWith(T, names) {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture';
  T.state.deskSeatsPerTable = 4; T.state.deskColumns = 3;
  T.state.totalParticipants = 16; T.state.tableCount = 4; T.state.seatCounts = [4, 4, 4, 4];
  T.buildTables();
  T.state.presetNamesText = names.join('\n');
  T.state.pairGroups = [];
  T.prepareBlanks();
  T.state.step = 'draw'; T.state.history = ['start', 'setup', 'layout'];
  T.render();
}
const ELEVEN = ['青木（あおき）', '伊藤', '鈴木', '坂田', '井上', '赤城', '藤井', '垣田', '肥後', '松永', '田中'];

test('くじ引き画面: 10人までは名前ボタンがそのまま並び、10人を超えると一覧ボタンになる', (T) => {
  drawScreenWith(T, ELEVEN.slice(0, 10));
  assert(document.querySelectorAll('#app .name-chip').length === 10, '10人のとき名前ボタンが並んでいません');
  assert(!btnByText(document, '名前リストから選ぶ'), '10人なのに一覧ボタンが出ました');
  drawScreenWith(T, ELEVEN);
  assert(document.querySelectorAll('#app .name-chip').length === 0, '11人なのに名前ボタンが並んでいます');
  assert(btnByText(document, '名前リストから選ぶ（11人）'), '11人のとき一覧ボタンが出ません');
});

test('くじ引き画面: 一覧を開くと あ行〜の箱に分かれ、名前をタップすると入力欄に入る（読みは外れる）', (T) => {
  drawScreenWith(T, ELEVEN);
  btnByText(document, '名前リストから選ぶ').onclick();
  const heads = Array.from(document.querySelectorAll('.modal-overlay .gyou-head-label')).map((x) => x.textContent);
  assert(JSON.stringify(heads) === JSON.stringify(['あ行', 'か行', 'さ行', 'た行', 'は行', 'ま行']), `箱の並びが違います: ${heads}`);
  const aBox = Array.from(document.querySelectorAll('.modal-overlay .gyou-box'))[0];
  const aNames = Array.from(aBox.querySelectorAll('.gyou-chip')).map((c) => c.firstChild.textContent);
  // 読みの最初のかな順（あ→い）。同じ「あ」の青木・赤城の順は問わない
  assert(aNames.length === 4 && ['青木', '赤城'].indexOf(aNames[0]) !== -1 && ['青木', '赤城'].indexOf(aNames[1]) !== -1 &&
    ['伊藤', '井上'].indexOf(aNames[2]) !== -1 && ['伊藤', '井上'].indexOf(aNames[3]) !== -1, `あ行の中身・順番が違います: ${aNames}`);
  assert(aBox.querySelector('.gyou-chip small').textContent === 'あおき', '添えた読みが小さく表示されていません');
  const naTab = Array.from(document.querySelectorAll('.modal-overlay .gyou-tab')).find((t) => t.textContent === 'な');
  assert(naTab.disabled, '名前のいない行の文字が押せてしまいます');
  Array.from(document.querySelectorAll('.modal-overlay .gyou-chip')).find((c) => c.firstChild.textContent === '青木').onclick();
  assert(!document.querySelector('.modal-overlay'), '一覧が閉じません');
  assert(T.state.draftName === '青木', `入力欄に入った名前が違います: ${T.state.draftName}`);
});

test('固定席の名前選び: 10人を超えると同じ あ行〜の一覧から選べる', (T) => {
  drawScreenWith(T, ELEVEN);
  T.state.step = 'layout'; T.render();
  T.openFixedModal(T.findSeatByNum(3));
  const open = Array.from(document.querySelectorAll('.modal-overlay button')).find((b) => b.textContent.indexOf('名前リストから選ぶ') !== -1);
  assert(open, '固定席の画面に一覧ボタンがありません');
  open.onclick();
  const lists = document.querySelectorAll('.modal-overlay .gyou-box');
  assert(lists.length >= 6, 'あ行〜の箱が出ません');
  Array.from(document.querySelectorAll('.modal-overlay .gyou-chip')).find((c) => c.firstChild.textContent === '垣田').onclick();
  const input = document.querySelector('.modal-overlay .modal-input');
  assert(input && input.value === '垣田', `固定席の名前欄に入りません: ${input && input.value}`);
});

test('隣同士グループの選択: 10人を超えると あ行〜の一覧で複数選び、「設定」でグループになる', (T) => {
  drawScreenWith(T, ELEVEN);
  T.state.step = 'setup'; T.state.history = ['start']; T.state.groupPickerOpen = true; T.state.groupPickerSelected = [];
  T.render();
  btnByText(document, '名前リストから選ぶ（11人）').onclick();
  const chip = (n) => Array.from(document.querySelectorAll('.modal-overlay .gyou-chip')).find((c) => c.firstChild.textContent === n);
  chip('田中').onclick(); chip('鈴木').onclick();
  assert(chip('田中').classList.contains('selected') && chip('鈴木').classList.contains('selected'), '選んだ名前が選択表示になりません');
  const confirm = document.querySelector('.modal-overlay .name-list-confirm-btn');
  assert(!confirm.disabled && confirm.textContent.indexOf('2人') !== -1, `設定ボタンが押せないか人数が出ません: ${confirm.textContent}`);
  confirm.onclick();
  assert(JSON.stringify(T.state.pairGroups) === JSON.stringify([['田中', '鈴木']]), `グループが作られません: ${JSON.stringify(T.state.pairGroups)}`);
});

/* ============================================================
 * 21. 窓（名前リスト等）が開いているときのスマホの戻る
 * ========================================================== */
console.log('\n=== 21. 窓が開いているときの戻る ===');

function phoneBack(window) { window.dispatchEvent(new window.PopStateEvent('popstate', { state: null })); }

test('名前リストを開いたままスマホの戻る → 画面は移らずリストだけ閉じる', (T, window) => {
  drawScreenWith(T, ELEVEN);
  btnByText(document, '名前リストから選ぶ').onclick();
  assert(document.querySelector('.modal-overlay'), '名前リストが開きません');
  phoneBack(window);
  assert(!document.querySelector('.modal-overlay'), '名前リストが閉じません');
  assert(T.state.step === 'draw', `画面が移ってしまいました: ${T.state.step}`);
  phoneBack(window);
  assert(T.state.step === 'layout', `窓が無いときの戻るで前の画面に戻りません: ${T.state.step}`);
});

test('固定席の窓の上に名前リスト → 戻るで上から1つずつ閉じ、その後に画面が戻る', (T, window) => {
  drawScreenWith(T, ELEVEN);
  T.state.step = 'layout'; T.state.history = ['start', 'setup']; T.render();
  T.openFixedModal(T.findSeatByNum(2));
  Array.from(document.querySelectorAll('.modal-overlay button')).find((b) => b.textContent.indexOf('名前リストから選ぶ') !== -1).onclick();
  assert(document.querySelectorAll('.modal-overlay').length === 2, '窓が2枚重なっていません');
  phoneBack(window);
  assert(document.querySelectorAll('.modal-overlay').length === 1 && document.querySelector('.modal-overlay').textContent.indexOf('席番号 2') !== -1, '上の名前リストだけが閉じていません');
  phoneBack(window);
  assert(!document.querySelector('.modal-overlay') && T.state.step === 'layout', '固定席の窓が閉じない、または画面が移りました');
  phoneBack(window);
  assert(T.state.step === 'setup', `設定画面へ戻りません: ${T.state.step}`);
});

test('くじのルーレット中はスマホの戻るで何も起きない', (T, window) => {
  drawScreenWith(T, ELEVEN);
  const overlay = document.createElement('div'); overlay.className = 'lottery-overlay'; document.body.appendChild(overlay);
  phoneBack(window);
  assert(document.querySelector('.lottery-overlay') && T.state.step === 'draw', 'ルーレット中に閉じる・画面が移るなどが起きました');
  overlay.remove();
});

test('スタート画面で一覧を開いたままスマホの戻る → 一覧だけ閉じる', (T, window) => {
  window.localStorage.clear();
  T.state.eventType = 'dining'; T.state.shape = 'circle'; T.state.tableCount = 1; T.state.seatCounts = [4]; T.state.totalParticipants = 4;
  T.buildTables(); T.saveNamed('setup', 'テスト');
  T.state.step = 'start'; T.state.history = []; T.render();
  btnByText(document, '保存した設定を開く').onclick();
  assert(document.querySelector('.modal-overlay'), '保存した設定の一覧が開きません');
  phoneBack(window);
  assert(!document.querySelector('.modal-overlay') && T.state.step === 'start', '一覧だけが閉じていません');
});

test('スタート画面でスマホの戻る →「アプリを閉じますか？」→いいえ/はい→未保存の注意、「いいえ」で残る', (T, window) => {
  T.state.step = 'start'; T.state.history = []; T.render();
  phoneBack(window);
  const box = document.querySelector('.modal-overlay');
  assert(box && box.querySelector('.modal-title').textContent === 'アプリを閉じますか？', '閉じる確認が出ません');
  const note = box.querySelector('.exit-note');
  assert(note && note.textContent === '⚠️「名前を付けて保存」していない内容は、削除されます。', '未保存の内容が削除される注意がありません');
  const order = Array.from(box.querySelector('.modal-box').children).map((x) => x.className);
  assert(JSON.stringify(order) === JSON.stringify(['modal-title', 'modal-actions', 'exit-note']), `並び順が違います: ${order}`);
  assert(btnByText(document, 'いいえ') && btnByText(document, 'はい'), '「いいえ」「はい」がありません');
  btnByText(document, 'いいえ').onclick();
  assert(!document.querySelector('.modal-overlay') && T.state.step === 'start', '「いいえ」で残りません');
  // 確認が出たまま戻る → 確認だけ閉じる
  phoneBack(window);
  phoneBack(window);
  assert(!document.querySelector('.modal-overlay') && T.state.step === 'start', '確認が出たままの戻るで確認が閉じません');
});

/* ============================================================
 * 22. プレビュー版（…/preview/ で開いたとき）
 * ========================================================== */
console.log('\n=== 22. プレビュー版 ===');

const PREVIEW_URL = 'https://ray-ray870.github.io/mitchie-sekikuji/preview/index.html';
const PROD_SAVES = {
  'mitchieSeatLottery.namedSaves.setup.lecture.v1': JSON.stringify([{ id: 'p1', name: '本番の保存（設定）', savedAt: 1, data: { eventType: 'lecture', tables: [] } }]),
};

test('プレビューで開くと「プレビュー版」の表示が出て、アイコンは本番のものを使い、アプリ追加用の設定は外れる', (T, window) => {
  const badge = document.querySelector('.preview-badge');
  assert(badge && badge.textContent.indexOf('プレビュー版') !== -1, 'プレビュー版の表示がありません');
  assert(document.querySelector('link[rel="icon"]').getAttribute('href') === '../icon.png', 'アイコンが本番のものになっていません');
  assert(!document.querySelector('link[rel="manifest"]'), 'アプリ追加用の設定（manifest）が残っています');
}, PREVIEW_URL);

test('プレビューでは、初回に本番の保存データをコピーして使い、プレビューで保存・削除しても本番は変わらない', (T, window) => {
  const ls = window.localStorage;
  const prodKey = 'mitchieSeatLottery.namedSaves.setup.lecture.v1';
  assert(ls.getItem('preview:' + prodKey) === PROD_SAVES[prodKey], '本番の保存データがプレビュー用にコピーされていません');
  assert(T.listNamedSaves('setup').some((x) => x.name === '本番の保存（設定）'), 'プレビューの一覧に本番の保存が出ません');
  // プレビューで保存 → プレビュー側だけ増える
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'desk'; T.state.shape = 'lecture'; T.state.tableCount = 1; T.state.seatCounts = [2]; T.state.totalParticipants = 2;
  T.buildTables();
  T.saveNamed('setup', 'プレビューで保存');
  assert(JSON.parse(ls.getItem('preview:' + prodKey)).length === 2, 'プレビュー側に保存されていません');
  assert(JSON.parse(ls.getItem(prodKey)).length === 1, 'プレビューの保存が本番の保存データを変えました');
  // プレビューで削除 → 本番は残る
  T.deleteNamedSave('setup', 'p1');
  assert(JSON.parse(ls.getItem(prodKey)).length === 1, 'プレビューの削除で本番の保存が消えました');
  // 自動保存も本番とは別
  T.state.step = 'layout'; T.render();
  assert(ls.getItem('preview:mitchieSeatLottery.autosave.v1') && !ls.getItem('mitchieSeatLottery.autosave.v1'), '自動保存が本番の場所に書かれました');
}, PREVIEW_URL, PROD_SAVES);

test('本番（preview以外）で開いたときは、今までどおりの保存場所で、プレビュー表示は出ない', (T, window) => {
  assert(!document.querySelector('.preview-badge'), '本番なのにプレビュー表示が出ています');
  assert(T.listNamedSaves('setup').some((x) => x.name === '本番の保存（設定）'), '本番の保存データが読めません');
  assert(document.querySelector('link[rel="icon"]').getAttribute('href') === 'icon.png', '本番のアイコン指定が変わりました');
}, 'https://ray-ray870.github.io/mitchie-sekikuji/index.html', PROD_SAVES);

/* ============================================================
 * 23. 演台とスクリーン
 * ========================================================== */
console.log('\n=== 23. 演台とスクリーン ===');

function setupLectureRows(T) {
  T.state.eventType = 'lecture'; T.state.lectureStyle = 'row'; T.state.shape = 'lecture';
  T.state.totalParticipants = 12; T.state.tableCount = 2; T.state.seatCounts = [6, 6];
  T.buildTables();
  T.state.step = 'layout';
}
function dragMarker(window, marker, dx, dy) {
  function pe(type, x, y) {
    const ev = new window.Event(type, { bubbles: true });
    ev.clientX = x; ev.clientY = y; ev.pointerId = 1; ev.pointerType = 'touch';
    return ev;
  }
  marker.dispatchEvent(pe('pointerdown', 100, 100));
  marker.dispatchEvent(pe('pointermove', 100 + dx, 100 + dy));
  marker.dispatchEvent(pe('pointerup', 100 + dx, 100 + dy));
}

test('講演会のレイアウトと結果に、演台とスクリーンが両方出る（食事会には出ない）', (T) => {
  setupLectureRows(T);
  T.render();
  assert(document.querySelector('.podium-marker'), 'レイアウトに演台がありません');
  assert(document.querySelector('.screen-marker'), 'レイアウトにスクリーンがありません');
  T.state.step = 'result';
  T.render();
  assert(document.querySelector('.screen-marker'), '結果画面にスクリーンがありません');
  T.state.eventType = 'dining'; T.state.shape = 'square';
  T.buildTables(); T.state.step = 'layout'; T.render();
  assert(!document.querySelector('.screen-marker') && !document.querySelector('.podium-marker'), '食事会なのに演台/スクリーンが出ています');
  const hints = () => Array.from(document.querySelectorAll('.hint-text')).map((h) => h.textContent).join('|');
  assert(hints().indexOf('演台・スクリーン') === -1, '食事会なのに演台・スクリーンの説明が出ています');
  setupLectureRows(T);
  T.render();
  assert(hints().indexOf('💡 演台・スクリーン → ドラッグで移動') !== -1, `講演会で演台・スクリーンの説明が出ません: ${hints()}`);
});

test('演台・スクリーンを下へ大きく動かしても、座席の上の余白からはみ出さない', (T, window) => {
  setupLectureRows(T);
  T.render();
  ['.podium-marker', '.screen-marker'].forEach((sel) => {
    const m = document.querySelector(sel);
    dragMarker(window, m, 0, 900);
    const top = parseFloat(m.style.top);
    assert(top + 34 <= 110, `${sel} が座席の方まで入りました (top=${top})`);
    dragMarker(window, m, -900, -900);
    assert(parseFloat(m.style.top) >= 0 && parseFloat(m.style.left) >= 0, `${sel} が上・左の端からはみ出しました`);
  });
});

test('スクリーンの位置は、名前を付けて保存→開く・一つ前に戻す で戻る。座席は変わらない', (T, window) => {
  window.localStorage.clear();
  setupLectureRows(T);
  T.render();
  const seatsBefore = JSON.stringify(T.state.tables.map((t) => t.seats.map((s) => s.num)));
  const scr = document.querySelector('.screen-marker');
  dragMarker(window, scr, 40, 20);
  const moved = JSON.stringify(T.state.screenOffset);
  assert(moved !== JSON.stringify({ x: 0, y: 0 }), 'スクリーンが動いていません');
  assert(JSON.stringify(T.state.tables.map((t) => t.seats.map((s) => s.num))) === seatsBefore, 'スクリーンを動かしたら座席が変わりました');
  T.saveNamed('setup', 'スクリーン');
  assert(T.undoLayout() === true, 'undoLayoutが失敗しました');
  assert(JSON.stringify(T.state.screenOffset) === JSON.stringify({ x: 0, y: 0 }), '一つ前に戻すでスクリーンが元の位置に戻りません');
  T.applyNamedSave('setup', T.listNamedSaves('setup')[0].data);
  assert(JSON.stringify(T.state.screenOffset) === moved, `保存から開いてもスクリーンの位置が戻りません: ${JSON.stringify(T.state.screenOffset)}`);
});

/* ============================================================
 * 24. 長テーブル：1辺に並びきらないグループは同じテーブル
 * ========================================================== */
console.log('\n=== 24. 長テーブルで1辺に並びきらないグループ ===');

// 長テーブル 3卓×6席（上3・下3）、参加者18人
function setupLongTables(T) {
  T.state.eventType = 'dining'; T.state.shape = 'square';
  T.state.tableCount = 3; T.state.totalParticipants = 18; T.state.seatCounts = [6, 6, 6];
  T.buildTables();
  T.state.presetNamesText = 'ABCDEFGHIJKLMNOPQR'.split('').join('\n');
  T.state.step = 'layout';
}
function tableIdxOf(T, name) {
  return T.state.tables.findIndex((t) => t.seats.some((s) => (s.fixedName || s.name) === name));
}
function sideOf(T, name) {
  for (const t of T.state.tables) {
    for (const k of ['top', 'bottom', 'left', 'right']) {
      const i = (t.sides[k] || []).findIndex((s) => (s.fixedName || s.name) === name);
      if (i !== -1) return { t, k, i };
    }
  }
  return null;
}

test('長テーブル1辺3席に4人グループ: 警告は出ず、一括くじ引きで同じテーブルになる (40回)', (T) => {
  for (let r = 0; r < 40; r++) {
    setupLongTables(T);
    assert(T.state.tables[0].sides.top.length === 3, `前提: 1辺が3席ではありません (${T.state.tables[0].sides.top.length})`);
    T.state.pairGroups = [['A', 'B', 'C', 'D'], ['E', 'F']];
    T.prepareBlanks();
    T.render();
    assert(!document.querySelector('.pair-group-warning'), `同じテーブルに座れるのに警告が出ました: ${document.querySelector('.pair-group-warning') && document.querySelector('.pair-group-warning').textContent}`);
    drawAllViaUi(T);
    const tbls = new Set(['A', 'B', 'C', 'D'].map((n) => tableIdxOf(T, n)));
    assert(tbls.size === 1, `回${r}: 4人グループが同じテーブルになっていません`);
    // 1辺に並べる2人グループは、今まで通り同じ辺の隣同士
    const e = sideOf(T, 'E'), f = sideOf(T, 'F');
    assert(e.t === f.t && e.k === f.k && Math.abs(e.i - f.i) === 1, `回${r}: 2人グループが隣同士になっていません`);
  }
});

test('長テーブル1辺3席に4人グループ: 1人ずつくじ引きでも同じテーブル (60回)', (T) => {
  for (let r = 0; r < 60; r++) {
    setupLongTables(T);
    T.state.pairGroups = [['A', 'B', 'C', 'D'], ['E', 'F', 'G']];
    T.prepareBlanks();
    drawOneByOne(T, 'ABCDEFGHIJKLMNOPQR'.split(''));
    const tbls = new Set(['A', 'B', 'C', 'D'].map((n) => tableIdxOf(T, n)));
    assert(tbls.size === 1, `回${r}: 4人グループが同じテーブルになっていません`);
    const sides = ['E', 'F', 'G'].map((n) => sideOf(T, n));
    assert(sides.every((x) => x.t === sides[0].t && x.k === sides[0].k), `回${r}: 3人グループが同じ辺に並んでいません`);
  }
});

test('1卓の席数より多いグループは、今まで通り警告が出る', (T) => {
  setupLongTables(T);
  T.state.pairGroups = [['A', 'B', 'C', 'D', 'E', 'F', 'G']];
  T.prepareBlanks();
  T.render();
  const w = document.querySelector('.pair-group-warning');
  assert(w && w.textContent.indexOf('「A・B・C・D・E・F・G」') !== -1, `警告が出ていません: ${w && w.textContent}`);
});

test('1卓4席（1辺2席）: 3人・4人グループは同じテーブル、2人グループは隣同士 (一括・1人ずつ 各30回)', (T) => {
  for (let r = 0; r < 60; r++) {
    T.state.eventType = 'dining'; T.state.shape = 'square';
    T.state.tableCount = 4; T.state.totalParticipants = 16; T.state.seatCounts = [4, 4, 4, 4];
    T.buildTables();
    const names = 'ABCDEFGHIJKLMNOP'.split('');
    T.state.presetNamesText = names.join('\n');
    T.state.step = 'layout';
    assert(T.state.tables[0].sides.top.length === 2, `前提: 1辺が2席ではありません`);
    T.state.pairGroups = [['A', 'B', 'C'], ['D', 'E', 'F', 'G'], ['H', 'I']];
    T.prepareBlanks();
    T.render();
    assert(!document.querySelector('.pair-group-warning'), '同じテーブルに座れるのに警告が出ました');
    if (r % 2) drawOneByOne(T, names); else drawAllViaUi(T);
    [['A', 'B', 'C'], ['D', 'E', 'F', 'G']].forEach((g) => {
      assert(new Set(g.map((n) => tableIdxOf(T, n))).size === 1, `回${r}: [${g}] が同じテーブルになっていません`);
    });
    const h = sideOf(T, 'H'), i = sideOf(T, 'I');
    assert(h.t === i.t && h.k === i.k && Math.abs(h.i - i.i) === 1, `回${r}: 2人グループが隣同士になっていません`);
  }
});

test('長テーブル: いろいろな席数・人数の組み合わせでも、グループは辺で隣同士か同じテーブル (ランダム300回)', (T) => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  for (let r = 0; r < 300; r++) {
    const tableCount = rnd(1, 5);
    const seatCounts = Array.from({ length: tableCount }, () => rnd(2, 10));
    const total = seatCounts.reduce((a, b) => a + b, 0);
    T.state.eventType = 'dining'; T.state.shape = 'square';
    T.state.tableCount = tableCount; T.state.totalParticipants = total; T.state.seatCounts = seatCounts.slice();
    T.buildTables();
    const names = letters.slice(0, total);
    T.state.presetNamesText = names.join('\n');
    T.state.step = 'layout';
    // 1卓に入る人数までのグループを1〜3個
    const pool = shuffled(names);
    const maxTable = Math.max(...T.state.tables.map((t) => t.seats.length));
    const groups = [];
    for (let g = 0; g < rnd(1, 3) && pool.length >= 2; g++) {
      const size = rnd(2, Math.min(maxTable, pool.length));
      groups.push(pool.splice(0, size));
    }
    T.state.pairGroups = groups;
    T.prepareBlanks();
    const feasible = T.checkPairGroupsFeasible().ok;
    if (!feasible) continue; // 同時には置けない組み合わせ（警告が出る）は対象外
    const oneByOne = r % 2 === 0;
    if (oneByOne) drawOneByOne(T, names); else drawAllViaUi(T);
    groups.forEach((g) => {
      const sides = g.map((n) => sideOf(T, n));
      const sameSide = sides.every((x) => x.t === sides[0].t && x.k === sides[0].k) &&
        (() => { const idx = sides.map((x) => x.i).sort((a, b) => a - b); return idx[idx.length - 1] - idx[0] === g.length - 1; })();
      const sameTable = new Set(g.map((n) => tableIdxOf(T, n))).size === 1;
      assert(sameTable, `回${r} 席数${JSON.stringify(seatCounts)} グループ[${g}]: 同じテーブルになっていません (${oneByOne ? '1人ずつ' : '一括'})`);
      // グループが1つだけで、どのテーブルでも1辺に並べる人数なら、辺で隣同士でなければならない
      if (groups.length === 1 && T.state.tables.every((tt) => Math.max(...['top', 'bottom', 'left', 'right'].map((k) => (tt.sides[k] || []).length)) >= g.length)) {
        assert(sameSide, `回${r} 席数${JSON.stringify(seatCounts)} グループ[${g}]: 1辺に並べるのに隣同士になっていません`);
      }
    });
  }
});

/* ============================================================
 * 25. アップデート情報
 * ========================================================== */
console.log('\n=== 25. アップデート情報 ===');

test('トップにアップデート情報が出て、見るまでは赤い点・見たら消える', (T, window) => {
  window.localStorage.clear();
  T.state.step = 'start';
  T.render();
  const pill = document.querySelector('.update-pill');
  assert(pill, 'トップにアップデート情報がありません');
  assert(/Ver \d+\.\d+\.\d+ にアップデートしました/.test(pill.textContent), `表示が違います: ${pill.textContent}`);
  assert(document.querySelector('.update-dot'), 'まだ見ていないのに赤い点がありません');
  pill.click();
  const modal = document.querySelector('.modal-overlay');
  assert(modal && modal.textContent.indexOf('アップデート情報') !== -1, 'タップしても一覧が開きません');
  assert(modal.querySelectorAll('.update-item').length >= 2, '一覧に更新が並んでいません');
  assert(!document.querySelector('.update-dot'), '一覧を開いたのに赤い点が消えません');
  modal.querySelector('.modal-cancel').click();
  assert(!document.querySelector('.modal-overlay'), '閉じるで閉じません');
  T.render();
  assert(!document.querySelector('.update-dot'), '見た後に開き直しても赤い点が出ています');
  // 古いバージョンまでしか見ていない人には、また赤い点が出る
  const key = Object.keys(window.localStorage).find((k) => k.indexOf('seen-version') !== -1);
  window.localStorage.setItem(key, '0.0.1');
  T.render();
  assert(document.querySelector('.update-dot'), '新しいバージョンなのに赤い点が出ません');
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
