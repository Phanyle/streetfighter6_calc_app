'use strict';

const DEFAULT_ROSTER = [
  'リュウ', 'ケン', 'ルーク', 'ジェイミー', '春麗', 'ガイル', 'キンバリー', 'ジュリ',
  'ブランカ', 'ダルシム', 'E.本田', 'ディージェイ', 'マノン', 'マリーザ', 'JP', 'ザンギエフ',
  'リリー', 'キャミィ', 'ラシード', 'A.K.I.', 'エド', '豪鬼', 'ベガ', 'テリー',
  '舞', 'エレナ', 'サガット', 'C.ヴァイパー', 'アレックス', 'イングリッド', 'ヤスミン', 'アルジュン',
];
const DEFAULT_TAGS = ['対空', '投げ抜け', '確反', '起き攻め', 'DR対応', 'インパクト返し', '差し返し', '画面端', 'SA管理', 'メンタル'];
const ROUNDS = { '勝ち': ['2-0', '2-1'], '負け': ['1-2', '0-2'] };
const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const ERRORS = {
  unauthorized: 'API キーが違います',
  locked: '認証失敗が多すぎるためロック中です (GAS で resetLock を実行)',
  rate_limited: '送信が多すぎます。少し待ってください',
  invalid_result: '結果が不正です',
  invalid_round: 'ラウンドと結果が一致しません',
  invalid_point: 'ポイントは数字で入力してください',
  missing_opponent: '相手キャラを選んでください',
  not_last: '最後の記録ではないため取り消せません',
  bad_request: 'リクエストが不正です',
  server_error: 'サーバーエラー (GAS の実行ログを確認)',
};

