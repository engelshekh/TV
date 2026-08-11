/*************************************************************
 *  لوحة مؤشرات الأداء — ريتش لاند
 *  الواجهة الخلفية (Google Apps Script)
 *
 *  الملف ده هو "الحارس": هو اللي بيتحقق من المستخدم وصلاحياته
 *  وبيرفض أي كتابة غير مصرّح بيها — عشان محدش يتخطى الصلاحيات من المتصفح.
 *
 *  العمليات المدعومة (POST → body.action):
 *    login      : تسجيل دخول حقيقي على السيرفر (بيتحقق من بصمة كلمة المرور) ويرجّع توكن.
 *    save       : حفظ المؤشرات + الميتا + السجل (الافتراضي لو مفيش action — توافق مع النسخ القديمة).
 *    updateName : تعديل اسم مؤشر (الـ id مابيتغيرش أبدًا).
 *    setBadge   : إظهار/إخفاء وسام الأداء لمؤشر.
 *    users      : حفظ الحسابات والصلاحيات (أدمن فقط).
 *  ملحوظة: تبويب Meta بيحتفظ كمان بـ safeConfig (عدّاد أيام بدون حوادث) و lastEditAt.
 *  مع كل حفظ أو تعديل اسم، السكريبت بيحدّث المفتاح lastEditAt في تبويب Meta،
 *  واللوحة بتستخدمه في عرض "آخر تحديث" فوق على الشاشة.
 *
 *    clear      : مسح بيانات المؤشرات والسجلات (أدمن فقط) — مع الإبقاء على
 *                 الحسابات والصلاحيات والإعدادات و History وسجل التغييرات.
 *  و GET (أو action=load) بيرجّع كل البيانات للعرض — العرض مفتوح للجميع.
 *
 *  الأمان: الدور (أدمن / صلاحيات الجداول) بيتقرا من تبويب Users في الشيت،
 *  ومابيتاخدش أبدًا من المتصفح. أي كتابة لازم يكون معاها توكن صالح صادر من دالة login.
 *
 *  خطوات التشغيل:
 *   1) افتح جوجل شيت جديد → Extensions → Apps Script → الصق الملف ده كله.
 *   2) غيّر WRITE_KEY تحت لقيمة طويلة عشوائية، وحطّ نفس القيمة في اللوحة من
 *      "ربط جوجل شيت" (بتتخزن على الجهاز، ومابتترفعش على GitHub).
 *   3) من قائمة الدوال اختار setup ثم Run (مرة واحدة بس) — هيعمل كل التبويبات
 *      والصفوف الافتراضية لوحده.
 *   4) setupTriggers مرة واحدة — للتجميع اليومي التلقائي.
 *   5) Deploy → New deployment → Web app:
 *        Execute as: Me      |      Who has access: Anyone
 *      وانسخ رابط /exec وحطّه في اللوحة من "ربط جوجل شيت".
 *************************************************************/

var WRITE_KEY = 'RL-YJ09Z-9C8X2-J9N3E-UPQIP';   // نفس القيمة في اللوحة (بتتحفظ على الجهاز مش في الكود)
var TOKEN_TTL_MIN = 720;                         // مدة صلاحية التوكن بالدقايق (12 ساعة)

var SH_DATA  = 'Data';      // القيم الحالية المعروضة على الشاشة
var SH_META  = 'Meta';      // التاريخ / الوردية / الرسالة
var SH_USERS = 'Users';     // الحسابات والصلاحيات
var SH_LOG   = 'Log';       // سجل كل يوم × وردية (صف مستقل لكل وردية)
var SH_HIST  = 'History';   // نقاط الرسوم البيانية (يوم واحد لكل صف)
var SH_AUDIT = 'Audit';     // مين غيّر إيه وإمتى
var SH_DAY   = 'Daily';     // ملخص كل يوم (الورديات مجمّعة) — أساس الرسوم
var SH_MON   = 'Monthly';   // ملخص كل شهر — أساس المقارنات الشهرية والربع سنوية والسنوية

/* خريطة المؤشرات: id → [الكارت اللي بيخصه, الاسم] — الصلاحية بتتحدد على مستوى الكارت */
var METRIC_MAP = {
  w1:['warehouse','عدد الحاويات المشحونة'], w2:['warehouse','عدد أوامر التحميل المنفذة'], w3:['warehouse','الشحن في الموعد (% OTIF)'],
  s1:['safety','عدد الحوادث الوشيكة'], s2:['safety','مخاطر السلامة المفتوحة'],
  q1:['quality','عدد حالات الـ Hold'], q2:['quality','مخالفات الفود سيفتي'], q3:['quality','GMP Score (%)'],
  p1:['production','إجمالي الإنتاج (كجم)'], p2:['production','الكفاءة الإنتاجية (%)'],
  p3:['production','Product Waste (%)'], p4:['production','Film Waste (%)'], p5:['production','Rework (%)'],
  l4_1:['line4','الإنتاج (كجم)'], l4_2:['line4','الكفاءة (%)'], l4_3:['line4','Product Waste (%)'], l4_4:['line4','Downtime (د)'],
  l3_1:['line3','الإنتاج (كجم)'], l3_2:['line3','الكفاءة (%)'], l3_3:['line3','Product Waste (%)'], l3_4:['line3','Downtime (د)'],
  l2_1:['line2','الإنتاج (كجم)'], l2_2:['line2','الكفاءة (%)'], l2_3:['line2','Product Waste (%)'], l2_4:['line2','Downtime (د)'],
  l1_1:['line1','الإنتاج (كجم)'], l1_2:['line1','الكفاءة (%)'], l1_3:['line1','Film Waste (%)'], l1_4:['line1','Downtime (د)']
};

