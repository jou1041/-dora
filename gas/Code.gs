/**
 * 煎和鍋貼所｜訂單系統後端（Google Apps Script）
 *
 * 功能：
 *  1. 接收網站結帳送出的訂單（doPost），驗證後寫入 Google 試算表
 *  2. 以「商品」工作表為準重新計算金額，避免有人竄改網頁價格
 *  3. 伺服器產生訂單編號（JH + 年月日 + 當日流水號），用 LockService 避免同時下單時重號
 *  4. 以客戶端代碼防止重複送單（網路不穩時重送不會變成兩筆）
 *  5. 寄送店家通知信與顧客確認信（可關閉）
 *  6. 在試算表把「狀態」改成「製作中／可取餐／已出貨」時，自動通知顧客
 *  7. 每日營業摘要信、訂單查詢（訂單編號＋電話）
 *
 * 部署方式請見同資料夾的 README.md。
 */

/* ===================== 設定區（只需要改這裡） ===================== */
const CONFIG = {
  STORE_NAME: '煎和鍋貼所',
  NOTIFY_EMAILS: '',            // 店家收通知的信箱，多個用逗號分隔；留空＝不寄店家通知
  SEND_CUSTOMER_MAIL: true,     // 顧客有填 Email 時，是否寄訂單確認信與狀態通知
  DAILY_SUMMARY_HOUR: 22,       // 每日摘要寄送時間（24 小時制）；NOTIFY_EMAILS 有填才會建立
  SHIPPING_FEE: 150,            // 冷凍宅配運費（需與網站 index.html 的 SHIPPING_FEE 相同）
  FREE_SHIP: 1500,              // 宅配免運門檻（需與網站 FREE_SHIP 相同）
  MAX_QTY: 99,
  MAX_LINES: 40,
  RATE_LIMIT_COUNT: 5,          // 同一支電話在時間窗內最多幾筆
  RATE_LIMIT_SECONDS: 600,
  TZ: 'Asia/Taipei',
  STATUSES: ['新訂單', '製作中', '可取餐', '已出貨', '已完成', '已取消'],
  NOTIFY_ON_STATUS: ['製作中', '可取餐', '已出貨', '已取消']   // 改成這些狀態時通知顧客
};

const SHEETS = { ORDERS: '訂單', ITEMS: '訂單明細', PRODUCTS: '商品', LOG: '系統記錄' };

const ORDER_HEADERS = ['建立時間', '訂單編號', '狀態', '取餐方式', '姓名', '電話', 'Email', '門市', '取餐時間／到貨日', '用餐人數',
  '收件地址', '付款方式', '備註', '商品摘要', '商品小計', '運費', '應付總額', '來源', '客戶端代碼'];
const ITEM_HEADERS = ['訂單編號', '品項ID', '品名', '單位', '單價', '數量', '小計'];
const PRODUCT_HEADERS = ['品項ID', '分類', '品名', '單位', '單價', '上架'];
const COL = { TIME: 1, ID: 2, STATUS: 3, TYPE: 4, NAME: 5, PHONE: 6, EMAIL: 7, STORE: 8, WHEN: 9, GUESTS: 10, ADDR: 11, PAY: 12, NOTE: 13,
  SUMMARY: 14, SUBTOTAL: 15, SHIP: 16, TOTAL: 17, SOURCE: 18, TOKEN: 19 };

const ORDER_TYPES = { dinein: '內用', takeout: '外帶', delivery: '冷凍宅配' };
const PAY_METHODS = ['現場付款', 'LINE Pay', '信用卡'];

