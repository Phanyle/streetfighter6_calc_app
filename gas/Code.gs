/**
 * SF6 対戦履歴ロガー — Google Apps Script (スプレッドシートにバインド)
 *
 * 受け付けるリクエスト (POST, body は JSON 文字列):
 *   { key, action: 'ping' }
 *   { key, action: 'add',  record: { id, myChar, oppChar, result, round, point, tags[], memo, tried, counter, mental } }
 *   { key, action: 'undo', id }
 *
 * API キーはコードに書かず、スクリプト プロパティ API_KEY に保存する (setupApiKey を1回実行)。
 */

const SHEET_NAME = '対戦履歴';

// 既存の表「表_3」の列 (左から順)。見出しがこれと一致しないときは書き込まずにエラーを返す。
const HEADERS = [
  '日付', '使用キャラクター (自分)', '使用キャラクター (相手)', '勝敗', '結果詳細',
  'ポイント', '反省点・メモ', '試したこと・意識したこと', '対策', 'メンタル',
];
const COL = { round: 5, point: 6 };  // 表示形式を個別に指定する列 (1 始まり)

const RESULTS = ['勝ち', '負け'];
const ROUNDS_BY_RESULT = { '勝ち': ['2-0', '2-1'], '負け': ['1-2', '0-2'] };

const MAX_LEN = { chara: 24, tag: 20, text: 500 };
const MAX_TAGS = 10;
const MAX_BODY = 6000;
const MAX_POINT = 1000000;

const RATE_LIMIT_PER_MIN = 30;   // 正常リクエストの上限 / 分
const AUTH_FAIL_LIMIT = 10;      // 認証失敗の上限 / 10分 (超えると全リクエスト拒否)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