/* عمود badge اتضاف في نسخة 2 — 'show' أو 'hide'. الأعمدة القديمة زي ما هي،
   والسكريبت بيضيف أي عمود ناقص لوحده عشان الشيتات القديمة تفضل شغالة. */
var DATA_HEAD  = ['id','card','name','target','actual','eff','pctGood','pctWarn','planSign','actualSign','override','dir','badge'];
var USERS_HEAD = ['u','name','salt','hash','hashAlt','admin','active','mustChange','perms','created','lastLogin'];
var LOG_HEAD   = ['date','shift','id','target','actual','eff','user','savedAt'];
var HIST_HEAD  = ['date','containers','efficiency','waste','rework'];
var AUDIT_HEAD = ['at','user','card','metric','field','from','to','date','shift'];
var DAY_HEAD   = ['date','id','card','name','target','actual','eff','status','shifts'];
var MON_HEAD   = ['month','id','card','name','avgTarget','avgActual','total','best','worst','daysLogged','compliancePct','trend'];

/* طريقة تجميع الورديات في اليوم الواحد:
   'sum' = المجموع (كميات ودقايق)، 'avg' = المتوسط (نِسَب) */
var AGG = {
  w1:'sum', w2:'sum', w3:'avg', s1:'sum', s2:'sum', q1:'sum', q2:'sum', q3:'avg',
  p1:'sum', p2:'avg', p3:'avg', p4:'avg', p5:'avg',
  l4_1:'sum', l4_2:'avg', l4_3:'avg', l4_4:'sum',
  l3_1:'sum', l3_2:'avg', l3_3:'avg', l3_4:'sum',
  l2_1:'sum', l2_2:'avg', l2_3:'avg', l2_4:'sum',
  l1_1:'sum', l1_2:'avg', l1_3:'avg', l1_4:'sum'
};
/* اتجاه المؤشر: 'up' الأعلى أحسن، 'down' الأقل أحسن — لحساب نسبة الالتزام */
var DIRS = {
  w1:'up', w2:'up', w3:'up', s1:'down', s2:'down', q1:'down', q2:'down', q3:'up',
  p1:'up', p2:'up', p3:'down', p4:'down', p5:'down',
  l4_1:'up', l4_2:'up', l4_3:'down', l4_4:'down',
  l3_1:'up', l3_2:'up', l3_3:'down', l3_4:'down',
  l2_1:'up', l2_2:'up', l2_3:'down', l2_4:'down',
  l1_1:'up', l1_2:'up', l1_3:'down', l1_4:'down'
};

/* ---------------------------------------------------------- */
/*  إعداد أول مرة                                              */
/* ---------------------------------------------------------- */
function setup(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SH_DATA,  DATA_HEAD);
  ensureSheet_(ss, SH_META,  ['key','value']);
  ensureSheet_(ss, SH_USERS, USERS_HEAD);
  ensureSheet_(ss, SH_LOG,   LOG_HEAD);
  ensureSheet_(ss, SH_HIST,  HIST_HEAD);
  ensureSheet_(ss, SH_AUDIT, AUDIT_HEAD);
  ensureSheet_(ss, SH_DAY,   DAY_HEAD);
  ensureSheet_(ss, SH_MON,   MON_HEAD);

  var data = ss.getSheetByName(SH_DATA);
  if(data.getLastRow() < 2){
    var rows = [];
    for(var id in METRIC_MAP){
      rows.push([id, METRIC_MAP[id][0], METRIC_MAP[id][1], '', '', '', 5, 15, '', '', 'auto', '', 'show']);
    }
    data.getRange(2, 1, rows.length, DATA_HEAD.length).setValues(rows);
  }
  var meta = ss.getSheetByName(SH_META);
  if(meta.getLastRow() < 2){
    meta.getRange(2, 1, 4, 2).setValues([
      ['date', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')],
      ['shift', 'الصباحية'],
      ['dayName', ''],
      ['tagline', 'الجودة - السلامة - الكفاءة - الالتزام ... نحو أداء أفضل كل يوم']
    ]);
    meta.appendRow(['shiftConfig', '{"morning":"07:00","evening":"15:00","night":"23:00","auto":true}']);
  }
  SpreadsheetApp.getUi && null;   // مش محتاجين UI — الدالة تنفع تتنفذ من المحرر
  return 'تم الإعداد بنجاح';
}

function ensureSheet_(ss, name, head){
  var sh = ss.getSheetByName(name);
  if(!sh) sh = ss.insertSheet(name);
  if(sh.getLastRow() === 0 || String(sh.getRange(1,1).getValue()).trim() === ''){
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  /* توافق للخلف: أي عمود جديد في الكود ومش موجود في الشيت بيتضاف في الآخر،
     والأعمدة القديمة مابتتلمسش ولا بتتعاد ترتيبها ولا بتتمسح. */
  var lastCol = Math.max(1, sh.getLastColumn());
  var cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h).trim(); });
  var missing = head.filter(function(h){ return cur.indexOf(h) === -1; });
  if(missing.length){
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sh;
}