// ---------------------------------------------------------------------------
// storage (localStorage は使えない環境もあるので必ず try/catch)
// ---------------------------------------------------------------------------
const NS = 'sf6log.';
const store = {
  get(k, d, s = localStorage) {
    try { const v = s.getItem(NS + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v, s = localStorage) { try { s.setItem(NS + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k, s = localStorage) { try { s.removeItem(NS + k); } catch { /* ignore */ } },
};
const getKey = () => store.get('key', null, sessionStorage) || store.get('key', '');
function setKey(key, remember) {
  store.del('key'); store.del('key', sessionStorage);
  if (key) store.set('key', key, remember ? localStorage : sessionStorage);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = {
  myChar: store.get('myChar', ''),
  oppChar: '',
  result: '',
  round: '',
  tags: new Set(),
};
const roster = () => store.get('roster', DEFAULT_ROSTER);
const tagList = () => store.get('tags', DEFAULT_TAGS);

function el(tag, props = {}, text = '') {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (text) e.textContent = text;  // ユーザー由来の文字列は必ず textContent で入れる
  return e;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function renderSelects() {
  const my = $('myChar');
  my.replaceChildren(el('option', { value: '' }, '— 選択 —'),
    ...roster().map((c) => el('option', { value: c, selected: c === state.myChar }, c)));
}

function renderOpp() {
  $('oppGrid').replaceChildren(...roster().map((c) => {
    const b = el('button', { type: 'button', title: c }, c);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === state.oppChar));
    b.addEventListener('click', () => { state.oppChar = c; renderOpp(); update(); });
    return b;
  }));
  $('oppPicked').textContent = state.oppChar;
}

function renderResult() {
  document.querySelectorAll('.res').forEach((b) => {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.result === state.result));
  });
  const rounds = state.result ? ROUNDS[state.result] : [];
  $('rounds').replaceChildren(...rounds.map((r) => {
    const b = el('button', { type: 'button' }, r);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(r === state.round));
    b.addEventListener('click', () => { state.round = state.round === r ? '' : r; renderResult(); });
    return b;
  }));
}

function renderTags() {
  $('tags').replaceChildren(...tagList().map((t) => {
    const b = el('button', { type: 'button' }, t);
    b.setAttribute('aria-pressed', String(state.tags.has(t)));
    b.addEventListener('click', () => {
      state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
      b.setAttribute('aria-pressed', String(state.tags.has(t)));
    });
    return b;
  }));
}

function renderToday() {
  const today = new Date().toDateString();
  const hist = store.get('history', []).filter((h) => new Date(h.at).toDateString() === today);
  const w = hist.filter((h) => h.result === '勝ち').length;
  const box = $('today');
  if (!hist.length) { box.textContent = '今日 0戦'; return; }
  const dots = el('span', { className: 'dots' });
  hist.slice(-10).forEach((h) => dots.append(el('i', { className: h.result === '勝ち' ? 'w' : 'l', title: h.oppChar })));
  box.replaceChildren('今日 ', el('b', { className: 'w' }, `${w}勝`), ' ', el('b', { className: 'l' }, `${hist.length - w}敗`), dots);
}

function renderNames() {
  $('recentMental').replaceChildren(...store.get('mentals', []).map((n) => el('option', { value: n })));
}

function renderQueue() {
  const q = store.get('queue', []);
  const info = $('queueInfo');
  info.hidden = !q.length;
  info.textContent = `未送信 ${q.length} 件 (通信が戻ったら自動で再送します)`;
}

function update() {
  $('submit').disabled = !(state.oppChar && state.result);
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------
class ServerError extends Error {}

async function post(payload) {
  const url = store.get('url', '');
  const key = getKey();
  if (!URL_RE.test(url) || !key) throw new ServerError('⚙ 設定で URL と API キーを入力してください');
  const res = await fetch(url, {
    method: 'POST',
    // text/plain にすると CORS プリフライトが発生しない (GAS は OPTIONS を処理できない)
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, key }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    redirect: 'follow',
  });
  let data;
  try { data = await res.json(); } catch { throw new ServerError('応答が JSON ではありません (デプロイ設定を確認)'); }
  if (!data.ok) {
    const msg = ERRORS[data.error] || data.error || '不明なエラー';
    throw new ServerError(data.detail ? `${msg}: ${data.detail}` : msg);
  }
  return data;
}

async function flushQueue() {
  let q = store.get('queue', []);
  while (q.length) {
    try { await post({ action: 'add', record: q[0] }); }
    catch (e) {
      if (e instanceof ServerError) { toast(`未送信分の再送に失敗: ${e.message}`, { error: true }); }
      break;
    }
    q = store.get('queue', []).slice(1);
    store.set('queue', q);
  }
  renderQueue();
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function submit() {
  if ($('submit').disabled) return;
  const record = {
    id: crypto.randomUUID(),
    myChar: state.myChar,
    oppChar: state.oppChar,
    point: $('point').value.trim(),
    result: state.result,
    round: state.round,
    tags: [...state.tags],
    memo: $('memo').value.trim(),
    tried: $('tried').value.trim(),
    counter: $('counter').value.trim(),
    mental: $('mental').value.trim(),
  };
  $('submit').disabled = true;
  let queued = false;
  let row = null;
  try {
    ({ row } = await post({ action: 'add', record }));
  } catch (e) {
    if (e instanceof ServerError) { toast(e.message, { error: true }); update(); return; }
    // ネットワークエラー → キューに積んで後で再送 (id で二重登録は防がれる)
    store.set('queue', [...store.get('queue', []), record]);
    queued = true;
  }

  store.set('history', [...store.get('history', []), { id: record.id, at: Date.now(), result: record.result, oppChar: record.oppChar }].slice(-300));
  if (record.mental) store.set('mentals', [record.mental, ...store.get('mentals', []).filter((n) => n !== record.mental)].slice(0, 20));

  // 次の試合用にリセット (自キャラ・相手キャラは連戦を想定して残す)
  state.result = ''; state.round = ''; state.tags.clear();
  // ポイントは次の試合前に更新するので残す。文章系は毎試合クリア
  ['memo', 'tried', 'counter', 'mental'].forEach((k) => { $(k).value = ''; });
  renderResult(); renderTags(); renderToday(); renderNames(); renderQueue(); update();
  if (queued && navigator.onLine) {
    // オンラインなのに fetch 自体が失敗 = ほぼデプロイ設定 (アクセス「全員」以外 / URL 違い)
    toast('送信できませんでした。デプロイのアクセスが「全員」か、URL が /exec か確認してください (記録は端末に保存済み)', { error: true, undoId: record.id });
  } else {
    toast(queued ? 'オフラインのため保存して後で送信します' : `記録しました (${row ?? '?'} 行目): vs ${record.oppChar} ${record.result}`, { undoId: record.id });
  }
}

async function undo(id) {
  const q = store.get('queue', []);
  if (q.some((r) => r.id === id)) {
    store.set('queue', q.filter((r) => r.id !== id));
  } else {
    try { await post({ action: 'undo', id }); }
    catch (e) { toast(e instanceof ServerError ? e.message : '通信エラーで取り消せませんでした', { error: true }); return; }
  }
  store.set('history', store.get('history', []).filter((h) => h.id !== id));
  renderToday(); renderQueue();
  toast('取り消しました');
}

let toastTimer;
function toast(msg, { error = false, undoId = null } = {}) {
  const t = $('toast');
  $('toastMsg').textContent = msg;
  t.classList.toggle('err', error);
  const u = $('toastUndo');
  u.hidden = !undoId;
  u.onclick = undoId ? () => { t.hidden = true; undo(undoId); } : null;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undoId ? 8000 : 4000);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
function openSettings() {
  $('cfgUrl').value = store.get('url', '');
  $('cfgKey').value = getKey();
  $('cfgRemember').checked = !store.get('key', null, sessionStorage);
  $('cfgRoster').value = roster().join('\n');
  $('cfgTags').value = tagList().join('\n');
  setMsg('');
  $('settings').showModal();
}
function setMsg(text, cls = '') { const m = $('cfgMsg'); m.textContent = text; m.className = 'msg ' + cls; }
const lines = (s) => [...new Set(s.split('\n').map((x) => x.trim()).filter(Boolean))];

function saveSettings() {
  const url = $('cfgUrl').value.trim();
  if (!URL_RE.test(url)) { setMsg('URL は https://script.google.com/macros/s/…/exec の形式で入力してください', 'err'); return false; }
  store.set('url', url);
  setKey($('cfgKey').value.trim(), $('cfgRemember').checked);
  const r = lines($('cfgRoster').value); store.set('roster', r.length ? r : DEFAULT_ROSTER);
  const t = lines($('cfgTags').value); store.set('tags', t);
  if (!roster().includes(state.oppChar)) state.oppChar = '';
  renderSelects(); renderOpp(); renderTags(); update();
  return true;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  renderSelects(); renderOpp(); renderResult(); renderTags(); renderToday(); renderNames(); renderQueue(); update();

  $('myChar').addEventListener('change', (e) => { state.myChar = e.target.value; store.set('myChar', state.myChar); });
  document.querySelectorAll('.res').forEach((b) => b.addEventListener('click', () => {
    state.result = b.dataset.result; state.round = ''; renderResult(); update();
  }));
  $('submit').addEventListener('click', submit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('settings').open) { e.preventDefault(); submit(); }
  });

  $('openSettings').addEventListener('click', openSettings);
  $('cfgCancel').addEventListener('click', () => $('settings').close());
  $('settingsForm').addEventListener('submit', (e) => {
    if (!saveSettings()) { e.preventDefault(); return; }
    toast('設定を保存しました');
  });
  $('cfgForget').addEventListener('click', () => { setKey('', false); $('cfgKey').value = ''; setMsg('キーを消去しました', 'ok'); });
  $('cfgTest').addEventListener('click', async () => {
    if (!saveSettings()) return;
    setMsg('接続中…');
    try { await post({ action: 'ping' }); setMsg('接続 OK', 'ok'); }
    catch (e) {
      setMsg(e instanceof ServerError ? e.message
        : '通信できません。デプロイの「アクセスできるユーザー」が「全員」か、URL が /exec で終わるか確認してください', 'err');
    }
  });

  window.addEventListener('online', flushQueue);
  flushQueue();
  if (!store.get('url', '')) openSettings();
});