/* 初始商品（與網站菜單一致；執行「初始化」時寫入「商品」工作表，之後在試算表直接改價格即可） */
const SEED_PRODUCTS = [
  ["p1", "鍋貼", "招牌豬肉鍋貼", "10 顆", 80, true],
  ["p2", "鍋貼", "韭黃鮮蝦鍋貼", "10 顆", 120, true],
  ["p3", "鍋貼", "川味麻辣鍋貼", "10 顆", 95, true],
  ["p4", "鍋貼", "泡菜起司鍋貼", "10 顆", 100, true],
  ["p5", "鍋貼", "玉米高麗菜鍋貼", "10 顆", 75, true],
  ["d1", "水餃", "經典鮮肉水餃", "10 顆", 70, true],
  ["d2", "水餃", "韭菜豬肉水餃", "10 顆", 70, true],
  ["d3", "水餃", "鮮蝦三鮮水餃", "10 顆", 110, true],
  ["d4", "水餃", "田園蔬食水餃", "10 顆", 65, true],
  ["s1", "湯品/飲料", "古早味酸辣湯", "一碗", 45, true],
  ["s2", "湯品/飲料", "玉米蛋花湯", "一碗", 40, true],
  ["s3", "湯品/飲料", "手工現磨豆漿", "500ml", 30, true],
  ["s4", "湯品/飲料", "冬瓜檸檬", "500ml", 35, true],
  ["c1", "小菜", "涼拌小黃瓜", "一份", 40, true],
  ["c2", "小菜", "老滷豆干海帶", "一份", 45, true],
  ["c3", "小菜", "皮蛋豆腐", "一份", 50, true],
  ["c4", "小菜", "麻辣鴨血", "一份", 55, true],
  ["g1", "冷凍禮盒", "招牌招財鍋貼禮盒", "50 入", 880, true],
  ["g2", "冷凍禮盒", "闔家團圓水餃組", "80 入", 1280, true],
  ["g3", "冷凍禮盒", "新春福氣伴手禮盒", "40 入", 980, true]
];
const STORES = [
  ["st1", "旗艦店"],
  ["st2", "信義店"],
  ["st3", "中山店"],
  ["st4", "台中勤美店"]
];
const STORE_MAP = STORES.reduce(function (m, s) { m[s[0]] = s[1]; return m; }, {});

/* ===================== 網頁進入點 ===================== */
function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    var payload = JSON.parse(raw);
    return json_(handleOrder_(payload));
  } catch (err) {
    log_('doPost 錯誤', String(err && err.stack || err));
    return json_({ ok: false, code: 'BAD_REQUEST', message: '訂單格式錯誤，請重新整理頁面再試一次。' });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'status') return json_(lookupStatus_(p.id, p.phone));
  return json_({ ok: true, service: CONFIG.STORE_NAME + ' order api', time: nowStr_() });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================== 下單主流程 ===================== */