/* ---------------------------------------------------------- */
/*  قراءة (العرض مفتوح للكل — مفيش تسجيل دخول للعرض)           */
/* ---------------------------------------------------------- */
function doGet(e){
  try{
    return loadAll_();
  }catch(err){
    return json_({ ok:false, error:String(err) });
  }
}
function loadAll_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = { metrics: [], meta: {}, users: [], history: [] };

  var data = readTable_(ss, SH_DATA);
  for(var i = 0; i < data.length; i++){
    var r = data[i];
    if(!r.id) continue;
    out.metrics.push({
      id: String(r.id), name: str_(r.name), target: str_(r.target), actual: str_(r.actual), eff: str_(r.eff),
      pctGood: str_(r.pctGood), pctWarn: str_(r.pctWarn),
      planSign: str_(r.planSign), actualSign: str_(r.actualSign),
      override: str_(r.override) || 'auto', dir: str_(r.dir),
      badge: (str_(r.badge).toLowerCase() === 'hide') ? 'hide' : 'show'   // الافتراضي: الوسام ظاهر
    });
  }

  var meta = readTable_(ss, SH_META);
  for(var j = 0; j < meta.length; j++){
    if(meta[j].key) out.meta[String(meta[j].key)] = str_(meta[j].value);
  }
  if(out.meta.date) out.meta.date = fmtDate_(out.meta.date);
  if(out.meta.tagline){ out.tagline = out.meta.tagline; }
  /* scoreConfig بيرجع كنص JSON واللوحة بتفكّه لوحدها */

  /* الحسابات: البصمة بتتبعت (مش كلمة المرور) عشان نفس الحسابات تشتغل على كل الأجهزة */
  var us = readTable_(ss, SH_USERS);
  for(var k = 0; k < us.length; k++){
    if(!us[k].u) continue;
    out.users.push({
      u: String(us[k].u), name: str_(us[k].name), salt: str_(us[k].salt), hash: str_(us[k].hash),
      hashAlt: str_(us[k].hashAlt),
      admin: truthy_(us[k].admin), active: us[k].active === '' ? true : truthy_(us[k].active),
      mustChange: truthy_(us[k].mustChange), perms: parseJson_(us[k].perms, {}),
      created: str_(us[k].created), lastLogin: str_(us[k].lastLogin), failed: 0, lockUntil: 0
    });
  }

  var hist = readTable_(ss, SH_HIST);
  for(var h = 0; h < hist.length; h++){
    if(!hist[h].date) continue;
    out.history.push({
      date: fmtDate_(hist[h].date), containers: str_(hist[h].containers),
      efficiency: str_(hist[h].efficiency), waste: str_(hist[h].waste), rework: str_(hist[h].rework)
    });
  }

  /* الملخص الشهري — أساس شاشات الإحصائيات (شهري / ربع سنوي / سنوي) */
  var mon = readTable_(ss, SH_MON);
  out.monthly = mon.map(function(r){
    return { month:String(r.month), id:String(r.id), card:str_(r.card),
             avgActual:str_(r.avgActual), avgTarget:str_(r.avgTarget), total:str_(r.total),
             days:str_(r.daysLogged), compliance:str_(r.compliancePct), trend:str_(r.trend) };
  });

  out.stamp = new Date().toISOString();
  return json_(out);
}

