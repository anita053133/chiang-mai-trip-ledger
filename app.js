const el = id => document.getElementById(id);
const members = ['Tina', 'Zoe', 'kiki', 'Yu'];
const categories = ['餐飲', '咖啡甜點', '交通', '購物', '景點門票', '住宿', '按摩 SPA', '活動體驗', '加油', '停車', '其他'];
const methods = ['現金', '信用卡', '電子支付', '其他'];
const kindLabels = { expense: '支出', initial: '初始投入', topup: '追加公款' };
const dates = ['11/28（六）', '11/29（日）', '11/30（一）', '12/01（二）', '12/02（三）', '12/03（四）', '12/04（五）', '12/05（六）'];
const invite = new URLSearchParams(location.hash.slice(1)).get('trip') || '';
const configured = Boolean(GAS_API_URL && /^[a-f0-9]{64}$/i.test(invite));
const tripStorage = 'chiang-mai-2026:' + invite + ':';
const readLocal = (name, fallback) => {
  try { return JSON.parse(localStorage.getItem(tripStorage + name)) ?? fallback; }
  catch { return fallback; }
};
const writeLocal = (name, value) => localStorage.setItem(tripStorage + name, JSON.stringify(value));
const clientId = readLocal('client', null) || crypto.randomUUID();
const preferredMember = readLocal('member', '');
const storedDay = Number(readLocal('day', 1));
const dateInChiangMai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', month: '2-digit', day: '2-digit',
}).format(new Date());
const nowIndex = dates.findIndex(date => date.startsWith(dateInChiangMai));

let activeDay = nowIndex >= 0 && readLocal('day', null) === null ? nowIndex + 1 : Math.min(8, Math.max(1, storedDay || 1));
let scope = 'public';
let state = configured ? readLocal('cache', {}) : {};
let rate = Number(state.rate) || 1;
let syncTask;
let bridgeTask;
let requestNumber = 0;
let rateEdited = false;

try { writeLocal('client', clientId); } catch { /* Cloud writes can still be attempted when storage is blocked. */ }

function makeOption(label, value = label) {
  return new Option(label, value);
}

dates.forEach((date, index) => el('day').append(makeOption('DAY ' + (index + 1) + '｜' + date, index + 1)));
categories.forEach(category => {
  el('category').append(makeOption(category));
  el('filterCategory').append(makeOption(category));
});
el('ledgerMember').append(makeOption('全部成員', ''));
el('payer').append(makeOption('選擇成員', ''));
members.forEach(member => {
  el('ledgerMember').append(makeOption(member));
  el('payer').append(makeOption(member));
});
el('payer').value = members.includes(preferredMember) ? preferredMember : '';
el('day').value = String(activeDay);
el('rate').value = String(rate);

class RequestError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

async function api(action, payload = null) {
  if (!configured) throw new RequestError('請使用完整邀請連結');
  const request = {action, payload, key: invite};
  let result;
  try {
    const response = await fetch(GAS_API_URL, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
      body: JSON.stringify(request), signal: AbortSignal.timeout(12000),
      headers: {'Content-Type': 'text/plain;charset=UTF-8'},
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    result = await response.json();
  } catch {
    result = await requestThroughBridge(request);
  }
  if (!result?.ok) throw new RequestError(result?.error || '後端未回傳結果', Boolean(result?.retry));
  return result;
}

function requestThroughBridge(request) {
  if (!navigator.onLine || !location.hostname.endsWith('.github.io')) {
    return Promise.reject(new RequestError('目前無法連線，將在恢復連線後重試', true));
  }
  if (!bridgeTask) bridgeTask = openBridge();
  return bridgeTask.then(bridge => bridge.send(request));
}

function openBridge() {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const url = new URL(GAS_API_URL);
    url.search = new URLSearchParams({bridge: nonce, origin: location.origin});
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = '記帳同步';
    frame.src = url.href;
    let peer;
    let peerOrigin;
    const callbacks = new Map();
    const remove = () => {
      bridgeTask = null;
      window.removeEventListener('message', onMessage);
      frame.remove();
    };
    const timer = setTimeout(() => {
      remove();
      reject(new RequestError('雲端連線逾時', true));
    }, 12000);
    function onMessage(event) {
      if (!/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/i.test(event.origin) ||
          event.data?.nonce !== nonce || !event.source) return;
      if (event.data.ready && !peer) {
        clearTimeout(timer);
        peer = event.source;
        peerOrigin = event.origin;
        resolve({send});
        return;
      }
      if (event.source !== peer || event.origin !== peerOrigin) return;
      callbacks.get(event.data.id)?.(event.data);
    }
    function send(data) {
      return new Promise((done, fail) => {
        const id = ++requestNumber;
        const timeout = setTimeout(() => {
          callbacks.delete(id);
          remove();
          fail(new RequestError('雲端回覆逾時', true));
        }, 12000);
        callbacks.set(id, message => {
          clearTimeout(timeout);
          callbacks.delete(id);
          if (message.transportError) fail(new RequestError('雲端暫時無法讀寫', true));
          else done(message.result);
        });
        peer.postMessage({nonce, id, request: data}, peerOrigin);
      });
    }
    window.addEventListener('message', onMessage);
    document.body.append(frame);
  });
}