function handleOrder_(p) {
  p = p || {};
  // 1. 防機器人：隱藏欄位必須為空
  if (String(p.website || '').trim() !== '') return { ok: false, code: 'REJECTED', message: '訂單無法送出。' };

  var v = validate_(p);
  if (!v.ok) return v;

  var phoneKey = 'rl_' + v.phone;
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, code: 'BUSY', message: '目前下單人數較多，請稍後再試一次。' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var orders = sheet_(ss, SHEETS.ORDERS);
    var items = sheet_(ss, SHEETS.ITEMS);

    // 2. 重複送單檢查（同一個客戶端代碼只建立一筆）
    var dup = findByToken_(orders, v.token);
    if (dup) return Object.assign({ ok: true, duplicate: true }, dup);

    // 3. 頻率限制
    var count = Number(cache.get(phoneKey) || 0);
    if (count >= CONFIG.RATE_LIMIT_COUNT) return { ok: false, code: 'RATE_LIMIT', message: '送出次數過多，請稍後再試或來電訂購。' };

    // 4. 以商品表重新計價
    var catalog = loadCatalog_(ss);
    var lines = [], subtotal = 0;
    for (var i = 0; i < v.items.length; i++) {
      var it = v.items[i];
      var prod = catalog[it.id];
      if (!prod || !prod.active) return { ok: false, code: 'ITEM_UNAVAILABLE', message: '商品「' + it.id + '」目前無法訂購，請重新整理頁面。' };
      var amt = prod.price * it.qty;
      subtotal += amt;
      lines.push({ id: it.id, name: prod.name, unit: prod.unit, price: prod.price, qty: it.qty, amount: amt });
    }
    var shipping = v.type === 'delivery' && subtotal < CONFIG.FREE_SHIP ? CONFIG.SHIPPING_FEE : 0;
    var total = subtotal + shipping;

    // 5. 產生訂單編號
    var orderId = nextOrderId_();
    var createdAt = nowStr_();
    var summary = lines.map(function (l) { return l.name + '×' + l.qty; }).join('、');

    orders.appendRow([
      createdAt, orderId, CONFIG.STATUSES[0], ORDER_TYPES[v.type], safe_(v.name), "'" + v.phone, safe_(v.email),
      safe_(v.storeName), safe_(v.when), v.guests, safe_(v.address), v.pay, safe_(v.note),
      summary, subtotal, shipping, total, safe_(v.source), v.token
    ]);
    var rows = lines.map(function (l) { return [orderId, l.id, l.name, l.unit, l.price, l.qty, l.amount]; });
    if (rows.length) items.getRange(items.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
    cache.put(phoneKey, String(count + 1), CONFIG.RATE_LIMIT_SECONDS);

    var result = { orderId: orderId, subtotal: subtotal, shipping: shipping, total: total, status: CONFIG.STATUSES[0], createdAt: createdAt };

    // 6. 通知（失敗不影響訂單）
    try { notifyNewOrder_(result, v, lines); } catch (mailErr) { log_('寄信失敗', String(mailErr)); }
    return Object.assign({ ok: true }, result);
  } catch (err) {
    log_('下單失敗', String(err && err.stack || err));
    return { ok: false, code: 'SERVER_ERROR', message: '系統忙碌中，請稍後再試，或直接來電訂購。' };
  } finally {
    lock.releaseLock();
  }
}

/* 驗證與清理輸入 */
function validate_(p) {
  var fail = function (m, c) { return { ok: false, code: c || 'INVALID', message: m }; };
  var type = String(p.orderType || '');
  if (!ORDER_TYPES[type]) return fail('取餐方式不正確。');
  var name = clean_(p.name, 40);
  if (!name) return fail('請填寫姓名。');
  var phone = String(p.phone || '').replace(/[\s-]/g, '');
  if (!/^09\d{8}$/.test(phone)) return fail('請填寫正確的手機號碼（09 開頭共 10 碼）。');
  var email = clean_(p.email, 80);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Email 格式不正確。');
  var token = String(p.clientToken || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return fail('訂單識別碼無效，請重新整理頁面。');
  var pay = PAY_METHODS.indexOf(p.pay) >= 0 ? p.pay : PAY_METHODS[0];
  var address = clean_(p.address, 120), when = clean_(p.time, 40), storeName = '', guests = '';
  if (type === 'delivery') {
    if (address.length < 6) return fail('請填寫完整的收件地址。');
    when = clean_(p.date, 20);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return fail('請選擇到貨日期。');
    storeName = '宅配';
  } else {
    storeName = STORE_MAP[p.store];
    if (!storeName) return fail('請選擇取餐門市。');
    if (!when) return fail('請選擇取餐時間。');
    address = '';
    if (type === 'dinein') guests = clean_(p.guests, 10);
  }
  if (!Array.isArray(p.items) || !p.items.length) return fail('購物車是空的。');
  if (p.items.length > CONFIG.MAX_LINES) return fail('品項過多，請分次訂購。');
  var merged = {}, order = [];
  for (var i = 0; i < p.items.length; i++) {
    var id = String((p.items[i] || {}).id || ''), q = Math.floor(Number((p.items[i] || {}).qty));
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id) || !(q >= 1)) return fail('商品資料不正確。');
    if (q > CONFIG.MAX_QTY) q = CONFIG.MAX_QTY;
    if (!merged[id]) { merged[id] = 0; order.push(id); }
    merged[id] = Math.min(CONFIG.MAX_QTY, merged[id] + q);
  }
  return {
    ok: true, type: type, name: name, phone: phone, email: email, token: token, pay: pay, address: address, when: when,
    storeName: storeName, guests: guests, note: clean_(p.note, 200), source: clean_(p.source, 40) || 'web',
    items: order.map(function (id) { return { id: id, qty: merged[id] }; })
  };
}