/* ---------------------------------------------------------- */
/*  كتابة (لازم مفتاح صحيح + مستخدم مفعّل + صلاحية على الكارت)   */
/* ---------------------------------------------------------- */
function doPost(e){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }catch(err){ return json_({ ok:false, error:'busy' }); }

  try{
    var body = {};
    try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch(parseErr){ return json_({ ok:false, error:'bad_json' }); }

    var action = String(body.action || 'save');
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    /* القراءة مفتوحة للجميع — العرض مش محتاج دخول */
    if(action === 'load') return loadAll_();

    /* تسجيل الدخول: بنتحقق من بصمة كلمة المرور المخزّنة في تبويب Users */
    if(action === 'login') return doLoginAction_(ss, body);

    /* أي عملية كتابة: لازم مفتاح صحيح + هوية متحقق منها على السيرفر */
    if(String(body.key || (body.auth && body.auth.key)) !== WRITE_KEY){
      return json_({ ok:false, error:'bad_key' });
    }
    var me = authenticate_(ss, body.auth || {});
    if(!me.ok) return json_({ ok:false, error: me.error });

    if(action === 'updateName') return updateNameAction_(ss, body, me);
    if(action === 'setBadge')   return setBadgeAction_(ss, body, me);
    if(action === 'clear')      return clearAction_(ss, body, me);
    if(action === 'users'){
      if(!me.admin) return json_({ ok:false, error:'users_admin_only' });
      writeUsers_(ss, body.users || []);
      logAudit_(ss, me, [{ metric:'المستخدمون', field:'تحديث', from:'', to:(body.users || []).length + ' مستخدم' }]);
      return json_({ ok:true, at:new Date().toISOString() });
    }
    return saveAction_(ss, body, me);      // الافتراضي: حفظ (توافق مع النسخ القديمة)

  }catch(err){
    return json_({ ok:false, error: String(err) });
  }finally{
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------- */
/*  المصادقة: التوكن بيتصدر من السيرفر بعد التحقق من كلمة المرور */
/*  الدور (أدمن/صلاحيات) بيتقرا من الشيت، مش من المتصفح.        */
/* ---------------------------------------------------------- */
function doLoginAction_(ss, body){
  var name = String(body.user || '').trim();
  var pass = String(body.pass || '');
  if(!name || !pass) return json_({ ok:false, error:'missing' });

  var u = findUser_(ss, name);
  if(!u)          return json_({ ok:false, error:'no_user' });
  if(!u.active)   return json_({ ok:false, error:'disabled' });
  if(!u.hash)     return json_({ ok:false, error:'no_hash' });
  if(!verifyPassword_(pass, u.salt, u.hash) && !(u.hashAlt && verifyPassword_(pass, u.salt, u.hashAlt))){
    return json_({ ok:false, error:'bad_pass' });
  }

  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  var props = PropertiesService.getScriptProperties();
  props.setProperty('tok_' + token, JSON.stringify({
    u: u.u, exp: Date.now() + TOKEN_TTL_MIN * 60000
  }));
  cleanupTokens_(props);
  touchLastLogin_(ss, u.u);

  return json_({ ok:true, token: token, user: u.u, name: u.name,
                 admin: u.admin, perms: u.perms, ttlMinutes: TOKEN_TTL_MIN });
}

/* بترجّع { ok, u, name, admin, perms } — أو سبب الرفض */
function authenticate_(ss, auth){
  var props = PropertiesService.getScriptProperties();
  var token = String(auth.token || '');
  var uname = '';

  if(token){
    var raw = props.getProperty('tok_' + token);
    if(raw){
      var t = {};
      try{ t = JSON.parse(raw); }catch(e){ t = {}; }
      if(t.exp && t.exp > Date.now()) uname = t.u;
      else props.deleteProperty('tok_' + token);
    }
  }

  /* حالة التجهيز الأولى: تبويب Users لسه فاضي — نسمح بالكتابة بالمفتاح وحده
     مرة واحدة عشان الأدمن يقدر يرفع الحسابات لأول مرة، وبعدها التوكن يبقى إجباري. */
  if(!uname){
    if(!readTable_(ss, SH_USERS).length){
      return { ok:true, u: String(auth.user || 'setup'), name:'إعداد أولي', admin:true, perms:{}, bootstrap:true };
    }
    return { ok:false, error:'no_token' };
  }

  var u = findUser_(ss, uname);
  if(!u || !u.active) return { ok:false, error:'no_user' };
  return { ok:true, u:u.u, name:u.name, admin:u.admin, perms:u.perms || {} };
}

function cleanupTokens_(props){
  var all = props.getProperties(), now = Date.now(), n = 0;
  for(var k in all){
    if(k.indexOf('tok_') !== 0) continue;
    try{
      var t = JSON.parse(all[k]);
      if(!t.exp || t.exp < now){ props.deleteProperty(k); n++; }
    }catch(e){ props.deleteProperty(k); }
  }
  return n;
}

/* نفس خوارزميتَي البصمة المستخدمتين في اللوحة: SHA-256 (الأساسية) و FNV (بديل file://) */
function verifyPassword_(pass, salt, stored){
  var txt = String(salt || '') + '::' + String(pass);
  if(String(stored).indexOf('sha256:') === 0){
    return ('sha256:' + sha256Hex_(txt)) === String(stored);
  }
  if(String(stored).indexOf('fnv:') === 0){
    return ('fnv:' + fnv_(txt) + fnv_(txt.split('').reverse().join(''))) === String(stored);
  }
  return false;
}
function sha256Hex_(txt){
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txt, Utilities.Charset.UTF_8);
  var out = '';
  for(var i = 0; i < bytes.length; i++){
    var b = (bytes[i] < 0 ? bytes[i] + 256 : bytes[i]).toString(16);
    out += (b.length === 1 ? '0' : '') + b;
  }
  return out;
}
function fnv_(str){
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for(var i = 0; i < str.length; i++){
    h1 = (h1 ^ str.charCodeAt(i)) >>> 0; h1 = imul_(h1, 16777619) >>> 0;
    h2 = imul_((h2 ^ str.charCodeAt(i)) >>> 0, 2246822519) >>> 0;
  }
  return pad8_((h1 >>> 0).toString(16)) + pad8_((h2 >>> 0).toString(16));
}
function imul_(a, b){
  var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
  return ((al * bl) + ((((ah * bl) + (al * bh)) << 16) >>> 0)) | 0;
}
function pad8_(x){ while(x.length < 8) x = '0' + x; return x; }

function touchLastLogin_(ss, uname){
  var sh = ss.getSheetByName(SH_USERS);
  if(!sh || sh.getLastRow() < 2) return;
  var vals = sh.getDataRange().getValues();
  var head = vals[0].map(function(h){ return String(h).trim(); });
  var cu = head.indexOf('u'), cl = head.indexOf('lastLogin');
  if(cu === -1 || cl === -1) return;
  for(var r = 1; r < vals.length; r++){
    if(String(vals[r][cu]).trim().toLowerCase() === String(uname).trim().toLowerCase()){
      sh.getRange(r + 1, cl + 1).setValue(new Date().toISOString());
      return;
    }
  }
}