function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.style.display = 'none'; }, 3800);
}

function status(type, message) {
  el('cloudBadge').className = 'badge ' + type;
  el('cloudBadge').textContent = message;
}

function getQueue() {
  return configured ? readLocal('pending', []) : [];
}

function saveQueue(queue) {
  writeLocal('pending', queue);
}

function queueEntries(records) {
  const queue = [...getQueue()];
  const known = new Set(queue.map(record => record.id));
  for (const record of records) {
    if (!known.has(record.id)) {
      queue.push(record);
      known.add(record.id);
    }
  }
  saveQueue(queue);
  render();
}

async function syncOnce(manual) {
  if (!configured) {
    status('warn', GAS_API_URL ? '需要完整邀請連結' : '等待部署雲端帳本');
    return;
  }
  if (!navigator.onLine) {
    status('warn', '離線，等待同步');
    return;
  }
  if (manual || getQueue().length) status('', '同步中…');
  try {
    for (const row of getQueue()) {
      try {
        await api('addExpense', row);
      } catch (error) {
        if (error.retryable || error.message.includes('邀請連結')) throw error;
        // Keep rejected records on the device so they can be exported or removed by the user.
        status('err', '有待同步的紀錄需要檢查');
        toast(error.message);
        continue;
      }
      // Keep an acknowledged record visible even if a later pull fails.
      state = {...state, expenses: [row, ...(state.expenses || []).filter(record => record.id !== row.id)]};
      saveQueue(getQueue().filter(record => record.id !== row.id));
    }

    const data = await api('getAppData');
    state = {rate: data.rate, expenses: data.expenses, itinerary: data.itinerary};
    rate = Number(state.rate);
    if (!rateEdited) el('rate').value = String(rate);
    try { writeLocal('cache', state); } catch { /* The latest records remain available in memory. */ }
    status(getQueue().length ? 'warn' : 'ok', getQueue().length ? '有紀錄待同步' : '雲端已同步');
    el('lastSync').textContent = '最後同步 ' + new Date().toLocaleTimeString('zh-TW', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (error) {
    status(getQueue().length ? 'warn' : 'err', getQueue().length ? '已暫存，等待同步' : '雲端連線失敗');
    if (manual) toast(error.message);
  } finally {
    render();
  }
}

function synchronize(manual = false) {
  if (!syncTask) {
    syncTask = syncOnce(manual).finally(() => { syncTask = null; });
  }
  return syncTask;
}

function selectScope(next) {
  scope = next;
  el('publicScope').setAttribute('aria-pressed', String(scope === 'public'));
  el('personalScope').setAttribute('aria-pressed', String(scope === 'personal'));
  el('fundCard').hidden = scope === 'personal';
  el('memberFilter').hidden = scope === 'public';
  el('kind').disabled = scope === 'personal';
  el('kind').value = 'expense';
  if (scope === 'personal') el('ledgerMember').value = el('payer').value;
  updateKind();
  render();
}

function updateKind() {
  const kind = el('kind').value;
  const expense = kind === 'expense';
  el('categoryField').hidden = !expense;
  el('titleLabel').textContent = expense ? '支出項目' : '投入項目';
  el('payerLabel').textContent = expense ? '付款人' : '投入人';
  el('title').required = expense;
  el('title').placeholder = expense ? '例如：夜市晚餐' : kindLabels[kind];
  el('entryTitle').textContent = expense ? (scope === 'public' ? '新增公款支出' : '新增個人支出') : '記錄' + kindLabels[kind];
  el('addBtn').textContent = '＋ ' + (expense ? '新增支出' : '記錄' + kindLabels[kind]);
}

function addExpense(event) {
  event.preventDefault();
  if (!configured) return toast('請使用已串接雲端帳本的完整邀請連結');
  const kind = el('kind').value;
  const title = el('title').value.trim() || (kind === 'expense' ? '' : kindLabels[kind]);
  const record = {
    id: crypto.randomUUID(), created_at: new Date().toISOString(),
    day: Number(el('day').value), scope, kind, category: kind === 'expense' ? el('category').value : '',
    title, amount: Number(el('amount').value), currency: el('currency').value,
    payer: el('payer').value, method: el('method').value, note: el('note').value.trim(), client_id: clientId,
  };
  if (!isValidRecord(record)) return toast('請確認項目、金額及付款／投入人');
  try { queueEntries([record]); }
  catch { return toast('裝置的暫存空間無法寫入，這筆紀錄尚未儲存'); }
  try { writeLocal('member', record.payer); } catch {}
  if (scope === 'personal') el('ledgerMember').value = record.payer;
  setDay(record.day);
  for (const id of ['title', 'amount', 'note']) el(id).value = '';
  if (!navigator.onLine) toast('已暫存，恢復連線後會自動補傳');
  void synchronize();
}

function isValidRecord(record) {
  return /^[A-Za-z0-9_-]{1,96}$/.test(record.id) &&
    Number.isInteger(record.day) && record.day >= 1 && record.day <= dates.length &&
    ['public', 'personal'].includes(record.scope) && Object.hasOwn(kindLabels, record.kind) &&
    (record.kind === 'expense' ? categories.includes(record.category) : record.scope === 'public') &&
    record.title.length > 0 && record.title.length <= 80 && record.note.length <= 200 &&
    Number.isFinite(record.amount) && record.amount >= 0.01 && record.amount <= 100000000 &&
    Math.abs(record.amount * 100 - Math.round(record.amount * 100)) <= 0.00001 &&
    ['THB', 'TWD'].includes(record.currency) && members.includes(record.payer) && methods.includes(record.method);
}

async function deleteExpense(row, button) {
  if (!confirm('確定刪除這筆紀錄？已同步的紀錄會在 Google Sheet 保留刪除時間。')) return;
  button.disabled = true;
  try {
    await syncTask;
    if (navigator.onLine) {
      // A timed-out earlier write may already exist in Sheets. Tombstone by ID before dropping it from the queue.
      await api('deleteExpense', {scope: row.scope, id: row.id});
    } else {
      throw new RequestError('請在連線後刪除，以確認雲端同步狀態');
    }
    saveQueue(getQueue().filter(record => record.id !== row.id));
    state = {...state, expenses: (state.expenses || []).filter(record => record.id !== row.id)};
    try { writeLocal('cache', state); } catch {}
    render();
    toast('已刪除');
    void synchronize();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function setDay(day) {
  activeDay = day;
  el('day').value = String(day);
  try { writeLocal('day', day); } catch {}
  render();
  el('dayButtons').querySelector('.active')?.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
}

async function saveRate(event) {
  event.preventDefault();
  const next = Number(el('rate').value);
  if (!Number.isFinite(next) || next < 0.0001 || next > 100) return toast('請輸入正確匯率');
  const button = el('saveRate');
  button.disabled = true;
  try {
    await syncTask;
    const result = await api('saveRate', {rate: next});
    rate = Number(result.rate);
    state = {...state, rate};
    if (Number(el('rate').value) === next) {
      rateEdited = false;
      el('rate').value = String(rate);
    }
    try { writeLocal('cache', state); } catch {}
    render();
    toast('共用匯率已更新');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

const money = new Intl.NumberFormat('zh-TW', {maximumFractionDigits: 2});
const asThb = row => row.currency === 'THB' ? row.amount : row.amount / rate;
const asTwd = row => row.currency === 'TWD' ? row.amount : row.amount * rate;
const thb = amount => '฿' + money.format(amount);
const twd = amount => 'NT$' + money.format(amount);
const sum = (rows, getAmount) => rows.reduce((total, row) => total + getAmount(row), 0);
const formatOriginal = row => row.currency === 'THB' ? thb(row.amount) : twd(row.amount);

function allRows() {
  const records = new Map((state.expenses || []).map(row => [row.id, row]));
  getQueue().forEach(row => records.set(row.id, row));
  return [...records.values()].sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function currentRows() {
  const person = el('ledgerMember').value;
  return allRows().filter(row => row.scope === scope && (scope === 'public' || !person || row.payer === person));
}

function textNode(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function render() {
  const pending = new Set(getQueue().map(row => row.id));
  el('pendingBadge').hidden = !pending.size;
  el('pendingBadge').textContent = '待同步 ' + pending.size + ' 筆';
  const rows = currentRows();
  const expenseRows = rows.filter(row => row.kind === 'expense');
  const total = sum(expenseRows, asThb);
  const person = el('ledgerMember').value;
  el('summaryTitle').textContent = scope === 'public' ? '公款支出總覽' : (person ? person + ' 的' : '') + '個人支出總覽';
  el('sumThb').textContent = thb(total);
  el('sumTwd').textContent = twd(sum(expenseRows, asTwd));
  el('count').textContent = String(expenseRows.length);
  el('avgDay').textContent = thb(total / dates.length);

  if (scope === 'public') {
    const initial = sum(rows.filter(row => row.kind === 'initial'), asThb);
    const topup = sum(rows.filter(row => row.kind === 'topup'), asThb);
    const balance = initial + topup - total;
    el('initial').textContent = thb(initial);
    el('topup').textContent = thb(topup);
    el('spent').textContent = thb(total);
    el('balance').textContent = thb(balance);
    el('balance').classList.toggle('negative', balance < -0.005);
    el('memberContributions').textContent = members.map(member =>
      member + ' ' + thb(sum(rows.filter(row => row.kind !== 'expense' && row.payer === member), asThb))
    ).join(' ・ ');
  }

  const listDays = el('dayButtons');
  const scroll = listDays.scrollLeft;
  listDays.replaceChildren(...dates.map((_, index) => {
    const day = index + 1;
    const dayTotal = sum(expenseRows.filter(row => row.day === day), asThb);
    const button = textNode('button', 'DAY ' + day + '｜' + thb(dayTotal), 'daybtn' + (day === activeDay ? ' active' : ''));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(day === activeDay));
    button.addEventListener('click', () => setDay(day));
    return button;
  }));
  listDays.scrollLeft = scroll;
  const trip = state.itinerary?.[activeDay - 1];
  el('itinerary').replaceChildren(textNode('strong', 'DAY ' + activeDay + '｜' + dates[activeDay - 1]));
  if (trip) el('itinerary').append(textNode('small', trip[0]), textNode('small', trip[1]));

  const filter = el('filterCategory').value;
  const details = rows.filter(row => row.day === activeDay && (!filter || row.category === filter));
  el('expenseList').replaceChildren(...(details.length ? details.map(row => {
    const item = textNode('article', '', 'item');
    const left = textNode('div', '');
    const meta = [row.kind === 'expense' ? row.category : kindLabels[row.kind], row.payer, row.method, row.note, pending.has(row.id) ? '待同步' : ''];
    left.append(textNode('div', row.title, 'title'), textNode('div', meta.filter(Boolean).join('・'), 'meta'));
    const right = textNode('div', (row.kind === 'expense' ? '' : '+') + formatOriginal(row), 'amount');
    const button = textNode('button', '刪除', 'btn danger');
    button.type = 'button';
    button.setAttribute('aria-label', '刪除 ' + row.title);
    button.addEventListener('click', () => deleteExpense(row, button));
    right.append(textNode('small', '約 ' + (row.currency === 'THB' ? twd(asTwd(row)) : thb(asThb(row)))), button);
    item.append(left, right);
    return item;
  }) : [textNode('div', '這一天沒有符合條件的紀錄', 'empty')]));

  const groups = categories.map(category => [category, sum(expenseRows.filter(row => row.category === category), asThb)])
    .filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  el('categoryStats').replaceChildren(...(groups.length ? groups.map(([category, value]) => {
    const group = textNode('div', '', 'barrow');
    const bar = textNode('div', '', 'bar');
    const fill = document.createElement('i');
    fill.style.width = (value / groups[0][1] * 100) + '%';
    bar.append(fill);
    bar.setAttribute('aria-hidden', 'true');
    group.append(textNode('span', category), bar, textNode('strong', thb(value)));
    return group;
  }) : [textNode('div', '新增支出後會顯示分類統計', 'empty')]));
}

const csvColumns = ['紀錄ID', '建立時間', '帳本', '行程日', '日期', '類型', '分類', '項目', '原幣金額', '幣別', '換算泰銖', '換算台幣', '付款人', '付款方式', '備註'];

function csvCell(value) {
  const string = String(value ?? '');
  const safe = /^[\s]*[=+@-]/.test(string) && typeof value !== 'number' ? "'" + string : string;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function exportCSV() {
  const records = currentRows();
  if (!records.length) return toast('目前沒有可匯出的資料');
  const rows = records.slice().reverse().map(row => [
    row.id, row.created_at, row.scope === 'public' ? '公款' : '個人', 'DAY ' + row.day, dates[row.day - 1],
    kindLabels[row.kind], row.category, row.title, row.amount, row.currency, Number(asThb(row).toFixed(2)),
    Number(asTwd(row).toFixed(2)), row.payer, row.method, row.note,
  ]);
  const blob = new Blob(['\uFEFF', ...[csvColumns, ...rows].map(row => row.map(csvCell).join(',') + '\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = '清邁八天七夜_' + (scope === 'public' ? '公款' : '個人') + '_備份.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (char !== '\r') cell += char;
  }
  if (quoted) throw new Error('CSV 有未關閉的引號');
  if (cell.length || row.length) rows.push([...row, cell]);
  return rows;
}

async function importCSV(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!configured) return toast('請使用完整邀請連結');
  if (file.size > 1000000) return toast('請使用小於 1 MB 的清邁記帳 CSV');
  try {
    const [headers, ...source] = parseCSV((await file.text()).replace(/^\uFEFF/, ''));
    const fields = ['紀錄ID', '帳本', '行程日', '類型', '分類', '項目', '原幣金額', '幣別', '付款人', '付款方式'];
    if (!headers || fields.some(field => !headers.includes(field))) throw new Error('請使用清邁帳本匯出的 CSV 格式');
    const rows = source.filter(row => row.some(cell => cell.trim())).map(row => {
      const get = key => row[headers.indexOf(key)] ?? '';
      const unescape = value => value.replace(/^'(?=[\s]*[=+@-])/, '');
      const date = new Date(get('建立時間'));
      return {
        id: get('紀錄ID'), created_at: Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(),
        scope: ({公款: 'public', 個人: 'personal'})[get('帳本')],
        day: Number(get('行程日').replace(/^DAY\s*/i, '')),
        kind: Object.keys(kindLabels).find(kind => kindLabels[kind] === get('類型')),
        category: get('分類'), title: unescape(get('項目')).trim(), amount: Number(get('原幣金額')),
        currency: get('幣別'), payer: get('付款人'), method: get('付款方式'),
        note: unescape(get('備註')).trim(), client_id: clientId,
      };
    });
    if (!rows.length) throw new Error('CSV 沒有可匯入的資料');
    const invalidRow = rows.findIndex(row => !isValidRecord(row));
    if (invalidRow >= 0) throw new Error('第 ' + (invalidRow + 1) + ' 筆資料的欄位值不正確');
    if (!confirm('將 ' + rows.length + ' 筆紀錄匯入清邁帳本。重複 ID 會自動略過。')) return;
    const known = new Set(allRows().map(row => row.id));
    queueEntries(rows.filter(row => !known.has(row.id)));
    if (navigator.onLine) await synchronize(true);
    else toast('備份已暫存，恢復連線後會自動補傳');
  } catch (error) {
    toast('匯入失敗：' + error.message);
  }
}

el('publicScope').addEventListener('click', () => selectScope('public'));
el('personalScope').addEventListener('click', () => selectScope('personal'));
el('ledgerMember').addEventListener('change', render);
el('filterCategory').addEventListener('change', render);
el('kind').addEventListener('change', updateKind);
el('refresh').addEventListener('click', () => synchronize(true));
el('entry').addEventListener('submit', addExpense);
el('rate').addEventListener('input', () => { rateEdited = true; });
el('rateForm').addEventListener('submit', saveRate);
el('export').addEventListener('click', exportCSV);
el('import').addEventListener('click', () => el('csvFile').click());
el('csvFile').addEventListener('change', importCSV);
el('fundEntry').addEventListener('click', () => {
  el('kind').value = 'initial';
  updateKind();
  el('entryTitle').scrollIntoView({block: 'start'});
  el('kind').focus({preventScroll: true});
});
el('sample').addEventListener('click', () => {
  el('kind').value = 'expense';
  updateKind();
  el('category').value = '餐飲';
  el('title').value = '夜市晚餐（範例）';
  el('amount').value = '400';
  el('currency').value = 'THB';
  if (!el('payer').value) el('payer').value = 'Yu';
  el('method').value = '現金';
});
window.addEventListener('online', () => synchronize(true));
window.addEventListener('offline', () => status('warn', '離線，等待同步'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) void synchronize(); });
setInterval(() => { if (!document.hidden) void synchronize(); }, 15000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (!configured) {
  el('addBtn').disabled = true;
  el('saveRate').disabled = true;
}
render();
void synchronize(true);