function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
/* 避免試算表把內容當成公式執行（= + - @ 開頭） */
function safe_(v) { v = String(v == null ? '' : v); return /^[=+\-@]/.test(v) ? "'" + v : v; }

/* ===================== 試算表工具 ===================== */
function sheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('找不到工作表「' + name + '」，請先執行「鍋貼系統 → 初始化工作表」。');
  return sh;
}

function loadCatalog_(ss) {
  var sh = sheet_(ss, SHEETS.PRODUCTS);
  var last = sh.getLastRow();
  var map = {};
  if (last < 2) return map;
  sh.getRange(2, 1, last - 1, PRODUCT_HEADERS.length).getValues().forEach(function (r) {
    if (!r[0]) return;
    map[String(r[0])] = { id: String(r[0]), cat: r[1], name: String(r[2]), unit: String(r[3]), price: Number(r[4]) || 0, active: r[5] === true || String(r[5]).toUpperCase() === 'TRUE' };
  });
  return map;
}

function findByToken_(orders, token) {
  var last = orders.getLastRow();
  if (last < 2) return null;
  var from = Math.max(2, last - 300);
  var vals = orders.getRange(from, 1, last - from + 1, ORDER_HEADERS.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (vals[i][COL.TOKEN - 1] === token) {
      return { orderId: vals[i][COL.ID - 1], subtotal: vals[i][COL.SUBTOTAL - 1], shipping: vals[i][COL.SHIP - 1], total: vals[i][COL.TOTAL - 1],
        status: vals[i][COL.STATUS - 1], createdAt: String(vals[i][COL.TIME - 1]) };
    }
  }
  return null;
}

function nextOrderId_() {
  var day = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyMMdd');
  var props = PropertiesService.getScriptProperties();
  var key = 'seq_' + day;
  var n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  // 清掉舊日期的計數器
  var all = props.getKeys();
  for (var i = 0; i < all.length; i++) if (all[i].indexOf('seq_') === 0 && all[i] !== key) props.deleteProperty(all[i]);
  return 'JH' + day + ('0000' + n).slice(-4);
}

function nowStr_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'); }

function log_(title, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEETS.LOG) || ss.insertSheet(SHEETS.LOG);
    if (sh.getLastRow() === 0) sh.appendRow(['時間', '事件', '內容']);
    sh.appendRow([nowStr_(), title, String(detail).slice(0, 2000)]);
  } catch (e) { /* 記錄失敗就算了 */ }
}

/* ===================== 訂單查詢 ===================== */
function lookupStatus_(id, phone) {
  id = String(id || '').trim(); phone = String(phone || '').replace(/[\s-]/g, '');
  if (!/^JH\d{10}$/.test(id) || !/^09\d{8}$/.test(phone)) return { ok: false, code: 'INVALID', message: '請輸入正確的訂單編號與手機號碼。' };
  var orders = sheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEETS.ORDERS);
  var last = orders.getLastRow();
  if (last < 2) return { ok: false, code: 'NOT_FOUND', message: '查無此訂單。' };
  var vals = orders.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (vals[i][COL.ID - 1] === id) {
      if (String(vals[i][COL.PHONE - 1]).replace(/\D/g, '') !== phone) break;
      return { ok: true, orderId: id, status: vals[i][COL.STATUS - 1], type: vals[i][COL.TYPE - 1], total: vals[i][COL.TOTAL - 1], summary: vals[i][COL.SUMMARY - 1] };
    }
  }
  return { ok: false, code: 'NOT_FOUND', message: '查無此訂單，請確認編號與手機號碼。' };
}