/* ---------------------------------------------------------- */
/*  حفظ المؤشرات والميتا والسجل                                */
/* ---------------------------------------------------------- */
function saveAction_(ss, body, me){
  var rejected = [];

  if(Array.isArray(body.metrics) && body.metrics.length){
    var sh = ensureSheet_(ss, SH_DATA, DATA_HEAD);
    var vals = sh.getDataRange().getValues();
    var head = vals[0].map(function(h){ return String(h).trim(); });
    var col = {}; for(var c = 0; c < head.length; c++) col[head[c]] = c;
    var rowOf = {}; for(var r = 1; r < vals.length; r++) rowOf[String(vals[r][col.id])] = r;

    body.metrics.forEach(function(m){
      var id = String(m.id || '');
      var map = METRIC_MAP[id];
      if(!map){ rejected.push(id + ':unknown'); return; }
      var card = map[0];
      if(!me.admin && !me.perms[card]){ rejected.push(id + ':no_perm'); return; }   // ← الرفض الحقيقي

      var row = rowOf[id];
      if(row === undefined){                       // مؤشر جديد — نضيف صف له
        var blank = [];
        for(var k = 0; k < head.length; k++) blank.push('');
        blank[col.id] = id; blank[col.card] = card; blank[col.name] = map[1];
        if(col.override !== undefined) blank[col.override] = 'auto';
        if(col.badge !== undefined) blank[col.badge] = 'show';
        vals.push(blank);
        row = vals.length - 1;
        rowOf[id] = row;
      }
      setCell_(vals, col, row, 'target', m.target);
      setCell_(vals, col, row, 'actual', m.actual);
      setCell_(vals, col, row, 'eff', m.eff);
      setCell_(vals, col, row, 'planSign', m.planSign);
      setCell_(vals, col, row, 'actualSign', m.actualSign);
      setCell_(vals, col, row, 'override', m.override);
      /* الاسم بيتحفظ من هنا كمان عشان تعديل الاسم يوصل مع أي حفظ عادي */
      if(m.name !== undefined && str_(m.name) !== '') setCell_(vals, col, row, 'name', str_(m.name));
      /* نِسَب الحالة ووسام الأداء = أدمن فقط (بيأثروا على كل الناس) */
      if(me.admin){
        setCell_(vals, col, row, 'pctGood', m.pctGood);
        setCell_(vals, col, row, 'pctWarn', m.pctWarn);
        if(m.badge !== undefined) setCell_(vals, col, row, 'badge', m.badge === 'hide' ? 'hide' : 'show');
      }
      vals[row][col.card] = card;
    });
    sh.getRange(1, 1, vals.length, head.length).setValues(vals);

    /* سجل الوردية: كل (تاريخ + وردية + مؤشر) بيتحدّث في صفه، ومايستبدلش ورديات تانية */
    if(body.meta && body.meta.date){
      writeShiftLog_(ss, body.meta, body.metrics, me.u, me.admin, me.perms);
    }
    /* وقت آخر تعديل فعلي للمؤشرات — اللوحة بتقراه وبتكتب بيه "آخر تحديث" فوق،
       عشان كل الشاشات (حتى شاشة العرض اللي مابتعدّلش) تشوف نفس الوقت. */
    setMeta_(ensureSheet_(ss, SH_META, ['key','value']), 'lastEditAt', new Date().toISOString());
  }

  if(body.meta){
    var mSh = ensureSheet_(ss, SH_META, ['key','value']);
    setMeta_(mSh, 'date', fmtDate_(body.meta.date));
    setMeta_(mSh, 'shift', body.meta.shift);
    setMeta_(mSh, 'dayName', body.meta.dayName);
    if(body.tagline !== undefined && me.admin) setMeta_(mSh, 'tagline', body.tagline);
    if(body.scoreConfig && me.admin) setMeta_(mSh, 'scoreConfig', JSON.stringify(body.scoreConfig));
    if(body.shiftConfig && me.admin) setMeta_(mSh, 'shiftConfig', JSON.stringify(body.shiftConfig));
    /* عدّاد "أيام بدون حوادث": { base, anchor }.
       الأدمن هو اللي يعدّله، لكن التصفير التلقائي بسبب حادثة (base = 0) مسموح لأي
       مستخدم عنده صلاحية على جدول السلامة — عشان الحادثة تتسجّل فورًا من غير انتظار. */
    if(body.safeConfig && typeof body.safeConfig === 'object'){
      var sc = body.safeConfig;
      var isReset = (Number(sc.base) === 0);
      if(me.admin || (isReset && me.perms && me.perms.safety)){
        setMeta_(mSh, 'safeConfig', JSON.stringify({ base: Number(sc.base) || 0, anchor: str_(sc.anchor) }));
      }
    }
  }

  if(body.historyPoint && body.meta && body.meta.date){
    upsertHistory_(ss, fmtDate_(body.meta.date), body.historyPoint);
  }

  if(Array.isArray(body.users)){
    if(!me.admin) return json_({ ok:false, error:'users_admin_only' });
    writeUsers_(ss, body.users);
  }

  if(Array.isArray(body.audit) && body.audit.length) logAudit_(ss, me, body.audit);

  return json_({ ok:true, rejected: rejected, at: new Date().toISOString() });
}

/* ---------------------------------------------------------- */
/*  تعديل اسم مؤشر — الـ id مابيتغيرش أبدًا                      */
/* ---------------------------------------------------------- */
function updateNameAction_(ss, body, me){
  var items = Array.isArray(body.names) ? body.names
            : (body.id ? [{ id: body.id, name: body.name }] : []);
  if(!items.length) return json_({ ok:false, error:'missing' });

  var sh = ensureSheet_(ss, SH_DATA, DATA_HEAD);
  var vals = sh.getDataRange().getValues();
  var head = vals[0].map(function(h){ return String(h).trim(); });
  var col = {}; for(var c = 0; c < head.length; c++) col[head[c]] = c;
  if(col.name === undefined) return json_({ ok:false, error:'no_name_column' });

  var rowOf = {}; for(var r = 1; r < vals.length; r++) rowOf[String(vals[r][col.id])] = r;
  var done = [], rejected = [], entries = [];

  items.forEach(function(it){
    var id = String(it.id || '');
    var map = METRIC_MAP[id];
    if(!map || rowOf[id] === undefined){ rejected.push(id + ':unknown'); return; }
    if(!me.admin && !me.perms[map[0]]){ rejected.push(id + ':no_perm'); return; }
    var nm = str_(it.name);
    if(!nm){ rejected.push(id + ':empty'); return; }
    if(nm.length > 80) nm = nm.slice(0, 80);
    var old = str_(vals[rowOf[id]][col.name]);
    if(old === nm) return;
    vals[rowOf[id]][col.name] = nm;
    done.push(id);
    entries.push({ card: map[0], metric: old || id, field: 'اسم المؤشر', from: old, to: nm });
  });

  if(done.length){
    sh.getRange(1, 1, vals.length, head.length).setValues(vals);
    logAudit_(ss, me, entries);
    setMeta_(ensureSheet_(ss, SH_META, ['key','value']), 'lastEditAt', new Date().toISOString());
  }
  return json_({ ok:true, updated: done, rejected: rejected });
}