function doPost(e) {
  const cache = CacheService.getScriptCache();
  try {
    if (Number(cache.get('authfail') || 0) >= AUTH_FAIL_LIMIT) return json_({ ok: false, error: 'locked' });

    const body = e && e.postData && e.postData.contents;
    if (!body || body.length > MAX_BODY) return json_({ ok: false, error: 'bad_request' });
    const req = JSON.parse(body);

    if (!checkKey_(req.key)) {
      bump_(cache, 'authfail', 600);
      return json_({ ok: false, error: 'unauthorized' });
    }
    if (bump_(cache, 'rate:' + Math.floor(Date.now() / 60000), 120) > RATE_LIMIT_PER_MIN) {
      return json_({ ok: false, error: 'rate_limited' });
    }

    switch (req.action) {
      case 'ping': return json_({ ok: true });
      case 'add':  return json_(add_(req.record, cache));
      case 'undo': return json_(undo_(req.id, cache));
      default:     return json_({ ok: false, error: 'bad_request' });
    }
  } catch (err) {
    console.error(err);
    // ここに来るのはキー認証後の処理 (シート書き込み) がほとんどなので、原因を短く返す
    return json_({ ok: false, error: 'server_error', detail: String(err && err.message || err).slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// アクション
// ---------------------------------------------------------------------------

function add_(rec, cache) {
  if (!rec || typeof rec !== 'object') return { ok: false, error: 'bad_request' };

  const id = String(rec.id || '');
  if (!UUID_RE.test(id)) return { ok: false, error: 'bad_request' };
  // 再送 (オフラインキュー) で二重登録しないよう、同じ ID は 6 時間無視する
  if (cache.get('seen:' + id)) return { ok: true, id: id, duplicate: true };

  const result = String(rec.result || '');
  if (RESULTS.indexOf(result) < 0) return { ok: false, error: 'invalid_result' };
  const round = String(rec.round || '');
  if (round && ROUNDS_BY_RESULT[result].indexOf(round) < 0) return { ok: false, error: 'invalid_round' };

  const oppChar = clean_(rec.oppChar, MAX_LEN.chara);
  if (!oppChar) return { ok: false, error: 'missing_opponent' };

  let point = '';
  if (rec.point !== '' && rec.point != null) {
    point = Number(rec.point);
    if (!isFinite(point) || Math.abs(point) > MAX_POINT) return { ok: false, error: 'invalid_point' };
  }

  // タグは反省点の先頭に [対空][DR対応] の形で付ける
  const tags = (Array.isArray(rec.tags) ? rec.tags : [])
    .slice(0, MAX_TAGS)
    .map(function (t) { return clean_(t, MAX_LEN.tag); })
    .filter(String);
  const memoBody = clean_(rec.memo, MAX_LEN.text, true);
  // 先頭がタグ ([...]) なら数式にはならないので、本文側の ' ガードは外す
  const memo = tags.length
    ? tags.map(function (t) { return '[' + t + ']'; }).join('') + (memoBody ? ' ' + memoBody.replace(/^'/, '') : '')
    : memoBody;

  const values = [
    today_(),
    clean_(rec.myChar, MAX_LEN.chara),
    oppChar,
    result,
    round,
    point,
    memo,
    clean_(rec.tried, MAX_LEN.text, true),
    clean_(rec.counter, MAX_LEN.text, true),
    clean_(rec.mental, MAX_LEN.text, true),
  ];

  const rowNo = withLock_(function () {
    const sheet = getSheet_();
    const r = nextRow_(sheet);
    // 結果詳細は m-d (日付) 形式なので、"2-1" が 2月1日 に化けないよう文字列として書く
    sheet.getRange(r, COL.round).setNumberFormat('@');
    sheet.getRange(r, 1, 1, values.length).setValues([values]);
    // 書き込みはスクリプト終了時にまとめて反映されるため、ここで確定させてエラーを try 内で捕まえる。
    // (しないと表の型違反などが doPost の外で起き、「失敗しました」+ 応答なしになる)
    SpreadsheetApp.flush();
    // 日付は入力した日。Date オブジェクトが表に弾かれて空になる場合に備え、読み戻して空なら
    // 「2026/09/27」形式の入力として入れ直す (手入力と同じ扱いで日付になる)
    const dateCell = sheet.getRange(r, 1);
    if (dateCell.getValue() === '') {
      dateCell.setValue(Utilities.formatDate(new Date(), tz_(), 'yyyy/MM/dd'));
      SpreadsheetApp.flush();
    }
    if (dateCell.getValue() === '') throw new Error(r + '行目の日付を書き込めませんでした (日付列の型・入力規則を確認)');
    return r;
  });
  cache.put('seen:' + id, '1', 21600);
  cache.put('row:' + id, JSON.stringify({ row: rowNo, sig: signature_(values) }), 21600);
  return { ok: true, id: id, row: rowNo };
}

/**
 * 直前に書いた行だけ取り消せる。
 * 「その行がまだ最後の記録で、中身も書いたときのまま」の場合に限り、行を空に戻す (表の行自体は残す)。
 */
function undo_(id, cache) {
  id = String(id || '');
  if (!UUID_RE.test(id)) return { ok: false, error: 'bad_request' };
  const saved = cache.get('row:' + id);
  if (!saved) return { ok: false, error: 'not_last' };
  const info = JSON.parse(saved);
  return withLock_(function () {
    const sheet = getSheet_();
    if (nextRow_(sheet) !== info.row + 1) return { ok: false, error: 'not_last' };
    const range = sheet.getRange(info.row, 1, 1, HEADERS.length);
    if (signature_(range.getValues()[0]) !== info.sig) return { ok: false, error: 'not_last' };
    range.clearContent();
    SpreadsheetApp.flush();
    cache.remove('row:' + id);
    cache.remove('seen:' + id);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('シート「' + SHEET_NAME + '」がありません');
  const actual = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
  for (let i = 0; i < HEADERS.length; i++) {
    if (String(actual[i]).trim() !== HEADERS[i]) {
      throw new Error((i + 1) + '列目の見出しが「' + actual[i] + '」です (想定:「' + HEADERS[i] + '」)。書き込みを中止しました');
    }
  }
  return sheet;
}

/** 日付〜勝敗 (A〜D 列) のどれかが最後に埋まっている行の次。表の空行はそのまま使う。 */
function nextRow_(sheet) {
  const last = sheet.getLastRow();
  let r = 1;
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, 4).getValues();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].some(function (v) { return v !== '' && v !== null; })) { r = i + 2; break; }
    }
  }
  const next = Math.max(r, 1) + 1;
  if (next > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  return next;
}

/** 取り消し時に「書いたときのままか」を確かめるための要約 (日付以外の列)。 */
function signature_(values) {
  return JSON.stringify(values.slice(1).map(function (v) { return String(v).replace(/^'/, ''); }));
}

/** 今日の日付 (時刻なし、スプレッドシートのタイムゾーン)。 */
function today_() {
  const s = Utilities.formatDate(new Date(), tz_(), 'yyyy/MM/dd').split('/');
  return new Date(Number(s[0]), Number(s[1]) - 1, Number(s[2]));
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Tokyo';
}

/** 文字列化・制御文字除去・長さ制限・数式インジェクション対策。 */
function clean_(v, max, allowNewline) {
  let s = v == null ? '' : String(v);
  s = allowNewline ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
                   : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;  // セルが数式として解釈されないようにする
  return s;
}

/** キーの定数時間比較 (SHA-256 同士を比べるので長さも漏れない)。 */
function checkKey_(key) {
  const stored = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!stored || typeof key !== 'string' || !key) return false;
  const a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8);
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, stored, Utilities.Charset.UTF_8);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bump_(cache, name, ttlSec) {
  const n = Number(cache.get(name) || 0) + 1;
  cache.put(name, String(n), ttlSec);
  return n;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// エディタから手動で実行する管理用関数
// ---------------------------------------------------------------------------

/** API キーを新規発行 (再実行するとキーが入れ替わり、古いキーは即無効)。 */
function setupApiKey() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  CacheService.getScriptCache().remove('authfail');
  Logger.log('新しい API キー: ' + key);
}

/**
 * スプレッドシートへのアクセスを承認し、書き込み先を確認する (デプロイ前に1回実行)。
 * シートには何も書き込まない。
 */
function authorize() {
  const sheet = getSheet_();
  Logger.log('OK: 見出し一致。次の記録は ' + nextRow_(sheet) + ' 行目に入ります');
}

/** 対戦履歴シートの見出し・入力規則・表示形式をログに出す (列の対応付け確認用)。 */
function describeSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('シート「' + SHEET_NAME + '」がありません'); return; }
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const probe = sheet.getRange(2, 1, 1, lastCol);
  const rules = probe.getDataValidations()[0];
  const formats = probe.getNumberFormats()[0];
  const lines = headers.map(function (h, i) {
    let v = '';
    const r = rules[i];
    if (r) {
      const args = r.getCriteriaValues();
      v = ' / 入力規則: ' + r.getCriteriaType() + ' ' + JSON.stringify(args[0] && args[0].getA1Notation ? args[0].getA1Notation() : args[0]);
    }
    return (i + 1) + '列目 「' + h + '」 / 表示形式: ' + formats[i] + v;
  });
  Logger.log('最終行: ' + sheet.getLastRow() + '\n' + lines.join('\n'));
}

/** 認証失敗ロックを解除する。 */
function resetLock() {
  CacheService.getScriptCache().remove('authfail');
  Logger.log('ロックを解除しました');
}