/* ===================== 通知信 ===================== */
function money_(n) { return 'NT$' + Number(n).toLocaleString('en-US'); }
function esc_(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function orderTableHtml_(res, v, lines) {
  var rows = lines.map(function (l) {
    return '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">' + esc_(l.name) + '（' + esc_(l.unit) + '）</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">× ' + l.qty +
      '</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">' + money_(l.amount) + '</td></tr>';
  }).join('');
  return '<table style="border-collapse:collapse;font-size:14px;min-width:320px">' + rows +
    '<tr><td colspan="2" style="padding:4px 8px;text-align:right">商品小計</td><td style="padding:4px 8px;text-align:right">' + money_(res.subtotal) + '</td></tr>' +
    '<tr><td colspan="2" style="padding:4px 8px;text-align:right">運費</td><td style="padding:4px 8px;text-align:right">' + money_(res.shipping) + '</td></tr>' +
    '<tr><td colspan="2" style="padding:4px 8px;text-align:right"><b>應付總額</b></td><td style="padding:4px 8px;text-align:right"><b>' + money_(res.total) + '</b></td></tr></table>';
}

function notifyNewOrder_(res, v, lines) {
  var table = orderTableHtml_(res, v, lines);
  var detail = '<p>取餐方式：' + ORDER_TYPES[v.type] + '<br>' + (v.type === 'delivery' ? '收件地址：' + esc_(v.address) + '（' + esc_(v.when) + ' 到貨）' : '門市：' + esc_(v.storeName) + '・' + esc_(v.when)) +
    '<br>付款方式：' + esc_(v.pay) + (v.note ? '<br>備註：' + esc_(v.note) : '') + '</p>';
  if (CONFIG.NOTIFY_EMAILS) {
    MailApp.sendEmail({
      to: CONFIG.NOTIFY_EMAILS, subject: '【新訂單】' + res.orderId + '｜' + money_(res.total) + '｜' + v.name,
      htmlBody: '<h3>新訂單 ' + res.orderId + '</h3><p>' + esc_(v.name) + '　' + v.phone + (v.email ? '　' + esc_(v.email) : '') + '</p>' + detail + table
    });
  }
  if (CONFIG.SEND_CUSTOMER_MAIL && v.email) {
    MailApp.sendEmail({
      to: v.email, name: CONFIG.STORE_NAME, subject: '【' + CONFIG.STORE_NAME + '】訂單確認 ' + res.orderId,
      htmlBody: '<p>' + esc_(v.name) + ' 您好，感謝您的訂購！</p><p>您的訂單編號：<b>' + res.orderId + '</b></p>' + detail + table +
        '<p style="color:#888;font-size:12px">如需更改訂單，請來電門市並提供訂單編號。</p>'
    });
  }
}

/* 試算表「狀態」欄被改掉時，自動通知顧客（由 setup() 建立的 onEdit 觸發器呼叫） */
function onStatusEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEETS.ORDERS || e.range.getColumn() !== COL.STATUS || e.range.getRow() < 2) return;
    var status = String(e.value || '');
    if (CONFIG.NOTIFY_ON_STATUS.indexOf(status) < 0) return;
    var r = sh.getRange(e.range.getRow(), 1, 1, ORDER_HEADERS.length).getValues()[0];
    var email = String(r[COL.EMAIL - 1] || '').trim();
    if (!CONFIG.SEND_CUSTOMER_MAIL || !email) return;
    var msg = { '製作中': '您的餐點已開始製作。', '可取餐': '您的餐點已完成，歡迎前來取餐！', '已出貨': '您的冷凍宅配已出貨，請留意收件。', '已取消': '很抱歉，您的訂單已取消，如有疑問請來電聯繫。' }[status];
    MailApp.sendEmail({
      to: email, name: CONFIG.STORE_NAME, subject: '【' + CONFIG.STORE_NAME + '】訂單 ' + r[COL.ID - 1] + '：' + status,
      htmlBody: '<p>' + esc_(r[COL.NAME - 1]) + ' 您好，</p><p>' + msg + '</p><p>訂單編號：<b>' + r[COL.ID - 1] + '</b>　' + esc_(r[COL.SUMMARY - 1]) + '</p>'
    });
  } catch (err) { log_('狀態通知失敗', String(err)); }
}