/* ---------------------------------------------------------- */
/*  إظهار/إخفاء وسام الأداء لمؤشر — أدمن فقط                    */
/* ---------------------------------------------------------- */
function setBadgeAction_(ss, body, me){
  if(!me.admin) return json_({ ok:false, error:'badge_admin_only' });
  var items = Array.isArray(body.badges) ? body.badges
            : (body.id ? [{ id: body.id, badge: body.badge }] : []);
  if(!items.length) return json_({ ok:false, error:'missing' });

  var sh = ensureSheet_(ss, SH_DATA, DATA_HEAD);
  var vals = sh.getDataRange().getValues();
  var head = vals[0].map(function(h){ return String(h).trim(); });
  var col = {}; for(var c = 0; c < head.length; c++) col[head[c]] = c;
  if(col.badge === undefined) return json_({ ok:false, error:'no_badge_column' });

  var rowOf = {}; for(var r = 1; r < vals.length; r++) rowOf[String(vals[r][col.id])] = r;
  var done = [], entries = [];
  items.forEach(function(it){
    var id = String(it.id || '');
    if(rowOf[id] === undefined || !METRIC_MAP[id]) return;
    var v = (String(it.badge) === 'hide') ? 'hide' : 'show';
    var old = str_(vals[rowOf[id]][col.badge]) || 'show';
    if(old === v) return;
    vals[rowOf[id]][col.badge] = v;
    done.push(id);
    entries.push({ card: METRIC_MAP[id][0], metric: METRIC_MAP[id][1], field: 'وسام الأداء',
                   from: old === 'hide' ? 'مخفي' : 'ظاهر', to: v === 'hide' ? 'مخفي' : 'ظاهر' });
  });
  if(done.length){
    sh.getRange(1, 1, vals.length, head.length).setValues(vals);
    logAudit_(ss, me, entries);
  }
  return json_({ ok:true, updated: done });
}

/* ---------------------------------------------------------- */
/*  مسح كل البيانات — أدمن فقط                                  */
/*  بيمسح: قيم المؤشرات + Log + Daily + Monthly (واختياريًا      */
/*  History). وبيحافظ على: Users والصلاحيات وMeta والإعدادات     */
/*  وأسماء المؤشرات وحدود الحالة ووسام الأداء وسجل التغييرات.    */
/* ---------------------------------------------------------- */
function clearAction_(ss, body, me){
  if(!me.admin) return json_({ ok:false, error:'clear_admin_only' });
  if(String(body.confirm) !== 'CLEAR-ALL-DATA') return json_({ ok:false, error:'need_confirm' });

  var cleared = [];

  /* 1) قيم المؤشرات: بنفضّي الفعلي والمستهدف والكفاءة بس */
  var sh = ensureSheet_(ss, SH_DATA, DATA_HEAD);
  if(sh.getLastRow() > 1){
    var vals = sh.getDataRange().getValues();
    var head = vals[0].map(function(h){ return String(h).trim(); });
    var col = {}; for(var c = 0; c < head.length; c++) col[head[c]] = c;
    ['target','actual','eff'].forEach(function(f){
      if(col[f] === undefined) return;
      for(var r = 1; r < vals.length; r++) vals[r][col[f]] = '';
    });
    sh.getRange(1, 1, vals.length, head.length).setValues(vals);
    cleared.push('Data');
  }

  /* 2) السجلات والملخصات */
  [[SH_LOG, LOG_HEAD], [SH_DAY, DAY_HEAD], [SH_MON, MON_HEAD]].forEach(function(pair){
    var t = ensureSheet_(ss, pair[0], pair[1]);
    if(t.getLastRow() > 1){
      t.deleteRows(2, t.getLastRow() - 1);      // بنشيل الصفوف نفسها مش المحتوى بس
      cleared.push(pair[0]);
    }
  });

  /* 3) History: مابتتمسحش إلا لو المستخدم طلبها صراحة */
  if(body.includeHistory === true){
    var h = ensureSheet_(ss, SH_HIST, HIST_HEAD);
    if(h.getLastRow() > 1){
      h.deleteRows(2, h.getLastRow() - 1);
      cleared.push('History');
    }
  }

  logAudit_(ss, me, [{
    card:'—', metric:'كل البيانات', field:'مسح شامل',
    from: cleared.join(' + ') || 'لا شيء',
    to: body.includeHistory === true ? 'اتمسحت (ومعاها History)' : 'اتمسحت (History محفوظة)'
  }]);

  return json_({ ok:true, cleared: cleared, at: new Date().toISOString() });
}

/* سجل التغييرات — اسم المستخدم بيتاخد من السيرفر مش من المتصفح */
function logAudit_(ss, me, entries){
  if(!entries || !entries.length) return;
  var aSh = ensureSheet_(ss, SH_AUDIT, AUDIT_HEAD);
  var now = new Date().toISOString();
  var rows = entries.map(function(a){
    return [ a.at || a.t || now, me.name || me.u, a.card || '', a.metric || '',
             a.field || '', str_(a.from), str_(a.to), a.date || '', a.shift || '' ];
  });
  aSh.getRange(aSh.getLastRow() + 1, 1, rows.length, AUDIT_HEAD.length).setValues(rows);
}

/* ---------------------------------------------------------- */
/*  التجميع: من Log الخام → Daily → Monthly                     */
/*  شغّل rebuildSummaries يدويًا، أو setupTriggers مرة واحدة     */
/*  عشان تشتغل لوحدها كل يوم الساعة ١ بالليل.                   */
/* ---------------------------------------------------------- */
function setupTriggers(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction() === 'rebuildSummaries') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rebuildSummaries').timeBased().everyDays(1).atHour(1).create();
  return 'تم تفعيل التجميع التلقائي كل يوم الساعة 1 صباحًا';
}

function rebuildSummaries(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = readTable_(ss, SH_LOG);
  if(!log.length) return 'مفيش بيانات في Log';

  /* حدود الحالة الحالية لكل مؤشر (لحساب نسبة الالتزام) */
  var pct = {};
  readTable_(ss, SH_DATA).forEach(function(r){
    if(!r.id) return;
    var g = parseFloat(r.pctGood);
    pct[String(r.id)] = isNaN(g) ? 5 : g;
  });

  /* ---- Daily: تجميع ورديات اليوم الواحد ---- */
  var day = {};
  log.forEach(function(r){
    var id = String(r.id || ''); if(!METRIC_MAP[id]) return;
    var date = fmtDate_(r.date); if(!date) return;
    var a = num_(r.actual), t = num_(r.target);
    if(a === null) return;
    var k = date + '|' + id;
    if(!day[k]) day[k] = { date:date, id:id, a:[], t:[], eff:[], shifts:0 };
    day[k].a.push(a);
    if(t !== null) day[k].t.push(t);
    var e = num_(r.eff); if(e !== null) day[k].eff.push(e);
    day[k].shifts++;
  });

  var dayRows = [], dayIdx = {};
  Object.keys(day).sort().forEach(function(k){
    var d = day[k];
    var agg = AGG[d.id] === 'sum' ? 'sum' : 'avg';
    var actual = agg === 'sum' ? sum_(d.a) : avg_(d.a);
    var target = d.t.length ? (agg === 'sum' ? sum_(d.t) : avg_(d.t)) : '';
    var eff    = d.eff.length ? round_(avg_(d.eff), 1) : '';
    var st     = statusOf_(d.id, target, actual, pct[d.id]);
    dayRows.push([d.date, d.id, METRIC_MAP[d.id][0], METRIC_MAP[d.id][1],
                  target === '' ? '' : round_(target, 2), round_(actual, 2), eff, st, d.shifts]);
    if(!dayIdx[d.id]) dayIdx[d.id] = [];
    dayIdx[d.id].push({ date:d.date, a:actual, t:target, st:st });
  });
  writeTable_(ss, SH_DAY, DAY_HEAD, dayRows);

  /* ---- Monthly: تجميع أيام الشهر ---- */
  var mon = {};
  dayRows.forEach(function(r){
    var month = String(r[0]).slice(0, 7), id = r[1];
    var k = month + '|' + id;
    if(!mon[k]) mon[k] = { month:month, id:id, a:[], t:[], ok:0, n:0 };
    mon[k].a.push(Number(r[5]));
    if(r[4] !== '') mon[k].t.push(Number(r[4]));
    mon[k].n++;
    if(r[7] === 'ضمن المستهدف') mon[k].ok++;
  });

  var monRows = [];
  Object.keys(mon).sort().forEach(function(k){
    var m = mon[k];
    var up = DIRS[m.id] !== 'down';
    var best  = up ? Math.max.apply(null, m.a) : Math.min.apply(null, m.a);
    var worst = up ? Math.min.apply(null, m.a) : Math.max.apply(null, m.a);
    monRows.push([
      m.month, m.id, METRIC_MAP[m.id][0], METRIC_MAP[m.id][1],
      m.t.length ? round_(avg_(m.t), 2) : '',
      round_(avg_(m.a), 2),
      round_(sum_(m.a), 2),
      round_(best, 2), round_(worst, 2),
      m.n, Math.round((m.ok / m.n) * 100),
      trend_(m.a, up)
    ]);
  });
  writeTable_(ss, SH_MON, MON_HEAD, monRows);

  return 'تم: ' + dayRows.length + ' صف يومي و ' + monRows.length + ' صف شهري';
}