/* 每日營業摘要（由 setup() 建立的時間觸發器呼叫） */
function dailySummary() {
  if (!CONFIG.NOTIFY_EMAILS) return;
  var orders = sheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEETS.ORDERS);
  var last = orders.getLastRow();
  var today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  var cnt = 0, sum = 0, cancelled = 0, byType = {};
  if (last >= 2) {
    orders.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues().forEach(function (r) {
      if (String(r[COL.TIME - 1]).slice(0, 10) !== today) return;
      if (r[COL.STATUS - 1] === '已取消') { cancelled++; return; }
      cnt++; sum += Number(r[COL.TOTAL - 1]) || 0;
      byType[r[COL.TYPE - 1]] = (byType[r[COL.TYPE - 1]] || 0) + 1;
    });
  }
  var types = Object.keys(byType).map(function (k) { return k + ' ' + byType[k] + ' 筆'; }).join('、') || '—';
  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAILS, subject: '【' + CONFIG.STORE_NAME + '】' + today + ' 營業摘要',
    htmlBody: '<p>今日訂單：<b>' + cnt + '</b> 筆（取消 ' + cancelled + ' 筆）<br>營業額：<b>' + money_(sum) + '</b><br>類型：' + types + '</p>'
  });
}

/* ===================== 初始化與選單 ===================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('鍋貼系統')
    .addItem('初始化工作表', 'setup')
    .addItem('重設商品資料（還原為預設菜單）', 'resetProducts')
    .addItem('寄出今日營業摘要', 'dailySummary')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TZ);
  var o = ensureSheet_(ss, SHEETS.ORDERS, ORDER_HEADERS);
  ensureSheet_(ss, SHEETS.ITEMS, ITEM_HEADERS);
  var p = ensureSheet_(ss, SHEETS.PRODUCTS, PRODUCT_HEADERS);
  if (p.getLastRow() < 2) resetProducts();

  // 訂單：狀態下拉、顏色、欄寬
  var statusRange = o.getRange(2, COL.STATUS, 1000, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.STATUSES, true).setAllowInvalid(false).build());
  var colors = { '新訂單': '#fde68a', '製作中': '#fed7aa', '可取餐': '#bbf7d0', '已出貨': '#bfdbfe', '已完成': '#e5e7eb', '已取消': '#fecaca' };
  o.setConditionalFormatRules(Object.keys(colors).map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s).setBackground(colors[s]).setRanges([o.getRange(2, 1, 1000, ORDER_HEADERS.length)]).build();
  }).map(function (r) { return r; }));
  o.setColumnWidth(COL.SUMMARY, 320); o.setColumnWidth(COL.ADDR, 220); o.setColumnWidth(COL.NOTE, 180);
  o.hideColumns(COL.TOKEN);
  o.getRange(2, COL.PHONE, 1000, 1).setNumberFormat('@');

  // 觸發器：狀態通知、每日摘要
  var triggers = ScriptApp.getProjectTriggers();
  var has = function (fn) { return triggers.some(function (t) { return t.getHandlerFunction() === fn; }); };
  if (!has('onStatusEdit')) ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
  if (CONFIG.NOTIFY_EMAILS && !has('dailySummary')) ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(CONFIG.DAILY_SUMMARY_HOUR).inTimezone(CONFIG.TZ).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('初始化完成！接著請部署為網頁應用程式（見 README）。', CONFIG.STORE_NAME, 8);
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#3B271C').setFontColor('#F8F2E7');
    sh.setFrozenRows(1);
  }
  return sh;
}

function resetProducts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = ensureSheet_(ss, SHEETS.PRODUCTS, PRODUCT_HEADERS);
  if (p.getLastRow() > 1) p.getRange(2, 1, p.getLastRow() - 1, PRODUCT_HEADERS.length).clearContent();
  p.getRange(2, 1, SEED_PRODUCTS.length, PRODUCT_HEADERS.length).setValues(SEED_PRODUCTS);
  p.getRange(2, 6, SEED_PRODUCTS.length, 1).insertCheckboxes();
  p.autoResizeColumns(1, PRODUCT_HEADERS.length);
}