/* حالة القراءة بنسبة الانحراف عن المستهدف — نفس منطق اللوحة بالظبط */
function statusOf_(id, target, actual, pctGood){
  if(target === '' || target === null || actual === null) return '';
  var dir = DIRS[id] === 'down' ? 'down' : 'up';
  var diff = dir === 'down' ? (actual - target) : (target - actual);
  var dev;
  if(target === 0) dev = diff === 0 ? 0 : (diff > 0 ? 999 : -999);
  else dev = (diff / Math.abs(target)) * 100;
  return dev <= (pctGood === undefined ? 5 : pctGood) ? 'ضمن المستهدف' : 'خارج المستهدف';
}
/* اتجاه بسيط: مقارنة متوسط النص الأول بالنص التاني من الشهر */
function trend_(arr, up){
  if(arr.length < 4) return '—';
  var h = Math.floor(arr.length / 2);
  var a = avg_(arr.slice(0, h)), b = avg_(arr.slice(h));
  var diff = b - a;
  if(Math.abs(diff) < Math.abs(a) * 0.01) return 'ثابت';
  return (diff > 0) === up ? 'يتحسّن' : 'يسوء';
}
function num_(v){
  if(v === '' || v === null || v === undefined) return null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function sum_(a){ var t = 0; for(var i=0;i<a.length;i++) t += a[i]; return t; }
function avg_(a){ return a.length ? sum_(a)/a.length : 0; }
function round_(v, d){ var f = Math.pow(10, d); return Math.round(v*f)/f; }
function writeTable_(ss, name, head, rows){
  var sh = ensureSheet_(ss, name, head);
  if(sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow()-1, head.length).clearContent();
  if(rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
}

/* ---------------------------------------------------------- */
/*  مساعدات                                                    */
/* ---------------------------------------------------------- */
function writeShiftLog_(ss, meta, metrics, user, isAdmin, perms){
  var sh = ensureSheet_(ss, SH_LOG, LOG_HEAD);
  var date = fmtDate_(meta.date), shift = str_(meta.shift);
  var vals = sh.getDataRange().getValues();
  var idx = {};                                  // "date|shift|id" → رقم الصف
  for(var r = 1; r < vals.length; r++){
    idx[fmtDate_(vals[r][0]) + '|' + vals[r][1] + '|' + vals[r][2]] = r;
  }
  var now = new Date();
  var adds = [];
  metrics.forEach(function(m){
    var map = METRIC_MAP[String(m.id || '')];
    if(!map) return;
    if(!isAdmin && !perms[map[0]]) return;
    var key = date + '|' + shift + '|' + m.id;
    var row = [date, shift, String(m.id), str_(m.target), str_(m.actual), str_(m.eff), user, now];
    if(idx[key] !== undefined){
      sh.getRange(idx[key] + 1, 1, 1, LOG_HEAD.length).setValues([row]);
    }else{
      adds.push(row);
    }
  });
  if(adds.length) sh.getRange(sh.getLastRow() + 1, 1, adds.length, LOG_HEAD.length).setValues(adds);
}

function upsertHistory_(ss, date, p){
  var sh = ensureSheet_(ss, SH_HIST, HIST_HEAD);
  var vals = sh.getDataRange().getValues();
  var row = [date, str_(p.containers), str_(p.efficiency), str_(p.waste), str_(p.rework)];
  for(var r = 1; r < vals.length; r++){
    if(fmtDate_(vals[r][0]) === date){ sh.getRange(r + 1, 1, 1, HIST_HEAD.length).setValues([row]); return; }
  }
  sh.appendRow(row);
}

function writeUsers_(ss, list){
  var sh = ensureSheet_(ss, SH_USERS, USERS_HEAD);
  if(sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, USERS_HEAD.length).clearContent();
  if(!list.length) return;
  var rows = list.map(function(u){
    return [ String(u.u || ''), str_(u.name), str_(u.salt), str_(u.hash), str_(u.hashAlt),
             u.admin ? 'TRUE' : 'FALSE', (u.active === false ? 'FALSE' : 'TRUE'),
             u.mustChange ? 'TRUE' : 'FALSE', JSON.stringify(u.perms || {}),
             str_(u.created), str_(u.lastLogin) ];
  });
  sh.getRange(2, 1, rows.length, USERS_HEAD.length).setValues(rows);
}

function findUser_(ss, name){
  var key = String(name || '').trim().toLowerCase();
  if(!key) return null;
  var us = readTable_(ss, SH_USERS);
  for(var i = 0; i < us.length; i++){
    if(String(us[i].u).trim().toLowerCase() === key){
      return {
        u: String(us[i].u), name: str_(us[i].name), admin: truthy_(us[i].admin),
        active: (us[i].active === '' || us[i].active === undefined) ? true : truthy_(us[i].active),
        perms: parseJson_(us[i].perms, {}),
        salt: str_(us[i].salt), hash: str_(us[i].hash), hashAlt: str_(us[i].hashAlt)
      };
    }
  }
  return null;
}

function setCell_(vals, col, row, field, v){
  if(v === undefined || col[field] === undefined) return;
  vals[row][col[field]] = v === null ? '' : v;
}
function setMeta_(sh, key, v){
  if(v === undefined || v === null || v === '') return;
  var vals = sh.getDataRange().getValues();
  for(var r = 1; r < vals.length; r++){
    if(String(vals[r][0]) === key){ sh.getRange(r + 1, 2).setValue(v); return; }
  }
  sh.appendRow([key, v]);
}
function readTable_(ss, name){
  var sh = ss.getSheetByName(name);
  if(!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getDataRange().getValues();
  var head = vals[0].map(function(h){ return String(h).trim(); });
  var out = [];
  for(var r = 1; r < vals.length; r++){
    var o = {};
    for(var c = 0; c < head.length; c++) o[head[c]] = vals[r][c];
    out.push(o);
  }
  return out;
}
function fmtDate_(v){
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').trim().slice(0, 10);
}
function str_(v){ return v === undefined || v === null ? '' : String(v).trim(); }
function truthy_(v){
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'نعم' || v === true;
}
function parseJson_(v, dflt){
  try{ return JSON.parse(String(v || '')) || dflt; }catch(e){ return dflt; }
}
function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
