const {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef
} = React;
const firebaseConfig = {
  apiKey: "AIzaSyBtfR8N9Dw9kG3jQSfJSs0p0MLvlQaOR74",
  authDomain: "crm-sys-4184a.firebaseapp.com",
  projectId: "crm-sys-4184a",
  storageBucket: "crm-sys-4184a.firebasestorage.app",
  messagingSenderId: "943273685158",
  appId: "1:943273685158:web:8ca441dd78dcb5b956c467",
  measurementId: "G-2M2W340ZKB"
};
const FIREBASE_AUTH_SCRIPT_SRC = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js';
const loadScriptOnce = (src, id) => new Promise((resolve, reject) => {
  const existingById = id ? document.getElementById(id) : null;
  const existingScript = existingById || Array.from(document.scripts).find(script => script.src === src);
  const handleLoad = script => {
    script.dataset.loaded = '1';
    resolve(script);
  };
  const handleError = () => reject(new Error(`載入外部腳本失敗：${src}`));
  if (existingScript) {
    if (existingScript.dataset.loaded === '1') {
      resolve(existingScript);
      return;
    }
    existingScript.addEventListener('load', () => handleLoad(existingScript), {
      once: true
    });
    existingScript.addEventListener('error', handleError, {
      once: true
    });
    return;
  }
  const script = document.createElement('script');
  if (id) script.id = id;
  script.src = src;
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.addEventListener('load', () => handleLoad(script), {
    once: true
  });
  script.addEventListener('error', handleError, {
    once: true
  });
  document.head.appendChild(script);
});
let app = null;
let auth = null;
let db = null;
let authReadyPromise = null;
const configureFirestoreTransport = dbInstance => {
  if (!dbInstance || dbInstance.__crmTransportConfigured) return;
  try {
    const forceLongPolling = localStorage.getItem('crm_force_long_polling') === '1';
    if (forceLongPolling) {
      dbInstance.settings({
        experimentalForceLongPolling: true
      });
    } else {
      dbInstance.settings({
        experimentalAutoDetectLongPolling: true
      });
    }
    dbInstance.__crmTransportConfigured = true;
  } catch (error) {
    console.warn("Firebase settings failed (safe to ignore):", error);
  }
};
const initializeFirebaseCore = () => {
  try {
    if (typeof firebase === 'undefined' || !firebase.apps) {
      console.error("Firebase SDK not loaded.");
      return {
        app,
        auth,
        db
      };
    }
    if (!firebase.apps.length) {
      app = firebase.initializeApp(firebaseConfig);
    } else if (!app) {
      app = firebase.app();
    }
    if (!db && typeof firebase.firestore === 'function') {
      db = firebase.firestore();
      configureFirestoreTransport(db);
    }
    if (!auth && typeof firebase.auth === 'function') {
      auth = firebase.auth();
    }
  } catch (e) {
    console.error("Firebase initialization failed:", e);
  }
  return {
    app,
    auth,
    db
  };
};
const ensureFirebaseAuthReady = async () => {
  if (auth) return auth;
  if (authReadyPromise) return authReadyPromise;
  authReadyPromise = (async () => {
    if (!(window.firebase && typeof window.firebase.auth === 'function')) {
      await loadScriptOnce(FIREBASE_AUTH_SCRIPT_SRC, 'firebase-auth-compat-sdk');
    }
    const core = initializeFirebaseCore();
    if (!core.auth) throw new Error('Firebase Auth 初始化失敗');
    return core.auth;
  })().catch(error => {
    authReadyPromise = null;
    throw error;
  });
  return authReadyPromise;
};
initializeFirebaseCore();
const wrapSnapshot = snap => {
  if (!snap) return null;
  if (snap.docs) return snap;
  return {
    id: snap.id,
    ref: snap.ref,
    metadata: snap.metadata,
    data: () => snap.data(),
    exists: () => snap.exists,
    _original: snap
  };
};
const collection = (dbInstance, ...pathSegments) => {
  if (!dbInstance) return null;
  return dbInstance.collection(pathSegments.join('/'));
};
const doc = (dbInstance, ...pathSegments) => {
  if (!dbInstance) return null;
  return dbInstance.doc ? dbInstance.doc(pathSegments.join('/')) : db.doc(pathSegments.join('/'));
};
const FIRESTORE_WRITE_TIMEOUT_MS = 8000;
const withWriteTimeout = async (promise, ms, stage) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject({
        code: 'deadline-exceeded',
        message: `${stage} timeout ${ms}ms`
      }), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const isDeadlineExceeded = error => String(error?.code || '').includes('deadline-exceeded');
const encodeDocPathForRest = docPath => String(docPath || '').split('/').map(s => encodeURIComponent(s)).join('/');
const toFirestoreRestValue = value => {
  if (value === undefined) return {
    nullValue: null
  };
  if (value === null) return {
    nullValue: null
  };
  if (typeof value === 'string') return {
    stringValue: value
  };
  if (typeof value === 'boolean') return {
    booleanValue: value
  };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return {
      nullValue: null
    };
    if (Number.isInteger(value)) return {
      integerValue: String(value)
    };
    return {
      doubleValue: value
    };
  }
  if (value instanceof Date) return {
    timestampValue: value.toISOString()
  };
  if (Array.isArray(value)) return {
    arrayValue: {
      values: value.map(v => toFirestoreRestValue(v))
    }
  };
  if (typeof value === 'object') {
    const fields = {};
    Object.keys(value).forEach(k => {
      if (value[k] !== undefined) fields[k] = toFirestoreRestValue(value[k]);
    });
    return {
      mapValue: {
        fields
      }
    };
  }
  return {
    stringValue: String(value)
  };
};
const getAuthTokenForRest = async () => {
  const authInstance = await ensureFirebaseAuthReady();
  let currentUser = authInstance.currentUser;
  if (!currentUser) {
    try {
      await authInstance.signInAnonymously();
    } catch (_) {}
    currentUser = authInstance.currentUser;
  }
  if (!currentUser) throw {
    code: 'unauthenticated',
    message: '尚未登入匿名帳號'
  };
  return currentUser.getIdToken(true);
};
const restPatchDoc = async (docPath, data, opts = {}) => {
  const keys = Object.keys(data || {});
  if ((opts.merge || opts.update) && keys.length === 0) return null;
  const params = [];
  if (opts.merge || opts.update) {
    keys.forEach(k => params.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`));
  }
  if (opts.update) params.push('currentDocument.exists=true');
  const query = params.length ? `?${params.join('&')}` : '';
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${encodeDocPathForRest(docPath)}${query}`;
  const body = {
    fields: {}
  };
  keys.forEach(k => {
    body.fields[k] = toFirestoreRestValue(data[k]);
  });
  const token = await getAuthTokenForRest();
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw {
      code: `http-${res.status}`,
      message: `REST PATCH 失敗: ${text.slice(0, 220) || res.statusText}`
    };
  }
  return res.json().catch(() => null);
};
const restDeleteDoc = async docPath => {
  const token = await getAuthTokenForRest();
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${encodeDocPathForRest(docPath)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw {
      code: `http-${res.status}`,
      message: `REST DELETE 失敗: ${text.slice(0, 220) || res.statusText}`
    };
  }
  return null;
};
const fromFirestoreRestValue = fieldNode => {
  if (!fieldNode) return null;
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'stringValue')) return fieldNode.stringValue;
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'integerValue')) return Number(fieldNode.integerValue);
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'doubleValue')) return Number(fieldNode.doubleValue);
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'booleanValue')) return !!fieldNode.booleanValue;
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'timestampValue')) return fieldNode.timestampValue;
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'arrayValue')) {
    const values = fieldNode.arrayValue?.values || [];
    return values.map(item => fromFirestoreRestValue(item));
  }
  if (Object.prototype.hasOwnProperty.call(fieldNode, 'mapValue')) {
    const fields = fieldNode.mapValue?.fields || {};
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreRestValue(value)]));
  }
  return null;
};
const restGetDoc = async docPath => {
  const token = await getAuthTokenForRest();
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${encodeDocPathForRest(docPath)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw {
      code: `http-${res.status}`,
      message: `REST GET 失敗: ${text.slice(0, 220) || res.statusText}`
    };
  }
  const json = await res.json();
  const fields = json?.fields || {};
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreRestValue(value)]));
};
const setDoc = async (docRef, data, options) => {
  if (!docRef) return;
  try {
    return await withWriteTimeout(docRef.set(data, options), FIRESTORE_WRITE_TIMEOUT_MS, 'setDoc');
  } catch (error) {
    if (!isDeadlineExceeded(error)) throw error;
    console.warn('setDoc timeout, fallback to REST PATCH:', docRef.path);
    return restPatchDoc(docRef.path, data || {}, {
      merge: !!(options && options.merge)
    });
  }
};
const updateDoc = async (docRef, data) => {
  if (!docRef) return;
  try {
    return await withWriteTimeout(docRef.update(data), FIRESTORE_WRITE_TIMEOUT_MS, 'updateDoc');
  } catch (error) {
    if (!isDeadlineExceeded(error)) throw error;
    console.warn('updateDoc timeout, fallback to REST PATCH:', docRef.path);
    return restPatchDoc(docRef.path, data || {}, {
      update: true
    });
  }
};
const deleteDoc = async docRef => {
  if (!docRef) return;
  try {
    return await withWriteTimeout(docRef.delete(), FIRESTORE_WRITE_TIMEOUT_MS, 'deleteDoc');
  } catch (error) {
    if (!isDeadlineExceeded(error)) throw error;
    console.warn('deleteDoc timeout, fallback to REST DELETE:', docRef.path);
    return restDeleteDoc(docRef.path);
  }
};
const addDoc = async (collRef, data) => {
  if (!collRef) return;
  try {
    return await withWriteTimeout(collRef.add(data), FIRESTORE_WRITE_TIMEOUT_MS, 'addDoc');
  } catch (error) {
    if (!isDeadlineExceeded(error)) throw error;
    const fallbackRef = collRef.doc();
    console.warn('addDoc timeout, fallback to REST PATCH:', fallbackRef.path);
    await restPatchDoc(fallbackRef.path, data || {}, {});
    return fallbackRef;
  }
};
const writeBatch = dbInstance => dbInstance.batch();
const onSnapshot = (ref, callback, onError) => {
  if (!ref) return () => {};
  return ref.onSnapshot(snap => callback(wrapSnapshot(snap)), error => {
    console.warn("Firestore 即時讀取失敗:", error);
    if (onError) onError(error);
  });
};
const signInAnonymously = authInstance => authInstance.signInAnonymously();
const onAuthStateChanged = (authInstance, callback) => authInstance.onAuthStateChanged(callback);
const defaultAppId = 'default-app-id';
const APP_BUILD = '2026-03-03 23:45';
const APP_VERSION = APP_BUILD;
const readFlag = (key, defaultValue = false) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === '1';
  } catch (_) {
    return defaultValue;
  }
};
const CSV_HEADER = "日期,活動名稱,講師,客戶姓名,金額,交通方式,身分證字號,生日,Email,報名管道,社群暱稱,備註,訂購日,手機,報到狀態";
const parseCsvLine = line => {
  const cells = [];
  let current = '';
  let inQuotes = false;
  const text = String(line || '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};
const parseCsvDataRows = raw => {
  const normalizedRaw = String(raw || '').trim();
  if (!normalizedRaw) return [];
  const lines = normalizedRaw.split(/\r?\n/);
  return lines.slice(1).map((line, i) => {
    const v = parseCsvLine(line);
    if (v.length < 5) return null;
    return {
      id: i,
      date: v[0]?.trim(),
      eventName: v[1]?.trim(),
      instructor: v[2]?.trim(),
      customerName: v[3]?.trim(),
      price: parseInt(v[4], 10) || 0,
      transport: v[5]?.trim(),
      idNo: v[6]?.trim(),
      birthday: v[7]?.trim(),
      email: v[8]?.trim(),
      source: v[9]?.trim(),
      socialName: v[10]?.trim(),
      notes: v[11]?.trim(),
      orderDate: v[12]?.trim(),
      phone: v[13]?.trim(),
      isCheckedIn: v[14]?.trim() === '1'
    };
  }).filter(row => row && row.date);
};
const getLocalDateStr = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  const localISOTime = new Date(d - offset).toISOString().slice(0, 10);
  return localISOTime;
};
const formatLocalDateKey = date => {
  if (!(date instanceof Date) || isNaN(date.getTime())) return getLocalDateStr();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const parseLocalDateKey = dateKey => {
  const [year, month, day] = String(dateKey || '').split('-').map(value => parseInt(value, 10));
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day);
};
const Logo = ({
  className
}) => {
  return React.createElement("div", {
    className: `flex items-center justify-center ${className}`
  }, React.createElement("img", {
    src: "LOGO\u4FEE\u5FA9\u6A94.png",
    className: "h-8 w-auto object-contain",
    alt: "Logo"
  }));
};
const Icon = ({
  name,
  size = 24,
  className = ""
}) => {
  const containerRef = useRef(null);
  useEffect(() => {
    if (!window.lucide) return;
    const {
      icons,
      createElement
    } = window.lucide;
    const iconName = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    const iconNode = icons[iconName];
    if (iconNode && containerRef.current) {
      containerRef.current.innerHTML = '';
      const svgElement = createElement(iconNode);
      svgElement.setAttribute('width', size);
      svgElement.setAttribute('height', size);
      const existingClass = svgElement.getAttribute('class') || '';
      svgElement.setAttribute('class', `${existingClass} ${className}`.trim());
      containerRef.current.appendChild(svgElement);
    }
  }, [name, size, className]);
  return React.createElement("span", {
    ref: containerRef,
    className: "inline-flex items-center justify-center shrink-0"
  });
};
const TagSelector = ({
  definitions,
  value,
  onChange,
  onAddTag
}) => {
  const renderGroup = (label, type, options, colorClass, activeColorClass) => React.createElement("div", {
    className: "mb-3"
  }, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1.5 block flex items-center justify-between"
  }, label, React.createElement("button", {
    onClick: () => {
      const newTag = prompt(`新增${label}標籤:`);
      if (newTag) onAddTag(type, newTag);
    },
    className: "text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition"
  }, "+ \u65B0\u589E")), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, options.map(opt => React.createElement("button", {
    key: opt,
    type: "button",
    onClick: () => onChange(type, value[type] === opt ? '' : opt),
    className: `px-3 py-1.5 text-xs rounded-lg border transition-all ${value[type] === opt ? activeColorClass : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, opt)), options.length === 0 && React.createElement("span", {
    className: "text-xs text-slate-300 italic"
  }, "\u7121\u9078\u9805")));
  return React.createElement("div", {
    className: "bg-slate-50 p-3 rounded-xl border border-slate-200"
  }, renderGroup('活動等級', 'levels', definitions.levels || [], 'border-blue-200', 'bg-blue-600 text-white border-blue-600 shadow-sm'), renderGroup('活動種類', 'types', definitions.types || [], 'border-emerald-200', 'bg-emerald-600 text-white border-emerald-600 shadow-sm'), renderGroup('活動地點', 'locations', definitions.locations || [], 'border-purple-200', 'bg-purple-600 text-white border-purple-600 shadow-sm'));
};
const DebugPanel = ({
  onClose
}) => React.createElement("div", {
  className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4"
}, React.createElement("div", {
  className: "bg-white p-6 rounded-xl shadow-2xl max-w-sm w-full"
}, React.createElement("h3", {
  className: "font-bold text-lg mb-2"
}, "\u7CFB\u7D71\u72C0\u614B"), React.createElement("div", {
  className: "bg-slate-100 p-3 rounded text-xs font-mono text-slate-600 mb-4"
}, "Status: Online (Safe Mode)", React.createElement("br", null), "Version: 3.8.6 (BugFix)", React.createElement("br", null), "Firebase: Compat"), React.createElement("button", {
  onClick: onClose,
  className: "w-full bg-slate-800 text-white py-2 rounded-lg text-sm"
}, "\u95DC\u9589")));
const DEFAULT_TASKS_TEMPLATE = [{
  id: 'insurance',
  type: 'insurance',
  name: '辦理保險',
  fields: [{
    label: '保單號碼',
    value: ''
  }],
  completed: false
}, {
  id: 'pre_letter',
  type: 'pre_letter',
  name: '寄送行前信',
  fields: [{
    label: '寄送日期',
    value: ''
  }],
  completed: false
}, {
  id: 'post_letter',
  type: 'post_letter',
  name: '寄送花絮信',
  fields: [{
    label: '照片連結',
    value: ''
  }],
  completed: false
}];
const DEFAULT_STATUS_RULES = [{
  min: 0,
  max: 6,
  label: '6人以下，體驗舒適',
  color: 'green'
}, {
  min: 7,
  max: 11,
  label: '剩餘{remaining}位，即將滿團',
  color: 'orange'
}, {
  min: 12,
  max: 999,
  label: '滿團',
  color: 'slate'
}];
const cloneDefaultStatusRules = () => DEFAULT_STATUS_RULES.map(rule => ({
  ...rule
}));
const LEGACY_DEFAULT_STATUS_RULES = [{
  min: 0,
  max: 8,
  label: '舒適體驗｜8人以下',
  color: 'green'
}, {
  min: 9,
  max: 11,
  label: '即將額滿',
  color: 'orange'
}, {
  min: 12,
  max: 999,
  label: '已額滿',
  color: 'slate'
}];
const DEFAULT_TAG_DEFS = {
  levels: ['一般大眾', '進階', '親子限定', '社群限定', '包團'],
  types: ['蛇類觀察', '夜間生態', '步道導覽', '生態講座', '蛙類觀察', '昆蟲觀察'],
  locations: ['新店場', '北投場', '內湖場', '信義場', '富陽公園', '虎山溪']
};
const DEFAULT_PUBLIC_THEME = {
  pageBg: '#fff7ed',
  pageBgAlt: '#fef3c7',
  surfaceBg: '#ffffff',
  surfaceBorder: '#fde68a',
  textColor: '#334155',
  titleColor: '#1e293b',
  accentColor: '#2563eb'
};
const PUBLIC_THEME_PRESETS = [{
  id: 'sunny',
  label: '晴空琥珀',
  values: {
    pageBg: '#fff7ed',
    pageBgAlt: '#fef3c7',
    surfaceBg: '#ffffff',
    surfaceBorder: '#fde68a',
    textColor: '#334155',
    titleColor: '#1e293b',
    accentColor: '#2563eb'
  }
}, {
  id: 'forest',
  label: '森林薄霧',
  values: {
    pageBg: '#ecfdf5',
    pageBgAlt: '#d1fae5',
    surfaceBg: '#ffffff',
    surfaceBorder: '#a7f3d0',
    textColor: '#14532d',
    titleColor: '#064e3b',
    accentColor: '#059669'
  }
}, {
  id: 'ocean',
  label: '海洋晨光',
  values: {
    pageBg: '#f0f9ff',
    pageBgAlt: '#dbeafe',
    surfaceBg: '#ffffff',
    surfaceBorder: '#bfdbfe',
    textColor: '#1e3a8a',
    titleColor: '#1e40af',
    accentColor: '#0284c7'
  }
}, {
  id: 'newyear',
  label: '新年喜慶',
  values: {
    pageBg: '#fff1f2',
    pageBgAlt: '#ffe4b5',
    surfaceBg: '#fffaf0',
    surfaceBorder: '#f59e0b',
    textColor: '#7f1d1d',
    titleColor: '#991b1b',
    accentColor: '#dc2626'
  }
}];
const normalizePublicTheme = theme => ({
  ...DEFAULT_PUBLIC_THEME,
  ...(theme || {})
});
const DEFAULT_PUBLIC_SIDE_DECOR = {
  leftImage: '',
  rightImage: '',
  width: 180,
  mobileWidth: 0,
  offsetY: 0,
  offsetX: 24,
  opacity: 1
};
const DEFAULT_OUTING_POSTER_CONFIG = [{
  filename: 'new-year.gif',
  label: '新年出外',
  weight: 40
}, {
  filename: 'climbing.gif',
  label: '山林取材',
  weight: 35
}, {
  filename: 'frog_jumping.gif',
  label: '野外觀察',
  weight: 25
}];
const DEFAULT_POSTER_NAME_OVERRIDES = [];
const normalizePosterNameOverrides = list => (Array.isArray(list) ? list : []).map((item, index) => ({
  id: String(item?.id || `poster_name_${index}_${Date.now()}`),
  sourceName: String(item?.sourceName || item?.backendName || item?.from || '').trim(),
  posterName: String(item?.posterName || item?.displayName || item?.to || '').trim()
})).filter(item => item.sourceName && item.posterName);
const DEFAULT_CARPOOL_CAPACITY = 4;
const CARPOOL_DISPLAY_MODE_OPTIONS = [{
  value: 'normal',
  label: '顯示剩餘名額',
  helper: '前台顯示付費共乘剩餘名額'
}, {
  value: 'none',
  label: '顯示無共乘',
  helper: '前台固定顯示本活動無共乘'
}];
const DEFAULT_AUTH_ACCOUNT_NAME = '管理員';
const normalizeAuthAccounts = (accounts = [], fallbackPassword = '') => {
  const normalized = (Array.isArray(accounts) ? accounts : []).map((account, index) => ({
    id: String(account?.id || `auth_${index}`),
    name: String(account?.name || '').trim(),
    password: String(account?.password || '').trim()
  })).filter(account => account.password);
  if (normalized.length === 0 && String(fallbackPassword || '').trim()) {
    return [{
      id: 'legacy_admin',
      name: DEFAULT_AUTH_ACCOUNT_NAME,
      password: String(fallbackPassword || '').trim()
    }];
  }
  return normalized;
};
const DEFAULT_NO_CARPOOL_EVENT_NAMES = new Set(['大安鼠', '新店鼠']);
const getDefaultCarpoolDisplayModeForEventName = (eventName = '') => DEFAULT_NO_CARPOOL_EVENT_NAMES.has(String(eventName || '').trim()) ? 'none' : 'normal';
const resolveCarpoolDisplayMode = (value, eventName = '') => value === 'none' || value === 'normal' ? value : getDefaultCarpoolDisplayModeForEventName(eventName);
const PERFORMANCE_BUCKET_OPTIONS = [{
  value: 'theme',
  label: '主題活動'
}, {
  value: 'afterwork',
  label: '下班後走走'
}, {
  value: 'special',
  label: '特別活動'
}];
const PERFORMANCE_BUCKET_LABELS = PERFORMANCE_BUCKET_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});
const inferPerformanceBucket = (name = '') => {
  const normalized = String(name || '').trim();
  if (/^下班走走/.test(normalized) || normalized.includes('下班後走走')) return 'afterwork';
  return 'theme';
};
const QUICK_CREATE_TEMPLATE_CATEGORY_OPTIONS = [{
  value: 'theme',
  label: '主題活動',
  helper: '地名 + 動物，例如：大安鼠'
}, {
  value: 'afterWork',
  label: '下班後走走',
  helper: '下班走走 XX'
}, {
  value: 'special',
  label: '特別活動',
  helper: '其他自訂活動'
}];
const QUICK_CREATE_TEMPLATE_CATEGORY_LABELS = QUICK_CREATE_TEMPLATE_CATEGORY_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});
const SCHEDULE_TIME_SLOT_OPTIONS = [{
  value: 'morning',
  label: '上午',
  helper: '中午以前'
}, {
  value: 'afternoon',
  label: '下午',
  helper: '12:00-17:59'
}, {
  value: 'evening',
  label: '晚上',
  helper: '18:00 以後'
}];
const SCHEDULE_REST_SLOT_OPTIONS = [{
  value: 'all',
  label: '整天'
}, ...SCHEDULE_TIME_SLOT_OPTIONS.map(item => ({
  value: item.value,
  label: item.label
}))];
const SCHEDULE_TIME_SLOT_LABELS = SCHEDULE_REST_SLOT_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});
const normalizeScheduleTimeSlot = (value, fallback = 'evening') => SCHEDULE_TIME_SLOT_OPTIONS.some(item => item.value === value) ? value : fallback;
const normalizeScheduleRestSlot = (value, fallback = 'all') => SCHEDULE_REST_SLOT_OPTIONS.some(item => item.value === value) ? value : fallback;
const inferScheduleTimeSlot = time => {
  const match = String(time || '').match(/^(\d{1,2})/);
  if (!match) return 'evening';
  const hour = parseInt(match[1], 10);
  if (!Number.isFinite(hour)) return 'evening';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
};
const getScheduleSlotLabel = slot => SCHEDULE_TIME_SLOT_LABELS[slot] || SCHEDULE_TIME_SLOT_LABELS[normalizeScheduleTimeSlot(slot)];
const normalizeScheduleRestEntry = entry => {
  const empty = {
    all: [],
    morning: [],
    afternoon: [],
    evening: []
  };
  const cleanList = list => Array.from(new Set((Array.isArray(list) ? list : []).map(name => String(name || '').trim()).filter(Boolean)));
  if (Array.isArray(entry)) return {
    ...empty,
    all: cleanList(entry)
  };
  if (entry && typeof entry === 'object') {
    return {
      all: cleanList(entry.all || entry.fullDay || entry.names),
      morning: cleanList(entry.morning),
      afternoon: cleanList(entry.afternoon),
      evening: cleanList(entry.evening)
    };
  }
  return empty;
};
const getAllScheduleRestNames = entry => {
  const normalized = normalizeScheduleRestEntry(entry);
  return Array.from(new Set(['all', 'morning', 'afternoon', 'evening'].flatMap(slot => normalized[slot] || [])));
};
const getScheduleRestNamesForSlot = (entry, slot = 'all') => {
  const normalized = normalizeScheduleRestEntry(entry);
  const normalizedSlot = normalizeScheduleRestSlot(slot, 'all');
  if (normalizedSlot === 'all') return normalized.all || [];
  return Array.from(new Set([...(normalized.all || []), ...(normalized[normalizedSlot] || [])]));
};
const isInstructorRestingForSlot = (schedule = {}, dateKey = '', name = '', slot = 'all') => {
  const cleanName = String(name || '').trim();
  if (!cleanName) return false;
  return getScheduleRestNamesForSlot(schedule?.[dateKey], slot).includes(cleanName);
};
const getScheduleRestDisplayItems = entry => {
  const normalized = normalizeScheduleRestEntry(entry);
  const items = [];
  SCHEDULE_REST_SLOT_OPTIONS.forEach(option => {
    (normalized[option.value] || []).forEach(name => {
      const cleanName = String(name || '').trim();
      if (cleanName) items.push({
        name: cleanName,
        slot: option.value,
        label: option.label
      });
    });
  });
  return items;
};
const toggleScheduleRestEntry = (entry, name, slot = 'all') => {
  const cleanName = String(name || '').trim();
  if (!cleanName) return normalizeScheduleRestEntry(entry);
  const normalized = normalizeScheduleRestEntry(entry);
  const normalizedSlot = normalizeScheduleRestSlot(slot, 'all');
  const hasName = list => (list || []).includes(cleanName);
  const addName = list => hasName(list) ? list : [...(list || []), cleanName];
  const removeName = list => (list || []).filter(item => item !== cleanName);
  if (normalizedSlot === 'all') {
    if (hasName(normalized.all)) {
      normalized.all = removeName(normalized.all);
    } else {
      normalized.all = addName(normalized.all);
      SCHEDULE_TIME_SLOT_OPTIONS.forEach(option => {
        normalized[option.value] = removeName(normalized[option.value]);
      });
    }
  } else if (hasName(normalized.all) && !hasName(normalized[normalizedSlot])) {
    normalized.all = removeName(normalized.all);
    SCHEDULE_TIME_SLOT_OPTIONS.forEach(option => {
      normalized[option.value] = option.value === normalizedSlot ? removeName(normalized[option.value]) : addName(normalized[option.value]);
    });
  } else if (hasName(normalized[normalizedSlot])) {
    normalized[normalizedSlot] = removeName(normalized[normalizedSlot]);
  } else {
    normalized[normalizedSlot] = addName(normalized[normalizedSlot]);
  }
  return normalized;
};
const QUICK_CREATE_SPECIAL_ACTIVITY_NAMES = new Set(['北橫蛇']);
const QUICK_CREATE_THEME_ANIMAL_SUFFIXES = ['貓頭鷹', '蝙蝠', '飛鼠', '松鼠', '蜥蜴', '蟾蜍', '穿山甲', '水鹿', '梅花鹿', '山羌', '夜鷺', '老鷹', '螢火蟲', '鼠', '兔', '蛇', '龜', '蛙', '蜥', '蟾', '狐', '鹿', '猴', '鳥', '蟬', '螢'];
const normalizeQuickCreateTemplateCategory = (value, fallbackName = '') => {
  if (value === 'afterwork') return 'afterWork';
  if (value === 'theme' || value === 'afterWork' || value === 'special') return value;
  const cleanName = String(fallbackName || '').trim();
  if (!cleanName) return 'special';
  if (QUICK_CREATE_SPECIAL_ACTIVITY_NAMES.has(cleanName)) return 'special';
  if (cleanName.startsWith('下班走走') || cleanName.includes('下班後走走')) return 'afterWork';
  if (cleanName.startsWith('夜訪')) return 'theme';
  if (/^[\u3400-\u9fff]{2,10}$/.test(cleanName) && QUICK_CREATE_THEME_ANIMAL_SUFFIXES.some(suffix => cleanName.endsWith(suffix))) {
    return 'theme';
  }
  return 'special';
};
const getTemplateEventName = (tpl = {}) => String(tpl?.eventName || tpl?.name || '').trim();
const getTemplateEventNameKey = (tpl = {}) => getTemplateEventName(tpl).replace(/\s+/g, '');
const getQuickCreateTemplateStableKey = (tpl = {}) => String(tpl?.id || [tpl?.name, tpl?.eventName, tpl?.time, tpl?.instructor].map(value => String(value || '').trim()).join('::'));
const normalizeQuickCreateTemplate = (tpl = {}) => {
  const eventName = getTemplateEventName(tpl);
  const privateGroupLabel = toSafeDisplayText(tpl.privateGroupLabel, '此為包團活動') || '此為包團活動';
  return {
    ...tpl,
    eventName,
    templateCategory: normalizeQuickCreateTemplateCategory(tpl.templateCategory, eventName),
    timeSlot: normalizeScheduleTimeSlot(tpl.timeSlot, inferScheduleTimeSlot(tpl.time)),
    isPrivateGroupEvent: !!tpl.isPrivateGroupEvent || tpl?.tags?.levels === '包團' || String(tpl?.displayName || eventName || '').includes('包團'),
    privateGroupLabel,
    statusRules: normalizeStoredStatusRules(tpl.statusRules || [])
  };
};
const DEFAULT_MASCOT_THEMES = [{
  id: 'default_flying_squirrel',
  name: '飛鼠系列',
  keywords: '飛鼠,滑翔',
  gifs: [{
    filename: 'eating.gif',
    action: '吃東西',
    weight: 20
  }, {
    filename: 'cleaning.gif',
    action: '打掃',
    weight: 35
  }, {
    filename: 'climbing.gif',
    action: '攀岩',
    weight: 35
  }, {
    filename: 'sliding.gif',
    action: '滑行',
    weight: 8
  }, {
    filename: 'milking.gif',
    action: '喝奶',
    weight: 2
  }]
}];
const normalizePublicSideDecor = decor => ({
  ...DEFAULT_PUBLIC_SIDE_DECOR,
  ...(decor || {}),
  offsetY: Number((decor && decor.offsetY) ?? DEFAULT_PUBLIC_SIDE_DECOR.offsetY),
  offsetX: Number((decor && decor.offsetX) ?? DEFAULT_PUBLIC_SIDE_DECOR.offsetX),
  mobileWidth: Number((decor && decor.mobileWidth) ?? DEFAULT_PUBLIC_SIDE_DECOR.mobileWidth)
});
const COLOR_OPTIONS = [{
  value: 'blue',
  label: '藍色 (正常)',
  bg: 'bg-blue-50',
  border: 'border-blue-100',
  text: 'text-blue-600',
  hover: 'hover:bg-blue-100'
}, {
  value: 'green',
  label: '綠色 (充足)',
  bg: 'bg-green-50',
  border: 'border-green-100',
  text: 'text-green-600',
  hover: 'hover:bg-green-100'
}, {
  value: 'orange',
  label: '橘色 (緊張)',
  bg: 'bg-orange-50',
  border: 'border-orange-100',
  text: 'text-orange-600',
  hover: 'hover:bg-orange-100'
}, {
  value: 'red',
  label: '紅色 (滿員)',
  bg: 'bg-red-50',
  border: 'border-red-100',
  text: 'text-red-600',
  hover: 'hover:bg-red-100'
}, {
  value: 'purple',
  label: '紫色 (特別)',
  bg: 'bg-purple-50',
  border: 'border-purple-100',
  text: 'text-purple-600',
  hover: 'hover:bg-purple-100'
}, {
  value: 'slate',
  label: '灰色 (截止)',
  bg: 'bg-slate-50',
  border: 'border-slate-200',
  text: 'text-slate-500',
  hover: 'hover:bg-slate-100'
}];
const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
const getFirstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();
const getDayOfYear = dateStr => {
  const date = parseLocalDateKey(dateStr);
  if (isNaN(date.getTime())) return 0;
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const createProjectConsoleTemplate = name => ({
  id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  name: name || "新專案",
  pm: "未設定",
  department: "未設定",
  totalBudget: 0,
  deadline: getLocalDateStr(),
  status: "active",
  workPackages: [],
  issues: [],
  createdAt: new Date().toISOString()
});
const normalizeConsoleTask = (task, idx, wpId) => ({
  id: task?.id || `${wpId}.${idx + 1}`,
  name: task?.name || task?.title || "新任務",
  owner: task?.owner || task?.assignee || "未指派",
  plan: {
    start: task?.plan?.start || task?.dueDate || getLocalDateStr(),
    end: task?.plan?.end || task?.dueDate || getLocalDateStr(),
    cost: Number(task?.plan?.cost || task?.kpi?.target || 0)
  },
  actual: {
    start: task?.actual?.start || task?.dueDate || getLocalDateStr(),
    end: task?.actual?.end || task?.dueDate || getLocalDateStr(),
    cost: Number(task?.actual?.cost || task?.kpi?.current || 0)
  },
  progress: Number(task?.progress ?? (task?.completed ? 100 : 0))
});
const normalizeConsoleProject = (project, fallbackId) => {
  const id = project?.id || fallbackId || `proj_${Date.now()}`;
  const workspaceStatus = project?.workspaceStatus || (project?.status === 'archived' ? 'archived' : 'active');
  let workPackages = Array.isArray(project?.workPackages) ? project.workPackages : [];
  if (!workPackages.length) {
    const sourceTasks = Array.isArray(project?.phases) && project.phases.length > 0 ? project.phases.flatMap(p => p.tasks || []) : Array.isArray(project?.subTasks) ? project.subTasks : [];
    if (sourceTasks.length > 0) {
      workPackages = [{
        id: 'WP1',
        name: '第一工作包',
        tasks: sourceTasks
      }];
    }
  }
  workPackages = workPackages.map((wp, wpIdx) => {
    const wpId = wp?.id || `WP${wpIdx + 1}`;
    return {
      id: wpId,
      name: wp?.name || `工作包 ${wpIdx + 1}`,
      tasks: Array.isArray(wp?.tasks) ? wp.tasks.map((t, tIdx) => normalizeConsoleTask(t, tIdx, wpId)) : []
    };
  });
  return {
    ...project,
    id,
    name: project?.name || "未命名專案",
    pm: project?.pm || project?.owner || "未設定",
    department: project?.department || "未設定",
    totalBudget: Number(project?.totalBudget || 0),
    deadline: project?.deadline || getLocalDateStr(),
    status: workspaceStatus,
    workspaceStatus,
    workPackages,
    issues: Array.isArray(project?.issues) ? project.issues : [],
    createdAt: project?.createdAt || new Date().toISOString()
  };
};
const toCSVField = text => {
  if (!text) return '';
  const str = String(text);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};
const getWeightedOutingPoster = (posterList, excludeFilename = null) => {
  if (!Array.isArray(posterList) || posterList.length === 0) return null;
  const validList = posterList.filter(item => item && item.filename).map(item => ({
    ...item,
    weight: Math.max(1, parseInt(item.weight, 10) || 1)
  }));
  if (validList.length === 0) return null;
  const shouldExclude = excludeFilename && validList.length > 1 && validList.some(item => item.filename === excludeFilename);
  const candidateList = shouldExclude ? validList.filter(item => item.filename !== excludeFilename) : validList;
  const totalWeight = candidateList.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * totalWeight;
  for (const item of candidateList) {
    if (cursor < item.weight) return item;
    cursor -= item.weight;
  }
  return candidateList[0];
};
const getTaskStatusStyle = (taskType, eventDateStr) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(eventDateStr);
  const diffTime = target.getTime() - today.getTime();
  const daysDiff = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  if (taskType === 'insurance') {
    if (daysDiff <= 3 && daysDiff >= 0) return {
      color: 'text-red-600',
      bg: 'bg-red-50',
      border: 'border-red-200',
      label: '急迫'
    };
    if (daysDiff < 0) return {
      color: 'text-slate-400',
      bg: 'bg-slate-100',
      border: 'border-slate-200',
      label: '已過'
    };
    return {
      color: 'text-slate-600',
      bg: 'bg-white',
      border: 'border-slate-200',
      label: '待辦'
    };
  }
  if (taskType === 'post_letter') {
    const daysSinceEvent = -daysDiff;
    if (daysSinceEvent < 1) return {
      color: 'text-slate-400',
      bg: 'bg-slate-50',
      border: 'border-slate-200',
      label: '未開始'
    };
    if (daysSinceEvent === 1) return {
      color: 'text-green-600',
      bg: 'bg-green-50',
      border: 'border-green-200',
      label: '建議寄送'
    };
    if (daysSinceEvent >= 3) return {
      color: 'text-red-600',
      bg: 'bg-red-50',
      border: 'border-red-200',
      label: '延遲'
    };
  }
  return {
    color: 'text-slate-600',
    bg: 'bg-white',
    border: 'border-slate-200',
    label: ''
  };
};
const getPromiseStatus = (date, time) => {
  if (!date) return {
    status: 'normal',
    color: 'text-slate-600',
    bg: 'bg-white'
  };
  const now = new Date();
  const dueStr = time ? `${date}T${time}` : `${date}T23:59`;
  const due = new Date(dueStr);
  const diffMs = due - now;
  const diffHrs = diffMs / (1000 * 60 * 60);
  if (diffMs < 0) return {
    status: 'overdue',
    color: 'text-red-600',
    bg: 'bg-red-50',
    border: 'border-red-200',
    label: '已過期'
  };
  if (diffHrs < 24) return {
    status: 'urgent',
    color: 'text-orange-600',
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    label: '24h內'
  };
  return {
    status: 'future',
    color: 'text-green-700',
    bg: 'bg-green-50',
    border: 'border-green-200',
    label: '進行中'
  };
};
const getEventStatus = (count, capacity, config, dateStr, globalRules) => {
  const participantCount = Math.max(0, parseInt(count, 10) || 0);
  const fullThreshold = Math.max(1, parseInt(capacity, 10) || 12);
  const getDefaultStatus = () => {
    if (participantCount >= fullThreshold) {
      return {
        label: '滿團',
        color: 'slate',
        colorObj: COLOR_OPTIONS.find(c => c.value === 'slate'),
        isFull: true
      };
    }
    if (participantCount >= 7) {
      return {
        label: `剩餘${Math.max(fullThreshold - participantCount, 0)}位，即將滿團`,
        color: 'orange',
        colorObj: COLOR_OPTIONS.find(c => c.value === 'orange'),
        isFull: false
      };
    }
    return {
      label: '6人以下，體驗舒適',
      color: 'green',
      colorObj: COLOR_OPTIONS.find(c => c.value === 'green'),
      isFull: false
    };
  };
  if (dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const evtDate = parseLocalDateKey(dateStr);
    if (evtDate < today) {
      return {
        label: '🔚 已結束',
        color: 'slate',
        colorObj: COLOR_OPTIONS.find(c => c.value === 'slate'),
        isFull: true,
        isEnded: true
      };
    }
  }
  const matchedRule = getMatchingStatusRule(participantCount, config?.statusRules, globalRules);
  if (matchedRule) {
    const matchedLabel = normalizeStatusRuleValue(matchedRule.label);
    if (isLegacyLowStatusLabel(matchedLabel) || isLegacyMidStatusLabel(matchedLabel) || isLegacyHighStatusLabel(matchedLabel)) {
      return getDefaultStatus();
    }
    const colorObj = COLOR_OPTIONS.find(c => c.value === matchedRule.color) || COLOR_OPTIONS.find(c => c.value === 'blue');
    return {
      label: formatStatusRuleLabel(matchedRule.label, participantCount, fullThreshold),
      color: matchedRule.color || 'blue',
      colorObj,
      isFull: participantCount >= fullThreshold
    };
  }
  return getDefaultStatus();
};
const downloadCSV = (csvContent, filename = 'export.csv') => {
  const blob = new Blob(["\uFEFF" + csvContent], {
    type: 'text/csv;charset=utf-8;'
  });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};
const downloadTextFile = (content, filename = 'export.txt') => {
  const blob = new Blob([String(content ?? '')], {
    type: 'text/plain;charset=utf-8;'
  });
  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
const downloadBlobFile = (blob, filename = 'download.bin') => {
  if (!(blob instanceof Blob)) return;
  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
const sanitizeFilename = (value, fallback = 'export') => {
  const cleaned = String(value || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  return cleaned || fallback;
};
const MONTH_LABELS_ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const POSTER_BUCKET_META = {
  theme: {
    label: '主題活動',
    color: '#cb6a12',
    accent: '#cb6a12',
    order: 0
  },
  afterWork: {
    label: '下班後走走',
    color: '#337ea8',
    accent: '#337ea8',
    order: 1
  },
  special: {
    label: '特別活動',
    color: '#0f766e',
    accent: '#2dd4bf',
    order: 2
  }
};
const POSTER_HTML_WIDTH = 1080;
const POSTER_HTML_HEIGHT = 1350;
const POSTER_WALK_IMAGE_CROP = {
  sx: 1502,
  sy: 2342,
  sw: 371,
  sh: 332,
  width: 116,
  height: 104,
  offsetX: -2,
  offsetY: 4
};
const POSTER_BOTTOM_IMAGE_CROP = {
  sx: 195,
  sy: 823,
  sw: 2912,
  sh: 676,
  width: 932,
  height: 216
};
const getPosterAssets = () => window.__TPHA_POSTER_ASSETS__ || null;
let posterAssetsLoaderPromise = null;
const ensurePosterAssetsLoaded = () => {
  const existingAssets = getPosterAssets();
  if (existingAssets) return Promise.resolve(existingAssets);
  if (posterAssetsLoaderPromise) return posterAssetsLoaderPromise;
  posterAssetsLoaderPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-poster-assets="1"]');
    if (existingScript) {
      const currentState = existingScript.dataset.posterAssetsState || '';
      if (currentState === 'loaded') {
        const loadedAssets = getPosterAssets();
        if (loadedAssets) {
          resolve(loadedAssets);
        } else {
          reject(new Error('月曆海報圖資載入後仍不可用'));
        }
        return;
      }
      if (currentState !== 'error') {
        existingScript.addEventListener('load', () => resolve(getPosterAssets()), {
          once: true
        });
        existingScript.addEventListener('error', () => reject(new Error('月曆海報圖資載入失敗')), {
          once: true
        });
        return;
      }
      existingScript.remove();
    }
    const script = document.createElement('script');
    script.src = `./poster-assets.js?v=${encodeURIComponent(APP_VERSION)}`;
    script.async = true;
    script.dataset.posterAssets = '1';
    script.dataset.posterAssetsState = 'loading';
    script.onload = () => {
      script.dataset.posterAssetsState = 'loaded';
      const assets = getPosterAssets();
      if (assets) resolve(assets);else reject(new Error('月曆海報圖資載入後仍不可用'));
    };
    script.onerror = () => {
      script.dataset.posterAssetsState = 'error';
      reject(new Error('月曆海報圖資載入失敗'));
    };
    document.head.appendChild(script);
  }).catch(error => {
    posterAssetsLoaderPromise = null;
    throw error;
  });
  return posterAssetsLoaderPromise;
};
const getPosterWalkImageSrc = () => getPosterAssets()?.POSTER_WALK_DATA_URL || '';
const getPosterBottomImageSrc = () => getPosterAssets()?.POSTER_BOTTOM_DATA_URL || '';
const getPosterFlashlightImageSrc = () => getPosterAssets()?.POSTER_FLASHLIGHT_DATA_URL || '';
const getPosterLogoImageSrc = () => getPosterAssets()?.POSTER_LOGO_DATA_URL || '';
const inferSchedulePosterBucket = (evt = {}, cfg = {}) => {
  const namesToCheck = [cfg?.activityCategory, cfg?.displayName, evt?.eventName, cfg?.eventName].map(value => String(value || '').trim()).filter(Boolean);
  if (namesToCheck.some(value => value.includes('下班後走走') || value.startsWith('下班走走'))) return 'afterWork';
  if (namesToCheck.some(value => inferPlanActivityTemplateType(value) === 'theme')) return 'theme';
  if (namesToCheck.some(value => inferPlanActivityTemplateType(value) === 'special')) return 'special';
  return 'special';
};
const loadImageForCanvas = src => new Promise(resolve => {
  if (!src) {
    resolve(null);
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});
const EXTERNAL_SCRIPT_URLS = {
  rechartsPropTypes: 'https://cdnjs.cloudflare.com/ajax/libs/prop-types/15.8.1/prop-types.min.js',
  rechartsReactIs: 'https://cdnjs.cloudflare.com/ajax/libs/react-is/18.2.0/umd/react-is.production.min.js',
  rechartsCore: 'https://cdnjs.cloudflare.com/ajax/libs/recharts/2.10.3/Recharts.min.js'
};
const externalScriptPromises = {};
const ensureExternalScriptLoaded = (src, key) => {
  const cacheKey = String(key || src || '').trim();
  if (!cacheKey || !src) return Promise.reject(new Error('缺少外部腳本路徑'));
  if (externalScriptPromises[cacheKey]) return externalScriptPromises[cacheKey];
  externalScriptPromises[cacheKey] = new Promise((resolve, reject) => {
    const selector = `script[data-external-script="${cacheKey}"]`;
    const existingScript = document.querySelector(selector);
    if (existingScript) {
      const currentState = existingScript.dataset.loadedState || '';
      if (currentState === 'loaded') {
        resolve();
        return;
      }
      if (currentState !== 'error') {
        existingScript.addEventListener('load', () => resolve(), {
          once: true
        });
        existingScript.addEventListener('error', () => reject(new Error(`${cacheKey} 載入失敗`)), {
          once: true
        });
        return;
      }
      existingScript.remove();
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.dataset.externalScript = cacheKey;
    script.dataset.loadedState = 'loading';
    script.onload = () => {
      script.dataset.loadedState = 'loaded';
      resolve();
    };
    script.onerror = () => {
      script.dataset.loadedState = 'error';
      reject(new Error(`${cacheKey} 載入失敗`));
    };
    document.head.appendChild(script);
  }).catch(error => {
    delete externalScriptPromises[cacheKey];
    throw error;
  });
  return externalScriptPromises[cacheKey];
};
const ensureRechartsLoaded = async () => {
  if (window.Recharts && window.Recharts.BarChart) return window.Recharts;
  await ensureExternalScriptLoaded(EXTERNAL_SCRIPT_URLS.rechartsPropTypes, 'recharts-prop-types');
  await ensureExternalScriptLoaded(EXTERNAL_SCRIPT_URLS.rechartsReactIs, 'recharts-react-is');
  await ensureExternalScriptLoaded(EXTERNAL_SCRIPT_URLS.rechartsCore, 'recharts-core');
  if (!window.Recharts || !window.Recharts.BarChart) {
    throw new Error('Recharts 載入後仍不可用');
  }
  return window.Recharts;
};
let html2CanvasLoaderPromise = null;
const ensureHtml2CanvasLoaded = () => {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (html2CanvasLoaderPromise) return html2CanvasLoaderPromise;
  html2CanvasLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    script.async = true;
    script.onload = () => {
      if (window.html2canvas) resolve(window.html2canvas);else reject(new Error('html2canvas 載入後仍不可用'));
    };
    script.onerror = () => reject(new Error('html2canvas 載入失敗，請確認目前網路可連線'));
    document.head.appendChild(script);
  });
  return html2CanvasLoaderPromise;
};
const fitPosterEventName = (name = '', limit = 9) => {
  const clean = String(name || '').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(1, limit - 1))}…`;
};
const getPosterTopNoticeLines = posterData => [posterData.footnote, '請至訂票網站報名', '共乘名額請洽客服'];
const traceRoundedRectPath = (ctx, x, y, width, height, radius) => {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};
const drawPosterFlashlightCanvas = (ctx, cellX, cellY, flashlightImage) => {
  const targetX = cellX + 27;
  const targetY = cellY + 24;
  const originX = cellX + 82;
  const originY = cellY + 14;
  const angle = Math.atan2(targetY - originY, targetX - originX);
  const distance = Math.hypot(targetX - originX, targetY - originY);
  ctx.save();
  ctx.translate(originX, originY);
  ctx.rotate(angle);
  const beamGradient = ctx.createLinearGradient(0, 0, distance, 0);
  beamGradient.addColorStop(0, 'rgba(255, 244, 182, 0.22)');
  beamGradient.addColorStop(0.4, 'rgba(255, 234, 142, 0.48)');
  beamGradient.addColorStop(1, 'rgba(255, 224, 118, 0.05)');
  ctx.fillStyle = beamGradient;
  ctx.beginPath();
  ctx.moveTo(2, -5);
  ctx.lineTo(2, 5);
  ctx.lineTo(distance, 22);
  ctx.lineTo(distance, -22);
  ctx.closePath();
  ctx.fill();
  const spotlight = ctx.createRadialGradient(distance - 2, 0, 4, distance - 2, 0, 38);
  spotlight.addColorStop(0, 'rgba(255, 248, 210, 1)');
  spotlight.addColorStop(0.34, 'rgba(255, 241, 170, 0.8)');
  spotlight.addColorStop(0.72, 'rgba(255, 235, 146, 0.24)');
  spotlight.addColorStop(1, 'rgba(255, 235, 146, 0)');
  ctx.fillStyle = spotlight;
  ctx.beginPath();
  ctx.arc(distance - 2, 0, 38, 0, Math.PI * 2);
  ctx.fill();
  if (flashlightImage) {
    ctx.save();
    ctx.rotate(angle + Math.PI / 4 + Math.PI + Math.PI / 180);
    ctx.drawImage(flashlightImage, -30, -12, 44, 44);
    ctx.restore();
  }
  ctx.restore();
};
const buildPosterFlashlightSvgMarkup = (cellX, cellY) => {
  const targetX = cellX + 27;
  const targetY = cellY + 24;
  const originX = cellX + 82;
  const originY = cellY + 14;
  const angleDeg = Math.atan2(targetY - originY, targetX - originX) * 180 / Math.PI;
  const distance = Math.hypot(targetX - originX, targetY - originY);
  const flashlightSrc = getPosterFlashlightImageSrc();
  return `
            <g transform="translate(${originX} ${originY}) rotate(${angleDeg})">
                <path d="M 2 -5 L 2 5 L ${distance} 22 L ${distance} -22 Z" fill="url(#posterTodayBeam)" />
                <circle cx="${distance - 2}" cy="0" r="38" fill="url(#posterTodaySpotlight)" />
                <image href="${flashlightSrc}" x="-30" y="-12" width="44" height="44" transform="rotate(226)" preserveAspectRatio="xMidYMid meet" />
            </g>
        `;
};
const escapeSvgText = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const POSTER_LOGO_FILENAME = 'LOGO修復檔.png';
const stripAfterWorkPosterPrefix = (name = '') => String(name || '').trim().replace(/^下班後走走[｜|｜\-－:：\s]*/u, '').replace(/^下班走走[｜|｜\-－:：\s]*/u, '').trim();
const toSafeDisplayText = (value, fallback = '') => {
  const safeFallback = (() => {
    if (fallback === null || fallback === undefined) return '';
    if (typeof fallback === 'string') return fallback;
    if (typeof fallback === 'number' || typeof fallback === 'boolean') return String(fallback);
    if (fallback instanceof Date) return fallback.toISOString();
    if (typeof fallback === 'object') {
      if (typeof fallback.label === 'string') return fallback.label;
      if (typeof fallback.name === 'string') return fallback.name;
      if (typeof fallback.value === 'string') return fallback.value;
      return '';
    }
    return String(fallback || '');
  })();
  if (value === null || value === undefined) return safeFallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof value.label === 'string') return value.label;
    if (typeof value.name === 'string') return value.name;
    if (typeof value.value === 'string') return value.value;
    return safeFallback;
  }
  return String(value || safeFallback);
};
const normalizeTagDefinitionsForDisplay = (definitions = DEFAULT_TAG_DEFS) => {
  const normalizeList = (items = []) => (Array.isArray(items) ? items : []).map(item => toSafeDisplayText(item, '').trim()).filter(Boolean);
  return {
    levels: normalizeList(definitions.levels || DEFAULT_TAG_DEFS.levels),
    types: normalizeList(definitions.types || DEFAULT_TAG_DEFS.types),
    locations: normalizeList(definitions.locations || DEFAULT_TAG_DEFS.locations)
  };
};
const buildTagRenameMap = (previousDefs = DEFAULT_TAG_DEFS, nextDefs = DEFAULT_TAG_DEFS) => {
  const prev = normalizeTagDefinitionsForDisplay(previousDefs);
  const next = normalizeTagDefinitionsForDisplay(nextDefs);
  return ['levels', 'types', 'locations'].reduce((map, type) => {
    map[type] = {};
    (prev[type] || []).forEach((oldValue, idx) => {
      const newValue = (next[type] || [])[idx];
      if (oldValue && newValue && oldValue !== newValue) map[type][oldValue] = newValue;
    });
    return map;
  }, {});
};
const applyTagRenamesToTags = (tags = {}, renameMap = {}) => {
  const nextTags = {
    ...(tags || {})
  };
  ['levels', 'types', 'locations'].forEach(type => {
    const currentValue = toSafeDisplayText(nextTags[type], '').trim();
    if (currentValue && renameMap?.[type]?.[currentValue]) nextTags[type] = renameMap[type][currentValue];
  });
  return nextTags;
};
const applyTagRenamesToConfig = (config = {}, renameMap = {}) => ({
  ...(config || {}),
  tags: applyTagRenamesToTags(config?.tags || {}, renameMap)
});
const normalizeStatusRulesForDisplay = (rules = DEFAULT_STATUS_RULES) => (Array.isArray(rules) ? rules : DEFAULT_STATUS_RULES).map(rule => ({
  ...rule,
  min: toSafeDisplayText(rule?.min, '0'),
  max: toSafeDisplayText(rule?.max, '999'),
  label: toSafeDisplayText(rule?.label, '報名中'),
  color: toSafeDisplayText(rule?.color, 'blue')
}));
const normalizeStatusRuleValue = value => String(value ?? '').trim();
const getStatusRulesSignature = rules => JSON.stringify(normalizeStatusRulesForDisplay(rules).map(rule => ({
  min: normalizeStatusRuleValue(rule.min),
  max: normalizeStatusRuleValue(rule.max),
  label: normalizeStatusRuleValue(rule.label),
  color: normalizeStatusRuleValue(rule.color)
})));
const DEFAULT_STATUS_RULES_SIGNATURE = getStatusRulesSignature(DEFAULT_STATUS_RULES);
const LEGACY_DEFAULT_STATUS_RULES_SIGNATURE = getStatusRulesSignature(LEGACY_DEFAULT_STATUS_RULES);
const hasCustomStatusRules = rules => Array.isArray(rules) && rules.length > 0 && getStatusRulesSignature(rules) !== DEFAULT_STATUS_RULES_SIGNATURE;
const LEGACY_LOW_STATUS_LABELS = ['報名中', '開放報名中', '舒適體驗｜8人以下'];
const LEGACY_MID_STATUS_LABELS = ['即將額滿', '即將額滿｜目前 X 人'];
const LEGACY_HIGH_STATUS_LABELS = ['已額滿', '額滿'];
const isLegacyLowStatusLabel = label => LEGACY_LOW_STATUS_LABELS.includes(label) || label.includes('報名');
const isLegacyMidStatusLabel = label => LEGACY_MID_STATUS_LABELS.includes(label) || label.includes('即將滿員') || label.includes('即將額滿');
const isLegacyHighStatusLabel = label => LEGACY_HIGH_STATUS_LABELS.includes(label) || label.includes('滿員') || label.includes('額滿');
const shouldRemoveStoredStatusRules = rules => {
  const normalized = normalizeStatusRulesForDisplay(rules);
  if (normalized.length === 1) {
    const only = normalized[0];
    const label = normalizeStatusRuleValue(only.label);
    const min = parseInt(only.min, 10);
    const max = parseInt(only.max, 10);
    const coversLowRange = (!Number.isFinite(min) || min <= 0) && (!Number.isFinite(max) || max >= 5);
    return coversLowRange && isLegacyLowStatusLabel(label);
  }
  const low = normalized.find(rule => {
    const min = parseInt(rule.min, 10);
    const max = parseInt(rule.max, 10);
    return (!Number.isFinite(min) || min <= 0) && Number.isFinite(max) && max >= 8 && isLegacyLowStatusLabel(normalizeStatusRuleValue(rule.label));
  });
  const mid = normalized.find(rule => {
    const min = parseInt(rule.min, 10);
    const max = parseInt(rule.max, 10);
    return Number.isFinite(min) && min >= 8 && min <= 9 && Number.isFinite(max) && max >= 10 && max <= 11 && isLegacyMidStatusLabel(normalizeStatusRuleValue(rule.label));
  });
  const high = normalized.find(rule => {
    const min = parseInt(rule.min, 10);
    const max = parseInt(rule.max, 10);
    return Number.isFinite(min) && min >= 12 && (!Number.isFinite(max) || max >= 12) && isLegacyHighStatusLabel(normalizeStatusRuleValue(rule.label));
  });
  const allRulesLookLegacy = normalized.every(rule => {
    const label = normalizeStatusRuleValue(rule.label);
    const min = parseInt(rule.min, 10);
    const max = parseInt(rule.max, 10);
    if ((!Number.isFinite(min) || min <= 0) && Number.isFinite(max) && max >= 8) return isLegacyLowStatusLabel(label);
    if (Number.isFinite(min) && min >= 8 && min <= 9 && Number.isFinite(max) && max >= 10 && max <= 11) return isLegacyMidStatusLabel(label);
    if (Number.isFinite(min) && min >= 12 && (!Number.isFinite(max) || max >= 12)) return isLegacyHighStatusLabel(label);
    return false;
  });
  return !!low && allRulesLookLegacy && (normalized.length <= 2 || !!mid || !!high);
};
const normalizeStoredStatusRules = rules => {
  const normalized = normalizeStatusRulesForDisplay(rules);
  return getStatusRulesSignature(normalized) === LEGACY_DEFAULT_STATUS_RULES_SIGNATURE || shouldRemoveStoredStatusRules(normalized) ? [] : normalized;
};
const formatStatusRuleLabel = (label, participantCount, capacity = 12) => {
  const rawLabel = toSafeDisplayText(label, '報名中').trim() || '報名中';
  const fullThreshold = Math.max(1, parseInt(capacity, 10) || 12);
  const remaining = Math.max(fullThreshold - (parseInt(participantCount, 10) || 0), 0);
  return rawLabel.replace(/\{count\}/g, String(participantCount)).replace(/\{remaining\}/g, String(remaining)).replace(/\[remaining\]/g, String(remaining)).replace(/X/g, String(participantCount));
};
const getMatchingStatusRule = (participantCount, configRules, globalRules) => {
  const candidateRules = Array.isArray(configRules) && configRules.length > 0 ? configRules : Array.isArray(globalRules) && globalRules.length > 0 ? globalRules : [];
  return normalizeStoredStatusRules(candidateRules).find(rule => {
    const min = Number.isFinite(parseInt(rule.min, 10)) ? parseInt(rule.min, 10) : 0;
    const max = Number.isFinite(parseInt(rule.max, 10)) ? parseInt(rule.max, 10) : Infinity;
    return participantCount >= min && participantCount <= max;
  }) || null;
};
const sanitizeFirebaseValue = value => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => sanitizeFirebaseValue(item));
  if (typeof value === 'object') {
    if (value._delegate) return '';
    if (typeof value.toDate === 'function') {
      try {
        return value.toDate().toISOString();
      } catch (_) {
        return '';
      }
    }
    const sanitized = {};
    Object.entries(value).forEach(([key, child]) => {
      const nextValue = sanitizeFirebaseValue(child);
      if (nextValue !== undefined) sanitized[key] = nextValue;
    });
    return sanitized;
  }
  if (typeof value === 'function') return '';
  return String(value);
};
const normalizeEventConfigForDisplay = (config = {}) => {
  const rawTags = config?.tags || {};
  const rawRules = Array.isArray(config?.statusRules) ? config.statusRules : [];
  return {
    ...config,
    displayName: toSafeDisplayText(config.displayName, ''),
    activityCategory: toSafeDisplayText(config.activityCategory, ''),
    time: toSafeDisplayText(config.time, ''),
    timeSlot: normalizeScheduleTimeSlot(config.timeSlot, inferScheduleTimeSlot(config.time)),
    link: toSafeDisplayText(config.link, ''),
    note: toSafeDisplayText(config.note, ''),
    backendColor: toSafeDisplayText(config.backendColor, ''),
    carpoolDisplayMode: toSafeDisplayText(config.carpoolDisplayMode, ''),
    isPrivateGroupEvent: !!config.isPrivateGroupEvent,
    privateGroupLabel: toSafeDisplayText(config.privateGroupLabel, '此為包團活動') || '此為包團活動',
    tags: {
      levels: toSafeDisplayText(rawTags.levels, ''),
      types: toSafeDisplayText(rawTags.types, ''),
      locations: toSafeDisplayText(rawTags.locations, '')
    },
    statusRules: normalizeStoredStatusRules(rawRules)
  };
};
const buildPublicEventConfigCacheEntry = (config = {}) => {
  const normalized = normalizeEventConfigForDisplay(sanitizeFirebaseValue(config || {}));
  return {
    displayName: normalized.displayName || '',
    activityCategory: normalized.activityCategory || '',
    time: normalized.time || '',
    timeSlot: normalized.timeSlot || inferScheduleTimeSlot(normalized.time),
    link: normalized.link || '',
    capacity: normalized.capacity ?? '',
    duration: normalized.duration ?? '',
    prepDays: normalized.prepDays ?? '',
    prepTime: normalized.prepTime || '',
    tags: normalized.tags || {
      levels: '',
      types: '',
      locations: ''
    },
    statusRules: normalizeStoredStatusRules(normalized.statusRules || []),
    isCancelled: !!normalized.isCancelled,
    carpoolDisplayMode: normalized.carpoolDisplayMode || '',
    isPrivateGroupEvent: !!normalized.isPrivateGroupEvent,
    privateGroupLabel: normalized.privateGroupLabel || '此為包團活動'
  };
};
const resolvePosterEventName = (evt = {}, cfg = {}, posterNameOverrides = []) => {
  const rawInternalName = String(evt?.eventName || cfg?.eventName || '').trim();
  const rawDisplayName = String(cfg?.displayName || '').trim();
  const rawCategoryName = String(cfg?.activityCategory || '').trim();
  const normalizeNameKey = value => String(value || '').trim().replace(/\s+/g, '');
  const overrideMap = new Map(normalizePosterNameOverrides(posterNameOverrides).map(item => [normalizeNameKey(item.sourceName), item.posterName]));
  const overrideName = overrideMap.get(normalizeNameKey(rawInternalName)) || overrideMap.get(normalizeNameKey(rawDisplayName)) || overrideMap.get(normalizeNameKey(rawCategoryName));
  if (overrideName) return overrideName;
  const bucket = inferSchedulePosterBucket(evt, cfg);
  const exactReserved = ['預定中', '包團'];
  if (exactReserved.includes(rawInternalName)) return rawInternalName;
  if (exactReserved.includes(rawDisplayName)) return rawDisplayName;
  if (exactReserved.includes(rawCategoryName)) return rawCategoryName;
  if (bucket === 'afterWork') {
    const candidate = stripAfterWorkPosterPrefix(rawInternalName) || stripAfterWorkPosterPrefix(rawDisplayName);
    if (candidate) return candidate;
  }
  return rawInternalName || rawDisplayName || rawCategoryName || '未命名活動';
};
const buildMonthlySchedulePosterData = ({
  currentDate,
  events,
  eventConfigs,
  posterNameOverrides = []
}) => {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const todayParts = getLocalDateStr().split('-').map(value => parseInt(value, 10));
  const todayYear = todayParts[0];
  const todayMonth = todayParts[1];
  const todayDate = todayParts[2];
  const dedupedMap = new Map();
  Object.values(events || {}).forEach(evt => {
    if (!evt?.date) return;
    const cfg = eventConfigs?.[evt.key] || {};
    if (cfg.isCancelled) return;
    const displayName = resolvePosterEventName(evt, cfg, posterNameOverrides);
    const time = String(cfg.time || '').trim();
    if (!displayName) return;
    const bucket = inferSchedulePosterBucket(evt, cfg);
    const duration = Math.max(1, parseInt(cfg.duration, 10) || 1);
    const baseDate = new Date(`${String(evt.date).trim()}T00:00:00`);
    if (Number.isNaN(baseDate.getTime())) return;
    for (let dayOffset = 0; dayOffset < duration; dayOffset += 1) {
      const occurrenceDate = new Date(baseDate);
      occurrenceDate.setDate(baseDate.getDate() + dayOffset);
      const occurrenceKey = [occurrenceDate.getFullYear(), String(occurrenceDate.getMonth() + 1).padStart(2, '0'), String(occurrenceDate.getDate()).padStart(2, '0')].join('-');
      if (!occurrenceKey.startsWith(monthKey)) continue;
      const dedupeKey = `${occurrenceKey}__${displayName}__${time}`;
      if (!dedupedMap.has(dedupeKey)) {
        dedupedMap.set(dedupeKey, {
          date: occurrenceKey,
          day: occurrenceDate.getDate(),
          displayName,
          bucket
        });
      }
    }
  });
  const entries = Array.from(dedupedMap.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (POSTER_BUCKET_META[a.bucket]?.order ?? 99) - (POSTER_BUCKET_META[b.bucket]?.order ?? 99) || a.displayName.localeCompare(b.displayName, 'zh-Hant'));
  const days = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const weekRows = Math.ceil((firstDay + days) / 7);
  const byDay = {};
  entries.forEach(entry => {
    if (!byDay[entry.day]) byDay[entry.day] = [];
    byDay[entry.day].push(entry);
  });
  const legendBuckets = ['theme', 'afterWork', 'special'].filter(bucket => entries.some(entry => entry.bucket === bucket)).map(bucket => ({
    ...POSTER_BUCKET_META[bucket]
  }));
  return {
    year,
    month,
    monthKey,
    monthLabel: MONTH_LABELS_ZH[month],
    title: `${MONTH_LABELS_ZH[month]}月出團月曆`,
    footnote: '＊ 活動日期以訂票網站為主',
    weekRows,
    firstDay,
    days,
    entries,
    byDay,
    entryCount: entries.length,
    legendBuckets,
    generatedDateLabel: getLocalDateStr().replace(/-/g, '.'),
    todayDay: Number.isFinite(todayYear) && Number.isFinite(todayMonth) && Number.isFinite(todayDate) && todayYear === year && todayMonth === month + 1 ? todayDate : null
  };
};
const buildPosterActivityOptions = posterData => {
  const optionMap = new Map();
  (posterData?.entries || []).forEach(entry => {
    const safeName = String(entry?.displayName || '').trim() || '未命名活動';
    const safeBucket = String(entry?.bucket || 'special');
    const safeDay = Number(entry?.day) || 0;
    const current = optionMap.get(safeName);
    if (!current) {
      optionMap.set(safeName, {
        name: safeName,
        bucket: safeBucket,
        bucketLabel: String(POSTER_BUCKET_META[safeBucket]?.label || '其他活動'),
        count: 1,
        days: safeDay ? [safeDay] : []
      });
      return;
    }
    current.count += 1;
    if (safeDay && !current.days.includes(safeDay)) current.days.push(safeDay);
  });
  return Array.from(optionMap.values()).map(option => ({
    ...option,
    days: option.days.slice().sort((a, b) => a - b),
    daysLabel: option.days.slice().sort((a, b) => a - b).join('、') || '-'
  })).sort((a, b) => (POSTER_BUCKET_META[a.bucket]?.order ?? 99) - (POSTER_BUCKET_META[b.bucket]?.order ?? 99) || String(a.name).localeCompare(String(b.name), 'zh-Hant'));
};
const filterMonthlySchedulePosterData = (posterData, selectedNames) => {
  const allowSet = new Set((selectedNames || []).map(name => String(name).trim()).filter(Boolean));
  const entries = (posterData?.entries || []).filter(entry => allowSet.has(entry.displayName));
  const byDay = {};
  entries.forEach(entry => {
    if (!byDay[entry.day]) byDay[entry.day] = [];
    byDay[entry.day].push(entry);
  });
  const legendBuckets = ['theme', 'afterWork', 'special'].filter(bucket => entries.some(entry => entry.bucket === bucket)).map(bucket => ({
    ...POSTER_BUCKET_META[bucket]
  }));
  return {
    ...posterData,
    entries,
    byDay,
    entryCount: entries.length,
    legendBuckets
  };
};
const buildMonthlySchedulePosterHtmlParts = (posterData, options = {}) => {
  const renderTarget = options.renderTarget === 'png' ? 'png' : 'html';
  const posterWalkImageSrc = getPosterWalkImageSrc();
  const posterBottomImageSrc = getPosterBottomImageSrc();
  const posterLogoImageSrc = getPosterLogoImageSrc();
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdayMarkup = weekdays.map(label => `<div class="calendar-weekday">${escapeSvgText(label)}</div>`).join('');
  const maxVisibleEvents = 3;
  const dayCells = [];
  for (let row = 0; row < posterData.weekRows; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const index = row * 7 + col;
      const dayNumber = index - posterData.firstDay + 1;
      if (dayNumber < 1 || dayNumber > posterData.days) {
        dayCells.push('<div class="day-cell day-cell-empty"></div>');
        continue;
      }
      const entries = posterData.byDay[dayNumber] || [];
      const entryMarkup = entries.slice(0, maxVisibleEvents).map(entry => `
                        <div class="event-item event-item-${entry.bucket}">
                            ${escapeSvgText(fitPosterEventName(entry.displayName, 10))}
                        </div>
                    `).join('');
      const moreMarkup = entries.length > maxVisibleEvents ? `<div class="day-more">+${entries.length - maxVisibleEvents} 場</div>` : '';
      dayCells.push(`
                        <div class="day-cell">
                            <div class="day-number">${dayNumber}</div>
                            <div class="event-list">${entryMarkup}${moreMarkup}</div>
                        </div>
                    `);
    }
  }
  const styleMarkup = `
    :root { color-scheme: light; }
    html, body { margin: 0; padding: 0; }
    * { box-sizing: border-box; }
    .poster-root {
      margin: 0;
      padding: 24px;
      background: #d2dbe0;
      font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
      color: #fffdf5;
      width: 1128px;
    }
    .poster-page {
      width: 1080px;
      min-height: 1350px;
      margin: 0 auto;
      background: #43555d;
      position: relative;
      padding: 28px 46px 34px;
    }
    .poster-notice {
      position: absolute;
      top: 24px;
      right: 36px;
      text-align: right;
      color: rgba(255, 255, 255, 0.92);
      font-weight: 700;
      font-size: 20px;
      letter-spacing: 0.02em;
    }
    .poster-title-row {
      margin: 58px auto 58px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #f9f5de;
      width: 864px;
      min-height: 110px;
      border: 4px solid #f1ebd7;
      border-radius: 18px;
      padding: 16px 28px;
    }
    .poster-title-group {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 18px;
      margin: 0 auto;
      max-width: 100%;
    }
    .poster-title {
      position: relative;
      top: 6px;
      font-size: 72px;
      font-weight: 900;
      line-height: 1;
      letter-spacing: 0.12em;
      text-shadow: 6px 6px 0 rgba(29, 40, 44, 0.55);
      white-space: nowrap;
    }
    .poster-root-png .poster-title {
      top: -30px;
    }
    .poster-title-emoji {
      width: 132px;
      height: 118px;
      position: relative;
      overflow: hidden;
      flex: 0 0 auto;
      background-image: url("${posterWalkImageSrc}");
      background-repeat: no-repeat;
      background-size: 1080px auto;
      background-position: -474px -742px;
    }
    .calendar-grid {
      margin-top: 8px;
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      border-top: 6px solid #43555d;
      border-left: 6px solid #43555d;
      background: #fffdfb;
    }
    .calendar-weekday, .day-cell {
      border-right: 6px solid #43555d;
      border-bottom: 6px solid #43555d;
    }
    .calendar-weekday {
      min-height: 68px;
      background: #f3e6da;
      color: #42535b;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: 700;
    }
    .day-cell {
      min-height: 124px;
      background: #fffdfb;
      position: relative;
      overflow: hidden;
      padding: 10px 10px 10px 12px;
    }
    .day-number {
      position: relative;
      z-index: 2;
      color: #4e565b;
      font-size: 20px;
      font-weight: 500;
      line-height: 1;
    }
    .event-list {
      position: relative;
      z-index: 2;
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .event-item {
      display: block;
      font-size: 18px;
      font-weight: 500;
      line-height: 1.15;
    }
    .event-item-theme { color: ${POSTER_BUCKET_META.theme.color}; }
    .event-item-afterWork { color: ${POSTER_BUCKET_META.afterWork.color}; }
    .event-item-special { color: ${POSTER_BUCKET_META.special.color}; }
    .day-more {
      color: #64748b;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.1;
    }
    .poster-bottom-art {
      width: 932px;
      height: 216px;
      margin: 68px auto 0;
      position: relative;
      overflow: hidden;
      background-image: url("${posterBottomImageSrc}");
      background-repeat: no-repeat;
      background-size: 1080px auto;
      background-position: -62px -263px;
    }
    .poster-footer {
      margin-top: 28px;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 32px;
      padding: 0 2px 0 4px;
    }
    .date-badge-value {
      color: #fffdf5;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: 0.01em;
      line-height: 1;
      text-shadow: 0 2px 0 rgba(29, 40, 44, 0.25);
    }
    .poster-logo {
      width: 168px;
      height: auto;
      display: block;
    }`;
  const bodyMarkup = `
  <div class="poster-root ${renderTarget === 'png' ? 'poster-root-png' : ''}">
    <div class="poster-page">
      <div class="poster-notice">${escapeSvgText(posterData.footnote)}</div>
      <div class="poster-title-row">
        <div class="poster-title-group">
          <div class="poster-title">${escapeSvgText(posterData.title)}</div>
          <div class="poster-title-emoji" aria-label="Walking icon"></div>
        </div>
      </div>
      <div class="calendar-grid">
        ${weekdayMarkup}
        ${dayCells.join('')}
      </div>
      <div class="poster-bottom-art" aria-label="Poster bottom section"></div>
        <div class="poster-footer">
        <div class="date-badge-value">${escapeSvgText(posterData.generatedDateLabel)} 製</div>
        <img class="poster-logo" src="${posterLogoImageSrc}" alt="TPHA Logo" />
      </div>
    </div>
  </div>`;
  return {
    styleMarkup,
    bodyMarkup
  };
};
const renderMonthlySchedulePosterCanvas = async posterData => {
  const {
    styleMarkup,
    bodyMarkup
  } = buildMonthlySchedulePosterHtmlParts(posterData, {
    renderTarget: 'png'
  });
  const html2canvas = await ensureHtml2CanvasLoaded();
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-20000px';
  host.style.top = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '-1';
  host.innerHTML = `<style>${styleMarkup}</style>${bodyMarkup}`;
  document.body.appendChild(host);
  try {
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {}
    }
    await Promise.all([loadImageForCanvas(getPosterWalkImageSrc()), loadImageForCanvas(getPosterBottomImageSrc()), loadImageForCanvas(getPosterLogoImageSrc())]);
    await Promise.all(Array.from(host.querySelectorAll('img')).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const root = host.querySelector('.poster-root');
    if (!root) throw new Error('HTML 海報模板建立失敗');
    const bounds = root.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    return await html2canvas(root, {
      backgroundColor: null,
      useCORS: true,
      allowTaint: false,
      foreignObjectRendering: false,
      imageTimeout: 0,
      windowWidth: width,
      windowHeight: height,
      scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
      logging: false
    });
  } finally {
    document.body.removeChild(host);
  }
};
const buildMonthlySchedulePosterSvg = posterData => {
  const width = 1240;
  const height = 1600;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const gridX = 70;
  const gridY = 300;
  const gridW = width - 140;
  const headerH = 56;
  const cellW = gridW / 7;
  const cellH = 170;
  const maxVisibleEvents = 3;
  const weekdayCells = weekdays.map((label, index) => {
    const x = gridX + index * cellW;
    return `
                    <rect x="${x}" y="${gridY}" width="${cellW}" height="${headerH}" fill="#f7efe8" stroke="#48555a" stroke-width="3" />
                    <text x="${x + cellW / 2}" y="${gridY + 37}" fill="#5b5b5b" font-size="24" font-weight="700" text-anchor="middle">${escapeSvgText(label)}</text>
                `;
  }).join('');
  const dayCells = [];
  for (let row = 0; row < posterData.weekRows; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const index = row * 7 + col;
      const dayNumber = index - posterData.firstDay + 1;
      const x = gridX + col * cellW;
      const y = gridY + headerH + row * cellH;
      let cellMarkup = `
                        <rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="#fffdfb" stroke="#48555a" stroke-width="3" />
                    `;
      if (dayNumber >= 1 && dayNumber <= posterData.days) {
        if (posterData.todayDay === dayNumber) {
          cellMarkup += buildPosterFlashlightSvgMarkup(x, y);
        }
        cellMarkup += `
                            <text x="${x + 14}" y="${y + 32}" fill="${posterData.todayDay === dayNumber ? '#2f3135' : '#5b5b5b'}" font-size="25" font-weight="500">${dayNumber}</text>
                        `;
        const entries = posterData.byDay[dayNumber] || [];
        entries.slice(0, maxVisibleEvents).forEach((entry, entryIndex) => {
          const bucketMeta = POSTER_BUCKET_META[entry.bucket] || POSTER_BUCKET_META.special;
          const lineY = y + 64 + entryIndex * 30;
          cellMarkup += `
                                <text x="${x + 16}" y="${lineY}" fill="${bucketMeta.color}" font-size="20" font-weight="700">${escapeSvgText(fitPosterEventName(entry.displayName, 10))}</text>
                            `;
        });
        if (entries.length > maxVisibleEvents) {
          cellMarkup += `
                                <text x="${x + 16}" y="${y + 64 + maxVisibleEvents * 30}" fill="#64748b" font-size="18" font-weight="700">+${entries.length - maxVisibleEvents} 場</text>
                            `;
        }
      }
      dayCells.push(cellMarkup);
    }
  }
  const legendY = gridY + headerH + posterData.weekRows * cellH + 56;
  const legendStartX = 130;
  const legendRowWidth = width - legendStartX * 2;
  const legendSlotWidth = legendRowWidth / Math.max(1, posterData.legendBuckets.length);
  const legendItems = posterData.legendBuckets.map((bucket, index) => {
    const slotX = legendStartX + index * legendSlotWidth;
    const circleX = slotX + 18;
    const circleY = legendY - 2;
    return `
  <circle cx="${circleX}" cy="${circleY}" r="16" fill="${bucket.color}" stroke="#ffffff" stroke-width="4" />
  <text x="${circleX + 30}" y="${legendY + 12}" fill="#fffdf5" font-size="38" font-weight="900">${escapeSvgText(bucket.label)}</text>`;
  }).join('');
  const titleGroupCenterX = width / 2;
  const titleGroupGap = 16;
  const emojiWidth = 56;
  const approxTitleWidth = Math.max(180, posterData.title.length * 52);
  const titleCenterX = titleGroupCenterX - (titleGroupGap + emojiWidth) / 2;
  const emojiCenterX = titleGroupCenterX + (titleGroupGap + approxTitleWidth) / 2;
  const topNoticeMarkup = getPosterTopNoticeLines(posterData).map((line, index) => `
  <text x="${width - 90}" y="${62 + index * 28}" fill="rgba(255,255,255,0.92)" font-size="${index === 0 ? 22 : 20}" font-weight="700" text-anchor="end">${escapeSvgText(line)}</text>`).join('');
  const dateBadgeX = 56;
  const dateBadgeY = height - 126;
  const dateBadgeW = 292;
  const dateBadgeH = 76;
  const logoWidth = 170;
  const logoHeight = Math.round(logoWidth * 652 / 1938);
  const posterLogoImageSrc = getPosterLogoImageSrc();
  const spotlightDefs = posterData.todayDay ? `
  <defs>
    <linearGradient id="posterTodayBeam" x1="0%" y1="50%" x2="100%" y2="50%">
      <stop offset="0%" stop-color="#fff7c7" stop-opacity="0.16" />
      <stop offset="34%" stop-color="#ffea8e" stop-opacity="0.38" />
      <stop offset="100%" stop-color="#ffe076" stop-opacity="0.02" />
    </linearGradient>
    <radialGradient id="posterTodaySpotlight" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff8d2" stop-opacity="0.98" />
      <stop offset="34%" stop-color="#fff1aa" stop-opacity="0.74" />
      <stop offset="72%" stop-color="#ffeb92" stop-opacity="0.22" />
      <stop offset="100%" stop-color="#ffeb92" stop-opacity="0" />
    </radialGradient>
  </defs>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${spotlightDefs}
  <rect width="${width}" height="${height}" fill="#3f4d52" />
  ${topNoticeMarkup}
  <text x="${titleCenterX}" y="182" fill="#fffdf5" font-size="56" font-weight="900" text-anchor="middle">${escapeSvgText(posterData.title)}</text>
  <text x="${emojiCenterX}" y="182" fill="#fffdf5" font-size="56" text-anchor="middle">🚶</text>
  ${weekdayCells}
  ${dayCells.join('')}
  ${legendItems}
  <rect x="${dateBadgeX}" y="${dateBadgeY}" width="${dateBadgeW}" height="${dateBadgeH}" fill="rgba(255,253,245,0.96)" stroke="rgba(255,255,255,0.95)" stroke-width="3" />
  <text x="${dateBadgeX + 18}" y="${dateBadgeY + 25}" fill="#4a5960" font-size="18" font-weight="800">輸出日期</text>
  <text x="${dateBadgeX + 18}" y="${dateBadgeY + 58}" fill="#243238" font-size="34" font-weight="900">${escapeSvgText(posterData.generatedDateLabel)}</text>
  <image href="${posterLogoImageSrc}" x="${width - logoWidth - 70}" y="${height - logoHeight - 32}" width="${logoWidth}" height="${logoHeight}" preserveAspectRatio="xMidYMid meet" />
</svg>`;
};
const buildMonthlySchedulePosterHtmlDocument = posterData => {
  const {
    styleMarkup,
    bodyMarkup
  } = buildMonthlySchedulePosterHtmlParts(posterData, {
    renderTarget: 'html'
  });
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeSvgText(posterData.title)}</title>
  <style>${styleMarkup}</style>
</head>
<body>
  ${bodyMarkup}
</body>
</html>`;
};
const escapeSpreadsheetXml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const normalizeWorksheetName = (value, fallback = 'Sheet1') => {
  const cleaned = String(value || '').replace(/[\\/*?:\[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || fallback;
};
const buildExcelWorkbookXml = (worksheets = []) => {
  const worksheetXml = worksheets.map((sheet, sheetIndex) => {
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    const rowsXml = rows.map(row => {
      const isRowObject = row && typeof row === 'object' && !Array.isArray(row);
      const cells = Array.isArray(row) ? row : Array.isArray(row?.cells) ? row.cells : [];
      const heightAttr = isRowObject && row.height ? ` ss:Height="${Number(row.height) || 18}"` : '';
      const cellsXml = cells.map(cell => {
        const isCellObject = cell && typeof cell === 'object' && !Array.isArray(cell);
        const rawValue = isCellObject ? cell.value : cell;
        const isNumber = typeof rawValue === 'number' && Number.isFinite(rawValue);
        const type = isNumber ? 'Number' : 'String';
        const value = isNumber ? String(rawValue) : escapeSpreadsheetXml(rawValue);
        const styleAttr = isCellObject && cell.style ? ` ss:StyleID="${escapeSpreadsheetXml(cell.style)}"` : '';
        return `<Cell${styleAttr}><Data ss:Type="${type}">${value}</Data></Cell>`;
      }).join('');
      return `<Row${heightAttr}>${cellsXml}</Row>`;
    }).join('');
    const columnsXml = Array.isArray(sheet?.columns) ? sheet.columns.map(column => `<Column ss:Width="${Number(column?.width) || 90}"/>`).join('') : '';
    return `<Worksheet ss:Name="${escapeSpreadsheetXml(normalizeWorksheetName(sheet?.name, `Sheet${sheetIndex + 1}`))}"><Table>${columnsXml}${rowsXml}</Table></Worksheet>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Author>Codex</Author></DocumentProperties>
<ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><ProtectStructure>False</ProtectStructure><ProtectWindows>False</ProtectWindows></ExcelWorkbook>
<Styles>
  <Style ss:ID="header"><Font ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#F3F4F6" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="date"><Font ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>
  <Style ss:ID="rest"><Font ss:Bold="1" ss:Color="#9A3412"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FCE4D6" ss:Pattern="Solid"/></Style>
  <Style ss:ID="follow"><Font ss:Bold="1" ss:Color="#15803D"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/></Style>
  <Style ss:ID="event"><Font ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/></Style>
  <Style ss:ID="cancelled"><Font ss:Bold="1" ss:Color="#666666"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Interior ss:Color="#D9D9D9" ss:Pattern="Solid"/></Style>
  <Style ss:ID="outing"><Font ss:Bold="1" ss:Color="#92400E"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/></Style>
  <Style ss:ID="blank"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#EDE9FE" ss:Pattern="Solid"/></Style>
  <Style ss:ID="markerO"><Font ss:Bold="1" ss:Color="#3F6212"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#E2F0D9" ss:Pattern="Solid"/></Style>
  <Style ss:ID="markerV"><Font ss:Bold="1" ss:Color="#A16207"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/></Style>
</Styles>
${worksheetXml}
</Workbook>`;
};
const downloadExcelWorkbook = (worksheets, filename = 'export.xls') => {
  const xmlContent = buildExcelWorkbookXml(worksheets);
  const blob = new Blob([xmlContent], {
    type: 'application/vnd.ms-excel;charset=utf-8;'
  });
  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
const NavItem = ({
  id,
  icon,
  label,
  activeTab,
  setActiveTab,
  onClick,
  collapsed = false
}) => React.createElement("button", {
  title: collapsed ? label : '',
  onClick: () => {
    setActiveTab(id);
    if (onClick) onClick();
  },
  className: `flex items-center py-3 rounded-xl transition-all duration-200 w-full ${collapsed ? 'justify-center px-3' : 'space-x-3 px-4 text-left'} ${activeTab === id ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'text-slate-500 hover:bg-white hover:shadow-sm'}`
}, React.createElement(Icon, {
  name: icon,
  size: 20
}), !collapsed && React.createElement("span", {
  className: "font-medium tracking-wide"
}, label));
const CircularProgress = ({
  value,
  max,
  color = "text-blue-600",
  size = 60,
  strokeWidth = 5
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const safeValue = Math.min(Math.max(value, 0), max);
  const offset = circumference - safeValue / max * circumference;
  return React.createElement("div", {
    className: "relative flex items-center justify-center",
    style: {
      width: size,
      height: size
    }
  }, React.createElement("svg", {
    className: "transform -rotate-90 w-full h-full"
  }, React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: radius,
    stroke: "currentColor",
    strokeWidth: strokeWidth,
    fill: "transparent",
    className: "text-slate-100"
  }), React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: radius,
    stroke: "currentColor",
    strokeWidth: strokeWidth,
    fill: "transparent",
    strokeDasharray: circumference,
    strokeDashoffset: offset,
    strokeLinecap: "round",
    className: `${color} transition-all duration-1000 ease-out`
  })), React.createElement("div", {
    className: "absolute text-[10px] font-bold text-slate-600"
  }, Math.round(safeValue / max * 100), "%"));
};
const LoginModal = ({
  onClose,
  onLogin
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const handleSubmit = e => {
    e.preventDefault();
    onLogin(password, isSuccess => {
      if (!isSuccess) setError(true);
    });
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-sm p-8 shadow-2xl"
  }, React.createElement("div", {
    className: "flex flex-col items-center mb-6"
  }, React.createElement("div", {
    className: "w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 mb-3"
  }, React.createElement(Icon, {
    name: "lock",
    size: 24
  })), React.createElement("h3", {
    className: "text-xl font-bold text-slate-800"
  }, "\u7BA1\u7406\u54E1\u767B\u5165"), React.createElement("p", {
    className: "text-sm text-slate-500 text-center"
  }, "\u8ACB\u8F38\u5165\u5BC6\u78BC\u4EE5\u5B58\u53D6\u5F8C\u53F0\uFF0C\u82E5\u6709\u8A2D\u5B9A\u500B\u4EBA\u5BC6\u78BC\uFF0C\u767B\u5165\u5F8C\u6703\u81EA\u52D5\u5E36\u5165\u64CD\u4F5C\u4EBA\u3002")), React.createElement("form", {
    onSubmit: handleSubmit,
    className: "space-y-4"
  }, React.createElement("div", null, React.createElement("input", {
    type: "password",
    className: `w-full p-3 border rounded-xl outline-none transition-all text-center tracking-widest font-bold text-lg ${error ? 'border-red-500 bg-red-50' : 'border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200'}`,
    placeholder: "\u8F38\u5165\u5BC6\u78BC",
    value: password,
    onChange: e => {
      setPassword(e.target.value);
      setError(false);
    },
    autoFocus: true
  }), error && React.createElement("p", {
    className: "text-red-500 text-xs text-center mt-2"
  }, "\u5BC6\u78BC\u932F\u8AA4\uFF0C\u8ACB\u91CD\u8A66")), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    type: "button",
    onClick: onClose,
    className: "flex-1 py-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
  }, "\u53D6\u6D88"), React.createElement("button", {
    type: "submit",
    className: "flex-1 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold shadow-md transition-colors"
  }, "\u767B\u5165")))));
};
const AddPromiseModal = ({
  onClose,
  onSave
}) => {
  const [form, setForm] = useState({
    content: '',
    who: '',
    date: getLocalDateStr(),
    time: '12:00'
  });
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, React.createElement("h3", {
    className: "text-xl font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "message-square",
    className: "text-purple-500"
  }), " \u65B0\u589E\u627F\u8AFE"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "space-y-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5167\u5BB9"), React.createElement("textarea", {
    className: "w-full p-3 border rounded-xl resize-none h-24",
    value: form.content,
    onChange: e => setForm({
      ...form,
      content: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5C0D\u8C61"), React.createElement("input", {
    type: "text",
    className: "w-full p-3 border rounded-xl",
    value: form.who,
    onChange: e => setForm({
      ...form,
      who: e.target.value
    })
  })), React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, React.createElement("input", {
    type: "date",
    className: "w-full p-3 border rounded-xl",
    value: form.date,
    onChange: e => setForm({
      ...form,
      date: e.target.value
    })
  }), React.createElement("input", {
    type: "time",
    className: "w-full p-3 border rounded-xl",
    value: form.time,
    onChange: e => setForm({
      ...form,
      time: e.target.value
    })
  })), React.createElement("button", {
    onClick: () => {
      if (!form.content) return;
      onSave(form);
    },
    className: "w-full py-3 bg-purple-600 text-white rounded-xl font-bold shadow-lg shadow-purple-200 mt-2"
  }, "\u5EFA\u7ACB"))));
};
const ProjectTaskEditModal = ({
  task,
  phaseId,
  onClose,
  onSave
}) => {
  const [form, setForm] = useState({
    title: task.title,
    assignee: task.assignee || '',
    dueDate: task.dueDate || ''
  });
  const [kpi, setKpi] = useState(task.kpi || {
    name: '',
    target: '',
    current: '',
    unit: ''
  });
  const [notes, setNotes] = useState(task.notes || []);
  const [newNote, setNewNote] = useState('');
  const handleAddNote = () => {
    if (!newNote.trim()) return;
    const note = {
      id: Date.now(),
      content: newNote,
      date: new Date().toLocaleString()
    };
    setNotes([note, ...notes]);
    setNewNote('');
  };
  const handleSave = () => {
    const updatedTask = {
      ...task,
      ...form,
      kpi,
      notes
    };
    onSave(phaseId, task.id, updatedTask);
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto flex flex-col"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, React.createElement("h3", {
    className: "text-xl font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "edit-3",
    className: "text-blue-500"
  }), " \u7DE8\u8F2F\u4EFB\u52D9"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "space-y-6 flex-1 overflow-y-auto pr-2"
  }, React.createElement("div", {
    className: "space-y-3"
  }, React.createElement("h4", {
    className: "text-sm font-bold text-slate-700 border-b pb-1"
  }, "\u57FA\u672C\u8CC7\u8A0A"), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u4EFB\u52D9\u540D\u7A31"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    value: form.title,
    onChange: e => setForm({
      ...form,
      title: e.target.value
    })
  })), React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8CA0\u8CAC\u4EBA"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    value: form.assignee,
    onChange: e => setForm({
      ...form,
      assignee: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u622A\u6B62\u65E5\u671F"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg text-sm",
    value: form.dueDate,
    onChange: e => setForm({
      ...form,
      dueDate: e.target.value
    })
  })))), React.createElement("div", {
    className: "space-y-3 bg-blue-50 p-4 rounded-xl border border-blue-100"
  }, React.createElement("h4", {
    className: "text-sm font-bold text-blue-700 border-b border-blue-200 pb-1 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "target",
    size: 14
  }), " KPI \u8A2D\u5B9A"), React.createElement("div", {
    className: "grid grid-cols-3 gap-3"
  }, React.createElement("div", {
    className: "col-span-3"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-blue-600 mb-1"
  }, "\u76EE\u6A19\u540D\u7A31"), React.createElement("input", {
    type: "text",
    placeholder: "\u4F8B\u5982: \u89F8\u53CA\u4EBA\u6578",
    className: "w-full p-2 border border-blue-200 rounded-lg text-sm",
    value: kpi.name,
    onChange: e => setKpi({
      ...kpi,
      name: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-blue-600 mb-1"
  }, "\u76EE\u6A19\u503C"), React.createElement("input", {
    type: "number",
    placeholder: "100",
    className: "w-full p-2 border border-blue-200 rounded-lg text-sm",
    value: kpi.target,
    onChange: e => setKpi({
      ...kpi,
      target: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-blue-600 mb-1"
  }, "\u76EE\u524D\u9032\u5EA6"), React.createElement("input", {
    type: "number",
    placeholder: "50",
    className: "w-full p-2 border border-blue-200 rounded-lg text-sm",
    value: kpi.current,
    onChange: e => setKpi({
      ...kpi,
      current: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-blue-600 mb-1"
  }, "\u55AE\u4F4D"), React.createElement("input", {
    type: "text",
    placeholder: "\u4EBA",
    className: "w-full p-2 border border-blue-200 rounded-lg text-sm",
    value: kpi.unit,
    onChange: e => setKpi({
      ...kpi,
      unit: e.target.value
    })
  })))), React.createElement("div", {
    className: "space-y-3"
  }, React.createElement("h4", {
    className: "text-sm font-bold text-slate-700 border-b pb-1 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "file-text",
    size: 14
  }), " \u5099\u8A3B\u7D00\u9304"), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("input", {
    type: "text",
    className: "flex-1 p-2 border rounded-lg text-sm",
    placeholder: "\u65B0\u589E\u4E00\u7B46\u5099\u8A3B...",
    value: newNote,
    onChange: e => setNewNote(e.target.value),
    onKeyDown: e => e.key === 'Enter' && handleAddNote()
  }), React.createElement("button", {
    onClick: handleAddNote,
    className: "px-3 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700"
  }, React.createElement(Icon, {
    name: "plus",
    size: 16
  }))), React.createElement("div", {
    className: "max-h-40 overflow-y-auto space-y-2"
  }, notes.length === 0 && React.createElement("div", {
    className: "text-center text-slate-400 text-xs py-4"
  }, "\u5C1A\u7121\u5099\u8A3B"), notes.map(note => React.createElement("div", {
    key: note.id,
    className: "bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-sm"
  }, React.createElement("div", {
    className: "text-xs text-slate-400 mb-1"
  }, note.date), React.createElement("div", {
    className: "text-slate-700 break-words"
  }, note.content)))))), React.createElement("div", {
    className: "flex justify-end gap-2 mt-6 pt-4 border-t"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: handleSave,
    className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold shadow-md text-sm"
  }, "\u5132\u5B58\u8B8A\u66F4"))));
};
const InstructorScheduleModal = ({
  date,
  availableInstructors,
  restingList,
  onClose,
  onToggle,
  isCompanyRest,
  onToggleCompanyRest,
  isInternalDay,
  internalLabel,
  onToggleInternalDay,
  onSetInternalLabel,
  isOutingDay,
  outingPosterFilename,
  outingPosterOptions,
  outingPeople,
	  onToggleOutingDay,
	  onSetOutingPoster,
	  onToggleOutingPerson
	}) => {
	  const [activeRestSlot, setActiveRestSlot] = useState('all');
	  const activeRestNames = getScheduleRestNamesForSlot(restingList, activeRestSlot);
	  const restDisplayItems = getScheduleRestDisplayItems(restingList);
	  return React.createElement("div", {
	    className: "fixed inset-0 bg-black/50 z-[90] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
	  }, React.createElement("div", {
	    className: "bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "calendar-days",
    className: "text-blue-600"
  }), " ", date, " \u6392\u73ED"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400"
  }))), React.createElement("div", {
    className: "mb-4 p-3 bg-slate-100 rounded-xl flex justify-between items-center border border-slate-200"
  }, React.createElement("span", {
    className: "font-bold text-slate-700 text-sm"
  }, "\u5168\u516C\u53F8\u4F11\u5047\u8A2D\u5B9A"), React.createElement("button", {
    onClick: () => onToggleCompanyRest(date),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm flex items-center gap-1 ${isCompanyRest ? 'bg-red-500 text-white' : 'bg-green-500 text-white'}`
  }, isCompanyRest ? React.createElement(React.Fragment, null, React.createElement(Icon, {
    name: "x-circle",
    size: 12
  }), " \u672C\u65E5\u516C\u4F11") : React.createElement(React.Fragment, null, React.createElement(Icon, {
    name: "check-circle",
    size: 12
  }), " \u6B63\u5E38\u71DF\u904B"))), React.createElement("div", {
    className: "mb-4 p-3 bg-indigo-50 rounded-xl border border-indigo-200 space-y-3"
  }, React.createElement("div", {
    className: "flex justify-between items-center gap-3"
  }, React.createElement("div", null, React.createElement("span", {
    className: "font-bold text-indigo-700 text-sm block"
  }, "\u5167\u90E8\u6D3B\u52D5"), React.createElement("span", {
    className: "text-[11px] text-indigo-400"
  }, "\u50C5\u5F8C\u53F0\u6A19\u8A18\uFF0C\u4E0D\u986F\u793A\u5728\u524D\u53F0")), React.createElement("button", {
    onClick: () => onToggleInternalDay(date),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm flex items-center gap-1 ${isInternalDay ? 'bg-indigo-600 text-white' : 'bg-white text-indigo-700 border border-indigo-200'}`
  }, isInternalDay ? React.createElement(React.Fragment, null, React.createElement(Icon, {
    name: "check-circle",
    size: 12
  }), " \u5DF2\u6A19\u8A18") : React.createElement(React.Fragment, null, React.createElement(Icon, {
    name: "plus-circle",
    size: 12
  }), " \u6A19\u8A18"))), isInternalDay && React.createElement("div", {
    className: "mt-3"
  }, React.createElement("label", {
    className: "block text-[11px] font-bold text-indigo-700 mb-1"
  }, "\u5167\u90E8\u6D3B\u52D5\u5099\u8A3B"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border border-indigo-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200",
    placeholder: "\u4F8B\uFF1A\u5167\u90E8\u6703\u8B70\u3001\u5668\u6750\u6574\u7406\u3001\u8A13\u7DF4...",
    defaultValue: internalLabel || '',
    onBlur: e => onSetInternalLabel(date, e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') e.currentTarget.blur();
    }
  }))), React.createElement("div", {
    className: "mb-4 p-3 bg-amber-50 rounded-xl border border-amber-200 space-y-3"
  }, React.createElement("div", {
    className: "flex justify-between items-center"
  }, React.createElement("span", {
    className: "font-bold text-amber-700 text-sm"
  }, "\u672C\u65E5\u5834\u52D8"), React.createElement("button", {
    onClick: () => onToggleOutingDay(date),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm flex items-center gap-1 ${isOutingDay ? 'bg-amber-500 text-white' : 'bg-white text-amber-700 border border-amber-200'}`
  }, isOutingDay ? React.createElement(React.Fragment, null, React.createElement(Icon, {
    name: "image",
    size: 12
  }), " \u5DF2\u555F\u7528") : React.createElement(React.Fragment, null, React.createElement(Icon, {
    name: "x-circle",
    size: 12
  }), " \u672A\u555F\u7528"))), React.createElement("div", null, React.createElement("label", {
    className: "block text-[11px] font-bold text-amber-700 mb-1"
  }, "\u6307\u5B9A\u986F\u793A\u5716\u7247\uFF08\u7A7A\u767D = \u4F9D\u6A5F\u7387\u62BD\u5716\uFF09"), React.createElement("select", {
    className: "w-full p-2 border border-amber-200 rounded-lg text-xs bg-white",
    value: outingPosterFilename || '',
    onChange: e => onSetOutingPoster(date, e.target.value)
  }, React.createElement("option", {
    value: ""
  }, "\u4F9D\u6A5F\u7387\u81EA\u52D5\u9078\u5716"), (outingPosterOptions || []).map(item => React.createElement("option", {
    key: item.filename,
    value: item.filename
  }, item.label || item.filename, " (", item.weight || 0, "%)")))), React.createElement("div", null, React.createElement("label", {
    className: "block text-[11px] font-bold text-amber-700 mb-1"
  }, "\u5834\u52D8\u4EBA\u54E1\uFF08\u9EDE\u64CA\u5207\u63DB\uFF09"), React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, availableInstructors.map(name => {
    const active = (outingPeople || []).includes(name);
    return React.createElement("button", {
      key: `outing_${name}`,
      type: "button",
      onClick: () => onToggleOutingPerson(date, name),
      className: `text-[11px] px-2 py-1 rounded-full border transition-all ${active ? 'bg-amber-500 text-white border-amber-600' : 'bg-white text-amber-700 border-amber-200 hover:bg-amber-100'}`
    }, name);
  }), availableInstructors.length === 0 && React.createElement("span", {
    className: "text-[11px] text-amber-500"
	  }, "\u5C1A\u7121\u8B1B\u5E2B\u53EF\u9078")))), React.createElement("div", {
	    className: "mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3"
	  }, React.createElement("div", {
	    className: "text-xs font-bold text-slate-600 mb-2"
	  }, "\u4F11\u5047\u6642\u6BB5"), React.createElement("div", {
	    className: "grid grid-cols-4 gap-1.5"
	  }, SCHEDULE_REST_SLOT_OPTIONS.map(option => React.createElement("button", {
	    key: option.value,
	    type: "button",
	    onClick: () => setActiveRestSlot(option.value),
	    className: `px-2 py-1.5 rounded-lg text-xs font-bold border transition-all ${activeRestSlot === option.value ? 'bg-slate-800 text-white border-slate-900 shadow-sm' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-100'}`
	  }, option.label)))), React.createElement("p", {
	    className: "text-xs text-slate-500 mb-4"
	  }, "\u9EDE\u64CA\u5207\u63DB\u500B\u5225\u8B1B\u5E2B\u5728\u9078\u5B9A\u6642\u6BB5\u7684\u4E0A\u5DE5\u72C0\u614B (\uD83D\uDD34 \u4F11\u5047 / \uD83D\uDFE2 \u53EF\u4E0A\u5DE5)"), React.createElement("div", {
	    className: "space-y-2 max-h-60 overflow-y-auto"
	  }, availableInstructors.map(name => {
	    const isAllDayResting = getScheduleRestNamesForSlot(restingList, 'all').includes(name);
	    const isResting = activeRestNames.includes(name);
	    const isPartialResting = !isAllDayResting && restDisplayItems.some(item => item.name === name);
	    const hasRestTone = activeRestSlot === 'all' ? isAllDayResting || isPartialResting : isResting;
	    const statusLabel = activeRestSlot === 'all' ? isAllDayResting ? '整天休' : isPartialResting ? '部分休' : '可上工' : isResting ? `${getScheduleSlotLabel(activeRestSlot)}休` : '可上工';
	    return React.createElement("div", {
	      key: name,
	      onClick: () => onToggle(date, name, activeRestSlot),
	      className: `flex justify-between items-center p-3 rounded-xl border cursor-pointer transition-all ${hasRestTone ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`
	    }, React.createElement("span", {
	      className: `font-bold ${hasRestTone ? 'text-red-700' : 'text-green-700'}`
	    }, name), React.createElement("span", {
	      className: `text-xs px-2 py-1 rounded-full font-bold ${hasRestTone ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`
	    }, statusLabel));
  }), availableInstructors.length === 0 && React.createElement("div", {
    className: "text-center text-slate-400 py-4"
  }, "\u66AB\u7121\u8B1B\u5E2B\u8CC7\u6599\uFF0C\u8ACB\u5148\u5EFA\u7ACB\u6D3B\u52D5\u6216\u624B\u52D5\u8F38\u5165\u3002")), React.createElement("div", {
    className: "mt-4 pt-4 border-t flex justify-end"
  }, React.createElement("button", {
    onClick: onClose,
    className: "bg-slate-800 text-white px-4 py-2 rounded-lg text-sm"
  }, "\u5B8C\u6210"))));
};
const GlobalRulesModal = ({
  currentRules,
  onClose,
  onSave
}) => {
  const [rules, setRules] = useState(currentRules || DEFAULT_STATUS_RULES);
  const [newRule, setNewRule] = useState({
    min: 0,
    max: 10,
    label: '',
    color: 'blue'
  });
  const addRule = () => {
    if (!newRule.label) return alert("請輸入顯示文字");
    const updated = [...rules, newRule].sort((a, b) => parseInt(a.min) - parseInt(b.min));
    setRules(updated);
    setNewRule({
      min: parseInt(newRule.max) + 1,
      max: parseInt(newRule.max) + 10,
      label: '',
      color: 'blue'
    });
  };
  const removeRule = idx => setRules(rules.filter((_, i) => i !== idx));
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800"
  }, "\u8A2D\u5B9A\u5168\u57DF\u9810\u8A2D\u72C0\u614B\u898F\u5247"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400"
  }))), React.createElement("p", {
    className: "text-xs text-slate-500 mb-4 bg-yellow-50 p-2 rounded text-yellow-700"
  }, "\u6CE8\u610F\uFF1A\u9019\u88E1\u7684\u8A2D\u5B9A\u5C07\u5957\u7528\u5230\u300C\u672A\u500B\u5225\u8A2D\u5B9A\u898F\u5247\u300D\u7684\u6240\u6709\u6D3B\u52D5\u3002\u5982\u679C\u60A8\u5728\u500B\u5225\u6D3B\u52D5\u4E2D\u8A2D\u5B9A\u4E86\u898F\u5247\uFF0C\u5C07\u4EE5\u500B\u5225\u6D3B\u52D5\u70BA\u6E96\u3002\u986F\u793A\u6587\u5B57\u53EF\u7528 X \u6216 {count} \u4EE3\u5165\u76EE\u524D\u4EBA\u6578\uFF0C{remaining} \u4EE3\u5165\u5269\u9918\u540D\u984D\u3002"), React.createElement("div", {
    className: "bg-slate-50 p-3 rounded-lg border border-slate-200 mb-4"
  }, React.createElement("div", {
    className: "space-y-2 mb-3 max-h-60 overflow-y-auto"
  }, rules.map((rule, idx) => React.createElement("div", {
    key: idx,
    className: "flex items-center gap-2 text-xs bg-white p-2 rounded border"
  }, React.createElement("span", {
    className: "w-16 text-center bg-slate-100 rounded py-1"
  }, toSafeDisplayText(rule.min, '0'), "-", toSafeDisplayText(rule.max, '999'), "\u4EBA"), React.createElement("span", {
    className: `flex-1 px-2 py-1 rounded text-center ${COLOR_OPTIONS.find(c => c.value === rule.color)?.bg} ${COLOR_OPTIONS.find(c => c.value === rule.color)?.text}`
  }, toSafeDisplayText(rule.label, '報名中')), React.createElement("button", {
    onClick: () => removeRule(idx),
    className: "text-slate-400 hover:text-red-500"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  }))))), React.createElement("div", {
    className: "grid grid-cols-4 gap-2 items-end border-t pt-2 border-slate-200"
  }, React.createElement("div", null, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "Min"), React.createElement("input", {
    type: "number",
    className: "w-full p-1 text-xs border rounded",
    value: newRule.min,
    onChange: e => setNewRule({
      ...newRule,
      min: e.target.value
    })
  })), React.createElement("div", null, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "Max"), React.createElement("input", {
    type: "number",
    className: "w-full p-1 text-xs border rounded",
    value: newRule.max,
    onChange: e => setNewRule({
      ...newRule,
      max: e.target.value
    })
  })), React.createElement("div", {
    className: "col-span-2"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u6587\u5B57"), React.createElement("input", {
    type: "text",
    className: "w-full p-1 text-xs border rounded",
    placeholder: "\u5982: \u71B1\u8CE3\u4E2D",
    value: newRule.label,
    onChange: e => setNewRule({
      ...newRule,
      label: e.target.value
    })
  })), React.createElement("div", {
    className: "col-span-3"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u984F\u8272"), React.createElement("select", {
    className: "w-full p-1 text-xs border rounded",
    value: newRule.color,
    onChange: e => setNewRule({
      ...newRule,
      color: e.target.value
    })
  }, COLOR_OPTIONS.map(c => React.createElement("option", {
    key: c.value,
    value: c.value
  }, c.label)))), React.createElement("button", {
    onClick: addRule,
    className: "h-[26px] bg-slate-800 text-white text-xs rounded hover:bg-slate-700"
  }, "\u65B0\u589E"))), React.createElement("div", {
    className: "flex justify-end gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => onSave(normalizeStatusRulesForDisplay(rules)),
    className: "px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm shadow-md"
  }, "\u5132\u5B58\u8A2D\u5B9A"))));
};
const TagSettingsModal = ({
  currentDefs,
  onClose,
  onSave
}) => {
  const originalDefs = useMemo(() => normalizeTagDefinitionsForDisplay(currentDefs || DEFAULT_TAG_DEFS), [currentDefs]);
  const [defs, setDefs] = useState(originalDefs);
  const [newItem, setNewItem] = useState({
    type: 'levels',
    value: ''
  });
  const addItem = () => {
    if (!newItem.value.trim()) return;
    const updated = {
      ...defs,
      [newItem.type]: [...defs[newItem.type], newItem.value.trim()]
    };
    setDefs(updated);
    setNewItem({
      ...newItem,
      value: ''
    });
  };
  const removeItem = (type, index) => {
    const updated = {
      ...defs,
      [type]: defs[type].filter((_, i) => i !== index)
    };
    setDefs(updated);
  };
  const updateItem = (type, index, value) => {
    const updated = {
      ...defs,
      [type]: defs[type].map((item, i) => i === index ? value : item)
    };
    setDefs(updated);
  };
  const renderSection = (title, type, icon) => React.createElement("div", {
    className: "mb-4"
  }, React.createElement("h4", {
    className: "text-sm font-bold text-slate-700 mb-2 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: icon,
    size: 16
  }), " ", title), React.createElement("div", {
    className: "space-y-2 mb-2"
  }, defs[type].map((item, idx) => React.createElement("div", {
    key: idx,
    className: "text-xs bg-white border border-slate-200 px-2 py-1.5 rounded-lg flex items-center gap-2"
  }, React.createElement("input", {
    type: "text",
    className: "flex-1 min-w-0 bg-transparent outline-none font-bold text-slate-700",
    value: item,
    onChange: e => updateItem(type, idx, e.target.value),
    onBlur: () => setDefs(normalizeTagDefinitionsForDisplay(defs))
  }), React.createElement("button", {
    onClick: () => removeItem(type, idx),
    className: "text-slate-400 hover:text-red-500"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  }))))));
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800"
  }, "\u7BA1\u7406\u6D3B\u52D5\u6A19\u7C64"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400"
  }))), React.createElement("div", {
    className: "bg-slate-50 p-4 rounded-xl border border-slate-200 max-h-[60vh] overflow-y-auto mb-4"
  }, renderSection('活動等級', 'levels', 'bar-chart-2'), renderSection('活動種類', 'types', 'tag'), renderSection('活動地點', 'locations', 'map-pin')), React.createElement("div", {
    className: "flex gap-2 items-center bg-white p-2 border rounded-lg mb-4"
  }, React.createElement("select", {
    className: "text-xs bg-slate-100 p-2 rounded outline-none border-none",
    value: newItem.type,
    onChange: e => setNewItem({
      ...newItem,
      type: e.target.value
    })
  }, React.createElement("option", {
    value: "levels"
  }, "\u7B49\u7D1A"), React.createElement("option", {
    value: "types"
  }, "\u7A2E\u985E"), React.createElement("option", {
    value: "locations"
  }, "\u5730\u9EDE")), React.createElement("input", {
    type: "text",
    className: "flex-1 text-sm outline-none px-2",
    placeholder: "\u8F38\u5165\u65B0\u6A19\u7C64\u540D\u7A31...",
    value: newItem.value,
    onChange: e => setNewItem({
      ...newItem,
      value: e.target.value
    }),
    onKeyDown: e => e.key === 'Enter' && addItem()
  }), React.createElement("button", {
    onClick: addItem,
    className: "bg-slate-800 text-white p-1.5 rounded hover:bg-slate-700"
  }, React.createElement(Icon, {
    name: "plus",
    size: 16
  }))), React.createElement("div", {
    className: "flex justify-end gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => {
      const normalizedDefs = normalizeTagDefinitionsForDisplay(defs);
      onSave(normalizedDefs, buildTagRenameMap(originalDefs, normalizedDefs));
    },
    className: "px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm shadow-md"
  }, "\u5132\u5B58\u8A2D\u5B9A"))));
};
const OutingPosterSettingsModal = ({
  currentList,
  onClose,
  onSave
}) => {
  const initialList = Array.isArray(currentList) && currentList.length > 0 ? currentList : DEFAULT_OUTING_POSTER_CONFIG;
  const [list, setList] = useState(initialList);
  const [draft, setDraft] = useState({
    filename: '',
    label: '',
    weight: 10
  });
  const [editIdx, setEditIdx] = useState(null);
  const handleAddOrUpdate = () => {
    if (!draft.filename.trim()) return alert("請輸入圖片檔名或網址");
    const row = {
      filename: draft.filename.trim(),
      label: draft.label.trim() || draft.filename.trim(),
      weight: Math.max(1, parseInt(draft.weight, 10) || 1)
    };
    const next = [...list];
    if (editIdx === null) next.push(row);else next[editIdx] = row;
    setList(next);
    setDraft({
      filename: '',
      label: '',
      weight: 10
    });
    setEditIdx(null);
  };
  const handleEdit = idx => {
    setEditIdx(idx);
    setDraft(list[idx]);
  };
  const handleDelete = idx => {
    const next = list.filter((_, i) => i !== idx);
    setList(next);
    if (editIdx === idx) {
      setEditIdx(null);
      setDraft({
        filename: '',
        label: '',
        weight: 10
      });
    }
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden"
  }, React.createElement("div", {
    className: "p-4 border-b flex justify-between items-center bg-slate-50"
  }, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "image"
  }), " \u5916\u51FA\u5834\u520A\u8A2D\u5B9A"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "p-5 space-y-4"
  }, React.createElement("div", {
    className: "text-xs text-slate-500"
  }, "\u8A2D\u5B9A\u53EF\u7528\u5716\u7247\u8207\u6A5F\u7387\u6B0A\u91CD\u3002\u65E5\u671F\u82E5\u672A\u6307\u5B9A\u5716\u7247\uFF0C\u7CFB\u7D71\u6703\u4F9D\u6B0A\u91CD\u81EA\u52D5\u9078\u5716\u3002"), React.createElement("div", {
    className: "space-y-2 max-h-60 overflow-y-auto"
  }, list.length === 0 && React.createElement("div", {
    className: "text-xs text-slate-400 border border-dashed rounded-lg p-4 text-center"
  }, "\u5C1A\u7121\u5716\u7247\uFF0C\u8ACB\u65B0\u589E"), list.map((item, idx) => React.createElement("div", {
    key: `${item.filename}_${idx}`,
    className: `p-2 rounded-lg border flex items-center gap-2 ${editIdx === idx ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200'}`
  }, React.createElement("div", {
    className: "flex-1 min-w-0"
  }, React.createElement("div", {
    className: "text-xs font-bold text-slate-700 truncate"
  }, item.label || item.filename), React.createElement("div", {
    className: "text-[11px] text-slate-400 truncate"
  }, item.filename)), React.createElement("div", {
    className: "text-xs font-bold bg-slate-100 px-2 py-1 rounded"
  }, item.weight || 0), React.createElement("button", {
    onClick: () => handleEdit(idx),
    className: "p-1 text-blue-500 hover:bg-blue-50 rounded"
  }, React.createElement(Icon, {
    name: "edit-2",
    size: 14
  })), React.createElement("button", {
    onClick: () => handleDelete(idx),
    className: "p-1 text-red-500 hover:bg-red-50 rounded"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  }))))), React.createElement("div", {
    className: `p-3 rounded-xl border ${editIdx !== null ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`
  }, React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-2"
  }, React.createElement("input", {
    type: "text",
    className: "p-2 border rounded-lg text-xs",
    placeholder: "\u5716\u7247\u6A94\u540D\u6216\u7DB2\u5740",
    value: draft.filename,
    onChange: e => setDraft({
      ...draft,
      filename: e.target.value
    })
  }), React.createElement("input", {
    type: "text",
    className: "p-2 border rounded-lg text-xs",
    placeholder: "\u986F\u793A\u540D\u7A31",
    value: draft.label,
    onChange: e => setDraft({
      ...draft,
      label: e.target.value
    })
  }), React.createElement("input", {
    type: "number",
    min: "1",
    className: "p-2 border rounded-lg text-xs",
    placeholder: "\u6B0A\u91CD",
    value: draft.weight,
    onChange: e => setDraft({
      ...draft,
      weight: e.target.value
    })
  })), React.createElement("button", {
    onClick: handleAddOrUpdate,
    className: "w-full mt-2 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold hover:bg-slate-700"
  }, editIdx !== null ? '更新項目' : '新增項目'))), React.createElement("div", {
    className: "p-4 border-t bg-slate-50 flex justify-end gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-200 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => onSave(list),
    className: "px-5 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-bold"
  }, "\u5132\u5B58\u8A2D\u5B9A"))));
};
const PosterNameOverrideSettingsModal = ({
  currentList,
  eventNames = [],
  onClose,
  onSave
}) => {
  const [list, setList] = useState(normalizePosterNameOverrides(currentList));
  const [draft, setDraft] = useState({
    sourceName: '',
    posterName: ''
  });
  const [editIdx, setEditIdx] = useState(null);
  const suggestions = useMemo(() => Array.from(new Set((eventNames || []).map(name => String(name || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-Hant')), [eventNames]);
  const resetDraft = () => {
    setDraft({
      sourceName: '',
      posterName: ''
    });
    setEditIdx(null);
  };
  const handleAddOrUpdate = () => {
    const row = {
      id: editIdx === null ? `poster_name_${Date.now()}` : list[editIdx]?.id || `poster_name_${Date.now()}`,
      sourceName: String(draft.sourceName || '').trim(),
      posterName: String(draft.posterName || '').trim()
    };
    if (!row.sourceName || !row.posterName) return alert('請填寫後台名稱與圖片顯示名稱。');
    const next = [...list];
    if (editIdx === null) {
      const existingIndex = next.findIndex(item => item.sourceName.replace(/\s+/g, '') === row.sourceName.replace(/\s+/g, ''));
      if (existingIndex >= 0) next[existingIndex] = row;else next.push(row);
    } else {
      next[editIdx] = row;
    }
    setList(normalizePosterNameOverrides(next));
    resetDraft();
  };
  const handleEdit = idx => {
    setEditIdx(idx);
    setDraft({
      sourceName: list[idx]?.sourceName || '',
      posterName: list[idx]?.posterName || ''
    });
  };
  const handleDelete = idx => {
    setList(list.filter((_, i) => i !== idx));
    if (editIdx === idx) resetDraft();
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full shadow-2xl overflow-hidden flex flex-col",
    style: {
      maxWidth: 520,
      maxHeight: 'calc(100vh - 32px)'
    }
  }, React.createElement("div", {
    className: "p-3 border-b flex justify-between items-center bg-slate-50 flex-shrink-0"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "type"
  }), " \u6708\u66C6\u6D77\u5831\u540D\u7A31\u5C0D\u7167"), React.createElement("p", {
    className: "text-xs text-slate-500 mt-1"
  }, "\u53EA\u5F71\u97FF\u6708\u66C6\u5716\u4E0A\u7684\u6D3B\u52D5\u540D\u7A31\uFF0C\u4E0D\u6703\u6539\u5F8C\u53F0\u540D\u7A31\u6216\u524D\u53F0\u8A02\u7968\u8CC7\u6599\u3002")), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "p-4 space-y-3 overflow-y-auto"
  }, React.createElement("datalist", {
    id: "poster-name-source-suggestions"
  }, suggestions.map(name => React.createElement("option", {
    key: name,
    value: name
  }))), React.createElement("div", {
    className: "space-y-2"
  }, React.createElement("div", {
    className: "flex items-center justify-between px-1 text-[11px] font-bold text-slate-400"
  }, React.createElement("span", null, "\u5DF2\u5132\u5B58 ", list.length, " \u7B46"), list.length > 0 && React.createElement("span", null, "\u9EDE\u925B\u7B46\u7DE8\u8F2F")), React.createElement("div", {
    className: "max-h-36 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100 bg-white"
  }, list.length === 0 && React.createElement("div", {
    className: "text-xs text-slate-400 p-3 text-center"
  }, "\u5C1A\u7121\u5C0D\u7167\u8868\u3002\u6C92\u6709\u8A2D\u5B9A\u6642\uFF0C\u7CFB\u7D71\u6703\u6CBF\u7528\u76EE\u524D\u7684\u6D77\u5831\u547D\u540D\u898F\u5247\u3002"), list.map((item, idx) => React.createElement("div", {
    key: item.id || `${item.sourceName}_${idx}`,
    className: `px-2 py-1.5 flex items-center gap-1.5 text-xs ${editIdx === idx ? 'bg-amber-50' : 'bg-white hover:bg-slate-50'}`
  }, React.createElement("div", {
    className: "flex-1 min-w-0 grid gap-1.5 items-center",
    style: {
      gridTemplateColumns: 'minmax(0, 1fr) 14px minmax(0, .75fr)'
    }
  }, React.createElement("div", {
    className: "truncate font-semibold text-slate-700",
    title: item.sourceName
  }, item.sourceName), React.createElement("div", {
    className: "text-slate-300 font-bold text-center"
  }, "\u2192"), React.createElement("div", {
    className: "truncate font-bold text-emerald-700",
    title: item.posterName
  }, item.posterName)), React.createElement("button", {
    onClick: () => handleEdit(idx),
    className: "p-1 text-blue-500 hover:bg-blue-50 rounded"
  }, React.createElement(Icon, {
    name: "edit-2",
    size: 13
  })), React.createElement("button", {
    onClick: () => handleDelete(idx),
    className: "p-1 text-red-500 hover:bg-red-50 rounded"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 13
  })))))), React.createElement("div", {
    className: `p-3 rounded-xl border ${editIdx !== null ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`
  }, React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2"
  }, React.createElement("input", {
    type: "text",
    list: "poster-name-source-suggestions",
    className: "p-2 border rounded-lg text-sm",
    placeholder: "\u5F8C\u53F0\u540D\u7A31\uFF0C\u4F8B\u5982\uFF1A\u9F2F\u5F71\u9F2F\u8E64\uFF0D\u591C\u8A2A\u98DB\u9F20\u5927\u5B89\u5834",
    value: draft.sourceName,
    onChange: e => setDraft({
      ...draft,
      sourceName: e.target.value
    })
  }), React.createElement("input", {
    type: "text",
    className: "p-2 border rounded-lg text-sm",
    placeholder: "\u5716\u4E0A\u986F\u793A\uFF0C\u4F8B\u5982\uFF1A\u5927\u5B89\u9F20",
    value: draft.posterName,
    onChange: e => setDraft({
      ...draft,
      posterName: e.target.value
    })
  }), React.createElement("button", {
    onClick: handleAddOrUpdate,
    className: "px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-bold hover:bg-slate-700"
  }, editIdx !== null ? '\u66F4\u65B0' : '\u65B0\u589E')), editIdx !== null && React.createElement("button", {
    onClick: resetDraft,
    className: "mt-2 text-xs text-slate-500 hover:text-slate-700"
  }, "\u53D6\u6D88\u7DE8\u8F2F"))), React.createElement("div", {
    className: "p-3 border-t bg-slate-50 flex justify-end gap-2 flex-shrink-0"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-200 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => onSave(normalizePosterNameOverrides(list)),
    className: "px-5 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-bold"
  }, "\u5132\u5B58\u5C0D\u7167\u8868"))));
};
const PosterActivitySelectionModal = ({
  options,
  selectedNames,
  onToggle,
  onSelectAll,
  onClearAll,
  onClose,
  onConfirm,
  generating
}) => {
  const totalCount = options.length;
  const selectedCount = selectedNames.length;
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden"
  }, React.createElement("div", {
    className: "p-4 border-b border-slate-100 flex items-start justify-between gap-4 bg-slate-50"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800"
  }, "\u9078\u64C7\u8981\u986F\u793A\u5728\u6D77\u5831\u4E0A\u7684\u6D3B\u52D5"), React.createElement("p", {
    className: "text-sm text-slate-500 mt-1"
  }, "\u9810\u8A2D\u6703\u5168\u9078\u3002\u4F60\u53EF\u4EE5\u5148\u52FE\u6389\u9019\u6B21\u4E0D\u60F3\u51FA\u73FE\u5728\u5716\u7247\u4E0A\u7684\u6D3B\u52D5\uFF0C\u518D\u958B\u59CB\u751F\u6210\u3002")), React.createElement("button", {
    onClick: onClose,
    className: "text-slate-400 hover:text-slate-600"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "p-4 border-b border-slate-100 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", {
    className: "text-sm text-slate-500"
  }, "\u5DF2\u9078 ", React.createElement("span", {
    className: "font-bold text-slate-800"
  }, selectedCount), " / ", totalCount, " \u500B\u6D3B\u52D5"), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, React.createElement("button", {
    onClick: onSelectAll,
    className: "px-3 py-1.5 text-xs font-bold rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
  }, "\u5168\u9078"), React.createElement("button", {
    onClick: onClearAll,
    className: "px-3 py-1.5 text-xs font-bold rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
  }, "\u5168\u90E8\u53D6\u6D88"))), React.createElement("div", {
    className: "max-h-[60vh] overflow-y-auto p-4 space-y-2 bg-white"
  }, options.map(option => {
    const optionName = String(option?.name || '未命名活動');
    const optionBucketLabel = String(option?.bucketLabel || '其他活動');
    const optionDaysLabel = String(option?.daysLabel || '-');
    const optionCount = Number(option?.count) || 0;
    const isSelected = selectedNames.includes(optionName);
    return React.createElement("label", {
      key: optionName,
      className: `flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition ${isSelected ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'}`
    }, React.createElement("input", {
      type: "checkbox",
      className: "mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500",
      checked: isSelected,
      onChange: () => onToggle(optionName)
    }), React.createElement("div", {
      className: "flex-1 min-w-0"
    }, React.createElement("div", {
      className: "flex flex-wrap items-center gap-2"
    }, React.createElement("span", {
      className: "text-sm font-bold text-slate-800"
    }, optionName), React.createElement("span", {
      className: "text-[11px] px-2 py-0.5 rounded-full border border-slate-200 bg-white text-slate-500"
    }, optionBucketLabel)), React.createElement("div", {
      className: "text-xs text-slate-400 mt-1"
    }, "\u672C\u6708\u986F\u793A ", optionCount, " \u6B21 \xB7 \u65E5\u671F\uFF1A", optionDaysLabel)));
  })), React.createElement("div", {
    className: "p-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-sm rounded-lg text-slate-500 hover:bg-slate-100"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: onConfirm,
    disabled: generating,
    className: `px-4 py-2 text-sm font-bold rounded-lg text-white ${generating ? 'bg-slate-300 cursor-wait' : 'bg-emerald-600 hover:bg-emerald-700'}`
  }, generating ? '生成中...' : '確認並生成'))));
};
const MascotSettingsModal = ({
  currentList,
  onClose,
  onSave
}) => {
  const defaultThemes = [{
    id: 'theme_squirrel',
    name: '飛鼠系列',
    keywords: '飛鼠,滑翔',
    gifs: [{
      filename: 'eating.gif',
      action: '吃東西',
      weight: 20
    }, {
      filename: 'cleaning.gif',
      action: '打掃',
      weight: 35
    }, {
      filename: 'climbing.gif',
      action: '攀岩',
      weight: 35
    }, {
      filename: 'sliding.gif',
      action: '滑行',
      weight: 8
    }, {
      filename: 'milking.gif',
      action: '喝奶',
      weight: 2
    }]
  }];
  const initData = currentList && Array.isArray(currentList) ? currentList[0] && currentList[0].id ? currentList : defaultThemes : defaultThemes;
  const [themes, setThemes] = useState(initData);
  const [selectedThemeId, setSelectedThemeId] = useState(initData[0]?.id || 'theme_squirrel');
  const [newGif, setNewGif] = useState({
    filename: '',
    action: '',
    weight: 10
  });
  const [editGifIndex, setEditGifIndex] = useState(null);
  const activeTheme = themes.find(t => t.id === selectedThemeId) || themes[0];
  const addTheme = () => {
    const name = prompt("請輸入新主題名稱 (例如: 蛙類系列)");
    if (!name) return;
    const newId = `theme_${Date.now()}`;
    const newTheme = {
      id: newId,
      name,
      keywords: '',
      gifs: []
    };
    const newThemes = [...themes, newTheme];
    setThemes(newThemes);
    setSelectedThemeId(newId);
  };
  const deleteTheme = id => {
    if (themes.length <= 1) return alert("至少保留一個主題");
    if (!confirm("確定刪除此主題及所有設定？")) return;
    const newThemes = themes.filter(t => t.id !== id);
    setThemes(newThemes);
    setSelectedThemeId(newThemes[0].id);
  };
  const updateThemeInfo = (key, value) => {
    setThemes(themes.map(t => t.id === selectedThemeId ? {
      ...t,
      [key]: value
    } : t));
  };
  const handleAddOrUpdateGif = () => {
    if (!newGif.filename || !newGif.action) return alert("請輸入完整資訊");
    const gifData = {
      ...newGif,
      weight: parseInt(newGif.weight) || 10
    };
    const currentGifs = activeTheme.gifs || [];
    const updatedGifs = [...currentGifs];
    if (editGifIndex !== null) {
      updatedGifs[editGifIndex] = gifData;
      setEditGifIndex(null);
    } else {
      updatedGifs.push(gifData);
    }
    updateThemeInfo('gifs', updatedGifs);
    setNewGif({
      filename: '',
      action: '',
      weight: 10
    });
  };
  const startEditGif = idx => {
    setEditGifIndex(idx);
    setNewGif(activeTheme.gifs[idx]);
  };
  const removeGif = idx => {
    const updatedGifs = activeTheme.gifs.filter((_, i) => i !== idx);
    updateThemeInfo('gifs', updatedGifs);
    if (editGifIndex === idx) {
      setEditGifIndex(null);
      setNewGif({
        filename: '',
        action: '',
        weight: 10
      });
    }
  };
  if (!activeTheme) return null;
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-4xl p-0 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
  }, React.createElement("div", {
    className: "p-4 border-b flex justify-between items-center bg-slate-50"
  }, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "settings",
    className: "text-pink-500"
  }), " \u5409\u7965\u7269\u5168\u57DF\u8A2D\u5B9A"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "flex flex-1 overflow-hidden"
  }, React.createElement("div", {
    className: "w-1/3 border-r bg-slate-50 p-4 flex flex-col gap-2 overflow-y-auto"
  }, React.createElement("div", {
    className: "text-xs font-bold text-slate-400 mb-2 uppercase"
  }, "\u4E3B\u984C\u5217\u8868"), themes.map(t => React.createElement("div", {
    key: t.id,
    onClick: () => setSelectedThemeId(t.id),
    className: `p-3 rounded-xl cursor-pointer transition-all flex justify-between items-center group ${t.id === selectedThemeId ? 'bg-white shadow-md border-l-4 border-l-pink-500 text-slate-800' : 'hover:bg-white text-slate-500'}`
  }, React.createElement("span", {
    className: "font-bold text-sm truncate"
  }, t.name), React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      deleteTheme(t.id);
    },
    className: "opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  })))), React.createElement("button", {
    onClick: addTheme,
    className: "mt-2 py-2 border-2 border-dashed border-slate-300 rounded-xl text-slate-400 text-xs font-bold hover:bg-white hover:text-pink-500 hover:border-pink-300 transition-all flex justify-center items-center gap-1"
  }, React.createElement(Icon, {
    name: "plus",
    size: 14
  }), " \u65B0\u589E\u4E3B\u984C")), React.createElement("div", {
    className: "w-2/3 p-6 overflow-y-auto bg-white"
  }, React.createElement("div", {
    className: "space-y-4 mb-6"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u4E3B\u984C\u540D\u7A31"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    value: activeTheme.name,
    onChange: e => updateThemeInfo('name', e.target.value)
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u89F8\u767C\u95DC\u9375\u5B57 (\u7528\u9017\u865F\u5206\u9694)"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm bg-yellow-50 focus:bg-white transition-colors",
    placeholder: "\u4F8B\u5982: \u98DB\u9F20, \u6ED1\u7FD4, \u591C\u9593\u89C0\u5BDF",
    value: activeTheme.keywords,
    onChange: e => updateThemeInfo('keywords', e.target.value)
  }), React.createElement("p", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "\u7576\u6D3B\u52D5\u540D\u7A31\u5305\u542B\u4E0A\u8FF0\u4EFB\u4E00\u95DC\u9375\u5B57\u6642\uFF0C\u5C07\u6703\u986F\u793A\u4E0B\u65B9\u7684 GIF \u52D5\u756B\u3002"))), React.createElement("div", {
    className: "border-t pt-4"
  }, React.createElement("div", {
    className: "flex justify-between items-end mb-2"
  }, React.createElement("label", {
    className: "text-xs font-bold text-slate-500"
  }, "GIF \u52D5\u4F5C\u5217\u8868 (", activeTheme.gifs?.length || 0, ")")), React.createElement("div", {
    className: "space-y-2 mb-4"
  }, (!activeTheme.gifs || activeTheme.gifs.length === 0) && React.createElement("div", {
    className: "text-center text-slate-400 text-xs py-4 border border-dashed rounded-lg"
  }, "\u5C1A\u7121 GIF\uFF0C\u8ACB\u65B0\u589E"), activeTheme.gifs?.map((gif, idx) => React.createElement("div", {
    key: idx,
    className: `flex items-center gap-2 p-2 rounded-lg border text-sm ${editGifIndex === idx ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-200' : 'bg-white'}`
  }, React.createElement("div", {
    className: "flex-1 font-mono text-xs truncate",
    title: gif.filename
  }, gif.filename), React.createElement("div", {
    className: "w-20 truncate"
  }, gif.action), React.createElement("div", {
    className: "w-12 text-center bg-slate-100 rounded text-xs"
  }, gif.weight), React.createElement("div", {
    className: "flex gap-1"
  }, React.createElement("button", {
    onClick: () => startEditGif(idx),
    className: "p-1 hover:bg-blue-100 rounded text-blue-500"
  }, React.createElement(Icon, {
    name: "edit-2",
    size: 14
  })), React.createElement("button", {
    onClick: () => removeGif(idx),
    className: "p-1 hover:bg-red-100 rounded text-red-500"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  })))))), React.createElement("div", {
    className: `p-3 rounded-xl border transition-all ${editGifIndex !== null ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-200'}`
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-2"
  }, React.createElement("span", {
    className: `text-xs font-bold ${editGifIndex !== null ? 'text-blue-600' : 'text-slate-500'}`
  }, editGifIndex !== null ? '編輯中...' : '新增動作'), editGifIndex !== null && React.createElement("button", {
    onClick: () => {
      setEditGifIndex(null);
      setNewGif({
        filename: '',
        action: '',
        weight: 10
      });
    },
    className: "text-[10px] text-slate-400 underline"
  }, "\u53D6\u6D88")), React.createElement("div", {
    className: "flex gap-2 mb-2"
  }, React.createElement("input", {
    type: "text",
    className: "flex-[2] p-2 border rounded text-xs",
    placeholder: "\u6A94\u540D (\u5982: frog.gif)",
    value: newGif.filename,
    onChange: e => setNewGif({
      ...newGif,
      filename: e.target.value
    })
  }), React.createElement("input", {
    type: "text",
    className: "flex-[2] p-2 border rounded text-xs",
    placeholder: "\u52D5\u4F5C (\u5982: \u8DF3\u6C34)",
    value: newGif.action,
    onChange: e => setNewGif({
      ...newGif,
      action: e.target.value
    })
  }), React.createElement("input", {
    type: "number",
    className: "flex-1 p-2 border rounded text-xs",
    placeholder: "\u6B0A\u91CD",
    value: newGif.weight,
    onChange: e => setNewGif({
      ...newGif,
      weight: e.target.value
    })
  })), React.createElement("button", {
    onClick: handleAddOrUpdateGif,
    className: `w-full py-2 rounded-lg text-xs font-bold text-white shadow-sm ${editGifIndex !== null ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-800 hover:bg-slate-700'}`
  }, editGifIndex !== null ? '更新 GIF' : '加入列表'))))), React.createElement("div", {
    className: "p-4 border-t bg-slate-50 flex justify-end gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-200 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => onSave(themes),
    className: "px-6 py-2 bg-pink-600 text-white rounded-lg hover:bg-pink-700 text-sm shadow-md font-bold"
  }, "\u5132\u5B58\u6240\u6709\u8A2D\u5B9A"))));
};
const EventMascot = ({
  eventName,
  db,
  dbSource,
  config
}) => {
  const themes = Array.isArray(config) && config.length > 0 ? config : DEFAULT_MASCOT_THEMES;
  const matchedTheme = useMemo(() => {
    if (!eventName) return null;
    return themes.find(theme => {
      if (!theme.keywords) return false;
      const keywords = String(theme.keywords || '').split(/[,，、]/).map(k => k.trim()).filter(k => k);
      return keywords.some(k => String(eventName || '').includes(k));
    });
  }, [eventName, themes]);
  const matchedThemeSignature = matchedTheme ? `${matchedTheme.id || matchedTheme.name || matchedTheme.keywords || 'theme'}__${(matchedTheme.gifs || []).map(item => `${item.filename}:${item.action}:${item.weight}`).join('|')}` : '';
  const selectedItem = useMemo(() => {
    if (!matchedTheme) return null;
    const gifList = matchedTheme.gifs || [];
    if (gifList.length === 0) return null;
    const totalWeight = gifList.reduce((acc, item) => acc + (Number(item.weight) || 0), 0);
    if (totalWeight <= 0) return gifList[0];
    let random = Math.random() * totalWeight;
    for (const item of gifList) {
      if (random < (Number(item.weight) || 0)) return item;
      random -= Number(item.weight) || 0;
    }
    return gifList[0];
  }, [matchedThemeSignature]);
  const gifSrc = selectedItem?.filename || '';
  const actionName = selectedItem?.action || '';
  if (!gifSrc) return null;
  return React.createElement("div", {
    className: "absolute bottom-0 right-0 z-10 pointer-events-none flex flex-col items-end md:flex-row md:items-end"
  }, React.createElement("div", {
    className: "mb-2 mr-2 bg-white/95 border border-slate-200 shadow-lg rounded-2xl rounded-br-none px-3 py-2 text-[10px] leading-tight text-slate-600 animate-in fade-in slide-in-from-bottom-2 duration-700 relative z-20 max-w-[140px] md:mb-12 md:mr-[-10px]"
  }, "\u4F60\u9047\u5230\u4E86", React.createElement("span", {
    className: "text-slate-800 font-bold"
  }, matchedTheme.name?.replace('系列', '') || '吉祥物'), " ", React.createElement("span", {
    className: "text-blue-600 font-bold"
  }, actionName), "\uFF01", React.createElement("br", null), React.createElement("span", {
    className: "text-yellow-500 font-bold"
  }, "\u2728 \u597D\u5E78\u904B \u2728")), React.createElement("img", {
    src: gifSrc,
    alt: "Mascot",
    className: "w-36 h-36 object-contain relative z-10"
  }));
};
const AddEventCustomerModal = ({
  eventData,
  historicalData,
  onClose,
  onSave
}) => {
  const [form, setForm] = useState({
    customerName: '',
    price: '',
    transport: '',
    phone: '',
    email: '',
    idNo: '',
    birthday: '',
    source: '',
    notes: '',
    orderDate: getLocalDateStr()
  });
  const [matchFound, setMatchFound] = useState(false);
  const uniqueCustomers = useMemo(() => {
    const names = new Set();
    return historicalData.filter(d => d.customerName && d.customerName !== '開放報名中').map(d => d.customerName).filter(name => {
      if (names.has(name)) return false;
      names.add(name);
      return true;
    }).sort();
  }, [historicalData]);
  useEffect(() => {
    if (!form.customerName) {
      setMatchFound(false);
      return;
    }
    const records = historicalData.filter(d => d.customerName === form.customerName);
    if (records.length > 0) {
      const lastRecord = records[records.length - 1];
      setForm(prev => ({
        ...prev,
        phone: prev.phone || lastRecord.phone || '',
        email: prev.email || lastRecord.email || '',
        idNo: prev.idNo || lastRecord.idNo || '',
        birthday: prev.birthday || lastRecord.birthday || '',
        transport: prev.transport || lastRecord.transport || '',
        source: prev.source || lastRecord.source || ''
      }));
      setMatchFound(true);
    } else {
      setMatchFound(false);
    }
  }, [form.customerName, historicalData]);
  const handleSubmit = () => {
    if (!form.customerName) return alert('請輸入客戶姓名');
    onSave(form);
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800"
  }, "\u65B0\u589E\u5831\u540D"), React.createElement("p", {
    className: "text-xs text-slate-500"
  }, toSafeDisplayText(eventData.date, ''), " - ", toSafeDisplayText(eventData.eventName, '未命名活動'))), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "bg-slate-50 p-4 rounded-xl border border-slate-200 max-h-[60vh] overflow-y-auto space-y-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5BA2\u6236\u59D3\u540D *"), React.createElement("div", {
    className: "relative"
  }, React.createElement("input", {
    type: "text",
    list: "customer-suggestions",
    className: "w-full p-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "\u8F38\u5165\u59D3\u540D\u81EA\u52D5\u641C\u5C0B...",
    value: form.customerName,
    onChange: e => setForm({
      ...form,
      customerName: e.target.value
    }),
    autoFocus: true
  }), React.createElement("datalist", {
    id: "customer-suggestions"
  }, form.customerName && uniqueCustomers.filter(name => name.toLowerCase().includes(form.customerName.toLowerCase())).slice(0, 10).map(name => React.createElement("option", {
    key: name,
    value: name
  }))), matchFound && React.createElement("div", {
    className: "absolute right-2 top-2 text-xs text-green-600 font-bold flex items-center bg-green-50 px-2 rounded-full border border-green-200"
  }, React.createElement(Icon, {
    name: "check",
    size: 12,
    className: "mr-1"
  }), " \u5DF2\u4EE3\u5165\u6B77\u53F2\u8CC7\u6599"))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u91D1\u984D"), React.createElement("input", {
    type: "number",
    className: "w-full p-2 border rounded-lg",
    value: form.price,
    onChange: e => setForm({
      ...form,
      price: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u4EA4\u901A"), React.createElement("select", {
    className: "w-full p-2 border rounded-lg",
    value: form.transport,
    onChange: e => setForm({
      ...form,
      transport: e.target.value
    })
  }, React.createElement("option", {
    value: ""
  }, "\u672A\u5B9A"), React.createElement("option", {
    value: "\u5171\u4E58"
  }, "\u5171\u4E58"), React.createElement("option", {
    value: "\u81EA\u884C\u524D\u5F80"
  }, "\u81EA\u884C\u524D\u5F80")))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u624B\u6A5F"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    value: form.phone,
    onChange: e => setForm({
      ...form,
      phone: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8EAB\u5206\u8B49"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    value: form.idNo,
    onChange: e => setForm({
      ...form,
      idNo: e.target.value
    })
  }))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u751F\u65E5"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg",
    value: form.birthday,
    onChange: e => setForm({
      ...form,
      birthday: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "Email"), React.createElement("input", {
    type: "email",
    className: "w-full p-2 border rounded-lg",
    value: form.email,
    onChange: e => setForm({
      ...form,
      email: e.target.value
    })
  }))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5831\u540D\u7BA1\u9053"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    value: form.source,
    onChange: e => setForm({
      ...form,
      source: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8A02\u8CFC\u65E5"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg",
    value: form.orderDate,
    onChange: e => setForm({
      ...form,
      orderDate: e.target.value
    })
  }))), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5099\u8A3B"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    value: form.notes,
    onChange: e => setForm({
      ...form,
      notes: e.target.value
    })
  }))), React.createElement("div", {
    className: "flex justify-end gap-2 mt-4"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg text-sm"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: handleSubmit,
    className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold shadow-md text-sm"
  }, "\u78BA\u8A8D\u65B0\u589E"))));
};
const EventManagerModal = ({
  event,
  config,
  onClose,
  onSaveConfig,
  onSaveTemplate,
  availableInstructors,
  instructorSchedule,
  onCheckInToggle,
  onDeleteEvent,
  globalRules,
  onEditCustomer,
  tagDefinitions,
  onAddTag,
  parsedData,
  onAddDirectReg,
  customTemplates = [],
  adminPasswords = []
}) => {
  const [capacity, setCapacity] = useState(config?.capacity || 12);
  const [internalName, setInternalName] = useState(event.eventName);
  const [isEditingInternalName, setIsEditingInternalName] = useState(false);
  const [tempName, setTempName] = useState(event.eventName);
  const [eventNote, setEventNote] = useState(config?.note || '');
  const [eventTime, setEventTime] = useState(config?.time || '');
  const [eventTimeSlot, setEventTimeSlot] = useState(normalizeScheduleTimeSlot(config?.timeSlot, inferScheduleTimeSlot(config?.time || '')));
  const [eventLink, setEventLink] = useState(config?.link || '');
  const [backendColor, setBackendColor] = useState(config?.backendColor || '#eff6ff');
  const [displayName, setDisplayName] = useState(config?.displayName || '');
  const [activityCategory, setActivityCategory] = useState(config?.activityCategory || '');
  const [carpoolDisplayMode, setCarpoolDisplayMode] = useState(resolveCarpoolDisplayMode(config?.carpoolDisplayMode, event.eventName));
  const inferredPrivateGroupEvent = !!config?.isPrivateGroupEvent || config?.tags?.levels === '包團' || String(config?.displayName || event.eventName || '').includes('包團');
  const [isPrivateGroupEvent, setIsPrivateGroupEvent] = useState(inferredPrivateGroupEvent);
  const [privateGroupLabel, setPrivateGroupLabel] = useState(config?.privateGroupLabel || '此為包團活動');
  const [tasks, setTasks] = useState(config?.tasks || JSON.parse(JSON.stringify(DEFAULT_TASKS_TEMPLATE)));
  const [leadInstructors, setLeadInstructors] = useState(config?.leadInstructors && config.leadInstructors.length > 0 ? config.leadInstructors : event.instructor ? event.instructor.split(/[&,]/).map(s => s.trim()).filter(Boolean) : []);
  const [supportInstructors, setSupportInstructors] = useState(config?.supportInstructors || []);
  const [tempLeadInstructor, setTempLeadInstructor] = useState('');
  const [tempSupportInstructor, setTempSupportInstructor] = useState('');
  const [statusRules, setStatusRules] = useState(config?.statusRules ? normalizeStoredStatusRules(config.statusRules) : globalRules || DEFAULT_STATUS_RULES);
  const [newRule, setNewRule] = useState({
    min: 0,
    max: 10,
    label: '',
    color: 'blue'
  });
  const [showAddRegModal, setShowAddRegModal] = useState(false);
  const [tags, setTags] = useState(config?.tags || {
    levels: '',
    types: '',
    locations: ''
  });
  const [isCancelled, setIsCancelled] = useState(!!config?.isCancelled);
  const [dismissedTemplateSuggestionKey, setDismissedTemplateSuggestionKey] = useState('');
  const [appliedTemplateSuggestionKey, setAppliedTemplateSuggestionKey] = useState('');
  const [templateAutofillNotice, setTemplateAutofillNotice] = useState('');
  const handleTagChange = (type, val) => {
    setTags({
      ...tags,
      [type]: val
    });
  };
  const normalizedInternalName = useMemo(() => String(internalName || '').trim().replace(/\s+/g, ''), [internalName]);
  const matchedTemplate = useMemo(() => {
    if (!normalizedInternalName) return null;
    const matches = (customTemplates || []).filter(tpl => getTemplateEventNameKey(tpl) === normalizedInternalName);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }, [customTemplates, normalizedInternalName]);
  const matchedTemplateKey = matchedTemplate ? `${matchedTemplate.id || matchedTemplate.name || matchedTemplate.eventName}::${normalizedInternalName}` : '';
  const templateSuggestionNeeded = !!(matchedTemplate && (!eventTime && matchedTemplate.time || !config?.timeSlot && matchedTemplate.timeSlot || !eventLink && matchedTemplate.link || !displayName && matchedTemplate.displayName || !activityCategory && matchedTemplate.activityCategory || !eventNote && matchedTemplate.note || (capacity === 12 || capacity === '' || capacity === null || capacity === undefined) && matchedTemplate.capacity || !tags?.levels && matchedTemplate?.tags?.levels || !tags?.types && matchedTemplate?.tags?.types || !tags?.locations && matchedTemplate?.tags?.locations || !isPrivateGroupEvent && matchedTemplate.isPrivateGroupEvent || privateGroupLabel === '此為包團活動' && matchedTemplate.privateGroupLabel && matchedTemplate.privateGroupLabel !== '此為包團活動' || !(statusRules || []).length && (matchedTemplate.statusRules || []).length));
  const shouldShowTemplateSuggestion = !!(templateSuggestionNeeded && matchedTemplateKey && matchedTemplateKey !== dismissedTemplateSuggestionKey && matchedTemplateKey !== appliedTemplateSuggestionKey);
  const hasChanges = useMemo(() => {
    const currentInstr = [...leadInstructors, ...supportInstructors].sort().join(' & ');
    const originalInstr = event.instructor || '';
    const originalLeadInstructors = config?.leadInstructors && config.leadInstructors.length > 0 ? config.leadInstructors : event.instructor ? event.instructor.split(/[&,]/).map(s => s.trim()).filter(Boolean) : [];
    const originalSupportInstructors = config?.supportInstructors || [];
    return internalName !== event.eventName || capacity !== (config?.capacity || 12) || eventNote !== (config?.note || '') || eventTime !== (config?.time || '') || eventTimeSlot !== normalizeScheduleTimeSlot(config?.timeSlot, inferScheduleTimeSlot(config?.time || '')) || eventLink !== (config?.link || '') || backendColor !== (config?.backendColor || '#eff6ff') || displayName !== (config?.displayName || '') || activityCategory !== (config?.activityCategory || '') || carpoolDisplayMode !== resolveCarpoolDisplayMode(config?.carpoolDisplayMode, event.eventName) || isPrivateGroupEvent !== inferredPrivateGroupEvent || privateGroupLabel !== (config?.privateGroupLabel || '此為包團活動') || currentInstr !== originalInstr || JSON.stringify(leadInstructors) !== JSON.stringify(originalLeadInstructors) || JSON.stringify(supportInstructors) !== JSON.stringify(originalSupportInstructors) || JSON.stringify(tasks) !== JSON.stringify(config?.tasks || DEFAULT_TASKS_TEMPLATE) || JSON.stringify(tags) !== JSON.stringify(config?.tags || {
      levels: '',
      types: '',
      locations: ''
    }) || JSON.stringify(statusRules) !== JSON.stringify(config?.statusRules ? normalizeStoredStatusRules(config.statusRules) : globalRules || DEFAULT_STATUS_RULES) || isCancelled !== !!config?.isCancelled;
  }, [internalName, capacity, eventNote, eventTime, eventTimeSlot, eventLink, backendColor, displayName, activityCategory, carpoolDisplayMode, isPrivateGroupEvent, inferredPrivateGroupEvent, privateGroupLabel, leadInstructors, supportInstructors, tasks, tags, statusRules, isCancelled, event, config]);
  const handleRequestClose = () => {
    if (hasChanges) {
      if (confirm("您有尚未儲存的編輯內容，確定要直接關閉嗎？（變更將會遺失）")) {
        onClose();
      }
    } else {
      onClose();
    }
  };
  const sortedCustomers = useMemo(() => {
    if (!event.customers) return [];
    return [...event.customers].sort((a, b) => {
      if (a.transport === '共乘' && b.transport !== '共乘') return -1;
      if (a.transport !== '共乘' && b.transport === '共乘') return 1;
      return 0;
    });
  }, [event.customers]);
  // 每位客人參加過的總場次（身分證→手機→姓名 階梯式識別；同一天多筆算一場；含過去與未來、含當前這場）
  const personVisitKey = c => {
    const idNo = String(c.idNo || '').trim();
    if (idNo) return 'id:' + idNo;
    const phone = String(c.phone || '').trim();
    if (phone) return 'ph:' + phone;
    return 'nm:' + String(c.customerName || '').trim();
  };
  const visitCountByPerson = useMemo(() => {
    const m = {};
    (parsedData || []).forEach(r => {
      const name = String(r.customerName || '').trim();
      const date = String(r.date || '').trim();
      if (!name || name === '開放報名中' || !date) return;
      const k = personVisitKey(r);
      (m[k] || (m[k] = new Set())).add(date);
    });
    return m;
  }, [parsedData]);
  const carpoolCount = event.customers ? event.customers.filter(c => c.transport === '共乘').length : 0;
  const checkedInCount = event.customers ? event.customers.filter(c => c.isCheckedIn).length : 0;
  const handleTaskToggle = index => {
    const newTasks = [...tasks];
    newTasks[index].completed = !newTasks[index].completed;
    setTasks(newTasks);
  };
  const handleAddTask = () => {
    const name = prompt("任務名稱:");
    if (name) setTasks([...tasks, {
      id: `custom_${Date.now()}`,
      name,
      fields: [],
      completed: false
    }]);
  };
  const handleDeleteTask = index => {
    if (confirm("刪除?")) {
      const n = [...tasks];
      n.splice(index, 1);
      setTasks(n);
    }
  };
  const addLeadInstructor = name => {
    const clean = name.trim();
    if (!clean) return;
    const isResting = isInstructorRestingForSlot(instructorSchedule, event.date, clean, eventTimeSlot);
    if (isResting) {
      if (!confirm(`${clean} 在 ${event.date} ${getScheduleSlotLabel(eventTimeSlot)}已排休，確定要排入嗎？`)) return;
    }
    if (!leadInstructors.includes(clean)) setLeadInstructors([...leadInstructors, clean]);
    setTempLeadInstructor('');
  };
  const removeLeadInstructor = name => {
    setLeadInstructors(leadInstructors.filter(i => i !== name));
  };
  const addSupportInstructor = name => {
    const clean = name.trim();
    if (!clean) return;
    const isResting = isInstructorRestingForSlot(instructorSchedule, event.date, clean, eventTimeSlot);
    if (isResting) {
      if (!confirm(`${clean} 在 ${event.date} ${getScheduleSlotLabel(eventTimeSlot)}已排休，確定要排入嗎？`)) return;
    }
    if (!supportInstructors.includes(clean)) setSupportInstructors([...supportInstructors, clean]);
    setTempSupportInstructor('');
  };
  const removeSupportInstructor = name => {
    setSupportInstructors(supportInstructors.filter(i => i !== name));
  };
  const addStatusRule = () => {
    if (!newRule.label) return alert("請輸入顯示文字");
    const updatedRules = [...statusRules, newRule].sort((a, b) => parseInt(a.min) - parseInt(b.min));
    setStatusRules(updatedRules);
    setNewRule({
      min: parseInt(newRule.max) + 1,
      max: parseInt(newRule.max) + 10,
      label: '',
      color: 'blue'
    });
  };
  const removeStatusRule = idx => {
    setStatusRules(statusRules.filter((_, i) => i !== idx));
  };
  const updateStatusRule = (idx, key, value) => {
    setStatusRules(statusRules.map((rule, ruleIdx) => ruleIdx === idx ? {
      ...rule,
      [key]: value
    } : rule));
  };
  const handleSaveCurrentEventAsTemplate = async () => {
    const cleanInternalName = String(internalName || '').trim();
    if (!cleanInternalName) return alert('請先填寫活動後台名稱，再存成模板。');
    if (matchedTemplate && !confirm(`要用這場活動目前的設定，覆蓋同名模板「${matchedTemplate.name || getTemplateEventName(matchedTemplate)}」嗎？`)) return;
    const currentInstructorStr = Array.from(new Set([...leadInstructors, ...supportInstructors].map(name => String(name || '').trim()).filter(Boolean))).sort().join(' & ');
    const templatePayload = normalizeQuickCreateTemplate({
      id: matchedTemplate?.id || null,
      name: matchedTemplate?.name || cleanInternalName,
	      eventName: cleanInternalName,
	      instructor: currentInstructorStr || event.instructor || '',
	      time: eventTime || '',
	      timeSlot: normalizeScheduleTimeSlot(eventTimeSlot, inferScheduleTimeSlot(eventTime)),
	      duration: parseInt(config?.duration, 10) || 1,
      prepDays: parseInt(config?.prepDays, 10) || 0,
      prepTime: config?.prepTime || '',
      link: eventLink || '',
      note: eventNote || '',
      displayName: displayName || '',
      activityCategory: activityCategory || '',
      templateCategory: normalizeQuickCreateTemplateCategory(matchedTemplate?.templateCategory, cleanInternalName),
      carpoolDisplayMode,
      isPrivateGroupEvent,
      privateGroupLabel: privateGroupLabel || '此為包團活動',
      isCancelled,
      capacity: parseInt(capacity, 10) || 12,
      price: config?.price ?? matchedTemplate?.price ?? '',
      tags: tags || {
        levels: '',
        types: '',
        locations: ''
      },
      backendColor: backendColor || '#eff6ff',
      statusRules: normalizeStoredStatusRules(statusRules || [])
    });
    try {
      await Promise.resolve(onSaveTemplate?.(templatePayload));
      const targetTemplateName = templatePayload.name || templatePayload.eventName || '模板';
      setTemplateAutofillNotice(`已將這場活動${matchedTemplate ? '更新到' : '存成'}模板「${targetTemplateName}」。`);
    } catch (e) {
      console.error('Save current event as template failed', e);
      alert(`❌ 存成模板失敗：${formatFirestoreError(e)}`);
    }
  };
  const applyTemplateToEvent = tpl => {
    if (!tpl) return;
	    const templateEventName = getTemplateEventName(tpl);
	    setEventTime(tpl.time || '');
	    setEventTimeSlot(normalizeScheduleTimeSlot(tpl.timeSlot, inferScheduleTimeSlot(tpl.time)));
	    setEventLink(tpl.link || '');
    setEventNote(tpl.note || '');
    setDisplayName(tpl.displayName || '');
    setActivityCategory(tpl.activityCategory || '');
    setCarpoolDisplayMode(resolveCarpoolDisplayMode(tpl.carpoolDisplayMode, templateEventName));
    setIsPrivateGroupEvent(!!tpl.isPrivateGroupEvent);
    setPrivateGroupLabel(tpl.privateGroupLabel || '此為包團活動');
    setCapacity(tpl.capacity || 12);
    setBackendColor(tpl.backendColor || '#eff6ff');
    setTags(tpl.tags || {
      levels: '',
      types: '',
      locations: ''
    });
    setStatusRules(tpl.statusRules ? normalizeStoredStatusRules(tpl.statusRules) : []);
    setIsCancelled(!!tpl.isCancelled);
    const templateKey = `${tpl.id || tpl.name || tpl.eventName}::${templateEventName.replace(/\s+/g, '')}`;
    setAppliedTemplateSuggestionKey(templateKey);
    setDismissedTemplateSuggestionKey('');
    setTemplateAutofillNotice(`已從模板「${tpl.name || templateEventName}」帶入時間、連結、前台名稱、標籤與共乘設定。`);
  };
  useEffect(() => {
    setDismissedTemplateSuggestionKey('');
    setAppliedTemplateSuggestionKey('');
    setTemplateAutofillNotice('');
  }, [event.key]);
  const handleSave = () => {
    const newInstructorStr = Array.from(new Set([...leadInstructors, ...supportInstructors])).sort().join(' & ');
    onSaveConfig({
      capacity: parseInt(capacity),
      tasks,
	      note: eventNote,
	      time: eventTime,
	      timeSlot: normalizeScheduleTimeSlot(eventTimeSlot, inferScheduleTimeSlot(eventTime)),
	      link: eventLink,
      statusRules,
      displayName,
      activityCategory,
      carpoolDisplayMode,
      isPrivateGroupEvent,
      privateGroupLabel: privateGroupLabel || '此為包團活動',
      tags,
      backendColor,
      isCancelled,
      leadInstructors,
      supportInstructors
    }, newInstructorStr, internalName);
    onClose();
  };
  const handleExportList = () => {
    let csv = "\uFEFF姓名,手機,Email,身分證字號,生日,交通,備註,報到狀態\n";
    sortedCustomers.forEach(c => {
      const status = c.isCheckedIn ? '已報到' : '未報到';
      csv += `${c.customerName},${c.phone},${c.email},${c.idNo},${c.birthday},${c.transport},${toCSVField(c.notes)},${status}\n`;
    });
    downloadCSV(csv, `${event.eventName}_${event.date}_名單.csv`);
  };
  const handleSaveNewReg = customerData => {
    onAddDirectReg(event, customerData);
    setShowAddRegModal(false);
  };
  const progress = Math.round(tasks.filter(t => t.completed).length / Math.max(tasks.length, 1) * 100);
  return React.createElement("div", {
    onClick: handleRequestClose,
    className: "fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4 fade-in backdrop-blur-sm cursor-pointer"
  }, React.createElement("div", {
    onClick: e => e.stopPropagation(),
    className: "bg-white rounded-2xl w-full max-w-lg flex flex-col max-h-[90vh] shadow-2xl m-auto cursor-auto"
  }, React.createElement("div", {
    className: "p-6 border-b border-slate-100 flex justify-between items-start"
  }, React.createElement("div", {
    className: "flex-1 mr-4"
  }, React.createElement("div", {
    className: "text-xs text-blue-600 font-bold bg-blue-50 px-2 py-1 rounded mb-1 inline-block"
  }, event.date), !isEditingInternalName ? React.createElement("div", {
    className: "flex items-center gap-2 group cursor-pointer",
    onClick: () => {
      setTempName(internalName);
      setIsEditingInternalName(true);
    }
  }, React.createElement("h3", {
    className: "text-xl font-bold text-slate-800"
  }, internalName), React.createElement(Icon, {
    name: "edit-3",
    size: 16,
    className: "text-slate-300 group-hover:text-blue-500 transition-colors"
  })) : React.createElement("div", {
    className: "flex items-center gap-2 animate-in fade-in zoom-in-95"
  }, React.createElement("input", {
    type: "text",
    className: "text-xl font-bold text-slate-800 border-b-2 border-blue-500 outline-none bg-blue-50 px-1 rounded-t w-full",
    value: tempName,
    onChange: e => setTempName(e.target.value),
    autoFocus: true
  }), React.createElement("button", {
    onClick: () => {
      const pwd = prompt("修改後台名稱將連動所有報名資料，請輸入管理員密碼確認：");
      if (adminPasswords.includes(pwd)) {
        setInternalName(tempName);
        setIsEditingInternalName(false);
      } else if (pwd !== null) {
        alert("密碼錯誤，取消修改");
      }
    },
    className: "bg-blue-600 text-white p-1 rounded hover:bg-blue-700 shadow-sm"
  }, React.createElement(Icon, {
    name: "check",
    size: 18
  })), React.createElement("button", {
    onClick: () => setIsEditingInternalName(false),
    className: "bg-slate-200 text-slate-600 p-1 rounded hover:bg-slate-300"
  }, React.createElement(Icon, {
    name: "x",
    size: 18
  }))), React.createElement("div", {
    className: "text-[10px] text-slate-400 mt-1 flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "info",
    size: 10
  }), " \u5F8C\u53F0\u539F\u59CB\u540D\u7A31 (\u4FEE\u6539\u5C07\u9023\u52D5\u6240\u6709\u5831\u540D\u8CC7\u6599)"), React.createElement("div", {
    className: "mt-3 flex flex-wrap gap-2"
  }, React.createElement("button", {
    type: "button",
    onClick: handleSaveCurrentEventAsTemplate,
    className: "px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-bold text-emerald-700 hover:bg-emerald-100",
    title: matchedTemplate ? `用這場活動目前的設定，更新同名模板「${toSafeDisplayText(matchedTemplate.name, toSafeDisplayText(getTemplateEventName(matchedTemplate), '模板'))}」` : '把這場活動目前的設定存成新模板'
  }, matchedTemplate ? "\u66F4\u65B0\u540C\u540D\u6A21\u677F" : "\u5B58\u6210\u6A21\u677F"), matchedTemplate && React.createElement("button", {
    type: "button",
    onClick: () => applyTemplateToEvent(matchedTemplate),
    className: "px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-xs font-bold text-blue-700 hover:bg-blue-100",
    title: `從模板「${toSafeDisplayText(matchedTemplate.name, toSafeDisplayText(getTemplateEventName(matchedTemplate), '模板'))}」帶入設定`
  }, "\u5F9E\u540C\u540D\u6A21\u677F\u88DC\u9F4A\u8A2D\u5B9A"))), React.createElement("button", {
    onClick: handleRequestClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "p-6 overflow-y-auto space-y-6"
  }, React.createElement("section", null, React.createElement("h4", {
    className: "font-bold text-slate-700 mb-2 flex items-center"
  }, React.createElement(Icon, {
    name: "user",
    size: 18,
    className: "mr-2"
  }), " \u8B1B\u5E2B\u5206\u5DE5"), React.createElement("div", {
    className: "bg-slate-50 p-3 rounded-xl border border-slate-200"
  }, React.createElement("div", {
    className: "mb-3"
  }, React.createElement("div", {
    className: "text-xs font-bold text-blue-600 mb-2"
  }, "\u5E36\u5718\u8B1B\u5E2B\uFF08\u7D71\u8A08\u6703\u63A1\u7528\uFF09"), React.createElement("div", {
    className: "flex flex-wrap gap-2 mb-2"
  }, leadInstructors.map(ins => React.createElement("div", {
    key: `lead_${ins}`,
    className: "flex items-center bg-white text-blue-700 px-2 py-1 rounded-md text-sm border border-blue-100 shadow-sm"
  }, React.createElement("span", {
    className: "mr-1"
  }, ins), React.createElement("button", {
    onClick: () => removeLeadInstructor(ins)
  }, React.createElement(Icon, {
    name: "x",
    size: 14,
    className: "text-slate-400 hover:text-red-500"
  })))), leadInstructors.length === 0 && React.createElement("span", {
    className: "text-xs text-slate-400 py-1"
  }, "\u672A\u6307\u5B9A\u5E36\u5718\u8B1B\u5E2B")), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("input", {
    type: "text",
    className: "flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500",
    value: tempLeadInstructor,
    onChange: e => setTempLeadInstructor(e.target.value),
    onKeyDown: e => e.key === 'Enter' && addLeadInstructor(tempLeadInstructor),
    placeholder: "\u8F38\u5165\u5E36\u5718\u8B1B\u5E2B..."
  }), React.createElement("button", {
    onClick: () => addLeadInstructor(tempLeadInstructor),
    className: "px-3 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200"
  }, React.createElement(Icon, {
    name: "plus",
    size: 16
  })))), React.createElement("div", {
    className: "mb-2"
  }, React.createElement("div", {
    className: "text-xs font-bold text-emerald-600 mb-2"
  }, "\u8DDF\u5718\u8B1B\u5E2B\uFF08\u4E0D\u5217\u5165\u5E36\u5718\u91CF\u7D71\u8A08\uFF09"), React.createElement("div", {
    className: "flex flex-wrap gap-2 mb-2"
  }, supportInstructors.map(ins => React.createElement("div", {
    key: `support_${ins}`,
    className: "flex items-center bg-white text-emerald-700 px-2 py-1 rounded-md text-sm border border-slate-200 shadow-sm"
  }, React.createElement("span", {
    className: "mr-1"
  }, `(跟) ${ins}`), React.createElement("button", {
    onClick: () => removeSupportInstructor(ins)
  }, React.createElement(Icon, {
    name: "x",
    size: 14,
    className: "text-slate-400 hover:text-red-500"
  })))), supportInstructors.length === 0 && React.createElement("span", {
    className: "text-xs text-slate-400 py-1"
  }, "\u672A\u6307\u5B9A\u8DDF\u5718\u8B1B\u5E2B")), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("input", {
    type: "text",
    className: "flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500",
    value: tempSupportInstructor,
    onChange: e => setTempSupportInstructor(e.target.value),
    onKeyDown: e => e.key === 'Enter' && addSupportInstructor(tempSupportInstructor),
    placeholder: "\u8F38\u5165\u8DDF\u5718\u8B1B\u5E2B..."
  }), React.createElement("button", {
    onClick: () => addSupportInstructor(tempSupportInstructor),
    className: "px-3 bg-emerald-100 text-emerald-600 rounded-lg hover:bg-emerald-200"
  }, React.createElement(Icon, {
    name: "plus",
    size: 16
  })))), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, availableInstructors.slice(0, 6).map(i => React.createElement("div", {
    key: i,
    className: "flex gap-1"
  }, React.createElement("button", {
    onClick: () => addLeadInstructor(i),
    className: "text-xs px-2 py-1 bg-white border rounded-full hover:bg-blue-50 text-slate-600"
  }, "+\u5E36 ", i), React.createElement("button", {
    onClick: () => addSupportInstructor(i),
    className: "text-xs px-2 py-1 bg-white border rounded-full hover:bg-slate-50 text-emerald-700"
  }, "(\u8DDF) ", i)))))), React.createElement("section", null, React.createElement("div", {
    className: "flex justify-between items-center mb-3"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 flex items-center"
  }, React.createElement(Icon, {
    name: "users",
    size: 18,
    className: "mr-2"
  }), " \u5831\u540D\u540D\u55AE (", checkedInCount, "/", event.count, ")"), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: () => setShowAddRegModal(true),
    className: "text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 flex items-center shadow-sm"
  }, React.createElement(Icon, {
    name: "plus",
    size: 12,
    className: "mr-1"
  }), " \u65B0\u589E\u5831\u540D"), React.createElement("button", {
    onClick: handleExportList,
    className: "text-xs bg-slate-800 text-white px-2 py-1 rounded hover:bg-slate-700 flex items-center"
  }, React.createElement(Icon, {
    name: "download",
    size: 12,
    className: "mr-1"
  }), " \u532F\u51FA"), React.createElement("span", {
    className: "text-xs font-bold text-orange-600 bg-orange-50 px-2 py-1 rounded-full flex items-center"
  }, "\u5171\u4E58: ", carpoolCount))), React.createElement("div", {
    className: "bg-slate-50 p-3 rounded-xl border border-slate-200 max-h-60 overflow-y-auto"
  }, sortedCustomers.length > 0 ? React.createElement("ul", {
    className: "space-y-2"
  }, sortedCustomers.map((c, i) => React.createElement("li", {
    key: i,
    className: `flex justify-between items-center text-sm p-2 rounded-lg ${c.transport === '共乘' ? 'bg-white border border-orange-100 shadow-sm' : 'border-b border-slate-100'}`
  }, React.createElement("div", {
    className: "flex items-center gap-3"
  }, React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onCheckInToggle(c.id, c.isCheckedIn);
    },
    className: `w-5 h-5 rounded flex items-center justify-center border transition-colors ${c.isCheckedIn ? 'bg-green-500 border-green-500 text-white' : 'bg-white border-slate-300 text-transparent hover:border-blue-400'}`
  }, React.createElement(Icon, {
    name: "check",
    size: 14
  })), React.createElement("div", {
    className: "flex flex-col"
  }, React.createElement("span", {
    className: `font-medium ${c.isCheckedIn ? 'text-green-700' : 'text-slate-700'}`
  }, c.customerName, (() => {
    // 「到這場為止是第幾次來」：只累計日期 ≤ 本場活動日期的到訪，這場之後的報名不計
    const dates = visitCountByPerson[personVisitKey(c)];
    const eventDate = String(event.date || '').trim();
    let n = 0;
    if (dates) dates.forEach(d => { if (!eventDate || d <= eventDate) n++; });
    n = n || 1;
    return React.createElement("span", {
      className: `ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full align-middle ${n >= 2 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`,
      title: `到這場為止是第 ${n} 次參加（身分證→手機→姓名比對，同一天算一場；之後的報名不計）`
    }, `第 ${n} 次`);
  })()), React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, c.phone || '無手機'))), React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("div", {
    className: "flex flex-col items-end"
  }, c.transport === '共乘' && React.createElement("span", {
    className: "text-[10px] text-orange-500 flex items-center mb-0.5"
  }, React.createElement(Icon, {
    name: "car",
    size: 10,
    className: "mr-0.5"
  }), " \u5171\u4E58")), c.isCheckedIn && React.createElement("span", {
    className: "text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded"
  }, "\u5DF2\u5831\u5230"), React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onEditCustomer(c);
    },
    className: "p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-colors ml-1"
  }, React.createElement(Icon, {
    name: "edit-2",
    size: 14
  })))))) : React.createElement("div", {
    className: "text-slate-400 text-center text-sm py-2"
  }, "\u76EE\u524D\u5C1A\u7121\u5831\u540D"))), React.createElement("section", null, React.createElement("h4", {
    className: "font-bold text-slate-700 mb-3 flex items-center"
  }, React.createElement(Icon, {
    name: "settings",
    size: 18,
    className: "mr-2"
  }), " \u6D3B\u52D5\u8A2D\u5B9A"), React.createElement("div", {
    className: "bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-4"
  }, shouldShowTemplateSuggestion && React.createElement("div", {
    className: "rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
  }, React.createElement("div", {
    className: "flex items-start justify-between gap-3"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold text-amber-700 flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "sparkles",
    size: 12
  }), " \u627E\u5230\u540C\u540D\u6A21\u677F"), React.createElement("div", {
    className: "text-sm font-bold text-slate-700 mt-1"
  }, toSafeDisplayText(matchedTemplate.name, toSafeDisplayText(getTemplateEventName(matchedTemplate), '模板'))), React.createElement("div", {
    className: "text-[11px] text-slate-500 mt-1 leading-5"
  }, "\u9019\u5834\u300C", internalName, "\u300D\u548C\u6A21\u677F\u540C\u540D\uFF0C\u7CFB\u7D71\u627E\u5230\u53EF\u88DC\u9F4A\u7684\u9810\u8A2D\u5167\u5BB9\u3002\u8981\u4E0D\u8981\u76F4\u63A5\u5E36\u5165\u6A21\u677F\u88E1\u7684\u6642\u9593\u3001\u9023\u7D50\u3001\u524D\u53F0\u540D\u7A31\u3001\u6A19\u7C64\u8207\u5171\u4E58\u8A2D\u5B9A\uFF1F")), React.createElement("div", {
    className: "shrink-0 flex gap-2"
  }, React.createElement("button", {
    type: "button",
    onClick: () => applyTemplateToEvent(matchedTemplate),
    className: "px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-bold hover:bg-amber-600"
  }, "\u5957\u7528\u5167\u5BB9"), React.createElement("button", {
    type: "button",
    onClick: () => setDismissedTemplateSuggestionKey(matchedTemplateKey),
    className: "px-3 py-1.5 rounded-lg bg-white text-slate-500 text-xs font-bold border border-slate-200 hover:bg-slate-50"
  }, "\u5148\u4E0D\u8981")))), templateAutofillNotice && React.createElement("div", {
    className: "rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-[11px] font-medium text-emerald-700"
  }, templateAutofillNotice), React.createElement("div", {
    className: "grid grid-cols-2 gap-3 bg-white p-3 rounded-lg border border-slate-200"
  }, React.createElement("div", {
    className: "col-span-2 text-xs font-bold text-slate-500 border-b pb-1 mb-1"
  }, "\uD83D\uDCC5 \u6642\u9593\u8207\u6642\u7A0B\u8A2D\u5B9A"), React.createElement("div", null, React.createElement("span", {
    className: "text-slate-500 text-xs font-bold mb-1 block"
  }, "\u6D3B\u52D5\u6642\u9593"), React.createElement("input", {
	    type: "time",
	    value: eventTime,
	    onChange: e => {
	      setEventTime(e.target.value);
	      setEventTimeSlot(inferScheduleTimeSlot(e.target.value));
	    },
	    className: "w-full px-2 py-1.5 text-center border border-slate-300 rounded-lg font-bold outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
	  })), React.createElement("div", null, React.createElement("span", {
	    className: "text-slate-500 text-xs font-bold mb-1 block"
	  }, "\u6D3B\u52D5\u6642\u6BB5"), React.createElement("select", {
	    value: eventTimeSlot,
	    onChange: e => setEventTimeSlot(normalizeScheduleTimeSlot(e.target.value, inferScheduleTimeSlot(eventTime))),
	    className: "w-full px-2 py-1.5 text-center border border-slate-300 rounded-lg font-bold outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
	  }, SCHEDULE_TIME_SLOT_OPTIONS.map(option => React.createElement("option", {
	    key: option.value,
	    value: option.value
	  }, option.label)))), React.createElement("div", null, React.createElement("span", {
	    className: "text-slate-500 text-xs font-bold mb-1 block"
	  }, "\u4EBA\u6578\u4E0A\u9650"), React.createElement("input", {
    type: "number",
    value: capacity,
    onChange: e => setCapacity(e.target.value),
    className: "w-full px-2 py-1.5 text-center border border-slate-300 rounded-lg font-bold outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
  })), React.createElement("div", null, React.createElement("span", {
    className: "text-slate-500 text-xs font-bold mb-1 block flex items-center gap-1",
    title: "\u6D3B\u52D5\u5BE6\u969B\u8209\u8FA6\u7684\u5929\u6578"
  }, React.createElement(Icon, {
    name: "calendar",
    size: 12
  }), " \u6301\u7E8C\u5929\u6578"), React.createElement("input", {
    type: "number",
    min: "1",
    value: config?.duration || 1,
    onChange: e => onSaveConfig({
      ...config,
      duration: parseInt(e.target.value) || 1
    }),
    className: "w-full px-2 py-1.5 text-center border border-blue-200 rounded-lg font-bold outline-none focus:ring-2 focus:ring-blue-500 bg-blue-50/50 text-blue-700"
  })), React.createElement("div", {
    className: "flex gap-1"
  }, React.createElement("div", {
    className: "flex-1"
  }, React.createElement("span", {
    className: "text-amber-600 text-xs font-bold mb-1 block flex items-center gap-1",
    title: "\u6D3B\u52D5\u524D\u9700\u8981\u4F54\u7528\u7684\u6E96\u5099\u5929\u6578"
  }, React.createElement(Icon, {
    name: "clock",
    size: 12
  }), " \u524D\u7F6E(\u5929)"), React.createElement("input", {
    type: "number",
    min: "0",
    value: config?.prepDays || 0,
    onChange: e => onSaveConfig({
      ...config,
      prepDays: parseInt(e.target.value) || 0
    }),
    className: "w-full px-1 py-1.5 text-center border border-amber-200 rounded-lg font-bold outline-none focus:ring-2 focus:ring-amber-500 bg-amber-50/50 text-amber-700 text-xs"
  })), React.createElement("div", {
    className: "flex-1"
  }, React.createElement("span", {
    className: "text-amber-600 text-xs font-bold mb-1 block"
  }, "\u524D\u7F6E\u6642\u9593"), React.createElement("input", {
    type: "time",
    value: config?.prepTime || '',
    onChange: e => onSaveConfig({
      ...config,
      prepTime: e.target.value
    }),
    className: "w-full px-1 py-1.5 text-center border border-amber-200 rounded-lg font-bold outline-none focus:ring-2 focus:ring-amber-500 bg-amber-50/50 text-amber-700 text-xs"
  }))), React.createElement("div", {
    className: "col-span-2 mt-1"
  }, React.createElement("span", {
    className: "text-slate-500 text-xs font-bold mb-1 block"
  }, "\u5F8C\u53F0\u8B58\u5225\u984F\u8272"), React.createElement("input", {
    type: "color",
    value: backendColor,
    onChange: e => setBackendColor(e.target.value),
    className: "w-full h-[30px] p-0.5 border border-slate-300 rounded-lg cursor-pointer bg-white"
  }))), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u524D\u53F0\u986F\u793A\u540D\u7A31"), React.createElement("input", {
    type: "text",
    className: "w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "\u4F8B\u5982: \u51AC\u5B63\u591C\u8A2A\u86D9\u985E",
    value: displayName,
    onChange: e => setDisplayName(e.target.value)
  })), React.createElement("div", {
    className: "bg-rose-50 border border-rose-200 rounded-lg p-3 flex items-center justify-between"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-rose-700 block"
  }, "\u5F8C\u53F0\u6A19\u8A18\uFF1A\u6D41\u5718"), React.createElement("p", {
    className: "text-[10px] text-rose-500 mt-0.5"
  }, "\u50C5\u5F8C\u53F0\u8B58\u5225\u7528\uFF0C\u6708\u7D71\u8A08\u532F\u51FA\u6703\u81EA\u52D5\u6263\u9664")), React.createElement("button", {
    type: "button",
    onClick: () => setIsCancelled(!isCancelled),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${isCancelled ? 'bg-rose-600 text-white border-rose-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`
  }, isCancelled ? '已標記流團' : '標記為流團')), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-indigo-600 mb-1 block flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "bar-chart-2",
    size: 12
  }), " \u6D3B\u52D5\u6027\u8CEA\u540D\u7A31 (\u6210\u6548\u5206\u6790\u7528)"), React.createElement("input", {
    type: "text",
    className: "w-full px-3 py-2 text-sm border border-indigo-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 bg-indigo-50/30",
    placeholder: "\u4F8B\u5982: \u8C61\u5C71\u591C\u9593\u5C0E\u89BD (\u5C07\u5408\u4F75\u591A\u5834\u6B21\u5206\u6790)",
    value: activityCategory,
    onChange: e => setActivityCategory(e.target.value)
  }), React.createElement("p", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "\u82E5\u586B\u5BEB\u6B64\u6B04\u4F4D\uFF0C\u5728\u6210\u6548\u5206\u6790\u9801\u9762\u5C07\u4EE5\u6B64\u540D\u7A31\u5408\u4F75\u8A08\u7B97\u4E0D\u540C\u65E5\u671F\u7684\u540C\u6027\u8CEA\u6D3B\u52D5\u3002")), React.createElement("div", {
    className: "bg-amber-50 border border-amber-200 rounded-lg p-3"
  }, React.createElement("label", {
    className: "text-xs font-bold text-amber-700 mb-2 block"
  }, "\u524D\u53F0\u5171\u4E58\u986F\u793A"), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-2"
  }, CARPOOL_DISPLAY_MODE_OPTIONS.map(option => {
    const isActive = carpoolDisplayMode === option.value;
    return React.createElement("button", {
      key: option.value,
      type: "button",
      onClick: () => setCarpoolDisplayMode(option.value),
      className: `rounded-lg border px-3 py-2 text-left transition-all ${isActive ? 'border-amber-500 bg-white shadow-sm' : 'border-amber-100 bg-white/70 hover:border-amber-300'}`
    }, React.createElement("div", {
      className: `text-xs font-bold ${isActive ? 'text-amber-700' : 'text-slate-600'}`
    }, option.label), React.createElement("div", {
      className: "text-[10px] text-slate-400 mt-1"
    }, option.helper));
  }))), React.createElement("div", {
    className: "bg-amber-50 border border-amber-200 rounded-lg p-3"
  }, React.createElement("div", {
    className: "flex items-center justify-between gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-amber-700 block"
  }, "\u524D\u53F0\u5305\u5718\u986F\u793A"), React.createElement("p", {
    className: "text-[10px] text-amber-600 mt-0.5"
  }, "\u958B\u555F\u5F8C\u524D\u53F0\u4EBA\u6578\u72C0\u614B\u6703\u6539\u986F\u793A\u6307\u5B9A\u6587\u5B57")), React.createElement("button", {
    type: "button",
    onClick: () => setIsPrivateGroupEvent(!isPrivateGroupEvent),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${isPrivateGroupEvent ? 'bg-amber-600 text-white border-amber-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`
  }, isPrivateGroupEvent ? "\u5DF2\u8A2D\u70BA\u5305\u5718" : "\u8A2D\u70BA\u5305\u5718")), React.createElement("input", {
    type: "text",
    className: "w-full mt-2 px-3 py-2 text-sm border border-amber-200 rounded-lg outline-none focus:ring-2 focus:ring-amber-500 bg-white",
    placeholder: "\u4F8B\u5982\uFF1A\u6B64\u70BA\u5305\u5718\u6D3B\u52D5",
    value: privateGroupLabel,
    onChange: e => setPrivateGroupLabel(e.target.value)
  })), React.createElement("div", {
    className: "bg-white p-3 rounded-lg border border-slate-200"
  }, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-2 block flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "tag",
    size: 12
  }), " \u6D3B\u52D5\u6A19\u7C64 (\u5206\u985E\u7BE9\u9078\u7528)"), React.createElement(TagSelector, {
    definitions: tagDefinitions,
    value: tags,
    onChange: handleTagChange,
    onAddTag: onAddTag
  })), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-lg p-3"
  }, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-2 block flex justify-between"
  }, React.createElement("span", null, "\u81EA\u5B9A\u7FA9\u72C0\u614B\u898F\u5247 (\u4F9D\u7167\u4EBA\u6578\u986F\u793A)"), React.createElement("span", {
    className: "text-[10px] bg-slate-100 px-1 rounded font-normal"
  }, "\u5F9E\u4E0A\u5230\u4E0B\u5339\u914D")), React.createElement("div", {
    className: "space-y-2 mb-3"
  }, statusRules.map((rule, idx) => React.createElement("div", {
    key: idx,
    className: "grid grid-cols-4 gap-2 items-end text-xs bg-slate-50 p-2 rounded border border-slate-100"
  }, React.createElement("div", null, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "Min"), React.createElement("input", {
    type: "number",
    className: "w-full p-1 text-xs border rounded",
    value: toSafeDisplayText(rule.min, '0'),
    onChange: e => updateStatusRule(idx, 'min', e.target.value)
  })), React.createElement("div", null, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "Max"), React.createElement("input", {
    type: "number",
    className: "w-full p-1 text-xs border rounded",
    value: toSafeDisplayText(rule.max, '999'),
    onChange: e => updateStatusRule(idx, 'max', e.target.value)
  })), React.createElement("div", {
    className: "col-span-2"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u986F\u793A\u6587\u5B57"), React.createElement("input", {
    type: "text",
    className: "w-full p-1 text-xs border rounded",
    value: toSafeDisplayText(rule.label, '報名中'),
    onChange: e => updateStatusRule(idx, 'label', e.target.value)
  })), React.createElement("div", {
    className: "col-span-3"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u984F\u8272"), React.createElement("select", {
    className: "w-full p-1 text-xs border rounded",
    value: toSafeDisplayText(rule.color, 'blue'),
    onChange: e => updateStatusRule(idx, 'color', e.target.value)
  }, COLOR_OPTIONS.map(c => React.createElement("option", {
    key: c.value,
    value: c.value
  }, c.label)))), React.createElement("button", {
    onClick: () => removeStatusRule(idx),
    className: "h-7 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  }))))), React.createElement("div", {
    className: "grid grid-cols-4 gap-2 items-end bg-slate-50 p-2 rounded border border-slate-100"
  }, React.createElement("div", null, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "Min"), React.createElement("input", {
    type: "number",
    className: "w-full p-1 text-xs border rounded",
    value: newRule.min,
    onChange: e => setNewRule({
      ...newRule,
      min: e.target.value
    })
  })), React.createElement("div", null, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "Max"), React.createElement("input", {
    type: "number",
    className: "w-full p-1 text-xs border rounded",
    value: newRule.max,
    onChange: e => setNewRule({
      ...newRule,
      max: e.target.value
    })
  })), React.createElement("div", {
    className: "col-span-2"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u986F\u793A\u6587\u5B57"), React.createElement("input", {
    type: "text",
    className: "w-full p-1 text-xs border rounded",
    placeholder: "\u5982: \u5831\u540D\u4E2D",
    value: newRule.label,
    onChange: e => setNewRule({
      ...newRule,
      label: e.target.value
    })
  })), React.createElement("div", {
    className: "col-span-2"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u984F\u8272"), React.createElement("select", {
    className: "w-full p-1 text-xs border rounded",
    value: newRule.color,
    onChange: e => setNewRule({
      ...newRule,
      color: e.target.value
    })
  }, COLOR_OPTIONS.map(c => React.createElement("option", {
    key: c.value,
    value: c.value
  }, c.label)))), React.createElement("div", {
    className: "col-span-2"
  }, React.createElement("button", {
    onClick: addStatusRule,
    className: "w-full py-1 bg-slate-800 text-white text-xs rounded hover:bg-slate-700"
  }, "\u65B0\u589E\u898F\u5247")))), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u6D3B\u52D5\u5831\u540D\u9023\u7D50"), React.createElement("input", {
    type: "text",
    className: "w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "https://...",
    value: eventLink,
    onChange: e => setEventLink(e.target.value)
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u6D3B\u52D5\u5C08\u5C6C\u5099\u8A3B"), React.createElement("textarea", {
    className: "w-full p-2 border border-slate-300 rounded-lg text-sm h-20 resize-none focus:ring-2 focus:ring-blue-500 outline-none",
    placeholder: "\u4F8B\u5982: \u8A18\u5F97\u5E36\u7121\u7DDA\u96FB...",
    value: eventNote,
    onChange: e => setEventNote(e.target.value)
  })))), React.createElement("section", null, React.createElement("div", {
    className: "flex justify-between items-center mb-2"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 flex items-center"
  }, React.createElement(Icon, {
    name: "check-square",
    size: 18,
    className: "mr-2"
  }), " \u57F7\u884C\u4EFB\u52D9"), React.createElement("button", {
    onClick: handleAddTask,
    className: "text-xs bg-blue-100 text-blue-600 px-2 py-1 rounded hover:bg-blue-200 flex items-center"
  }, React.createElement(Icon, {
    name: "plus",
    size: 14,
    className: "mr-1"
  }), " \u65B0\u589E")), React.createElement("div", {
    className: "w-full h-1.5 bg-slate-100 rounded-full mb-4 overflow-hidden"
  }, React.createElement("div", {
    className: "h-full bg-green-500 transition-all duration-500",
    style: {
      width: `${progress}%`
    }
  })), React.createElement("div", {
    className: "space-y-2"
  }, tasks.map((t, i) => React.createElement("div", {
    key: i,
    className: "flex items-center justify-between p-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 group"
  }, React.createElement("div", {
    className: "flex items-center gap-3 cursor-pointer",
    onClick: () => handleTaskToggle(i)
  }, React.createElement("div", {
    className: `w-4 h-4 rounded border flex items-center justify-center ${t.completed ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300'}`
  }, t.completed && React.createElement(Icon, {
    name: "check",
    size: 12
  })), React.createElement("span", {
    className: `text-sm ${t.completed ? 'text-slate-400 line-through' : 'text-slate-700 font-medium'}`
  }, toSafeDisplayText(t.name, '未命名任務'))), React.createElement("button", {
    onClick: () => handleDeleteTask(i),
    className: "text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  }))))))), React.createElement("div", {
    className: "p-4 border-t border-slate-100 bg-slate-50/50 rounded-b-2xl flex justify-between items-center"
  }, React.createElement("button", {
    onClick: onDeleteEvent,
    className: "px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1 font-bold text-sm"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 16
  }), " \u522A\u9664\u6B64\u6D3B\u52D5"), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: handleSave,
    className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium shadow-md"
  }, "\u5132\u5B58\u8A2D\u5B9A"))), showAddRegModal && React.createElement(AddEventCustomerModal, {
    eventData: event,
    historicalData: parsedData,
    onClose: () => setShowAddRegModal(false),
    onSave: handleSaveNewReg
  })));
};
const CalendarExportModal = ({
  events,
  eventConfigs,
  instructorSchedule = {},
  companyRestDates = [],
  outingDays = {},
  availableInstructors = [],
  posterNameOverrides = [],
  onClose
}) => {
  const getTodayDateStr = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const normalizeDateString = value => {
    if (!value) return '';
    const raw = String(value).trim();
    const match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (match) {
      const y = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const d = parseInt(match[3], 10);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
    const dt = new Date(raw);
    if (isNaN(dt.getTime())) return '';
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const handleRequestClose = e => {
    if (e) e.stopPropagation();
    onClose();
  };
  const toMonthStr = dateStr => {
    if (!dateStr) return '';
    return dateStr.slice(0, 7);
  };
  const formatExportDate = value => {
    const normalized = normalizeDateString(value);
    if (!normalized) return value || '';
    const [y, m, d] = normalized.split('-');
    return `${y}/${m}/${d}`;
  };
  const formatMatrixDate = value => {
    const normalized = normalizeDateString(value);
    if (!normalized) return value || '';
    const [, m, d] = normalized.split('-');
    return `${m}/${d}`;
  };
  const formatMatrixWeekday = value => {
    const normalized = normalizeDateString(value);
    if (!normalized) return '';
    const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
    const dt = parseLocalDateKey(normalized);
    return `（${weekdayLabels[dt.getDay()] || ''}）`;
  };
  const defaultEndDate = useMemo(() => {
    try {
      const list = Object.values(events);
      if (list.length === 0) {
        const d = new Date();
        d.setMonth(d.getMonth() + 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      const validDates = list.map(e => e.date).map(normalizeDateString).filter(Boolean).sort();
      if (validDates.length > 0) {
        return validDates[validDates.length - 1];
      }
    } catch (e) {
      console.error("日期計算錯誤", e);
    }
    return getTodayDateStr();
  }, [events]);
  const monthOptions = useMemo(() => {
    const months = new Set();
    Object.values(events).forEach(e => {
      const normalized = normalizeDateString(e.date);
      if (normalized) months.add(toMonthStr(normalized));
    });
    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [events]);
  const [exportMode, setExportMode] = useState('calendar');
  const [startDate, setStartDate] = useState(getTodayDateStr());
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [listingDate, setListingDate] = useState(getTodayDateStr());
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0] || getTodayDateStr().slice(0, 7));
  useEffect(() => {
    if (defaultEndDate) {
      setEndDate(defaultEndDate);
    }
  }, [defaultEndDate]);
  useEffect(() => {
    if (monthOptions.length === 0) {
      setSelectedMonth(getTodayDateStr().slice(0, 7));
      return;
    }
    if (!monthOptions.includes(selectedMonth)) {
      setSelectedMonth(monthOptions[0]);
    }
  }, [monthOptions, selectedMonth]);
  const uniqueEventNames = useMemo(() => {
    const names = new Set();
    Object.values(events).forEach(e => {
      const normalized = normalizeDateString(e.date);
      if (normalized && normalized >= startDate && normalized <= endDate) {
        names.add(e.eventName);
      }
    });
    return Array.from(names).sort();
  }, [events, startDate, endDate]);
  const handleToggleType = name => {
    if (selectedTypes.includes(name)) {
      setSelectedTypes(selectedTypes.filter(t => t !== name));
    } else {
      setSelectedTypes([...selectedTypes, name]);
    }
  };
  const selectAll = () => setSelectedTypes(uniqueEventNames);
  const clearAll = () => setSelectedTypes([]);
  const monthlyStats = useMemo(() => {
    const instructorMap = {};
    const validEvents = Object.values(events).filter(e => {
      const normalized = normalizeDateString(e.date);
      if (!normalized) return false;
      const cfg = eventConfigs[e.key] || {};
      return toMonthStr(normalized) === selectedMonth && !cfg.isCancelled;
    }).sort((a, b) => normalizeDateString(a.date).localeCompare(normalizeDateString(b.date)));
    validEvents.forEach(e => {
      const cfg = eventConfigs[e.key] || {};
      const names = cfg.leadInstructors && cfg.leadInstructors.length > 0 ? cfg.leadInstructors : (e.instructor || '未定').split(/[&,]/).map(s => s.trim()).filter(Boolean);
      const finalNames = names.length > 0 ? names : ['未定'];
      finalNames.forEach(name => {
        instructorMap[name] = (instructorMap[name] || 0) + 1;
      });
    });
    const instructorRows = Object.entries(instructorMap).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      totalGroups: validEvents.length,
      instructorRows
    };
  }, [events, eventConfigs, selectedMonth]);
  const buildDateRangeKeys = (start, end) => {
    const startKey = normalizeDateString(start);
    const endKey = normalizeDateString(end);
    if (!startKey || !endKey) return [];
    const startDateObj = parseLocalDateKey(startKey);
    const endDateObj = parseLocalDateKey(endKey);
    if (startDateObj > endDateObj) return [];
    const keys = [];
    const cursor = new Date(startDateObj);
    while (cursor <= endDateObj) {
      keys.push(formatLocalDateKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return keys;
  };
  const shiftDateKey = (dateKey, offset) => {
    const normalized = normalizeDateString(dateKey);
    if (!normalized) return '';
    const dateObj = parseLocalDateKey(normalized);
    dateObj.setDate(dateObj.getDate() + offset);
    return formatLocalDateKey(dateObj);
  };
  const parseInstructorAssignmentsForExport = (eventItem, cfg = {}) => {
    const cleanNames = names => Array.from(new Set((Array.isArray(names) ? names : []).map(name => String(name || '').trim()).filter(name => name && name !== '未定')));
    const leadNames = cleanNames(cfg.leadInstructors);
    const supportNames = cleanNames(cfg.supportInstructors).filter(name => !leadNames.includes(name));
    if (leadNames.length > 0 || supportNames.length > 0) {
      return [...leadNames.map(name => ({
        name,
        role: 'lead'
      })), ...supportNames.map(name => ({
        name,
        role: 'support'
      }))];
    }
    const fallbackNames = String(eventItem?.instructor || '').split(/[&,、，]/).map(name => String(name || '').trim()).filter(name => name && name !== '未定');
    return Array.from(new Set(fallbackNames)).map(name => ({
      name,
      role: 'lead'
    }));
  };
  const getScheduleExportEventName = (eventItem, cfg = {}) => {
    return toSafeDisplayText(resolvePosterEventName(eventItem, cfg, posterNameOverrides), toSafeDisplayText(eventItem?.eventName, '未命名活動')).trim() || '未命名活動';
  };
  const buildInstructorScheduleMatrixSheet = () => {
    const dateKeys = buildDateRangeKeys(startDate, endDate);
    if (dateKeys.length === 0) {
      alert("請確認開始日期與結束日期是否正確。");
      return null;
    }
    const dateSet = new Set(dateKeys);
    const instructorSet = new Set();
    const eventCellMap = {};
    const filteredEvents = Object.values(events).filter(eventItem => {
      const normalized = normalizeDateString(eventItem.date);
      if (!normalized) return false;
      const cfg = eventConfigs[eventItem.key] || {};
      const duration = Math.max(1, parseInt(cfg.duration, 10) || 1);
      const hasDateInRange = Array.from({
        length: duration
      }, (_, offset) => shiftDateKey(normalized, offset)).some(dateKey => dateSet.has(dateKey));
      if (!hasDateInRange) return false;
      const inType = selectedTypes.length === 0 || selectedTypes.includes(eventItem.eventName);
      return inType;
    }).sort((a, b) => {
      const da = normalizeDateString(a.date);
      const db = normalizeDateString(b.date);
      return da.localeCompare(db);
    });
    filteredEvents.forEach(eventItem => {
      const normalized = normalizeDateString(eventItem.date);
      const cfg = eventConfigs[eventItem.key] || {};
      const assignments = parseInstructorAssignmentsForExport(eventItem, cfg);
      const finalAssignments = assignments.length > 0 ? assignments : [{
        name: '未定',
        role: 'lead'
      }];
      const eventName = getScheduleExportEventName(eventItem, cfg);
      const duration = Math.max(1, parseInt(cfg.duration, 10) || 1);
      for (let offset = 0; offset < duration; offset += 1) {
        const occurrenceDate = shiftDateKey(normalized, offset);
        if (!dateSet.has(occurrenceDate)) continue;
        finalAssignments.forEach(assignment => {
          const name = assignment.name;
          const isSupport = assignment.role === 'support';
          instructorSet.add(name);
          eventCellMap[occurrenceDate] = eventCellMap[occurrenceDate] || {};
          eventCellMap[occurrenceDate][name] = eventCellMap[occurrenceDate][name] || [];
          eventCellMap[occurrenceDate][name].push({
            label: isSupport ? `(跟) ${eventName}` : eventName,
            style: cfg.isCancelled ? 'cancelled' : isSupport ? 'follow' : 'event'
          });
        });
      }
    });
    Object.entries(outingDays || {}).forEach(([dateKey, info]) => {
      const normalized = normalizeDateString(dateKey);
      if (!normalized || !dateSet.has(normalized) || !info?.enabled) return;
      const outingPeople = (Array.isArray(info.people) ? info.people : []).map(name => String(name || '').trim()).filter(name => name && name !== '未定');
      outingPeople.forEach(name => {
        instructorSet.add(name);
        eventCellMap[normalized] = eventCellMap[normalized] || {};
        eventCellMap[normalized][name] = eventCellMap[normalized][name] || [];
        eventCellMap[normalized][name].push({
          label: '場勘 / 取材',
          style: 'outing'
        });
      });
	    });
	    dateKeys.forEach(dateKey => {
	      getAllScheduleRestNames(instructorSchedule?.[dateKey]).forEach(name => {
	        const cleanName = String(name || '').trim();
	        if (cleanName) instructorSet.add(cleanName);
	      });
    });
    const instructorNames = Array.from(instructorSet).filter(name => name && name !== '未定').sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const fallbackInstructors = (Array.isArray(availableInstructors) ? availableInstructors : []).map(name => String(name || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const finalInstructorNames = instructorNames.length > 0 ? instructorNames : fallbackInstructors;
    if (finalInstructorNames.length === 0) {
      alert("目前沒有可輸出的講師欄位。");
      return null;
    }
    const companyRestSet = new Set((companyRestDates || []).map(date => normalizeDateString(date)).filter(Boolean));
    const rows = [[{
      value: '',
      style: 'header'
    }, {
      value: '日期',
      style: 'header'
    }, {
      value: '星期',
      style: 'header'
    }, ...finalInstructorNames.map(name => ({
      value: name,
      style: 'header'
    }))]];
    dateKeys.forEach(dateKey => {
	      const restItems = getScheduleRestDisplayItems(instructorSchedule?.[dateKey]);
	      const instructorCells = finalInstructorNames.map(name => {
	        const eventItems = eventCellMap?.[dateKey]?.[name] || [];
        if (eventItems.length > 0) {
          const hasCancelled = eventItems.some(item => item.style === 'cancelled');
          const hasPrimary = eventItems.some(item => item.style === 'event');
          const hasOuting = eventItems.some(item => item.style === 'outing');
          return {
            value: eventItems.map(item => item.label).join('\n'),
            style: hasCancelled ? 'cancelled' : hasPrimary ? 'event' : hasOuting ? 'outing' : 'follow'
          };
        }
	        if (companyRestSet.has(dateKey)) {
	          return {
	            value: '休',
	            style: 'rest'
	          };
	        }
	        const instructorRestItems = restItems.filter(item => item.name === name);
	        if (instructorRestItems.length > 0) {
	          return {
	            value: instructorRestItems.map(item => item.slot === 'all' ? '休' : `${item.label}休`).join('\n'),
	            style: 'rest'
	          };
	        }
	        return {
          value: '',
          style: 'blank',
          isBlank: true
        };
      });
      const emptyCellCount = instructorCells.filter(cell => cell === '' || cell?.isBlank).length;
      const markerValue = emptyCellCount >= 2 ? 'O' : emptyCellCount === 1 ? 'V' : '';
      const maxLineCount = Math.max(1, ...instructorCells.map(cell => String(cell?.value ?? cell ?? '').split('\n').length));
      const rowHeight = Math.min(110, 24 + (maxLineCount - 1) * 24);
      rows.push({
        height: rowHeight,
        cells: [{
          value: markerValue,
          style: markerValue === 'O' ? 'markerO' : markerValue === 'V' ? 'markerV' : 'date'
        }, {
          value: formatMatrixDate(dateKey),
          style: 'date'
        }, {
          value: formatMatrixWeekday(dateKey),
          style: 'date'
        }, ...instructorCells]
      });
    });
    return {
      name: `${startDate}_${endDate}講師排班`,
      columns: [{
        width: 28
      }, {
        width: 54
      }, {
        width: 42
      }, ...finalInstructorNames.map(() => ({
        width: 96
      }))],
      rows
    };
  };
  const handleExport = () => {
    if (exportMode === 'monthly') {
      if (!selectedMonth) return alert("請先選擇月份");
      if (monthlyStats.totalGroups === 0) return alert("該月份無可匯出資料（可能都被標記為流團）");
      let csvContent = "\uFEFF月份,總團數(已扣除流團)\n";
      csvContent += `${selectedMonth},${monthlyStats.totalGroups}\n\n`;
      csvContent += "講師,出團量\n";
      monthlyStats.instructorRows.forEach(([name, count]) => {
        csvContent += `${toCSVField(name)},${count}\n`;
      });
      downloadCSV(csvContent, `出團統計_${selectedMonth}.csv`);
      onClose();
      return;
    }
    if (exportMode === 'matrix') {
      const matrixSheet = buildInstructorScheduleMatrixSheet();
      if (!matrixSheet) return;
      downloadExcelWorkbook([matrixSheet], `講師排班表_${startDate}_${endDate}.xls`);
      onClose();
      return;
    }
    const filteredEvents = Object.values(events).filter(e => {
      const normalized = normalizeDateString(e.date);
      if (!normalized) return false;
      const inDate = normalized >= startDate && normalized <= endDate;
      const inType = selectedTypes.length === 0 || selectedTypes.includes(e.eventName);
      return inDate && inType;
    }).sort((a, b) => {
      const da = normalizeDateString(a.date);
      const db = normalizeDateString(b.date);
      return da.localeCompare(db);
    });
    if (filteredEvents.length === 0) return alert("無符合條件的資料");
    let csvContent = "\uFEFF講師,日期,,,,活動名稱,,,,,,,,,,,上架時間,一般票價格\n";
    filteredEvents.forEach(e => {
      const cfg = eventConfigs[e.key] || {};
      const colA = toCSVField(e.instructor || '未定');
      const colB = formatExportDate(e.date);
      const colF = toCSVField(e.eventName);
      const colQ = formatExportDate(listingDate);
      let price = cfg.price || 0;
      if (!price && e.customers && e.customers.length > 0) {
        const validP = e.customers.find(c => c.price > 0);
        if (validP) price = validP.price;
      }
      const colR = price;
      const row = `${colA},${colB},,,,${colF},,,,,,,,,,,${colQ},${colR}`;
      csvContent += row + "\n";
    });
    downloadCSV(csvContent, `月曆匯出_${startDate}_${endDate}.csv`);
    onClose();
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[90] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-lg p-6 shadow-2xl"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, React.createElement("h3", {
    className: "text-xl font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "download",
    className: "text-blue-600"
  }), " \u532F\u51FA\u6708\u66C6\u8CC7\u6599"), React.createElement("button", {
    onClick: handleRequestClose
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400 hover:text-slate-600"
  }))), React.createElement("div", {
    className: "space-y-4"
  }, React.createElement("div", {
    className: "bg-slate-50 border border-slate-200 rounded-lg p-1 grid grid-cols-3 gap-1"
  }, React.createElement("button", {
    onClick: () => setExportMode('calendar'),
    className: `py-2 rounded-md text-xs font-bold ${exportMode === 'calendar' ? 'bg-white text-blue-600 shadow' : 'text-slate-500'}`
  }, "\u6708\u66C6\u660E\u7D30"), React.createElement("button", {
    onClick: () => setExportMode('matrix'),
    className: `py-2 rounded-md text-xs font-bold ${exportMode === 'matrix' ? 'bg-white text-blue-600 shadow' : 'text-slate-500'}`
  }, "\u8B1B\u5E2B\u6392\u73ED\u8868"), React.createElement("button", {
    onClick: () => setExportMode('monthly'),
    className: `py-2 rounded-md text-xs font-bold ${exportMode === 'monthly' ? 'bg-white text-blue-600 shadow' : 'text-slate-500'}`
  }, "\u6BCF\u6708\u51FA\u5718")), (exportMode === 'calendar' || exportMode === 'matrix') && React.createElement(React.Fragment, null, React.createElement("div", {
    className: "grid grid-cols-2 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u958B\u59CB\u65E5\u671F"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg",
    value: startDate,
    onChange: e => setStartDate(e.target.value)
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u7D50\u675F\u65E5\u671F (\u6700\u5F8C\u4E00\u5718)"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg font-bold text-blue-600 bg-blue-50",
    value: endDate,
    onChange: e => setEndDate(e.target.value)
  }))), exportMode === 'calendar' && React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "Q\u6B04: \u4E0A\u67B6\u6642\u9593 (\u986F\u793A\u65BC\u5831\u8868)"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg bg-slate-50 border-slate-200",
    value: listingDate,
    onChange: e => setListingDate(e.target.value)
  })), exportMode === 'matrix' && React.createElement("div", {
    className: "text-xs text-slate-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
  }, "\u8B1B\u5E2B\u6392\u73ED\u8868\u6703\u8F38\u51FA\u300C\u65E5\u671F x \u8B1B\u5E2B\u300D\u77E9\u9663\uFF1A\u4F11\u5047\u986F\u793A\u300C\u4F11\u300D\u3001\u6C92\u4E8B\u7559\u7A7A\u767D\u3001\u540C\u5834\u975E\u7B2C\u4E00\u4F4D\u8B1B\u5E2B\u6703\u6A19\u300C\uFF08\u8DDF\u6D3B\u52D5\u540D\uFF09\u300D\u3002"), React.createElement("div", {
    className: "border-t pt-4"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-2"
  }, React.createElement("label", {
    className: "text-xs font-bold text-slate-500"
  }, "\u9078\u64C7\u6D3B\u52D5 (\u672A\u9078\u5247\u532F\u51FA\u5168\u90E8)"), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: selectAll,
    className: "text-[10px] bg-slate-100 px-2 py-1 rounded hover:bg-slate-200"
  }, "\u5168\u9078"), React.createElement("button", {
    onClick: clearAll,
    className: "text-[10px] bg-slate-100 px-2 py-1 rounded hover:bg-slate-200"
  }, "\u6E05\u7A7A"))), React.createElement("div", {
    className: "max-h-40 overflow-y-auto border rounded-lg p-2 bg-slate-50 grid grid-cols-2 gap-2"
  }, uniqueEventNames.length === 0 && React.createElement("div", {
    className: "col-span-2 text-center text-slate-400 py-4"
  }, "\u6B64\u65E5\u671F\u7BC4\u570D\u7121\u6D3B\u52D5"), uniqueEventNames.map(name => React.createElement("div", {
    key: name,
    onClick: () => handleToggleType(name),
    className: `text-xs p-2 rounded cursor-pointer border flex items-center gap-2 ${selectedTypes.includes(name) ? 'bg-blue-100 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-600'}`
  }, React.createElement("div", {
    className: `w-3 h-3 rounded-full border ${selectedTypes.includes(name) ? 'bg-blue-500 border-blue-500' : 'bg-white border-slate-300'}`
  }), name))))), exportMode === 'monthly' && React.createElement(React.Fragment, null, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u9078\u64C7\u6708\u4EFD"), React.createElement("select", {
    className: "w-full p-2 border rounded-lg bg-white",
    value: selectedMonth,
    onChange: e => setSelectedMonth(e.target.value)
  }, monthOptions.length === 0 && React.createElement("option", {
    value: ""
  }, "\u7121\u6D3B\u52D5\u6708\u4EFD"), monthOptions.map(m => React.createElement("option", {
    key: m,
    value: m
  }, m))), React.createElement("p", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "\u7D71\u8A08\u6703\u81EA\u52D5\u6263\u9664\u5DF2\u6A19\u8A18\u300C\u6D41\u5718\u300D\u7684\u5834\u6B21\u3002")), React.createElement("div", {
    className: "bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2"
  }, React.createElement("div", {
    className: "text-xs text-slate-500"
  }, "\u672C\u6708\u6709\u6548\u7E3D\u5718\u6578"), React.createElement("div", {
    className: "text-2xl font-bold text-slate-800"
  }, monthlyStats.totalGroups), React.createElement("div", {
    className: "border-t pt-2"
  }, React.createElement("div", {
    className: "text-xs font-bold text-slate-600 mb-1"
  }, "\u6BCF\u4F4D\u5E36\u5718\u8B1B\u5E2B\u51FA\u5718\u91CF"), React.createElement("div", {
    className: "max-h-32 overflow-y-auto space-y-1"
  }, monthlyStats.instructorRows.length === 0 && React.createElement("div", {
    className: "text-xs text-slate-400"
  }, "\u6B64\u6708\u4EFD\u7121\u6709\u6548\u8CC7\u6599"), monthlyStats.instructorRows.map(([name, count]) => React.createElement("div", {
    key: name,
    className: "text-xs flex justify-between bg-white px-2 py-1 rounded border border-slate-100"
  }, React.createElement("span", {
    className: "text-slate-600"
  }, name), React.createElement("span", {
    className: "font-bold text-blue-600"
  }, count)))))))), React.createElement("div", {
    className: "mt-6 flex justify-end gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg text-sm font-bold"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: handleExport,
    className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-md flex items-center gap-2 text-sm font-bold"
  }, React.createElement(Icon, {
    name: "file-text",
    size: 16
  }), " ", exportMode === 'monthly' ? '匯出月統計 (CSV)' : exportMode === 'matrix' ? '匯出講師排班表 (XLS)' : '匯出 Excel (CSV)'))));
};
const CreateEventModal = ({ onClose, onSave, customTemplates, onSaveTemplate, onDeleteTemplate, onReorderTemplates, availableInstructors, instructorSchedule, tagDefinitions, onAddTag, initialDate, initialInstructors = [], companyRestDates = [], existingScheduleByDate = {}, templatesLoadState = 'idle', onRetryTemplatesLoad }) => {
  const normalizedInitialInstructors = Array.isArray(initialInstructors) ? initialInstructors.map((name) => String(name || "").trim()).filter(Boolean) : [];
  const [mode, setMode] = useState("template");
  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(initialDate ? new Date(initialDate) : /* @__PURE__ */ new Date());
  const [templateCategoryFilter, setTemplateCategoryFilter] = useState("all");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const createEmptyTemplateData = () => ({
    id: null,
    name: "",
    eventName: "",
	    instructor: "",
	    time: "",
	    timeSlot: "",
	    duration: 1,
    prepDays: 0,
    prepTime: "",
    link: "",
    note: "",
    displayName: "",
    activityCategory: "",
    templateCategory: "",
    carpoolDisplayMode: "",
    isPrivateGroupEvent: false,
    privateGroupLabel: "此為包團活動",
    isCancelled: false,
    capacity: 12,
    price: "",
    tags: { levels: "", types: "", locations: "" },
    backendColor: "#eff6ff",
    statusRules: cloneDefaultStatusRules()
  });
  const getTemplateSelectionKey = getQuickCreateTemplateStableKey;
  const [formData, setFormData] = useState({
    dates: initialDate ? [initialDate] : [],
    eventName: "",
	    instructors: normalizedInitialInstructors,
	    time: "",
	    timeSlot: "",
	    duration: 1,
    prepDays: 0,
    prepTime: "",
    link: "",
    note: "",
    displayName: "",
    activityCategory: "",
    carpoolDisplayMode: "",
    isPrivateGroupEvent: false,
    privateGroupLabel: "此為包團活動",
    isCancelled: false,
    capacity: 12,
    price: "",
    // 新增價格
    tags: { levels: "", types: "", locations: "" },
    backendColor: "#eff6ff",
    statusRules: []
  });
  const [tempInstructor, setTempInstructor] = useState("");
  const [dismissedTemplateSuggestionKey, setDismissedTemplateSuggestionKey] = useState("");
  const [appliedTemplateSuggestionKey, setAppliedTemplateSuggestionKey] = useState("");
  const [templateAutofillNotice, setTemplateAutofillNotice] = useState("");
  const normalizedTemplates = useMemo(() => (customTemplates || []).map(normalizeQuickCreateTemplate), [customTemplates]);
  const isTemplatesLoading = templatesLoadState === "loading";
  const isTemplatesLoadError = templatesLoadState === "error";
  const filteredTemplates = useMemo(() => {
    if (templateCategoryFilter === "all") return normalizedTemplates;
    return normalizedTemplates.filter((tpl) => tpl.templateCategory === templateCategoryFilter);
  }, [normalizedTemplates, templateCategoryFilter]);
  const templateCategoryCounts = useMemo(() => QUICK_CREATE_TEMPLATE_CATEGORY_OPTIONS.reduce((acc, option) => {
    acc[option.value] = normalizedTemplates.filter((tpl) => tpl.templateCategory === option.value).length;
    return acc;
  }, { all: normalizedTemplates.length }), [normalizedTemplates]);
  const [newTemplateData, setNewTemplateData] = useState(createEmptyTemplateData);
  const [newRule, setNewRule] = useState({ min: 0, max: 10, label: "", color: "blue" });
	  const unavailableInstructors = useMemo(() => {
	    const unavailable = /* @__PURE__ */ new Set();
	    const selectedTimeSlot = normalizeScheduleTimeSlot(formData.timeSlot, inferScheduleTimeSlot(formData.time));
	    formData.dates.forEach((date) => {
	      getScheduleRestNamesForSlot(instructorSchedule[date], selectedTimeSlot).forEach((name) => unavailable.add(name));
	    });
	    return unavailable;
	  }, [formData.dates, formData.time, formData.timeSlot, instructorSchedule]);
  const normalizedFormEventName = useMemo(
    () => String(formData.eventName || "").trim().replace(/\s+/g, ""),
    [formData.eventName]
  );
  const matchedTemplate = useMemo(() => {
    if (!normalizedFormEventName) return null;
    const matches = normalizedTemplates.filter((tpl) => getTemplateEventNameKey(tpl) === normalizedFormEventName);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }, [normalizedTemplates, normalizedFormEventName]);
  const matchedTemplateKey = matchedTemplate ? `${matchedTemplate.id || matchedTemplate.name || matchedTemplate.eventName}::${normalizedFormEventName}` : "";
  const shouldShowTemplateSuggestion = !!(matchedTemplate && matchedTemplateKey && matchedTemplateKey !== dismissedTemplateSuggestionKey && matchedTemplateKey !== appliedTemplateSuggestionKey);
  const companyRestSet = useMemo(() => new Set((companyRestDates || []).map((date) => String(date || ""))), [companyRestDates]);
  const selectedDateSchedules = useMemo(() => [...formData.dates].sort().map((dateKey) => ({
    dateKey,
    isCompanyRest: companyRestSet.has(dateKey),
    items: Array.isArray(existingScheduleByDate?.[dateKey]) ? existingScheduleByDate[dateKey] : []
  })), [formData.dates, existingScheduleByDate, companyRestSet]);
  const getScheduledItemMeta = (item) => {
    const type = item?.type || "main";
    if (type === "prep") return { label: "\u524D\u7F6E", tone: "bg-amber-50 text-amber-700 border-amber-200" };
    if (type === "cont") return { label: "\u8DE8\u65E5", tone: "bg-slate-100 text-slate-600 border-slate-200" };
    return { label: "\u4E3B\u6D3B\u52D5", tone: "bg-blue-50 text-blue-700 border-blue-200" };
  };
  const addTemplateRule = () => {
    if (!newRule.label) return alert("\u8ACB\u8F38\u5165\u986F\u793A\u6587\u5B57");
    const currentRules = newTemplateData.statusRules || [];
    const updated = [...currentRules, newRule].sort((a, b) => parseInt(a.min) - parseInt(b.min));
    setNewTemplateData({ ...newTemplateData, statusRules: updated });
    setNewRule({ min: parseInt(newRule.max) + 1, max: parseInt(newRule.max) + 10, label: "", color: "blue" });
  };
  const removeTemplateRule = (idx) => {
    const currentRules = newTemplateData.statusRules || [];
    setNewTemplateData({ ...newTemplateData, statusRules: currentRules.filter((_, i) => i !== idx) });
  };
  const applyDefaultTemplateRules = () => {
    setNewTemplateData({
      ...newTemplateData,
      statusRules: cloneDefaultStatusRules()
    });
  };
  const addFormRule = () => {
    if (!newRule.label) return alert("\u8ACB\u8F38\u5165\u986F\u793A\u6587\u5B57");
    const currentRules = formData.statusRules || [];
    const updated = [...currentRules, newRule].sort((a, b) => parseInt(a.min) - parseInt(b.min));
    setFormData({ ...formData, statusRules: updated });
    setNewRule({ min: parseInt(newRule.max) + 1, max: parseInt(newRule.max) + 10, label: "", color: "blue" });
  };
  const removeFormRule = (idx) => {
    const currentRules = formData.statusRules || [];
    setFormData({ ...formData, statusRules: currentRules.filter((_, i) => i !== idx) });
  };
  const applyTemplateToForm = (tpl) => {
    let tplInstructors = [];
    if (tpl.instructor) tplInstructors = tpl.instructor.split(/[&,]/).map((s) => s.trim()).filter(Boolean);
    const templateEventName = getTemplateEventName(tpl);
    setFormData((prev) => {
      const nextInstructors = prev.instructors.length > 0 ? prev.instructors : tplInstructors;
      return {
        ...prev,
	        eventName: templateEventName,
	        instructors: nextInstructors,
	        time: tpl.time || "",
	        timeSlot: normalizeScheduleTimeSlot(tpl.timeSlot, inferScheduleTimeSlot(tpl.time)),
	        duration: parseInt(tpl.duration, 10) || 1,
        prepDays: parseInt(tpl.prepDays, 10) || 0,
        prepTime: tpl.prepTime || "",
        link: tpl.link || "",
        note: tpl.note || "",
        displayName: tpl.displayName || "",
        activityCategory: tpl.activityCategory || "",
        carpoolDisplayMode: resolveCarpoolDisplayMode(tpl.carpoolDisplayMode, templateEventName),
        isPrivateGroupEvent: !!tpl.isPrivateGroupEvent,
        privateGroupLabel: tpl.privateGroupLabel || "此為包團活動",
        isCancelled: !!tpl.isCancelled,
        capacity: tpl.capacity || 12,
        price: tpl.price || "",
        tags: tpl.tags || { levels: "", types: "", locations: "" },
        backendColor: tpl.backendColor || "#eff6ff",
        statusRules: tpl.statusRules ? normalizeStoredStatusRules(tpl.statusRules) : []
      };
    });
  };
  const handleTemplateSelect = (tpl, options = {}) => {
    applyTemplateToForm(tpl);
    setSelectedTemplateId(getTemplateSelectionKey(tpl));
    const templateEventName = getTemplateEventName(tpl);
    const templateKey = `${tpl.id || tpl.name || tpl.eventName}::${templateEventName.replace(/\s+/g, "")}`;
    setAppliedTemplateSuggestionKey(templateKey);
    setDismissedTemplateSuggestionKey("");
    if (options.fromSuggestion) {
      setTemplateAutofillNotice(`\u5DF2\u5F9E\u6A21\u677F\u300C${tpl.name || templateEventName}\u300D\u5E36\u5165\u6642\u9593\u3001\u9023\u7D50\u3001\u524D\u53F0\u540D\u7A31\u7B49\u9810\u8A2D\u5167\u5BB9\u3002`);
    } else {
      setTemplateAutofillNotice("");
    }
  };
  const handleEditTemplate = (e, tpl) => {
    e.stopPropagation();
    const templateEventName = getTemplateEventName(tpl);
    const templateStatusRules = tpl.statusRules ? normalizeStoredStatusRules(tpl.statusRules) : [];
    setNewTemplateData({
      id: tpl.id,
      name: tpl.name,
	      eventName: templateEventName,
	      instructor: tpl.instructor,
	      time: tpl.time || "",
	      timeSlot: normalizeScheduleTimeSlot(tpl.timeSlot, inferScheduleTimeSlot(tpl.time)),
	      duration: parseInt(tpl.duration, 10) || 1,
      prepDays: parseInt(tpl.prepDays, 10) || 0,
      prepTime: tpl.prepTime || "",
      link: tpl.link || "",
      note: tpl.note || "",
      displayName: tpl.displayName || "",
      activityCategory: tpl.activityCategory || "",
      templateCategory: normalizeQuickCreateTemplateCategory(tpl.templateCategory, templateEventName || tpl.name),
      carpoolDisplayMode: resolveCarpoolDisplayMode(tpl.carpoolDisplayMode, templateEventName),
      isPrivateGroupEvent: !!tpl.isPrivateGroupEvent,
      privateGroupLabel: tpl.privateGroupLabel || "此為包團活動",
      isCancelled: !!tpl.isCancelled,
      capacity: tpl.capacity || 12,
      price: tpl.price || "",
      // 載入價格
      tags: tpl.tags || { levels: "", types: "", locations: "" },
      backendColor: tpl.backendColor || "#eff6ff",
      statusRules: templateStatusRules.length > 0 ? templateStatusRules : cloneDefaultStatusRules()
      // 載入規則
    });
    setIsCreatingTemplate(true);
  };
  const handleMoveTemplate = (e, tpl, direction) => {
    e.stopPropagation();
    if (!onReorderTemplates) return;
    onReorderTemplates(tpl, direction, templateCategoryFilter);
  };
  useEffect(() => {
    setDismissedTemplateSuggestionKey("");
    setAppliedTemplateSuggestionKey("");
    setTemplateAutofillNotice("");
  }, [normalizedFormEventName]);
  const toggleDate = (dateStr) => {
    if (companyRestSet.has(dateStr)) return;
    let newDates = formData.dates.includes(dateStr) ? formData.dates.filter((d) => d !== dateStr) : [...formData.dates, dateStr].sort();
    setFormData({ ...formData, dates: newDates });
  };
	  const addInstructor = (name) => {
	    const clean = name.trim();
	    const selectedTimeSlot = normalizeScheduleTimeSlot(formData.timeSlot, inferScheduleTimeSlot(formData.time));
	    const isResting = formData.dates.some((d) => isInstructorRestingForSlot(instructorSchedule, d, clean, selectedTimeSlot));
	    if (isResting) {
	      if (!confirm(`${clean} \u5728\u90E8\u5206\u9078\u5B9A\u7684\u65E5\u671F\u5DF2\u6392 ${getScheduleSlotLabel(selectedTimeSlot)} \u4F11\uFF0C\u78BA\u5B9A\u8981\u6392\u5165\u55CE\uFF1F`)) return;
	    }
    if (clean && !formData.instructors.includes(clean)) setFormData({ ...formData, instructors: [...formData.instructors, clean] });
    setTempInstructor("");
  };
  const removeInstructor = (name) => {
    setFormData({ ...formData, instructors: formData.instructors.filter((i) => i !== name) });
  };
  const handleSubmitEvent = () => {
    if (formData.dates.length === 0) {
      alert("\u8ACB\u81F3\u5C11\u9078\u64C7\u4E00\u500B\u65E5\u671F");
      return;
    }
    onSave(formData);
  };
  const handleSaveNewTemplate = () => {
    if (!newTemplateData.name) {
      alert("\u8ACB\u8F38\u5165\u6A21\u677F\u540D\u7A31");
      return;
    }
    onSaveTemplate(normalizeQuickCreateTemplate(newTemplateData));
    setIsCreatingTemplate(false);
    setNewTemplateData(createEmptyTemplateData());
  };
  const renderCalendar = () => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    const days = Array(firstDay).fill(null).concat([...Array(daysInMonth).keys()].map((i) => i + 1));
    return /* @__PURE__ */ React.createElement("div", { className: "bg-slate-50 p-4 rounded-xl border border-slate-200 relative" }, /* @__PURE__ */ React.createElement("div", { className: "flex justify-between items-center mb-4" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setCalendarMonth(new Date(year, month - 1)) }, /* @__PURE__ */ React.createElement(Icon, { name: "chevron-left", size: 20 })), /* @__PURE__ */ React.createElement("span", { className: "font-bold text-slate-700" }, year, "\u5E74 ", month + 1, "\u6708"), /* @__PURE__ */ React.createElement("button", { onClick: () => setCalendarMonth(new Date(year, month + 1)) }, /* @__PURE__ */ React.createElement(Icon, { name: "chevron-right", size: 20 }))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-7 text-center mb-2 text-xs font-bold text-slate-400" }, ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"].map((d) => /* @__PURE__ */ React.createElement("div", { key: d }, d))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-7 gap-1" }, days.map((day, i) => {
      const dateStr = day ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` : "";
      const isCompanyRest = day ? companyRestSet.has(dateStr) : false;
      const isSelected = day ? formData.dates.includes(dateStr) : false;
      return /* @__PURE__ */ React.createElement("div", { key: i, className: "aspect-square flex items-center justify-center" }, day && /* @__PURE__ */ React.createElement(
        "button",
        {
          type: "button",
          disabled: isCompanyRest,
          title: isCompanyRest ? "\u672C\u65E5\u70BA\u5168\u516C\u53F8\u516C\u4F11\uFF0C\u7121\u6CD5\u6392\u6D3B\u52D5" : "",
          onClick: () => toggleDate(dateStr),
          className: `w-8 h-8 rounded-full text-sm transition-all ${isCompanyRest ? "bg-slate-200 text-slate-400 cursor-not-allowed line-through" : isSelected ? "bg-blue-600 text-white shadow-md" : "hover:bg-blue-100 text-slate-600"}`
        },
        day
      ));
    })), /* @__PURE__ */ React.createElement("div", { className: "mt-3 text-[11px] text-slate-400" }, "\u7070\u8272\u522A\u9664\u7DDA\u65E5\u671F\u4EE3\u8868\u5168\u516C\u53F8\u516C\u4F11\uFF0C\u5DF2\u9396\u5B9A\u4E0D\u53EF\u6392\u6D3B\u52D5\u3002"));
  };
  return /* @__PURE__ */ React.createElement("div", { className: "fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 fade-in backdrop-blur-sm" }, /* @__PURE__ */ React.createElement("div", { className: "bg-white rounded-2xl w-full max-w-lg flex flex-col max-h-[90vh] shadow-2xl m-auto relative" }, /* @__PURE__ */ React.createElement("div", { className: "p-6 border-b border-slate-100 flex justify-between items-center" }, /* @__PURE__ */ React.createElement("h3", { className: "text-xl font-bold flex items-center gap-2" }, /* @__PURE__ */ React.createElement(Icon, { name: "zap", className: "text-yellow-500" }), " \u5FEB\u901F\u958B\u5718"), /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-2" }, mode === "template" && !isCreatingTemplate && /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => (onRetryTemplatesLoad || (() => {}))(), disabled: isTemplatesLoading, className: `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${isTemplatesLoading ? "bg-blue-50 text-blue-500 border-blue-100 cursor-wait" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"}` }, /* @__PURE__ */ React.createElement(Icon, { name: isTemplatesLoading ? "loader-2" : "refresh-cw", size: 12, className: isTemplatesLoading ? "animate-spin" : "" }), isTemplatesLoading ? "\u6A21\u677F\u8F09\u5165\u4E2D" : "\u91CD\u65B0\u6574\u7406\u6A21\u677F"), /* @__PURE__ */ React.createElement("button", { onClick: onClose }, /* @__PURE__ */ React.createElement(Icon, { name: "x", className: "text-slate-400" })))), /* @__PURE__ */ React.createElement("div", { className: "p-6 overflow-y-auto space-y-6 custom-scrollbar" }, !isCreatingTemplate ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "flex bg-slate-100 p-1 rounded-lg" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setMode("template"), className: `flex-1 py-1.5 text-sm rounded-md transition-all ${mode === "template" ? "bg-white shadow text-blue-600" : "text-slate-500"}` }, "\u4F7F\u7528\u6A21\u677F"), /* @__PURE__ */ React.createElement("button", { onClick: () => setMode("custom"), className: `flex-1 py-1.5 text-sm rounded-md transition-all ${mode === "custom" ? "bg-white shadow text-blue-600" : "text-slate-500"}` }, "\u5B8C\u5168\u81EA\u8A02")), mode === "template" && /* @__PURE__ */ React.createElement("div", { className: "space-y-3" }, /* @__PURE__ */ React.createElement("div", { className: "flex flex-wrap gap-2" }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setTemplateCategoryFilter("all"), className: `px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${templateCategoryFilter === "all" ? "bg-slate-800 text-white border-slate-900" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"}` }, "\u5168\u90E8 ", templateCategoryCounts.all), QUICK_CREATE_TEMPLATE_CATEGORY_OPTIONS.map((option) => /* @__PURE__ */ React.createElement("button", { key: option.value, type: "button", onClick: () => setTemplateCategoryFilter(option.value), className: `px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${templateCategoryFilter === option.value ? "bg-blue-600 text-white border-blue-700 shadow-sm" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"}` }, option.label, " ", templateCategoryCounts[option.value] || 0))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-3 sm:grid-cols-4 gap-2" }, normalizedTemplates.length === 0 && /* @__PURE__ */ React.createElement("div", { className: `col-span-full text-center text-xs py-2 ${isTemplatesLoadError ? "text-red-500" : isTemplatesLoading ? "text-blue-500" : "text-slate-400"}` }, isTemplatesLoadError ? "\u6A21\u677F\u8B80\u53D6\u5931\u6557\uFF0C\u8ACB\u6309\u4E0A\u65B9\u6309\u9215\u91CD\u65B0\u6574\u7406" : isTemplatesLoading ? "\u6A21\u677F\u8F09\u5165\u4E2D..." : "\u7121\u6A21\u677F"), normalizedTemplates.length > 0 && filteredTemplates.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "col-span-full text-center text-slate-400 text-xs py-2" }, "\u9019\u500B\u5206\u985E\u76EE\u524D\u6C92\u6709\u6A21\u677F"), filteredTemplates.map((tpl, templateIndex) => {
    const canMoveTemplateUp = templateIndex > 0;
    const canMoveTemplateDown = templateIndex < filteredTemplates.length - 1;
    const templateKey = getTemplateSelectionKey(tpl);
    const isSelected = selectedTemplateId === templateKey;
    return /* @__PURE__ */ React.createElement("div", { key: templateKey, onClick: () => handleTemplateSelect(tpl), className: `relative border rounded-lg p-2 cursor-pointer text-center hover:shadow-sm transition-all ${isSelected ? "border-blue-500 ring-2 ring-blue-100 bg-blue-50" : "border-slate-200 bg-white"}`, style: isSelected ? { borderColor: tpl.backendColor } : {} }, /* @__PURE__ */ React.createElement("div", { className: "absolute -top-1 -left-1 flex gap-0.5" }, /* @__PURE__ */ React.createElement("button", { type: "button", disabled: !canMoveTemplateUp, title: "\u5F80\u524D\u79FB", onClick: (e) => handleMoveTemplate(e, tpl, "up"), className: `p-0.5 rounded-full border border-white bg-slate-100 text-slate-500 hover:text-blue-600 hover:bg-blue-50 ${!canMoveTemplateUp ? "opacity-35 cursor-not-allowed" : ""}` }, /* @__PURE__ */ React.createElement(Icon, { name: "chevron-up", size: 8 })), /* @__PURE__ */ React.createElement("button", { type: "button", disabled: !canMoveTemplateDown, title: "\u5F80\u5F8C\u79FB", onClick: (e) => handleMoveTemplate(e, tpl, "down"), className: `p-0.5 rounded-full border border-white bg-slate-100 text-slate-500 hover:text-blue-600 hover:bg-blue-50 ${!canMoveTemplateDown ? "opacity-35 cursor-not-allowed" : ""}` }, /* @__PURE__ */ React.createElement(Icon, { name: "chevron-down", size: 8 }))), /* @__PURE__ */ React.createElement("div", { className: "font-bold text-slate-700 text-[11px] truncate mb-1" }, toSafeDisplayText(tpl.name, toSafeDisplayText(getTemplateEventName(tpl), "\u6A21\u677F"))), /* @__PURE__ */ React.createElement("div", { className: "text-[9px] text-slate-400 truncate" }, toSafeDisplayText(tpl.instructor, "")), /* @__PURE__ */ React.createElement("div", { className: "mt-1.5" }, /* @__PURE__ */ React.createElement("span", { className: "inline-flex items-center px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-bold" }, toSafeDisplayText(QUICK_CREATE_TEMPLATE_CATEGORY_LABELS[tpl.templateCategory], "\u7279\u5225\u6D3B\u52D5"))), /* @__PURE__ */ React.createElement("button", { onClick: (e) => {
      e.stopPropagation();
      handleEditTemplate(e, tpl);
    }, className: "absolute -top-1 -right-1 p-0.5 bg-slate-100 rounded-full text-slate-400 hover:text-blue-500 border border-white" }, /* @__PURE__ */ React.createElement(Icon, { name: "edit-2", size: 8 })));
  }), /* @__PURE__ */ React.createElement("button", { onClick: () => setIsCreatingTemplate(true), className: "border border-dashed border-slate-300 rounded-lg p-1.5 flex flex-col items-center justify-center text-slate-400 hover:border-blue-400 hover:bg-blue-50 transition-all" }, /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 12 }), /* @__PURE__ */ React.createElement("span", { className: "text-[10px]" }, "\u65B0\u589E\u6A21\u677F")))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-2" }, "1. \u9078\u64C7\u65E5\u671F"), renderCalendar()), /* @__PURE__ */ React.createElement("div", { className: "space-y-4" }, /* @__PURE__ */ React.createElement("div", { className: "space-y-2" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "flex items-center justify-between gap-3 mb-1" }, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700" }, "2. \u6D3B\u52D5\u540D\u7A31"), /* @__PURE__ */ React.createElement("span", { className: "text-[11px] text-slate-400" }, "\u8F38\u5165\u5F8C\u6703\u81EA\u52D5\u63D0\u793A\u540C\u540D\u6A21\u677F")), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: formData.eventName, onChange: (e) => setFormData({ ...formData, eventName: e.target.value }), placeholder: "\u8F38\u5165\u540D\u7A31..." })), shouldShowTemplateSuggestion && /* @__PURE__ */ React.createElement("div", { className: "rounded-xl border border-amber-200 bg-amber-50 px-3 py-3" }, /* @__PURE__ */ React.createElement("div", { className: "flex items-start justify-between gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "text-xs font-bold text-amber-700 flex items-center gap-1" }, /* @__PURE__ */ React.createElement(Icon, { name: "sparkles", size: 12 }), " \u627E\u5230\u540C\u540D\u6A21\u677F"), /* @__PURE__ */ React.createElement("div", { className: "text-sm font-bold text-slate-700 mt-1" }, toSafeDisplayText(matchedTemplate.name, toSafeDisplayText(getTemplateEventName(matchedTemplate), "\u6A21\u677F"))), /* @__PURE__ */ React.createElement("div", { className: "text-[11px] text-slate-500 mt-1 leading-5" }, "\u9019\u500B\u6D3B\u52D5\u540D\u7A31\u548C\u6A21\u677F\u300C", toSafeDisplayText(getTemplateEventName(matchedTemplate), "\u6A21\u677F"), "\u300D\u4E00\u81F4\u3002\u8981\u4E0D\u8981\u76F4\u63A5\u5E36\u5165\u9810\u8A2D\u6642\u9593\u3001\u9023\u7D50\u3001\u524D\u53F0\u540D\u7A31\u3001\u6A19\u7C64\u548C\u5171\u4E58\u8A2D\u5B9A\uFF1F")), /* @__PURE__ */ React.createElement("div", { className: "shrink-0 flex gap-2" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      onClick: () => handleTemplateSelect(matchedTemplate, { fromSuggestion: true }),
      className: "px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-bold hover:bg-amber-600"
    },
    "\u5957\u7528\u5167\u5BB9"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      onClick: () => setDismissedTemplateSuggestionKey(matchedTemplateKey),
      className: "px-3 py-1.5 rounded-lg bg-white text-slate-500 text-xs font-bold border border-slate-200 hover:bg-slate-50"
    },
    "\u5148\u4E0D\u8981"
  )))), templateAutofillNotice && /* @__PURE__ */ React.createElement("div", { className: "rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-700" }, templateAutofillNotice)), /* @__PURE__ */ React.createElement("div", null, " ", /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "3. \u5E36\u5718\u8B1B\u5E2B"), " ", /* @__PURE__ */ React.createElement("div", { className: "flex flex-wrap gap-2 mb-2 min-h-[38px] p-2 bg-white border border-slate-200 rounded-lg" }, formData.instructors.map((ins) => /* @__PURE__ */ React.createElement("div", { key: ins, className: "flex items-center bg-blue-50 text-blue-700 px-2 py-1 rounded text-sm" }, /* @__PURE__ */ React.createElement("span", { className: "mr-1" }, ins), /* @__PURE__ */ React.createElement("button", { onClick: () => setFormData({ ...formData, instructors: formData.instructors.filter((i) => i !== ins) }) }, /* @__PURE__ */ React.createElement(Icon, { name: "x", size: 14 }))))), " ", /* @__PURE__ */ React.createElement("div", { className: "flex gap-2" }, /* @__PURE__ */ React.createElement("input", { type: "text", className: "flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500", value: tempInstructor, onChange: (e) => setTempInstructor(e.target.value), onKeyDown: (e) => e.key === "Enter" && addInstructor(tempInstructor), placeholder: "\u8F38\u5165\u540D\u5B57..." }), /* @__PURE__ */ React.createElement("button", { onClick: () => addInstructor(tempInstructor), className: "px-3 bg-slate-100 rounded-lg hover:bg-slate-200" }, /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 18 }))), " ", /* @__PURE__ */ React.createElement("div", { className: "flex flex-wrap gap-2 mt-2" }, availableInstructors.slice(0, 6).map((i) => /* @__PURE__ */ React.createElement("button", { key: i, onClick: () => addInstructor(i), className: `text-xs px-2 py-1 border rounded-full transition ${unavailableInstructors.has(i) ? "bg-slate-100 text-slate-400 border-slate-200" : "bg-slate-50 hover:bg-blue-50 text-slate-600"}` }, "+ ", i))), " "), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-2 gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "4. \u6D3B\u52D5\u6642\u9593"), /* @__PURE__ */ React.createElement("input", { type: "time", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: formData.time, onChange: (e) => setFormData({ ...formData, time: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "\u4EBA\u6578\u4E0A\u9650"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: formData.capacity, onChange: (e) => setFormData({ ...formData, capacity: e.target.value }) }))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-3 gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "\u6301\u7E8C\u5929\u6578"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: formData.duration, onChange: (e) => setFormData({ ...formData, duration: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "\u524D\u7F6E\u5929\u6578"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: formData.prepDays, onChange: (e) => setFormData({ ...formData, prepDays: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "\u524D\u7F6E\u6642\u9593"), /* @__PURE__ */ React.createElement("input", { type: "time", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: formData.prepTime, onChange: (e) => setFormData({ ...formData, prepTime: e.target.value }) }))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-2 gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "5. \u9810\u8A2D\u50F9\u683C"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", placeholder: "0", value: formData.price, onChange: (e) => setFormData({ ...formData, price: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "\u5F8C\u53F0\u984F\u8272"), /* @__PURE__ */ React.createElement("input", { type: "color", className: "w-full h-[40px] p-1 border border-slate-300 rounded-lg cursor-pointer", value: formData.backendColor, onChange: (e) => setFormData({ ...formData, backendColor: e.target.value }), title: "\u6B64\u984F\u8272\u50C5\u5728\u5F8C\u53F0\u53EF\u898B" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "6. \u6D3B\u52D5\u7DB2\u5740"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", placeholder: "https://...", value: formData.link, onChange: (e) => setFormData({ ...formData, link: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "7. \u524D\u53F0\u986F\u793A\u540D\u7A31 (\u9078\u586B)"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", placeholder: "\u4F8B\u5982: \u51AC\u5B63\u591C\u8A2A\u86D9\u985E", value: formData.displayName, onChange: (e) => setFormData({ ...formData, displayName: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-indigo-600 mb-1" }, "8. \u6D3B\u52D5\u6027\u8CEA\u540D\u7A31 (\u9078\u586B)"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 border border-indigo-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 bg-indigo-50/20", placeholder: "\u4F8B\u5982: \u8C61\u5C71\u591C\u9593\u5C0E\u89BD", value: formData.activityCategory, onChange: (e) => setFormData({ ...formData, activityCategory: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "9. \u524D\u53F0\u5171\u4E58\u986F\u793A"), /* @__PURE__ */ React.createElement("select", { className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500", value: resolveCarpoolDisplayMode(formData.carpoolDisplayMode, formData.eventName), onChange: (e) => setFormData({ ...formData, carpoolDisplayMode: e.target.value }) }, CARPOOL_DISPLAY_MODE_OPTIONS.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.label)))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-sm font-medium text-slate-700 mb-1" }, "10. \u6D3B\u52D5\u5C08\u5C6C\u5099\u8A3B"), /* @__PURE__ */ React.createElement("textarea", { className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 h-20 resize-none", placeholder: "\u4F8B\u5982\uFF1A\u96C6\u5408\u63D0\u9192\u3001\u88DD\u5099\u8AAA\u660E...", value: formData.note, onChange: (e) => setFormData({ ...formData, note: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "bg-rose-50 border border-rose-200 rounded-lg p-3 flex items-center justify-between" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "text-sm font-medium text-rose-700" }, "11. \u9810\u8A2D\u6A19\u8A18\u6D41\u5718"), /* @__PURE__ */ React.createElement("div", { className: "text-[10px] text-rose-500 mt-0.5" }, "\u5EFA\u7ACB\u6D3B\u52D5\u6642\u76F4\u63A5\u5E36\u5165\u6D41\u5718\u6A19\u8A18")), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setFormData({ ...formData, isCancelled: !formData.isCancelled }), className: `px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${formData.isCancelled ? "bg-rose-600 text-white border-rose-700" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}` }, formData.isCancelled ? "\u5DF2\u6A19\u8A18\u6D41\u5718" : "\u6A19\u8A18\u70BA\u6D41\u5718")), /* @__PURE__ */ React.createElement("div", { className: "bg-slate-50 p-2 rounded-lg border border-slate-200" }, /* @__PURE__ */ React.createElement("label", { className: "text-xs font-bold text-slate-500 mb-2 block" }, "12. \u9810\u8A2D\u6D3B\u52D5\u6A19\u7C64"), /* @__PURE__ */ React.createElement(TagSelector, { definitions: tagDefinitions, value: formData.tags, onChange: (type, val) => setFormData({ ...formData, tags: { ...formData.tags, [type]: val } }), onAddTag })), /* @__PURE__ */ React.createElement("div", { className: "bg-white border border-slate-200 rounded-lg p-3" }, /* @__PURE__ */ React.createElement("label", { className: "text-xs font-bold text-slate-500 mb-2 block flex justify-between" }, /* @__PURE__ */ React.createElement("span", null, "13. \u81EA\u5B9A\u7FA9\u72C0\u614B\u898F\u5247 (\u4F9D\u7167\u4EBA\u6578\u986F\u793A)"), /* @__PURE__ */ React.createElement("span", { className: "text-[10px] bg-slate-100 px-1 rounded font-normal" }, "\u5F9E\u4E0A\u5230\u4E0B\u5339\u914D")), /* @__PURE__ */ React.createElement("div", { className: "space-y-2 mb-3" }, (formData.statusRules || []).map((rule, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "flex items-center gap-2 text-xs" }, /* @__PURE__ */ React.createElement("span", { className: "w-12 text-center bg-slate-100 rounded py-1" }, toSafeDisplayText(rule.min, "0"), "-", toSafeDisplayText(rule.max, "999"), "\u4EBA"), /* @__PURE__ */ React.createElement("span", { className: `flex-1 px-2 py-1 rounded border text-center ${COLOR_OPTIONS.find((c) => c.value === rule.color)?.bg} ${COLOR_OPTIONS.find((c) => c.value === rule.color)?.text}` }, toSafeDisplayText(rule.label, "\u5831\u540D\u4E2D")), /* @__PURE__ */ React.createElement("button", { onClick: () => removeFormRule(idx), className: "text-slate-400 hover:text-red-500" }, /* @__PURE__ */ React.createElement(Icon, { name: "trash-2", size: 14 }))))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-4 gap-2 items-end bg-slate-50 p-2 rounded border border-slate-100" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "Min"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full p-1 text-xs border rounded", value: newRule.min, onChange: (e) => setNewRule({ ...newRule, min: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "Max"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full p-1 text-xs border rounded", value: newRule.max, onChange: (e) => setNewRule({ ...newRule, max: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "col-span-2" }, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "\u986F\u793A\u6587\u5B57"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full p-1 text-xs border rounded", placeholder: "\u5982: \u5831\u540D\u4E2D", value: newRule.label, onChange: (e) => setNewRule({ ...newRule, label: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "col-span-2" }, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "\u984F\u8272"), /* @__PURE__ */ React.createElement("select", { className: "w-full p-1 text-xs border rounded", value: newRule.color, onChange: (e) => setNewRule({ ...newRule, color: e.target.value }) }, COLOR_OPTIONS.map((c) => /* @__PURE__ */ React.createElement("option", { key: c.value, value: c.value }, c.label)))), /* @__PURE__ */ React.createElement("div", { className: "col-span-2" }, /* @__PURE__ */ React.createElement("button", { onClick: addFormRule, className: "w-full py-1 bg-slate-800 text-white text-xs rounded hover:bg-slate-700" }, "\u65B0\u589E\u898F\u5247")))))), /* @__PURE__ */ React.createElement("div", { className: "bg-slate-50 border border-slate-200 rounded-xl p-4" }, /* @__PURE__ */ React.createElement("div", { className: "flex items-center justify-between mb-3" }, /* @__PURE__ */ React.createElement("h4", { className: "text-sm font-bold text-slate-700 flex items-center gap-2" }, /* @__PURE__ */ React.createElement(Icon, { name: "list", size: 16 }), " \u540C\u65E5\u5DF2\u6392\u6D3B\u52D5"), /* @__PURE__ */ React.createElement("div", { className: "text-[11px] text-slate-400" }, "\u907F\u514D\u540C\u4E00\u5929\u91CD\u8907\u6392\u76F8\u4F3C\u884C\u7A0B")), /* @__PURE__ */ React.createElement("div", { className: "space-y-3" }, selectedDateSchedules.length > 0 ? selectedDateSchedules.map(({ dateKey, isCompanyRest, items }) => /* @__PURE__ */ React.createElement("div", { key: `scheduled_${dateKey}`, className: "bg-white border border-slate-200 rounded-xl p-3" }, /* @__PURE__ */ React.createElement("div", { className: "flex items-center justify-between mb-2" }, /* @__PURE__ */ React.createElement("div", { className: "text-sm font-bold text-slate-700" }, dateKey), isCompanyRest && /* @__PURE__ */ React.createElement("span", { className: "text-[10px] font-bold px-2 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200" }, "\u5168\u516C\u53F8\u516C\u4F11")), items.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "space-y-2" }, items.map((item, idx) => {
    const meta = getScheduledItemMeta(item);
    const evt = item.evt || {};
    const cfg = item.cfg || {};
    return /* @__PURE__ */ React.createElement("div", { key: `${dateKey}_${evt.key || evt.eventName || idx}_${item.type || "main"}_${idx}`, className: "flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "text-sm font-bold text-slate-700" }, toSafeDisplayText(evt.eventName, "\u672A\u547D\u540D\u6D3B\u52D5"), cfg.isCancelled && /* @__PURE__ */ React.createElement("span", { className: "ml-2 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200" }, "\u6D41\u5718")), /* @__PURE__ */ React.createElement("div", { className: "text-[11px] text-slate-500 mt-1" }, toSafeDisplayText(item.displayTime, "--:--"), " \xB7 @", toSafeDisplayText(evt.instructor, "\u672A\u5B9A"))), /* @__PURE__ */ React.createElement("span", { className: `shrink-0 text-[10px] font-bold px-2 py-1 rounded-full border ${meta.tone}` }, toSafeDisplayText(meta.label, "")));
  })) : /* @__PURE__ */ React.createElement("div", { className: "text-xs text-slate-400" }, "\u672C\u65E5\u5C1A\u7121\u5DF2\u6392\u6D3B\u52D5\u3002"))) : /* @__PURE__ */ React.createElement("div", { className: "text-xs text-slate-400" }, "\u5148\u9078\u65E5\u671F\u5F8C\uFF0C\u9019\u88E1\u6703\u5217\u51FA\u540C\u4E00\u5929\u5DF2\u6392\u7684\u6D3B\u52D5\u3002")))) : /* @__PURE__ */ React.createElement("div", { className: "bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3" }, /* @__PURE__ */ React.createElement("div", { className: "flex justify-between items-start gap-2" }, /* @__PURE__ */ React.createElement("h4", { className: "font-bold" }, newTemplateData.id ? "\u7DE8\u8F2F\u6A21\u677F" : "\u5EFA\u7ACB\u65B0\u6A21\u677F"), /* @__PURE__ */ React.createElement("div", { className: "flex gap-2" }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: applyDefaultTemplateRules, className: "rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-100" }, "\u5957\u7528\u76EE\u524D\u9810\u8A2D"), /* @__PURE__ */ React.createElement("button", { onClick: () => {
    setIsCreatingTemplate(false);
    setNewTemplateData(createEmptyTemplateData());
  }, className: "text-sm text-slate-500" }, "\u53D6\u6D88"))), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 text-sm border rounded-lg", placeholder: "\u6A21\u677F\u540D\u7A31 (\u5982: \u8C6A\u83EF\u5718)", value: newTemplateData.name, onChange: (e) => setNewTemplateData({ ...newTemplateData, name: e.target.value }) }), /* @__PURE__ */ React.createElement("div", { className: "bg-white border border-slate-200 rounded-xl p-3" }, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-2" }, "\u6A21\u677F\u5206\u985E"), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-3 gap-2" }, QUICK_CREATE_TEMPLATE_CATEGORY_OPTIONS.map((option) => {
    const isActive = normalizeQuickCreateTemplateCategory(newTemplateData.templateCategory, newTemplateData.eventName || newTemplateData.name) === option.value;
    return /* @__PURE__ */ React.createElement(
      "button",
      {
        key: option.value,
        type: "button",
        onClick: () => setNewTemplateData({ ...newTemplateData, templateCategory: option.value }),
        className: `rounded-xl border px-3 py-2 text-left transition-all ${isActive ? "border-blue-500 bg-blue-50 text-blue-700 shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`
      },
      /* @__PURE__ */ React.createElement("div", { className: "text-xs font-bold" }, option.label),
      /* @__PURE__ */ React.createElement("div", { className: "text-[10px] mt-1 opacity-80" }, option.helper)
    );
  })), /* @__PURE__ */ React.createElement("div", { className: "text-[10px] text-slate-400 mt-2" }, "\u82E5\u820A\u6A21\u677F\u5C1A\u672A\u8A2D\u5B9A\u5206\u985E\uFF0C\u7CFB\u7D71\u6703\u5148\u4F9D\u6D3B\u52D5\u540D\u7A31\u81EA\u52D5\u5224\u65B7\uFF0C\u4F60\u4E5F\u53EF\u4EE5\u5728\u9019\u88E1\u624B\u52D5\u4FEE\u6B63\u3002")), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 text-sm border rounded-lg", placeholder: "\u9810\u8A2D\u6D3B\u52D5\u540D\u7A31", value: newTemplateData.eventName, onChange: (e) => setNewTemplateData({ ...newTemplateData, eventName: e.target.value }) }), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 text-sm border rounded-lg", placeholder: "\u9810\u8A2D\u8B1B\u5E2B", value: newTemplateData.instructor, onChange: (e) => setNewTemplateData({ ...newTemplateData, instructor: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u6642\u9593"), /* @__PURE__ */ React.createElement("input", { type: "time", className: "w-full px-3 py-2 text-sm border rounded-lg", value: newTemplateData.time, onChange: (e) => setNewTemplateData({ ...newTemplateData, time: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u4EBA\u6578"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full px-3 py-2 text-sm border rounded-lg", value: newTemplateData.capacity, onChange: (e) => setNewTemplateData({ ...newTemplateData, capacity: e.target.value }) }))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-3 gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u6301\u7E8C\u5929\u6578"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", className: "w-full px-3 py-2 text-sm border rounded-lg", value: newTemplateData.duration, onChange: (e) => setNewTemplateData({ ...newTemplateData, duration: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u524D\u7F6E\u5929\u6578"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "0", className: "w-full px-3 py-2 text-sm border rounded-lg", value: newTemplateData.prepDays, onChange: (e) => setNewTemplateData({ ...newTemplateData, prepDays: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u524D\u7F6E\u6642\u9593"), /* @__PURE__ */ React.createElement("input", { type: "time", className: "w-full px-3 py-2 text-sm border rounded-lg", value: newTemplateData.prepTime, onChange: (e) => setNewTemplateData({ ...newTemplateData, prepTime: e.target.value }) }))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u50F9\u683C (R\u6B04)"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full px-3 py-2 text-sm border rounded-lg", placeholder: "900", value: newTemplateData.price, onChange: (e) => setNewTemplateData({ ...newTemplateData, price: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u5F8C\u53F0\u984F\u8272"), /* @__PURE__ */ React.createElement("input", { type: "color", className: "w-full h-[36px] p-1 border rounded-lg cursor-pointer", value: newTemplateData.backendColor, onChange: (e) => setNewTemplateData({ ...newTemplateData, backendColor: e.target.value }) }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u7DB2\u5740"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 text-sm border rounded-lg", placeholder: "https://...", value: newTemplateData.link, onChange: (e) => setNewTemplateData({ ...newTemplateData, link: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u5099\u8A3B"), /* @__PURE__ */ React.createElement("textarea", { className: "w-full px-3 py-2 text-sm border rounded-lg h-20 resize-none", placeholder: "\u4F8B\u5982\uFF1A\u96C6\u5408\u5730\u9EDE\u63D0\u9192\u3001\u88DD\u5099\u63D0\u9192...", value: newTemplateData.note, onChange: (e) => setNewTemplateData({ ...newTemplateData, note: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u524D\u53F0\u540D\u7A31"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 text-sm border rounded-lg", placeholder: "\u4F8B\u5982: \u51AC\u5B63\u591C\u8A2A\u86D9\u985E", value: newTemplateData.displayName, onChange: (e) => setNewTemplateData({ ...newTemplateData, displayName: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-indigo-600 mb-1" }, "\u9810\u8A2D\u6027\u8CEA\u540D\u7A31"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full px-3 py-2 text-sm border rounded-lg border-indigo-200 bg-indigo-50/20", placeholder: "\u4F8B\u5982: \u8C61\u5C71\u591C\u9593\u5C0E\u89BD", value: newTemplateData.activityCategory, onChange: (e) => setNewTemplateData({ ...newTemplateData, activityCategory: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("label", { className: "block text-xs font-bold text-slate-500 mb-1" }, "\u9810\u8A2D\u5171\u4E58\u986F\u793A"), /* @__PURE__ */ React.createElement("select", { className: "w-full px-3 py-2 text-sm border rounded-lg", value: resolveCarpoolDisplayMode(newTemplateData.carpoolDisplayMode, newTemplateData.eventName), onChange: (e) => setNewTemplateData({ ...newTemplateData, carpoolDisplayMode: e.target.value }) }, CARPOOL_DISPLAY_MODE_OPTIONS.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.label)))), /* @__PURE__ */ React.createElement("div", { className: "bg-rose-50 border border-rose-200 rounded-lg p-3 flex items-center justify-between" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "text-xs font-bold text-rose-700" }, "\u9810\u8A2D\u6A19\u8A18\u6D41\u5718"), /* @__PURE__ */ React.createElement("div", { className: "text-[10px] text-rose-500 mt-0.5" }, "\u4F7F\u7528\u6A21\u677F\u958B\u5718\u6642\u81EA\u52D5\u5E36\u5165")), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setNewTemplateData({ ...newTemplateData, isCancelled: !newTemplateData.isCancelled }), className: `px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${newTemplateData.isCancelled ? "bg-rose-600 text-white border-rose-700" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}` }, newTemplateData.isCancelled ? "\u5DF2\u6A19\u8A18\u6D41\u5718" : "\u6A19\u8A18\u70BA\u6D41\u5718")), /* @__PURE__ */ React.createElement("div", { className: "bg-white p-2 rounded-lg border border-slate-200" }, /* @__PURE__ */ React.createElement("label", { className: "text-xs font-bold text-slate-500 mb-2 block" }, "\u9810\u8A2D\u6D3B\u52D5\u6A19\u7C64"), /* @__PURE__ */ React.createElement(TagSelector, { definitions: tagDefinitions, value: newTemplateData.tags, onChange: (type, val) => setNewTemplateData({ ...newTemplateData, tags: { ...newTemplateData.tags, [type]: val } }), onAddTag })), /* @__PURE__ */ React.createElement("div", { className: "bg-white border border-slate-200 rounded-lg p-3" }, /* @__PURE__ */ React.createElement("label", { className: "text-xs font-bold text-slate-500 mb-2 block flex justify-between" }, /* @__PURE__ */ React.createElement("span", null, "\u9810\u8A2D\u72C0\u614B\u898F\u5247 (\u4F9D\u7167\u4EBA\u6578\u986F\u793A)"), /* @__PURE__ */ React.createElement("span", { className: "text-[10px] bg-slate-100 px-1 rounded font-normal" }, "\u5F9E\u4E0A\u5230\u4E0B\u5339\u914D")), /* @__PURE__ */ React.createElement("div", { className: "space-y-2 mb-3" }, (newTemplateData.statusRules || []).map((rule, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "flex items-center gap-2 text-xs" }, /* @__PURE__ */ React.createElement("span", { className: "w-12 text-center bg-slate-100 rounded py-1" }, toSafeDisplayText(rule.min, "0"), "-", toSafeDisplayText(rule.max, "999"), "\u4EBA"), /* @__PURE__ */ React.createElement("span", { className: `flex-1 px-2 py-1 rounded border text-center ${COLOR_OPTIONS.find((c) => c.value === rule.color)?.bg} ${COLOR_OPTIONS.find((c) => c.value === rule.color)?.text}` }, toSafeDisplayText(rule.label, "\u5831\u540D\u4E2D")), /* @__PURE__ */ React.createElement("button", { onClick: () => removeTemplateRule(idx), className: "text-slate-400 hover:text-red-500" }, /* @__PURE__ */ React.createElement(Icon, { name: "trash-2", size: 14 }))))), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-4 gap-2 items-end bg-slate-50 p-2 rounded border border-slate-100" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "Min"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full p-1 text-xs border rounded", value: newRule.min, onChange: (e) => setNewRule({ ...newRule, min: e.target.value }) })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "Max"), /* @__PURE__ */ React.createElement("input", { type: "number", className: "w-full p-1 text-xs border rounded", value: newRule.max, onChange: (e) => setNewRule({ ...newRule, max: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "col-span-2" }, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "\u986F\u793A\u6587\u5B57"), /* @__PURE__ */ React.createElement("input", { type: "text", className: "w-full p-1 text-xs border rounded", placeholder: "\u5982: \u5831\u540D\u4E2D", value: newRule.label, onChange: (e) => setNewRule({ ...newRule, label: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "col-span-2" }, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-slate-400" }, "\u984F\u8272"), /* @__PURE__ */ React.createElement("select", { className: "w-full p-1 text-xs border rounded", value: newRule.color, onChange: (e) => setNewRule({ ...newRule, color: e.target.value }) }, COLOR_OPTIONS.map((c) => /* @__PURE__ */ React.createElement("option", { key: c.value, value: c.value }, c.label)))), /* @__PURE__ */ React.createElement("div", { className: "col-span-2" }, /* @__PURE__ */ React.createElement("button", { onClick: addTemplateRule, className: "w-full py-1 bg-slate-800 text-white text-xs rounded hover:bg-slate-700" }, "\u65B0\u589E\u898F\u5247")))), /* @__PURE__ */ React.createElement("div", { className: "flex gap-2" }, newTemplateData.id && /* @__PURE__ */ React.createElement("button", { onClick: () => {
    if (confirm("\u78BA\u5B9A\u522A\u9664?")) {
      onDeleteTemplate(newTemplateData.id);
      setIsCreatingTemplate(false);
      setNewTemplateData(createEmptyTemplateData());
    }
  }, className: "flex-1 py-2 bg-red-100 text-red-600 rounded-lg text-sm" }, "\u522A\u9664"), /* @__PURE__ */ React.createElement("button", { onClick: handleSaveNewTemplate, className: "flex-[2] py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm" }, "\u5132\u5B58\u6A21\u677F")))), !isCreatingTemplate && /* @__PURE__ */ React.createElement("div", { className: "p-4 border-t border-slate-100 flex justify-end items-center gap-4 bg-slate-50/50 rounded-b-2xl" }, /* @__PURE__ */ React.createElement("span", { className: "text-xs text-slate-500" }, "\u5C07\u5EFA\u7ACB ", formData.dates.length, " \u5834\u6D3B\u52D5"), /* @__PURE__ */ React.createElement("button", { onClick: () => {
    if (formData.dates.length === 0) {
      alert("\u8ACB\u81F3\u5C11\u9078\u64C7\u4E00\u500B\u65E5\u671F\uFF01");
      return;
    }
    onSave(formData);
  }, className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium shadow-md" }, "\u6279\u91CF\u5EFA\u7ACB"))));
};
const TaskDetailModal = ({
  task,
  eventData,
  onClose
}) => {
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-lg flex flex-col max-h-[90vh] shadow-2xl"
  }, React.createElement("div", {
    className: "p-6 border-b flex justify-between items-center"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded inline-block mb-1"
  }, eventData.date), React.createElement("h3", {
    className: "text-xl font-bold"
  }, task.name)), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "p-6 overflow-y-auto"
  }, React.createElement("div", {
    className: "text-center text-slate-500 py-8"
  }, "\u4EFB\u52D9\u8A73\u7D30\u5167\u5BB9\u529F\u80FD\u5340 (\u53EF\u5728\u6B64\u64F4\u5145)"))));
};
const PLAN_ACTIVITY_TEMPLATES = {
  theme: {
    id: 'theme',
    label: '主題活動',
    prefix: '',
    defaultRevenuePerPax: 850,
    helper: '地名 + 動物，例如：大安鼠'
  },
  afterWork: {
    id: 'afterWork',
    label: '下班後走走',
    prefix: '下班走走',
    defaultRevenuePerPax: 800,
    helper: '下班走走XX'
  },
  special: {
    id: 'special',
    label: '特殊活動',
    prefix: '',
    defaultRevenuePerPax: '',
    helper: '其他自訂活動'
  }
};
const PLAN_ACTIVITY_TEMPLATE_LIST = Object.values(PLAN_ACTIVITY_TEMPLATES);
const PLAN_SPECIAL_ACTIVITY_NAMES = new Set(['北橫蛇']);
const PLAN_THEME_ANIMAL_SUFFIXES = ['貓頭鷹', '蝙蝠', '飛鼠', '松鼠', '蜥蜴', '蟾蜍', '穿山甲', '水鹿', '梅花鹿', '山羌', '夜鷺', '老鷹', '螢火蟲', '鼠', '兔', '蛇', '龜', '蛙', '蜥', '蟾', '狐', '鹿', '猴', '鳥', '蟬', '螢'];
const normalizePlanActivityTemplateType = value => PLAN_ACTIVITY_TEMPLATES[value] ? value : 'special';
const inferPlanActivityTemplateType = (eventName = '') => {
  const cleanName = String(eventName || '').trim();
  if (PLAN_SPECIAL_ACTIVITY_NAMES.has(cleanName)) return 'special';
  if (cleanName.startsWith('下班走走')) return 'afterWork';
  if (cleanName.startsWith('夜訪')) return 'theme';
  if (/^[\u3400-\u9fff]{2,10}$/.test(cleanName) && PLAN_THEME_ANIMAL_SUFFIXES.some(suffix => cleanName.endsWith(suffix))) {
    return 'theme';
  }
  return 'special';
};
const buildPlanningActivityDraft = (rawName, templateType = 'special') => {
  const normalizedType = normalizePlanActivityTemplateType(templateType);
  let cleanName = String(rawName || '').trim();
  if (!cleanName) {
    const template = PLAN_ACTIVITY_TEMPLATES[normalizedType];
    return {
      name: '',
      templateType: normalizedType,
      defaultRevenuePerPax: template.defaultRevenuePerPax
    };
  }
  const inferredType = inferPlanActivityTemplateType(cleanName);
  const finalType = inferredType === 'special' ? normalizedType : inferredType;
  const template = PLAN_ACTIVITY_TEMPLATES[finalType];
  if (template.prefix && inferredType === 'special' && !cleanName.startsWith(template.prefix)) {
    cleanName = `${template.prefix}${cleanName}`;
  }
  return {
    name: cleanName,
    templateType: finalType,
    defaultRevenuePerPax: template.defaultRevenuePerPax
  };
};
const MonthlyKpiPanel = ({
  monthLabel,
  actuals,
  target,
  activityRows,
  availableEventNames,
  onChangeTarget,
  onChangeActivityTarget,
  onAddActivityTarget,
  onSave,
  saveStatus,
  onPrevMonth,
  onNextMonth,
  onMatrixCellClick
}) => {
  const [selectedActivity, setSelectedActivity] = useState('');
  useEffect(() => {
    setSelectedActivity('');
  }, [monthLabel]);
  const remainingEventOptions = availableEventNames.filter(name => !activityRows.some(row => row.name === name));
  const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const formatValue = (value, digits = 0) => Number(value || 0).toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  const formatDayChip = dateKey => {
    if (!dateKey) return '';
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const dt = new Date(year, (month || 1) - 1, day || 1);
    if (Number.isNaN(dt.getTime())) return String(dateKey);
    return `${month}/${day}(${weekdayLabels[dt.getDay()]})`;
  };
  const getMatrixHeaderParts = dateKey => {
    if (!dateKey) return {
      day: '',
      weekday: ''
    };
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const dt = new Date(year, (month || 1) - 1, day || 1);
    if (Number.isNaN(dt.getTime())) return {
      day: String(dateKey).slice(-2),
      weekday: ''
    };
    return {
      day,
      weekday: weekdayLabels[dt.getDay()]
    };
  };
  const matrixLegendItems = [{
    label: '可排',
    tone: 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }, {
    label: '已排',
    tone: 'bg-sky-50 text-sky-700 border-sky-200'
  }, {
    label: '排休',
    tone: 'bg-rose-50 text-rose-700 border-rose-200'
  }, {
    label: '公休',
    tone: 'bg-slate-100 text-slate-500 border-slate-200'
  }, {
    label: '已過',
    tone: 'bg-slate-50 text-slate-300 border-slate-100'
  }];
  const getMatrixCellTone = state => ({
    available: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    busy: 'bg-sky-50 text-sky-700 border-sky-200',
    rest: 'bg-rose-50 text-rose-700 border-rose-200',
    companyRest: 'bg-slate-100 text-slate-500 border-slate-200',
    past: 'bg-slate-50 text-slate-300 border-slate-100'
  })[state] || 'bg-white text-slate-400 border-slate-200';
  const getMatrixCellTitle = cell => ({
    available: '可排活動',
    busy: '已排活動',
    rest: '個人排休',
    companyRest: '全公司公休',
    past: '已過日期'
  })[cell?.state] || '未分類';
  const formatTarget = (value, digits = 0, suffix = '') => value === '' || value === null || value === undefined ? '未設定' : `${formatValue(value, digits)}${suffix}`;
  const getDiffText = (actualValue, targetValue, digits = 0, suffix = '') => {
    if (targetValue === '' || targetValue === null || targetValue === undefined) return '尚未設定目標';
    const diff = Number(actualValue || 0) - Number(targetValue || 0);
    const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
    return `差額 ${sign}${formatValue(Math.abs(diff), digits)}${suffix}`;
  };
  const cardStyles = {
    blue: {
      border: 'border-blue-100',
      bg: 'bg-blue-50',
      text: 'text-blue-600'
    },
    amber: {
      border: 'border-amber-100',
      bg: 'bg-amber-50',
      text: 'text-amber-600'
    },
    emerald: {
      border: 'border-emerald-100',
      bg: 'bg-emerald-50',
      text: 'text-emerald-600'
    },
    indigo: {
      border: 'border-indigo-100',
      bg: 'bg-indigo-50',
      text: 'text-indigo-600'
    }
  };
  const summaryCards = [{
    key: 'totalPax',
    label: '總人數',
    icon: 'users',
    tone: 'blue',
    actual: actuals.totalPax,
    target: target.totalPax,
    digits: 0,
    suffix: ' 人',
    note: `已出 ${actuals.completedPax} / 未出 ${actuals.upcomingPax}`
  }, {
    key: 'inventoryDays',
    label: '講師庫存人日',
    icon: 'calendar-days',
    tone: 'amber',
    actual: actuals.inventoryDays,
    target: target.inventoryDays,
    digits: 0,
    suffix: ' 人日',
    note: `可用講師人日 ${actuals.availableInstructorDays} / 已占用 ${actuals.busyInstructorDays}`
  }, {
    key: 'avgPaxPerSession',
    label: '平均每團人數',
    icon: 'bar-chart-2',
    tone: 'emerald',
    actual: actuals.avgPaxPerSession,
    target: target.avgPaxPerSession,
    digits: 1,
    suffix: ' 人',
    note: `總團數 ${actuals.totalSessions}`
  }, {
    key: 'fillRate',
    label: '整體滿載率',
    icon: 'pie-chart',
    tone: 'indigo',
    actual: actuals.fillRate,
    target: target.fillRate,
    digits: 1,
    suffix: '%',
    note: `總容量 ${actuals.totalCapacity}`
  }];
  return React.createElement("div", {
    className: "order-last mt-6 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"
  }, React.createElement("div", {
    className: "p-5 border-b border-slate-100 bg-slate-50/80"
  }, React.createElement("div", {
    className: "flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold uppercase tracking-wider text-slate-400 mb-1"
  }, "\u6D3B\u52D5\u5834\u6B21 KPI"), React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("button", {
    onClick: onPrevMonth,
    className: "p-2 rounded-full hover:bg-white border border-slate-200 text-slate-500"
  }, React.createElement(Icon, {
    name: "chevron-left",
    size: 16
  })), React.createElement("div", {
    className: "text-lg font-bold text-slate-800 min-w-[120px] text-center"
  }, monthLabel), React.createElement("button", {
    onClick: onNextMonth,
    className: "p-2 rounded-full hover:bg-white border border-slate-200 text-slate-500"
  }, React.createElement(Icon, {
    name: "chevron-right",
    size: 16
  }))), React.createElement("div", {
    className: "text-[11px] text-slate-400 mt-2"
  }, "\u5EAB\u5B58 = \u7576\u5929\u975E\u5168\u516C\u53F8\u516C\u4F11\uFF0C\u4E14\u8A72\u8B1B\u5E2B\u672A\u6392\u4F11\u3001\u672A\u6392\u6D3B\u52D5 / \u524D\u7F6E / \u8DE8\u65E5 / \u5834\u52D8\uFF0C\u5373\u8A18 1 \u500B\u8B1B\u5E2B\u5EAB\u5B58\u4EBA\u65E5")), React.createElement("div", {
    className: "flex items-center gap-3"
  }, React.createElement("div", {
    className: "text-xs text-slate-400"
  }, saveStatus === 'saving' && 'KPI 儲存中...', saveStatus === 'success' && 'KPI 已儲存', saveStatus === 'error' && 'KPI 儲存失敗', saveStatus === 'idle' && '可按月份分別設定'), React.createElement("button", {
    onClick: onSave,
    className: "bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 shadow-sm"
  }, React.createElement(Icon, {
    name: "save",
    size: 16
  }), " \u5132\u5B58\u672C\u6708 KPI")))), React.createElement("div", {
    className: "p-5 space-y-6"
  }, React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
  }, summaryCards.map(card => {
    const tone = cardStyles[card.tone];
    return React.createElement("div", {
      key: card.key,
      className: `rounded-2xl border ${tone.border} p-4 ${tone.bg}`
    }, React.createElement("div", {
      className: "flex items-center justify-between mb-3"
    }, React.createElement("div", {
      className: "text-xs font-bold uppercase tracking-wide text-slate-500"
    }, card.label), React.createElement(Icon, {
      name: card.icon,
      size: 16,
      className: tone.text
    })), React.createElement("div", {
      className: "text-3xl font-bold text-slate-800"
    }, formatValue(card.actual, card.digits), React.createElement("span", {
      className: "text-sm font-medium text-slate-400 ml-1"
    }, card.suffix.trim())), React.createElement("div", {
      className: "mt-2 text-xs text-slate-500"
    }, card.note), React.createElement("div", {
      className: "mt-4"
    }, React.createElement("label", {
      className: "block text-[11px] font-bold text-slate-500 mb-1"
    }, "\u76EE\u6A19\u503C"), React.createElement("input", {
      type: "number",
      step: card.digits > 0 ? '0.1' : '1',
      className: "w-full px-3 py-2 rounded-lg border border-white bg-white/90 text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-200",
      value: card.target,
      onChange: e => onChangeTarget(card.key, e.target.value, card.digits > 0),
      placeholder: "\u672A\u8A2D\u5B9A"
    }), React.createElement("div", {
      className: "mt-2 text-[11px] text-slate-400"
    }, "\u76EE\u6A19 ", formatTarget(card.target, card.digits, card.suffix), "\uFF0C", getDiffText(card.actual, card.target, card.digits, card.suffix))));
  })), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, [{
    label: '講師利用率',
    value: `${formatValue(actuals.utilizationRate, 1)}%`,
    tone: 'text-blue-600 bg-blue-50 border-blue-100'
  }, {
    label: '講師數',
    value: `${actuals.instructorCount} 位`,
    tone: 'text-slate-600 bg-slate-50 border-slate-200'
  }, {
    label: '講師已占用',
    value: `${actuals.busyInstructorDays} 人日`,
    tone: 'text-indigo-600 bg-indigo-50 border-indigo-100'
  }, {
    label: '講師排休',
    value: `${actuals.restInstructorDays} 人日`,
    tone: 'text-rose-600 bg-rose-50 border-rose-100'
  }, {
    label: '全公司公休',
    value: `${actuals.companyRestDays} 天`,
    tone: 'text-orange-600 bg-orange-50 border-orange-100'
  }, {
    label: '場勘日',
    value: `${actuals.outingDaysCount} 天`,
    tone: 'text-amber-600 bg-amber-50 border-amber-100'
  }].map(item => React.createElement("div", {
    key: item.label,
    className: `px-3 py-2 rounded-xl border text-xs font-bold ${item.tone}`
  }, React.createElement("span", {
    className: "mr-2 opacity-80"
  }, item.label), React.createElement("span", null, item.value)))), React.createElement("div", {
    className: "bg-emerald-50/50 border border-emerald-100 rounded-2xl p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "calendar-days",
    size: 16
  }), " \u8B1B\u5E2B\u53EF\u6392\u65E5\u671F"), React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u50C5\u5217\u4ECA\u5929\u8D77\u4ECD\u53EF\u5B89\u6392\u7684\u65E5\u671F\uFF1B\u6C92\u6709\u7DA0\u8272\u65E5\u671F\u4EE3\u8868\u672C\u6708\u5269\u9918\u5929\u6578\u5DF2\u6392\u6EFF\u6216\u6392\u4F11\u3002")), React.createElement("div", {
    className: "text-xs font-bold text-emerald-700 bg-white border border-emerald-100 rounded-full px-3 py-1.5 self-start lg:self-auto"
  }, "\u5269\u9918\u53EF\u6392 ", actuals.remainingAvailableInstructorDays, " \u4EBA\u65E5")), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
  }, actuals.availabilityByInstructor.map(row => React.createElement("div", {
    key: row.name,
    className: "bg-white rounded-xl border border-emerald-100 p-4 shadow-sm"
  }, React.createElement("div", {
    className: "flex items-start justify-between gap-3 mb-3"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-sm font-bold text-slate-800"
  }, row.name), React.createElement("div", {
    className: "text-[11px] text-slate-400 mt-1"
  }, "\u5C1A\u53EF\u6392 ", row.upcomingAvailableCount, " \u5929 / \u5DF2\u6392 ", row.upcomingBusyCount, " \u5929 / \u6392\u4F11 ", row.upcomingRestCount, " \u5929")), React.createElement("div", {
    className: `px-2.5 py-1 rounded-full text-xs font-bold border ${row.upcomingAvailableCount > 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-400 border-slate-200'}`
  }, row.upcomingAvailableCount, " \u5929")), row.upcomingAvailableDates.length > 0 ? React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, row.upcomingAvailableDates.map(dateKey => React.createElement("span", {
    key: `${row.name}_${dateKey}`,
    className: "px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 text-xs font-bold"
  }, formatDayChip(dateKey)))) : React.createElement("div", {
    className: "text-xs text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2"
  }, "\u672C\u6708\u5269\u9918\u65E5\u671F\u6C92\u6709\u53EF\u6392\u7A7A\u6A94"))), actuals.availabilityByInstructor.length === 0 && React.createElement("div", {
    className: "md:col-span-2 xl:col-span-3 text-center text-slate-400 py-8 bg-white rounded-xl border border-dashed border-emerald-100"
  }, "\u76EE\u524D\u5C1A\u7121\u53EF\u8A08\u7B97\u7684\u8B1B\u5E2B\u8CC7\u6599\u3002"))), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-2xl p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "grid-2x2",
    size: 16
  }), " \u8B1B\u5E2B x \u65E5\u671F\u77E9\u9663"), React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u6574\u6708\u4E00\u773C\u770B\u5B8C\u8AB0\u5728\u54EA\u4E00\u5929\u53EF\u6392\u3002\u7DA0\u8272\u53EF\u6392\u3001\u85CD\u8272\u5DF2\u6392\u3001\u7D05\u8272\u6392\u4F11\u3001\u7070\u8272\u516C\u4F11\u6216\u5DF2\u904E\u3002")), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, matrixLegendItems.map(item => React.createElement("div", {
    key: item.label,
    className: `px-2.5 py-1 rounded-full border text-[11px] font-bold ${item.tone}`
  }, item.label)))), React.createElement("div", {
    className: "overflow-x-auto"
  }, React.createElement("table", {
    className: "min-w-[1100px] border-separate border-spacing-1 text-xs"
  }, React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", {
    className: "sticky left-0 z-20 bg-white border border-slate-200 rounded-xl px-3 py-2 text-left min-w-[120px]"
  }, React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500 uppercase tracking-wide"
  }, "\u8B1B\u5E2B")), actuals.matrixDates.map(dateKey => {
    const header = getMatrixHeaderParts(dateKey);
    const isToday = dateKey === actuals.todayKey;
    return React.createElement("th", {
      key: `matrix_head_${dateKey}`,
      className: `min-w-[42px] px-0.5 py-1 text-center rounded-xl border ${isToday ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500'}`
    }, React.createElement("div", {
      className: "text-[11px] font-bold leading-none"
    }, header.day), React.createElement("div", {
      className: "text-[10px] opacity-70 mt-1 leading-none"
    }, header.weekday));
  }))), React.createElement("tbody", null, actuals.availabilityMatrix.map(row => React.createElement("tr", {
    key: `matrix_${row.name}`
  }, React.createElement("td", {
    className: "sticky left-0 z-10 bg-white border border-slate-200 rounded-xl px-3 py-2 align-middle"
  }, React.createElement("div", {
    className: "font-bold text-slate-700"
  }, row.name), React.createElement("div", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "\u53EF ", row.upcomingAvailableCount, " / \u5718 ", row.upcomingBusyCount, " / \u4F11 ", row.upcomingRestCount)), row.cells.map(cell => {
    const isToday = cell.dateKey === actuals.todayKey;
    const isClickable = cell.state === 'available' && typeof onMatrixCellClick === 'function';
    const cellTitle = `${row.name} ${cell.dateKey} ${getMatrixCellTitle(cell)}${isClickable ? '，點擊快速開團' : ''}`;
    const cellClassName = `w-9 h-9 rounded-lg border flex items-center justify-center font-bold transition-all ${getMatrixCellTone(cell.state)} ${isToday ? 'ring-1 ring-blue-300' : ''} ${isClickable ? 'cursor-pointer hover:scale-105 hover:shadow-sm' : ''}`;
    return React.createElement("td", {
      key: `${row.name}_${cell.dateKey}`,
      className: "p-0.5"
    }, isClickable ? React.createElement("button", {
      type: "button",
      title: cellTitle,
      onClick: () => onMatrixCellClick(row.name, cell.dateKey),
      className: cellClassName
    }, cell.label) : React.createElement("div", {
      title: cellTitle,
      className: cellClassName
    }, cell.label));
  }))), actuals.availabilityMatrix.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: Math.max((actuals.matrixDates?.length || 0) + 1, 2),
    className: "px-4 py-8 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200"
  }, "\u76EE\u524D\u5C1A\u7121\u53EF\u8A08\u7B97\u7684\u8B1B\u5E2B\u6708\u77E9\u9663\u3002")))))), React.createElement("div", {
    className: "bg-slate-50 border border-slate-200 rounded-2xl p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "briefcase",
    size: 16
  }), " \u5404\u6D3B\u52D5\u6708\u5718\u6578 KPI"), React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u6BCF\u500B\u6D3B\u52D5\u53EF\u8A2D\u5B9A\u672C\u6708\u76EE\u6A19\u5718\u6578\uFF0C\u4E26\u540C\u6B65\u986F\u793A\u5DF2\u51FA / \u672A\u51FA\u3002")), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("select", {
    className: "px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600",
    value: selectedActivity,
    onChange: e => setSelectedActivity(e.target.value)
  }, React.createElement("option", {
    value: ""
  }, "\u65B0\u589E\u6D3B\u52D5\u76EE\u6A19..."), remainingEventOptions.map(name => React.createElement("option", {
    key: name,
    value: name
  }, name))), React.createElement("button", {
    onClick: () => {
      if (!selectedActivity) return;
      onAddActivityTarget(selectedActivity);
      setSelectedActivity('');
    },
    className: "px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-100 flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "plus",
    size: 14
  }), " \u52A0\u5165"))), React.createElement("div", {
    className: "overflow-x-auto bg-white rounded-xl border border-slate-200"
  }, React.createElement("table", {
    className: "w-full min-w-[760px] text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-4 py-3 text-left"
  }, "\u6D3B\u52D5\u540D\u7A31"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u5BE6\u969B\u5718\u6578"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u5DF2\u51FA"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u672A\u51FA"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u76EE\u6A19\u5718\u6578"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u5DEE\u984D"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, activityRows.map(row => React.createElement("tr", {
    key: row.name,
    className: "hover:bg-slate-50"
  }, React.createElement("td", {
    className: "px-4 py-3 font-medium text-slate-700"
  }, row.name), React.createElement("td", {
    className: "px-4 py-3 text-center font-bold text-slate-700"
  }, row.actual.total), React.createElement("td", {
    className: "px-4 py-3 text-center font-bold text-emerald-600"
  }, row.actual.completed), React.createElement("td", {
    className: "px-4 py-3 text-center font-bold text-amber-600"
  }, row.actual.upcoming), React.createElement("td", {
    className: "px-4 py-3 text-center"
  }, React.createElement("input", {
    type: "number",
    min: "0",
    className: "w-24 px-2 py-1.5 rounded-lg border border-slate-200 text-center font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-200",
    value: row.target,
    onChange: e => onChangeActivityTarget(row.name, e.target.value),
    placeholder: "-"
  })), React.createElement("td", {
    className: "px-4 py-3 text-center text-xs text-slate-400"
  }, row.target === '' || row.target === null || row.target === undefined ? '未設定' : `${row.actual.total - Number(row.target)} 團`))), activityRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "6",
    className: "px-4 py-8 text-center text-slate-400"
  }, "\u672C\u6708\u5C1A\u7121\u6D3B\u52D5\uFF0C\u4E5F\u5C1A\u672A\u8A2D\u5B9A\u6D3B\u52D5 KPI\u3002"))))))));
};
const MonthlyReport = ({
  month,
  data,
  events,
  eventConfigs
}) => {
  const [expanded, setExpanded] = useState(false);
  const stats = useMemo(() => {
    const rev = data.reduce((sum, row) => sum + (Number(row.price) || 0), 0);
    const pax = data.length;
    const sources = {};
    const monthlyActivityMap = {};
    const leadInstructorMap = {};
    const supportInstructorMap = {};
    const createSplitCounter = () => ({
      total: 0,
      completed: 0,
      upcoming: 0
    });
    const createActivityCounter = () => ({
      sessions: createSplitCounter(),
      pax: createSplitCounter(),
      revenue: createSplitCounter()
    });
    const bumpSplit = (counter, bucket, amount = 1) => {
      counter.total += amount;
      counter[bucket] += amount;
    };
    const getDateKey = value => {
      if (!value) return '';
      if (value instanceof Date) {
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
      }
      const raw = String(value).trim();
      const match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
      if (!match) return raw;
      return `${match[1]}-${String(parseInt(match[2], 10)).padStart(2, '0')}-${String(parseInt(match[3], 10)).padStart(2, '0')}`;
    };
    const getMonthKey = value => {
      const dateKey = getDateKey(value);
      return dateKey ? dateKey.slice(0, 7) : '';
    };
    const todayKey = getDateKey(new Date());
    const parseInstructorNames = value => String(value || '').split(/[&,]/).map(part => part.trim()).filter(name => name && name !== '未定');
    const monthSummary = {
      sessions: createSplitCounter(),
      pax: createSplitCounter(),
      leadTrips: createSplitCounter(),
      supportTrips: createSplitCounter()
    };
    data.forEach(row => {
      const rawSrc = row.source || '未知';
      const srcParts = rawSrc.split(/\s+/).filter(part => part.trim().length > 0);
      if (srcParts.length === 0) srcParts.push('未知');
      srcParts.forEach(part => {
        sources[part] = (sources[part] || 0) + 1;
      });
    });
    Object.values(events || {}).filter(evt => evt?.date && getMonthKey(evt.date) === month).forEach(evt => {
      const cfg = eventConfigs?.[evt.key] || {};
      if (cfg.isCancelled) return;
      const dateKey = getDateKey(evt.date);
      const bucket = dateKey && dateKey < todayKey ? 'completed' : 'upcoming';
      const customers = Array.isArray(evt.customers) ? evt.customers : [];
      const paxCount = Number.isFinite(Number(evt.count)) ? Number(evt.count) : customers.length;
      const revenue = customers.reduce((sum, customer) => sum + (Number(customer.price) || 0), 0);
      if (!monthlyActivityMap[evt.eventName]) {
        monthlyActivityMap[evt.eventName] = createActivityCounter();
      }
      const activityRow = monthlyActivityMap[evt.eventName];
      bumpSplit(activityRow.sessions, bucket, 1);
      bumpSplit(activityRow.pax, bucket, paxCount);
      bumpSplit(activityRow.revenue, bucket, revenue);
      bumpSplit(monthSummary.sessions, bucket, 1);
      bumpSplit(monthSummary.pax, bucket, paxCount);
      const leadNames = Array.from(new Set(Array.isArray(cfg.leadInstructors) && cfg.leadInstructors.length > 0 ? cfg.leadInstructors.map(name => String(name || '').trim()).filter(Boolean) : parseInstructorNames(evt.instructor)));
      const supportNames = Array.from(new Set(Array.isArray(cfg.supportInstructors) ? cfg.supportInstructors.map(name => String(name || '').trim()).filter(Boolean) : []));
      leadNames.forEach(name => {
        if (!name || name === '未定') return;
        if (!leadInstructorMap[name]) leadInstructorMap[name] = createSplitCounter();
        bumpSplit(leadInstructorMap[name], bucket, 1);
        bumpSplit(monthSummary.leadTrips, bucket, 1);
      });
      supportNames.forEach(name => {
        if (!name || name === '未定') return;
        if (!supportInstructorMap[name]) supportInstructorMap[name] = createSplitCounter();
        bumpSplit(supportInstructorMap[name], bucket, 1);
        bumpSplit(monthSummary.supportTrips, bucket, 1);
      });
    });
    const monthlyActivityRows = Object.entries(monthlyActivityMap).sort((a, b) => b[1].sessions.total - a[1].sessions.total || b[1].pax.total - a[1].pax.total || a[0].localeCompare(b[0]));
    const leadInstructorRows = Object.entries(leadInstructorMap).sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
    const supportInstructorRows = Object.entries(supportInstructorMap).sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
    return {
      rev,
      pax,
      sources,
      monthlyActivityRows,
      leadInstructorRows,
      supportInstructorRows,
      monthSummary
    };
  }, [data, events, eventConfigs, month]);
  const handleDownloadReport = e => {
    e.stopPropagation();
    const toCsvCell = value => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const toCsvLine = fields => fields.map(toCsvCell).join(',');
    const sourceRows = Object.entries(stats.sources).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const lines = [];
    lines.push(toCsvLine(['月份', month]));
    lines.push(toCsvLine(['總營收', stats.rev]));
    lines.push(toCsvLine(['總人數（已扣除流團）', stats.monthSummary.pax.total]));
    lines.push(toCsvLine(['總團數（已扣除流團）', stats.monthSummary.sessions.total]));
    lines.push(toCsvLine(['主講師總出團', stats.monthSummary.leadTrips.total]));
    lines.push(toCsvLine(['跟團講師總出團', stats.monthSummary.supportTrips.total]));
    lines.push('');
    lines.push('月統計概覽（已出 = 日期早於今天，已扣除流團）');
    lines.push(toCsvLine(['項目', '總數', '已出', '未出']));
    lines.push(toCsvLine(['活動團數', stats.monthSummary.sessions.total, stats.monthSummary.sessions.completed, stats.monthSummary.sessions.upcoming]));
    lines.push(toCsvLine(['活動人數', stats.monthSummary.pax.total, stats.monthSummary.pax.completed, stats.monthSummary.pax.upcoming]));
    lines.push(toCsvLine(['主講師出團', stats.monthSummary.leadTrips.total, stats.monthSummary.leadTrips.completed, stats.monthSummary.leadTrips.upcoming]));
    lines.push(toCsvLine(['跟團講師出團', stats.monthSummary.supportTrips.total, stats.monthSummary.supportTrips.completed, stats.monthSummary.supportTrips.upcoming]));
    lines.push('');
    lines.push('每一場活動統計（已扣除流團）');
    lines.push(toCsvLine(['活動名稱', '總團數', '已出團數', '未出團數', '總人數', '已出人數', '未出人數', '總營收']));
    if (stats.monthlyActivityRows.length === 0) {
      lines.push(toCsvLine(['無資料', 0, 0, 0, 0, 0, 0, 0]));
    } else {
      stats.monthlyActivityRows.forEach(([name, row]) => {
        lines.push(toCsvLine([name, row.sessions.total, row.sessions.completed, row.sessions.upcoming, row.pax.total, row.pax.completed, row.pax.upcoming, row.revenue.total]));
      });
    }
    lines.push('');
    lines.push('主講師出團數（已扣除流團）');
    lines.push(toCsvLine(['講師', '總出團數', '已出', '未出']));
    if (stats.leadInstructorRows.length === 0) {
      lines.push(toCsvLine(['無資料', 0, 0, 0]));
    } else {
      stats.leadInstructorRows.forEach(([name, row]) => {
        lines.push(toCsvLine([name, row.total, row.completed, row.upcoming]));
      });
    }
    lines.push('');
    lines.push('跟團講師出團數（已扣除流團）');
    lines.push(toCsvLine(['講師', '總出團數', '已出', '未出']));
    if (stats.supportInstructorRows.length === 0) {
      lines.push(toCsvLine(['無資料', 0, 0, 0]));
    } else {
      stats.supportInstructorRows.forEach(([name, row]) => {
        lines.push(toCsvLine([name, row.total, row.completed, row.upcoming]));
      });
    }
    lines.push('');
    lines.push('報名管道分析');
    lines.push(toCsvLine(['來源', '人數', '占比']));
    if (sourceRows.length === 0) {
      lines.push(toCsvLine(['無資料', 0, '0%']));
    } else {
      sourceRows.forEach(([src, count]) => {
        const ratio = stats.pax > 0 ? `${Math.round(count / stats.pax * 100)}%` : '0%';
        lines.push(toCsvLine([src, count, ratio]));
      });
    }
    lines.push('');
    lines.push('詳細資料');
    lines.push(CSV_HEADER);
    data.forEach(row => {
      lines.push(toCsvLine([row.date || '', row.eventName || '', row.instructor || '', row.customerName || '', Number(row.price) || 0, row.transport || '', row.idNo || '', row.birthday || '', row.email || '', row.source || '', row.socialName || '', row.notes || '', row.orderDate || '', row.phone || '', row.isCheckedIn ? 1 : 0]));
    });
    downloadCSV(lines.join('\n'), `${month}_report.csv`);
  };
  return React.createElement("div", {
    className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-4 transition-all"
  }, React.createElement("div", {
    className: "p-4 flex justify-between items-start gap-4 cursor-pointer hover:bg-slate-50",
    onClick: () => setExpanded(!expanded)
  }, React.createElement("div", {
    className: "flex-1 min-w-0"
  }, React.createElement("div", {
    className: "flex flex-wrap items-center gap-3"
  }, React.createElement("div", {
    className: "text-lg font-bold text-slate-700"
  }, month), React.createElement("div", {
    className: "text-sm text-slate-500 bg-slate-100 px-2 py-0.5 rounded"
  }, "\u7E3D\u6536 $", stats.rev.toLocaleString()), React.createElement("div", {
    className: "text-sm text-slate-500"
  }, "(", stats.monthSummary.pax.total, " \u4EBA)")), React.createElement("div", {
    className: "flex flex-wrap gap-2 mt-3"
  }, React.createElement("div", {
    className: "text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-100"
  }, "\u7E3D\u5718\u6578 ", stats.monthSummary.sessions.total, " \u5718"), React.createElement("div", {
    className: "text-xs px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100"
  }, "\u7E3D\u4EBA\u6578 ", stats.monthSummary.pax.total, " \u4EBA"), React.createElement("div", {
    className: "text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100"
  }, "\u4E3B\u8B1B ", stats.monthSummary.leadTrips.total, " \u5718"), React.createElement("div", {
    className: "text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-100"
  }, "\u8DDF\u5718 ", stats.monthSummary.supportTrips.total, " \u5718"))), React.createElement(Icon, {
    name: expanded ? 'chevron-up' : 'chevron-down',
    className: "text-slate-400 mt-1 shrink-0"
  })), expanded && React.createElement("div", {
    className: "p-4 border-t border-slate-100 bg-slate-50/50 animate-in fade-in space-y-6"
  }, React.createElement("div", null, React.createElement("div", {
    className: "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3"
  }, React.createElement("h5", {
    className: "text-xs font-bold text-slate-500 uppercase flex items-center"
  }, React.createElement(Icon, {
    name: "layout-grid",
    size: 14,
    className: "mr-1"
  }), " \u51FA\u5718\u6982\u89BD"), React.createElement("span", {
    className: "text-[11px] text-slate-400"
  }, "\u5DF2\u51FA = \u65E5\u671F\u65E9\u65BC\u4ECA\u5929\uFF1B\u672A\u51FA = \u4ECA\u5929\u8D77\u5C1A\u672A\u57F7\u884C\uFF1B\u5DF2\u6263\u9664\u6D41\u5718")), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3"
  }, [{
    label: '活動團數',
    icon: 'calendar-days',
    iconClass: 'text-blue-600',
    stat: stats.monthSummary.sessions
  }, {
    label: '活動人數',
    icon: 'users',
    iconClass: 'text-emerald-600',
    stat: stats.monthSummary.pax
  }, {
    label: '主講師出團',
    icon: 'briefcase',
    iconClass: 'text-indigo-600',
    stat: stats.monthSummary.leadTrips
  }, {
    label: '跟團講師出團',
    icon: 'user-plus',
    iconClass: 'text-amber-600',
    stat: stats.monthSummary.supportTrips
  }].map(card => React.createElement("div", {
    key: card.label,
    className: "bg-white border border-slate-200 rounded-xl p-4 shadow-sm"
  }, React.createElement("div", {
    className: "text-xs font-bold text-slate-500 uppercase flex items-center gap-2 mb-3"
  }, React.createElement(Icon, {
    name: card.icon,
    size: 14,
    className: card.iconClass
  }), card.label), React.createElement("div", {
    className: "grid grid-cols-3 gap-3"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-[10px] text-slate-400 font-bold mb-1"
  }, "\u7E3D\u6578"), React.createElement("div", {
    className: "text-lg font-bold text-slate-800"
  }, card.stat.total)), React.createElement("div", null, React.createElement("div", {
    className: "text-[10px] text-slate-400 font-bold mb-1"
  }, "\u5DF2\u51FA"), React.createElement("div", {
    className: "text-lg font-bold text-emerald-600"
  }, card.stat.completed)), React.createElement("div", null, React.createElement("div", {
    className: "text-[10px] text-slate-400 font-bold mb-1"
  }, "\u672A\u51FA"), React.createElement("div", {
    className: "text-lg font-bold text-amber-600"
  }, card.stat.upcoming))))))), React.createElement("div", null, React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, React.createElement("h5", {
    className: "text-xs font-bold text-slate-500 uppercase flex items-center"
  }, React.createElement(Icon, {
    name: "activity",
    size: 14,
    className: "mr-1"
  }), " \u6D3B\u52D5\u5718\u6578 / \u4EBA\u6578"), React.createElement("span", {
    className: "text-[11px] text-slate-400"
  }, "\u6BCF\u500B\u6D3B\u52D5\u90FD\u62C6\u6210\u7E3D\u6578\u3001\u5DF2\u51FA\u3001\u672A\u51FA")), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-xl overflow-x-auto"
  }, React.createElement("table", {
    className: "w-full min-w-[860px] text-left text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-4 py-2"
  }, "\u6D3B\u52D5\u540D\u7A31"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u7E3D\u5718\u6578"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u5DF2\u51FA"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u672A\u51FA"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u7E3D\u4EBA\u6578"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u5DF2\u51FA"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u672A\u51FA"), React.createElement("th", {
    className: "px-4 py-2 text-right"
  }, "\u7E3D\u71DF\u6536"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, stats.monthlyActivityRows.map(([name, row]) => React.createElement("tr", {
    key: name,
    className: "hover:bg-slate-50"
  }, React.createElement("td", {
    className: "px-4 py-2 font-medium text-slate-700"
  }, name), React.createElement("td", {
    className: "px-4 py-2 text-center font-bold text-slate-700"
  }, row.sessions.total), React.createElement("td", {
    className: "px-4 py-2 text-center text-emerald-600 font-bold"
  }, row.sessions.completed), React.createElement("td", {
    className: "px-4 py-2 text-center text-amber-600 font-bold"
  }, row.sessions.upcoming), React.createElement("td", {
    className: "px-4 py-2 text-center font-bold text-slate-700"
  }, row.pax.total), React.createElement("td", {
    className: "px-4 py-2 text-center text-emerald-600 font-bold"
  }, row.pax.completed), React.createElement("td", {
    className: "px-4 py-2 text-center text-amber-600 font-bold"
  }, row.pax.upcoming), React.createElement("td", {
    className: "px-4 py-2 text-right font-mono text-slate-600"
  }, "$", row.revenue.total.toLocaleString()))), stats.monthlyActivityRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "8",
    className: "p-6 text-center text-slate-400"
  }, "\u6B64\u6708\u4EFD\u7121\u6709\u6548\u6D3B\u52D5")))))), React.createElement("div", {
    className: "grid grid-cols-1 xl:grid-cols-2 gap-4"
  }, React.createElement("div", null, React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, React.createElement("h5", {
    className: "text-xs font-bold text-slate-500 uppercase flex items-center"
  }, React.createElement(Icon, {
    name: "briefcase",
    size: 14,
    className: "mr-1"
  }), " \u4E3B\u8B1B\u5E2B\u51FA\u5718\u6578"), React.createElement("span", {
    className: "text-[11px] text-slate-400"
  }, "\u53EA\u8A08\u7B97\u4E3B\u8B1B\u5E2B")), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-xl overflow-hidden"
  }, React.createElement("table", {
    className: "w-full text-left text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-4 py-2"
  }, "\u8B1B\u5E2B"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u7E3D\u6578"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u5DF2\u51FA"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u672A\u51FA"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, stats.leadInstructorRows.map(([name, row]) => React.createElement("tr", {
    key: name,
    className: "hover:bg-slate-50"
  }, React.createElement("td", {
    className: "px-4 py-2 font-medium text-slate-700"
  }, name), React.createElement("td", {
    className: "px-4 py-2 text-center font-bold text-slate-700"
  }, row.total), React.createElement("td", {
    className: "px-4 py-2 text-center text-emerald-600 font-bold"
  }, row.completed), React.createElement("td", {
    className: "px-4 py-2 text-center text-amber-600 font-bold"
  }, row.upcoming))), stats.leadInstructorRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "4",
    className: "p-6 text-center text-slate-400"
  }, "\u6B64\u6708\u4EFD\u7121\u4E3B\u8B1B\u5E2B\u8CC7\u6599")))))), React.createElement("div", null, React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, React.createElement("h5", {
    className: "text-xs font-bold text-slate-500 uppercase flex items-center"
  }, React.createElement(Icon, {
    name: "user-plus",
    size: 14,
    className: "mr-1"
  }), " \u8DDF\u5718\u8B1B\u5E2B\u51FA\u5718\u6578"), React.createElement("span", {
    className: "text-[11px] text-slate-400"
  }, "\u53EA\u8A08\u7B97\u8DDF\u5718\u8B1B\u5E2B")), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-xl overflow-hidden"
  }, React.createElement("table", {
    className: "w-full text-left text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-4 py-2"
  }, "\u8B1B\u5E2B"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u7E3D\u6578"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u5DF2\u51FA"), React.createElement("th", {
    className: "px-4 py-2 text-center"
  }, "\u672A\u51FA"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, stats.supportInstructorRows.map(([name, row]) => React.createElement("tr", {
    key: name,
    className: "hover:bg-slate-50"
  }, React.createElement("td", {
    className: "px-4 py-2 font-medium text-slate-700"
  }, name), React.createElement("td", {
    className: "px-4 py-2 text-center font-bold text-slate-700"
  }, row.total), React.createElement("td", {
    className: "px-4 py-2 text-center text-emerald-600 font-bold"
  }, row.completed), React.createElement("td", {
    className: "px-4 py-2 text-center text-amber-600 font-bold"
  }, row.upcoming))), stats.supportInstructorRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "4",
    className: "p-6 text-center text-slate-400"
  }, "\u6B64\u6708\u4EFD\u7121\u8DDF\u5718\u8B1B\u5E2B\u8CC7\u6599"))))))), React.createElement("div", null, React.createElement("h5", {
    className: "text-xs font-bold text-slate-500 mb-2 uppercase flex items-center"
  }, React.createElement(Icon, {
    name: "share-2",
    size: 14,
    className: "mr-1"
  }), " \u5831\u540D\u7BA1\u9053\u5206\u6790"), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, Object.entries(stats.sources).map(([src, count]) => React.createElement("div", {
    key: src,
    className: "text-xs px-3 py-1.5 bg-white border rounded-lg shadow-sm flex gap-2"
  }, React.createElement("span", {
    className: "text-slate-600"
  }, src), React.createElement("span", {
    className: "font-bold text-blue-600"
  }, count), React.createElement("span", {
    className: "text-slate-400"
  }, "(", stats.pax > 0 ? Math.round(count / stats.pax * 100) : 0, "%)"))))), React.createElement("div", {
    className: "flex justify-end pt-2"
  }, React.createElement("button", {
    onClick: handleDownloadReport,
    className: "text-xs text-blue-600 hover:underline flex items-center bg-blue-50 px-3 py-1.5 rounded border border-blue-100"
  }, React.createElement(Icon, {
    name: "download",
    size: 12,
    className: "mr-1"
  }), " \u4E0B\u8F09\u6B64\u6708\u8A73\u7D30\u5831\u8868"))));
};
const PlanningBoard = ({
  monthLabel,
  planning,
  availableEventNames,
  saveStatus,
  versionHistory,
  operatorName,
  onOperatorNameChange,
  onRestoreVersion,
  onSave,
  onPrevMonth,
  onNextMonth,
  onAddActivity,
  onChangeActivityMetric,
  onBulkApplyActivityMetric,
  onChangeProfitSplit,
  onAssignPlacement,
  onRemovePlacement,
  onClearPlacements
}) => {
  const [selectedActivity, setSelectedActivity] = useState('');
  const [selectedActivityTemplate, setSelectedActivityTemplate] = useState('theme');
  const [draggingEventName, setDraggingEventName] = useState('');
  const [dragTargetKey, setDragTargetKey] = useState('');
  const [bulkMetricDraft, setBulkMetricDraft] = useState({
    avgPax: '',
    revenuePerPax: '',
    costPerPax: ''
  });
  const [versionExpanded, setVersionExpanded] = useState(false);
  const boardRef = useRef(null);
  const calendarScrollRef = useRef(null);
  const matrixScrollRef = useRef(null);
  const pendingScrollSnapshotRef = useRef(null);
  const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const weekdayLabelsFull = weekdayLabels.map(label => `週${label}`);
  const dayColumnWidth = 100;
  const instructorColumnWidth = 100;
  const buildCellKey = (dateKey, instructorName) => `${String(dateKey || '').trim()}__${String(instructorName || '').trim()}`;
  const formatNumber = (value, digits = 0) => Number(value || 0).toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  const formatCurrency = value => `$${Math.round(Number(value || 0)).toLocaleString()}`;
  const formatVersionTime = value => {
    if (!value) return '時間未記錄';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };
  const captureScrollSnapshot = () => {
    const mainScrollEl = boardRef.current?.closest('main');
    pendingScrollSnapshotRef.current = {
      mainTop: mainScrollEl?.scrollTop ?? null,
      mainLeft: mainScrollEl?.scrollLeft ?? null,
      calendarLeft: calendarScrollRef.current?.scrollLeft ?? null,
      matrixLeft: matrixScrollRef.current?.scrollLeft ?? null
    };
  };
  const getHeader = dateKey => {
    const [year, month, day] = String(dateKey || '').split('-').map(Number);
    const dt = new Date(year, (month || 1) - 1, day || 1);
    if (Number.isNaN(dt.getTime())) return {
      day: String(dateKey).slice(-2),
      weekday: ''
    };
    return {
      day,
      weekday: weekdayLabels[dt.getDay()]
    };
  };
  const getCellTone = cell => {
    if (cell?.simulatedPlacement) return `bg-violet-50 text-violet-700 border-violet-200${cell?.isPast ? ' opacity-80' : ''}`;
    const baseTone = {
      available: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      busy: 'bg-sky-50 text-sky-700 border-sky-200',
      rest: 'bg-slate-200 text-slate-500 border-slate-300',
      companyRest: 'bg-slate-300 text-slate-600 border-slate-400'
    }[cell?.state] || 'bg-white text-slate-400 border-slate-200';
    if (cell?.isPast && cell?.state === 'available') return 'bg-slate-50 text-slate-300 border-slate-100';
    return `${baseTone}${cell?.isPast ? ' opacity-70' : ''}`;
  };
  const getCalendarCellTone = cell => {
    if (cell?.simulatedPlacement) return `bg-violet-50/70${cell?.isPast ? ' opacity-80' : ''}`;
    return ({
      available: 'bg-emerald-50/90 ring-1 ring-inset ring-emerald-200',
      busy: 'bg-slate-50',
      rest: 'bg-slate-200/90',
      companyRest: 'bg-slate-300/80'
    }[cell?.state] || 'bg-white') + (cell?.isPast ? ' opacity-80' : '');
  };
  const getCalendarEmptyLabelTone = cell => {
    if (cell?.state === 'companyRest') return 'text-slate-600 font-semibold';
    if (cell?.state === 'rest') return 'text-slate-500 font-medium';
    if (cell?.isPast && cell?.state === 'available') return 'text-slate-300';
    if (draggingEventName && cell?.canDrop) return 'text-emerald-700 font-bold';
    if (cell?.state === 'busy') return 'text-slate-500';
    return 'text-emerald-600 font-bold';
  };
  const getEntryTone = type => ({
    main: 'bg-sky-50 border-sky-100 text-sky-800',
    prep: 'bg-amber-50 border-amber-100 text-amber-800',
    cont: 'bg-violet-50 border-violet-100 text-violet-800',
    outing: 'bg-rose-50 border-rose-100 text-rose-800',
    simulated: 'bg-violet-50 border-violet-200 text-violet-800'
  })[type] || 'bg-slate-50 border-slate-200 text-slate-700';
  const getCompactCellLabel = cell => {
    if (cell?.simulatedPlacement) return '模';
    if (cell?.isPast && cell?.state === 'available') return '過';
    return {
      available: '可',
      busy: '團',
      rest: '休',
      companyRest: '公'
    }[cell?.state] || '';
  };
  const getCalendarEmptyLabel = cell => {
    if (cell?.state === 'companyRest') return '公休';
    if (cell?.state === 'rest') return '排休';
    if (cell?.isPast && cell?.state === 'available') return '已過';
    if (draggingEventName && cell?.canDrop) return '拖到這裡';
    if (cell?.state === 'busy') return '正式已排';
    return '可排';
  };
  const calendarRows = useMemo(() => planning.matrixRows.map(row => ({
    ...row,
    cellMap: Object.fromEntries((row.cells || []).map(cell => [cell.dateKey, cell]))
  })), [planning.matrixRows]);
  const calendarWeeks = useMemo(() => {
    const dates = Array.isArray(planning.matrixDates) ? planning.matrixDates : [];
    if (dates.length === 0) return [];
    const [year, month, day] = String(dates[0] || '').split('-').map(Number);
    const firstWeekday = new Date(year, (month || 1) - 1, day || 1).getDay();
    const padded = Array(firstWeekday).fill(null).concat(dates);
    while (padded.length % 7 !== 0) padded.push(null);
    const weeks = [];
    for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
    return weeks;
  }, [planning.matrixDates]);
  const legendItems = [{
    label: '可排',
    tone: 'bg-emerald-100 text-emerald-800 border-emerald-300'
  }, {
    label: '正式已排',
    tone: 'bg-sky-50 text-sky-700 border-sky-200'
  }, {
    label: '模擬安排',
    tone: 'bg-violet-50 text-violet-700 border-violet-200'
  }, {
    label: '排休',
    tone: 'bg-slate-200 text-slate-500 border-slate-300'
  }, {
    label: '公休',
    tone: 'bg-slate-300 text-slate-600 border-slate-400'
  }];
  const activeActivityTemplate = PLAN_ACTIVITY_TEMPLATES[selectedActivityTemplate] || PLAN_ACTIVITY_TEMPLATES.theme;
  const visibleActivityRows = useMemo(() => planning.activityRows.filter(row => {
    const rowTemplateType = normalizePlanActivityTemplateType(row.templateType || inferPlanActivityTemplateType(row.name));
    return rowTemplateType === activeActivityTemplate.id;
  }), [activeActivityTemplate.id, planning.activityRows]);
  const remainingEventOptions = useMemo(() => (availableEventNames || []).filter(name => {
    const cleanName = String(name || '').trim();
    if (!cleanName) return false;
    if (planning.activityRows.some(row => row.name === cleanName)) return false;
    return inferPlanActivityTemplateType(cleanName) === activeActivityTemplate.id;
  }), [activeActivityTemplate.id, availableEventNames, planning.activityRows]);
  const activityRowNames = useMemo(() => planning.activityRows.map(row => row.name), [planning.activityRows]);
  const actualSessionTotal = planning.activityRows.reduce((sum, row) => sum + (Number(row.actualSessions) || 0), 0);
  const weeklyMissingActivities = useMemo(() => {
    const trackedNames = visibleActivityRows.map(row => row.name);
    return calendarWeeks.map(week => {
      const weekDates = week.filter(Boolean);
      const scheduledNames = new Set();
      weekDates.forEach(dateKey => {
        calendarRows.forEach(row => {
          const simulatedPlacements = Array.isArray(row.cellMap[dateKey]?.simulatedPlacements) ? row.cellMap[dateKey].simulatedPlacements : row.cellMap[dateKey]?.simulatedPlacement ? [row.cellMap[dateKey].simulatedPlacement] : [];
          simulatedPlacements.forEach(placement => {
            const scheduledEventName = String(placement?.eventName || '').trim();
            if (scheduledEventName) scheduledNames.add(scheduledEventName);
          });
          (row.cellMap[dateKey]?.entries || []).forEach(entry => {
            const entryTitle = String(entry?.title || '').trim();
            if (!entryTitle || entry?.type === 'outing') return;
            scheduledNames.add(entryTitle);
          });
        });
      });
      return trackedNames.filter(name => !scheduledNames.has(name));
    });
  }, [calendarRows, calendarWeeks, visibleActivityRows]);
  const summaryCards = [{
    label: '可排講師人日',
    value: `${formatNumber(planning.summary.openInstructorDays)} 人日`,
    note: `所有可排 ${formatNumber(planning.summary.totalSchedulableInstructorDays)} - 已確定 ${formatNumber(planning.summary.actualBusyInstructorDays)} - 模擬排 ${formatNumber(planning.summary.simulatedInstructorDays)}`,
    tone: 'border-emerald-100 bg-emerald-50',
    icon: 'calendar-days'
  }, {
    label: '正式已排占用',
    value: `${formatNumber(planning.summary.actualBusyInstructorDays)} 人日`,
    note: `來自正式活動、前置、跨日、場勘`,
    tone: 'border-sky-100 bg-sky-50',
    icon: 'briefcase'
  }, {
    label: '模擬總團數',
    value: `${formatNumber(planning.summary.simulatedSessions)} 團`,
    note: `全部來自拖曳模擬 ${formatNumber(planning.summary.droppedSessions)} 團`,
    tone: 'border-violet-100 bg-violet-50',
    icon: 'layout-grid'
  }, {
    label: '預估總毛利',
    value: formatCurrency(planning.summary.plannedGrossProfit),
    note: `公司 ${planning.profitSplit.companyPct}% / 獎金 ${planning.profitSplit.bonusPct}%`,
    tone: 'border-amber-100 bg-amber-50',
    icon: 'trending-up'
  }];
  const planningExcelSheets = useMemo(() => {
    const placementMap = new Map();
    calendarRows.forEach(row => {
      (planning.matrixDates || []).forEach(dateKey => {
        const cell = row.cellMap[dateKey];
        const simulatedPlacements = Array.isArray(cell?.simulatedPlacements) ? cell.simulatedPlacements : cell?.simulatedPlacement ? [cell.simulatedPlacement] : [];
        simulatedPlacements.forEach(placement => {
          if (!placement?.eventName) return;
          const cleanDate = String(dateKey || '').trim();
          const cleanEventName = String(placement.eventName || '').trim();
          const cleanInstructorName = String(placement.instructorName || row.name || '').trim();
          if (!cleanDate || !cleanEventName || !cleanInstructorName) return;
          const key = `${cleanDate}__${cleanEventName}`;
          if (!placementMap.has(key)) {
            placementMap.set(key, {
              dateKey: cleanDate,
              eventName: cleanEventName,
              instructors: new Set()
            });
          }
          placementMap.get(key).instructors.add(cleanInstructorName);
        });
      });
    });
    const placementRows = [['講師', '活動日期', '', '', '', '活動名稱'], ...Array.from(placementMap.values()).sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.eventName.localeCompare(b.eventName, 'zh-Hant')).map(item => {
      const instructorNames = Array.from(item.instructors).sort((a, b) => a.localeCompare(b, 'zh-Hant')).join(' & ');
      return [instructorNames, item.dateKey.replace(/-/g, '/'), '', '', '', item.eventName];
    })];
    return [{
      name: `${monthLabel}排班清單`,
      rows: placementRows
    }];
  }, [monthLabel, planning, calendarRows]);
  const handleExportPlanningExcel = () => {
    downloadExcelWorkbook(planningExcelSheets, `${sanitizeFilename(monthLabel, '活動模擬')}_活動模擬.xls`);
  };
  const handleClearPlanningPlacements = () => {
    if ((planning?.placementCount || 0) <= 0) return alert("本月目前沒有模擬排班可清除。");
    if (!confirm(`確定要清除 ${monthLabel} 目前 ${planning.placementCount} 筆模擬排班嗎？\n這只會清除本月月曆上的模擬安排，活動假設與毛利設定會保留。`)) return;
    captureScrollSnapshot();
    onClearPlacements();
  };
  const bulkMetricConfigs = [{
    field: 'avgPax',
    label: '平均人數整欄套用',
    hint: '一次覆蓋本表全部活動的平均人數',
    step: '0.1',
    inputClass: 'w-28 text-center',
    placeholder: '例如 18.5'
  }, {
    field: 'revenuePerPax',
    label: '每人營收整欄套用',
    hint: '一次覆蓋本表全部活動的每人營收',
    step: '1',
    inputClass: 'w-32 text-right',
    placeholder: '例如 1800'
  }, {
    field: 'costPerPax',
    label: '每人成本整欄套用',
    hint: '一次覆蓋本表全部活動的每人成本',
    step: '1',
    inputClass: 'w-32 text-right',
    placeholder: '例如 450'
  }];
  const updateBulkMetricDraft = (field, value) => {
    setBulkMetricDraft(prev => ({
      ...prev,
      [field]: value
    }));
  };
  const applyBulkMetric = field => {
    if (activityRowNames.length === 0) return;
    onBulkApplyActivityMetric(field, bulkMetricDraft[field], activityRowNames);
  };
  const clearBulkMetric = field => {
    if (activityRowNames.length === 0) return;
    onBulkApplyActivityMetric(field, '', activityRowNames);
    setBulkMetricDraft(prev => ({
      ...prev,
      [field]: ''
    }));
  };
  const addSelectedActivity = () => {
    const draft = buildPlanningActivityDraft(selectedActivity, selectedActivityTemplate);
    if (!draft.name) return;
    onAddActivity(draft);
    setSelectedActivity('');
  };
  const parseDragPayload = event => {
    const raw = event?.dataTransfer?.getData('application/x-crm-planning') || event?.dataTransfer?.getData('text/plain') || '';
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return {
        eventName: raw
      };
    }
  };
  const handleDragStart = payload => event => {
    event.dataTransfer.setData('application/x-crm-planning', JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', payload.eventName || '');
    event.dataTransfer.effectAllowed = 'move';
    setDraggingEventName(payload.eventName || '');
  };
  const handleDragEnd = () => {
    setDraggingEventName('');
    setDragTargetKey('');
  };
  const handleCellDragOver = (rowName, cell) => event => {
    if (!cell?.canDrop) return;
    if (!draggingEventName) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragTargetKey(buildCellKey(cell.dateKey, rowName));
  };
  const handleCellDrop = (rowName, cell) => event => {
    if (!cell?.canDrop) return;
    const payload = parseDragPayload(event);
    if (!payload?.eventName) return;
    event.preventDefault();
    captureScrollSnapshot();
    setDragTargetKey('');
    onAssignPlacement({
      eventName: payload.eventName,
      instructorName: rowName,
      dateKey: cell.dateKey,
      sourceDateKey: payload.sourceDateKey,
      sourceInstructorName: payload.sourceInstructorName,
      sourcePlacementId: payload.sourcePlacementId
    });
  };
  useEffect(() => {
    setSelectedActivity('');
    setSelectedActivityTemplate('theme');
    setDraggingEventName('');
    setDragTargetKey('');
    setBulkMetricDraft({
      avgPax: '',
      revenuePerPax: '',
      costPerPax: ''
    });
  }, [monthLabel]);
  useLayoutEffect(() => {
    const snapshot = pendingScrollSnapshotRef.current;
    if (!snapshot) return undefined;
    const restoreFrame = requestAnimationFrame(() => {
      const mainScrollEl = boardRef.current?.closest('main');
      if (mainScrollEl && snapshot.mainTop !== null) {
        mainScrollEl.scrollTop = snapshot.mainTop;
        if (snapshot.mainLeft !== null) mainScrollEl.scrollLeft = snapshot.mainLeft;
      }
      if (calendarScrollRef.current && snapshot.calendarLeft !== null) {
        calendarScrollRef.current.scrollLeft = snapshot.calendarLeft;
      }
      if (matrixScrollRef.current && snapshot.matrixLeft !== null) {
        matrixScrollRef.current.scrollLeft = snapshot.matrixLeft;
      }
      pendingScrollSnapshotRef.current = null;
    });
    return () => cancelAnimationFrame(restoreFrame);
  }, [planning]);
  return React.createElement("div", {
    ref: boardRef,
    className: "fade-in max-w-7xl mx-auto pb-20 space-y-6"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden xl:overflow-visible"
  }, React.createElement("div", {
    className: "p-5 border-b border-slate-100 bg-slate-50/80"
  }, React.createElement("div", {
    className: "flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold uppercase tracking-wider text-slate-400 mb-1"
  }, "\u6D3B\u52D5\u6A21\u64EC"), React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("button", {
    onClick: onPrevMonth,
    className: "p-2 rounded-full hover:bg-white border border-slate-200 text-slate-500"
  }, React.createElement(Icon, {
    name: "chevron-left",
    size: 16
  })), React.createElement("div", {
    className: "text-lg font-bold text-slate-800 min-w-[120px] text-center"
  }, monthLabel), React.createElement("button", {
    onClick: onNextMonth,
    className: "p-2 rounded-full hover:bg-white border border-slate-200 text-slate-500"
  }, React.createElement(Icon, {
    name: "chevron-right",
    size: 16
  }))), React.createElement("div", {
    className: "text-[11px] text-slate-400 mt-2"
  }, "\u9019\u4E00\u9801\u53EA\u505A\u6708\u5EA6\u6D3B\u52D5\u6A21\u64EC\u8207\u640D\u76CA\u4F30\u7B97\uFF0C\u4E0D\u6703\u771F\u7684\u5EFA\u7ACB\u6D3B\u52D5\u5834\u6B21\u3002")), React.createElement("div", {
    className: "flex flex-wrap items-center justify-end gap-3"
  }, React.createElement("div", {
    className: "flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
  }, React.createElement("span", {
    className: "text-[11px] font-bold text-slate-500 whitespace-nowrap"
  }, "\u64CD\u4F5C\u4EBA"), React.createElement("input", {
    type: "text",
    value: operatorName,
    onChange: e => onOperatorNameChange(e.target.value),
    placeholder: "\u4F8B\u5982 \u90ED\u739F\u5E0C",
    className: "w-28 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-300"
  })), React.createElement("div", {
    className: "text-xs text-slate-400"
  }, saveStatus === 'saving' && '模擬資料儲存中...', saveStatus === 'success' && '模擬資料已儲存', saveStatus === 'error' && '模擬資料儲存失敗', saveStatus === 'idle' && '可按月份分別設定'), React.createElement("button", {
    onClick: handleExportPlanningExcel,
    className: "bg-white hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 border border-slate-200 shadow-sm"
  }, React.createElement(Icon, {
    name: "download",
    size: 16
  }), " \u532F\u51FA Excel"), React.createElement("button", {
    onClick: handleClearPlanningPlacements,
    disabled: (planning?.placementCount || 0) <= 0,
    className: `px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 border shadow-sm transition ${planning?.placementCount > 0 ? 'bg-white hover:bg-rose-50 text-rose-600 border-rose-200' : 'bg-slate-100 text-slate-300 border-slate-200 cursor-not-allowed'}`
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 16
  }), " \u6E05\u9664\u672C\u6708\u6A21\u64EC"), React.createElement("button", {
    onClick: onSave,
    className: "bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 shadow-sm"
  }, React.createElement(Icon, {
    name: "save",
    size: 16
  }), " \u5132\u5B58\u672C\u6708\u6A21\u64EC")))), React.createElement("div", {
    className: "p-5 space-y-6"
  }, React.createElement("div", {
    className: "rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold uppercase tracking-wide text-slate-500"
  }, "\u6700\u8FD1\u7248\u672C"), React.createElement("div", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u6BCF\u6B21\u5132\u5B58\u672C\u6708\u6A21\u64EC\u90FD\u6703\u7559\u4E00\u4EFD\u5FEB\u7167\u3002\u73FE\u5728\u5148\u7528\u300C\u64CD\u4F5C\u4EBA\u300D\u6B04\u4F4D\u7F72\u540D\uFF0C\u4E4B\u5F8C\u518D\u63A5\u500B\u4EBA\u5E33\u865F\u3002")), React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("div", {
    className: "text-[11px] text-slate-400"
  }, "\u53EA\u5F71\u97FF ", monthLabel, "\uFF0C\u4E0D\u6703\u78B0\u5176\u4ED6\u6708\u4EFD"), React.createElement("button", {
    type: "button",
    onClick: () => setVersionExpanded(prev => !prev),
    className: "inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
  }, React.createElement(Icon, {
    name: versionExpanded ? 'chevron-up' : 'chevron-down',
    size: 14
  }), versionExpanded ? '收起版本' : '展開版本'))), !versionExpanded ? React.createElement("div", {
    className: "mt-4 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-4 text-sm text-slate-400"
  }, "\u7248\u672C\u5217\u8868\u5DF2\u6536\u8D77\u3002\u5C55\u958B\u5F8C\u53EF\u67E5\u770B ", monthLabel, " \u6700\u8FD1\u7684\u5132\u5B58\u8207\u9084\u539F\u7D00\u9304\u3002") : Array.isArray(versionHistory) && versionHistory.length > 0 ? React.createElement("div", {
    className: "mt-4 space-y-2"
  }, versionHistory.map(version => React.createElement("div", {
    key: `planning_version_${version.id}`,
    className: "rounded-xl border border-slate-200 bg-white px-3 py-3"
  }, React.createElement("div", {
    className: "flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", {
    className: "flex flex-wrap items-center gap-2 text-xs"
  }, React.createElement("span", {
    className: `rounded-full px-2 py-1 font-bold ${version.action === 'restore' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`
  }, version.action === 'restore' ? '還原' : '儲存'), React.createElement("span", {
    className: "font-bold text-slate-600"
  }, formatVersionTime(version.savedAt)), React.createElement("span", {
    className: "text-slate-400"
  }, version.savedByName || '未署名')), React.createElement("button", {
    type: "button",
    onClick: () => onRestoreVersion(version),
    className: "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
  }, React.createElement(Icon, {
    name: "history",
    size: 14
  }), " \u9084\u539F\u9019\u7248")), React.createElement("div", {
    className: "mt-2 text-xs text-slate-500"
  }, version.summary || '這個版本沒有附帶摘要。'), Array.isArray(version.details) && version.details.length > 0 && React.createElement("div", {
    className: "mt-2 space-y-1 rounded-lg bg-slate-50 px-3 py-2"
  }, version.details.slice(0, 4).map((detail, idx) => React.createElement("div", {
    key: `planning_version_detail_${version.id}_${idx}`,
    className: "text-[11px] text-slate-500"
  }, "\u2022 ", detail)), version.details.length > 4 && React.createElement("div", {
    className: "text-[11px] text-slate-400"
  }, "\u9084\u6709 ", version.details.length - 4, " \u9805\u7D30\u7BC0"))))) : React.createElement("div", {
    className: "mt-4 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-5 text-sm text-slate-400"
  }, "\u9019\u500B\u6708\u4EFD\u9084\u6C92\u6709\u6B77\u53F2\u7248\u672C\u3002\u7B2C\u4E00\u6B21\u5132\u5B58\u5F8C\u5C31\u6703\u958B\u59CB\u7D2F\u7A4D\u3002")), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
  }, summaryCards.map(card => React.createElement("div", {
    key: card.label,
    className: `rounded-2xl border p-4 ${card.tone}`
  }, React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, React.createElement("div", {
    className: "text-xs font-bold uppercase tracking-wide text-slate-500"
  }, card.label), React.createElement(Icon, {
    name: card.icon,
    size: 16,
    className: "text-slate-500"
  })), React.createElement("div", {
    className: "text-3xl font-bold text-slate-800"
  }, card.value), React.createElement("div", {
    className: "mt-2 text-xs text-slate-500"
  }, card.note)))), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, [{
    label: '公司公休',
    value: `${planning.summary.companyRestDays} 天`,
    tone: 'text-slate-600 bg-slate-50 border-slate-200'
  }, {
    label: '講師排休',
    value: `${planning.summary.restInstructorDays} 人日`,
    tone: 'text-amber-700 bg-amber-50 border-amber-100'
  }, {
    label: '正式已排團數',
    value: `${actualSessionTotal} 團`,
    tone: 'text-sky-700 bg-sky-50 border-sky-100'
  }, {
    label: '拖曳模擬',
    value: `${planning.summary.droppedSessions} 團`,
    tone: 'text-violet-700 bg-violet-50 border-violet-100'
  }, {
    label: '活動種類',
    value: `${planning.activityRows.length} 種`,
    tone: 'text-blue-700 bg-blue-50 border-blue-100'
  }].map(item => React.createElement("div", {
    key: item.label,
    className: `px-3 py-2 rounded-xl border text-xs font-bold ${item.tone}`
  }, React.createElement("span", {
    className: "mr-2 opacity-80"
  }, item.label), React.createElement("span", null, item.value)))), React.createElement("div", {
    className: "grid grid-cols-1 lg:grid-cols-4 gap-4"
  }, React.createElement("div", {
    className: "planning-palette-panel bg-slate-50 border border-slate-200 rounded-2xl p-4"
  }, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 mb-2"
  }, "\u6D3B\u52D5\u6B04\u4F4D"), React.createElement("p", {
    className: "text-xs text-slate-400 mb-4"
  }, "\u5148\u628A\u6D3B\u52D5\u52A0\u5165\u6B04\u4F4D\uFF0C\u518D\u76F4\u63A5\u62D6\u5230\u53F3\u908A\u6708\u66C6\u7684\u7A7A\u767D\u683C\u3002\u62D6\u5230\u5DF2\u6709\u6A21\u64EC\u6D3B\u52D5\u7684\u683C\u5B50\u6703\u76F4\u63A5\u53D6\u4EE3\u3002"), React.createElement("div", {
    className: "grid grid-cols-1 gap-1.5 mb-3"
  }, PLAN_ACTIVITY_TEMPLATE_LIST.map(template => {
    const isActive = selectedActivityTemplate === template.id;
    const priceLabel = template.defaultRevenuePerPax === '' ? '價格自訂' : `$${template.defaultRevenuePerPax}`;
    return React.createElement("button", {
      key: `plan_template_${template.id}`,
      type: "button",
      onClick: () => setSelectedActivityTemplate(template.id),
      className: `rounded-lg border px-2.5 py-1.5 text-left transition ${isActive ? 'border-blue-300 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`
    }, React.createElement("div", {
      className: "flex items-center justify-between gap-2"
    }, React.createElement("span", {
      className: `text-[11px] font-bold ${isActive ? 'text-blue-700' : 'text-slate-700'}`
    }, template.label), React.createElement("span", {
      className: `text-[9px] font-bold px-1.5 py-0.5 rounded-full ${isActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`
    }, priceLabel)), React.createElement("div", {
      className: "mt-0.5 text-[9px] text-slate-400"
    }, template.helper));
  })), React.createElement("div", {
    className: "flex gap-2 mb-4"
  }, React.createElement("input", {
    list: "planning-activity-options",
    className: "flex-1 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm",
    value: selectedActivity,
    onChange: e => setSelectedActivity(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSelectedActivity();
      }
    },
    placeholder: `輸入${activeActivityTemplate.label}名稱...`
  }), React.createElement("datalist", {
    id: "planning-activity-options"
  }, remainingEventOptions.map(name => React.createElement("option", {
    key: `plan_add_${name}`,
    value: name
  }, name))), React.createElement("button", {
    onClick: addSelectedActivity,
    className: "px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700"
  }, React.createElement(Icon, {
    name: "plus",
    size: 14
  }))), React.createElement("div", {
    className: "space-y-1.5 max-h-[200px] overflow-y-scroll overscroll-contain pr-2",
    style: {
      scrollbarGutter: 'stable'
    }
  }, visibleActivityRows.map(row => React.createElement("div", {
    key: `planning_palette_${row.name}`,
    draggable: true,
    onDragStart: handleDragStart({
      type: 'palette',
      eventName: row.name
    }),
    onDragEnd: handleDragEnd,
    className: `rounded-lg border bg-white px-2.5 py-2 shadow-sm cursor-grab active:cursor-grabbing transition ${draggingEventName === row.name ? 'opacity-60 border-violet-200' : 'border-slate-200 hover:border-slate-300'}`
  }, React.createElement("div", {
    className: "text-[11px] font-semibold leading-tight tracking-tight text-slate-700",
    style: {
      wordBreak: 'keep-all',
      overflowWrap: 'anywhere',
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden'
    }
  }, row.name), React.createElement("div", {
    className: "mt-1 text-[10px] text-slate-400"
  }, "\u672C\u6708\u5DF2\u6392 ", formatNumber(row.activityCount), " \u5834"))), visibleActivityRows.length === 0 && React.createElement("div", {
    className: "rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400"
  }, "\u9019\u500B\u5206\u985E\u76EE\u524D\u9084\u6C92\u6709\u6D3B\u52D5\uFF0C\u5148\u65B0\u589E\u4E00\u500B\u518D\u62D6\u66F3\u5B89\u6392\u3002"))), React.createElement("div", {
    className: "planning-calendar-panel bg-white border border-slate-200 rounded-2xl p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "calendar-days",
    size: 16
  }), " \u8B1B\u5E2B\u6708\u66C6\u6A21\u5F0F"), React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u6BCF\u4E00\u9031\u5206\u584A\u5448\u73FE\uFF0C\u6240\u6709\u65E5\u671F\u6B04\u56FA\u5B9A\u7B49\u5BEC\u3002\u628A\u5DE6\u908A\u6D3B\u52D5\u62D6\u5230\u53EF\u6392\u7A7A\u683C\uFF0C\u5C31\u80FD\u5FEB\u901F\u6392\u51FA\u672C\u6708\u6A21\u64EC\u7248\u3002")), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, legendItems.map(item => React.createElement("div", {
    key: `calendar_${item.label}`,
    className: `px-2.5 py-1 rounded-full border text-[11px] font-bold ${item.tone}`
  }, item.label)))), React.createElement("div", {
    ref: calendarScrollRef,
    className: "overflow-x-auto"
  }, React.createElement("table", {
    className: "border-separate border-spacing-0 text-xs",
    style: {
      minWidth: `${instructorColumnWidth + dayColumnWidth * 7}px`
    }
  }, React.createElement("colgroup", null, React.createElement("col", {
    style: {
      width: `${instructorColumnWidth}px`
    }
  }), weekdayLabelsFull.map(label => React.createElement("col", {
    key: `planning_col_${label}`,
    style: {
      width: `${dayColumnWidth}px`
    }
  }))), React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", {
    className: "sticky left-0 z-20 bg-white border border-slate-200 px-3 py-2 text-left"
  }, React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500 uppercase tracking-wide"
  }, "\u8B1B\u5E2B")), weekdayLabelsFull.map(label => React.createElement("th", {
    key: `calendar_weekday_${label}`,
    className: "border border-slate-200 bg-slate-50 px-3 py-2 text-center text-[11px] font-bold text-slate-500"
  }, label)))), React.createElement("tbody", null, calendarWeeks.map((week, weekIndex) => React.createElement(React.Fragment, {
    key: `calendar_week_${weekIndex}`
  }, React.createElement("tr", null, React.createElement("td", {
    className: "sticky left-0 z-10 border border-slate-200 bg-slate-50 px-3 py-2 font-bold text-slate-500"
  }, weekIndex === 0 ? monthLabel : ''), week.map((dateKey, dayIndex) => React.createElement("td", {
    key: `calendar_date_${weekIndex}_${dayIndex}`,
    className: `border border-slate-200 px-3 py-2 align-top ${dateKey === planning.todayKey ? 'bg-blue-50' : 'bg-slate-50/60'}`
  }, dateKey ? React.createElement(React.Fragment, null, React.createElement("div", {
    className: "text-lg font-bold text-slate-800 leading-none"
  }, getHeader(dateKey).day), React.createElement("div", {
    className: "text-[10px] text-slate-400 mt-1"
  }, weekdayLabelsFull[dayIndex])) : React.createElement("div", {
    className: "h-7"
  })))), React.createElement("tr", null, React.createElement("td", {
    className: "sticky left-0 z-10 border border-slate-200 bg-amber-50/80 px-3 py-2 text-[11px] font-bold text-amber-700"
  }, "\u672C\u9031\u672A\u6392"), React.createElement("td", {
    colSpan: "7",
    className: "border border-slate-200 bg-amber-50/40 px-3 py-2"
  }, weeklyMissingActivities[weekIndex] && weeklyMissingActivities[weekIndex].length > 0 ? React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, weeklyMissingActivities[weekIndex].slice(0, 8).map(name => React.createElement("span", {
    key: `weekly_missing_${weekIndex}_${name}`,
    className: "rounded-full border border-amber-200 bg-white/80 px-2 py-1 text-[10px] font-bold text-amber-700"
  }, name)), weeklyMissingActivities[weekIndex].length > 8 && React.createElement("span", {
    className: "px-2 py-1 text-[10px] font-bold text-amber-700"
  }, "+", weeklyMissingActivities[weekIndex].length - 8, " \u500B\u6D3B\u52D5")) : React.createElement("div", {
    className: "text-[11px] font-medium text-emerald-700"
  }, "\u672C\u9031\u5DE6\u6B04\u6D3B\u52D5\u90FD\u6709\u5B89\u6392"))), calendarRows.map(row => React.createElement("tr", {
    key: `calendar_row_${weekIndex}_${row.name}`
  }, React.createElement("td", {
    className: "sticky left-0 z-10 border border-slate-200 bg-white px-3 py-2 align-top font-bold text-slate-700"
  }, React.createElement("div", null, row.name), React.createElement("div", {
    className: "text-[10px] font-medium text-slate-400 mt-1"
  }, "\u6A21\u64EC ", row.simulatedCount || 0)), week.map((dateKey, dayIndex) => {
    if (!dateKey) {
      return React.createElement("td", {
        key: `calendar_blank_${row.name}_${weekIndex}_${dayIndex}`,
        className: "border border-slate-100 bg-slate-50/40 px-2 py-2 align-top"
      });
    }
    const cell = row.cellMap[dateKey] || {
      dateKey,
      state: 'available',
      isPast: false,
      entries: [],
      canDrop: false,
      simulatedPlacements: [],
      simulatedPlacement: null
    };
    const simulatedPlacements = Array.isArray(cell.simulatedPlacements) ? cell.simulatedPlacements : cell.simulatedPlacement ? [cell.simulatedPlacement] : [];
    const cellKey = buildCellKey(dateKey, row.name);
    const isDropTarget = dragTargetKey === cellKey;
    return React.createElement("td", {
      key: `calendar_cell_${row.name}_${dateKey}`,
      className: `border border-slate-200 px-2 py-2 align-top min-h-[84px] transition ${getCalendarCellTone(cell)} ${cell.canDrop ? 'cursor-copy' : ''} ${isDropTarget ? 'ring-2 ring-slate-400 ring-inset' : ''}`,
      onDragOver: handleCellDragOver(row.name, cell),
      onDrop: handleCellDrop(row.name, cell),
      onDragLeave: () => {
        if (dragTargetKey === cellKey) setDragTargetKey('');
      }
    }, React.createElement("div", {
      className: "space-y-1"
    }, Array.isArray(cell.entries) && cell.entries.slice(0, 2).map((entry, index) => React.createElement("div", {
      key: `${row.name}_${dateKey}_${entry.key || index}`,
      className: `rounded-md border px-2 py-1 leading-tight ${getEntryTone(entry.type)}`
    }, React.createElement("div", {
      className: "font-bold break-words"
    }, entry.title), entry.note && React.createElement("div", {
      className: "text-[10px] opacity-70 mt-0.5"
    }, entry.note))), Array.isArray(cell.entries) && cell.entries.length > 2 && React.createElement("div", {
      className: "text-[10px] text-slate-400"
    }, "+", cell.entries.length - 2, " \u9805\u6B63\u5F0F\u5B89\u6392"), simulatedPlacements.map((placement, placementIndex) => React.createElement("div", {
      key: `simulated_${cellKey}_${placement.id || placementIndex}`,
      draggable: true,
      onDragStart: handleDragStart({
        type: 'placement',
        eventName: placement.eventName,
        sourceDateKey: cell.dateKey,
        sourceInstructorName: row.name,
        sourcePlacementId: placement.id
      }),
      onDragEnd: handleDragEnd,
      className: `relative rounded-md border px-2 py-1.5 pr-5 pb-4 cursor-grab active:cursor-grabbing ${getEntryTone('simulated')}`
    }, React.createElement("div", {
      className: "text-[10px] font-semibold leading-[1.2] tracking-tight text-violet-800",
      style: {
        wordBreak: 'keep-all',
        overflowWrap: 'anywhere',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden'
      }
    }, placement.eventName), React.createElement("div", {
      className: "text-[9px] opacity-70 mt-1"
    }, "\u6A21\u64EC\u5B89\u6392"), React.createElement("button", {
      type: "button",
      title: "\u79FB\u9664\u6A21\u64EC\u5B89\u6392",
      "aria-label": "\u79FB\u9664\u6A21\u64EC\u5B89\u6392",
      onClick: event => {
        event.stopPropagation();
        captureScrollSnapshot();
        onRemovePlacement(row.name, cell.dateKey, placement.id);
      },
      className: "absolute bottom-1 right-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[11px] font-bold leading-none text-violet-500 hover:bg-violet-100/80 hover:text-violet-700"
    }, "\xD7"))), simulatedPlacements.length === 0 && (!Array.isArray(cell.entries) || cell.entries.length === 0) && React.createElement("div", {
      className: `text-[11px] leading-tight ${getCalendarEmptyLabelTone(cell)}`
    }, getCalendarEmptyLabel(cell))));
  }))))), calendarRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "8",
    className: "px-4 py-8 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200"
  }, "\u76EE\u524D\u5C1A\u7121\u53EF\u7528\u4F86\u6A21\u64EC\u7684\u8B1B\u5E2B\u8CC7\u6599\u3002"))))))), React.createElement("div", {
    className: "bg-slate-50 border border-slate-200 rounded-2xl p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "briefcase",
    size: 16
  }), " \u6D3B\u52D5\u6A21\u64EC\u5047\u8A2D"), React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u9019\u88E1\u53EA\u4FDD\u7559\u6D3B\u52D5\u6578\u3001\u5E73\u5747\u4EBA\u6578\u3001\u6BCF\u4EBA\u71DF\u6536\u3001\u6BCF\u4EBA\u6210\u672C\u8207\u7E3D\u6BDB\u5229\u3002\u672A\u624B\u52D5\u8F38\u5165\u6642\uFF0C\u6703\u5148\u5E36\u5165\u7576\u6708\u6B63\u5F0F\u6D3B\u52D5\u5E73\u5747\u503C\u3002"))), React.createElement("div", {
    className: "mb-4 grid grid-cols-1 xl:grid-cols-3 gap-3"
  }, bulkMetricConfigs.map(item => React.createElement("div", {
    key: `bulk_metric_${item.field}`,
    className: "rounded-xl border border-slate-200 bg-white px-4 py-3 flex flex-col gap-3"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold text-slate-600"
  }, item.label), React.createElement("div", {
    className: "text-[11px] text-slate-400"
  }, item.hint)), React.createElement("div", {
    className: "flex flex-wrap items-center gap-2"
  }, React.createElement("input", {
    type: "number",
    step: item.step,
    className: `${item.inputClass} px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold outline-none focus:ring-2 focus:ring-blue-200`,
    value: bulkMetricDraft[item.field],
    onChange: e => updateBulkMetricDraft(item.field, e.target.value),
    placeholder: item.placeholder
  }), React.createElement("button", {
    onClick: () => applyBulkMetric(item.field),
    disabled: activityRowNames.length === 0 || bulkMetricDraft[item.field] === '',
    className: "px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
  }, "\u5957\u7528\u5168\u90E8"), React.createElement("button", {
    onClick: () => clearBulkMetric(item.field),
    disabled: activityRowNames.length === 0,
    className: "px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
  }, "\u6E05\u7A7A\u624B\u52D5"))))), React.createElement("div", {
    className: "overflow-x-auto"
  }, React.createElement("table", {
    className: "w-full min-w-[860px] text-sm bg-white border border-slate-200 rounded-xl overflow-hidden"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-4 py-3 text-left"
  }, "\u6D3B\u52D5\u540D\u7A31"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u6D3B\u52D5\u6578"), React.createElement("th", {
    className: "px-4 py-3 text-center"
  }, "\u5E73\u5747\u4EBA\u6578"), React.createElement("th", {
    className: "px-4 py-3 text-right"
  }, "\u6BCF\u4EBA\u71DF\u6536"), React.createElement("th", {
    className: "px-4 py-3 text-right"
  }, "\u6BCF\u4EBA\u6210\u672C"), React.createElement("th", {
    className: "px-4 py-3 text-right"
  }, "\u7E3D\u6BDB\u5229"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, planning.activityRows.map(row => React.createElement("tr", {
    key: `planning_row_${row.name}`,
    className: "hover:bg-slate-50"
  }, React.createElement("td", {
    className: "px-4 py-3 font-bold text-slate-700"
  }, row.name), React.createElement("td", {
    className: "px-4 py-3 text-center font-bold text-violet-700"
  }, row.activityCount), React.createElement("td", {
    className: "px-4 py-3 text-center"
  }, React.createElement("div", {
    className: "flex flex-col items-center gap-1"
  }, React.createElement("input", {
    type: "number",
    step: "0.1",
    title: row.isAutoAvgPax ? '目前使用當月正式活動平均每團人數；直接輸入可改成手動值。' : '',
    className: `w-24 px-2 py-1.5 rounded-lg border text-center font-bold outline-none focus:ring-2 focus:ring-blue-200 ${row.isAutoAvgPax ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`,
    value: row.avgPax,
    onChange: e => onChangeActivityMetric(row.name, 'avgPax', e.target.value),
    placeholder: "\u672A\u8A2D\u5B9A"
  }), React.createElement("div", {
    className: `text-[10px] ${row.isAutoAvgPax ? 'text-emerald-600' : 'text-slate-300'}`
  }, row.isAutoAvgPax ? '自動帶入' : '手動設定'))), React.createElement("td", {
    className: "px-4 py-3 text-right"
  }, React.createElement("div", {
    className: "flex flex-col items-end gap-1"
  }, React.createElement("input", {
    type: "number",
    step: "1",
    title: row.isAutoRevenuePerPax ? '目前使用當月正式活動平均每人營收；直接輸入可改成手動值。' : '',
    className: `w-28 px-2 py-1.5 rounded-lg border text-right font-bold outline-none focus:ring-2 focus:ring-blue-200 ${row.isAutoRevenuePerPax ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`,
    value: row.revenuePerPax,
    onChange: e => onChangeActivityMetric(row.name, 'revenuePerPax', e.target.value),
    placeholder: "\u672A\u8A2D\u5B9A"
  }), React.createElement("div", {
    className: `text-[10px] ${row.isAutoRevenuePerPax ? 'text-emerald-600' : 'text-slate-300'}`
  }, row.isAutoRevenuePerPax ? '自動帶入' : '手動設定'))), React.createElement("td", {
    className: "px-4 py-3 text-right"
  }, React.createElement("div", {
    className: "flex flex-col items-end gap-1"
  }, React.createElement("input", {
    type: "number",
    step: "1",
    title: row.isAutoCostPerPax ? '目前使用當月正式活動平均每人成本；直接輸入可改成手動值。' : '',
    className: `w-28 px-2 py-1.5 rounded-lg border text-right font-bold outline-none focus:ring-2 focus:ring-blue-200 ${row.isAutoCostPerPax ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`,
    value: row.costPerPax,
    onChange: e => onChangeActivityMetric(row.name, 'costPerPax', e.target.value),
    placeholder: "\u672A\u8A2D\u5B9A"
  }), React.createElement("div", {
    className: `text-[10px] ${row.isAutoCostPerPax ? 'text-emerald-600' : 'text-slate-300'}`
  }, row.isAutoCostPerPax ? '自動帶入' : '手動設定'))), React.createElement("td", {
    className: "px-4 py-3 text-right font-bold text-amber-700"
  }, React.createElement("div", null, formatCurrency(row.projectedGrossProfit)), React.createElement("div", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "\u6BCF\u4EBA\u6BDB\u5229 ", formatCurrency(row.grossProfitPerPax))))), planning.activityRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "6",
    className: "px-4 py-8 text-center text-slate-400"
  }, "\u672C\u6708\u9084\u6C92\u6709\u6D3B\u52D5\u6A21\u64EC\u8CC7\u6599\u3002"))))), React.createElement("div", {
    className: "mt-4 rounded-xl border border-slate-200 bg-white px-4 py-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold text-slate-600"
  }, "\u6BDB\u5229\u62C6\u5206\u6BD4\u4F8B"), React.createElement("div", {
    className: "text-[11px] text-slate-400"
  }, "\u516C\u53F8\u6BDB\u5229\u8207\u696D\u7E3E\u734E\u91D1\u6703\u4F9D\u7167\u9019\u500B\u6BD4\u4F8B\u81EA\u52D5\u63DB\u7B97\uFF0C\u5169\u8005\u5408\u8A08\u56FA\u5B9A\u70BA 100%\u3002")), React.createElement("div", {
    className: "flex flex-wrap items-center gap-3"
  }, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 flex items-center gap-2"
  }, "\u516C\u53F8", React.createElement("input", {
    type: "number",
    min: "0",
    max: "100",
    step: "0.1",
    className: "w-24 px-3 py-2 rounded-lg border border-slate-200 text-right text-sm font-bold outline-none focus:ring-2 focus:ring-blue-200",
    value: planning.profitSplit.companyPct,
    onChange: e => onChangeProfitSplit('companyPct', e.target.value)
  }), React.createElement("span", null, "%")), React.createElement("label", {
    className: "text-xs font-bold text-slate-500 flex items-center gap-2"
  }, "\u696D\u7E3E\u734E\u91D1", React.createElement("input", {
    type: "number",
    min: "0",
    max: "100",
    step: "0.1",
    className: "w-24 px-3 py-2 rounded-lg border border-slate-200 text-right text-sm font-bold outline-none focus:ring-2 focus:ring-blue-200",
    value: planning.profitSplit.bonusPct,
    onChange: e => onChangeProfitSplit('bonusPct', e.target.value)
  }), React.createElement("span", null, "%")))), React.createElement("div", {
    className: "mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3"
  }, React.createElement("div", {
    className: "rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3"
  }, React.createElement("div", {
    className: "text-xs font-bold text-emerald-700"
  }, "\u7E3D\u4EBA\u6578"), React.createElement("div", {
    className: "mt-2 text-2xl font-bold text-emerald-800"
  }, formatNumber(planning.summary.plannedPax, 1), " \u4EBA")), React.createElement("div", {
    className: "rounded-xl border border-amber-100 bg-amber-50 px-4 py-3"
  }, React.createElement("div", {
    className: "text-xs font-bold text-amber-700"
  }, "\u6BDB\u5229\u7E3D\u548C"), React.createElement("div", {
    className: "mt-2 text-2xl font-bold text-amber-800"
  }, formatCurrency(planning.summary.plannedGrossProfit))), React.createElement("div", {
    className: "rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"
  }, React.createElement("div", {
    className: "text-xs font-bold text-blue-700"
  }, "\u516C\u53F8\u6BDB\u5229"), React.createElement("div", {
    className: "mt-2 text-2xl font-bold text-blue-800"
  }, formatCurrency(planning.summary.companyGrossProfit))), React.createElement("div", {
    className: "rounded-xl border border-violet-100 bg-violet-50 px-4 py-3"
  }, React.createElement("div", {
    className: "text-xs font-bold text-violet-700"
  }, "\u696D\u7E3E\u734E\u91D1"), React.createElement("div", {
    className: "mt-2 text-2xl font-bold text-violet-800"
  }, formatCurrency(planning.summary.bonusGrossProfit)))))), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-2xl p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-sm font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "grid-2x2",
    size: 16
  }), " \u8B1B\u5E2B x \u65E5\u671F\u53EF\u7528\u77E9\u9663"), React.createElement("p", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u4FDD\u7559\u7DCA\u6E4A\u7248\u77E9\u9663\uFF0C\u65B9\u4FBF\u5FEB\u901F\u6383\u4E00\u773C\u6574\u6708\u7A7A\u6A94\u3002\u82E5\u683C\u5B50\u986F\u793A `\u6A21`\uFF0C\u4EE3\u8868\u90A3\u5929\u5DF2\u7D93\u653E\u4E86\u6A21\u64EC\u6D3B\u52D5\u3002")), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, legendItems.map(item => React.createElement("div", {
    key: item.label,
    className: `px-2.5 py-1 rounded-full border text-[11px] font-bold ${item.tone}`
  }, item.label)))), React.createElement("div", {
    ref: matrixScrollRef,
    className: "overflow-x-auto"
  }, React.createElement("table", {
    className: "min-w-[1160px] border-separate border-spacing-1 text-xs"
  }, React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", {
    className: "sticky left-0 z-20 bg-white border border-slate-200 rounded-xl px-3 py-2 text-left min-w-[140px]"
  }, React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500 uppercase tracking-wide"
  }, "\u8B1B\u5E2B")), planning.matrixDates.map(dateKey => {
    const header = getHeader(dateKey);
    const isToday = dateKey === planning.todayKey;
    return React.createElement("th", {
      key: `planning_head_${dateKey}`,
      className: `min-w-[46px] px-0.5 py-1 text-center rounded-xl border ${isToday ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500'}`
    }, React.createElement("div", {
      className: "text-[11px] font-bold leading-none"
    }, header.day), React.createElement("div", {
      className: "text-[10px] opacity-70 mt-1 leading-none"
    }, header.weekday));
  }))), React.createElement("tbody", null, planning.matrixRows.map(row => React.createElement("tr", {
    key: `planning_matrix_${row.name}`
  }, React.createElement("td", {
    className: "sticky left-0 z-10 bg-white border border-slate-200 rounded-xl px-3 py-2 align-middle"
  }, React.createElement("div", {
    className: "font-bold text-slate-700"
  }, row.name), React.createElement("div", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "\u7A7A ", row.openCount, " / \u6A21 ", row.simulatedCount || 0, " / \u6B63\u5F0F ", row.actualBusyCount, " / \u4F11 ", row.restCount)), row.cells.map(cell => {
    const isToday = cell.dateKey === planning.todayKey;
    return React.createElement("td", {
      key: `${row.name}_${cell.dateKey}`,
      className: "p-0.5"
    }, React.createElement("div", {
      title: `${row.name} ${cell.dateKey}`,
      className: `w-9 h-10 rounded-lg border flex items-center justify-center font-bold ${getCellTone(cell)} ${isToday ? 'ring-1 ring-blue-300' : ''}`
    }, getCompactCellLabel(cell)));
  }))), planning.matrixRows.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: Math.max((planning.matrixDates?.length || 0) + 1, 2),
    className: "px-4 py-8 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200"
  }, "\u76EE\u524D\u5C1A\u7121\u53EF\u7528\u4F86\u6A21\u64EC\u7684\u8B1B\u5E2B\u8CC7\u6599\u3002")))))))));
};
const TimeAnalysisModal = ({
  title,
  data,
  onClose
}) => {
  const [selectedYear, setSelectedYear] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const handleYearClick = year => {
    if (selectedYear === year) {
      setSelectedYear(null);
      setSelectedMonth(null);
    } else {
      setSelectedYear(year);
      setSelectedMonth(null);
    }
  };
  const handleMonthClick = idx => {
    if (selectedMonth === idx) {
      setSelectedMonth(null);
    } else {
      setSelectedMonth(idx);
    }
  };
  const resetFilters = () => {
    setSelectedYear(null);
    setSelectedMonth(null);
  };
  const yearStats = useMemo(() => {
    const stats = {};
    let max = 0;
    data.forEach(row => {
      if (!row.date || row.customerName === '開放報名中') return;
      const d = new Date(row.date);
      if (isNaN(d.getTime())) return;
      const y = d.getFullYear();
      const price = Number(row.price) || 0;
      if (!stats[y]) stats[y] = {
        count: 0,
        revenue: 0
      };
      stats[y].count += 1;
      stats[y].revenue += price;
      if (stats[y].revenue > max) max = stats[y].revenue;
    });
    return {
      data: stats,
      max
    };
  }, [data]);
  const monthStats = useMemo(() => {
    const stats = Array(12).fill(0).map(() => ({
      count: 0,
      revenue: 0
    }));
    let max = 0;
    data.forEach(row => {
      if (!row.date || row.customerName === '開放報名中') return;
      const d = new Date(row.date);
      if (isNaN(d.getTime())) return;
      if (selectedYear !== null && d.getFullYear() !== selectedYear) return;
      const m = d.getMonth();
      const price = Number(row.price) || 0;
      stats[m].count += 1;
      stats[m].revenue += price;
      if (stats[m].revenue > max) max = stats[m].revenue;
    });
    return {
      data: stats,
      max
    };
  }, [data, selectedYear]);
  const weekStats = useMemo(() => {
    const stats = Array(7).fill(0).map(() => ({
      count: 0,
      revenue: 0
    }));
    let max = 0;
    data.forEach(row => {
      if (!row.date || row.customerName === '開放報名中') return;
      const d = new Date(row.date);
      if (isNaN(d.getTime())) return;
      if (selectedYear !== null && d.getFullYear() !== selectedYear) return;
      if (selectedMonth !== null && d.getMonth() !== selectedMonth) return;
      const w = d.getDay();
      const price = Number(row.price) || 0;
      stats[w].count += 1;
      stats[w].revenue += price;
      if (stats[w].revenue > max) max = stats[w].revenue;
    });
    return {
      data: stats,
      max
    };
  }, [data, selectedYear, selectedMonth]);
  const weekdayNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const renderBar = (label, value, count, max, baseColorClass, isSelected, onClick) => {
    const percent = max > 0 ? value / max * 100 : 0;
    const activeColor = isSelected ? baseColorClass.replace('500', '700') : baseColorClass;
    const containerClass = isSelected ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-50";
    return React.createElement("div", {
      onClick: onClick,
      className: `flex items-center gap-4 py-2 px-2 rounded-lg cursor-pointer transition-all ${containerClass}`
    }, React.createElement("div", {
      className: `w-14 text-sm font-bold text-right shrink-0 ${isSelected ? 'text-slate-900 underline' : 'text-slate-600'}`
    }, label), React.createElement("div", {
      className: "flex-1"
    }, React.createElement("div", {
      className: "flex justify-between text-xs mb-1"
    }, React.createElement("span", {
      className: `font-bold ${isSelected ? 'text-slate-900' : 'text-slate-700'}`
    }, "$", value.toLocaleString()), React.createElement("span", {
      className: "text-slate-400"
    }, count, " \u4EBA")), React.createElement("div", {
      className: "w-full h-2 bg-slate-100 rounded-full overflow-hidden"
    }, React.createElement("div", {
      className: `h-full rounded-full transition-all duration-500 ${activeColor}`,
      style: {
        width: `${percent}%`
      }
    }))), isSelected && React.createElement(Icon, {
      name: "check-circle",
      size: 14,
      className: "text-slate-400 shrink-0"
    }));
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[90] flex items-center justify-center p-4 fade-in backdrop-blur-sm",
    onClick: onClose
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-5xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto",
    onClick: e => e.stopPropagation()
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6 pb-4 border-b"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-xl font-bold text-slate-800 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "bar-chart-2",
    className: "text-blue-600"
  }), " \u6642\u9593\u7DAD\u5EA6\u92B7\u552E\u5206\u6790"), React.createElement("div", {
    className: "flex items-center gap-2 mt-1 text-sm text-slate-500"
  }, React.createElement("span", null, "\u76EE\u524D\u6AA2\u8996\uFF1A"), React.createElement("span", {
    className: `px-2 py-0.5 rounded font-bold ${selectedYear ? 'bg-blue-100 text-blue-700' : 'bg-slate-100'}`
  }, selectedYear ? `${selectedYear}年` : '所有年份'), React.createElement(Icon, {
    name: "chevron-right",
    size: 12
  }), React.createElement("span", {
    className: `px-2 py-0.5 rounded font-bold ${selectedMonth !== null ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100'}`
  }, selectedMonth !== null ? `${selectedMonth + 1}月` : '全年'), (selectedYear !== null || selectedMonth !== null) && React.createElement("button", {
    onClick: resetFilters,
    className: "ml-2 text-xs text-red-500 hover:underline flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "x-circle",
    size: 12
  }), " \u91CD\u7F6E"))), React.createElement("button", {
    onClick: onClose,
    className: "p-2 hover:bg-slate-100 rounded-full"
  }, React.createElement(Icon, {
    name: "x",
    className: "text-slate-400"
  }))), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-6"
  }, React.createElement("div", {
    className: "bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col h-full"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 mb-4 flex items-center gap-2 pb-2 border-b border-slate-100"
  }, React.createElement("div", {
    className: "bg-blue-100 p-1.5 rounded text-blue-600"
  }, React.createElement(Icon, {
    name: "calendar",
    size: 16
  })), "\u5E74\u4EFD\u8868\u73FE (\u9EDE\u64CA\u7BE9\u9078)"), React.createElement("div", {
    className: "space-y-1 overflow-y-auto flex-1 custom-scrollbar max-h-[400px]"
  }, Object.keys(yearStats.data).sort().map(year => {
    const y = parseInt(year);
    return React.createElement("div", {
      key: y
    }, renderBar(y, yearStats.data[y].revenue, yearStats.data[y].count, yearStats.max, 'bg-blue-500', selectedYear === y, () => handleYearClick(y)));
  }))), React.createElement("div", {
    className: "bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col h-full"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 mb-4 flex items-center gap-2 pb-2 border-b border-slate-100"
  }, React.createElement("div", {
    className: "bg-emerald-100 p-1.5 rounded text-emerald-600"
  }, React.createElement(Icon, {
    name: "moon",
    size: 16
  })), "\u6708\u4EFD\u6DE1\u65FA\u5B63 (\u9EDE\u64CA\u7BE9\u9078)"), React.createElement("div", {
    className: "space-y-1 overflow-y-auto flex-1 custom-scrollbar max-h-[400px]"
  }, monthStats.data.map((d, idx) => React.createElement("div", {
    key: idx
  }, renderBar(`${idx + 1}月`, d.revenue, d.count, monthStats.max, 'bg-emerald-500', selectedMonth === idx, () => handleMonthClick(idx)))), monthStats.max === 0 && React.createElement("div", {
    className: "text-center text-slate-400 py-10"
  }, "\u8A72\u5E74\u4EFD\u7121\u6578\u64DA"))), React.createElement("div", {
    className: "bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col h-full"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 mb-4 flex items-center gap-2 pb-2 border-b border-slate-100"
  }, React.createElement("div", {
    className: "bg-purple-100 p-1.5 rounded text-purple-600"
  }, React.createElement(Icon, {
    name: "sun",
    size: 16
  })), "\u661F\u671F\u5206\u4F48 (\u7D50\u679C)"), React.createElement("div", {
    className: "space-y-1 overflow-y-auto flex-1 custom-scrollbar max-h-[400px]"
  }, weekStats.data.map((d, idx) => React.createElement("div", {
    key: idx
  }, renderBar(weekdayNames[idx], d.revenue, d.count, weekStats.max, 'bg-purple-500', false, null))), weekStats.max === 0 && React.createElement("div", {
    className: "text-center text-slate-400 py-10"
  }, "\u7121\u7B26\u5408\u6578\u64DA"))))));
};
const ActivityPerformance = ({
  parsedData,
  eventConfigs,
  productPerformanceSettings = {},
  onSaveProductPerformanceSettings
}) => {
  const [dimension, setDimension] = useState('category');
  const [analysisData, setAnalysisData] = useState(null);
  const [sectionExpanded, setSectionExpanded] = useState({
    past: true,
    future: false
  });
  const [showProductSettings, setShowProductSettings] = useState(false);
  const [productSettingsDraft, setProductSettingsDraft] = useState({});
  const [productSettingsSaveStatus, setProductSettingsSaveStatus] = useState('idle');
  const getDateKey = value => {
    if (!value) return '';
    if (value instanceof Date) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    const raw = String(value).trim();
    const match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!match) return raw;
    return `${match[1]}-${String(parseInt(match[2], 10)).padStart(2, '0')}-${String(parseInt(match[3], 10)).padStart(2, '0')}`;
  };
  const todayKey = useMemo(() => getDateKey(new Date()), []);
  const getRowConfig = row => {
    const sortedInstr = row.instructor ? row.instructor.split(/[&,]/).map(s => s.trim()).sort().join(' & ') : '';
    const rowKey = `${row.date}_${row.eventName}_${sortedInstr}`.replace(/[\/\\#\?]/g, '-');
    return eventConfigs[rowKey] || {};
  };
  const getProductName = row => {
    const config = getRowConfig(row);
    return String(config.activityCategory || row.eventName || '未分類').trim() || '未分類';
  };
  const getResolvedProductSetting = productName => {
    const saved = productPerformanceSettings?.[productName] || {};
    const resolvedBucket = PERFORMANCE_BUCKET_OPTIONS.some(option => option.value === saved?.bucket) ? saved.bucket : inferPerformanceBucket(productName);
    const legacyCost = saved?.cost === '' || saved?.cost === null || saved?.cost === undefined ? '' : Number(saved.cost) || 0;
    return {
      bucket: resolvedBucket,
      trait: String(saved?.trait || '').trim(),
      costPerPax: saved?.costPerPax === '' || saved?.costPerPax === null || saved?.costPerPax === undefined ? legacyCost : Number(saved.costPerPax) || 0,
      costPerSession: saved?.costPerSession === '' || saved?.costPerSession === null || saved?.costPerSession === undefined ? '' : Number(saved.costPerSession) || 0
    };
  };
  const validRows = useMemo(() => (parsedData || []).filter(row => row.customerName !== '開放報名中'), [parsedData]);
  const segmentedRows = useMemo(() => {
    const past = [];
    const future = [];
    validRows.forEach(row => {
      const dateKey = getDateKey(row.date);
      if (dateKey && dateKey >= todayKey) {
        future.push(row);
      } else {
        past.push(row);
      }
    });
    return {
      past,
      future
    };
  }, [validRows, todayKey]);
  const productNames = useMemo(() => {
    const nameSet = new Set();
    validRows.forEach(row => nameSet.add(getProductName(row)));
    Object.keys(productPerformanceSettings || {}).forEach(name => nameSet.add(String(name || '').trim()));
    return Array.from(nameSet).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  }, [validRows, eventConfigs, productPerformanceSettings]);
  useEffect(() => {
    const nextDraft = {};
    productNames.forEach(name => {
      const resolved = getResolvedProductSetting(name);
      nextDraft[name] = {
        bucket: resolved.bucket,
        trait: resolved.trait,
        costPerPax: resolved.costPerPax,
        costPerSession: resolved.costPerSession
      };
    });
    setProductSettingsDraft(nextDraft);
    setProductSettingsSaveStatus('idle');
  }, [productNames, productPerformanceSettings]);
  const buildLoyaltyMetrics = rows => {
    if (!rows || rows.length === 0) return {
      rate: '0.0',
      heavyRate: '0.0',
      total: 0
    };
    const counts = {};
    rows.forEach(row => {
      const name = row.customerName || row['姓名'];
      if (name && name !== '開放報名中') {
        counts[name] = (counts[name] || 0) + 1;
      }
    });
    const total = Object.keys(counts).length;
    const repeat = Object.values(counts).filter(count => count > 1).length;
    const heavy = Object.values(counts).filter(count => count >= 3).length;
    return {
      rate: total > 0 ? (repeat / total * 100).toFixed(1) : '0.0',
      heavyRate: total > 0 ? (heavy / total * 100).toFixed(1) : '0.0',
      total
    };
  };
  const buildActivityStats = rows => {
    const stats = {};
    rows.forEach(row => {
      const config = getRowConfig(row);
      const tags = config.tags || {};
      let groupName = '未分類';
      if (dimension === 'category') {
        groupName = config.activityCategory || row.eventName || '未分類';
      } else if (dimension === 'name') {
        groupName = row.eventName || '未命名活動';
      } else if (dimension === 'type') {
        groupName = tags.types || '未分類';
      } else if (dimension === 'level') {
        groupName = tags.levels || '未分類';
      } else if (dimension === 'location') {
        groupName = tags.locations || '未分類';
      }
      if (!stats[groupName]) stats[groupName] = {
        revenue: 0,
        pax: 0,
        sessions: new Set(),
        rawRows: []
      };
      stats[groupName].revenue += row.price || 0;
      stats[groupName].pax += 1;
      stats[groupName].sessions.add(`${row.date}_${row.instructor || ''}`);
      stats[groupName].rawRows.push(row);
    });
    return Object.entries(stats).map(([name, data]) => ({
      name,
      revenue: data.revenue,
      pax: data.pax,
      sessions: data.sessions.size,
      avgRev: data.sessions.size > 0 ? Math.round(data.revenue / data.sessions.size) : 0,
      avgPax: data.sessions.size > 0 ? (data.pax / data.sessions.size).toFixed(1) : 0,
      arpu: data.pax > 0 ? Math.round(data.revenue / data.pax) : 0,
      rawRows: data.rawRows
    })).sort((a, b) => b.revenue - a.revenue);
  };
  const buildProductReportSections = rows => {
    const grouped = PERFORMANCE_BUCKET_OPTIONS.reduce((acc, option) => {
      acc[option.value] = {};
      return acc;
    }, {});
    rows.forEach(row => {
      const productName = getProductName(row);
      const resolved = getResolvedProductSetting(productName);
      const bucket = PERFORMANCE_BUCKET_OPTIONS.some(option => option.value === resolved.bucket) ? resolved.bucket : 'theme';
      if (!grouped[bucket][productName]) {
        grouped[bucket][productName] = {
          name: productName,
          trait: resolved.trait,
          costPerPax: resolved.costPerPax,
          costPerSession: resolved.costPerSession,
          revenue: 0,
          pax: 0,
          sessions: new Set()
        };
      }
      grouped[bucket][productName].revenue += Number(row.price) || 0;
      grouped[bucket][productName].pax += 1;
      grouped[bucket][productName].sessions.add(`${row.date}_${row.instructor || ''}`);
    });
    return PERFORMANCE_BUCKET_OPTIONS.map(option => {
      const rowsForBucket = Object.values(grouped[option.value] || {}).map(item => ({
        ...item,
        sessionCount: item.sessions.size,
        avgPax: item.sessions.size > 0 ? Number((item.pax / item.sessions.size).toFixed(1)) : 0,
        avgRevenue: item.sessions.size > 0 ? Math.round(item.revenue / item.sessions.size) : 0,
        avgGrossProfit: item.sessions.size > 0 ? Math.round((item.revenue - (Number(item.costPerPax) || 0) * item.pax - (Number(item.costPerSession) || 0) * item.sessions.size) / item.sessions.size) : 0
      })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'zh-Hant'));
      return {
        ...option,
        rows: rowsForBucket,
        totalRevenue: rowsForBucket.reduce((sum, item) => sum + item.revenue, 0),
        totalPax: rowsForBucket.reduce((sum, item) => sum + item.pax, 0)
      };
    });
  };
  const pastActivityStats = useMemo(() => buildActivityStats(segmentedRows.past), [segmentedRows.past, eventConfigs, dimension]);
  const futureActivityStats = useMemo(() => buildActivityStats(segmentedRows.future), [segmentedRows.future, eventConfigs, dimension]);
  const pastLoyaltyMetrics = useMemo(() => buildLoyaltyMetrics(segmentedRows.past), [segmentedRows.past]);
  const futureLoyaltyMetrics = useMemo(() => buildLoyaltyMetrics(segmentedRows.future), [segmentedRows.future]);
  const pastProductReportSections = useMemo(() => buildProductReportSections(segmentedRows.past), [segmentedRows.past, eventConfigs, productPerformanceSettings]);
  const futureProductReportSections = useMemo(() => buildProductReportSections(segmentedRows.future), [segmentedRows.future, eventConfigs, productPerformanceSettings]);
  const dimensionLabels = {
    category: '依活動性質 (合併分析)',
    name: '依後台名稱 (原始名稱)',
    type: '依活動種類 (標籤)',
    level: '依活動等級 (標籤)',
    location: '依活動地點 (標籤)'
  };
  const handleGlobalAnalysis = (title, rows) => {
    setAnalysisData({
      title,
      data: rows
    });
  };
  const handleItemAnalysis = (item, scopeLabel) => {
    setAnalysisData({
      title: `${scopeLabel}｜分析項目: ${item.name}`,
      data: item.rawRows
    });
  };
  const toggleSection = key => {
    setSectionExpanded(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };
  const handleProductSettingChange = (name, field, value) => {
    setProductSettingsDraft(prev => ({
      ...prev,
      [name]: {
        ...(prev[name] || {
          bucket: inferPerformanceBucket(name),
          trait: '',
          costPerPax: '',
          costPerSession: ''
        }),
        [field]: value
      }
    }));
    setProductSettingsSaveStatus('idle');
  };
  const handleSaveProductSettings = async () => {
    if (!onSaveProductPerformanceSettings) return;
    setProductSettingsSaveStatus('saving');
    try {
      await onSaveProductPerformanceSettings(productSettingsDraft);
      setProductSettingsSaveStatus('success');
      setTimeout(() => setProductSettingsSaveStatus('idle'), 2000);
    } catch (e) {
      console.error('Save performance product settings failed', e);
      setProductSettingsSaveStatus('error');
      alert(`❌ 產品分類設定儲存失敗：${e?.message || e}`);
    }
  };
  const handleExportProductReport = (filePrefix, sections) => {
    const exportDate = todayKey ? todayKey.replace(/-/g, '') : getDateKey(new Date()).replace(/-/g, '');
    const rows = [[Number(exportDate) || exportDate]];
    sections.forEach((section, idx) => {
      if (idx > 0) rows.push([]);
      rows.push([section.label, '特性', '總營收', '總人數', '總場次', '平均人數', '成本（每人)', '成本（每場）', '平均營收', '平均毛利']);
      if (section.rows.length === 0) {
        rows.push(['(無資料)', '', 0, 0, 0, 0, '', '', 0, 0]);
        return;
      }
      section.rows.forEach(item => {
        rows.push([item.name, item.trait || '', item.revenue, item.pax, item.sessionCount, item.avgPax, item.costPerPax === '' ? '' : item.costPerPax, item.costPerSession === '' ? '' : item.costPerSession, item.avgRevenue, item.avgGrossProfit]);
      });
    });
    downloadExcelWorkbook([{
      name: `${filePrefix}_${exportDate}`,
      rows
    }], `${filePrefix}_${exportDate}.xls`);
  };
  const renderSection = ({
    key,
    title,
    description,
    badgeTone,
    rows,
    activityStats,
    loyaltyMetrics,
    emptyText,
    globalAnalysisTitle,
    productReportSections,
    productReportDescription,
    productReportEmptyText,
    exportFilePrefix
  }) => {
    const avgRev = activityStats.length > 0 ? Math.round(activityStats.reduce((sum, item) => sum + item.avgRev, 0) / activityStats.length) : 0;
    const avgPax = activityStats.length > 0 ? (activityStats.reduce((sum, item) => sum + parseFloat(item.avgPax), 0) / activityStats.length).toFixed(1) : '0.0';
    const avgArpu = activityStats.length > 0 ? Math.round(activityStats.reduce((sum, item) => sum + item.arpu, 0) / activityStats.length) : 0;
    const topItem = activityStats[0];
    const isExpanded = sectionExpanded[key];
    return React.createElement("section", {
      className: "bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden"
    }, React.createElement("button", {
      type: "button",
      onClick: () => toggleSection(key),
      className: "w-full px-6 py-5 bg-slate-50/70 hover:bg-slate-50 transition-colors flex flex-col gap-3 md:flex-row md:items-center md:justify-between text-left"
    }, React.createElement("div", {
      className: "min-w-0"
    }, React.createElement("div", {
      className: "flex flex-wrap items-center gap-2"
    }, React.createElement("h3", {
      className: "text-lg font-bold text-slate-800"
    }, title), React.createElement("span", {
      className: `text-[11px] font-bold px-2.5 py-1 rounded-full border ${badgeTone}`
    }, "\u5831\u540D ", rows.length, " \u7B46"), React.createElement("span", {
      className: "text-[11px] font-bold px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-600"
    }, activityStats.length, " \u500B\u5206\u6790\u9805\u76EE")), React.createElement("p", {
      className: "text-sm text-slate-500 mt-2"
    }, description)), React.createElement("div", {
      className: "flex items-center gap-2 text-xs text-slate-500"
    }, React.createElement("span", null, isExpanded ? '收起區塊' : '展開區塊'), React.createElement(Icon, {
      name: isExpanded ? 'chevron-up' : 'chevron-down',
      size: 18,
      className: "text-slate-400"
    }))), isExpanded && React.createElement("div", {
      className: "p-6 space-y-6 animate-in fade-in slide-in-from-top-2"
    }, React.createElement("div", {
      className: "flex flex-col md:flex-row md:items-center md:justify-between gap-3"
    }, React.createElement("div", {
      className: "text-xs text-slate-400"
    }, key === 'past' ? '這一區只計入日期早於今天的已執行活動。' : '這一區獨立顯示今天起尚未執行的未來活動，不會混進過去成效。'), React.createElement("button", {
      onClick: () => handleGlobalAnalysis(globalAnalysisTitle, rows),
      disabled: rows.length === 0,
      className: `px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 shadow-sm transition-colors ${rows.length === 0 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-slate-800 text-white hover:bg-slate-700'}`
    }, React.createElement(Icon, {
      name: "pie-chart",
      size: 14
    }), "\u7E3D\u9AD4\u6642\u9593\u5206\u6790")), React.createElement("div", {
      className: "grid grid-cols-1 md:grid-cols-5 gap-4"
    }, React.createElement("div", {
      className: "bg-white p-4 rounded-2xl border border-slate-200 shadow-sm"
    }, React.createElement("div", {
      className: "text-xs text-slate-400 font-bold uppercase mb-1"
    }, key === 'past' ? '最高總營收項目' : '最高預估營收項目'), React.createElement("div", {
      className: "text-lg font-bold text-blue-600 truncate",
      title: topItem?.name
    }, topItem?.name || '-'), React.createElement("div", {
      className: "text-xs text-slate-500 mt-1"
    }, "$", Number(topItem?.revenue || 0).toLocaleString())), React.createElement("div", {
      className: "bg-white p-4 rounded-2xl border border-slate-200 shadow-sm"
    }, React.createElement("div", {
      className: "text-xs text-slate-400 font-bold uppercase mb-1"
    }, "\u5E73\u5747\u6BCF\u5834\u71DF\u6536"), React.createElement("div", {
      className: "text-2xl font-bold text-slate-800"
    }, "$", avgRev.toLocaleString())), React.createElement("div", {
      className: "bg-white p-4 rounded-2xl border border-slate-200 shadow-sm"
    }, React.createElement("div", {
      className: "text-xs text-slate-400 font-bold uppercase mb-1"
    }, "\u5E73\u5747\u6BCF\u5834\u4EBA\u6578"), React.createElement("div", {
      className: "text-2xl font-bold text-slate-800"
    }, avgPax, " ", React.createElement("span", {
      className: "text-sm font-normal text-slate-400"
    }, "\u4EBA"))), React.createElement("div", {
      className: "bg-white p-4 rounded-2xl border border-slate-200 shadow-sm"
    }, React.createElement("div", {
      className: "text-xs text-slate-400 font-bold uppercase mb-1"
    }, "\u5E73\u5747\u5BA2\u55AE\u50F9 (ARPU)"), React.createElement("div", {
      className: "text-2xl font-bold text-emerald-600"
    }, "$", avgArpu.toLocaleString())), React.createElement("div", {
      className: "bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow border-l-4 border-l-purple-500 relative group"
    }, React.createElement("div", {
      className: "text-xs text-slate-400 font-bold uppercase mb-1 flex justify-between items-center"
    }, React.createElement("span", null, "\u5BA2\u6236\u9ECF\u8457\u5EA6"), React.createElement("span", {
      className: "text-[10px] bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium",
      title: "\u6D88\u8CBB3\u6B21\u4EE5\u4E0A\u7684\u9AD8\u983B\u5BA2\u6BD4\u4F8B"
    }, "\u9435\u7C89: ", loyaltyMetrics.heavyRate, "%")), React.createElement("div", {
      className: "flex items-baseline gap-2 mt-1"
    }, React.createElement("div", {
      className: "text-2xl font-bold text-purple-600"
    }, loyaltyMetrics.rate, "%"), React.createElement("div", {
      className: "text-xs text-slate-400 font-medium"
    }, "(\u57FA\u6578: ", loyaltyMetrics.total, "\u4EBA)")))), React.createElement("div", {
      className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden table-container"
    }, React.createElement("div", {
      className: "p-4 bg-slate-50/50 border-b border-slate-100 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    }, React.createElement("span", {
      className: "text-xs font-bold text-slate-500 uppercase tracking-wider"
    }, dimensionLabels[dimension]), React.createElement("span", {
      className: "text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold"
    }, activityStats.length, " \u9805")), React.createElement("table", {
      className: "w-full text-left text-sm"
    }, React.createElement("thead", {
      className: "bg-slate-50 border-b border-slate-100 text-slate-500"
    }, React.createElement("tr", null, React.createElement("th", {
      className: "px-6 py-4 font-bold"
    }, "\u9805\u76EE\u540D\u7A31"), React.createElement("th", {
      className: "px-6 py-4 font-bold text-right"
    }, "\u8209\u8FA6\u5834\u6B21"), React.createElement("th", {
      className: "px-6 py-4 font-bold text-right"
    }, "\u7E3D\u4EBA\u6578"), React.createElement("th", {
      className: "px-6 py-4 font-bold text-right"
    }, "\u5E73\u5747\u4EBA\u6578"), React.createElement("th", {
      className: "px-6 py-4 font-bold text-right"
    }, "\u7E3D\u71DF\u6536"), React.createElement("th", {
      className: "px-6 py-4 font-bold text-right"
    }, "\u64CD\u4F5C"))), React.createElement("tbody", {
      className: "divide-y divide-slate-100"
    }, activityStats.map((stat, idx) => React.createElement("tr", {
      key: `${key}-${stat.name}`,
      className: "hover:bg-slate-50 transition-colors group"
    }, React.createElement("td", {
      className: "px-6 py-4 font-bold text-slate-700 flex items-center gap-2"
    }, React.createElement("span", {
      className: "w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs shrink-0"
    }, idx + 1), stat.name), React.createElement("td", {
      className: "px-6 py-4 text-right text-slate-600"
    }, stat.sessions), React.createElement("td", {
      className: "px-6 py-4 text-right text-slate-600"
    }, stat.pax), React.createElement("td", {
      className: "px-6 py-4 text-right"
    }, React.createElement("span", {
      className: `px-2 py-1 rounded text-xs font-bold ${Number(stat.avgPax) >= 15 ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`
    }, stat.avgPax)), React.createElement("td", {
      className: "px-6 py-4 text-right font-mono font-bold text-blue-600 bg-blue-50/30 group-hover:bg-blue-50/50"
    }, "$", stat.revenue.toLocaleString()), React.createElement("td", {
      className: "px-6 py-4 text-right"
    }, React.createElement("button", {
      onClick: () => handleItemAnalysis(stat, title),
      className: "text-xs bg-white border border-slate-200 text-slate-600 hover:text-blue-600 hover:border-blue-300 px-3 py-1 rounded-lg shadow-sm transition-all flex items-center gap-1 ml-auto"
    }, React.createElement(Icon, {
      name: "bar-chart-2",
      size: 14
    }), " \u6642\u9593\u5206\u6790")))), activityStats.length === 0 && React.createElement("tr", null, React.createElement("td", {
      colSpan: "6",
      className: "p-8 text-center text-slate-400"
    }, emptyText))))), React.createElement("div", {
      className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden table-container"
    }, React.createElement("div", {
      className: "p-4 bg-slate-50/50 border-b border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    }, React.createElement("div", null, React.createElement("div", {
      className: "text-xs font-bold text-slate-500 uppercase tracking-wider"
    }, "\u7522\u54C1\u6210\u6548\u8868"), React.createElement("div", {
      className: "text-sm text-slate-500 mt-1"
    }, productReportDescription)), React.createElement("button", {
      onClick: () => handleExportProductReport(exportFilePrefix, productReportSections),
      className: "bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 hover:bg-emerald-700 shadow-sm self-start sm:self-auto"
    }, React.createElement(Icon, {
      name: "download",
      size: 14
    }), " \u532F\u51FA\u7522\u54C1\u6210\u6548\u8868")), React.createElement("div", {
      className: "space-y-6 p-4"
    }, productReportSections.map(section => React.createElement("div", {
      key: `${key}-${section.value}`,
      className: "border border-slate-200 rounded-2xl overflow-hidden"
    }, React.createElement("div", {
      className: "px-4 py-3 bg-white border-b border-slate-100 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: "text-sm font-bold text-slate-800"
    }, section.label), React.createElement("span", {
      className: "text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-slate-600"
    }, section.rows.length, " \u9805")), React.createElement("div", {
      className: "flex flex-wrap gap-2 text-xs"
    }, React.createElement("span", {
      className: "px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100"
    }, "\u7E3D\u71DF\u6536 $", section.totalRevenue.toLocaleString()), React.createElement("span", {
      className: "px-2 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-100"
    }, "\u7E3D\u4EBA\u6578 ", section.totalPax, " \u4EBA"))), React.createElement("div", {
      className: "overflow-x-auto"
    }, React.createElement("table", {
      className: "w-full min-w-[1200px] text-sm"
    }, React.createElement("thead", {
      className: "bg-slate-50 border-b border-slate-100 text-slate-500"
    }, React.createElement("tr", null, React.createElement("th", {
      className: "px-4 py-3 text-left font-bold"
    }, "\u6D3B\u52D5\u540D\u7A31"), React.createElement("th", {
      className: "px-4 py-3 text-left font-bold"
    }, "\u7279\u6027"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u7E3D\u71DF\u6536"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u7E3D\u4EBA\u6578"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u7E3D\u5834\u6B21"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u5E73\u5747\u4EBA\u6578"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u6210\u672C\uFF08\u6BCF\u4EBA)"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u6210\u672C\uFF08\u6BCF\u5834\uFF09"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u5E73\u5747\u71DF\u6536"), React.createElement("th", {
      className: "px-4 py-3 text-right font-bold"
    }, "\u5E73\u5747\u6BDB\u5229"))), React.createElement("tbody", {
      className: "divide-y divide-slate-100 bg-white"
    }, section.rows.map(item => React.createElement("tr", {
      key: `${key}-${section.value}-${item.name}`,
      className: "hover:bg-slate-50"
    }, React.createElement("td", {
      className: "px-4 py-3 font-medium text-slate-700"
    }, item.name), React.createElement("td", {
      className: "px-4 py-3 text-slate-500"
    }, item.trait || '-'), React.createElement("td", {
      className: "px-4 py-3 text-right font-mono font-bold text-blue-600"
    }, "$", item.revenue.toLocaleString()), React.createElement("td", {
      className: "px-4 py-3 text-right font-bold text-slate-700"
    }, item.pax), React.createElement("td", {
      className: "px-4 py-3 text-right font-bold text-slate-700"
    }, item.sessionCount), React.createElement("td", {
      className: "px-4 py-3 text-right text-slate-600"
    }, item.avgPax), React.createElement("td", {
      className: "px-4 py-3 text-right text-slate-500"
    }, item.costPerPax === '' ? '-' : item.costPerPax), React.createElement("td", {
      className: "px-4 py-3 text-right text-slate-500"
    }, item.costPerSession === '' ? '-' : item.costPerSession), React.createElement("td", {
      className: "px-4 py-3 text-right font-mono text-slate-600"
    }, "$", item.avgRevenue.toLocaleString()), React.createElement("td", {
      className: "px-4 py-3 text-right font-mono font-bold text-emerald-600"
    }, "$", item.avgGrossProfit.toLocaleString()))), section.rows.length === 0 && React.createElement("tr", null, React.createElement("td", {
      colSpan: "10",
      className: "px-4 py-8 text-center text-slate-400"
    }, productReportEmptyText)))))))))));
  };
  return React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto space-y-8 pb-20"
  }, React.createElement("header", {
    className: "mb-2 flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
  }, React.createElement("div", null, React.createElement("h2", {
    className: "text-2xl font-bold text-slate-800"
  }, "\u6D3B\u52D5\u6210\u6548\u5206\u6790"), React.createElement("p", {
    className: "text-sm text-slate-500"
  }, "\u904E\u53BB\u8207\u672A\u4F86\u6D3B\u52D5\u5206\u958B\u5448\u73FE\uFF0C\u907F\u514D\u672A\u4F86\u5834\u6B21\u6DF7\u9032\u5DF2\u57F7\u884C\u6210\u6548\u3002")), React.createElement("div", {
    className: "flex flex-wrap items-center gap-2"
  }, React.createElement("button", {
    onClick: () => setShowProductSettings(prev => !prev),
    className: "bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 hover:bg-slate-50 shadow-sm"
  }, React.createElement(Icon, {
    name: "settings",
    size: 14
  }), " ", showProductSettings ? '收起分類設定' : '設定活動分類'), React.createElement("div", {
    className: "flex items-center gap-2 bg-white p-1 rounded-lg border border-slate-200 shadow-sm"
  }, React.createElement("span", {
    className: "text-xs font-bold text-slate-500 px-2"
  }, "\u5206\u6790\u7DAD\u5EA6:"), React.createElement("select", {
    className: "text-sm bg-slate-50 border-none rounded-md py-1.5 pl-2 pr-8 focus:ring-2 focus:ring-blue-500 outline-none font-bold text-slate-700 cursor-pointer",
    value: dimension,
    onChange: e => setDimension(e.target.value)
  }, React.createElement("option", {
    value: "category"
  }, "\u4F9D\u6D3B\u52D5\u6027\u8CEA (\u63A8\u85A6)"), React.createElement("option", {
    value: "name"
  }, "\u4F9D\u5F8C\u53F0\u540D\u7A31"), React.createElement("option", {
    value: "type"
  }, "\u4F9D\u7A2E\u985E\u6A19\u7C64 (\u5982: \u86C7\u985E\u3001\u591C\u9593)"), React.createElement("option", {
    value: "level"
  }, "\u4F9D\u7B49\u7D1A\u6A19\u7C64 (\u5982: \u5305\u5718\u3001\u89AA\u5B50)"), React.createElement("option", {
    value: "location"
  }, "\u4F9D\u5730\u9EDE\u6A19\u7C64"))))), showProductSettings && React.createElement("section", {
    className: "bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden"
  }, React.createElement("div", {
    className: "px-6 py-5 border-b border-slate-100 bg-slate-50/70"
  }, React.createElement("div", {
    className: "flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "text-lg font-bold text-slate-800"
  }, "\u7522\u54C1\u5206\u985E\u8A2D\u5B9A"), React.createElement("p", {
    className: "text-sm text-slate-500 mt-1"
  }, "\u5728\u9019\u88E1\u6307\u5B9A\u6BCF\u500B\u6D3B\u52D5\u5C6C\u65BC\u4E3B\u984C\u6D3B\u52D5\u3001\u4E0B\u73ED\u5F8C\u8D70\u8D70\u6216\u7279\u5225\u6D3B\u52D5\uFF0C\u4E26\u53EF\u586B\u5BEB\u7279\u6027\u3001\u6BCF\u4EBA\u6210\u672C\u3001\u6BCF\u5834\u6210\u672C\u3002")), React.createElement("div", {
    className: "flex items-center gap-2 text-xs"
  }, productSettingsSaveStatus === 'saving' && React.createElement("span", {
    className: "text-blue-600 font-bold"
  }, "\u5132\u5B58\u4E2D..."), productSettingsSaveStatus === 'success' && React.createElement("span", {
    className: "text-emerald-600 font-bold"
  }, "\u5DF2\u5132\u5B58"), productSettingsSaveStatus === 'error' && React.createElement("span", {
    className: "text-rose-600 font-bold"
  }, "\u5132\u5B58\u5931\u6557"), React.createElement("button", {
    onClick: handleSaveProductSettings,
    className: "bg-slate-800 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-slate-700 shadow-sm"
  }, "\u5132\u5B58\u5206\u985E\u8A2D\u5B9A")))), React.createElement("div", {
    className: "p-6 table-container"
  }, React.createElement("div", {
    className: "overflow-x-auto border border-slate-200 rounded-2xl"
  }, React.createElement("table", {
    className: "w-full min-w-[980px] text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-4 py-3 text-left font-bold"
  }, "\u6D3B\u52D5\u540D\u7A31"), React.createElement("th", {
    className: "px-4 py-3 text-left font-bold"
  }, "\u5206\u985E"), React.createElement("th", {
    className: "px-4 py-3 text-left font-bold"
  }, "\u7279\u6027"), React.createElement("th", {
    className: "px-4 py-3 text-left font-bold"
  }, "\u6210\u672C\uFF08\u6BCF\u4EBA)"), React.createElement("th", {
    className: "px-4 py-3 text-left font-bold"
  }, "\u6210\u672C\uFF08\u6BCF\u5834\uFF09"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100 bg-white"
  }, productNames.map(name => React.createElement("tr", {
    key: name,
    className: "hover:bg-slate-50"
  }, React.createElement("td", {
    className: "px-4 py-3 font-medium text-slate-700"
  }, name), React.createElement("td", {
    className: "px-4 py-3"
  }, React.createElement("select", {
    className: "w-full px-3 py-2 border border-slate-300 rounded-lg bg-white outline-none focus:ring-2 focus:ring-blue-500",
    value: productSettingsDraft[name]?.bucket || inferPerformanceBucket(name),
    onChange: e => handleProductSettingChange(name, 'bucket', e.target.value)
  }, PERFORMANCE_BUCKET_OPTIONS.map(option => React.createElement("option", {
    key: option.value,
    value: option.value
  }, option.label)))), React.createElement("td", {
    className: "px-4 py-3"
  }, React.createElement("input", {
    type: "text",
    className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "\u4F8B\u5982\uFF1A\u590F\u5B63\u9650\u5B9A\u3001\u5916\u5305\u8B1B\u5E2B",
    value: productSettingsDraft[name]?.trait || '',
    onChange: e => handleProductSettingChange(name, 'trait', e.target.value)
  })), React.createElement("td", {
    className: "px-4 py-3"
  }, React.createElement("input", {
    type: "number",
    className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "\u4F8B\u5982\uFF1A100",
    value: productSettingsDraft[name]?.costPerPax ?? '',
    onChange: e => handleProductSettingChange(name, 'costPerPax', e.target.value)
  })), React.createElement("td", {
    className: "px-4 py-3"
  }, React.createElement("input", {
    type: "number",
    className: "w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "\u4F8B\u5982\uFF1A800",
    value: productSettingsDraft[name]?.costPerSession ?? '',
    onChange: e => handleProductSettingChange(name, 'costPerSession', e.target.value)
  })))), productNames.length === 0 && React.createElement("tr", null, React.createElement("td", {
    colSpan: "5",
    className: "px-4 py-10 text-center text-slate-400"
  }, "\u76EE\u524D\u9084\u6C92\u6709\u53EF\u8A2D\u5B9A\u7684\u6D3B\u52D5\u8CC7\u6599"))))))), renderSection({
    key: 'past',
    title: '已執行活動成效',
    description: '這一區只統計過去活動，適合看真實成效表現。',
    badgeTone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    rows: segmentedRows.past,
    activityStats: pastActivityStats,
    loyaltyMetrics: pastLoyaltyMetrics,
    emptyText: '目前沒有可分析的已執行活動資料',
    globalAnalysisTitle: '已執行活動總體分析',
    productReportSections: pastProductReportSections,
    productReportDescription: '格式參考你提供的損益表，這裡只採用已執行活動資料，並固定拆成三種活動類型。',
    productReportEmptyText: '目前沒有這一類的已執行活動資料',
    exportFilePrefix: '已執行產品成效表'
  }), renderSection({
    key: 'future',
    title: '未來活動預覽',
    description: '未來活動獨立收在這裡，方便看預售與排程，但不納入已執行成效。',
    badgeTone: 'border-amber-200 bg-amber-50 text-amber-700',
    rows: segmentedRows.future,
    activityStats: futureActivityStats,
    loyaltyMetrics: futureLoyaltyMetrics,
    emptyText: '目前沒有未來活動資料',
    globalAnalysisTitle: '未來活動總體分析',
    productReportSections: futureProductReportSections,
    productReportDescription: '這裡用未來活動目前的報名與營收資料，方便你先看不同產品類型的預售狀況。',
    productReportEmptyText: '目前沒有這一類的未來活動資料',
    exportFilePrefix: '未來活動產品成效表'
  }), analysisData && React.createElement(TimeAnalysisModal, {
    title: analysisData.title,
    data: analysisData.data,
    onClose: () => setAnalysisData(null)
  }));
};
const EnrollmentMonitor = ({
  stats,
  eventConfigs,
  tagDefinitions
}) => {
  const [filters, setFilters] = useState({
    level: '',
    type: '',
    location: ''
  });
  const [sortBy, setSortBy] = useState('date');
  const getDefaultRangeEndDate = () => {
    const endDate = parseLocalDateKey(getLocalDateStr());
    endDate.setDate(endDate.getDate() + 30);
    return formatLocalDateKey(endDate);
  };
  const [rangeStartDate, setRangeStartDate] = useState(getLocalDateStr);
  const [rangeEndDate, setRangeEndDate] = useState(getDefaultRangeEndDate);
  const processedEvents = useMemo(() => {
    const startDate = String(rangeStartDate || '').trim();
    const endDate = String(rangeEndDate || '').trim();
    const customerVisitDateMap = {};
    Object.values(stats.events || {}).forEach(eventItem => {
      const eventDate = String(eventItem?.date || '').trim();
      (Array.isArray(eventItem?.customers) ? eventItem.customers : []).forEach(customer => {
        const customerName = String(customer?.customerName || '').trim();
        if (!customerName || customerName === '開放報名中' || !eventDate) return;
        if (!customerVisitDateMap[customerName]) customerVisitDateMap[customerName] = new Set();
        customerVisitDateMap[customerName].add(eventDate);
      });
    });
    return Object.values(stats.events || {}).map(e => {
      const cfg = (eventConfigs || {})[e.key] || {};
      const capacity = parseInt(cfg.capacity) || 12;
      const rate = Math.min(e.count / capacity * 100, 100);
      const tags = cfg.tags || {
        levels: '',
        types: '',
        locations: ''
      };
      const isFull = e.count >= capacity;
      const bookedCustomers = (Array.isArray(e.customers) ? e.customers : []).filter(customer => {
        const customerName = String(customer?.customerName || '').trim();
        return customerName && customerName !== '開放報名中';
      });
      const returningCustomerCount = bookedCustomers.reduce((sum, customer) => {
        const customerName = String(customer?.customerName || '').trim();
        const historyDates = Array.from(customerVisitDateMap[customerName] || []);
        return historyDates.some(date => date < e.date) ? sum + 1 : sum;
      }, 0);
      const newCustomerCount = Math.max(bookedCustomers.length - returningCustomerCount, 0);
      const newCustomerRate = bookedCustomers.length > 0 ? Math.round(newCustomerCount / bookedCustomers.length * 100) : 0;
      const returningCustomerRate = bookedCustomers.length > 0 ? 100 - newCustomerRate : 0;
      return {
        ...e,
        capacity,
        rate,
        tags,
        isFull,
        cfg,
        newCustomerCount,
        returningCustomerCount,
        newCustomerRate,
        returningCustomerRate
      };
    }).filter(e => {
      if (startDate && e.date < startDate) return false;
      if (endDate && e.date > endDate) return false;
      if (filters.level && e.tags.levels !== filters.level) return false;
      if (filters.type && e.tags.types !== filters.type) return false;
      if (filters.location && e.tags.locations !== filters.location) return false;
      return true;
    }).sort((a, b) => {
      if (sortBy === 'rate') return b.rate - a.rate;
      return new Date(a.date) - new Date(b.date);
    });
  }, [stats, eventConfigs, filters, sortBy, rangeStartDate, rangeEndDate]);
  const getProgressColor = (rate, isFull) => {
    if (isFull || rate >= 100) return 'bg-red-500';
    if (rate >= 80) return 'bg-orange-500';
    if (rate >= 50) return 'bg-blue-500';
    return 'bg-emerald-500';
  };
  const exportEnrollmentRange = () => {
    const startLabel = rangeStartDate || '不限開始';
    const endLabel = rangeEndDate || '不限結束';
    const headers = ['日期', '活動名稱', '講師', '活動等級', '活動種類', '活動地點', '報名人數', '人數上限', '報名率', '狀態', '新客人數', '舊客人數', '新客比例', '舊客比例', '共乘人數', '自行前往人數', '未定交通', '報名者摘要'];
    const rows = processedEvents.map(eventItem => {
      const bookedCustomers = (Array.isArray(eventItem.customers) ? eventItem.customers : []).filter(customer => {
        const customerName = String(customer?.customerName || '').trim();
        return customerName && customerName !== '開放報名中';
      });
      const carpoolCount = bookedCustomers.filter(customer => String(customer?.transport || '').trim() === '共乘').length;
      const selfTransportCount = bookedCustomers.filter(customer => String(customer?.transport || '').trim() === '自行前往').length;
      const unsetTransportCount = Math.max(bookedCustomers.length - carpoolCount - selfTransportCount, 0);
      const customerSummary = bookedCustomers.map(customer => {
        const name = toSafeDisplayText(customer.customerName, '未命名');
        const transport = toSafeDisplayText(customer.transport, '未定');
        return `${name}(${transport})`;
      }).join('、');
      return [toSafeDisplayText(eventItem.date, ''), toSafeDisplayText(eventItem.cfg?.displayName, toSafeDisplayText(eventItem.eventName, '未命名活動')), toSafeDisplayText(eventItem.instructor, '未定'), toSafeDisplayText(eventItem.tags?.levels, ''), toSafeDisplayText(eventItem.tags?.types, ''), toSafeDisplayText(eventItem.tags?.locations, ''), eventItem.count || 0, eventItem.capacity || 0, `${Math.round(eventItem.rate || 0)}%`, eventItem.isFull ? '額滿' : '可報名', eventItem.newCustomerCount || 0, eventItem.returningCustomerCount || 0, `${eventItem.newCustomerRate || 0}%`, `${eventItem.returningCustomerRate || 0}%`, carpoolCount, selfTransportCount, unsetTransportCount, customerSummary];
    });
    const csvContent = [headers, ...rows].map(row => row.map(value => toCSVField(value === 0 ? '0' : value ?? '')).join(',')).join('\n');
    downloadCSV(csvContent, `報名監控_${sanitizeFilename(startLabel)}_${sanitizeFilename(endLabel)}.csv`);
  };
  return React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto space-y-6 pb-20"
  }, React.createElement("header", {
    className: "flex flex-col md:flex-row justify-between items-center gap-4"
  }, React.createElement("div", null, React.createElement("h2", {
    className: "text-2xl font-bold text-slate-800"
  }, "\u5831\u540D\u76E3\u63A7\u4E2D\u5FC3"), React.createElement("p", {
    className: "text-sm text-slate-500"
  }, "\u5373\u6642\u638C\u63E1\u5404\u5834\u6B21\u5831\u540D\u7387\u8207\u5269\u9918\u540D\u984D")), React.createElement("div", {
    className: "flex bg-slate-100 p-1 rounded-lg"
  }, React.createElement("button", {
    onClick: () => setSortBy('date'),
    className: `px-4 py-1.5 rounded-md text-sm font-bold transition-all ${sortBy === 'date' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`
  }, "\u4F9D\u65E5\u671F\u6392\u5E8F"), React.createElement("button", {
    onClick: () => setSortBy('rate'),
    className: `px-4 py-1.5 rounded-md text-sm font-bold transition-all ${sortBy === 'rate' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`
  }, "\u4F9D\u71B1\u9580\u5EA6\u6392\u5E8F"))), React.createElement("div", {
    className: "bg-white p-4 rounded-2xl shadow-sm border border-slate-200"
  }, React.createElement("div", {
    className: "flex items-center gap-2 mb-3"
  }, React.createElement(Icon, {
    name: "filter",
    size: 18,
    className: "text-blue-600"
  }), React.createElement("span", {
    className: "font-bold text-slate-700"
  }, "\u6A19\u7C64\u7BE9\u9078"), (filters.level || filters.type || filters.location) && React.createElement("button", {
    onClick: () => setFilters({
      level: '',
      type: '',
      location: ''
    }),
    className: "text-xs text-red-500 hover:bg-red-50 px-2 py-1 rounded ml-auto flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  }), " \u6E05\u9664\u7BE9\u9078")), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-400 mb-1 block"
  }, "\u6D3B\u52D5\u7B49\u7D1A"), React.createElement("select", {
    className: "w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500",
    value: filters.level,
    onChange: e => setFilters({
      ...filters,
      level: e.target.value
    })
  }, React.createElement("option", {
    value: ""
  }, "\u5168\u90E8\u7B49\u7D1A"), (tagDefinitions.levels || []).map(t => {
    const safeTag = toSafeDisplayText(t, '').trim();
    return safeTag ? React.createElement("option", {
      key: safeTag,
      value: safeTag
    }, safeTag) : null;
  }))), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-400 mb-1 block"
  }, "\u6D3B\u52D5\u7A2E\u985E"), React.createElement("select", {
    className: "w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-emerald-500",
    value: filters.type,
    onChange: e => setFilters({
      ...filters,
      type: e.target.value
    })
  }, React.createElement("option", {
    value: ""
  }, "\u5168\u90E8\u7A2E\u985E"), (tagDefinitions.types || []).map(t => {
    const safeTag = toSafeDisplayText(t, '').trim();
    return safeTag ? React.createElement("option", {
      key: safeTag,
      value: safeTag
    }, safeTag) : null;
  }))), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-400 mb-1 block"
  }, "\u6D3B\u52D5\u5730\u9EDE"), React.createElement("select", {
    className: "w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-purple-500",
    value: filters.location,
    onChange: e => setFilters({
      ...filters,
      location: e.target.value
    })
  }, React.createElement("option", {
    value: ""
  }, "\u5168\u90E8\u5730\u9EDE"), (tagDefinitions.locations || []).map(t => {
    const safeTag = toSafeDisplayText(t, '').trim();
    return safeTag ? React.createElement("option", {
      key: safeTag,
      value: safeTag
    }, safeTag) : null;
  }))))), React.createElement("div", {
    className: "bg-white p-4 rounded-2xl shadow-sm border border-slate-200"
  }, React.createElement("div", {
    className: "flex flex-col lg:flex-row lg:items-end gap-4"
  }, React.createElement("div", {
    className: "flex-1"
  }, React.createElement("div", {
    className: "flex items-center gap-2 mb-3"
  }, React.createElement(Icon, {
    name: "download",
    size: 18,
    className: "text-emerald-600"
  }), React.createElement("span", {
    className: "font-bold text-slate-700"
  }, "\u7BC4\u570D\u532F\u51FA"), React.createElement("span", {
    className: "text-xs text-slate-400"
  }, "\u76EE\u524D\u7BC4\u570D ", processedEvents.length, " \u5834")), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("label", {
    className: "block"
  }, React.createElement("span", {
    className: "text-xs font-bold text-slate-400 mb-1 block"
  }, "\u958B\u59CB\u65E5\u671F"), React.createElement("input", {
    type: "date",
    value: rangeStartDate,
    onChange: event => setRangeStartDate(event.target.value),
    className: "w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-emerald-500"
  })), React.createElement("label", {
    className: "block"
  }, React.createElement("span", {
    className: "text-xs font-bold text-slate-400 mb-1 block"
  }, "\u7D50\u675F\u65E5\u671F"), React.createElement("input", {
    type: "date",
    value: rangeEndDate,
    onChange: event => setRangeEndDate(event.target.value),
    className: "w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-emerald-500"
  })))), React.createElement("button", {
    onClick: exportEnrollmentRange,
    disabled: processedEvents.length === 0,
    className: `px-5 py-2.5 rounded-xl font-bold shadow-sm flex items-center justify-center gap-2 transition-all ${processedEvents.length === 0 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700 hover:shadow'}`
  }, React.createElement(Icon, {
    name: "download",
    size: 18
  }), "\u532F\u51FA\u5831\u540D\u72C0\u6CC1"))), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
  }, processedEvents.map((e, idx) => {
    const safeEventDate = toSafeDisplayText(e.date, '');
    const safeEventName = toSafeDisplayText(e.cfg?.displayName, toSafeDisplayText(e.eventName, '未命名活動'));
    const safeInstructor = toSafeDisplayText(e.instructor, '未定');
    const safeLocationTag = toSafeDisplayText(e.tags?.locations, '');
    const safeLevelTag = toSafeDisplayText(e.tags?.levels, '');
    const safeTypeTag = toSafeDisplayText(e.tags?.types, '');
    return React.createElement("div", {
      key: idx,
      className: "bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all p-4 relative overflow-hidden group"
    }, React.createElement("div", {
      className: "flex justify-between items-start mb-2"
    }, React.createElement("span", {
      className: "text-xs font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded"
    }, safeEventDate), React.createElement("div", {
      className: "flex gap-1"
    }, e.isFull && React.createElement("span", {
      className: "text-[10px] font-bold bg-red-100 text-red-600 px-1.5 py-0.5 rounded"
    }, "\u984D\u6EFF"), safeLocationTag && React.createElement("span", {
      className: "text-[10px] font-bold bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded border border-purple-100"
    }, safeLocationTag))), React.createElement("h3", {
      className: "font-bold text-slate-800 mb-1 truncate",
      title: safeEventName
    }, safeEventName), React.createElement("div", {
      className: "text-xs text-slate-500 mb-4 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "user",
      size: 12
    }), " ", safeInstructor), React.createElement("div", {
      className: "mb-2"
    }, React.createElement("div", {
      className: "flex justify-between text-xs mb-1"
    }, React.createElement("span", {
      className: `font-bold ${e.isFull ? 'text-red-600' : 'text-slate-700'}`
    }, e.count, " ", React.createElement("span", {
      className: "text-slate-400 font-normal"
    }, "/ ", e.capacity)), React.createElement("span", {
      className: "font-bold text-slate-600"
    }, Math.round(e.rate), "%")), React.createElement("div", {
      className: "w-full h-2.5 bg-slate-100 rounded-full overflow-hidden"
    }, React.createElement("div", {
      className: `h-full rounded-full transition-all duration-500 ${getProgressColor(e.rate, e.isFull)}`,
      style: {
        width: `${e.rate}%`
      }
    }))), React.createElement("div", {
      className: "mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
    }, React.createElement("div", {
      className: "flex items-center justify-between text-[11px] font-bold text-slate-500"
    }, React.createElement("span", null, "\u65B0\u5BA2 ", e.newCustomerCount, " \u4EBA"), React.createElement("span", null, "\u820A\u5BA2 ", e.returningCustomerCount, " \u4EBA")), React.createElement("div", {
      className: "mt-1 text-[10px] text-slate-400"
    }, "\u65B0\u5BA2 ", e.newCustomerRate, "% / \u820A\u5BA2 ", e.returningCustomerRate, "%")), React.createElement("div", {
      className: "flex flex-wrap gap-1 mt-3 pt-3 border-t border-slate-50"
    }, safeLevelTag && React.createElement("span", {
      className: "text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded"
    }, safeLevelTag), safeTypeTag && React.createElement("span", {
      className: "text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded"
    }, safeTypeTag), !safeLevelTag && !safeTypeTag && React.createElement("span", {
      className: "text-[10px] text-slate-300 italic"
    }, "\u7121\u6A19\u7C64")));
  })), processedEvents.length === 0 && React.createElement("div", {
    className: "text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200"
  }, React.createElement("div", {
    className: "text-4xl mb-2"
  }, "\uD83D\uDD0D"), React.createElement("p", {
    className: "text-slate-500"
  }, "\u6C92\u6709\u7B26\u5408\u7BE9\u9078\u689D\u4EF6\u6216\u65E5\u671F\u7BC4\u570D\u7684\u6D3B\u52D5")));
};
const EditRowModal = ({
  rowData,
  onClose,
  onSave,
  onDelete,
  existingTransports,
  availableEvents = []
}) => {
  const [form, setForm] = useState({
    ...rowData
  });
  const getInitialEventCalendarMonth = () => {
    const parsed = form.date ? new Date(`${form.date}T00:00:00`) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  };
  const [eventCalendarMonth, setEventCalendarMonth] = useState(getInitialEventCalendarMonth);
  const [selectedEventDate, setSelectedEventDate] = useState(form.date || '');
  const selectableEventsByDate = useMemo(() => {
    const sourceEvents = Array.isArray(availableEvents) ? availableEvents : Object.values(availableEvents || {});
    const map = {};
    sourceEvents.forEach(evt => {
      const dateKey = String(evt?.date || '').trim();
      const eventName = String(evt?.eventName || '').trim();
      if (!dateKey || !eventName) return;
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push(evt);
    });
    Object.values(map).forEach(items => {
      items.sort((a, b) => String(a.time || a.config?.time || '').localeCompare(String(b.time || b.config?.time || '')) || String(a.eventName || '').localeCompare(String(b.eventName || ''), 'zh-Hant') || String(a.instructor || '').localeCompare(String(b.instructor || ''), 'zh-Hant'));
    });
    return map;
  }, [availableEvents]);
  const selectedDateEvents = selectableEventsByDate[selectedEventDate] || [];
  const transportOptions = useMemo(() => {
    const options = ['', '共乘', '自行前往', ...(Array.isArray(existingTransports) ? existingTransports : [])];
    return Array.from(new Set(options.map(value => String(value || '').trim()))).filter((value, index) => value || index === 0);
  }, [existingTransports]);
  const handleSelectTargetEvent = evt => {
    setSelectedEventDate(evt.date || selectedEventDate);
    setForm(prev => ({
      ...prev,
      date: evt.date || prev.date,
      eventName: evt.eventName || prev.eventName,
      instructor: evt.instructor || prev.instructor
    }));
  };
  const renderTargetEventCalendar = () => {
    const year = eventCalendarMonth.getFullYear();
    const month = eventCalendarMonth.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    const days = [...Array(firstDay).fill(null), ...Array.from({
      length: daysInMonth
    }, (_, i) => i + 1)];
    return React.createElement("div", {
      className: "rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3"
    }, React.createElement("div", {
      className: "flex items-center justify-between"
    }, React.createElement("button", {
      type: "button",
      className: "w-8 h-8 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-100",
      onClick: () => setEventCalendarMonth(new Date(year, month - 1, 1))
    }, React.createElement(Icon, {
      name: "chevron-left",
      size: 16
    })), React.createElement("div", {
      className: "font-bold text-slate-800"
    }, year, "\u5E74 ", month + 1, "\u6708"), React.createElement("button", {
      type: "button",
      className: "w-8 h-8 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-100",
      onClick: () => setEventCalendarMonth(new Date(year, month + 1, 1))
    }, React.createElement(Icon, {
      name: "chevron-right",
      size: 16
    }))), React.createElement("div", {
      className: "grid grid-cols-7 text-center text-[11px] font-bold text-slate-400"
    }, ['日', '一', '二', '三', '四', '五', '六'].map(day => React.createElement("div", {
      key: day
    }, day))), React.createElement("div", {
      className: "grid grid-cols-7 gap-1"
    }, days.map((day, idx) => {
      if (!day) return React.createElement("div", {
        key: `empty-${idx}`,
        className: "min-h-10"
      });
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dateEvents = selectableEventsByDate[dateStr] || [];
      const isSelected = selectedEventDate === dateStr;
      const isCurrent = form.date === dateStr;
      return React.createElement("button", {
        key: dateStr,
        type: "button",
        disabled: dateEvents.length === 0,
        onClick: () => setSelectedEventDate(dateStr),
        className: `min-h-10 rounded-lg border text-xs flex flex-col items-center justify-center transition-all ${isSelected ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : isCurrent ? 'bg-blue-50 border-blue-300 text-blue-700' : dateEvents.length > 0 ? 'bg-white border-slate-200 text-slate-700 hover:border-blue-300 hover:bg-blue-50' : 'bg-slate-100 border-transparent text-slate-300 cursor-not-allowed'}`
      }, React.createElement("span", {
        className: "font-bold leading-none"
      }, day), dateEvents.length > 0 && React.createElement("span", {
        className: `mt-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${isSelected ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-700'}`
      }, dateEvents.length, "\u5834"));
    })), React.createElement("div", {
      className: "rounded-lg border border-slate-200 bg-white p-3"
    }, React.createElement("div", {
      className: "flex items-center justify-between gap-2 mb-2"
    }, React.createElement("div", {
      className: "text-xs font-bold text-slate-500"
    }, selectedEventDate || "\u5148\u9078\u64C7\u65E5\u671F"), form.date && React.createElement("div", {
      className: "text-[11px] text-blue-600 font-bold"
    }, "\u76EE\u524D\uFF1A", form.date, " \u00B7 ", form.eventName || "\u672A\u547D\u540D")), selectedEventDate ? selectedDateEvents.length > 0 ? React.createElement("div", {
      className: "space-y-2"
    }, selectedDateEvents.map((evt, idx) => {
      const isPicked = form.date === evt.date && form.eventName === evt.eventName && String(form.instructor || '') === String(evt.instructor || '');
      const capacityText = Number.isFinite(Number(evt.capacity)) ? `${evt.count || 0}/${evt.capacity}\u4EBA` : `${evt.count || 0}\u4EBA`;
      return React.createElement("button", {
        key: evt.key || `${evt.date}-${evt.eventName}-${evt.instructor}-${idx}`,
        type: "button",
        onClick: () => handleSelectTargetEvent(evt),
        className: `w-full text-left rounded-lg border p-2 transition-all ${isPicked ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50'}`
      }, React.createElement("div", {
        className: "flex items-start justify-between gap-2"
      }, React.createElement("div", {
        className: "min-w-0"
      }, React.createElement("div", {
        className: "font-bold text-sm text-slate-800 truncate"
      }, evt.eventName || "\u672A\u547D\u540D\u6D3B\u52D5"), React.createElement("div", {
        className: "text-xs text-slate-500 mt-0.5"
      }, evt.instructor ? `@${evt.instructor}` : "\u672A\u6307\u5B9A\u8B1B\u5E2B")), React.createElement("span", {
        className: "text-[11px] font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-1 flex-shrink-0"
      }, capacityText)));
    })) : React.createElement("div", {
      className: "text-sm text-slate-400 py-3 text-center"
    }, "\u9019\u5929\u6C92\u6709\u53EF\u9078\u5834\u6B21") : React.createElement("div", {
      className: "text-sm text-slate-400 py-3 text-center"
    }, "\u8ACB\u5148\u5728\u6708\u66C6\u4E0A\u9078\u64C7\u65E5\u671F")));
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-lg p-6 shadow-2xl"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, React.createElement("h3", {
    className: "text-xl font-bold"
  }, "\u7DE8\u8F2F\u5831\u540D\u8CC7\u6599"), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "space-y-4 max-h-[70vh] overflow-y-auto p-1"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold block mb-2"
  }, "\u5831\u540D\u5834\u6B21"), renderTargetEventCalendar()), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u5BA2\u6236\u59D3\u540D"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded",
    value: form.customerName,
    onChange: e => setForm({
      ...form,
      customerName: e.target.value
    })
  })), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u91D1\u984D"), React.createElement("input", {
    type: "number",
    className: "w-full p-2 border rounded",
    value: form.price,
    onChange: e => setForm({
      ...form,
      price: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold mb-1.5 block"
  }, "\u4EA4\u901A"), React.createElement("select", {
    className: `w-full p-2 border rounded outline-none focus:ring-2 focus:ring-orange-400 ${form.transport === '共乘' ? 'bg-orange-50 border-orange-300 text-orange-700 font-bold' : 'bg-white border-slate-300 text-slate-600'}`,
    value: String(form.transport || '').trim(),
    onChange: e => setForm({
      ...form,
      transport: e.target.value
    })
  }, transportOptions.map(option => React.createElement("option", {
    key: option || 'unset',
    value: option
  }, option || "\u672A\u5B9A"))), React.createElement("div", {
    className: "flex flex-wrap gap-1.5 mt-2"
  }, ['共乘', '自行前往', ''].map(option => React.createElement("button", {
    key: option || 'unset-button',
    type: "button",
    onClick: () => setForm({
      ...form,
      transport: option
    }),
    className: `px-2 py-1 rounded-full border text-[11px] font-bold transition ${String(form.transport || '').trim() === option ? option === '共乘' ? 'bg-orange-500 border-orange-500 text-white' : 'bg-slate-700 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`
  }, option || "\u672A\u5B9A"))))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "Email"), React.createElement("input", {
    type: "email",
    className: "w-full p-2 border rounded",
    value: form.email || '',
    onChange: e => setForm({
      ...form,
      email: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u624B\u6A5F"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded",
    value: form.phone || '',
    onChange: e => setForm({
      ...form,
      phone: e.target.value
    })
  }))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u8A02\u8CFC\u65E5"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded",
    value: form.orderDate || '',
    onChange: e => setForm({
      ...form,
      orderDate: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u8EAB\u5206\u8B49"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded",
    value: form.idNo || '',
    onChange: e => setForm({
      ...form,
      idNo: e.target.value
    })
  }))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u751F\u65E5"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded",
    value: form.birthday || '',
    onChange: e => setForm({
      ...form,
      birthday: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u793E\u7FA4\u66B1\u7A31"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded",
    value: form.socialName || '',
    onChange: e => setForm({
      ...form,
      socialName: e.target.value
    })
  }))), React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u5831\u540D\u7BA1\u9053"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded",
    value: form.source || '',
    onChange: e => setForm({
      ...form,
      source: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold"
  }, "\u5099\u8A3B"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded",
    value: form.notes || '',
    onChange: e => setForm({
      ...form,
      notes: e.target.value
    })
  })))), React.createElement("div", {
    className: "flex justify-between mt-6 pt-4 border-t border-slate-100"
  }, React.createElement("button", {
    onClick: () => onDelete(rowData.id),
    className: "px-4 py-2 text-red-500 hover:bg-red-50 rounded-lg flex items-center gap-1 font-bold text-xs"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  }), " \u522A\u9664\u8CC7\u6599"), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => onSave({
      ...form,
      transport: String(form.transport || '').trim()
    }),
    className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-md"
  }, "\u5132\u5B58\u8B8A\u66F4")))));
};
const BulkImportModal = ({
  onClose,
  onImport,
  existingData
}) => {
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4 fade-in backdrop-blur-sm"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-2xl h-[85vh] flex flex-col shadow-2xl"
  }, React.createElement("div", {
    className: "p-6 border-b flex justify-between items-center"
  }, React.createElement("h3", {
    className: "text-xl font-bold"
  }, "\u6279\u91CF\u532F\u5165\u529F\u80FD\u958B\u767C\u4E2D..."), React.createElement("button", {
    onClick: onClose
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "p-8 text-center text-slate-500"
  }, "\u6B64\u529F\u80FD\u5373\u5C07\u63A8\u51FA\uFF0C\u656C\u8ACB\u671F\u5F85")));
};
const DataRescueTab = ({
  currentAppId,
  onSwitch
}) => {
  const options = [{
    id: 'crm-system-v1',
    label: 'v1 (您的真實資料)'
  }, {
    id: 'default-app-id',
    label: 'Default (舊版測試)'
  }];
  return React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-orange-200"
  }, " ", React.createElement("div", {
    className: "flex items-start gap-4"
  }, " ", React.createElement("div", {
    className: "bg-orange-100 p-3 rounded-full text-orange-600"
  }, React.createElement(Icon, {
    name: "life-buoy",
    size: 24
  })), " ", React.createElement("div", {
    className: "flex-1"
  }, " ", React.createElement("h3", {
    className: "text-xl font-bold text-slate-800 mb-2"
  }, "\u8CC7\u6599\u5EAB\u6551\u63F4\u63A7\u5236\u53F0"), " ", React.createElement("p", {
    className: "text-sm text-slate-500 mb-4"
  }, "\u5982\u679C\u60A8\u767C\u73FE\u8CC7\u6599\u907A\u5931\uFF0C\u8ACB\u5617\u8A66\u5207\u63DB\u4E0B\u65B9\u7684\u8CC7\u6599\u4F86\u6E90\u3002\u9019\u901A\u5E38\u767C\u751F\u5728\u7CFB\u7D71\u66F4\u65B0\u5F8C\u3002"), " ", React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-4"
  }, " ", options.map(opt => React.createElement("div", {
    key: opt.id,
    onClick: () => onSwitch(opt.id),
    className: `p-4 rounded-xl border cursor-pointer transition-all flex justify-between items-center ${currentAppId === opt.id ? 'bg-orange-50 border-orange-400 ring-1 ring-orange-400' : 'hover:bg-slate-50 border-slate-200'}`
  }, " ", React.createElement("div", null, " ", React.createElement("div", {
    className: "font-bold text-slate-700"
  }, opt.label), " ", React.createElement("div", {
    className: "text-xs text-slate-400 font-mono"
  }, opt.id), " "), " ", currentAppId === opt.id && React.createElement(Icon, {
    name: "check-circle",
    className: "text-orange-500",
    size: 20
  }), " ")), " "), " "), " "), " ");
};
const ProjectDetailModal = ({
  project,
  onClose,
  onUpdate,
  onDelete
}) => {
  const [editName, setEditName] = useState(project.name || '');
  const [editLink, setEditLink] = useState(project.cloudLink || '');
  const [editStatus, setEditStatus] = useState(project.status || 'To Do');
  const [editStakeholders, setEditStakeholders] = useState(project.stakeholders || '');
  const [metrics, setMetrics] = useState(project.metrics || []);
  const [newMetric, setNewMetric] = useState({
    name: '',
    target: '',
    current: 0,
    unit: ''
  });
  const [showMetricForm, setShowMetricForm] = useState(false);
  const [phases, setPhases] = useState(() => {
    if (project.phases && project.phases.length > 0) return project.phases;
    if (project.subTasks && project.subTasks.length > 0) {
      return [{
        id: 'phase_default',
        name: '第一階段：啟動',
        tasks: project.subTasks
      }];
    }
    return [{
      id: 'phase_1',
      name: '第一階段：規劃',
      tasks: []
    }];
  });
  const [newTask, setNewTask] = useState({
    title: '',
    assignee: '',
    dueDate: '',
    kpiName: '',
    kpiTarget: '',
    kpiUnit: ''
  });
  const [addingToPhaseId, setAddingToPhaseId] = useState(null);
  const [editingTaskInfo, setEditingTaskInfo] = useState(null);
  const totalTasks = phases.reduce((acc, p) => acc + p.tasks.length, 0);
  const completedTasks = phases.reduce((acc, p) => acc + p.tasks.filter(t => t.completed).length, 0);
  const metricsProgress = metrics.length > 0 ? metrics.reduce((acc, m) => acc + Math.min(m.current / m.target, 1), 0) / metrics.length : 0;
  const taskProgress = totalTasks > 0 ? completedTasks / totalTasks : 0;
  const xp = Math.round((taskProgress * 0.6 + metricsProgress * 0.4) * 100);
  const level = Math.floor(xp / 20) + 1;
  const addMetric = () => {
    if (!newMetric.name || !newMetric.target) return alert("請輸入目標名稱與數值");
    setMetrics([...metrics, {
      ...newMetric,
      id: Date.now(),
      target: Number(newMetric.target),
      current: 0
    }]);
    setNewMetric({
      name: '',
      target: '',
      current: 0,
      unit: ''
    });
    setShowMetricForm(false);
  };
  const updateMetricCurrent = (id, val) => {
    setMetrics(metrics.map(m => m.id === id ? {
      ...m,
      current: Number(val)
    } : m));
  };
  const deleteMetric = id => {
    if (confirm("刪除此目標？")) setMetrics(metrics.filter(m => m.id !== id));
  };
  const addPhase = () => {
    const name = prompt("輸入新階段名稱 (例如：執行期):");
    if (name) setPhases([...phases, {
      id: `phase_${Date.now()}`,
      name,
      tasks: []
    }]);
  };
  const deletePhase = pId => {
    if (confirm("刪除此階段及所有任務？")) setPhases(phases.filter(p => p.id !== pId));
  };
  const addTaskToPhase = phaseId => {
    if (!newTask.title) return;
    const task = {
      id: Date.now(),
      title: newTask.title,
      assignee: newTask.assignee,
      dueDate: newTask.dueDate,
      completed: false,
      kpi: {
        name: newTask.kpiName,
        target: newTask.kpiTarget,
        current: '',
        unit: newTask.kpiUnit
      },
      notes: []
    };
    setPhases(phases.map(p => p.id === phaseId ? {
      ...p,
      tasks: [...p.tasks, task]
    } : p));
    setNewTask({
      title: '',
      assignee: '',
      dueDate: '',
      kpiName: '',
      kpiTarget: '',
      kpiUnit: ''
    });
    setAddingToPhaseId(null);
  };
  const toggleTask = (phaseId, taskId) => {
    setPhases(phases.map(p => p.id === phaseId ? {
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? {
        ...t,
        completed: !t.completed
      } : t)
    } : p));
  };
  const deleteTask = (phaseId, taskId) => {
    if (confirm("刪除任務？")) {
      setPhases(phases.map(p => p.id === phaseId ? {
        ...p,
        tasks: p.tasks.filter(t => t.id !== taskId)
      } : p));
    }
  };
  const handleSave = () => {
    const flatTasks = phases.flatMap(p => p.tasks);
    onUpdate(project.id, {
      name: editName,
      cloudLink: editLink,
      status: editStatus,
      stakeholders: editStakeholders,
      metrics: metrics,
      phases: phases,
      subTasks: flatTasks
    });
    onClose();
  };
  return React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4 fade-in backdrop-blur-sm cursor-pointer",
    onClick: onClose
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-4xl p-0 shadow-2xl flex flex-col max-h-[90vh] cursor-auto overflow-hidden relative",
    onClick: e => e.stopPropagation()
  }, React.createElement("div", {
    className: "bg-gradient-to-r from-slate-800 to-slate-900 p-6 text-white shrink-0 relative overflow-hidden"
  }, React.createElement("div", {
    className: "absolute top-0 right-0 p-4 opacity-10 pointer-events-none"
  }, React.createElement(Icon, {
    name: "gamepad-2",
    size: 150
  })), React.createElement("div", {
    className: "flex justify-between items-start relative z-10"
  }, React.createElement("div", null, React.createElement("div", {
    className: "flex items-center gap-3 mb-2"
  }, React.createElement("h3", {
    className: "text-2xl font-bold"
  }, editName || '未命名專案'), React.createElement("span", {
    className: `text-xs px-2 py-0.5 rounded font-bold ${editStatus === 'Done' ? 'bg-green-500' : editStatus === 'Stuck' ? 'bg-red-500' : 'bg-blue-500'}`
  }, editStatus)), React.createElement("div", {
    className: "flex items-center gap-4 text-slate-300 text-sm"
  }, editLink ? React.createElement("a", {
    href: editLink,
    target: "_blank",
    className: "bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-all text-xs font-bold border border-white/20 shadow-sm group"
  }, React.createElement(Icon, {
    name: "external-link",
    size: 14,
    className: "group-hover:scale-110 transition-transform"
  }), " \u958B\u555F\u96F2\u7AEF\u8CC7\u6599\u593E") : React.createElement("span", {
    className: "opacity-50 text-xs bg-black/20 px-3 py-1.5 rounded-lg flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "link-2-off",
    size: 12
  }), " \u7121\u96F2\u7AEF\u9023\u7D50"))), React.createElement("div", {
    className: "flex flex-col items-end"
  }, React.createElement("div", {
    className: "text-sm font-bold text-yellow-400 flex items-center gap-1 mb-1"
  }, React.createElement(Icon, {
    name: "crown",
    size: 16
  }), " LEVEL ", level), React.createElement("div", {
    className: "w-32 h-3 bg-slate-700 rounded-full overflow-hidden border border-slate-600 relative"
  }, React.createElement("div", {
    className: "h-full bg-gradient-to-r from-yellow-400 to-orange-500 xp-bar-fill",
    style: {
      width: `${xp}%`
    }
  })), React.createElement("div", {
    className: "text-[10px] text-slate-400 mt-1"
  }, "XP: ", xp, " / 100")))), React.createElement("div", {
    className: "flex flex-col md:flex-row flex-1 overflow-hidden bg-slate-50"
  }, React.createElement("div", {
    className: "w-full md:w-1/3 p-4 border-r border-slate-200 overflow-y-auto bg-white custom-scrollbar"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "target",
    size: 18,
    className: "text-red-500"
  }), " \u9810\u671F\u6210\u679C (KPI)"), React.createElement("button", {
    onClick: () => setShowMetricForm(true),
    className: "text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded transition"
  }, React.createElement(Icon, {
    name: "plus",
    size: 14
  }))), showMetricForm && React.createElement("div", {
    className: "mb-4 p-3 bg-slate-50 border border-slate-200 rounded-xl animate-in fade-in slide-in-from-top-2"
  }, React.createElement("input", {
    type: "text",
    className: "w-full mb-2 p-1.5 text-xs border rounded",
    placeholder: "\u76EE\u6A19\u540D\u7A31 (\u5982: \u71DF\u6536)",
    value: newMetric.name,
    onChange: e => setNewMetric({
      ...newMetric,
      name: e.target.value
    })
  }), React.createElement("div", {
    className: "flex gap-2 mb-2"
  }, React.createElement("input", {
    type: "number",
    className: "w-2/3 p-1.5 text-xs border rounded",
    placeholder: "\u76EE\u6A19\u6578\u503C",
    value: newMetric.target,
    onChange: e => setNewMetric({
      ...newMetric,
      target: e.target.value
    })
  }), React.createElement("input", {
    type: "text",
    className: "w-1/3 p-1.5 text-xs border rounded",
    placeholder: "\u55AE\u4F4D",
    value: newMetric.unit,
    onChange: e => setNewMetric({
      ...newMetric,
      unit: e.target.value
    })
  })), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: () => setShowMetricForm(false),
    className: "flex-1 py-1 text-xs text-slate-500 hover:bg-slate-200 rounded"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: addMetric,
    className: "flex-1 py-1 text-xs bg-blue-600 text-white rounded shadow-sm hover:bg-blue-700"
  }, "\u65B0\u589E"))), React.createElement("div", {
    className: "space-y-3"
  }, metrics.map(m => React.createElement("div", {
    key: m.id,
    className: "p-3 border border-slate-100 rounded-xl shadow-sm bg-white relative group"
  }, React.createElement("button", {
    onClick: () => deleteMetric(m.id),
    className: "absolute top-1 right-1 text-slate-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition p-1"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  })), React.createElement("div", {
    className: "flex items-center justify-between"
  }, React.createElement("div", {
    className: "flex items-center gap-3"
  }, React.createElement(CircularProgress, {
    value: m.current,
    max: m.target,
    size: 40,
    strokeWidth: 4,
    color: m.current >= m.target ? 'text-green-500' : 'text-blue-500'
  }), React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold text-slate-700"
  }, m.name), React.createElement("div", {
    className: "text-[10px] text-slate-400"
  }, "\u76EE\u6A19: ", Number(m.target).toLocaleString(), " ", m.unit)))), React.createElement("div", {
    className: "mt-2 flex items-center gap-2"
  }, React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, "\u76EE\u524D:"), React.createElement("input", {
    type: "number",
    className: "flex-1 py-0.5 px-2 text-xs border border-slate-200 rounded text-right font-bold text-slate-700 focus:ring-1 focus:ring-blue-500 outline-none",
    value: m.current,
    onChange: e => updateMetricCurrent(m.id, e.target.value)
  }), React.createElement("span", {
    className: "text-[10px] text-slate-400"
  }, m.unit)))), metrics.length === 0 && React.createElement("div", {
    className: "text-center py-6 text-slate-400 text-xs border-2 border-dashed border-slate-200 rounded-xl"
  }, "\u5C1A\u672A\u8A2D\u5B9A KPI")), React.createElement("div", {
    className: "mt-6 pt-4 border-t border-slate-100"
  }, React.createElement("div", {
    className: "space-y-3"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u5C08\u6848\u540D\u7A31"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    value: editName,
    onChange: e => setEditName(e.target.value)
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u96F2\u7AEF\u9023\u7D50"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    value: editLink,
    onChange: e => setEditLink(e.target.value),
    placeholder: "https://..."
  })), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u72C0\u614B"), React.createElement("select", {
    className: "w-full p-2 border rounded-lg text-sm",
    value: editStatus,
    onChange: e => setEditStatus(e.target.value)
  }, React.createElement("option", {
    value: "To Do"
  }, "To Do"), React.createElement("option", {
    value: "In Progress"
  }, "In Progress"), React.createElement("option", {
    value: "Stuck"
  }, "Stuck"), React.createElement("option", {
    value: "Done"
  }, "Done"))), React.createElement("div", null, React.createElement("label", {
    className: "text-xs font-bold text-slate-500 mb-1 block"
  }, "\u5229\u5BB3\u95DC\u4FC2\u4EBA"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    value: editStakeholders,
    onChange: e => setEditStakeholders(e.target.value),
    placeholder: "\u5982: \u696D\u52D9\u90E8, \u5916\u90E8\u5EE0\u5546..."
  }))))), React.createElement("div", {
    className: "w-full md:w-2/3 p-4 overflow-y-auto bg-slate-50/50 relative"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6 sticky top-0 bg-slate-50/95 backdrop-blur z-20 py-2 border-b border-slate-200"
  }, React.createElement("h4", {
    className: "font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "map",
    size: 18,
    className: "text-blue-600"
  }), " \u4EFB\u52D9\u5730\u5716 (Quest Map)"), React.createElement("button", {
    onClick: addPhase,
    className: "text-xs bg-slate-800 text-white px-3 py-1.5 rounded-lg shadow hover:bg-slate-700 flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "plus-circle",
    size: 14
  }), " \u65B0\u589E\u968E\u6BB5")), React.createElement("div", {
    className: "space-y-0 pl-2 relative pb-20"
  }, React.createElement("div", {
    className: "absolute left-[21px] top-4 bottom-0 w-0.5 bg-slate-200 z-0"
  }), phases.map((phase, pIndex) => React.createElement("div", {
    key: phase.id,
    className: "relative z-10 mb-8 animate-in slide-in-from-bottom-4 duration-500",
    style: {
      animationDelay: `${pIndex * 100}ms`
    }
  }, React.createElement("div", {
    className: "flex items-center gap-4 mb-4"
  }, React.createElement("div", {
    className: `w-10 h-10 rounded-full flex items-center justify-center border-4 border-slate-50 shadow-md z-10 ${phase.tasks.every(t => t.completed) && phase.tasks.length > 0 ? 'bg-green-500 text-white' : 'bg-blue-600 text-white'}`
  }, phase.tasks.every(t => t.completed) && phase.tasks.length > 0 ? React.createElement(Icon, {
    name: "check",
    size: 20
  }) : React.createElement("span", {
    className: "font-bold"
  }, pIndex + 1)), React.createElement("div", {
    className: "flex-1 bg-white p-2 px-4 rounded-xl border border-slate-200 shadow-sm flex justify-between items-center group"
  }, React.createElement("h5", {
    className: "font-bold text-slate-800"
  }, phase.name), React.createElement("button", {
    onClick: () => deletePhase(phase.id),
    className: "text-slate-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  })))), React.createElement("div", {
    className: "ml-14 grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, phase.tasks.map(t => React.createElement("div", {
    key: t.id,
    onClick: () => setEditingTaskInfo({
      phaseId: phase.id,
      task: t
    }),
    className: `quest-card bg-white p-3 rounded-xl border-2 cursor-pointer transition-all group relative ${t.completed ? 'border-green-200 bg-green-50/30' : 'border-slate-100 hover:border-blue-200 shadow-sm'}`
  }, React.createElement("div", {
    className: "flex items-start gap-3"
  }, React.createElement("div", {
    onClick: e => {
      e.stopPropagation();
      toggleTask(phase.id, t.id);
    },
    className: `mt-1 w-5 h-5 rounded border flex items-center justify-center transition-colors ${t.completed ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300 bg-slate-50'}`
  }, t.completed && React.createElement(Icon, {
    name: "check",
    size: 12
  })), React.createElement("div", {
    className: "flex-1"
  }, React.createElement("div", {
    className: `text-sm font-bold mb-1 ${t.completed ? 'text-slate-400 line-through' : 'text-slate-700'}`
  }, t.title), React.createElement("div", {
    className: "flex flex-wrap gap-2 text-[10px] text-slate-400"
  }, t.assignee && React.createElement("span", {
    className: "flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 rounded"
  }, React.createElement(Icon, {
    name: "user",
    size: 10
  }), " ", t.assignee), t.dueDate && React.createElement("span", {
    className: `flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 rounded ${new Date(t.dueDate) < new Date() && !t.completed ? 'text-red-500 font-bold' : ''}`
  }, React.createElement(Icon, {
    name: "clock",
    size: 10
  }), " ", t.dueDate)), t.kpi?.target && React.createElement("div", {
    className: "mt-2 text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded border border-blue-100 flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "target",
    size: 10
  }), " ", t.kpi.name || 'KPI', ": ", t.kpi.current || '0', " / ", t.kpi.target, " ", t.kpi.unit)), React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      deleteTask(phase.id, t.id);
    },
    className: "absolute top-2 right-2 text-slate-300 hover:text-red-400 opacity-0 group-hover:opacity-100 p-1"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  }))))), addingToPhaseId === phase.id ? React.createElement("div", {
    className: "bg-blue-50 border-2 border-blue-200 border-dashed p-3 rounded-xl animate-in zoom-in-95"
  }, React.createElement("input", {
    type: "text",
    className: "w-full text-xs p-1.5 border rounded mb-2",
    placeholder: "\u4EFB\u52D9\u540D\u7A31...",
    value: newTask.title,
    onChange: e => setNewTask({
      ...newTask,
      title: e.target.value
    }),
    autoFocus: true,
    onKeyDown: e => e.key === 'Enter' && addTaskToPhase(phase.id)
  }), React.createElement("div", {
    className: "flex gap-2 mb-2"
  }, React.createElement("input", {
    type: "text",
    className: "w-1/2 text-xs p-1.5 border rounded",
    placeholder: "\u8CA0\u8CAC\u4EBA",
    value: newTask.assignee,
    onChange: e => setNewTask({
      ...newTask,
      assignee: e.target.value
    })
  }), React.createElement("input", {
    type: "date",
    className: "w-1/2 text-xs p-1.5 border rounded",
    value: newTask.dueDate,
    onChange: e => setNewTask({
      ...newTask,
      dueDate: e.target.value
    })
  })), React.createElement("div", {
    className: "grid grid-cols-3 gap-2 mb-2"
  }, React.createElement("input", {
    type: "text",
    className: "text-xs p-1.5 border rounded",
    placeholder: "KPI \u540D\u7A31",
    value: newTask.kpiName,
    onChange: e => setNewTask({
      ...newTask,
      kpiName: e.target.value
    })
  }), React.createElement("input", {
    type: "number",
    className: "text-xs p-1.5 border rounded",
    placeholder: "\u76EE\u6A19\u503C",
    value: newTask.kpiTarget,
    onChange: e => setNewTask({
      ...newTask,
      kpiTarget: e.target.value
    })
  }), React.createElement("input", {
    type: "text",
    className: "text-xs p-1.5 border rounded",
    placeholder: "\u55AE\u4F4D",
    value: newTask.kpiUnit,
    onChange: e => setNewTask({
      ...newTask,
      kpiUnit: e.target.value
    })
  })), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: () => setAddingToPhaseId(null),
    className: "flex-1 py-1 text-xs text-slate-500 hover:bg-slate-200 rounded"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: () => addTaskToPhase(phase.id),
    className: "flex-1 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
  }, "\u78BA\u5B9A"))) : React.createElement("button", {
    onClick: () => setAddingToPhaseId(phase.id),
    className: "border-2 border-dashed border-slate-200 rounded-xl p-3 flex flex-col items-center justify-center text-slate-400 hover:border-blue-300 hover:text-blue-500 hover:bg-blue-50 transition-all min-h-[80px]"
  }, React.createElement(Icon, {
    name: "plus",
    size: 20,
    className: "mb-1"
  }), React.createElement("span", {
    className: "text-xs"
  }, "\u65B0\u589E\u4E26\u884C\u4EFB\u52D9"))))), React.createElement("div", {
    className: "ml-4 mt-4 relative z-10"
  }, React.createElement("button", {
    onClick: addPhase,
    className: "w-10 h-10 rounded-full bg-slate-200 hover:bg-blue-500 hover:text-white text-slate-500 flex items-center justify-center transition-colors shadow-sm mx-auto md:mx-0"
  }, React.createElement(Icon, {
    name: "plus",
    size: 20
  })))))), React.createElement("div", {
    className: "flex justify-between items-center p-4 border-t border-slate-100 bg-white z-30"
  }, React.createElement("button", {
    onClick: async () => {
      if (confirm('確定刪除此專案？')) {
        await onDelete(project.id);
        onClose();
      }
    },
    className: "text-red-500 hover:bg-red-50 px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 16
  }), " \u522A\u9664\u5C08\u6848"), React.createElement("div", {
    className: "flex gap-2"
  }, React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg"
  }, "\u53D6\u6D88"), React.createElement("button", {
    onClick: handleSave,
    className: "px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-md font-bold tracking-wide"
  }, "\u5132\u5B58\u9032\u5EA6"))), editingTaskInfo && React.createElement(ProjectTaskEditModal, {
    task: editingTaskInfo.task,
    phaseId: editingTaskInfo.phaseId,
    onClose: () => setEditingTaskInfo(null),
    onSave: (phaseId, taskId, updatedTask) => {
      setPhases(prev => prev.map(p => p.id === phaseId ? {
        ...p,
        tasks: p.tasks.map(t => t.id === taskId ? updatedTask : t)
      } : p));
      setEditingTaskInfo(null);
    }
  })));
};
const AnalyticsDashboard = ({
  db,
  dbSource
}) => {
  const [stats, setStats] = useState({
    total: 0,
    today: 0
  });
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [trendMode, setTrendMode] = useState('daily');
  const [isChartLibReady, setIsChartLibReady] = useState(!!(window.Recharts && window.Recharts.BarChart));
  const [chartLoadError, setChartLoadError] = useState(false);
  useEffect(() => {
    if (isChartLibReady) return;
    let cancelled = false;
    setChartLoadError(false);
    ensureRechartsLoaded().then(() => {
      if (!cancelled) setIsChartLibReady(true);
    }).catch(error => {
      console.error('Recharts lazy load failed', error);
      if (!cancelled) setChartLoadError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isChartLibReady]);
  const Recharts = window.Recharts || {};
  const {
    BarChart,
    Bar,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip: RechartsTooltip,
    ResponsiveContainer
  } = Recharts;
  useEffect(() => {
    if (!db) {
      setLoading(false);
      return;
    }
    const basePath = `artifacts/${dbSource}/analytics`;
    const todayStr = getLocalDateStr();
    const unsubTotal = onSnapshot(doc(db, basePath, 'stats', 'overview', 'total'), s => {
      const totalData = s && s.exists() ? sanitizeFirebaseValue(s.data() || {}) : {};
      setStats(prev => ({
        ...prev,
        total: totalData.count || 0
      }));
    });
    const unsubDaily = onSnapshot(doc(db, basePath, 'stats', 'daily', todayStr), s => {
      const dailyData = s && s.exists() ? sanitizeFirebaseValue(s.data() || {}) : {};
      setStats(prev => ({
        ...prev,
        today: dailyData.count || 0
      }));
    });
    const unsubSessions = onSnapshot(collection(db, basePath, 'traffic', 'sessions'), snapshot => {
      const list = [];
      if (snapshot) snapshot.forEach(doc => list.push({
        id: doc.id,
        ...sanitizeFirebaseValue(doc.data() || {})
      }));
      list.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
      setSessions(list);
      setLoading(false);
    });
    return () => {
      if (unsubTotal) unsubTotal();
      if (unsubDaily) unsubDaily();
      if (unsubSessions) unsubSessions();
    };
  }, [db, dbSource]);
  const processHourlyData = useMemo(() => {
    const hours = Array(24).fill(0).map((_, i) => ({
      hour: `${i}時`,
      count: 0
    }));
    sessions.forEach(s => {
      if (!s.startTime) return;
      const h = new Date(s.startTime).getHours();
      if (hours[h]) hours[h].count++;
    });
    return hours;
  }, [sessions]);
  const processTrendData = useMemo(() => {
    const map = {};
    sessions.forEach(s => {
      if (!s.startTime) return;
      const d = new Date(s.startTime);
      let key = '';
      if (trendMode === 'daily') {
        key = s.date || formatLocalDateKey(d);
      } else if (trendMode === 'weekly') {
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const days = Math.floor((d - startOfYear) / (24 * 60 * 60 * 1000));
        const week = Math.ceil((days + 1) / 7);
        key = `${d.getFullYear()} W${week}`;
      } else if (trendMode === 'monthly') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      map[key] = (map[key] || 0) + 1;
    });
    return Object.entries(map).map(([date, count]) => ({
      date,
      count
    })).sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  }, [sessions, trendMode]);
  if (!db) return React.createElement("div", {
    className: "p-8 text-center text-red-400"
  }, "\u8CC7\u6599\u5EAB\u672A\u9023\u7DDA");
  if (!isChartLibReady) {
    if (chartLoadError) {
      return React.createElement("div", {
        className: "p-12 text-center border-2 border-dashed border-red-200 rounded-xl m-4 bg-red-50"
      }, React.createElement(Icon, {
        name: "alert-triangle",
        className: "mb-2 mx-auto text-red-500",
        size: 32
      }), React.createElement("h3", {
        className: "font-bold text-red-600"
      }, "\u5716\u8868\u5F15\u64CE\u8F09\u5165\u5931\u6557"), React.createElement("p", {
        className: "text-xs text-red-400 mt-2 mb-4"
      }, "\u53EF\u80FD\u662F\u7DB2\u8DEF\u9023\u7DDA\u554F\u984C\u6216 CDN \u963B\u64CB"), React.createElement("button", {
        onClick: () => window.location.reload(),
        className: "bg-red-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-red-600 transition"
      }, "\u91CD\u65B0\u6574\u7406\u9801\u9762"));
    }
    return React.createElement("div", {
      className: "p-12 text-center border-2 border-dashed border-slate-200 rounded-xl m-4 bg-slate-50"
    }, React.createElement(Icon, {
      name: "loader-2",
      className: "animate-spin mb-2 mx-auto text-blue-500",
      size: 32
    }), React.createElement("h3", {
      className: "font-bold text-slate-600"
    }, "\u6B63\u5728\u555F\u52D5\u5716\u8868\u5F15\u64CE..."), React.createElement("p", {
      className: "text-xs text-slate-400 mt-2"
    }, "\u9996\u6B21\u8F09\u5165\u53EF\u80FD\u9700\u8981\u5E7E\u79D2\u9418"));
  }
  if (loading) return React.createElement("div", {
    className: "p-8 text-center text-slate-400"
  }, React.createElement(Icon, {
    name: "loader-2",
    className: "animate-spin inline mr-2"
  }), "\u8B80\u53D6\u6578\u64DA\u4E2D...");
  const avgDuration = sessions.length > 0 ? Math.round(sessions.reduce((a, b) => a + (b.durationSeconds || 0), 0) / sessions.length) : 0;
  if (!BarChart || !LineChart) return React.createElement("div", null, "Chart components missing");
  return React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto pb-20 space-y-6"
  }, React.createElement("header", {
    className: "flex justify-between items-end"
  }, React.createElement("div", null, React.createElement("h2", {
    className: "text-2xl font-bold text-slate-800"
  }, "\u6D41\u91CF\u6578\u64DA\u4E2D\u5FC3"), React.createElement("p", {
    className: "text-sm text-slate-500"
  }, "\u638C\u63E1\u8A2A\u5BA2\u52D5\u5411\u8207\u6642\u6BB5\u5206\u6790")), React.createElement("div", {
    className: "text-xs text-slate-400"
  }, "\u7D71\u8A08\u6A23\u672C: \u6700\u8FD1 ", sessions.length, " \u7B46")), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-6"
  }, React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-blue-100"
  }, React.createElement("div", {
    className: "text-sm font-bold text-blue-500 mb-1"
  }, "\u7E3D\u7D2F\u7A4D\u8A2A\u5BA2\u6578"), React.createElement("div", {
    className: "text-4xl font-bold text-slate-800"
  }, (stats.total || 0).toLocaleString())), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-emerald-100"
  }, React.createElement("div", {
    className: "text-sm font-bold text-emerald-500 mb-1"
  }, "\u4ECA\u65E5\u8A2A\u5BA2"), React.createElement("div", {
    className: "text-4xl font-bold text-slate-800"
  }, (stats.today || 0).toLocaleString())), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-orange-100"
  }, React.createElement("div", {
    className: "text-sm font-bold text-orange-500 mb-1"
  }, "\u5E73\u5747\u505C\u7559\u6642\u9593"), React.createElement("div", {
    className: "text-4xl font-bold text-slate-800"
  }, avgDuration, " ", React.createElement("span", {
    className: "text-base text-slate-400 font-normal"
  }, "\u79D2")))), React.createElement("div", {
    className: "grid grid-cols-1 lg:grid-cols-2 gap-6"
  }, React.createElement("div", {
    className: "bg-white p-4 rounded-2xl shadow-sm border border-slate-200"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("h3", {
    className: "font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "trending-up",
    size: 18
  }), " \u6D41\u91CF\u8DA8\u52E2"), React.createElement("div", {
    className: "flex bg-slate-100 rounded-lg p-1"
  }, ['daily', 'weekly', 'monthly'].map(m => React.createElement("button", {
    key: m,
    onClick: () => setTrendMode(m),
    className: `px-3 py-1 text-xs rounded-md transition-all ${trendMode === m ? 'bg-white shadow text-blue-600 font-bold' : 'text-slate-500'}`
  }, m === 'daily' ? '日' : m === 'weekly' ? '週' : '月')))), React.createElement("div", {
    className: "h-[250px] w-full"
  }, React.createElement(ResponsiveContainer, {
    width: "100%",
    height: "100%"
  }, React.createElement(LineChart, {
    data: processTrendData
  }, React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    vertical: false,
    stroke: "#e2e8f0"
  }), React.createElement(XAxis, {
    dataKey: "date",
    tick: {
      fontSize: 10
    },
    stroke: "#94a3b8"
  }), React.createElement(YAxis, {
    tick: {
      fontSize: 10
    },
    stroke: "#94a3b8"
  }), React.createElement(RechartsTooltip, {
    contentStyle: {
      borderRadius: '8px',
      border: 'none',
      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
    }
  }), React.createElement(Line, {
    type: "monotone",
    dataKey: "count",
    stroke: "#3b82f6",
    strokeWidth: 3,
    dot: {
      r: 3
    },
    activeDot: {
      r: 6
    },
    name: "\u8A2A\u5BA2\u6578"
  }))))), React.createElement("div", {
    className: "bg-white p-4 rounded-2xl shadow-sm border border-slate-200"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-4"
  }, React.createElement("h3", {
    className: "font-bold text-slate-700 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "clock",
    size: 18
  }), " \u55AE\u65E5\u71B1\u9580\u6642\u6BB5 (0-23\u6642)")), React.createElement("div", {
    className: "h-[250px] w-full"
  }, React.createElement(ResponsiveContainer, {
    width: "100%",
    height: "100%"
  }, React.createElement(BarChart, {
    data: processHourlyData
  }, React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    vertical: false,
    stroke: "#e2e8f0"
  }), React.createElement(XAxis, {
    dataKey: "hour",
    tick: {
      fontSize: 10
    },
    stroke: "#94a3b8"
  }), React.createElement(YAxis, {
    tick: {
      fontSize: 10
    },
    stroke: "#94a3b8"
  }), React.createElement(RechartsTooltip, {
    cursor: {
      fill: '#f1f5f9'
    },
    contentStyle: {
      borderRadius: '8px',
      border: 'none',
      boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
    }
  }), React.createElement(Bar, {
    dataKey: "count",
    fill: "#8b5cf6",
    radius: [4, 4, 0, 0],
    name: "\u6D3B\u8E8D\u6B21\u6578"
  })))))), React.createElement("div", {
    className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden"
  }, React.createElement("div", {
    className: "p-4 border-b border-slate-100 font-bold text-slate-700 bg-slate-50/50"
  }, "\uD83D\uDD75\uFE0F \u6700\u8FD1\u8A2A\u5BA2\u7D00\u9304 (\u6700\u8FD1 50 \u7B46)"), React.createElement("div", {
    className: "overflow-x-auto"
  }, React.createElement("table", {
    className: "w-full text-left text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 text-slate-500"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "p-4"
  }, "\u6642\u9593"), React.createElement("th", {
    className: "p-4"
  }, "\u88DD\u7F6E"), React.createElement("th", {
    className: "p-4"
  }, "\u505C\u7559"), React.createElement("th", {
    className: "p-4"
  }, "\u6700\u5F8C\u4E92\u52D5 (\u6D3B\u52D5\u8FFD\u8E64)"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, sessions.slice(0, 50).map(s => React.createElement("tr", {
    key: s.id,
    className: "hover:bg-slate-50 transition-colors"
  }, React.createElement("td", {
    className: "p-4 text-slate-600"
  }, React.createElement("div", {
    className: "font-bold"
  }, s.date), React.createElement("div", {
    className: "text-xs text-slate-400"
  }, s.startTime ? new Date(s.startTime).toLocaleTimeString() : '-')), React.createElement("td", {
    className: "p-4"
  }, React.createElement("span", {
    className: `px-2 py-1 rounded text-xs font-bold ${s.device === 'Mobile' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`
  }, s.device || 'Desktop')), React.createElement("td", {
    className: "p-4 font-mono font-bold text-blue-600"
  }, (s.durationSeconds || 0) < 60 ? `${s.durationSeconds || 0}s` : `${Math.floor((s.durationSeconds || 0) / 60)}m`), React.createElement("td", {
    className: "p-4"
  }, React.createElement("div", {
    className: "max-w-[240px] truncate text-slate-700 font-medium",
    title: s.lastAction
  }, s.lastAction || '-')))))))));
};
const ProjectConsoleTab = ({
  user,
  db,
  dbSource,
  sourceProjects
}) => {
  const [allProjects, setAllProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [expandedWPs, setExpandedWPs] = useState([]);
  const [viewMode, setViewMode] = useState('table');
  const [workspaceMode, setWorkspaceMode] = useState('active');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => {
    const mapped = (sourceProjects || []).map((p, idx) => normalizeConsoleProject(p, `proj_${idx}`));
    setAllProjects(mapped);
  }, [sourceProjects]);
  useEffect(() => {
    const list = allProjects.filter(p => p.status === workspaceMode);
    if (!activeProjectId && list.length > 0) setActiveProjectId(list[0].id);
    if (activeProjectId && !list.some(p => p.id === activeProjectId)) {
      setActiveProjectId(list[0]?.id || null);
    }
  }, [allProjects, workspaceMode, activeProjectId]);
  const currentProject = useMemo(() => allProjects.find(p => p.id === activeProjectId) || null, [allProjects, activeProjectId]);
  useEffect(() => {
    if (!user || !db || !currentProject) return;
    const timer = setTimeout(async () => {
      setIsSaving(true);
      try {
        await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'projects', currentProject.id), currentProject, {
          merge: true
        });
      } catch (e) {
        console.error("Project autosave error:", e);
      } finally {
        setIsSaving(false);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [currentProject, user, db, dbSource]);
  const setProjectData = (field, value) => {
    setAllProjects(prev => prev.map(p => p.id === activeProjectId ? {
      ...p,
      [field]: value
    } : p));
  };
  const updateTask = (wpId, taskId, field, subfield, value) => {
    setAllProjects(prev => prev.map(p => {
      if (p.id !== activeProjectId) return p;
      return {
        ...p,
        workPackages: p.workPackages.map(wp => {
          if (wp.id !== wpId) return wp;
          if (!taskId) return {
            ...wp,
            [field]: value
          };
          return {
            ...wp,
            tasks: wp.tasks.map(t => {
              if (t.id !== taskId) return t;
              if (subfield) return {
                ...t,
                [field]: {
                  ...t[field],
                  [subfield]: value
                }
              };
              return {
                ...t,
                [field]: value
              };
            })
          };
        })
      };
    }));
  };
  const addWP = () => {
    if (!currentProject) return;
    const newId = `WP${currentProject.workPackages.length + 1}`;
    setProjectData('workPackages', [...currentProject.workPackages, {
      id: newId,
      name: "新工作包",
      tasks: []
    }]);
    setExpandedWPs(prev => [...new Set([...prev, newId])]);
  };
  const deleteWP = wpId => {
    if (!confirm("確定刪除此工作包？")) return;
    setProjectData('workPackages', currentProject.workPackages.filter(wp => wp.id !== wpId));
  };
  const addTask = wpId => {
    if (!currentProject) return;
    const today = getLocalDateStr();
    const next = currentProject.workPackages.map(wp => {
      if (wp.id !== wpId) return wp;
      return {
        ...wp,
        tasks: [...wp.tasks, {
          id: `${wp.id.replace('WP', '')}.${wp.tasks.length + 1}`,
          name: "新任務",
          owner: "未指派",
          plan: {
            start: today,
            end: today,
            cost: 0
          },
          actual: {
            start: today,
            end: today,
            cost: 0
          },
          progress: 0
        }]
      };
    });
    setProjectData('workPackages', next);
  };
  const deleteTask = (wpId, taskId) => {
    if (!confirm("確定刪除此任務？")) return;
    const next = currentProject.workPackages.map(wp => wp.id === wpId ? {
      ...wp,
      tasks: wp.tasks.filter(t => t.id !== taskId)
    } : wp);
    setProjectData('workPackages', next);
  };
  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !db) return;
    const newProj = createProjectConsoleTemplate(newProjectName.trim());
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'projects', newProj.id), newProj);
    setNewProjectName("");
    setIsCreateModalOpen(false);
    setWorkspaceMode('active');
    setActiveProjectId(newProj.id);
  };
  const archiveProject = () => {
    if (currentProject) setProjectData('status', 'archived');
  };
  const restartProject = () => {
    if (currentProject) setProjectData('status', 'active');
  };
  const deleteProject = async id => {
    if (!confirm("確定要永久刪除此專案嗎？此動作無法復原。")) return;
    await deleteDoc(doc(db, `artifacts/${dbSource}/public/data`, 'projects', id));
    if (activeProjectId === id) setActiveProjectId(null);
  };
  const workspaceProjects = allProjects.filter(p => p.status === workspaceMode);
  const evmStats = useMemo(() => {
    if (!currentProject) return {
      totalPV: 0,
      totalAC: 0,
      totalEV: 0,
      cpi: "0.00",
      spi: "0.00",
      cv: 0
    };
    let totalPV = 0,
      totalAC = 0,
      totalEV = 0;
    currentProject.workPackages.forEach(wp => {
      wp.tasks.forEach(task => {
        totalPV += Number(task.plan?.cost || 0);
        totalAC += Number(task.actual?.cost || 0);
        totalEV += Number(task.plan?.cost || 0) * (Number(task.progress || 0) / 100);
      });
    });
    return {
      totalPV,
      totalAC,
      totalEV,
      cpi: totalAC > 0 ? (totalEV / totalAC).toFixed(2) : "0.00",
      spi: totalPV > 0 ? (totalEV / totalPV).toFixed(2) : "0.00",
      cv: totalEV - totalAC
    };
  }, [currentProject]);
  const getPosition = dateStr => getDayOfYear(dateStr) / 365 * 100;
  return React.createElement("div", {
    className: "min-h-[80vh] bg-slate-50 text-slate-900 rounded-2xl overflow-hidden border border-slate-200 flex flex-col md:flex-row"
  }, React.createElement("div", {
    className: "w-full md:w-72 bg-slate-900 text-white flex flex-col shrink-0 border-r border-slate-800"
  }, React.createElement("div", {
    className: "p-6 flex items-center gap-3 border-b border-slate-800"
  }, React.createElement("div", {
    className: "w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-black"
  }, "P"), React.createElement("span", {
    className: "font-black tracking-tighter text-lg"
  }, "Project Console")), React.createElement("div", {
    className: "flex-1 overflow-y-auto p-4 space-y-6"
  }, React.createElement("div", {
    className: "space-y-1"
  }, React.createElement("button", {
    onClick: () => setWorkspaceMode('active'),
    className: `w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-bold ${workspaceMode === 'active' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`
  }, React.createElement(Icon, {
    name: "briefcase",
    size: 18
  }), " \u57F7\u884C\u4E2D\u5C08\u6848"), React.createElement("button", {
    onClick: () => setWorkspaceMode('archived'),
    className: `w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-bold ${workspaceMode === 'archived' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`
  }, React.createElement(Icon, {
    name: "history",
    size: 18
  }), " \u5DF2\u7D50\u6848\u5B58\u6A94")), React.createElement("div", null, React.createElement("p", {
    className: "text-[10px] font-black text-slate-500 uppercase tracking-widest px-4 mb-3"
  }, "Project List"), React.createElement("div", {
    className: "space-y-1"
  }, workspaceProjects.map(p => React.createElement("div", {
    key: p.id,
    className: "group relative"
  }, React.createElement("button", {
    onClick: () => setActiveProjectId(p.id),
    className: `w-full text-left px-4 py-3 rounded-xl text-sm font-medium truncate pr-10 ${activeProjectId === p.id ? 'bg-slate-800 text-blue-400 ring-1 ring-slate-700' : 'text-slate-400 hover:bg-slate-800/50'}`
  }, p.name), workspaceMode === 'archived' && React.createElement("button", {
    onClick: () => deleteProject(p.id),
    className: "absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 14
  })))), workspaceProjects.length === 0 && React.createElement("div", {
    className: "px-4 py-8 text-center border-2 border-dashed border-slate-800 rounded-2xl"
  }, React.createElement("p", {
    className: "text-xs text-slate-600 font-bold"
  }, "\u5C1A\u7121\u9805\u76EE"))))), React.createElement("div", {
    className: "p-4 border-t border-slate-800"
  }, React.createElement("button", {
    onClick: () => setIsCreateModalOpen(true),
    className: "w-full py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-black flex items-center justify-center gap-2 border border-slate-700"
  }, React.createElement(Icon, {
    name: "folder-plus",
    size: 18
  }), " \u65B0\u589E\u5C08\u6848"))), React.createElement("div", {
    className: "flex-1 flex flex-col overflow-hidden"
  }, !currentProject ? React.createElement("div", {
    className: "flex-1 flex flex-col items-center justify-center text-slate-300 p-12"
  }, React.createElement(Icon, {
    name: "layout-grid",
    size: 64,
    className: "mb-4 opacity-20"
  }), React.createElement("p", {
    className: "text-xl font-black"
  }, "\u8ACB\u9078\u64C7\u6216\u5EFA\u7ACB\u4E00\u500B\u5C08\u6848")) : React.createElement(React.Fragment, null, React.createElement("div", {
    className: "bg-white border-b border-slate-200 p-6 shadow-sm"
  }, React.createElement("div", {
    className: "max-w-[1400px] mx-auto flex flex-col lg:flex-row justify-between items-start lg:items-end gap-6"
  }, React.createElement("div", {
    className: "flex-1 w-full"
  }, React.createElement("div", {
    className: "flex items-center gap-2 mb-2"
  }, React.createElement("span", {
    className: `text-[10px] font-black px-2 py-0.5 rounded uppercase ${currentProject.status === 'active' ? 'bg-blue-600 text-white' : 'bg-amber-600 text-white'}`
  }, currentProject.status === 'active' ? 'Active Project' : 'Archived'), isSaving && React.createElement("span", {
    className: "text-[10px] text-blue-500 animate-pulse font-bold flex items-center gap-1"
  }, React.createElement(Icon, {
    name: "cloud-upload",
    size: 12
  }), " \u5132\u5B58\u4E2D")), React.createElement("input", {
    className: "text-3xl font-black text-slate-800 bg-transparent border-none focus:ring-2 focus:ring-blue-50 rounded-lg w-full px-2 py-1 -ml-2",
    value: currentProject.name,
    onChange: e => setProjectData('name', e.target.value),
    disabled: currentProject.status === 'archived'
  }), React.createElement("div", {
    className: "flex flex-wrap gap-x-6 gap-y-3 mt-4 text-xs text-slate-500 font-bold"
  }, React.createElement("span", null, "PM: ", React.createElement("input", {
    className: "bg-transparent border-none p-0 font-black text-slate-700 w-24 focus:ring-0",
    value: currentProject.pm,
    onChange: e => setProjectData('pm', e.target.value),
    disabled: currentProject.status === 'archived'
  })), React.createElement("span", null, "Dept: ", React.createElement("input", {
    className: "bg-transparent border-none p-0 font-black text-slate-700 w-24 focus:ring-0",
    value: currentProject.department,
    onChange: e => setProjectData('department', e.target.value),
    disabled: currentProject.status === 'archived'
  })), React.createElement("span", null, "Budget: NT$", React.createElement("input", {
    type: "number",
    className: "bg-transparent border-none p-0 font-black text-slate-700 w-24 focus:ring-0",
    value: currentProject.totalBudget,
    onChange: e => setProjectData('totalBudget', Number(e.target.value) || 0),
    disabled: currentProject.status === 'archived'
  })))), React.createElement("div", {
    className: "flex items-center gap-3 shrink-0"
  }, React.createElement("div", {
    className: "flex bg-slate-100 rounded-xl p-1 border border-slate-200"
  }, React.createElement("button", {
    onClick: () => setViewMode('table'),
    className: `px-4 py-2 text-xs font-bold rounded-lg ${viewMode === 'table' ? 'bg-white text-slate-800 shadow-sm' : 'text-gray-500'}`
  }, "\u6578\u64DA\u8868"), React.createElement("button", {
    onClick: () => setViewMode('gantt'),
    className: `px-4 py-2 text-xs font-bold rounded-lg ${viewMode === 'gantt' ? 'bg-white text-slate-800 shadow-sm' : 'text-gray-500'}`
  }, "\u7518\u7279\u5716")), currentProject.status === 'active' ? React.createElement("button", {
    onClick: archiveProject,
    className: "flex items-center gap-2 px-5 py-2.5 bg-amber-500 text-white text-xs font-black rounded-xl"
  }, React.createElement(Icon, {
    name: "archive",
    size: 16
  }), " \u7D50\u6848\u5B58\u6A94") : React.createElement("button", {
    onClick: restartProject,
    className: "flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-xs font-black rounded-xl"
  }, React.createElement(Icon, {
    name: "briefcase",
    size: 16
  }), " \u91CD\u555F\u5C08\u6848")))), React.createElement("div", {
    className: "p-8 max-w-[1400px] mx-auto w-full overflow-y-auto space-y-8 flex-1"
  }, React.createElement("div", {
    className: "grid grid-cols-2 lg:grid-cols-4 gap-4"
  }, [{
    label: 'CPI (成本績效)',
    val: evmStats.cpi,
    color: Number(evmStats.cpi) >= 1 ? 'text-emerald-600' : 'text-rose-600'
  }, {
    label: 'SPI (進度績效)',
    val: evmStats.spi,
    color: Number(evmStats.spi) >= 1 ? 'text-emerald-600' : 'text-rose-600'
  }, {
    label: '實獲價值 (EV)',
    val: `NT$${Math.round(evmStats.totalEV).toLocaleString()}`,
    color: 'text-slate-800'
  }, {
    label: '成本偏差 (CV)',
    val: `${evmStats.cv >= 0 ? '+' : ''}${Math.round(evmStats.cv).toLocaleString()}`,
    color: evmStats.cv >= 0 ? 'text-emerald-600' : 'text-rose-600'
  }].map((kpi, idx) => React.createElement("div", {
    key: idx,
    className: "bg-white p-6 border border-slate-200 rounded-2xl shadow-sm"
  }, React.createElement("p", {
    className: "text-[10px] text-gray-400 font-black uppercase mb-1"
  }, kpi.label), React.createElement("div", {
    className: `text-2xl font-black ${kpi.color}`
  }, kpi.val)))), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden min-h-[400px]"
  }, viewMode === 'table' ? React.createElement("div", {
    className: "overflow-x-auto"
  }, React.createElement("table", {
    className: "w-full text-left border-collapse min-w-[920px]"
  }, React.createElement("thead", {
    className: "bg-slate-800 text-white text-[11px] uppercase tracking-wider font-bold"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-5 py-4 w-[42%]"
  }, "WBS \u968E\u5C64\u8207\u5DE5\u4F5C\u5167\u5BB9"), React.createElement("th", {
    className: "px-3 py-4 text-center w-24"
  }, "\u9032\u5EA6 %"), React.createElement("th", {
    className: "px-4 py-4 w-56"
  }, "\u6210\u672C (P vs A)"), React.createElement("th", {
    className: "px-4 py-4 w-72"
  }, "\u8D77\u8A16\u9031\u671F"), React.createElement("th", {
    className: "px-3 py-4 text-center w-14"
  }))), React.createElement("tbody", {
    className: "text-sm"
  }, currentProject.workPackages.map(wp => React.createElement(React.Fragment, {
    key: wp.id
  }, React.createElement("tr", {
    className: "bg-slate-50 border-b border-slate-100"
  }, React.createElement("td", {
    className: "px-5 py-3 flex items-center gap-3"
  }, React.createElement("button", {
    onClick: () => setExpandedWPs(prev => prev.includes(wp.id) ? prev.filter(i => i !== wp.id) : [...prev, wp.id])
  }, expandedWPs.includes(wp.id) ? React.createElement(Icon, {
    name: "chevron-down",
    size: 18
  }) : React.createElement(Icon, {
    name: "chevron-right",
    size: 18
  })), React.createElement("input", {
    className: "bg-transparent border-none font-black text-slate-800 focus:ring-0 p-0 max-w-[240px]",
    value: wp.name,
    onChange: e => updateTask(wp.id, null, 'name', null, e.target.value),
    disabled: currentProject.status === 'archived'
  }), React.createElement("button", {
    onClick: () => addTask(wp.id),
    className: "ml-4 text-[10px] font-black text-blue-600 uppercase hover:underline",
    disabled: currentProject.status === 'archived'
  }, "+ Add Task")), React.createElement("td", {
    colSpan: "3"
  }), React.createElement("td", {
    className: "px-3 py-3 text-center text-slate-300 hover:text-rose-500 cursor-pointer",
    onClick: () => deleteWP(wp.id)
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 16
  }))), expandedWPs.includes(wp.id) && wp.tasks.map(task => React.createElement("tr", {
    key: task.id,
    className: "border-b border-slate-50 hover:bg-slate-50/50"
  }, React.createElement("td", {
    className: "px-8 py-4"
  }, React.createElement("input", {
    className: "block w-full max-w-[260px] font-bold text-slate-700 bg-transparent border-none p-0 mb-1 focus:ring-0",
    value: task.name,
    onChange: e => updateTask(wp.id, task.id, 'name', null, e.target.value),
    disabled: currentProject.status === 'archived'
  }), React.createElement("div", {
    className: "text-[10px] text-slate-400"
  }, "Owner: ", task.owner)), React.createElement("td", {
    className: "px-3 py-4 text-center"
  }, React.createElement("input", {
    type: "number",
    className: "w-14 text-center font-black text-blue-600 bg-blue-50 border-none rounded py-1",
    value: task.progress,
    onChange: e => updateTask(wp.id, task.id, 'progress', null, Number(e.target.value) || 0),
    disabled: currentProject.status === 'archived'
  })), React.createElement("td", {
    className: "px-4 py-4 text-[11px] space-y-2"
  }, React.createElement("div", {
    className: "flex items-center justify-between gap-2 text-slate-500"
  }, React.createElement("span", {
    className: "font-bold"
  }, "P:"), React.createElement("input", {
    type: "number",
    className: "w-24 bg-white border border-slate-200 rounded px-2 py-1 text-right font-bold focus:ring-1 focus:ring-blue-500 outline-none",
    value: task.plan.cost,
    onChange: e => updateTask(wp.id, task.id, 'plan', 'cost', Number(e.target.value) || 0),
    disabled: currentProject.status === 'archived'
  })), React.createElement("div", {
    className: "flex items-center justify-between gap-2 text-slate-700"
  }, React.createElement("span", {
    className: "font-bold"
  }, "A:"), React.createElement("input", {
    type: "number",
    className: "w-24 bg-white border border-slate-200 rounded px-2 py-1 text-right font-bold focus:ring-1 focus:ring-blue-500 outline-none",
    value: task.actual.cost,
    onChange: e => updateTask(wp.id, task.id, 'actual', 'cost', Number(e.target.value) || 0),
    disabled: currentProject.status === 'archived'
  }))), React.createElement("td", {
    className: "px-4 py-4 text-[10px] space-y-2"
  }, React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("span", {
    className: "text-slate-400 w-9"
  }, "Plan"), React.createElement("input", {
    type: "date",
    className: "text-[10px] bg-white border border-slate-200 rounded px-1.5 py-1 focus:ring-1 focus:ring-blue-500 outline-none",
    value: task.plan.start,
    onChange: e => updateTask(wp.id, task.id, 'plan', 'start', e.target.value),
    disabled: currentProject.status === 'archived'
  }), React.createElement("span", {
    className: "text-slate-300"
  }, "~"), React.createElement("input", {
    type: "date",
    className: "text-[10px] bg-white border border-slate-200 rounded px-1.5 py-1 focus:ring-1 focus:ring-blue-500 outline-none",
    value: task.plan.end,
    onChange: e => updateTask(wp.id, task.id, 'plan', 'end', e.target.value),
    disabled: currentProject.status === 'archived'
  })), React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("span", {
    className: "text-blue-600 font-bold w-9"
  }, "Act"), React.createElement("input", {
    type: "date",
    className: "text-[10px] bg-white border border-blue-100 rounded px-1.5 py-1 focus:ring-1 focus:ring-blue-500 outline-none",
    value: task.actual.start,
    onChange: e => updateTask(wp.id, task.id, 'actual', 'start', e.target.value),
    disabled: currentProject.status === 'archived'
  }), React.createElement("span", {
    className: "text-slate-300"
  }, "~"), React.createElement("input", {
    type: "date",
    className: "text-[10px] bg-white border border-blue-100 rounded px-1.5 py-1 focus:ring-1 focus:ring-blue-500 outline-none",
    value: task.actual.end,
    onChange: e => updateTask(wp.id, task.id, 'actual', 'end', e.target.value),
    disabled: currentProject.status === 'archived'
  }))), React.createElement("td", {
    className: "px-3 py-4 text-center text-slate-200 hover:text-rose-500 cursor-pointer",
    onClick: () => deleteTask(wp.id, task.id)
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 16
  })))))), currentProject.status === 'active' && React.createElement("tr", null, React.createElement("td", {
    colSpan: "5",
    className: "p-6 text-center"
  }, React.createElement("button", {
    onClick: addWP,
    className: "text-sm font-black text-blue-600 border-2 border-dashed border-blue-100 px-6 py-3 rounded-2xl hover:bg-blue-50 flex items-center gap-2 mx-auto"
  }, React.createElement(Icon, {
    name: "plus",
    size: 18
  }), " \u65B0\u589E\u5DE5\u4F5C\u5305 (WBS Group)")))))) : React.createElement("div", {
    className: "p-8"
  }, React.createElement("div", {
    className: "flex border-b border-slate-100 mb-8 pb-4 font-black text-[10px] text-slate-400"
  }, React.createElement("div", {
    className: "w-64 shrink-0 uppercase tracking-widest"
  }, "WBS Tasks Timeline"), React.createElement("div", {
    className: "flex-1 flex justify-between px-4"
  }, MONTH_LABELS.map(m => React.createElement("div", {
    key: m,
    className: "flex-1 pl-3 border-l border-slate-50"
  }, m)))), React.createElement("div", {
    className: "space-y-8"
  }, currentProject.workPackages.map(wp => React.createElement("div", {
    key: wp.id,
    className: "space-y-5"
  }, React.createElement("div", {
    className: "flex items-center gap-4 text-xs font-black text-slate-800 uppercase tracking-tight"
  }, React.createElement("div", {
    className: "w-1.5 h-1.5 rounded-full bg-blue-600"
  }), " ", wp.name), wp.tasks.map(task => {
    const planS = getPosition(task.plan.start),
      planE = getPosition(task.plan.end);
    const actS = getPosition(task.actual.start),
      actE = getPosition(task.actual.end);
    return React.createElement("div", {
      key: task.id,
      className: "flex items-center group"
    }, React.createElement("div", {
      className: "w-64 shrink-0 pr-8 text-[11px] font-bold text-slate-600 truncate"
    }, task.name), React.createElement("div", {
      className: "flex-1 relative h-10 bg-slate-50 rounded-lg border-x border-slate-100 overflow-hidden"
    }, React.createElement("div", {
      className: "absolute h-1.5 bg-slate-200 rounded-full top-2 opacity-50",
      style: {
        left: `${planS}%`,
        width: `${Math.max(1, planE - planS)}%`
      }
    }), React.createElement("div", {
      className: `absolute h-4 rounded shadow-sm top-4 ${Number(task.progress) === 100 ? 'bg-emerald-500' : 'bg-blue-600'}`,
      style: {
        left: `${actS}%`,
        width: `${Math.max(1, actE - actS)}%`
      }
    }, React.createElement("div", {
      className: "absolute inset-y-0 left-0 bg-white/25",
      style: {
        width: `${task.progress}%`
      }
    }))));
  }))))))))), isCreateModalOpen && React.createElement("div", {
    className: "fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4"
  }, React.createElement("div", {
    className: "bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
  }, React.createElement("div", {
    className: "p-8 border-b border-slate-100 flex justify-between items-center"
  }, React.createElement("h3", {
    className: "text-xl font-black text-slate-800"
  }, "\u5EFA\u7ACB\u65B0\u5C08\u6848"), React.createElement("button", {
    onClick: () => setIsCreateModalOpen(false),
    className: "text-slate-300 hover:text-slate-600"
  }, React.createElement(Icon, {
    name: "x",
    size: 24
  }))), React.createElement("div", {
    className: "p-8 space-y-6"
  }, React.createElement("div", null, React.createElement("label", {
    className: "text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2"
  }, "Project Name"), React.createElement("input", {
    autoFocus: true,
    className: "w-full bg-slate-50 border-2 border-slate-100 rounded-2xl px-5 py-4 font-bold focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none",
    placeholder: "\u4F8B\u5982\uFF1A2026 \u5E74\u5EA6\u884C\u92B7\u8A08\u756B",
    value: newProjectName,
    onChange: e => setNewProjectName(e.target.value),
    onKeyDown: e => e.key === 'Enter' && handleCreateProject()
  })), React.createElement("button", {
    onClick: handleCreateProject,
    disabled: !newProjectName.trim(),
    className: "w-full py-4 bg-blue-600 disabled:bg-slate-200 text-white rounded-2xl font-black hover:bg-blue-700"
  }, "\u78BA\u8A8D\u5EFA\u7ACB\u5C08\u6848")))));
};
const MainApp = () => {
  const [showExportModal, setShowExportModal] = useState(false);
  const [posterGenerating, setPosterGenerating] = useState(false);
  const [showPosterActivitySelection, setShowPosterActivitySelection] = useState(false);
  const [posterActivityOptions, setPosterActivityOptions] = useState([]);
  const [posterSelectedNames, setPosterSelectedNames] = useState([]);
  const [pendingPosterData, setPendingPosterData] = useState(null);
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('events');
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [createEventPrefillInstructors, setCreateEventPrefillInstructors] = useState([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('crm_admin_sidebar_collapsed') === '1';
    } catch (e) {
      return false;
    }
  });
  const buildPlanningCellKey = (dateKey, instructorName) => `${String(dateKey || '').trim()}__${String(instructorName || '').trim()}`;
  const buildPlanningPlacementId = (dateKey, instructorName, eventName) => {
    const base = [dateKey, instructorName, eventName].map(value => String(value || '').trim()).filter(Boolean).join('__').replace(/[.\s/\\#?%]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return `${base || 'plan'}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  };
  const buildPlanningPlacementIdentity = (placement, fallback = '') => {
    const cleanId = String(placement?.id || '').trim();
    if (cleanId) return cleanId;
    const eventName = String(placement?.eventName || '').trim();
    const instructorName = String(placement?.instructorName || '').trim();
    const dateKey = String(placement?.dateKey || '').trim();
    return [buildPlanningCellKey(dateKey, instructorName), eventName, fallback].filter(Boolean).join('__');
  };
  const sortPlanningPlacements = (placements = []) => [...placements].sort((a, b) => (a.dateKey || '').localeCompare(b.dateKey || '') || (a.instructorName || '').localeCompare(b.instructorName || '', 'zh-Hant') || (a.eventName || '').localeCompare(b.eventName || '', 'zh-Hant') || (a.id || '').localeCompare(b.id || ''));
  const [showAddPromise, setShowAddPromise] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [editingEvent, setEditingEvent] = useState(null);
  const [editingRow, setEditingRow] = useState(null);
  const [eventsViewMode, setEventsViewMode] = useState('calendar');
  const [importSearch, setImportSearch] = useState('');
  const [promiseSearch, setPromiseSearch] = useState('');
  const [publicSearchTerm, setPublicSearchTerm] = useState('');
  const [globalRules, setGlobalRules] = useState(null);
  const [showGlobalRules, setShowGlobalRules] = useState(false);
  const [selectedPublicDate, setSelectedPublicDate] = useState(getLocalDateStr);
  const [publicDaySheetOpen, setPublicDaySheetOpen] = useState(false);
  const lastLocalTodayRef = useRef(getLocalDateStr());
  const [editingProject, setEditingProject] = useState(null);
  const [tagDefinitions, setTagDefinitions] = useState(DEFAULT_TAG_DEFS);
  const [showTagSettings, setShowTagSettings] = useState(false);
  const [performanceProductSettings, setPerformanceProductSettings] = useState({});
  const [monthlyKpis, setMonthlyKpis] = useState({});
  const [legacyMonthlyPlans, setLegacyMonthlyPlans] = useState({});
  const [storedMonthlyPlanDocs, setStoredMonthlyPlanDocs] = useState({});
  const [monthlyPlans, setMonthlyPlans] = useState({});
  const [currentMonthPlanVersions, setCurrentMonthPlanVersions] = useState([]);
  const [kpiSaveStatus, setKpiSaveStatus] = useState('idle');
  const [planningSaveStatus, setPlanningSaveStatus] = useState('idle');
  const [planningOperatorName, setPlanningOperatorName] = useState(() => {
    try {
      return localStorage.getItem('crm_planning_operator_name') || '';
    } catch (e) {
      return '';
    }
  });
  const [eventScheduleVersions, setEventScheduleVersions] = useState([]);
  const [eventVersionStatus, setEventVersionStatus] = useState({
    status: 'idle',
    message: '',
    at: ''
  });
  const [eventVersionOperatorName, setEventVersionOperatorName] = useState(() => {
    try {
      return localStorage.getItem('crm_event_version_operator_name') || '';
    } catch (e) {
      return '';
    }
  });
  const [eventVersionsExpanded, setEventVersionsExpanded] = useState(false);
  const [publicFilters, setPublicFilters] = useState({
    level: [],
    type: [],
    location: []
  });
  const [publicFiltersExpanded, setPublicFiltersExpanded] = useState(false);
  const [dbSource, setDbSource] = useState(() => localStorage.getItem('crm_db_source') || defaultAppId);
  const [isEditingCSV, setIsEditingCSV] = useState(false);
  const isEditingRef = useRef(false);
  const [csvInput, setCsvInput] = useState('');
  const [parsedData, setParsedData] = useState([]);
  const [eventConfigs, setEventConfigs] = useState({});
  const [customTemplates, setCustomTemplates] = useState([]);
  const [templatesLoadState, setTemplatesLoadState] = useState('idle');
  const [templatesReloadSeed, setTemplatesReloadSeed] = useState(0);
  const [projects, setProjects] = useState([]);
  const [promises, setPromises] = useState([]);
  const [instructorSchedule, setInstructorSchedule] = useState({});
  const [companyRestDates, setCompanyRestDates] = useState([]);
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [passwordSaveStatus, setPasswordSaveStatus] = useState('idle');
  const [authAccounts, setAuthAccounts] = useState([]);
  const [newAuthAccount, setNewAuthAccount] = useState({
    name: '',
    password: ''
  });
  const [authAccountsSaveStatus, setAuthAccountsSaveStatus] = useState('idle');
  const [addRegStatus, setAddRegStatus] = useState('idle');
  const [csvSaveStatus, setCsvSaveStatus] = useState('idle');
  const [isHealthChecking, setIsHealthChecking] = useState(false);
  const [firebaseHealth, setFirebaseHealth] = useState({
    status: 'idle',
    message: '尚未執行檢查',
    checkedAt: ''
  });
  const [eventDeleteStatus, setEventDeleteStatus] = useState({
    status: 'idle',
    message: '',
    at: ''
  });
  const [viewMode, setViewMode] = useState('public');
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authReady, setAuthReady] = useState(() => !!auth);
  const [adminPassword, setAdminPassword] = useState('8888');
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [currentDate, setCurrentDate] = useState(() => parseLocalDateKey(getLocalDateStr()));
  useEffect(() => {
    const syncLocalToday = () => {
      const nextToday = getLocalDateStr();
      const previousToday = lastLocalTodayRef.current;
      if (nextToday === previousToday) return;
      lastLocalTodayRef.current = nextToday;
      setSelectedPublicDate(dateKey => dateKey === previousToday ? nextToday : dateKey);
      setCurrentDate(date => formatLocalDateKey(date) === previousToday ? parseLocalDateKey(nextToday) : date);
    };
    syncLocalToday();
    const timer = setInterval(syncLocalToday, 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  const [crmSearchTerm, setCrmSearchTerm] = useState('');
  const [crmRankMode, setCrmRankMode] = useState('ltv');
  const [showCrmDropdown, setShowCrmDropdown] = useState(false);
  const [newReg, setNewReg] = useState({
    date: getLocalDateStr(),
    eventName: '',
    instructor: '',
    customerName: '',
    price: '',
    transport: '',
    idNo: '',
    birthday: '',
    email: '',
    source: '',
    orderDate: getLocalDateStr(),
    phone: ''
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const planningDirtyMonthsRef = useRef(new Set());
  const publicConfigSyncHashRef = useRef('');
  const [latestNews, setLatestNews] = useState('');
  const [marqueeIconHistory, setMarqueeIconHistory] = useState([]);
  const [marqueeBgColor, setMarqueeBgColor] = useState('#0f172a');
  const [marqueeTextColor, setMarqueeTextColor] = useState('#ffffff');
  const [marqueeIconSize, setMarqueeIconSize] = useState(24);
  const [marqueeSpeed, setMarqueeSpeed] = useState(20);
  const [marqueeIcon, setMarqueeIcon] = useState('');
  const [mascotConfig, setMascotConfig] = useState([]);
  const [showMascotSettings, setShowMascotSettings] = useState(false);
  const [outingPosterConfig, setOutingPosterConfig] = useState(DEFAULT_OUTING_POSTER_CONFIG);
  const [showOutingPosterSettings, setShowOutingPosterSettings] = useState(false);
  const [posterNameOverrides, setPosterNameOverrides] = useState(DEFAULT_POSTER_NAME_OVERRIDES);
  const [showPosterNameSettings, setShowPosterNameSettings] = useState(false);
  const [outingDays, setOutingDays] = useState({});
  const [internalDays, setInternalDays] = useState({});
  const [publicTheme, setPublicTheme] = useState(DEFAULT_PUBLIC_THEME);
  const [publicSideDecor, setPublicSideDecor] = useState(DEFAULT_PUBLIC_SIDE_DECOR);
  const [selectedOutingPosterRandom, setSelectedOutingPosterRandom] = useState(null);
  const [publicDateEntryNonce, setPublicDateEntryNonce] = useState(0);
  const shouldBootstrapAuth = showLoginModal || viewMode === 'admin';
  const canLoadAdminData = !!user && (!shouldBootstrapAuth || authReady);
  const handleDbSourceChange = newSource => {
    setDbSource(newSource);
    localStorage.setItem('crm_db_source', newSource);
  };
  const uniqueTransports = useMemo(() => {
    const defaults = ['共乘', '自行前往'];
    const existing = new Set(parsedData.map(r => r.transport).filter(Boolean));
    return Array.from(new Set([...defaults, ...existing]));
  }, [parsedData]);
  const formatFirestoreError = error => {
    if (!error) return '未知錯誤';
    const code = error.code ? ` (${error.code})` : '';
    return `${error.message || '未知錯誤'}${code}`;
  };
  const pushEventDeleteStatus = (status, message) => {
    setEventDeleteStatus({
      status,
      message,
      at: new Date().toLocaleTimeString('zh-TW')
    });
  };
  const withTimeout = async (promise, ms, stage) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject({
          code: 'deadline-exceeded',
          message: `${stage}逾時（${ms}ms）`
        }), ms);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const toFirestoreFieldValue = value => {
    if (value === null || value === undefined) return {
      nullValue: null
    };
    if (typeof value === 'boolean') return {
      booleanValue: value
    };
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return {
        integerValue: String(value)
      };
      return {
        doubleValue: value
      };
    }
    return {
      stringValue: String(value)
    };
  };
  const fromFirestoreFieldValue = fieldNode => {
    if (!fieldNode) return null;
    if (Object.prototype.hasOwnProperty.call(fieldNode, 'stringValue')) return fieldNode.stringValue;
    if (Object.prototype.hasOwnProperty.call(fieldNode, 'integerValue')) return Number(fieldNode.integerValue);
    if (Object.prototype.hasOwnProperty.call(fieldNode, 'doubleValue')) return Number(fieldNode.doubleValue);
    if (Object.prototype.hasOwnProperty.call(fieldNode, 'booleanValue')) return !!fieldNode.booleanValue;
    if (Object.prototype.hasOwnProperty.call(fieldNode, 'nullValue')) return null;
    return null;
  };
  const getCurrentIdToken = async () => {
    const authInstance = await ensureFirebaseAuthReady();
    const currentUser = authInstance.currentUser;
    if (!currentUser) throw {
      code: 'unauthenticated',
      message: '尚未登入匿名帳號'
    };
    return currentUser.getIdToken(true);
  };
  const patchMainDocViaRest = async partialFields => {
    const keys = Object.keys(partialFields || {});
    if (keys.length === 0) return null;
    const token = await getCurrentIdToken();
    const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/artifacts/${encodeURIComponent(dbSource)}/public/data/settings/main?${mask}`;
    const body = {
      fields: {}
    };
    keys.forEach(k => {
      body.fields[k] = toFirestoreFieldValue(partialFields[k]);
    });
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw {
        code: `http-${res.status}`,
        message: `REST PATCH 失敗: ${text.slice(0, 200) || res.statusText}`
      };
    }
    return res.json().catch(() => null);
  };
  const getMainDocViaRest = async () => {
    const token = await getCurrentIdToken();
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/artifacts/${encodeURIComponent(dbSource)}/public/data/settings/main`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw {
        code: `http-${res.status}`,
        message: `REST GET 失敗: ${text.slice(0, 200) || res.statusText}`
      };
    }
    const json = await res.json();
    const fields = json?.fields || {};
    const out = {};
    Object.keys(fields).forEach(k => {
      out[k] = fromFirestoreFieldValue(fields[k]);
    });
    return out;
  };
  const handleFirebaseHealthCheck = async () => {
    const checkedAt = new Date().toLocaleString('zh-TW');
    if (!db || !user) {
      setFirebaseHealth({
        status: 'error',
        message: '資料庫未連線或尚未登入匿名帳號',
        checkedAt
      });
      return;
    }
    setIsHealthChecking(true);
    setFirebaseHealth({
      status: 'checking',
      message: '檢查中，請稍候...',
      checkedAt
    });
    const csvBytes = new Blob([String(csvInput || '')]).size;
    const maxDocBytes = 1024 * 1024;
    const sizeRatio = (csvBytes / maxDocBytes * 100).toFixed(1);
    const probeValue = `probe_${Date.now()}`;
    const mainRef = doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main');
    try {
      let writeMode = 'sdk';
      try {
        await withTimeout(setDoc(mainRef, {
          _healthPing: probeValue,
          _healthPingAt: new Date().toISOString(),
          _healthSource: dbSource,
          _healthUid: user.uid || 'anonymous'
        }, {
          merge: true
        }), 10000, '寫入 settings/main');
        if (typeof db.waitForPendingWrites === 'function') {
          await withTimeout(db.waitForPendingWrites(), 10000, '等待雲端同步');
        }
      } catch (writeErr) {
        if (!String(writeErr?.code || '').includes('deadline-exceeded')) throw writeErr;
        writeMode = 'rest';
        await withTimeout(patchMainDocViaRest({
          _healthPing: probeValue,
          _healthPingAt: new Date().toISOString(),
          _healthSource: dbSource,
          _healthUid: user.uid || 'anonymous'
        }), 15000, 'REST 備援寫入 settings/main');
      }
      let serverVisible = true;
      let pingMatched = false;
      let readMode = 'sdk';
      try {
        const serverSnap = await withTimeout(mainRef.get({
          source: 'server'
        }), 10000, '伺服器讀取 settings/main');
        serverVisible = !!(serverSnap && serverSnap.exists);
        pingMatched = !!(serverSnap && serverSnap.exists && serverSnap.data && serverSnap.data()?._healthPing === probeValue);
      } catch (readErr) {
        if (!String(readErr?.code || '').includes('deadline-exceeded')) throw readErr;
        readMode = 'rest';
        const restDoc = await withTimeout(getMainDocViaRest(), 15000, 'REST 備援讀取 settings/main');
        serverVisible = !!restDoc;
        pingMatched = !!(restDoc && restDoc._healthPing === probeValue);
      }
      const sizeHint = csvBytes > 980000 ? '；CSV 已接近 1MB 上限，可能造成儲存失敗' : csvBytes > 800000 ? '；CSV 偏大，建議分拆資料' : '';
      const modeHint = `；通道=${writeMode}/${readMode}`;
      if (!serverVisible) {
        setFirebaseHealth({
          status: 'warning',
          message: `寫入後無法由伺服器讀回 settings/main（來源：${dbSource}）${modeHint}`,
          checkedAt
        });
      } else if (!pingMatched) {
        setFirebaseHealth({
          status: 'warning',
          message: `伺服器可讀，但健康檢查標記未吻合（來源：${dbSource}）${modeHint}`,
          checkedAt
        });
      } else {
        setFirebaseHealth({
          status: 'success',
          message: `settings/main 寫入/讀回測試成功（來源：${dbSource}，CSV ${csvBytes} bytes，約 ${sizeRatio}%）${sizeHint}${modeHint}`,
          checkedAt
        });
      }
    } catch (e) {
      const reason = formatFirestoreError(e);
      let hint = '';
      if (String(e?.code || '').includes('permission-denied')) hint = '（規則權限不足）';
      if (String(e?.code || '').includes('unauthenticated')) hint = '（匿名登入可能被停用）';
      if (String(e?.code || '').includes('resource-exhausted')) hint = '（配額或大小限制）';
      if (String(e?.code || '').includes('deadline-exceeded')) hint = '（網路不穩或 Firebase 未回應）';
      if (window.location.protocol === 'file:') hint += '（目前以 file:// 開啟，建議改用 http://localhost）';
      setFirebaseHealth({
        status: 'error',
        message: `健康檢查失敗：${reason}${hint}`,
        checkedAt
      });
    } finally {
      setIsHealthChecking(false);
    }
  };
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    setUser(prev => prev || {
      isAnonymous: true,
      uid: 'demo'
    });
    if (!shouldBootstrapAuth) return () => {};
    ensureFirebaseAuthReady().then(authInstance => {
      if (cancelled) return;
      setAuthReady(true);
      unsub = onAuthStateChanged(authInstance, nextUser => {
        if (cancelled) return;
        setUser(nextUser || {
          isAnonymous: true,
          uid: 'demo'
        });
      });
      if (!authInstance.currentUser) {
        signInAnonymously(authInstance).catch(error => {
          console.warn('Anonymous auth bootstrap failed:', error);
        });
      }
    }).catch(error => {
      if (cancelled) return;
      console.warn('Firebase auth lazy bootstrap failed:', error);
      setAuthReady(false);
    });
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [shouldBootstrapAuth]);
  const shouldLoadAuthSettings = showLoginModal || viewMode === 'admin';
  const shouldLoadTemplates = viewMode === 'admin' && (activeTab === 'events' || activeTab === 'planning' || showCreateEvent || !!editingEvent);
  const shouldLoadMonthlyPlans = viewMode === 'admin' && activeTab === 'planning';
  const shouldLoadProjects = viewMode === 'admin' && activeTab === 'projects';
  const shouldLoadPromises = viewMode === 'admin' && activeTab === 'promises';
  useEffect(() => {
    if (!user) return undefined;
    setLoading(true);
    const basePath = `artifacts/${dbSource}/public/data`;
    if (!db) {
      setLoading(false);
      console.warn("Running in offline/demo mode");
      return undefined;
    }
    const updateParsedData = raw => {
      try {
        setParsedData(parseCsvDataRows(raw));
      } catch (e) {
        console.error(e);
      }
    };
    const mainRef = doc(db, basePath, 'settings', 'main');
    const configsRef = collection(db, basePath, 'event_configs');
    const publicConfigsRef = doc(db, basePath, 'settings', 'public_event_configs');
    const scheduleRef = doc(db, basePath, 'settings', 'schedule');
    const applyConfigSnapshot = s => {
      const cfgs = {};
      if (s) s.forEach(d => {
        const rawConfig = sanitizeFirebaseValue(d.data() || {});
        cfgs[d.id] = normalizeEventConfigForDisplay(rawConfig);
      });
      setEventConfigs(cfgs);
    };
    const applyPublicConfigData = rawData => {
      const rawConfigs = sanitizeFirebaseValue(rawData || {})?.configs || {};
      const cfgs = {};
      Object.entries(rawConfigs || {}).forEach(([key, rawConfig]) => {
        cfgs[key] = normalizeEventConfigForDisplay(rawConfig || {});
      });
      setEventConfigs(cfgs);
      return Object.keys(cfgs).length;
    };
    const unsubMain = onSnapshot(mainRef, s => {
      if (s && s.exists()) {
        const data = sanitizeFirebaseValue(s.data() || {});
        const d = data.csvData || '';
        if (Array.isArray(data.globalRules)) {
          const cleanedGlobalRules = normalizeStoredStatusRules(data.globalRules);
          setGlobalRules(cleanedGlobalRules);
        }
        if (data.tagDefinitions) setTagDefinitions(normalizeTagDefinitionsForDisplay(data.tagDefinitions));
        setPerformanceProductSettings(data.performanceProductSettings || {});
        setMonthlyKpis(data.monthlyKpis || {});
        setLegacyMonthlyPlans(data.monthlyPlans || {});
        if (data.latestNews) setLatestNews(data.latestNews);
        if (data.marqueeSpeed) setMarqueeSpeed(data.marqueeSpeed);
        if (data.marqueeIcon) setMarqueeIcon(data.marqueeIcon);
        if (data.marqueeIconHistory) setMarqueeIconHistory(data.marqueeIconHistory);
        if (data.marqueeBgColor) setMarqueeBgColor(data.marqueeBgColor);
        if (data.marqueeTextColor) setMarqueeTextColor(data.marqueeTextColor);
        if (data.marqueeIconSize) setMarqueeIconSize(data.marqueeIconSize);
        if (data.mascotConfig) setMascotConfig(data.mascotConfig);
        if (Array.isArray(data.outingPosterConfig)) setOutingPosterConfig(data.outingPosterConfig);
        if (Array.isArray(data.posterNameOverrides)) setPosterNameOverrides(normalizePosterNameOverrides(data.posterNameOverrides));
        if (data.publicTheme) setPublicTheme(normalizePublicTheme(data.publicTheme));
        if (data.publicSideDecor) setPublicSideDecor(normalizePublicSideDecor(data.publicSideDecor));
        if (!isEditingRef.current) {
          setCsvInput(d);
          updateParsedData(d);
        }
      } else {
        setPerformanceProductSettings({});
        setMonthlyKpis({});
        setLegacyMonthlyPlans({});
        if (!isEditingRef.current) {
          setCsvInput('');
          setParsedData([]);
        }
      }
      setLoading(false);
    });
    let unsubConfigFallback = null;
    const unsubConfigs = viewMode === 'public' ? onSnapshot(publicConfigsRef, s => {
      const publicConfigCount = s && s.exists() ? applyPublicConfigData(s.data() || {}) : 0;
      if (publicConfigCount > 0) {
        if (unsubConfigFallback) {
          unsubConfigFallback();
          unsubConfigFallback = null;
        }
        return;
      }
      if (!unsubConfigFallback) {
        unsubConfigFallback = onSnapshot(configsRef, applyConfigSnapshot);
      }
    }, error => {
      console.warn('Public event config cache failed, fallback to full configs:', error);
      if (!unsubConfigFallback) {
        unsubConfigFallback = onSnapshot(configsRef, applyConfigSnapshot);
      }
    }) : onSnapshot(configsRef, applyConfigSnapshot);
    const cleanupConfigs = () => {
      if (typeof unsubConfigs === 'function') unsubConfigs();
      if (typeof unsubConfigFallback === 'function') unsubConfigFallback();
    };
    const unsubSchedule = onSnapshot(scheduleRef, s => {
      if (s && s.exists()) {
        const scheduleData = sanitizeFirebaseValue(s.data() || {});
        setInstructorSchedule(scheduleData.resting || {});
        setCompanyRestDates(scheduleData.companyRest || []);
        setOutingDays(scheduleData.outingDays || {});
        setInternalDays(scheduleData.internalDays || {});
      } else {
        setInstructorSchedule({});
        setCompanyRestDates([]);
        setOutingDays({});
        setInternalDays({});
      }
    });
    return () => {
      if (unsubMain) unsubMain();
      cleanupConfigs();
      if (unsubSchedule) unsubSchedule();
    };
  }, [user, db, dbSource, viewMode]);
  useEffect(() => {
    if (!db || !user || viewMode !== 'admin' || !canLoadAdminData) return undefined;
    const normalizedConfigs = {};
    Object.entries(eventConfigs || {}).forEach(([key, cfg]) => {
      normalizedConfigs[key] = buildPublicEventConfigCacheEntry(cfg || {});
    });
    const configKeys = Object.keys(normalizedConfigs);
    if (configKeys.length === 0) return undefined;
    const syncHash = JSON.stringify(normalizedConfigs);
    const storageKey = `crm_public_event_configs_hash_${dbSource}`;
    let storedHash = '';
    try {
      storedHash = localStorage.getItem(storageKey) || '';
    } catch (_) {}
    if (syncHash === storedHash || syncHash === publicConfigSyncHashRef.current) return undefined;
    const timer = setTimeout(async () => {
      try {
        await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'public_event_configs'), {
          configs: normalizedConfigs,
          updatedAt: new Date().toISOString(),
          count: configKeys.length
        });
        publicConfigSyncHashRef.current = syncHash;
        try {
          localStorage.setItem(storageKey, syncHash);
        } catch (_) {}
      } catch (e) {
        console.warn('Public event config cache sync failed:', e);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [db, user, dbSource, viewMode, canLoadAdminData, eventConfigs]);
  useEffect(() => {
    if (!canLoadAdminData || !shouldLoadAuthSettings) return undefined;
    if (!db) {
      setAdminPassword('8888');
      setAuthAccounts(normalizeAuthAccounts([], '8888'));
      return undefined;
    }
    const settingsRef = doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'auth');
    return onSnapshot(settingsRef, s => {
      if (s && s.exists()) {
        const authData = sanitizeFirebaseValue(s.data() || {});
        const fallbackPassword = authData.password || '8888';
        setAdminPassword(fallbackPassword);
        setAuthAccounts(normalizeAuthAccounts(authData.accounts, fallbackPassword));
      } else {
        setAdminPassword('8888');
        setAuthAccounts(normalizeAuthAccounts([], '8888'));
      }
    });
  }, [canLoadAdminData, db, dbSource, shouldLoadAuthSettings]);
  useEffect(() => {
    if (!shouldLoadTemplates) {
      setTemplatesLoadState(current => current === 'loading' ? 'idle' : current);
      return undefined;
    }
    if (!canLoadAdminData) {
      const authWaitTimer = setTimeout(() => {
        setTemplatesLoadState(current => current === 'loading' ? 'error' : current);
      }, 10000);
      return () => clearTimeout(authWaitTimer);
    }
    if (!db) {
      setTemplatesLoadState('error');
      return undefined;
    }
    setTemplatesLoadState('loading');
    const templatesRef = doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'templates');
    const cacheKey = `crm_templates_cache_${dbSource}`;
    const applyTemplatesData = rawData => {
      const rawTemplates = sanitizeFirebaseValue(rawData || {})?.list || [];
      const cleanedTemplates = (Array.isArray(rawTemplates) ? rawTemplates : []).map(tpl => {
        return normalizeQuickCreateTemplate(tpl);
      });
      setCustomTemplates(cleanedTemplates);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cleanedTemplates));
      } catch (_) {}
      setTemplatesLoadState('success');
    };
    try {
      const cachedTemplates = JSON.parse(localStorage.getItem(cacheKey) || '[]');
      if (Array.isArray(cachedTemplates) && cachedTemplates.length > 0) {
        setCustomTemplates(cachedTemplates.map(tpl => normalizeQuickCreateTemplate(tpl)));
      }
    } catch (_) {}
    let cancelled = false;
    let didResolveInitialLoad = false;
    const timeoutTimer = setTimeout(() => {
      if (didResolveInitialLoad) return;
      console.warn('Template initial load timed out');
      setTemplatesLoadState('error');
    }, 15000);
    const resolveInitialLoad = rawData => {
      if (cancelled) return;
      didResolveInitialLoad = true;
      clearTimeout(timeoutTimer);
      applyTemplatesData(rawData || {});
    };
    const readTemplatesOnce = async () => {
      try {
        const snap = await withTimeout(templatesRef.get({
          source: 'server'
        }), 7000, '讀取模板');
        if (didResolveInitialLoad || cancelled) return;
        resolveInitialLoad(snap && snap.exists ? snap.data() || {} : {});
      } catch (sdkError) {
        console.warn('Template one-time SDK read failed, trying REST:', sdkError);
        try {
          const restDoc = await withTimeout(restGetDoc(templatesRef.path), 10000, 'REST 讀取模板');
          if (didResolveInitialLoad || cancelled) return;
          resolveInitialLoad(restDoc || {});
        } catch (restError) {
          console.error('Template one-time read failed:', restError);
          if (!didResolveInitialLoad && !cancelled) {
            clearTimeout(timeoutTimer);
            setTemplatesLoadState('error');
          }
        }
      }
    };
    readTemplatesOnce();
    return () => {
      cancelled = true;
      clearTimeout(timeoutTimer);
    };
  }, [canLoadAdminData, db, dbSource, shouldLoadTemplates, templatesReloadSeed]);
  useEffect(() => {
    if (!canLoadAdminData || !shouldLoadMonthlyPlans || !db) return undefined;
    const monthlyPlansRef = collection(db, `artifacts/${dbSource}/public/data`, 'monthly_plans');
    return onSnapshot(monthlyPlansRef, s => {
      const nextPlans = {};
      if (s) s.forEach(d => {
        nextPlans[d.id] = sanitizeFirebaseValue(d.data() || {});
      });
      setStoredMonthlyPlanDocs(nextPlans);
    });
  }, [canLoadAdminData, db, dbSource, shouldLoadMonthlyPlans]);
  useEffect(() => {
    if (!canLoadAdminData || !shouldLoadProjects || !db) return undefined;
    const projectsRef = collection(db, `artifacts/${dbSource}/public/data`, 'projects');
    return onSnapshot(projectsRef, s => {
      const nextProjects = [];
      if (s) s.forEach(d => nextProjects.push({
        id: d.id,
        ...sanitizeFirebaseValue(d.data() || {})
      }));
      setProjects(nextProjects);
    });
  }, [canLoadAdminData, db, dbSource, shouldLoadProjects]);
  useEffect(() => {
    if (!canLoadAdminData || !shouldLoadPromises || !db) return undefined;
    const promisesRef = collection(db, `artifacts/${dbSource}/public/data`, 'promises');
    return onSnapshot(promisesRef, s => {
      const nextPromises = [];
      if (s) s.forEach(d => nextPromises.push({
        id: d.id,
        ...sanitizeFirebaseValue(d.data() || {})
      }));
      setPromises(nextPromises.sort((a, b) => new Date(a.date + 'T' + a.time) - new Date(b.date + 'T' + b.time)));
    });
  }, [canLoadAdminData, db, dbSource, shouldLoadPromises]);
  const validAdminPasswords = useMemo(() => Array.from(new Set([String(adminPassword || '').trim(), ...authAccounts.map(account => String(account.password || '').trim())].filter(Boolean))), [adminPassword, authAccounts]);
  const handleVerifyLogin = (inputPwd, callback) => {
    const cleanInput = String(inputPwd || '').trim();
    const matchedAccount = authAccounts.find(account => account.password === cleanInput);
    if (matchedAccount || cleanInput === adminPassword) {
      const operatorName = String(matchedAccount?.name || DEFAULT_AUTH_ACCOUNT_NAME).trim() || DEFAULT_AUTH_ACCOUNT_NAME;
      setPlanningOperatorName(operatorName);
      setEventVersionOperatorName(operatorName);
      setViewMode('admin');
      setShowLoginModal(false);
      callback(true);
      return;
    }
    callback(false);
  };
  const handleUpdatePassword = async () => {
    if (!newPasswordInput) return;
    setPasswordSaveStatus('saving');
    try {
      const ref = doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'auth');
      if (ref) await setDoc(ref, {
        password: newPasswordInput
      }, {
        merge: true
      });
      setNewPasswordInput('');
      setPasswordSaveStatus('success');
      setTimeout(() => setPasswordSaveStatus('idle'), 2000);
    } catch (e) {
      console.error("Password update failed", e);
      setPasswordSaveStatus('idle');
    }
  };
  const handleSaveAuthAccounts = async nextAccounts => {
    if (!db) return;
    const normalizedAccounts = normalizeAuthAccounts(nextAccounts, adminPassword);
    setAuthAccountsSaveStatus('saving');
    try {
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'auth'), {
        accounts: normalizedAccounts
      }, {
        merge: true
      });
      setAuthAccounts(normalizedAccounts);
      setAuthAccountsSaveStatus('success');
      setTimeout(() => setAuthAccountsSaveStatus('idle'), 2000);
    } catch (e) {
      console.error('Auth accounts update failed', e);
      setAuthAccountsSaveStatus('idle');
      alert(`❌ 操作人帳號儲存失敗：${formatFirestoreError(e)}`);
    }
  };
  const handleAddAuthAccount = async () => {
    const name = String(newAuthAccount.name || '').trim();
    const password = String(newAuthAccount.password || '').trim();
    if (!name || !password) return;
    const nextAccounts = [...authAccounts, {
      id: `auth_${Date.now()}`,
      name,
      password
    }];
    await handleSaveAuthAccounts(nextAccounts);
    setNewAuthAccount({
      name: '',
      password: ''
    });
  };
  const handleDeleteAuthAccount = async accountId => {
    if (!confirm('確定要刪除這組登入密碼對應嗎？')) return;
    await handleSaveAuthAccounts(authAccounts.filter(account => account.id !== accountId));
  };
  const handleExportCurrentCsvAsTxt = () => {
    const rawContent = String(csvInput || '').trim();
    if (!rawContent) {
      alert('目前沒有可匯出的 CSV 資料。');
      return;
    }
    downloadTextFile(csvInput, `${sanitizeFilename(getLocalDateStr(), 'calendar_export')}.txt`);
  };
  const handleTogglePosterSelectedName = name => {
    setPosterSelectedNames(prev => prev.includes(name) ? prev.filter(item => item !== name) : [...prev, name]);
  };
  const resetPosterActivitySelection = () => {
    setShowPosterActivitySelection(false);
    setPosterActivityOptions([]);
    setPosterSelectedNames([]);
    setPendingPosterData(null);
  };
  const handleOpenMonthlyPosterGenerator = async () => {
    try {
      setPosterGenerating(true);
      await ensurePosterAssetsLoaded();
      const posterData = buildMonthlySchedulePosterData({
        currentDate,
        events: stats.events,
        eventConfigs,
        posterNameOverrides
      });
      if (posterData.entryCount === 0) {
        alert(`目前 ${posterData.year} 年 ${posterData.month + 1} 月沒有可生成的活動資料。`);
        return;
      }
      const options = buildPosterActivityOptions(posterData);
      setPendingPosterData(posterData);
      setPosterActivityOptions(options);
      setPosterSelectedNames(options.map(option => option.name));
      setShowPosterActivitySelection(true);
    } catch (e) {
      console.error('Prepare monthly poster failed', e);
      alert(`月曆海報準備失敗：${e?.message || e}`);
    } finally {
      setPosterGenerating(false);
    }
  };
  const handleGenerateMonthlyPoster = async () => {
    if (!pendingPosterData) {
      await handleOpenMonthlyPosterGenerator();
      return;
    }
    const selectedNames = posterSelectedNames.length > 0 ? posterSelectedNames : posterActivityOptions.map(option => option.name);
    if (selectedNames.length === 0) {
      alert('請至少選擇一個要顯示在月曆海報上的活動。');
      return;
    }
    try {
      setPosterGenerating(true);
      await ensurePosterAssetsLoaded();
      const posterData = filterMonthlySchedulePosterData(pendingPosterData, selectedNames);
      if (posterData.entryCount === 0) {
        alert('你目前勾選的活動沒有可輸出的月曆內容，請重新選擇。');
        return;
      }
      const canvas = await renderMonthlySchedulePosterCanvas(posterData);
      const htmlMarkup = buildMonthlySchedulePosterHtmlDocument(posterData);
      const filename = sanitizeFilename(`${posterData.title}_${getLocalDateStr()}`, `monthly_schedule_${getLocalDateStr()}`);
      if (canvas.toBlob) {
        const blob = await new Promise((resolve, reject) => {
          try {
            canvas.toBlob(result => {
              if (!result) {
                reject(new Error('Canvas 無法輸出 PNG Blob'));
                return;
              }
              resolve(result);
            }, 'image/png');
          } catch (blobError) {
            reject(blobError);
          }
        });
        downloadBlobFile(blob, `${filename}.png`);
      } else {
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${filename}.png`;
        link.click();
      }
      downloadBlobFile(new Blob([htmlMarkup], {
        type: 'text/html;charset=utf-8'
      }), `${filename}.html`);
      resetPosterActivitySelection();
    } catch (e) {
      console.error('Generate monthly poster failed', e);
      alert(`月曆海報生成失敗：${e?.message || e}`);
    } finally {
      setPosterGenerating(false);
    }
  };
	  const handleToggleInstructorRest = async (date, name, slot = 'all') => {
	    if (!user || !db) return;
	    const newResting = toggleScheduleRestEntry(instructorSchedule[date], name, slot);
	    const newSchedule = {
	      ...instructorSchedule
	    };
	    if (getAllScheduleRestNames(newResting).length > 0) {
	      newSchedule[date] = newResting;
	    } else {
	      newSchedule[date] = [];
    }
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      resting: newSchedule
    }, {
      merge: true
    });
  };
  const handleToggleCompanyRest = async date => {
    if (!user || !db) return;
    const isResting = companyRestDates.includes(date);
    let newDates;
    if (isResting) {
      newDates = companyRestDates.filter(d => d !== date);
    } else {
      newDates = [...companyRestDates, date].sort();
    }
    setCompanyRestDates(newDates);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      companyRest: newDates
    }, {
      merge: true
    });
  };
  const handleToggleOutingDay = async date => {
    if (!user || !db) return;
    const current = outingDays[date];
    const next = {
      ...outingDays
    };
    if (current && current.enabled) {
      delete next[date];
    } else {
      next[date] = {
        enabled: true,
        posterFilename: current?.posterFilename || '',
        people: current?.people || []
      };
    }
    setOutingDays(next);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      outingDays: next
    }, {
      merge: true
    });
  };
  const handleToggleInternalDay = async date => {
    if (!user || !db) return;
    const current = internalDays[date];
    const next = {
      ...internalDays
    };
    if (current && current.enabled) {
      delete next[date];
    } else {
      next[date] = {
        enabled: true,
        label: current?.label || '內部活動'
      };
    }
    setInternalDays(next);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      internalDays: next
    }, {
      merge: true
    });
  };
  const handleSetInternalLabel = async (date, label) => {
    if (!user || !db) return;
    const next = {
      ...internalDays,
      [date]: {
        enabled: true,
        label: String(label || '').trim()
      }
    };
    setInternalDays(next);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      internalDays: next
    }, {
      merge: true
    });
  };
  const handleSetOutingPoster = async (date, posterFilename) => {
    if (!user || !db) return;
    const next = {
      ...outingDays,
      [date]: {
        enabled: true,
        posterFilename: posterFilename || '',
        people: outingDays[date]?.people || []
      }
    };
    setOutingDays(next);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      outingDays: next
    }, {
      merge: true
    });
  };
  const handleToggleOutingPerson = async (date, name) => {
    if (!user || !db) return;
    const current = outingDays[date] || {
      enabled: true,
      posterFilename: '',
      people: []
    };
    const currentPeople = Array.isArray(current.people) ? current.people : [];
    const nextPeople = currentPeople.includes(name) ? currentPeople.filter(n => n !== name) : [...currentPeople, name];
    const next = {
      ...outingDays,
      [date]: {
        enabled: true,
        posterFilename: current.posterFilename || '',
        people: nextPeople
      }
    };
    setOutingDays(next);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'schedule'), {
      outingDays: next
    }, {
      merge: true
    });
  };
  const handleApplyThemePreset = presetId => {
    const preset = PUBLIC_THEME_PRESETS.find(p => p.id === presetId);
    if (preset) setPublicTheme(normalizePublicTheme(preset.values));
  };
  const handleSavePublicTheme = async () => {
    if (!user || !db) return alert("請先登入");
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
      publicTheme: normalizePublicTheme(publicTheme)
    }, {
      merge: true
    });
    alert("前台主題已更新！");
  };
  const handleSavePublicSideDecor = async () => {
    if (!user || !db) return alert("請先登入");
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
      publicSideDecor: normalizePublicSideDecor(publicSideDecor)
    }, {
      merge: true
    });
    alert("活動場次表左右裝飾圖已更新！");
  };
  const handleSavePerformanceProductSettings = async nextSettings => {
    if (!user || !db) return alert("請先登入");
    const normalized = {};
    Object.entries(nextSettings || {}).forEach(([name, setting]) => {
      const cleanName = String(name || '').trim();
      if (!cleanName) return;
      const normalizedCostPerPax = setting?.costPerPax === '' || setting?.costPerPax === null || setting?.costPerPax === undefined ? setting?.cost === '' || setting?.cost === null || setting?.cost === undefined ? '' : Number(setting.cost) || 0 : Number(setting.costPerPax) || 0;
      const normalizedCostPerSession = setting?.costPerSession === '' || setting?.costPerSession === null || setting?.costPerSession === undefined ? '' : Number(setting.costPerSession) || 0;
      normalized[cleanName] = {
        bucket: PERFORMANCE_BUCKET_OPTIONS.some(option => option.value === setting?.bucket) ? setting.bucket : inferPerformanceBucket(cleanName),
        trait: String(setting?.trait || '').trim(),
        cost: normalizedCostPerPax,
        costPerPax: normalizedCostPerPax,
        costPerSession: normalizedCostPerSession
      };
    });
    setPerformanceProductSettings(normalized);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
      performanceProductSettings: normalized
    }, {
      merge: true
    });
  };
  const openCreateEventModal = (date = '', instructors = []) => {
    if (date && companyRestDates.includes(date)) {
      alert(`${date} 已設為全公司公休，無法直接排活動。`);
      return;
    }
    if (templatesLoadState !== 'success') {
      setTemplatesLoadState('loading');
    }
    setScheduleDate(date || '');
    setCreateEventPrefillInstructors(Array.isArray(instructors) ? instructors.map(name => String(name || '').trim()).filter(Boolean) : []);
    setShowCreateEvent(true);
  };
  const closeCreateEventModal = () => {
    setShowCreateEvent(false);
    setScheduleDate('');
    setCreateEventPrefillInstructors([]);
  };
  const handleRetryTemplatesLoad = () => {
    setTemplatesLoadState('loading');
    setTemplatesReloadSeed((seed) => seed + 1);
  };
  const handleOpenCreateEventFromMatrix = (instructorName, dateKey) => {
    if (!instructorName || !dateKey) return;
    openCreateEventModal(dateKey, [instructorName]);
  };
  const handleSaveMonthlyKpis = async () => {
    if (!user || !db) return alert("請先登入");
    const sanitized = {};
    Object.entries(monthlyKpis || {}).forEach(([monthKey, raw]) => {
      const activityTargets = {};
      Object.entries(raw?.activityTargets || {}).forEach(([name, value]) => {
        if (value !== '' && value !== null && value !== undefined) activityTargets[name] = Number(value) || 0;
      });
      const entry = {
        totalPax: raw?.totalPax === '' || raw?.totalPax === null || raw?.totalPax === undefined ? '' : Number(raw.totalPax) || 0,
        inventoryDays: raw?.inventoryDays === '' || raw?.inventoryDays === null || raw?.inventoryDays === undefined ? '' : Number(raw.inventoryDays) || 0,
        avgPaxPerSession: raw?.avgPaxPerSession === '' || raw?.avgPaxPerSession === null || raw?.avgPaxPerSession === undefined ? '' : Number(raw.avgPaxPerSession) || 0,
        fillRate: raw?.fillRate === '' || raw?.fillRate === null || raw?.fillRate === undefined ? '' : Number(raw.fillRate) || 0,
        activityTargets
      };
      const hasValue = entry.totalPax !== '' || entry.inventoryDays !== '' || entry.avgPaxPerSession !== '' || entry.fillRate !== '' || Object.keys(activityTargets).length > 0;
      if (hasValue) sanitized[monthKey] = entry;
    });
    setKpiSaveStatus('saving');
    try {
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        monthlyKpis: sanitized
      }, {
        merge: true
      });
      setMonthlyKpis(sanitized);
      setKpiSaveStatus('success');
      setTimeout(() => setKpiSaveStatus('idle'), 2500);
    } catch (e) {
      console.error('Monthly KPI save failed', e);
      setKpiSaveStatus('error');
      alert(`❌ KPI 儲存失敗：${formatFirestoreError(e)}`);
    }
  };
  const DEFAULT_PLAN_PROFIT_SPLIT = {
    companyPct: 75,
    bonusPct: 25
  };
  const DEFAULT_PLANNING_OPERATOR_NAME = '未署名';
  const normalizePlanMetricValue = (value, digits = null) => {
    if (value === '' || value === null || value === undefined) return '';
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '';
    return digits === null ? parsed : Number(parsed.toFixed(digits));
  };
  const normalizePlanActivityInput = (metrics = {}, fallbackName = '') => {
    const avgPax = normalizePlanMetricValue(metrics?.avgPax, 1);
    let revenuePerPax = normalizePlanMetricValue(metrics?.revenuePerPax, 2);
    const costPerPax = normalizePlanMetricValue(metrics?.costPerPax, 2);
    const legacyGrossProfitPerSession = normalizePlanMetricValue(metrics?.grossProfitPerSession, 2);
    const templateType = normalizePlanActivityTemplateType(metrics?.templateType || inferPlanActivityTemplateType(fallbackName));
    if (revenuePerPax === '' && legacyGrossProfitPerSession !== '' && avgPax !== '' && Number(avgPax) !== 0) {
      revenuePerPax = Number((legacyGrossProfitPerSession / Number(avgPax)).toFixed(2));
    }
    return {
      avgPax,
      revenuePerPax,
      costPerPax,
      templateType
    };
  };
  const normalizePlanProfitSplit = (raw = {}) => {
    const hasCompany = raw?.companyPct !== '' && raw?.companyPct !== null && raw?.companyPct !== undefined;
    const hasBonus = raw?.bonusPct !== '' && raw?.bonusPct !== null && raw?.bonusPct !== undefined;
    if (!hasCompany && !hasBonus) return {
      ...DEFAULT_PLAN_PROFIT_SPLIT
    };
    let companyPct = hasCompany ? Number(raw.companyPct) : NaN;
    let bonusPct = hasBonus ? Number(raw.bonusPct) : NaN;
    if (!Number.isFinite(companyPct) && !Number.isFinite(bonusPct)) return {
      ...DEFAULT_PLAN_PROFIT_SPLIT
    };
    if (!Number.isFinite(companyPct)) companyPct = 100 - bonusPct;
    if (!Number.isFinite(bonusPct)) bonusPct = 100 - companyPct;
    companyPct = Math.max(0, Math.min(100, companyPct));
    bonusPct = Math.max(0, Math.min(100, bonusPct));
    const total = companyPct + bonusPct;
    if (total <= 0) return {
      ...DEFAULT_PLAN_PROFIT_SPLIT
    };
    if (Math.abs(total - 100) > 0.01) {
      companyPct = Number((companyPct / total * 100).toFixed(1));
      bonusPct = Number((100 - companyPct).toFixed(1));
    } else {
      companyPct = Number(companyPct.toFixed(1));
      bonusPct = Number(bonusPct.toFixed(1));
    }
    return {
      companyPct,
      bonusPct
    };
  };
  const buildDefaultPlanActivityInput = (templateType = 'special') => {
    const normalizedType = normalizePlanActivityTemplateType(templateType);
    const template = PLAN_ACTIVITY_TEMPLATES[normalizedType];
    return {
      avgPax: '',
      revenuePerPax: template.defaultRevenuePerPax === '' ? '' : template.defaultRevenuePerPax,
      costPerPax: '',
      templateType: normalizedType
    };
  };
  const sanitizeMonthlyPlanEntry = (raw = {}, fallbackMonthKey = '') => {
    const activityInputs = {};
    const placementList = [];
    const profitSplit = normalizePlanProfitSplit(raw?.profitSplit);
    Object.entries(raw?.activityInputs || {}).forEach(([eventName, metrics]) => {
      const cleanName = String(eventName || '').trim();
      if (!cleanName) return;
      const normalizedMetrics = normalizePlanActivityInput(metrics, cleanName);
      if (normalizedMetrics.avgPax === '' && normalizedMetrics.revenuePerPax === '' && normalizedMetrics.costPerPax === '') return;
      activityInputs[cleanName] = normalizedMetrics;
    });
    (Array.isArray(raw?.calendarPlacements) ? raw.calendarPlacements : []).forEach((placement, index) => {
      const eventName = String(placement?.eventName || '').trim();
      const instructorName = String(placement?.instructorName || '').trim();
      const dateKey = String(placement?.dateKey || '').trim();
      if (!eventName || !instructorName || !dateKey) return;
      placementList.push({
        id: String(placement?.id || `${fallbackMonthKey}_${index}_${buildPlanningCellKey(dateKey, instructorName)}`),
        eventName,
        instructorName,
        dateKey
      });
    });
    return {
      activityInputs,
      calendarPlacements: sortPlanningPlacements(placementList),
      profitSplit
    };
  };
  const cloneMonthlyPlanEntry = (raw = {}, fallbackMonthKey = '') => {
    const sanitized = sanitizeMonthlyPlanEntry(raw, fallbackMonthKey);
    return {
      activityInputs: {
        ...(sanitized.activityInputs || {})
      },
      calendarPlacements: (sanitized.calendarPlacements || []).map(placement => ({
        ...placement
      })),
      profitSplit: {
        ...(sanitized.profitSplit || DEFAULT_PLAN_PROFIT_SPLIT)
      }
    };
  };
  const formatVersionMetricValue = (value, digits = null) => {
    if (value === '' || value === null || value === undefined) return '未填';
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return String(value);
    return parsed.toLocaleString('zh-TW', {
      minimumFractionDigits: digits === null ? 0 : digits,
      maximumFractionDigits: digits === null ? 2 : digits
    });
  };
  const getPlanTemplateLabel = value => {
    const cleanValue = normalizePlanActivityTemplateType(value);
    return PLAN_ACTIVITY_TEMPLATES[cleanValue]?.label || cleanValue || '未分類';
  };
  const buildPlanningVersionMeta = (previousRaw, nextRaw, options = {}) => {
    const previous = previousRaw ? sanitizeMonthlyPlanEntry(previousRaw) : null;
    const next = sanitizeMonthlyPlanEntry(nextRaw);
    const details = [];
    const previousPlacementMap = Object.fromEntries((previous?.calendarPlacements || []).map((placement, index) => [buildPlanningPlacementIdentity(placement, `prev_${index}`), placement]));
    const nextPlacementMap = Object.fromEntries((next.calendarPlacements || []).map((placement, index) => [buildPlanningPlacementIdentity(placement, `next_${index}`), placement]));
    const placementCellKeys = Array.from(new Set([...Object.keys(previousPlacementMap), ...Object.keys(nextPlacementMap)])).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    let addedPlacements = 0;
    let removedPlacements = 0;
    let updatedPlacements = 0;
    placementCellKeys.forEach(cellKey => {
      const before = previousPlacementMap[cellKey];
      const after = nextPlacementMap[cellKey];
      if (!before && after) {
        addedPlacements += 1;
        details.push(`${after.dateKey}｜${after.instructorName} 新增「${after.eventName}」`);
        return;
      }
      if (before && !after) {
        removedPlacements += 1;
        details.push(`${before.dateKey}｜${before.instructorName} 移除「${before.eventName}」`);
        return;
      }
      if (before && after && (before.eventName !== after.eventName || before.dateKey !== after.dateKey || before.instructorName !== after.instructorName)) {
        updatedPlacements += 1;
        details.push(`${before.dateKey}｜${before.instructorName}｜${before.eventName} → ${after.dateKey}｜${after.instructorName}｜${after.eventName}`);
      }
    });
    const metricNames = Array.from(new Set([...Object.keys(previous?.activityInputs || {}), ...Object.keys(next.activityInputs || {})])).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    let metricChanges = 0;
    metricNames.forEach(name => {
      const before = previous?.activityInputs?.[name] || null;
      const after = next.activityInputs?.[name] || null;
      if (!before && after) {
        metricChanges += 1;
        details.push(`活動設定｜${name} 新增假設（${getPlanTemplateLabel(after.templateType)}）`);
        return;
      }
      if (before && !after) {
        metricChanges += 1;
        details.push(`活動設定｜${name} 移除假設`);
        return;
      }
      if (!before || !after) return;
      if ((before.avgPax ?? '') !== (after.avgPax ?? '')) {
        metricChanges += 1;
        details.push(`活動設定｜${name} 平均人數 ${formatVersionMetricValue(before.avgPax, 1)} → ${formatVersionMetricValue(after.avgPax, 1)}`);
      }
      if ((before.revenuePerPax ?? '') !== (after.revenuePerPax ?? '')) {
        metricChanges += 1;
        details.push(`活動設定｜${name} 每人營收 ${formatVersionMetricValue(before.revenuePerPax, 2)} → ${formatVersionMetricValue(after.revenuePerPax, 2)}`);
      }
      if ((before.costPerPax ?? '') !== (after.costPerPax ?? '')) {
        metricChanges += 1;
        details.push(`活動設定｜${name} 每人成本 ${formatVersionMetricValue(before.costPerPax, 2)} → ${formatVersionMetricValue(after.costPerPax, 2)}`);
      }
      if (normalizePlanActivityTemplateType(before.templateType) !== normalizePlanActivityTemplateType(after.templateType)) {
        metricChanges += 1;
        details.push(`活動設定｜${name} 類型 ${getPlanTemplateLabel(before.templateType)} → ${getPlanTemplateLabel(after.templateType)}`);
      }
    });
    const previousSplit = normalizePlanProfitSplit(previous?.profitSplit);
    const nextSplit = normalizePlanProfitSplit(next.profitSplit);
    const splitChanged = previous ? previousSplit.companyPct !== nextSplit.companyPct || previousSplit.bonusPct !== nextSplit.bonusPct : false;
    if (splitChanged) {
      details.push(`毛利拆分 公司 ${formatVersionMetricValue(previousSplit.companyPct, 1)}% / 獎金 ${formatVersionMetricValue(previousSplit.bonusPct, 1)}% → 公司 ${formatVersionMetricValue(nextSplit.companyPct, 1)}% / 獎金 ${formatVersionMetricValue(nextSplit.bonusPct, 1)}%`);
    }
    const summaryParts = [];
    if (previous) {
      if (addedPlacements > 0) summaryParts.push(`新增 ${addedPlacements} 項排班`);
      if (removedPlacements > 0) summaryParts.push(`移除 ${removedPlacements} 項排班`);
      if (updatedPlacements > 0) summaryParts.push(`調整 ${updatedPlacements} 項排班`);
      if (metricChanges > 0) summaryParts.push(`活動設定 ${metricChanges} 項調整`);
      if (splitChanged) summaryParts.push('毛利拆分更新');
      if (summaryParts.length === 0) summaryParts.push('內容無差異，重新儲存');
    } else {
      summaryParts.push(`建立初始版本`);
      if (next.calendarPlacements.length > 0) summaryParts.push(`排班 ${next.calendarPlacements.length} 項`);
      if (Object.keys(next.activityInputs || {}).length > 0) summaryParts.push(`活動設定 ${Object.keys(next.activityInputs || {}).length} 種`);
    }
    if (options?.action === 'restore') summaryParts.unshift('還原版本');
    return {
      summary: summaryParts.join('｜'),
      details
    };
  };
  const DEFAULT_EVENT_VERSION_OPERATOR_NAME = '未署名';
  const EVENT_VERSION_FIELD_LABELS = {
    time: '活動時間',
    capacity: '人數上限',
    displayName: '前台名稱',
    activityCategory: '活動性質',
    carpoolDisplayMode: '共乘顯示',
    isCancelled: '流團標記',
    duration: '持續天數',
    prepDays: '前置天數',
    prepTime: '前置時間',
    price: '活動價格',
    tags: '前台標籤',
    statusRules: '狀態規則',
    tasks: '任務清單',
    leadInstructors: '帶團講師',
    supportInstructors: '跟團講師'
  };
  const normalizeMonthKeyFromDate = value => {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})[\/-](\d{1,2})/);
    if (!match) return '';
    return `${match[1]}-${String(parseInt(match[2], 10)).padStart(2, '0')}`;
  };
  const buildEventKeyFromRow = (row = {}) => {
    const date = String(row.date || '').trim();
    const eventName = String(row.eventName || '').trim();
    const sortedInstr = row.instructor ? row.instructor.split(/[&,]/).map(s => s.trim()).filter(Boolean).sort().join(' & ') : '';
    if (!date || !eventName) return '';
    return `${date}_${eventName}_${sortedInstr}`.replace(/[\/\\#\?]/g, '-');
  };
  const sortEventRows = (rows = []) => [...rows].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.eventName || '').localeCompare(String(b.eventName || ''), 'zh-Hant') || String(a.instructor || '').localeCompare(String(b.instructor || ''), 'zh-Hant') || String(a.customerName || '').localeCompare(String(b.customerName || ''), 'zh-Hant') || String(a.orderDate || '').localeCompare(String(b.orderDate || '')));
  const flattenRowsByMonth = (rowsByMonthKey = {}) => Object.values(rowsByMonthKey || {}).flat().map(row => ({
    ...row
  }));
  const buildEventGroupMapFromRows = (rows = []) => {
    const map = {};
    (rows || []).forEach(row => {
      const key = buildEventKeyFromRow(row);
      if (!key) return;
      if (!map[key]) {
        map[key] = {
          key,
          date: row.date || '',
          eventName: row.eventName || '',
          instructor: row.instructor || '',
          count: 0
        };
      }
      if (row.customerName !== '開放報名中') map[key].count += 1;
    });
    return map;
  };
  const collectEventConfigKeysFromRows = (rows = []) => Array.from(new Set((rows || []).map(row => buildEventKeyFromRow(row)).filter(Boolean)));
  const cloneEventConfigValue = configValue => {
    if (configValue === null || configValue === undefined) return null;
    return JSON.parse(JSON.stringify(configValue));
  };
  const buildEventScheduleMonthSnapshot = (rows = [], configs = {}, monthKeys = []) => {
    const cleanMonthKeys = Array.from(new Set((monthKeys || []).filter(Boolean))).sort();
    const monthKeySet = new Set(cleanMonthKeys);
    const rowsByMonthKey = {};
    (rows || []).forEach(row => {
      const monthKey = normalizeMonthKeyFromDate(row.date);
      if (!monthKeySet.has(monthKey)) return;
      if (!rowsByMonthKey[monthKey]) rowsByMonthKey[monthKey] = [];
      rowsByMonthKey[monthKey].push({
        ...row
      });
    });
    Object.keys(rowsByMonthKey).forEach(monthKey => {
      rowsByMonthKey[monthKey] = sortEventRows(rowsByMonthKey[monthKey]);
    });
    const configSnapshot = {};
    collectEventConfigKeysFromRows(flattenRowsByMonth(rowsByMonthKey)).forEach(key => {
      configSnapshot[key] = cloneEventConfigValue(configs?.[key]);
    });
    return {
      monthKeys: cleanMonthKeys,
      rowsByMonthKey,
      configSnapshot
    };
  };
  const formatEventVersionFieldValue = (field, value) => {
    if (value === '' || value === null || value === undefined) {
      return field === 'isCancelled' ? '未標記' : '未填';
    }
    if (field === 'carpoolDisplayMode') {
      return CARPOOL_DISPLAY_MODE_OPTIONS.find(option => option.value === resolveCarpoolDisplayMode(value, ''))?.label || String(value);
    }
    if (field === 'isCancelled') return value ? '已標記流團' : '未標記';
    if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '未填';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  const buildEventScheduleVersionMeta = (previousRows = [], nextRows = [], previousConfigSnapshot = {}, nextConfigSnapshot = {}, options = {}) => {
    const beforeGroups = buildEventGroupMapFromRows(previousRows);
    const afterGroups = buildEventGroupMapFromRows(nextRows);
    const details = [];
    let createdCount = 0;
    let removedCount = 0;
    let updatedCount = 0;
    const groupKeys = Array.from(new Set([...Object.keys(beforeGroups), ...Object.keys(afterGroups)])).sort((a, b) => {
      const before = beforeGroups[a] || afterGroups[a] || {};
      const after = afterGroups[b] || beforeGroups[b] || {};
      return String(before.date || '').localeCompare(String(after.date || '')) || String(before.eventName || '').localeCompare(String(after.eventName || ''), 'zh-Hant') || String(before.instructor || '').localeCompare(String(after.instructor || ''), 'zh-Hant');
    });
    groupKeys.forEach(key => {
      const before = beforeGroups[key];
      const after = afterGroups[key];
      if (!before && after) {
        createdCount += 1;
        details.push(`${after.date}｜新增「${after.eventName}」@${after.instructor || '未定'}（${after.count} 人）`);
        return;
      }
      if (before && !after) {
        removedCount += 1;
        details.push(`${before.date}｜刪除「${before.eventName}」@${before.instructor || '未定'}（${before.count} 人）`);
        return;
      }
      if (!before || !after) return;
      if (before.eventName !== after.eventName || before.instructor !== after.instructor) {
        updatedCount += 1;
        details.push(`${after.date}｜「${before.eventName}」@${before.instructor || '未定'} → 「${after.eventName}」@${after.instructor || '未定'}`);
      }
    });
    let configChanges = 0;
    const configKeys = Array.from(new Set([...Object.keys(previousConfigSnapshot || {}), ...Object.keys(nextConfigSnapshot || {})])).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    configKeys.forEach(key => {
      const beforeConfig = previousConfigSnapshot?.[key] || null;
      const afterConfig = nextConfigSnapshot?.[key] || null;
      if (!beforeConfig || !afterConfig) return;
      const group = afterGroups[key] || beforeGroups[key];
      const groupLabel = group ? `${group.date}｜${group.eventName}` : key;
      Object.keys(EVENT_VERSION_FIELD_LABELS).forEach(field => {
        const beforeValue = beforeConfig?.[field];
        const afterValue = afterConfig?.[field];
        if (JSON.stringify(beforeValue ?? null) === JSON.stringify(afterValue ?? null)) return;
        configChanges += 1;
        details.push(`設定｜${groupLabel} ${EVENT_VERSION_FIELD_LABELS[field]} ${formatEventVersionFieldValue(field, beforeValue)} → ${formatEventVersionFieldValue(field, afterValue)}`);
      });
    });
    const summaryParts = [];
    if (createdCount > 0) summaryParts.push(`新增 ${createdCount} 場`);
    if (removedCount > 0) summaryParts.push(`刪除 ${removedCount} 場`);
    if (updatedCount > 0) summaryParts.push(`改動 ${updatedCount} 場`);
    if (configChanges > 0) summaryParts.push(`設定 ${configChanges} 項調整`);
    if (summaryParts.length === 0) summaryParts.push('內容無差異，重新儲存');
    if (options?.action === 'restore') summaryParts.unshift('還原版本');
    return {
      summary: summaryParts.join('｜'),
      details
    };
  };
  const formatPlanningVersionTimestamp = value => {
    if (!value) return '時間未記錄';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };
  const handleSaveMonthlyPlans = async () => {
    if (!user || !db) return alert("請先登入");
    const basePath = `artifacts/${dbSource}/public/data`;
    const mainPlanRef = doc(db, basePath, 'monthly_plans', currentMonthKey);
    const versionRef = collection(db, basePath, 'monthly_plans', currentMonthKey, 'versions');
    const sanitizedEntry = sanitizeMonthlyPlanEntry(currentMonthPlan, currentMonthKey);
    const previousSavedEntry = storedMonthlyPlanDocs[currentMonthKey] || legacyMonthlyPlans[currentMonthKey] || null;
    const versionMeta = buildPlanningVersionMeta(previousSavedEntry, sanitizedEntry);
    const operatorName = String(planningOperatorName || '').trim() || DEFAULT_PLANNING_OPERATOR_NAME;
    const savedAt = new Date().toISOString();
    const versionPayload = {
      monthKey: currentMonthKey,
      monthLabel: currentMonthLabel,
      action: 'save',
      summary: versionMeta.summary,
      details: versionMeta.details,
      savedAt,
      savedAtMs: Date.now(),
      savedByName: operatorName,
      savedByUid: user?.uid || 'anonymous',
      snapshot: sanitizedEntry
    };
    setPlanningSaveStatus('saving');
    try {
      await setDoc(mainPlanRef, sanitizedEntry, {});
      await addDoc(versionRef, versionPayload);
      setStoredMonthlyPlanDocs(prev => ({
        ...prev,
        [currentMonthKey]: cloneMonthlyPlanEntry(sanitizedEntry, currentMonthKey)
      }));
      setMonthlyPlans(prev => ({
        ...prev,
        [currentMonthKey]: cloneMonthlyPlanEntry(sanitizedEntry, currentMonthKey)
      }));
      planningDirtyMonthsRef.current.delete(currentMonthKey);
      setPlanningSaveStatus('success');
      setTimeout(() => setPlanningSaveStatus('idle'), 2500);
    } catch (e) {
      console.error('Monthly planning save failed', e);
      setPlanningSaveStatus('error');
      alert(`❌ 模擬資料儲存失敗：${formatFirestoreError(e)}`);
    }
  };
  const handleSaveCSV = async newData => {
    if (!user || !db) {
      const err = {
        code: 'unavailable',
        message: '資料庫未連線或尚未登入'
      };
      alert(`❌ 儲存失敗：${formatFirestoreError(err)}`);
      throw err;
    }
    setCsvSaveStatus('saving');
    setIsSaving(true);
    try {
      isEditingRef.current = false;
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        csvData: newData
      }, {
        merge: true
      });
      setCsvInput(newData);
      setParsedData(parseCsvDataRows(newData));
      setCsvSaveStatus('success');
      setTimeout(() => setCsvSaveStatus('idle'), 3000);
    } catch (e) {
      console.error(e);
      setCsvSaveStatus('error');
      alert(`❌ 儲存失敗：${formatFirestoreError(e)}\n資料未寫入 Firebase，請先執行 Firebase 健康檢查。`);
      throw e;
    } finally {
      setIsSaving(false);
    }
  };
  const pushEventVersionStatus = (status, message) => {
    setEventVersionStatus({
      status,
      message,
      at: new Date().toLocaleTimeString('zh-TW')
    });
  };
  const saveEventScheduleVersionEntry = async ({
    action = 'save',
    monthKeys = [],
    previousRows = [],
    nextRows = [],
    previousConfigs = {},
    nextConfigs = {},
    restoredFromVersion = null
  }) => {
    const cleanMonthKeys = Array.from(new Set((monthKeys || []).filter(Boolean))).sort();
    if (cleanMonthKeys.length === 0) return null;
    const basePath = `artifacts/${dbSource}/public/data`;
    const versionCollectionRef = collection(db, basePath, 'event_schedule_versions');
    const beforeSnapshot = buildEventScheduleMonthSnapshot(previousRows, previousConfigs, cleanMonthKeys);
    const afterSnapshot = buildEventScheduleMonthSnapshot(nextRows, nextConfigs, cleanMonthKeys);
    const versionMeta = buildEventScheduleVersionMeta(flattenRowsByMonth(beforeSnapshot.rowsByMonthKey), flattenRowsByMonth(afterSnapshot.rowsByMonthKey), beforeSnapshot.configSnapshot, afterSnapshot.configSnapshot, {
      action
    });
    const operatorName = String(eventVersionOperatorName || '').trim() || DEFAULT_EVENT_VERSION_OPERATOR_NAME;
    const sourceLabel = restoredFromVersion?.savedAt ? formatPlanningVersionTimestamp(restoredFromVersion.savedAt) : '';
    const payload = {
      action,
      monthKey: cleanMonthKeys[0],
      monthKeys: cleanMonthKeys,
      summary: action === 'restore' && sourceLabel ? `${versionMeta.summary}（來源：${sourceLabel}）` : versionMeta.summary,
      details: versionMeta.details,
      savedAt: new Date().toISOString(),
      savedAtMs: Date.now(),
      savedByName: operatorName,
      savedByUid: user?.uid || 'anonymous',
      snapshot: afterSnapshot
    };
    if (restoredFromVersion?.id) payload.restoredFromVersionId = restoredFromVersion.id;
    await addDoc(versionCollectionRef, payload);
    return payload;
  };
  const handleRestoreEventScheduleVersion = async version => {
    if (!version?.snapshot || !db || !user) return alert('請先登入');
    const monthKeys = Array.from(new Set([...(Array.isArray(version.monthKeys) ? version.monthKeys : []), ...Object.keys(version.snapshot.rowsByMonthKey || {})].filter(Boolean))).sort();
    if (monthKeys.length === 0) return alert('這個版本沒有可還原的月份資料。');
    const sourceTime = formatPlanningVersionTimestamp(version.savedAt);
    const sourceActor = String(version.savedByName || '').trim() || DEFAULT_EVENT_VERSION_OPERATOR_NAME;
    if (!confirm(`確定要把活動場次表還原成 ${sourceTime}（${sourceActor}）這版嗎？\n會覆蓋 ${monthKeys.join('、')} 的活動場次與設定。`)) return;
    const restoredRows = flattenRowsByMonth(version.snapshot.rowsByMonthKey || {});
    const untouchedRows = parsedData.filter(row => !monthKeys.includes(normalizeMonthKeyFromDate(row.date)));
    const nextRows = sortEventRows([...untouchedRows, ...restoredRows]);
    const currentScopedRows = parsedData.filter(row => monthKeys.includes(normalizeMonthKeyFromDate(row.date)));
    const currentConfigKeys = Array.from(new Set([...collectEventConfigKeysFromRows(currentScopedRows), ...Object.keys(eventConfigs || {}).filter(key => monthKeys.some(monthKey => key.startsWith(`${monthKey}-`)))]));
    const restoredConfigSnapshot = version.snapshot.configSnapshot || {};
    const restoredConfigKeys = Object.keys(restoredConfigSnapshot);
    const keysToDelete = currentConfigKeys.filter(key => !restoredConfigKeys.includes(key));
    const nextConfigs = {
      ...eventConfigs
    };
    keysToDelete.forEach(key => {
      delete nextConfigs[key];
    });
    restoredConfigKeys.forEach(key => {
      const configValue = cloneEventConfigValue(restoredConfigSnapshot[key]);
      if (configValue) nextConfigs[key] = configValue;
    });
    pushEventVersionStatus('checking', `正在還原 ${monthKeys.join('、')} 的活動場次...`);
    try {
      await handleSaveCSV(arrayToCSV(nextRows));
      await Promise.all([...keysToDelete.map(key => deleteDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', key)).catch(() => null)), ...restoredConfigKeys.map(key => {
        const configValue = restoredConfigSnapshot[key];
        if (!configValue) return Promise.resolve();
        return setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', key), configValue, {});
      })]);
      await saveEventScheduleVersionEntry({
        action: 'restore',
        monthKeys,
        previousRows: parsedData,
        nextRows,
        previousConfigs: eventConfigs,
        nextConfigs,
        restoredFromVersion: version
      });
      pushEventVersionStatus('success', `已還原 ${monthKeys.join('、')} 的活動場次版本`);
    } catch (e) {
      console.error('Event schedule restore failed', e);
      pushEventVersionStatus('error', `還原失敗：${formatFirestoreError(e)}`);
      alert(`❌ 活動場次版本還原失敗：${formatFirestoreError(e)}`);
    }
  };
  const arrayToCSV = dataArray => {
    let csv = CSV_HEADER + '\n';
    dataArray.forEach(row => {
      const check = row.isCheckedIn ? '1' : '0';
      const line = `${row.date || ''},${row.eventName || ''},${row.instructor || ''},${row.customerName || ''},${row.price || 0},${row.transport || ''},${row.idNo || ''},${row.birthday || ''},${row.email || ''},${row.source || ''},${row.socialName || ''},${toCSVField(row.notes)},${row.orderDate || ''},${row.phone || ''},${check}`;
      csv += line + '\n';
    });
    return csv;
  };
  const handleUpdateRow = async newRowData => {
    const newData = parsedData.map(row => row.id === newRowData.id ? newRowData : row);
    await handleSaveCSV(arrayToCSV(newData));
    setEditingRow(null);
  };
  const handleDeleteRow = async id => {
    if (!confirm("確定刪除此筆資料？")) return;
    const newData = parsedData.filter(row => row.id !== id);
    await handleSaveCSV(arrayToCSV(newData));
  };
  const handleBulkImport = async newRows => {
    const currentRows = [...parsedData];
    const formattedNewRows = newRows.map(r => ({
      date: r.date || '',
      eventName: r.eventName || '',
      instructor: r.instructor || '',
      customerName: r.customerName || '',
      price: r.price || 0,
      transport: '',
      idNo: r.idNo || '',
      birthday: r.birthday || '',
      email: r.email || '',
      source: r.source || '',
      socialName: r.socialName || '',
      notes: r.notes || '',
      orderDate: getLocalDateStr(),
      phone: r.phone || ''
    }));
    const finalData = [...currentRows, ...formattedNewRows];
    await handleSaveCSV(arrayToCSV(finalData));
  };
  const handleAddManualReg = async () => {
    if (!newReg.date || !newReg.eventName || !newReg.customerName) {
      return;
    }
    // 防呆：公開行事曆只認 event_configs，沒建場次就加報名，前台永遠看不到這一場
    const _regPrefix = `${newReg.date}_${newReg.eventName}_`;
    if (!Object.keys(eventConfigs || {}).some(k => k.startsWith(_regPrefix))) {
      if (!confirm(`「${newReg.date} ${newReg.eventName}」還沒有場次設定，公開行事曆不會顯示這一場。\n建議先用「新增活動」建立場次，再回來加報名。\n\n仍要只加報名資料嗎？`)) {
        return;
      }
    }
    setAddRegStatus('saving');
    let currentData = csvInput.trim();
    if (!currentData || !currentData.startsWith("日期")) {
      currentData = CSV_HEADER + "\n" + currentData;
    }
    const newRow = `\n${newReg.date},${newReg.eventName},${newReg.instructor},${newReg.customerName},${newReg.price},${newReg.transport},${newReg.idNo},${newReg.birthday},${newReg.email},${newReg.source},,${newReg.orderDate},${newReg.phone},0`;
    const updatedCSV = currentData + newRow;
    await handleSaveCSV(updatedCSV);
    setNewReg({
      date: '',
      eventName: '',
      instructor: '',
      customerName: '',
      price: '',
      transport: '',
      idNo: '',
      birthday: '',
      email: '',
      source: '',
      orderDate: getLocalDateStr(),
      phone: ''
    });
    setAddRegStatus('success');
    setTimeout(() => setAddRegStatus('idle'), 2000);
  };
  const handleAddDirectReg = async (eventInfo, customerData) => {
    const _drPrefix = `${eventInfo.date}_${eventInfo.eventName}_`;
    if (!Object.keys(eventConfigs || {}).some(k => k.startsWith(_drPrefix))) {
      if (!confirm(`「${eventInfo.date} ${eventInfo.eventName}」還沒有場次設定，公開行事曆不會顯示這一場。\n\n仍要加報名資料嗎？`)) {
        return;
      }
    }
    let currentData = csvInput.trim();
    if (!currentData || !currentData.startsWith("日期")) {
      currentData = CSV_HEADER + "\n" + currentData;
    }
    const newRow = `\n${eventInfo.date},${eventInfo.eventName},${eventInfo.instructor},${customerData.customerName},${customerData.price},${customerData.transport},${customerData.idNo},${customerData.birthday},${customerData.email},${customerData.source},,${toCSVField(customerData.notes)},${customerData.orderDate},${customerData.phone},0`;
    const updatedCSV = currentData + newRow;
    await handleSaveCSV(updatedCSV);
  };
  const handleCreateEvent = async ({
    dates,
	    eventName,
	    instructors,
	    time,
	    timeSlot,
	    duration,
    prepDays,
    prepTime,
    link,
    note,
    displayName,
    activityCategory,
    carpoolDisplayMode,
    isPrivateGroupEvent,
    privateGroupLabel,
    isCancelled,
    tags,
    capacity,
    backendColor,
    statusRules,
    price
  }) => {
    const cleanDates = Array.from(new Set((dates || []).filter(Boolean))).sort();
    if (cleanDates.length === 0) return;
    const instr = [...(instructors || [])].map(name => String(name || '').trim()).filter(Boolean).sort().join(' & ');
    const createdRows = cleanDates.map(d => ({
      date: d,
      eventName,
      instructor: instr,
      customerName: '開放報名中',
      price: 0,
      transport: '',
      idNo: '',
      birthday: '',
      email: '',
      source: '',
      socialName: '',
      notes: '',
      orderDate: '',
      phone: '',
      isCheckedIn: false
    }));
    const nextRows = sortEventRows([...parsedData, ...createdRows]);
    const monthKeys = Array.from(new Set(cleanDates.map(normalizeMonthKeyFromDate).filter(Boolean)));
    const nextConfigs = {
      ...eventConfigs
    };
	    cleanDates.forEach(d => {
	      const key = `${d}_${eventName}_${instr}`.replace(/[\/\\#\?]/g, '-');
	      nextConfigs[key] = {
	        time: time || '',
	        timeSlot: normalizeScheduleTimeSlot(timeSlot, inferScheduleTimeSlot(time)),
	        duration: parseInt(duration, 10) || 1,
        prepDays: parseInt(prepDays, 10) || 0,
        prepTime: prepTime || '',
        link: link || '',
        note: note || '',
        displayName: displayName || '',
        activityCategory: activityCategory || '',
        carpoolDisplayMode: resolveCarpoolDisplayMode(carpoolDisplayMode, eventName),
        isPrivateGroupEvent: !!isPrivateGroupEvent,
        privateGroupLabel: privateGroupLabel || '此為包團活動',
        capacity: parseInt(capacity) || 12,
        price: parseInt(price) || 0,
        tags: tags || {
          levels: '',
          types: '',
          locations: ''
        },
        backendColor: backendColor || '#eff6ff',
        statusRules: normalizeStoredStatusRules(statusRules || []),
        leadInstructors: instructors || [],
        supportInstructors: [],
        isCancelled: !!isCancelled
      };
    });
    pushEventVersionStatus('checking', `正在建立 ${cleanDates.length} 場活動...`);
    try {
      await handleSaveCSV(arrayToCSV(nextRows));
      await Promise.all(cleanDates.map(d => {
        const key = `${d}_${eventName}_${instr}`.replace(/[\/\\#\?]/g, '-');
        return setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', key), nextConfigs[key], {
          merge: true
        });
      }));
      await saveEventScheduleVersionEntry({
        action: 'create',
        monthKeys,
        previousRows: parsedData,
        nextRows,
        previousConfigs: eventConfigs,
        nextConfigs
      });
      pushEventVersionStatus('success', `已建立 ${cleanDates.length} 場活動，並留下版本紀錄`);
      closeCreateEventModal();
    } catch (e) {
      console.error('Create event failed', e);
      pushEventVersionStatus('error', `建立失敗：${formatFirestoreError(e)}`);
      alert(`❌ 建立活動失敗：${formatFirestoreError(e)}`);
    }
  };
  const handleCheckInToggle = async (customerId, currentStatus) => {
    const row = parsedData.find(r => r.id === customerId);
    if (row) {
      await handleUpdateRow({
        ...row,
        isCheckedIn: !currentStatus
      });
    }
  };
  const handleSaveEventConfig = async (oldEventKey, newConfig, newInstructorStr, newInternalName) => {
    const newRows = parsedData.map(r => {
      const sortedInstr = r.instructor ? r.instructor.split(/[&,]/).map(s => s.trim()).sort().join(' & ') : '';
      const key = `${r.date}_${r.eventName}_${sortedInstr}`.replace(/[\/\\#\?]/g, '-');
      if (key === oldEventKey) {
        return {
          ...r,
          instructor: newInstructorStr !== undefined ? newInstructorStr : r.instructor,
          eventName: newInternalName || r.eventName
        };
      }
      return r;
    });
    const sortedRows = sortEventRows(newRows);
    const finalName = newInternalName || editingEvent.eventName;
    const finalInstr = newInstructorStr !== undefined ? newInstructorStr : editingEvent.instructor;
    const newKey = `${editingEvent.date}_${finalName}_${finalInstr}`.replace(/[\/\\#\?]/g, '-');
    const monthKeys = Array.from(new Set(sortedRows.filter(r => {
      const key = buildEventKeyFromRow(r);
      return key === newKey || key === oldEventKey;
    }).map(r => normalizeMonthKeyFromDate(r.date)).filter(Boolean)));
    const nextConfigs = {
      ...eventConfigs
    };
    const mergedConfig = {
      ...(eventConfigs[oldEventKey] || {}),
      ...(newConfig || {})
    };
    mergedConfig.statusRules = normalizeStoredStatusRules(mergedConfig.statusRules || []);
    if (newKey !== oldEventKey) delete nextConfigs[oldEventKey];
    nextConfigs[newKey] = mergedConfig;
    pushEventVersionStatus('checking', `正在更新 ${editingEvent.date} 的活動設定...`);
    try {
      await handleSaveCSV(arrayToCSV(sortedRows));
      if (newKey !== oldEventKey) {
        await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', newKey), mergedConfig, {
          merge: true
        });
        await deleteDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', oldEventKey));
      } else {
        await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', oldEventKey), mergedConfig, {
          merge: true
        });
      }
      await saveEventScheduleVersionEntry({
        action: 'save',
        monthKeys: monthKeys.length > 0 ? monthKeys : [normalizeMonthKeyFromDate(editingEvent.date)],
        previousRows: parsedData,
        nextRows: sortedRows,
        previousConfigs: eventConfigs,
        nextConfigs
      });
      pushEventVersionStatus('success', `已更新 ${editingEvent.date} 的活動設定`);
    } catch (e) {
      console.error('Save event config failed', e);
      pushEventVersionStatus('error', `更新失敗：${formatFirestoreError(e)}`);
      alert(`❌ 活動設定更新失敗：${formatFirestoreError(e)}`);
    }
  };
  const handleSaveTemplate = async tpl => {
    if (templatesLoadState !== 'success') {
      throw new Error('模板尚未載入完成，請稍候再試。');
    }
    const normalizedTemplate = normalizeQuickCreateTemplate(tpl);
    const templateList = (Array.isArray(customTemplates) ? customTemplates : []).map(normalizeQuickCreateTemplate);
    const normalizedTemplateKey = getTemplateEventNameKey(normalizedTemplate);
    let updateIndex = -1;
    if (normalizedTemplate.id) {
      updateIndex = templateList.findIndex(t => t.id === normalizedTemplate.id);
    }
    if (updateIndex < 0 && normalizedTemplateKey) {
      updateIndex = templateList.map(getTemplateEventNameKey).lastIndexOf(normalizedTemplateKey);
    }
    let newList = templateList.map((t, idx) => {
      if (idx !== updateIndex) return t;
      return {
        ...normalizedTemplate,
        id: t.id || normalizedTemplate.id || `custom_${Date.now()}`
      };
    });
    if (updateIndex < 0) {
      newList = [...templateList, {
        ...normalizedTemplate,
        id: normalizedTemplate.id || `custom_${Date.now()}`
      }];
    }
    const normalizedList = newList.map(normalizeQuickCreateTemplate);
    setCustomTemplates(normalizedList);
    return setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'templates'), {
      list: normalizedList
    }, {
      merge: true
    });
  };
  const handleAddTemplate = tpl => handleSaveTemplate(tpl);
  const onDeleteTemplate = async id => {
    if (templatesLoadState !== 'success') {
      alert('模板尚未載入完成，請稍候再試。');
      return;
    }
    if (confirm("確定刪除?")) {
      const nextList = (Array.isArray(customTemplates) ? customTemplates : []).filter(t => t.id !== id);
      setCustomTemplates(nextList);
      return setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'templates'), {
        list: nextList
      }, {
        merge: true
      });
    }
  };
  const handleReorderTemplates = async (targetTemplate, direction, categoryFilter = 'all') => {
    if (templatesLoadState !== 'success') {
      alert('模板尚未載入完成，請稍候再試。');
      return;
    }
    const currentList = (Array.isArray(customTemplates) ? customTemplates : []).map(normalizeQuickCreateTemplate);
    const visibleIndices = currentList.map((tpl, idx) => ({ tpl, idx })).filter(({ tpl }) => categoryFilter === 'all' || tpl.templateCategory === categoryFilter).map(({ idx }) => idx);
    const targetKey = getQuickCreateTemplateStableKey(targetTemplate);
    const currentVisibleIndex = visibleIndices.findIndex(idx => getQuickCreateTemplateStableKey(currentList[idx]) === targetKey);
    const nextVisibleIndex = currentVisibleIndex + (direction === 'up' ? -1 : 1);
    if (currentVisibleIndex < 0 || nextVisibleIndex < 0 || nextVisibleIndex >= visibleIndices.length) return;
    const fromIndex = visibleIndices[currentVisibleIndex];
    const toIndex = visibleIndices[nextVisibleIndex];
    const nextList = [...currentList];
    [nextList[fromIndex], nextList[toIndex]] = [nextList[toIndex], nextList[fromIndex]];
    setCustomTemplates(nextList);
    try {
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'templates'), {
        list: nextList
      }, {
        merge: true
      });
    } catch (e) {
      setCustomTemplates(currentList);
      console.error('Reorder templates failed', e);
      alert(`❌ 模板排序儲存失敗：${formatFirestoreError(e)}`);
    }
  };
  const handleUpdateProject = async (pid, newData) => {
    await updateDoc(doc(db, `artifacts/${dbSource}/public/data`, 'projects', pid), newData);
  };
  const handleProjectStatus = async (pid, status) => {
    const next = status === 'Stuck' ? 'To Do' : status === 'To Do' ? 'In Progress' : status === 'In Progress' ? 'Done' : 'Stuck';
    await updateDoc(doc(db, `artifacts/${dbSource}/public/data`, 'projects', pid), {
      status: next
    });
  };
  const handleAddProject = async () => {
    const name = prompt("專案名稱:");
    if (name) await addDoc(collection(db, `artifacts/${dbSource}/public/data`, 'projects'), {
      name,
      owner: 'Team',
      status: 'To Do',
      deadline: getLocalDateStr(),
      subTasks: [],
      cloudLink: ''
    });
  };
  const handleDeleteProject = async pid => {
    await deleteDoc(doc(db, `artifacts/${dbSource}/public/data`, 'projects', pid));
  };
  const handleAddPromise = async data => {
    await addDoc(collection(db, `artifacts/${dbSource}/public/data`, 'promises'), {
      ...data,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    setShowAddPromise(false);
  };
  const handleTogglePromise = async (id, currentStatus) => {
    await updateDoc(doc(db, `artifacts/${dbSource}/public/data`, 'promises', id), {
      status: currentStatus === 'done' ? 'pending' : 'done'
    });
  };
  const handleDeletePromise = async id => {
    if (confirm("刪除此承諾？")) await deleteDoc(doc(db, `artifacts/${dbSource}/public/data`, 'promises', id));
  };
  const handleDeleteEvent = async () => {
    if (!editingEvent) return;
    const {
      date,
      eventName,
      key
    } = editingEvent;
    pushEventDeleteStatus('checking', `準備刪除：${date} ${eventName}`);
    if (!confirm(`確定要刪除「${date} ${eventName}」嗎？\n⚠️ 警告：這將會刪除該場次的所有報名資料，無法復原！`)) {
      pushEventDeleteStatus('warning', '已取消刪除');
      return;
    }
    const newRows = parsedData.filter(r => {
      const sortedInstr = r.instructor ? r.instructor.split(/[&,]/).map(s => s.trim()).sort().join(' & ') : '';
      const rowKey = `${r.date}_${r.eventName}_${sortedInstr}`.replace(/[\/\\#\?]/g, '-');
      return rowKey !== key;
    });
    const sortedRows = sortEventRows(newRows);
    const monthKeys = [normalizeMonthKeyFromDate(date)].filter(Boolean);
    const nextConfigs = {
      ...eventConfigs
    };
    // 防呆：講師順序可能與文件 ID 不一致（如「口永 & 世祥」vs「世祥 & 口永」），
    // 用 日期_活動名 前綴＋講師正規化比對，把同場次的所有 key 變體一起刪，避免留下孤兒
    const _cfgPrefix = `${date}_${eventName}_`.replace(/[\/\\#\?]/g, '-');
    const _normInstr = s => String(s || '').split(/[&,]/).map(x => x.trim()).filter(Boolean).sort().join(' & ');
    const _targetInstr = key.startsWith(_cfgPrefix) ? _normInstr(key.slice(_cfgPrefix.length)) : '';
    const _cfgKeysToRemove = [...new Set([key, ...Object.keys(eventConfigs).filter(k => k.startsWith(_cfgPrefix) && _normInstr(k.slice(_cfgPrefix.length)) === _targetInstr)])];
    _cfgKeysToRemove.forEach(k => delete nextConfigs[k]);
    try {
      pushEventVersionStatus('checking', `正在刪除 ${date} ${eventName}...`);
      await handleSaveCSV(arrayToCSV(sortedRows));
    } catch (e) {
      pushEventDeleteStatus('error', `刪除失敗：${formatFirestoreError(e)}`);
      pushEventVersionStatus('error', `刪除失敗：${formatFirestoreError(e)}`);
      return;
    }
    try {
      for (const k of _cfgKeysToRemove) {
        await deleteDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', k));
      }
    } catch (e) {
      console.warn('event_configs 刪除失敗（前台可能殘留孤兒場次）', e);
      pushEventDeleteStatus('warning', `場次設定檔刪除失敗，公開行事曆可能殘留：${formatFirestoreError(e)}`);
    }
    try {
      await saveEventScheduleVersionEntry({
        action: 'delete',
        monthKeys,
        previousRows: parsedData,
        nextRows: sortedRows,
        previousConfigs: eventConfigs,
        nextConfigs
      });
      pushEventVersionStatus('success', `已刪除 ${date} ${eventName}，並留下版本紀錄`);
    } catch (e) {
      console.error('Delete event version save failed', e);
      pushEventVersionStatus('error', `刪除已完成，但版本紀錄失敗：${formatFirestoreError(e)}`);
    }
    setEditingEvent(null);
    pushEventDeleteStatus('success', `已刪除活動並寫入 Firebase：${date} ${eventName}`);
    alert('✅ 活動已刪除並寫入 Firebase');
  };
  const handleAddTagDefinition = async (type, newValue) => {
    const safeValue = toSafeDisplayText(newValue, '').trim();
    if (!safeValue) return;
    const currentList = (tagDefinitions[type] || []).map(item => toSafeDisplayText(item, '').trim()).filter(Boolean);
    if (currentList.includes(safeValue)) return;
    const newDefs = normalizeTagDefinitionsForDisplay({
      ...tagDefinitions,
      [type]: [...currentList, safeValue]
    });
    setTagDefinitions(newDefs);
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
      tagDefinitions: newDefs
    }, {
      merge: true
    });
  };
  const stats = useMemo(() => {
    const totalRev = parsedData.reduce((a, c) => a + c.price, 0);
    const events = {};
    const instrs = {};
    parsedData.forEach(c => {
      const sortedInstr = c.instructor ? c.instructor.split(/[&,]/).map(s => s.trim()).sort().join(' & ') : '';
      const key = `${c.date}_${c.eventName}_${sortedInstr}`.replace(/[\/\\#\?]/g, '-');
      if (!events[key]) events[key] = {
        ...c,
        count: 0,
        customers: [],
        key
      };
      if (c.customerName !== '開放報名中') {
        events[key].count++;
        events[key].customers.push(c);
      }
      if (c.instructor) c.instructor.split(/[&,]/).forEach(i => {
        const name = i.trim();
        if (name && name !== '未定') instrs[name] = (instrs[name] || 0) + 1;
      });
    });
    return {
      totalRev,
      totalPax: parsedData.length,
      events,
      instrs
    };
  }, [parsedData]);
  const dashboardData = useMemo(() => {
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthlyGroups = {};
    const normalizeMonthKey = value => {
      const raw = String(value || '').trim();
      const match = raw.match(/^(\d{4})[\/-](\d{1,2})/);
      if (!match) return raw.slice(0, 7);
      return `${match[1]}-${String(parseInt(match[2], 10)).padStart(2, '0')}`;
    };
    parsedData.forEach(c => {
      if (!c.date) return;
      const m = normalizeMonthKey(c.date);
      if (!m || c.customerName === '開放報名中') return;
      if (!monthlyGroups[m]) monthlyGroups[m] = [];
      monthlyGroups[m].push(c);
    });
    const validCurrentMonthEvents = Object.values(stats.events || {}).filter(evt => {
      if (!evt?.date) return false;
      if (normalizeMonthKey(evt.date) !== currentMonthStr) return false;
      const cfg = eventConfigs?.[evt.key] || {};
      return !cfg.isCancelled;
    });
    const currentMonthRev = validCurrentMonthEvents.reduce((sum, evt) => {
      const customers = Array.isArray(evt.customers) ? evt.customers : [];
      return sum + customers.reduce((customerSum, customer) => customerSum + (Number(customer.price) || 0), 0);
    }, 0);
    const currentMonthPax = validCurrentMonthEvents.reduce((sum, evt) => {
      const customers = Array.isArray(evt.customers) ? evt.customers : [];
      const paxCount = Number.isFinite(Number(evt.count)) ? Number(evt.count) : customers.length;
      return sum + paxCount;
    }, 0);
    const currentMonthGroups = validCurrentMonthEvents.length;
    return {
      monthlyGroups,
      currentMonthRev,
      currentMonthPax,
      currentMonthGroups
    };
  }, [parsedData, stats.events, eventConfigs]);
  const tasks = useMemo(() => {
    const list = [];
    Object.values(stats.events).forEach(evt => {
      const cfg = eventConfigs[evt.key] || {};
      const tList = cfg.tasks || DEFAULT_TASKS_TEMPLATE;
      tList.forEach((t, i) => {
        if (!t.completed) list.push({
          ...t,
          taskIdx: i,
          evtDate: evt.date,
          evtName: evt.eventName,
          cfgKey: evt.key,
          style: getTaskStatusStyle(t.type, evt.date),
          fullEvent: evt
        });
      });
    });
    return list.sort((a, b) => new Date(a.evtDate) - new Date(b.evtDate));
  }, [stats.events, eventConfigs]);
  const toggleTask = async (key, idx) => {
    const cfg = eventConfigs[key] || {};
    const tList = cfg.tasks || JSON.parse(JSON.stringify(DEFAULT_TASKS_TEMPLATE));
    tList[idx].completed = !tList[idx].completed;
    await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', key), {
      ...cfg,
      tasks: tList
    }, {
      merge: true
    });
  };
  const [ltvTimeframe, setLtvTimeframe] = useState('all');
  const ltvStats = useMemo(() => {
    const now = new Date();
    const customerMetrics = {};
    let periodRevenue = 0;
    const normalizeDateKey = value => {
      const raw = String(value || '').trim();
      const match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
      if (!match) return '';
      return `${match[1]}-${String(parseInt(match[2], 10)).padStart(2, '0')}-${String(parseInt(match[3], 10)).padStart(2, '0')}`;
    };
    const getMonthSpan = (startDate, endDate) => {
      if (!startDate || !endDate) return 1;
      const [startYear, startMonth] = startDate.split('-').map(Number);
      const [endYear, endMonth] = endDate.split('-').map(Number);
      if (!startYear || !startMonth || !endYear || !endMonth) return 1;
      return Math.max(1, (endYear - startYear) * 12 + (endMonth - startMonth) + 1);
    };
    parsedData.forEach(d => {
      const name = d.customerName;
      if (!name || name === '開放報名中') return;
      let include = true;
      if (ltvTimeframe !== 'all') {
        const date = new Date(d.date);
        const diffTime = Math.abs(now - date);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (ltvTimeframe === 'year' && diffDays > 365) include = false;
        if (ltvTimeframe === 'quarter' && diffDays > 90) include = false;
        if (ltvTimeframe === 'month' && diffDays > 30) include = false;
      }
      if (!include) return;
      const price = parseInt(d.price, 10) || 0;
      const dateKey = normalizeDateKey(d.date);
      if (!customerMetrics[name]) {
        customerMetrics[name] = {
          totalRevenue: 0,
          purchaseCount: 0,
          firstDate: dateKey,
          lastDate: dateKey
        };
      }
      const metric = customerMetrics[name];
      metric.totalRevenue += price;
      metric.purchaseCount += 1;
      if (dateKey) {
        if (!metric.firstDate || dateKey < metric.firstDate) metric.firstDate = dateKey;
        if (!metric.lastDate || dateKey > metric.lastDate) metric.lastDate = dateKey;
      }
      periodRevenue += price;
    });
    const finalizedMetrics = {};
    Object.entries(customerMetrics).forEach(([name, metric]) => {
      const activeMonthSpan = getMonthSpan(metric.firstDate, metric.lastDate);
      finalizedMetrics[name] = {
        totalRevenue: metric.totalRevenue,
        purchaseCount: metric.purchaseCount,
        activeMonthSpan,
        firstDate: metric.firstDate,
        lastDate: metric.lastDate,
        avgRevenuePerOrder: metric.purchaseCount > 0 ? metric.totalRevenue / metric.purchaseCount : 0,
        avgMonthlyPurchaseCount: metric.purchaseCount > 0 ? metric.purchaseCount / activeMonthSpan : 0,
        avgMonthlyRevenue: metric.totalRevenue > 0 ? metric.totalRevenue / activeMonthSpan : 0
      };
    });
    const getRankValue = (name, mode) => {
      const metric = finalizedMetrics[name];
      if (!metric) return 0;
      if (mode === 'count') return metric.purchaseCount;
      if (mode === 'monthlyCount') return metric.avgMonthlyPurchaseCount;
      if (mode === 'monthlyRevenue') return metric.avgMonthlyRevenue;
      if (mode === 'avgOrderValue') return metric.avgRevenuePerOrder;
      return metric.totalRevenue;
    };
    const sortCustomers = mode => Object.keys(finalizedMetrics).sort((a, b) => {
      const diff = getRankValue(b, mode) - getRankValue(a, mode);
      if (Math.abs(diff) > 0.0001) return diff;
      const purchaseDiff = (finalizedMetrics[b]?.purchaseCount || 0) - (finalizedMetrics[a]?.purchaseCount || 0);
      if (purchaseDiff !== 0) return purchaseDiff;
      const revenueDiff = (finalizedMetrics[b]?.totalRevenue || 0) - (finalizedMetrics[a]?.totalRevenue || 0);
      if (revenueDiff !== 0) return revenueDiff;
      return a.localeCompare(b, 'zh-Hant');
    });
    const customerNames = Object.keys(finalizedMetrics);
    const activeCustomerCount = customerNames.length;
    const avgLtv = activeCustomerCount > 0 ? Math.round(periodRevenue / activeCustomerCount) : 0;
    return {
      customerMetrics: finalizedMetrics,
      sortedCustomersByMode: {
        ltv: sortCustomers('ltv'),
        count: sortCustomers('count'),
        monthlyCount: sortCustomers('monthlyCount'),
        monthlyRevenue: sortCustomers('monthlyRevenue'),
        avgOrderValue: sortCustomers('avgOrderValue')
      },
      getRankValue,
      avgLtv,
      periodRevenue,
      activeCustomerCount
    };
  }, [parsedData, ltvTimeframe]);
  const crmRankOptions = [{
    id: 'ltv',
    label: '總消費',
    title: 'LTV 排行榜',
    formatValue: value => `$${Math.round(value || 0).toLocaleString()}`,
    renderMeta: metric => `${metric.purchaseCount || 0} 次消費`
  }, {
    id: 'count',
    label: '消費總次數',
    title: '消費總次數排行榜',
    formatValue: value => `${Math.round(value || 0).toLocaleString()} 次`,
    renderMeta: metric => `總消費 $${Math.round(metric.totalRevenue || 0).toLocaleString()}`
  }, {
    id: 'monthlyCount',
    label: '平均每月消費次數',
    title: '平均每月消費次數排行榜',
    formatValue: value => `${Number(value || 0).toLocaleString('zh-TW', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })} 次/月`,
    renderMeta: metric => `${metric.purchaseCount || 0} 次消費 / ${metric.activeMonthSpan || 1} 個月`
  }, {
    id: 'monthlyRevenue',
    label: '平均每月消費金額',
    title: '平均每月消費金額排行榜',
    formatValue: value => `$${Math.round(value || 0).toLocaleString()}/月`,
    renderMeta: metric => `總消費 $${Math.round(metric.totalRevenue || 0).toLocaleString()}`
  }, {
    id: 'avgOrderValue',
    label: '平均每次消費',
    title: '平均客單價排行榜',
    formatValue: value => `$${Math.round(value || 0).toLocaleString()}`,
    renderMeta: metric => `${metric.purchaseCount || 0} 次消費`
  }];
  const crmRankOptionMap = Object.fromEntries(crmRankOptions.map(option => [option.id, option]));
  const activeCrmRankOption = crmRankOptionMap[crmRankMode] || crmRankOptionMap.ltv;
  const crmSortedCustomers = ltvStats.sortedCustomersByMode[crmRankMode] || ltvStats.sortedCustomersByMode.ltv || [];
  const filteredCrmCustomers = crmSortedCustomers.filter(c => c.toLowerCase().includes(crmSearchTerm.toLowerCase()));
  const customerProfile = useMemo(() => {
    if (!selectedCustomer) return null;
    const history = parsedData.filter(d => d.customerName === selectedCustomer);
    const totalSpend = history.reduce((a, c) => a + c.price, 0);
    const avgSpend = history.length ? Math.round(totalSpend / history.length) : 0;
    const lastReg = history[history.length - 1];
    return {
      history,
      totalSpend,
      avgSpend,
      email: lastReg?.email,
      source: lastReg?.source,
      idNo: lastReg?.idNo,
      birthday: lastReg?.birthday,
      transport: lastReg?.transport,
      phone: lastReg?.phone,
      socialName: lastReg?.socialName,
      notes: lastReg?.notes,
      latestRecord: lastReg
    };
  }, [selectedCustomer, parsedData]);
  const calendarDays = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    return Array(firstDay).fill(null).concat([...Array(daysInMonth).keys()].map(i => i + 1));
  }, [currentDate]);
  const publicRollingCalendarDays = useMemo(() => {
    const anchorYear = currentDate.getFullYear();
    const anchorMonth = currentDate.getMonth();
    const firstMonthStart = new Date(anchorYear, anchorMonth, 1);
    const secondMonthEnd = new Date(anchorYear, anchorMonth + 2, 0);
    const visibleStart = new Date(firstMonthStart);
    visibleStart.setDate(firstMonthStart.getDate() - firstMonthStart.getDay());
    const visibleEnd = new Date(secondMonthEnd);
    visibleEnd.setDate(secondMonthEnd.getDate() + (6 - secondMonthEnd.getDay()));
    const dayCount = Math.round((visibleEnd - visibleStart) / 86400000) + 1;
    return Array.from({
      length: dayCount
    }, (_, index) => {
      const dateObj = new Date(visibleStart);
      dateObj.setDate(visibleStart.getDate() + index);
      const year = dateObj.getFullYear();
      const month = dateObj.getMonth();
      const day = dateObj.getDate();
      const weekIndex = Math.floor(index / 7);
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return {
        dateObj,
        dateStr,
        year,
        month,
        day,
        monthKey: `${year}-${String(month + 1).padStart(2, '0')}`,
        monthLabel: `${month + 1}月`,
        weekIndex
      };
    });
  }, [currentDate]);
  const currentMonthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
  const currentMonthLabel = `${currentDate.getFullYear()}年 ${currentDate.getMonth() + 1}月`;
  const currentMonthKpiTarget = useMemo(() => {
    const raw = monthlyKpis[currentMonthKey] || {};
    return {
      totalPax: raw.totalPax ?? '',
      inventoryDays: raw.inventoryDays ?? '',
      avgPaxPerSession: raw.avgPaxPerSession ?? '',
      fillRate: raw.fillRate ?? '',
      activityTargets: {
        ...(raw.activityTargets || {})
      }
    };
  }, [monthlyKpis, currentMonthKey]);
  const currentMonthPlan = useMemo(() => {
    const raw = monthlyPlans[currentMonthKey] || {};
    const activityInputs = {};
    const placementList = [];
    Object.entries(raw?.activityInputs || {}).forEach(([name, metrics]) => {
      const cleanName = String(name || '').trim();
      if (!cleanName) return;
      activityInputs[cleanName] = normalizePlanActivityInput(metrics, cleanName);
    });
    (Array.isArray(raw?.calendarPlacements) ? raw.calendarPlacements : []).forEach((placement, index) => {
      const eventName = String(placement?.eventName || '').trim();
      const instructorName = String(placement?.instructorName || '').trim();
      const dateKey = String(placement?.dateKey || '').trim();
      if (!eventName || !instructorName || !dateKey) return;
      placementList.push({
        id: String(placement?.id || `${currentMonthKey}_${index}_${buildPlanningCellKey(dateKey, instructorName)}`),
        eventName,
        instructorName,
        dateKey
      });
    });
    return {
      activityInputs,
      calendarPlacements: sortPlanningPlacements(placementList),
      profitSplit: normalizePlanProfitSplit(raw?.profitSplit)
    };
  }, [monthlyPlans, currentMonthKey]);
  const remoteMonthlyPlans = useMemo(() => {
    const merged = {};
    Object.entries(legacyMonthlyPlans || {}).forEach(([monthKey, raw]) => {
      merged[monthKey] = sanitizeMonthlyPlanEntry(raw, monthKey);
    });
    Object.entries(storedMonthlyPlanDocs || {}).forEach(([monthKey, raw]) => {
      merged[monthKey] = sanitizeMonthlyPlanEntry(raw, monthKey);
    });
    return merged;
  }, [legacyMonthlyPlans, storedMonthlyPlanDocs]);
  useEffect(() => {
    setKpiSaveStatus('idle');
  }, [currentMonthKey]);
  useEffect(() => {
    setPlanningSaveStatus('idle');
  }, [currentMonthKey]);
  useEffect(() => {
    setMonthlyPlans(prev => {
      const next = {
        ...prev
      };
      Object.keys(next).forEach(monthKey => {
        if (!remoteMonthlyPlans[monthKey] && !planningDirtyMonthsRef.current.has(monthKey)) {
          delete next[monthKey];
        }
      });
      Object.entries(remoteMonthlyPlans).forEach(([monthKey, raw]) => {
        if (planningDirtyMonthsRef.current.has(monthKey)) return;
        next[monthKey] = cloneMonthlyPlanEntry(raw, monthKey);
      });
      return next;
    });
  }, [remoteMonthlyPlans]);
  useEffect(() => {
    try {
      localStorage.setItem('crm_admin_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
    } catch (e) {
      console.warn('Sidebar preference save failed', e);
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem('crm_planning_operator_name', planningOperatorName);
    } catch (e) {
      console.warn('Planning operator preference save failed', e);
    }
  }, [planningOperatorName]);
  useEffect(() => {
    try {
      localStorage.setItem('crm_event_version_operator_name', eventVersionOperatorName);
    } catch (e) {
      console.warn('Event version operator preference save failed', e);
    }
  }, [eventVersionOperatorName]);
  useEffect(() => {
    if (!db || !user || viewMode !== 'admin' || activeTab !== 'planning') {
      setCurrentMonthPlanVersions([]);
      return undefined;
    }
    const basePath = `artifacts/${dbSource}/public/data`;
    const versionsRef = collection(db, basePath, 'monthly_plans', currentMonthKey, 'versions');
    const versionsQuery = versionsRef && typeof versionsRef.orderBy === 'function' ? versionsRef.orderBy('savedAtMs', 'desc').limit(8) : versionsRef;
    return onSnapshot(versionsQuery, snapshot => {
      const nextVersions = [];
      if (snapshot) snapshot.forEach(d => nextVersions.push({
        id: d.id,
        ...sanitizeFirebaseValue(d.data() || {})
      }));
      nextVersions.sort((a, b) => (Number(b.savedAtMs) || 0) - (Number(a.savedAtMs) || 0));
      setCurrentMonthPlanVersions(nextVersions);
    });
  }, [db, user, dbSource, currentMonthKey, viewMode, activeTab]);
  useEffect(() => {
    if (!db || !user || viewMode !== 'admin' || activeTab !== 'events') {
      setEventScheduleVersions([]);
      return undefined;
    }
    const basePath = `artifacts/${dbSource}/public/data`;
    const versionsRef = collection(db, basePath, 'event_schedule_versions');
    const versionsQuery = versionsRef && typeof versionsRef.orderBy === 'function' ? versionsRef.orderBy('savedAtMs', 'desc').limit(30) : versionsRef;
    return onSnapshot(versionsQuery, snapshot => {
      const nextVersions = [];
      if (snapshot) snapshot.forEach(d => nextVersions.push({
        id: d.id,
        ...sanitizeFirebaseValue(d.data() || {})
      }));
      nextVersions.sort((a, b) => (Number(b.savedAtMs) || 0) - (Number(a.savedAtMs) || 0));
      setEventScheduleVersions(nextVersions.filter(version => {
        const monthKeys = Array.isArray(version.monthKeys) ? version.monthKeys : version.monthKey ? [version.monthKey] : [];
        return monthKeys.includes(currentMonthKey);
      }).slice(0, 8));
    });
  }, [db, user, dbSource, currentMonthKey, viewMode, activeTab]);
  useEffect(() => {
    setEventVersionStatus({
      status: 'idle',
      message: '',
      at: ''
    });
  }, [currentMonthKey]);
  const allEventNames = useMemo(() => Array.from(new Set(Object.values(stats.events).map(evt => evt.eventName).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [stats.events]);
  const currentMonthKpiActuals = useMemo(() => {
    const year = currentDate.getFullYear();
    const monthIndex = currentDate.getMonth();
    const monthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const todayKey = getLocalDateStr();
    const daysInMonth = getDaysInMonth(year, monthIndex);
    const monthDates = Array.from({
      length: daysInMonth
    }, (_, idx) => `${monthKey}-${String(idx + 1).padStart(2, '0')}`);
    const companyRestSet = new Set(companyRestDates.filter(date => String(date || '').startsWith(`${monthKey}-`)));
    const eventBusySet = new Set();
    const occupiedSet = new Set();
    const busyInstructorByDate = {};
    const instructorEntryMap = {};
    const activityMap = {};
    let totalPax = 0;
    let completedPax = 0;
    let upcomingPax = 0;
    let totalSessions = 0;
    let completedSessions = 0;
    let upcomingSessions = 0;
    let totalCapacity = 0;
    const normalizeName = value => String(value || '').trim();
    const normalizeDateKey = value => {
      const raw = String(value || '').trim();
      const match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
      if (!match) return '';
      return `${match[1]}-${String(parseInt(match[2], 10)).padStart(2, '0')}-${String(parseInt(match[3], 10)).padStart(2, '0')}`;
    };
	    const normalizeNameList = list => {
	      const source = Array.isArray(list) ? list : getAllScheduleRestNames(list);
	      return source.map(item => normalizeName(item)).filter(name => name && name !== '未定');
	    };
    const parseInstructorNames = value => String(value || '').split(/[&,、，]/).map(part => normalizeName(part)).filter(name => name && name !== '未定');
    const shiftDate = (dateKey, offset) => {
      const [y, m, d] = String(dateKey || '').split('-').map(Number);
      const dt = new Date(y, (m || 1) - 1, d || 1);
      dt.setDate(dt.getDate() + offset);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    const addBusyInstructors = (dateKey, names) => {
      if (!dateKey || !dateKey.startsWith(`${monthKey}-`) || !Array.isArray(names) || names.length === 0) return;
      if (!busyInstructorByDate[dateKey]) busyInstructorByDate[dateKey] = new Set();
      names.forEach(name => {
        const clean = normalizeName(name);
        if (clean && clean !== '未定') busyInstructorByDate[dateKey].add(clean);
      });
    };
    const addInstructorEntries = (dateKey, names, entry) => {
      if (!dateKey || !dateKey.startsWith(`${monthKey}-`) || !Array.isArray(names) || names.length === 0 || !entry) return;
      names.forEach(name => {
        const clean = normalizeName(name);
        if (!clean || clean === '未定') return;
        if (!instructorEntryMap[clean]) instructorEntryMap[clean] = {};
        if (!instructorEntryMap[clean][dateKey]) instructorEntryMap[clean][dateKey] = [];
        const entries = instructorEntryMap[clean][dateKey];
        if (!entries.some(item => item.key === entry.key)) entries.push(entry);
      });
    };
    const getAssignedInstructors = (evt, cfg) => {
      const leadNames = normalizeNameList(cfg.leadInstructors);
      const supportNames = normalizeNameList(cfg.supportInstructors);
      if (leadNames.length === 0 && supportNames.length === 0) {
        return Array.from(new Set(parseInstructorNames(evt.instructor)));
      }
      return Array.from(new Set([...leadNames, ...supportNames]));
    };
    const instructorPool = new Set();
    Object.keys(stats.instrs || {}).forEach(name => {
      const clean = normalizeName(name);
      if (clean && clean !== '未定') instructorPool.add(clean);
    });
    Object.values(instructorSchedule || {}).forEach(list => {
      normalizeNameList(list).forEach(name => instructorPool.add(name));
    });
    Object.values(eventConfigs || {}).forEach(cfg => {
      normalizeNameList(cfg?.leadInstructors).forEach(name => instructorPool.add(name));
      normalizeNameList(cfg?.supportInstructors).forEach(name => instructorPool.add(name));
    });
    Object.values(stats.events).forEach(evt => {
      parseInstructorNames(evt.instructor).forEach(name => instructorPool.add(name));
    });
    Object.values(outingDays || {}).forEach(info => {
      normalizeNameList(info?.people).forEach(name => instructorPool.add(name));
    });
    const instructorNames = Array.from(instructorPool).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    Object.values(stats.events).forEach(evt => {
      const eventDateKey = normalizeDateKey(evt.date);
      if (!eventDateKey) return;
      const cfg = eventConfigs[evt.key] || {};
      if (cfg.isCancelled) return;
      const prepDays = parseInt(cfg.prepDays, 10) || 0;
      const duration = parseInt(cfg.duration, 10) || 1;
      const assignedInstructors = getAssignedInstructors(evt, cfg);
      const eventTitle = normalizeName(evt.eventName || cfg.displayName) || '未命名活動';
      for (let offset = -prepDays; offset < duration; offset += 1) {
        const occupiedDate = shiftDate(eventDateKey, offset);
        if (!occupiedDate.startsWith(`${monthKey}-`)) continue;
        occupiedSet.add(occupiedDate);
        addBusyInstructors(occupiedDate, assignedInstructors);
        addInstructorEntries(occupiedDate, assignedInstructors, {
          key: `${evt.key}_${offset}`,
          title: eventTitle,
          note: offset < 0 ? `前置 D${prepDays + offset + 1}` : offset > 0 ? `跨日 D${offset + 1}` : '',
          type: offset < 0 ? 'prep' : offset > 0 ? 'cont' : 'main'
        });
        if (offset >= 0) eventBusySet.add(occupiedDate);
      }
      if (!eventDateKey.startsWith(`${monthKey}-`)) return;
      const paxCount = Number.isFinite(Number(evt.count)) ? Number(evt.count) : Array.isArray(evt.customers) ? evt.customers.length : 0;
      const capacity = parseInt(cfg.capacity, 10) || 12;
      const bucket = eventDateKey < todayKey ? 'completed' : 'upcoming';
      const customers = Array.isArray(evt.customers) ? evt.customers : [];
      const fallbackUnitPrice = Number(cfg.price) || 0;
      const eventRevenue = customers.length > 0 ? customers.reduce((sum, customer) => sum + (Number(customer.price) || fallbackUnitPrice), 0) : fallbackUnitPrice * paxCount;
      totalSessions += 1;
      totalPax += paxCount;
      totalCapacity += capacity;
      if (bucket === 'completed') {
        completedSessions += 1;
        completedPax += paxCount;
      } else {
        upcomingSessions += 1;
        upcomingPax += paxCount;
      }
      if (!activityMap[evt.eventName]) {
        activityMap[evt.eventName] = {
          total: 0,
          completed: 0,
          upcoming: 0,
          totalPax: 0,
          totalRevenue: 0
        };
      }
      activityMap[evt.eventName].total += 1;
      activityMap[evt.eventName][bucket] += 1;
      activityMap[evt.eventName].totalPax += paxCount;
      activityMap[evt.eventName].totalRevenue += eventRevenue;
    });
    let outingDaysCount = 0;
    Object.entries(outingDays || {}).forEach(([dateKey, info]) => {
      if (info?.enabled && String(dateKey).startsWith(`${monthKey}-`)) {
        occupiedSet.add(dateKey);
        outingDaysCount += 1;
        const outingPeople = normalizeNameList(info.people);
        addBusyInstructors(dateKey, outingPeople);
        addInstructorEntries(dateKey, outingPeople, {
          key: `outing_${dateKey}`,
          title: normalizeName(info?.label || info?.title || info?.name) || '外出',
          note: '場勘 / 取材',
          type: 'outing'
        });
      }
    });
    const workableDays = monthDates.filter(dateKey => !companyRestSet.has(dateKey));
    const occupiedWorkableDays = workableDays.filter(dateKey => occupiedSet.has(dateKey));
    const instructorAvailabilityMap = Object.fromEntries(instructorNames.map(name => [name, {
      availableDates: [],
      upcomingAvailableDates: [],
      busyDates: [],
      upcomingBusyDates: [],
      restDates: [],
      upcomingRestDates: []
    }]));
    let availableInstructorDays = 0;
    let busyInstructorDays = 0;
    let restInstructorDays = 0;
    let inventoryInstructorDays = 0;
    let remainingAvailableInstructorDays = 0;
    workableDays.forEach(dateKey => {
      const busySet = busyInstructorByDate[dateKey] || new Set();
      const restingSet = new Set(normalizeNameList(instructorSchedule[dateKey]).filter(name => !busySet.has(name)));
      instructorNames.forEach(name => {
        const entry = instructorAvailabilityMap[name];
        if (restingSet.has(name)) {
          restInstructorDays += 1;
          entry.restDates.push(dateKey);
          if (dateKey >= todayKey) entry.upcomingRestDates.push(dateKey);
          return;
        }
        availableInstructorDays += 1;
        if (busySet.has(name)) {
          busyInstructorDays += 1;
          entry.busyDates.push(dateKey);
          if (dateKey >= todayKey) entry.upcomingBusyDates.push(dateKey);
        } else {
          inventoryInstructorDays += 1;
          entry.availableDates.push(dateKey);
          if (dateKey >= todayKey) {
            entry.upcomingAvailableDates.push(dateKey);
            remainingAvailableInstructorDays += 1;
          }
        }
      });
    });
    const availabilityByInstructor = instructorNames.map(name => ({
      name,
      availableDates: instructorAvailabilityMap[name].availableDates,
      upcomingAvailableDates: instructorAvailabilityMap[name].upcomingAvailableDates,
      availableCount: instructorAvailabilityMap[name].availableDates.length,
      upcomingAvailableCount: instructorAvailabilityMap[name].upcomingAvailableDates.length,
      busyCount: instructorAvailabilityMap[name].busyDates.length,
      upcomingBusyCount: instructorAvailabilityMap[name].upcomingBusyDates.length,
      restCount: instructorAvailabilityMap[name].restDates.length,
      upcomingRestCount: instructorAvailabilityMap[name].upcomingRestDates.length
    })).sort((a, b) => b.upcomingAvailableCount - a.upcomingAvailableCount || a.upcomingBusyCount - b.upcomingBusyCount || a.name.localeCompare(b.name, 'zh-Hant'));
    const availabilityMatrix = availabilityByInstructor.map(row => ({
      ...row,
      cells: monthDates.map(dateKey => {
        const entries = instructorEntryMap[row.name]?.[dateKey] || [];
        const isPast = dateKey < todayKey;
        if (companyRestSet.has(dateKey)) return {
          dateKey,
          state: 'companyRest',
          label: '公',
          isPast,
          entries
        };
        const busySet = busyInstructorByDate[dateKey] || new Set();
        const restingSet = new Set(normalizeNameList(instructorSchedule[dateKey]).filter(name => !busySet.has(name)));
        if (restingSet.has(row.name)) return {
          dateKey,
          state: 'rest',
          label: '休',
          isPast,
          entries
        };
        if (busySet.has(row.name)) return {
          dateKey,
          state: 'busy',
          label: '團',
          isPast,
          entries
        };
        return {
          dateKey,
          state: 'available',
          label: '可',
          isPast,
          entries
        };
      })
    }));
    const avgPaxPerSession = totalSessions > 0 ? totalPax / totalSessions : 0;
    const fillRate = totalCapacity > 0 ? totalPax / totalCapacity * 100 : 0;
    const utilizationRate = availableInstructorDays > 0 ? busyInstructorDays / availableInstructorDays * 100 : 0;
    const normalizedActivityMap = Object.fromEntries(Object.entries(activityMap).map(([name, data]) => [name, {
      ...data,
      avgPax: data.total > 0 ? Number((data.totalPax / data.total).toFixed(1)) : '',
      avgRevenuePerPax: data.totalPax > 0 && data.totalRevenue > 0 ? Math.round(data.totalRevenue / data.totalPax) : ''
    }]));
    return {
      totalPax,
      completedPax,
      upcomingPax,
      totalSessions,
      completedSessions,
      upcomingSessions,
      totalCapacity,
      companyRestDays: companyRestSet.size,
      workableDays: workableDays.length,
      occupiedDays: occupiedWorkableDays.length,
      inventoryDays: inventoryInstructorDays,
      availableInstructorDays,
      busyInstructorDays,
      restInstructorDays,
      remainingAvailableInstructorDays,
      availabilityByInstructor,
      availabilityMatrix,
      matrixDates: monthDates,
      todayKey,
      instructorCount: instructorNames.length,
      utilizationRate,
      avgPaxPerSession,
      fillRate,
      eventBusyDays: eventBusySet.size,
      outingDaysCount,
      activityMap: normalizedActivityMap
    };
  }, [currentDate, stats.events, stats.instrs, eventConfigs, companyRestDates, instructorSchedule, outingDays]);
  const currentMonthKpiRows = useMemo(() => {
    const targetMap = currentMonthKpiTarget.activityTargets || {};
    const names = Array.from(new Set([...Object.keys(currentMonthKpiActuals.activityMap || {}), ...Object.keys(targetMap).filter(name => targetMap[name] !== '' && targetMap[name] !== null && targetMap[name] !== undefined)]));
    return names.map(name => ({
      name,
      actual: currentMonthKpiActuals.activityMap[name] || {
        total: 0,
        completed: 0,
        upcoming: 0
      },
      target: targetMap[name] ?? ''
    })).sort((a, b) => b.actual.total - a.actual.total || a.name.localeCompare(b.name));
  }, [currentMonthKpiActuals, currentMonthKpiTarget]);
  const currentMonthPlanningData = useMemo(() => {
    const activityInputMap = currentMonthPlan.activityInputs || {};
    const placementList = Array.isArray(currentMonthPlan.calendarPlacements) ? currentMonthPlan.calendarPlacements : [];
    const profitSplit = normalizePlanProfitSplit(currentMonthPlan.profitSplit);
    const placementSessionMap = {};
    const placementsByCell = {};
    placementList.forEach(placement => {
      if (!placement?.eventName || !placement?.instructorName || !placement?.dateKey) return;
      if (!placementSessionMap[placement.eventName]) placementSessionMap[placement.eventName] = new Set();
      placementSessionMap[placement.eventName].add(String(placement.dateKey || '').trim());
      const cellKey = buildPlanningCellKey(placement.dateKey, placement.instructorName);
      if (!placementsByCell[cellKey]) placementsByCell[cellKey] = [];
      placementsByCell[cellKey].push(placement);
    });
    const placementCountMap = Object.fromEntries(Object.entries(placementSessionMap).map(([name, dateSet]) => [name, dateSet.size]));
    const activityNames = Array.from(new Set([...allEventNames, ...Object.keys(currentMonthKpiActuals.activityMap || {}), ...Object.keys(activityInputMap || {}), ...Object.keys(placementCountMap || {})])).filter(Boolean);
    const activityRows = activityNames.map(name => {
      const isTracked = Object.prototype.hasOwnProperty.call(activityInputMap || {}, name) || Object.prototype.hasOwnProperty.call(placementCountMap || {}, name);
      const actualActivity = currentMonthKpiActuals.activityMap[name] || {};
      const actualSessions = actualActivity.total || 0;
      const simulatedActivityCount = placementCountMap[name] || 0;
      const activityCount = actualSessions + simulatedActivityCount;
      const manualAvgPax = activityInputMap[name]?.avgPax ?? '';
      const manualRevenuePerPax = activityInputMap[name]?.revenuePerPax ?? '';
      const manualCostPerPax = activityInputMap[name]?.costPerPax ?? '';
      const templateType = activityInputMap[name]?.templateType || inferPlanActivityTemplateType(name);
      const autoAvgPax = actualActivity.avgPax ?? '';
      const autoRevenuePerPax = actualActivity.avgRevenuePerPax ?? '';
      const autoCostPerPax = actualActivity.avgCostPerPax ?? '';
      const avgPax = manualAvgPax === '' ? autoAvgPax : manualAvgPax;
      const revenuePerPax = manualRevenuePerPax === '' ? autoRevenuePerPax : manualRevenuePerPax;
      const costPerPax = manualCostPerPax === '' ? autoCostPerPax : manualCostPerPax;
      const grossProfitPerPax = (Number(revenuePerPax) || 0) - (Number(costPerPax) || 0);
      const projectedGrossProfit = activityCount * (Number(avgPax) || 0) * grossProfitPerPax;
      return {
        name,
        actualSessions,
        activityCount,
        droppedSessions: simulatedActivityCount,
        simulatedSessions: simulatedActivityCount,
        isTracked,
        totalSessions: activityCount,
        templateType,
        avgPax,
        revenuePerPax,
        costPerPax,
        manualAvgPax,
        manualRevenuePerPax,
        manualCostPerPax,
        autoAvgPax,
        autoRevenuePerPax,
        autoCostPerPax,
        isAutoAvgPax: manualAvgPax === '' && autoAvgPax !== '',
        isAutoRevenuePerPax: manualRevenuePerPax === '' && autoRevenuePerPax !== '',
        isAutoCostPerPax: manualCostPerPax === '' && autoCostPerPax !== '',
        grossProfitPerPax,
        projectedGrossProfit
      };
    }).filter(row => row.actualSessions > 0 || row.activityCount > 0 || row.manualAvgPax !== '' || row.manualRevenuePerPax !== '' || row.manualCostPerPax !== '' || row.isTracked).sort((a, b) => b.activityCount - a.activityCount || b.simulatedSessions - a.simulatedSessions || a.name.localeCompare(b.name, 'zh-Hant'));
    const matrixRows = currentMonthKpiActuals.availabilityMatrix.map(row => ({
      ...row,
      cells: row.cells.map(cell => ({
        ...cell,
        simulatedPlacements: sortPlanningPlacements(placementsByCell[buildPlanningCellKey(cell.dateKey, row.name)] || []),
        simulatedPlacement: sortPlanningPlacements(placementsByCell[buildPlanningCellKey(cell.dateKey, row.name)] || [])[0] || null,
        canDrop: (cell.state === 'available' || cell.state === 'busy') && !cell.isPast
      })),
      openCount: row.cells.filter(cell => cell.state === 'available').length,
      actualBusyCount: row.cells.filter(cell => cell.state === 'busy').length,
      restCount: row.cells.filter(cell => cell.state === 'rest').length,
      simulatedCount: row.cells.reduce((sum, cell) => sum + ((placementsByCell[buildPlanningCellKey(cell.dateKey, row.name)] || []).length), 0)
    }));
    const simulatedInstructorDays = Object.keys(placementsByCell).length;
    const simulatedSessions = activityRows.reduce((sum, row) => sum + row.simulatedSessions, 0);
    const plannedPax = activityRows.reduce((sum, row) => sum + row.activityCount * (Number(row.avgPax) || 0), 0);
    const plannedGrossProfit = activityRows.reduce((sum, row) => sum + row.projectedGrossProfit, 0);
    const droppedSessions = activityRows.reduce((sum, row) => sum + row.droppedSessions, 0);
    const companyGrossProfit = plannedGrossProfit * ((profitSplit.companyPct || 0) / 100);
    const bonusGrossProfit = plannedGrossProfit * ((profitSplit.bonusPct || 0) / 100);
    const openInstructorDays = Math.max(0, (currentMonthKpiActuals.availableInstructorDays || 0) - (currentMonthKpiActuals.busyInstructorDays || 0) - simulatedInstructorDays);
    return {
      activityRows,
      activityInputMap,
      matrixRows,
      matrixDates: currentMonthKpiActuals.matrixDates,
      todayKey: currentMonthKpiActuals.todayKey,
      placementCount: placementList.length,
      profitSplit,
      summary: {
        totalSchedulableInstructorDays: currentMonthKpiActuals.availableInstructorDays,
        openInstructorDays,
        actualBusyInstructorDays: currentMonthKpiActuals.busyInstructorDays,
        simulatedInstructorDays,
        restInstructorDays: currentMonthKpiActuals.restInstructorDays,
        companyRestDays: currentMonthKpiActuals.companyRestDays,
        simulatedSessions,
        droppedSessions,
        plannedPax,
        plannedGrossProfit,
        companyGrossProfit,
        bonusGrossProfit
      }
    };
  }, [currentMonthPlan, currentMonthKpiActuals, allEventNames]);
  const updateCurrentMonthKpi = updater => {
    setMonthlyKpis(prev => {
      const raw = prev[currentMonthKey] || {};
      const draft = {
        totalPax: raw.totalPax ?? '',
        inventoryDays: raw.inventoryDays ?? '',
        avgPaxPerSession: raw.avgPaxPerSession ?? '',
        fillRate: raw.fillRate ?? '',
        activityTargets: {
          ...(raw.activityTargets || {})
        }
      };
      return {
        ...prev,
        [currentMonthKey]: updater(draft)
      };
    });
    setKpiSaveStatus('idle');
  };
  const updateCurrentMonthPlan = updater => {
    setMonthlyPlans(prev => {
      const raw = prev[currentMonthKey] || {};
      const draft = {
        activityInputs: {
          ...(raw.activityInputs || {})
        },
        calendarPlacements: Array.isArray(raw.calendarPlacements) ? raw.calendarPlacements.map(placement => ({
          ...placement
        })) : [],
        profitSplit: normalizePlanProfitSplit(raw.profitSplit)
      };
      return {
        ...prev,
        [currentMonthKey]: updater(draft)
      };
    });
    planningDirtyMonthsRef.current.add(currentMonthKey);
    setPlanningSaveStatus('idle');
  };
  const handleCurrentMonthKpiFieldChange = (field, value, allowFloat = false) => {
    const normalized = value === '' ? '' : allowFloat ? parseFloat(value) : parseInt(value, 10);
    updateCurrentMonthKpi(current => ({
      ...current,
      [field]: Number.isFinite(normalized) ? normalized : ''
    }));
  };
  const handleCurrentMonthActivityTargetChange = (eventName, value) => {
    updateCurrentMonthKpi(current => {
      const nextTargets = {
        ...(current.activityTargets || {})
      };
      if (value === '') delete nextTargets[eventName];else {
        const parsed = parseInt(value, 10);
        nextTargets[eventName] = Number.isFinite(parsed) ? parsed : 0;
      }
      return {
        ...current,
        activityTargets: nextTargets
      };
    });
  };
  const handleAddCurrentMonthActivityTarget = eventName => {
    if (!eventName) return;
    updateCurrentMonthKpi(current => ({
      ...current,
      activityTargets: {
        ...(current.activityTargets || {}),
        [eventName]: current.activityTargets?.[eventName] ?? 0
      }
    }));
  };
  const handleCurrentMonthPlanActivityMetricChange = (eventName, field, value) => {
    const cleanName = String(eventName || '').trim();
    if (!cleanName) return;
    updateCurrentMonthPlan(current => {
      const currentEntry = current.activityInputs?.[cleanName] || buildDefaultPlanActivityInput(inferPlanActivityTemplateType(cleanName));
      const parsed = value === '' ? '' : parseFloat(value);
      return {
        ...current,
        activityInputs: {
          ...(current.activityInputs || {}),
          [cleanName]: {
            ...currentEntry,
            [field]: Number.isFinite(parsed) ? parsed : ''
          }
        }
      };
    });
  };
  const handleBulkCurrentMonthPlanActivityMetricChange = (field, value, eventNames = []) => {
    const cleanNames = Array.from(new Set((eventNames || []).map(name => String(name || '').trim()).filter(Boolean)));
    if (cleanNames.length === 0) return;
    updateCurrentMonthPlan(current => {
      const parsed = value === '' ? '' : parseFloat(value);
      const nextInputs = {
        ...(current.activityInputs || {})
      };
      cleanNames.forEach(name => {
        const currentEntry = nextInputs[name] || buildDefaultPlanActivityInput(inferPlanActivityTemplateType(name));
        nextInputs[name] = {
          ...currentEntry,
          [field]: Number.isFinite(parsed) ? parsed : ''
        };
      });
      return {
        ...current,
        activityInputs: nextInputs
      };
    });
  };
  const handleCurrentMonthPlanProfitSplitChange = (field, value) => {
    const parsed = value === '' ? 0 : parseFloat(value);
    const safeValue = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
    updateCurrentMonthPlan(current => {
      const currentSplit = normalizePlanProfitSplit(current.profitSplit);
      const nextSplit = field === 'companyPct' ? {
        companyPct: Number(safeValue.toFixed(1)),
        bonusPct: Number((100 - safeValue).toFixed(1))
      } : {
        companyPct: Number((100 - safeValue).toFixed(1)),
        bonusPct: Number(safeValue.toFixed(1))
      };
      return {
        ...current,
        profitSplit: normalizePlanProfitSplit({
          ...currentSplit,
          ...nextSplit
        })
      };
    });
  };
  const handleAddCurrentMonthPlanActivity = activityPayload => {
    const rawName = typeof activityPayload === 'string' ? activityPayload : activityPayload?.name || activityPayload?.eventName || '';
    const rawTemplateType = typeof activityPayload === 'string' ? inferPlanActivityTemplateType(rawName) : activityPayload?.templateType;
    const draft = buildPlanningActivityDraft(rawName, rawTemplateType);
    if (!draft.name) return;
    updateCurrentMonthPlan(current => ({
      ...current,
      activityInputs: {
        ...(current.activityInputs || {}),
        [draft.name]: current.activityInputs?.[draft.name] || buildDefaultPlanActivityInput(draft.templateType)
      }
    }));
  };
  const handleRestoreCurrentMonthPlanVersion = async version => {
    if (!version?.snapshot || !user || !db) return alert("請先登入");
    const versionTime = formatPlanningVersionTimestamp(version.savedAt);
    const versionActor = String(version.savedByName || '').trim() || DEFAULT_PLANNING_OPERATOR_NAME;
    if (!confirm(`確定要把 ${currentMonthLabel} 還原成 ${versionTime}（${versionActor}）這版嗎？\n目前本月未儲存的調整會被覆蓋。`)) return;
    const basePath = `artifacts/${dbSource}/public/data`;
    const mainPlanRef = doc(db, basePath, 'monthly_plans', currentMonthKey);
    const versionRef = collection(db, basePath, 'monthly_plans', currentMonthKey, 'versions');
    const restoredEntry = sanitizeMonthlyPlanEntry(version.snapshot, currentMonthKey);
    const previousSavedEntry = storedMonthlyPlanDocs[currentMonthKey] || legacyMonthlyPlans[currentMonthKey] || null;
    const operatorName = String(planningOperatorName || '').trim() || DEFAULT_PLANNING_OPERATOR_NAME;
    const savedAt = new Date().toISOString();
    const versionMeta = buildPlanningVersionMeta(previousSavedEntry, restoredEntry, {
      action: 'restore'
    });
    const versionPayload = {
      monthKey: currentMonthKey,
      monthLabel: currentMonthLabel,
      action: 'restore',
      summary: `${versionMeta.summary}（來源：${versionTime}）`,
      details: versionMeta.details,
      savedAt,
      savedAtMs: Date.now(),
      savedByName: operatorName,
      savedByUid: user?.uid || 'anonymous',
      restoredFromVersionId: version.id || '',
      snapshot: restoredEntry
    };
    setPlanningSaveStatus('saving');
    try {
      await setDoc(mainPlanRef, restoredEntry, {});
      await addDoc(versionRef, versionPayload);
      setStoredMonthlyPlanDocs(prev => ({
        ...prev,
        [currentMonthKey]: cloneMonthlyPlanEntry(restoredEntry, currentMonthKey)
      }));
      setMonthlyPlans(prev => ({
        ...prev,
        [currentMonthKey]: cloneMonthlyPlanEntry(restoredEntry, currentMonthKey)
      }));
      planningDirtyMonthsRef.current.delete(currentMonthKey);
      setPlanningSaveStatus('success');
      setTimeout(() => setPlanningSaveStatus('idle'), 2500);
    } catch (e) {
      console.error('Monthly planning restore failed', e);
      setPlanningSaveStatus('error');
      alert(`❌ 版本還原失敗：${formatFirestoreError(e)}`);
    }
  };
  const handleAssignCurrentMonthPlanPlacement = ({
    eventName,
    instructorName,
    dateKey,
    sourceDateKey,
    sourceInstructorName,
    sourcePlacementId
  }) => {
    const cleanEventName = String(eventName || '').trim();
    const cleanInstructorName = String(instructorName || '').trim();
    const cleanDateKey = String(dateKey || '').trim();
    const cleanSourcePlacementId = String(sourcePlacementId || '').trim();
    if (!cleanEventName || !cleanInstructorName || !cleanDateKey) return;
    const sourceKey = buildPlanningCellKey(sourceDateKey, sourceInstructorName);
    const targetKey = buildPlanningCellKey(cleanDateKey, cleanInstructorName);
    if (cleanSourcePlacementId) {
      const sourcePlacement = (Array.isArray(currentMonthPlan.calendarPlacements) ? currentMonthPlan.calendarPlacements : []).find(placement => String(placement?.id || '').trim() === cleanSourcePlacementId);
      if (sourcePlacement && buildPlanningCellKey(sourcePlacement.dateKey, sourcePlacement.instructorName) === targetKey) return;
    } else if (sourceKey && sourceKey === targetKey) {
      return;
    }
    updateCurrentMonthPlan(current => {
      const nextInputs = {
        ...(current.activityInputs || {}),
        [cleanEventName]: current.activityInputs?.[cleanEventName] || buildDefaultPlanActivityInput(inferPlanActivityTemplateType(cleanEventName))
      };
      const nextPlacements = (Array.isArray(current.calendarPlacements) ? current.calendarPlacements : []).filter(placement => String(placement?.id || '').trim() !== cleanSourcePlacementId);
      nextPlacements.push({
        id: cleanSourcePlacementId || buildPlanningPlacementId(cleanDateKey, cleanInstructorName, cleanEventName),
        eventName: cleanEventName,
        instructorName: cleanInstructorName,
        dateKey: cleanDateKey
      });
      return {
        ...current,
        activityInputs: nextInputs,
        calendarPlacements: sortPlanningPlacements(nextPlacements)
      };
    });
  };
  const handleRemoveCurrentMonthPlanPlacement = (instructorName, dateKey, placementId = '') => {
    const targetKey = buildPlanningCellKey(dateKey, instructorName);
    const targetPlacement = (Array.isArray(currentMonthPlan.calendarPlacements) ? currentMonthPlan.calendarPlacements : []).find(placement => {
      if (placementId) return String(placement?.id || '').trim() === String(placementId).trim();
      return buildPlanningCellKey(placement?.dateKey, placement?.instructorName) === targetKey;
    });
    if (targetPlacement && !confirm(`確定要移除 ${dateKey} ${instructorName} 的「${targetPlacement.eventName}」模擬安排嗎？`)) return;
    updateCurrentMonthPlan(current => ({
      ...current,
      calendarPlacements: (Array.isArray(current.calendarPlacements) ? current.calendarPlacements : []).filter(placement => String(placement?.id || '').trim() !== String(targetPlacement?.id || '').trim())
    }));
  };
  const handleClearCurrentMonthPlanPlacements = () => {
    updateCurrentMonthPlan(current => ({
      ...current,
      calendarPlacements: []
    }));
  };
  const calendarOccupancy = useMemo(() => {
    const map = {};
    Object.values(stats.events).forEach(evt => {
      if (!evt.date) return;
      const mainDate = parseLocalDateKey(evt.date);
      if (isNaN(mainDate.getTime())) return;
      const cfg = eventConfigs[evt.key] || {};
	      const duration = parseInt(cfg.duration) || 1;
	      const prepDays = parseInt(cfg.prepDays) || 0;
	      const prepTime = cfg.prepTime || '09:00';
	      const mainTime = cfg.time || '23:59';
	      const prepTimeSlot = normalizeScheduleTimeSlot(cfg.prepTimeSlot, inferScheduleTimeSlot(prepTime));
	      const mainTimeSlot = normalizeScheduleTimeSlot(cfg.timeSlot, inferScheduleTimeSlot(mainTime));
      for (let i = prepDays; i > 0; i--) {
        const d = new Date(mainDate);
        d.setDate(d.getDate() - i);
        const dateStr = formatLocalDateKey(d);
        if (!map[dateStr]) map[dateStr] = [];
        map[dateStr].push({
          type: 'prep',
	          evt,
	          cfg,
	          displayTime: prepTime,
	          timeSlot: prepTimeSlot,
	          label: `⚠️ 前置: ${evt.eventName}`
        });
      }
      for (let i = 0; i < duration; i++) {
        const d = new Date(mainDate);
        d.setDate(d.getDate() + i);
        const dateStr = formatLocalDateKey(d);
        if (!map[dateStr]) map[dateStr] = [];
        if (i === 0) {
          map[dateStr].push({
            type: 'main',
	            evt,
	            cfg,
	            displayTime: mainTime,
	            timeSlot: mainTimeSlot
          });
        } else {
          map[dateStr].push({
            type: 'cont',
	            evt,
	            cfg,
	            displayTime: '00:00',
	            timeSlot: mainTimeSlot,
	            label: `↳ D${i + 1}: ${evt.eventName}`
          });
        }
      }
    });
    Object.keys(map).forEach(date => {
      map[date].sort((a, b) => a.displayTime.localeCompare(b.displayTime));
    });
    return map;
  }, [stats.events, eventConfigs]);
  const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  const shiftPublicMonthWindow = monthOffset => setCurrentDate(date => {
    const targetYear = date.getFullYear();
    const targetMonth = date.getMonth() + monthOffset;
    const safeDay = Math.min(date.getDate(), getDaysInMonth(targetYear, targetMonth));
    return new Date(targetYear, targetMonth, safeDay);
  });
  const nextPublicMonthWindow = () => shiftPublicMonthWindow(1);
  const prevPublicMonthWindow = () => shiftPublicMonthWindow(-1);
  const checkEventMatchesFilters = (eventKey, filters = publicFilters) => {
    if (filters.level.length === 0 && filters.type.length === 0 && filters.location.length === 0) return true;
    const cfg = eventConfigs[eventKey] || {};
    const tags = cfg.tags || {};
    const matchLevel = filters.level.length === 0 || filters.level.includes(tags.levels);
    const matchType = filters.type.length === 0 || filters.type.includes(tags.types);
    const matchLocation = filters.location.length === 0 || filters.location.includes(tags.locations);
    return matchLevel && matchType && matchLocation;
  };
  const availableOptions = useMemo(() => {
    const result = {
      levels: new Set(),
      types: new Set(),
      locations: new Set()
    };
    const allEvents = Object.values(stats.events);
    allEvents.forEach(e => {
      const cfg = eventConfigs[e.key] || {};
      const t = cfg.tags || {};
      const matchType = publicFilters.type.length === 0 || publicFilters.type.includes(t.types);
      const matchLocation = publicFilters.location.length === 0 || publicFilters.location.includes(t.locations);
      if (matchType && matchLocation && t.levels) result.levels.add(t.levels);
    });
    allEvents.forEach(e => {
      const cfg = eventConfigs[e.key] || {};
      const t = cfg.tags || {};
      const matchLevel = publicFilters.level.length === 0 || publicFilters.level.includes(t.levels);
      const matchLocation = publicFilters.location.length === 0 || publicFilters.location.includes(t.locations);
      if (matchLevel && matchLocation && t.types) result.types.add(t.types);
    });
    allEvents.forEach(e => {
      const cfg = eventConfigs[e.key] || {};
      const t = cfg.tags || {};
      const matchLevel = publicFilters.level.length === 0 || publicFilters.level.includes(t.levels);
      const matchType = publicFilters.type.length === 0 || publicFilters.type.includes(t.types);
      if (matchLevel && matchType && t.locations) result.locations.add(t.locations);
    });
    return result;
  }, [stats.events, eventConfigs, publicFilters]);
  const matchingDates = useMemo(() => {
    const filtersActive = publicFilters.level.length > 0 || publicFilters.type.length > 0 || publicFilters.location.length > 0;
    if (!publicSearchTerm && !filtersActive) return [];
    return Object.values(stats.events).filter(e => {
      const cfg = eventConfigs[e.key] || {};
      const nameToCheck = cfg.displayName || e.eventName;
      if (!checkEventMatchesFilters(e.key)) return false;
      if (publicSearchTerm) {
        return nameToCheck.includes(publicSearchTerm) || e.instructor && e.instructor.includes(publicSearchTerm);
      }
      return true;
    }).map(e => e.date).sort();
  }, [publicSearchTerm, stats.events, eventConfigs, publicFilters]);
  const matchingMonths = useMemo(() => {
    const months = new Set(matchingDates.map(d => d.substring(0, 7)));
    return Array.from(months);
  }, [matchingDates]);
  const toggleFilter = (type, value) => {
    setPublicFilters(prev => {
      const list = prev[type];
      if (list.includes(value)) {
        return {
          ...prev,
          [type]: list.filter(item => item !== value)
        };
      } else {
        return {
          ...prev,
          [type]: [...list, value]
        };
      }
    });
  };
  const clearFilters = () => setPublicFilters({
    level: [],
    type: [],
    location: []
  });
  const hasActiveFilters = publicFilters.level.length > 0 || publicFilters.type.length > 0 || publicFilters.location.length > 0;
  const activeFilterCount = publicFilters.level.length + publicFilters.type.length + publicFilters.location.length;
  useEffect(() => {
    const selectedOuting = outingDays[selectedPublicDate];
    if (!selectedOuting?.enabled || selectedOuting?.posterFilename) {
      setSelectedOutingPosterRandom(null);
      return;
    }
    setSelectedOutingPosterRandom(prev => {
      const nextPoster = getWeightedOutingPoster(outingPosterConfig, prev?.filename || null);
      return nextPoster || null;
    });
  }, [selectedPublicDate, outingDays, outingPosterConfig, publicDateEntryNonce]);
  if (loading && viewMode !== 'public') return React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-50 text-slate-400"
  }, React.createElement(Icon, {
    name: "loader-2",
    className: "animate-spin mr-2"
  }), " \u8F09\u5165\u4E2D...");
  const activeEditingEvent = editingEvent && stats.events[editingEvent.key] ? stats.events[editingEvent.key] : editingEvent;
  if (viewMode === 'public') {
    const selectedDayItems = (calendarOccupancy[selectedPublicDate] || []).filter(item => checkEventMatchesFilters(item.evt.key)).map((item, index) => {
      const cfg = eventConfigs[item.evt.key] || {};
      const status = getEventStatus(item.evt.count, cfg.capacity, cfg, item.evt.date, globalRules);
      return {
        ...item,
        sortIndex: index,
        sortIsFull: !!status.isFull
      };
    }).sort((a, b) => {
      if (a.sortIsFull !== b.sortIsFull) return a.sortIsFull ? 1 : -1;
      return a.sortIndex - b.sortIndex;
    });
    const selectedOuting = outingDays[selectedPublicDate];
    const isSelectedOutingDay = !!selectedOuting?.enabled;
    const selectedOutingPoster = isSelectedOutingDay ? selectedOuting?.posterFilename ? {
      filename: selectedOuting.posterFilename,
      label: '指定場刊'
    } : selectedOutingPosterRandom : null;
    const todayDateKey = getLocalDateStr();
    const currentMonthStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
    const nextPublicMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    const publicRangeLabel = `${currentDate.getFullYear()}年${currentDate.getMonth() + 1}月 - ${nextPublicMonth.getFullYear()}年${nextPublicMonth.getMonth() + 1}月`;
    const anchorMonthIndex = currentDate.getFullYear() * 12 + currentDate.getMonth();
    const publicVisibleMonthBadges = Array.from(publicRollingCalendarDays.reduce((map, dayInfo) => {
      if (!dayInfo || map.has(dayInfo.monthKey)) return map;
      const monthIndex = dayInfo.year * 12 + dayInfo.month;
      const relation = monthIndex < anchorMonthIndex ? '前月' : monthIndex === anchorMonthIndex ? '當月' : monthIndex === anchorMonthIndex + 1 ? '下月' : '補齊';
      map.set(dayInfo.monthKey, {
        key: dayInfo.monthKey,
        relation,
        label: `${dayInfo.year}年${dayInfo.month + 1}月`
      });
      return map;
    }, new Map()).values());
    const publicMonthTonePalette = [{
      bg: '#f1f5f9',
      text: '#475569'
    }, {
      bg: '#dbeafe',
      text: '#1d4ed8'
    }, {
      bg: '#fef3c7',
      text: '#b45309'
    }, {
      bg: '#dcfce7',
      text: '#047857'
    }, {
      bg: '#f3e8ff',
      text: '#7e22ce'
    }, {
      bg: '#ffe4e6',
      text: '#be123c'
    }];
    const publicMonthToneMap = publicVisibleMonthBadges.reduce((map, badge) => {
      const monthNumber = parseInt(String(badge.key || '').split('-')[1], 10);
      const paletteIndex = Number.isFinite(monthNumber) ? (monthNumber - 1) % publicMonthTonePalette.length : 0;
      map[badge.key] = publicMonthTonePalette[paletteIndex];
      return map;
    }, {});
    const appliedTheme = normalizePublicTheme(publicTheme);
    const appliedSideDecor = normalizePublicSideDecor(publicSideDecor);
    const selectedPublicDaySheetContent = companyRestDates.includes(selectedPublicDate) ? React.createElement("div", {
      className: "rounded-3xl border border-red-100 bg-red-50 p-6 text-center"
    }, React.createElement("div", {
      className: "text-3xl mb-2"
    }, "\uD83D\uDE34"), React.createElement("div", {
      className: "font-bold text-red-400"
    }, "\u672C\u65E5\u5168\u516C\u53F8\u516C\u4F11"), React.createElement("div", {
      className: "text-sm text-red-300 mt-1"
    }, "\u6211\u5011\u4F11\u606F\u5145\u96FB\u4E2D\uFF0C\u8ACB\u6539\u671F\u518D\u4F86\u5594\uFF01")) : isSelectedOutingDay ? React.createElement("div", {
      className: "rounded-3xl border border-amber-200 bg-amber-50 p-6 text-center"
    }, selectedOutingPoster?.filename && React.createElement("img", {
      src: selectedOutingPoster.filename,
      alt: "outing-poster",
      className: "max-h-40 mx-auto mb-4 rounded-2xl border border-amber-200 bg-transparent object-contain"
    }), React.createElement("div", {
      className: "text-3xl mb-2"
    }, "\uD83D\uDCF7"), React.createElement("div", {
      className: "font-bold text-amber-700"
    }, "\u51FA\u5916\u53D6\u6750\u4E2D"), React.createElement("div", {
      className: "text-sm text-amber-500 mt-1"
    }, "\u4ECA\u65E5\u66AB\u505C\u524D\u53F0\u6D3B\u52D5\u5C55\u793A\u3002")) : selectedDayItems.length > 0 ? selectedDayItems.map(item => {
      const e = item.evt;
      const cfg = eventConfigs[e.key] || {};
      const status = getEventStatus(e.count, cfg.capacity, cfg, e.date, globalRules);
      const displayName = toSafeDisplayText(cfg.displayName, toSafeDisplayText(e.eventName, '未命名活動'));
      const tags = cfg.tags || {};
      const safeTags = [tags.levels, tags.types, tags.locations].map(tag => toSafeDisplayText(tag, '').trim()).filter(Boolean);
      const isPrivateGroupEvent = !!cfg.isPrivateGroupEvent || safeTags.includes('包團') || displayName.includes('包團') || e.eventName === '包團';
      const privateGroupLabel = toSafeDisplayText(cfg.privateGroupLabel, '此為包團活動') || '此為包團活動';
      const itemType = item.type;
      const itemLabel = toSafeDisplayText(item.label, '');
      const statusBadgeClass = status.isFull ? "bg-slate-600 text-white" : `${status.colorObj?.bg || 'bg-blue-50'} ${status.colorObj?.text || 'text-blue-600'}`;
      return React.createElement("div", {
        key: `mobile_sheet_${itemType}_${e.key}`,
        className: "rounded-2xl border border-slate-100 bg-slate-50 p-4 shadow-sm"
      }, React.createElement("div", {
        className: "flex items-start justify-between gap-3"
      }, React.createElement("div", {
        className: "min-w-0"
      }, itemType === 'prep' && React.createElement("span", {
        className: "mb-1 inline-block rounded bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700"
      }, "\u26A0\uFE0F \u524D\u7F6E\u6E96\u5099"), itemType === 'cont' && itemLabel && React.createElement("span", {
        className: "mb-1 inline-block rounded bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600"
      }, itemLabel.split(':')[0]), React.createElement("div", {
        className: "text-base font-black text-slate-800 leading-snug"
      }, displayName)), React.createElement("span", {
        className: `shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold ${isPrivateGroupEvent ? 'bg-amber-50 text-amber-700 border border-amber-200' : statusBadgeClass}`
      }, isPrivateGroupEvent ? privateGroupLabel : toSafeDisplayText(status.label, '報名中'))), safeTags.length > 0 && React.createElement("div", {
        className: "mt-3 flex flex-wrap gap-1.5"
      }, safeTags.map(tag => React.createElement("span", {
        key: `${e.key}_${tag}`,
        className: "rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500 border border-slate-200"
      }, tag))), React.createElement("div", {
        className: "mt-3 space-y-1.5 text-sm text-slate-600"
      }, React.createElement("div", {
        className: "flex items-center gap-2"
      }, React.createElement(Icon, {
        name: "user",
        size: 15,
        className: "text-slate-400"
      }), "\u8B1B\u5E2B\uFF1A", toSafeDisplayText(e.instructor, '未定')), toSafeDisplayText(cfg.time, '') && React.createElement("div", {
        className: "flex items-center gap-2"
      }, React.createElement(Icon, {
        name: "clock",
        size: 15,
        className: "text-slate-400"
      }), "\u6642\u9593\uFF1A", toSafeDisplayText(cfg.time, ''))), cfg.link && React.createElement("button", {
        disabled: status.isFull,
        onClick: evt => {
          evt.stopPropagation();
          if (!status.isFull) window.open(cfg.link, '_blank');
        },
        className: `mt-4 w-full rounded-xl px-4 py-3 text-sm font-black shadow-sm transition-all ${status.isFull ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-blue-600 text-white active:scale-[0.98]'}`
      }, status.isEnded ? '活動已結束' : status.isFull ? '名額已滿' : '前往報名'));
    }) : React.createElement("div", {
      className: "rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center"
    }, React.createElement("div", {
      className: "text-3xl mb-2"
    }, "\uD83D\uDCC5"), React.createElement("div", {
      className: "font-bold text-slate-400"
    }, hasActiveFilters ? '此篩選條件下無活動' : '本日無活動'), React.createElement("div", {
      className: "text-sm text-slate-300 mt-1"
    }, "\u8ACB\u9EDE\u9078\u5176\u4ED6\u6709\u85CD\u9EDE\u7684\u65E5\u671F"));
    return React.createElement("div", {
      className: "min-h-screen pb-20 relative",
      style: {
        background: `linear-gradient(180deg, ${appliedTheme.pageBg} 0%, ${appliedTheme.pageBgAlt} 100%)`,
        color: appliedTheme.textColor
      }
    }, React.createElement("nav", {
      className: "glass-nav sticky top-0 z-50 px-6 py-4 flex justify-between items-center relative",
      style: {
        backgroundColor: `${appliedTheme.surfaceBg}f2`,
        borderBottomColor: appliedTheme.surfaceBorder
      }
    }, React.createElement(Logo, {
      className: "h-8 w-auto"
    }), React.createElement("button", {
      onClick: () => setShowLoginModal(true),
      className: "text-sm flex items-center gap-1 px-3 py-1.5 rounded-lg transition-colors",
      style: {
        color: appliedTheme.textColor,
        backgroundColor: 'transparent'
      },
      onMouseEnter: e => e.currentTarget.style.color = appliedTheme.accentColor,
      onMouseLeave: e => e.currentTarget.style.color = appliedTheme.textColor
    }, React.createElement(Icon, {
      name: "lock",
      size: 14
    }), " \u7BA1\u7406\u54E1\u767B\u5165")), latestNews && React.createElement("div", {
      className: "overflow-hidden py-2 relative z-40 marquee-container border-b border-slate-700 shadow-sm",
      style: {
        backgroundColor: marqueeBgColor,
        color: marqueeTextColor
      }
    }, React.createElement("div", {
      className: "animate-marquee font-bold text-sm tracking-wide flex items-center",
      style: {
        animationDuration: `${marqueeSpeed}s`
      }
    }, marqueeIcon && React.createElement("img", {
      src: marqueeIcon,
      className: "w-auto mr-3 -mt-1 pixel-art inline-block",
      style: {
        height: `${marqueeIconSize}px`
      },
      alt: "icon"
    }), React.createElement("span", {
      className: "text-yellow-400 mr-2"
    }, " \u6700\u65B0\u6D88\u606F\uFF1A"), toSafeDisplayText(latestNews, ''))), React.createElement("div", {
      className: "bg-amber-50 text-amber-800 text-xs py-2 px-4 text-center font-bold border-b border-amber-100 flex items-center justify-center gap-2 relative z-10"
    }, React.createElement(Icon, {
      name: "alert-circle",
      size: 14
    }), " \u7CFB\u7D71\u4EBA\u6578\u66F4\u65B0\u53EF\u80FD\u6709\u5EF6\u9072\uFF0C\u6E96\u78BA\u540D\u984D\u8ACB\u4EE5\u9EDE\u64CA\u300C\u524D\u5F80\u5831\u540D\u300D\u5F8C\u7684\u8868\u55AE\u70BA\u4E3B"), React.createElement("main", {
      className: "max-w-6xl mx-auto p-6 relative z-10"
    }, React.createElement("div", {
      className: "max-w-2xl mx-auto relative z-10"
    }, React.createElement("div", {
      className: "mb-6 text-center relative schedule-title-wrap"
    }, appliedSideDecor.leftImage && React.createElement("img", {
      src: appliedSideDecor.leftImage,
      alt: "left decor",
      className: "absolute schedule-side-decor schedule-side-decor-left",
      style: {
        left: `calc(-${Number(appliedSideDecor.width || 180)}px - ${Number(appliedSideDecor.offsetX || 24)}px)`,
        bottom: `${-Number(appliedSideDecor.offsetY || 0)}px`,
        width: `${appliedSideDecor.width}px`,
        '--decor-mobile-width': `${Number(appliedSideDecor.mobileWidth || appliedSideDecor.width || 180)}px`,
        opacity: Number(appliedSideDecor.opacity) || 1
      }
    }), appliedSideDecor.rightImage && React.createElement("img", {
      src: appliedSideDecor.rightImage,
      alt: "right decor",
      className: "absolute schedule-side-decor schedule-side-decor-right",
      style: {
        right: `calc(-${Number(appliedSideDecor.width || 180)}px - ${Number(appliedSideDecor.offsetX || 24)}px)`,
        bottom: `${-Number(appliedSideDecor.offsetY || 0)}px`,
        width: `${appliedSideDecor.width}px`,
        '--decor-mobile-width': `${Number(appliedSideDecor.mobileWidth || appliedSideDecor.width || 180)}px`,
        opacity: Number(appliedSideDecor.opacity) || 1
      }
    }), React.createElement("h1", {
      className: "text-2xl font-bold mb-2",
      style: {
        color: appliedTheme.titleColor
      }
    }, "\u6D3B\u52D5\u5834\u6B21\u8868"), React.createElement("p", {
      className: "text-sm",
      style: {
        color: appliedTheme.textColor
      }
    }, "\u6B61\u8FCE\u67E5\u770B\u6700\u65B0\u7684\u6D3B\u52D5\u8CC7\u8A0A")), React.createElement("div", {
      className: "relative mb-2"
    }, React.createElement(Icon, {
      name: "search",
      className: "absolute left-4 top-3 text-slate-400",
      size: 20
    }), React.createElement("input", {
      type: "text",
      placeholder: "\u641C\u5C0B\u6D3B\u52D5\u95DC\u9375\u5B57...",
      className: "w-full pl-12 pr-4 py-3 border-none rounded-2xl outline-none focus:ring-2 transition-all",
      style: {
        backgroundColor: `${appliedTheme.surfaceBg}`,
        color: appliedTheme.textColor,
        boxShadow: `0 0 0 1px ${appliedTheme.surfaceBorder} inset`,
        '--tw-ring-color': appliedTheme.accentColor
      },
      value: publicSearchTerm,
      onChange: e => setPublicSearchTerm(e.target.value)
    })), React.createElement("div", {
      className: "mb-6 p-5 rounded-2xl border shadow-sm",
      style: {
        backgroundColor: appliedTheme.surfaceBg,
        borderColor: appliedTheme.surfaceBorder
      }
    }, React.createElement("div", {
      className: "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    }, React.createElement("div", null, React.createElement("div", {
      className: "flex flex-wrap items-center gap-2"
    }, React.createElement("h3", {
      className: "text-sm font-bold flex items-center gap-2",
      style: {
        color: appliedTheme.titleColor
      }
    }, React.createElement(Icon, {
      name: "filter",
      size: 18,
      className: "text-blue-500"
    }), " \u6D3B\u52D5\u7BE9\u9078"), hasActiveFilters && React.createElement("span", {
      className: "text-[11px] font-bold px-2 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-100"
    }, "\u5DF2\u5957\u7528 ", activeFilterCount, " \u500B\u689D\u4EF6")), !publicFiltersExpanded && React.createElement("p", {
      className: "text-xs text-slate-400 mt-2"
    }, "\u53EF\u5C55\u958B\u7BE9\u9078\uFF0C\u66F4\u5FEB\u641C\u5C0B\u5230\u4F60\u60F3\u627E\u7684\u6D3B\u52D5\u3002")), React.createElement("div", {
      className: "flex items-center gap-2"
    }, hasActiveFilters && React.createElement("button", {
      onClick: clearFilters,
      className: "text-xs text-red-500 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "x",
      size: 14
    }), " \u91CD\u7F6E\u689D\u4EF6"), React.createElement("button", {
      type: "button",
      onClick: () => setPublicFiltersExpanded(prev => !prev),
      className: "text-xs font-bold text-slate-600 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 border border-slate-200"
    }, React.createElement(Icon, {
      name: publicFiltersExpanded ? "chevron-up" : "chevron-down",
      size: 14
    }), publicFiltersExpanded ? '收起篩選' : '展開篩選'))), publicFiltersExpanded && React.createElement("div", {
      className: "space-y-4 mt-4 animate-in fade-in slide-in-from-top-2"
    }, React.createElement("div", {
      className: "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
    }, React.createElement("span", {
      className: "text-xs font-bold text-slate-400 w-12 shrink-0 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "bar-chart-2",
      size: 12
    }), " \u7B49\u7D1A"), React.createElement("div", {
      className: "flex flex-wrap gap-2"
    }, (tagDefinitions.levels || []).map(t => {
      const safeTag = toSafeDisplayText(t, '');
      if (!safeTag) return null;
      const isActive = publicFilters.level.includes(safeTag);
      const isAvailable = availableOptions.levels.has(safeTag);
      return React.createElement("button", {
        key: safeTag,
        onClick: () => toggleFilter('level', safeTag),
        disabled: !isAvailable && !isActive,
        className: `px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${isActive ? 'bg-blue-600 text-white border-blue-600 shadow-md ring-2 ring-blue-100' : !isAvailable ? 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-white hover:border-blue-300'}`
      }, safeTag);
    }))), React.createElement("div", {
      className: "border-t border-slate-50 my-2"
    }), React.createElement("div", {
      className: "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
    }, React.createElement("span", {
      className: "text-xs font-bold text-slate-400 w-12 shrink-0 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "tag",
      size: 12
    }), " \u7A2E\u985E"), React.createElement("div", {
      className: "flex flex-wrap gap-2"
    }, (tagDefinitions.types || []).map(t => {
      const safeTag = toSafeDisplayText(t, '');
      if (!safeTag) return null;
      const isActive = publicFilters.type.includes(safeTag);
      const isAvailable = availableOptions.types.has(safeTag);
      return React.createElement("button", {
        key: safeTag,
        onClick: () => toggleFilter('type', safeTag),
        disabled: !isAvailable && !isActive,
        className: `px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${isActive ? 'bg-emerald-600 text-white border-emerald-600 shadow-md ring-2 ring-emerald-100' : !isAvailable ? 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-white hover:border-emerald-300'}`
      }, safeTag);
    }))), React.createElement("div", {
      className: "border-t border-slate-50 my-2"
    }), React.createElement("div", {
      className: "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
    }, React.createElement("span", {
      className: "text-xs font-bold text-slate-400 w-12 shrink-0 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "map-pin",
      size: 12
    }), " \u5730\u9EDE"), React.createElement("div", {
      className: "flex flex-wrap gap-2"
    }, (tagDefinitions.locations || []).map(t => {
      const safeTag = toSafeDisplayText(t, '');
      if (!safeTag) return null;
      const isActive = publicFilters.location.includes(safeTag);
      const isAvailable = availableOptions.locations.has(safeTag);
      return React.createElement("button", {
        key: safeTag,
        onClick: () => toggleFilter('location', safeTag),
        disabled: !isAvailable && !isActive,
        className: `px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${isActive ? 'bg-purple-600 text-white border-purple-600 shadow-md ring-2 ring-purple-100' : !isAvailable ? 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-white hover:border-purple-300'}`
      }, safeTag);
    }))))), (publicSearchTerm || hasActiveFilters) && matchingMonths.length > 0 && React.createElement("div", {
      className: "mb-6 flex flex-wrap gap-2 animate-in fade-in slide-in-from-top-2"
    }, React.createElement("span", {
      className: "text-xs text-slate-400 py-1.5 flex items-center"
    }, React.createElement(Icon, {
      name: "search",
      size: 12,
      className: "mr-1"
    }), " \u7B26\u5408\u689D\u4EF6\u7684\u6708\u4EFD\uFF1A"), matchingMonths.sort().map(m => {
      const isCurrentView = m === currentMonthStr;
      return React.createElement("button", {
        key: m,
        onClick: () => {
          const [y, mon] = m.split('-');
          setCurrentDate(new Date(parseInt(y), parseInt(mon) - 1, 1));
        },
        className: `text-xs px-3 py-1.5 rounded-full font-bold transition-all flex items-center gap-1 ${isCurrentView ? 'bg-slate-800 text-white shadow-md ring-2 ring-slate-200' : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'}`
      }, m, " ", !isCurrentView && React.createElement(Icon, {
        name: "arrow-right",
        size: 12
      }));
    })), !publicSearchTerm && !hasActiveFilters && React.createElement("div", {
      className: "flex justify-center gap-4 mb-4 text-xs text-slate-400"
    }, React.createElement("div", {
      className: "flex items-center gap-1"
    }, React.createElement("span", {
      className: "w-2 h-2 rounded-full bg-blue-500"
    }), " \u6709\u6D3B\u52D5"), React.createElement("div", {
      className: "flex items-center gap-1"
    }, React.createElement("span", {
      className: "text-red-500 font-bold text-[10px]"
    }, "\u984D\u6EFF"), " \u5DF2\u984D\u6EFF"), React.createElement("div", {
      className: "flex items-center gap-1"
    }, React.createElement("span", {
      className: "text-amber-500 font-bold text-[10px]"
    }, "\u5916\u51FA"), " \u53D6\u6750\u4E2D"), React.createElement("div", {
      className: "flex items-center gap-1"
    }, React.createElement("span", {
      className: "text-slate-300 font-bold"
    }, "\u2715"), " \u516C\u4F11")), React.createElement("div", {
      className: "rounded-3xl shadow-lg border overflow-hidden mb-8",
      style: {
        backgroundColor: appliedTheme.surfaceBg,
        borderColor: appliedTheme.surfaceBorder
      }
    }, React.createElement("div", {
      className: "p-4 border-b flex justify-between items-center",
      style: {
        borderColor: appliedTheme.surfaceBorder,
        backgroundColor: `${appliedTheme.surfaceBg}cc`
      }
    }, React.createElement("div", {
      className: "flex items-center gap-2 sm:gap-4 w-full justify-between px-2"
    }, React.createElement("div", {
      className: "flex items-center gap-1 sm:gap-2"
    }, React.createElement("button", {
      onClick: prevPublicMonthWindow,
      className: "px-2 sm:px-3 py-1.5 rounded-full text-[11px] sm:text-xs font-bold border border-slate-200 text-slate-500 hover:bg-white hover:shadow-sm transition-all whitespace-nowrap"
    }, "\u4E0A\u6708")), React.createElement("div", {
      className: "text-center min-w-0"
    }, React.createElement("h2", {
      className: "text-base sm:text-lg font-bold text-slate-800"
    }, publicRangeLabel), React.createElement("div", {
      className: "mt-1 flex flex-wrap justify-center gap-1"
    }, publicVisibleMonthBadges.map(badge => React.createElement("span", {
      key: badge.key,
      className: `text-[10px] px-2 py-0.5 rounded-full font-bold ${badge.relation === '當月' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`
    }, badge.relation, " \u00B7 ", badge.label)))), React.createElement("div", {
      className: "flex items-center gap-1 sm:gap-2"
    }, React.createElement("button", {
      onClick: nextPublicMonthWindow,
      className: "px-2 sm:px-3 py-1.5 rounded-full text-[11px] sm:text-xs font-bold border border-slate-200 text-slate-500 hover:bg-white hover:shadow-sm transition-all whitespace-nowrap"
    }, "\u4E0B\u6708")))), React.createElement("div", {
      className: "grid grid-cols-7 text-center py-3 text-xs font-bold text-slate-400 bg-white border-b border-slate-100"
    }, ['日', '一', '二', '三', '四', '五', '六'].map(d => React.createElement("div", {
      key: d
    }, d))), React.createElement("div", {
      className: "grid grid-cols-7 bg-white pb-6",
      style: {
        gridAutoRows: '76px'
      }
    }, publicRollingCalendarDays.map((dayInfo, i) => {
      const day = dayInfo.day;
      const dateStr = dayInfo.dateStr;
      const dayItems = (calendarOccupancy[dateStr] || []).filter(item => checkEventMatchesFilters(item.evt.key));
      const hasEvents = dayItems.length > 0;
      const areAllFull = hasEvents && dayItems.every(item => {
        const cfg = eventConfigs[item.evt.key] || {};
        const cap = cfg.capacity || 12;
        return item.evt.count >= cap;
      });
      const hasPrep = hasEvents && dayItems.some(item => item.type === 'prep');
      const isSelected = dateStr === selectedPublicDate;
      const isRestDay = companyRestDates.includes(dateStr);
      const isOutingDay = !!(outingDays[dateStr] && outingDays[dateStr].enabled);
      const isSearchMatch = publicSearchTerm && matchingDates.includes(dateStr);
      const isFilterMatch = hasActiveFilters && hasEvents;
      const shouldHighlight = isSearchMatch || isFilterMatch;
      const isPastDay = dateStr < todayDateKey;
      const monthTone = publicMonthToneMap[dayInfo.monthKey] || publicMonthTonePalette[0];
      const isMonthLabelCell = i === 0 || publicRollingCalendarDays[i - 1]?.monthKey !== dayInfo.monthKey || day === 1;
      const cellStyle = {
        backgroundColor: isSelected ? '#1e293b' : isRestDay || isPastDay ? '#f8fafc' : shouldHighlight ? '#fef9c3' : monthTone.bg
      };
      let cellClass = "cursor-pointer relative transition-all border-b border-r border-slate-50";
      const dateNumberBaseClass = "text-sm sm:text-lg font-bold leading-none z-10 relative";
      let numClass = `${dateNumberBaseClass} text-slate-700`;
      if (isRestDay || isPastDay) {
        cellClass += isRestDay ? " bg-slate-50 cursor-not-allowed" : " bg-slate-50/70 hover:bg-slate-100/80";
        numClass = `${dateNumberBaseClass} text-slate-300`;
      } else if (isSelected) {
        cellClass += " bg-slate-800 text-white hover:bg-slate-900 shadow-md z-20";
        numClass = `${dateNumberBaseClass} text-white`;
      } else if (shouldHighlight) {
        cellClass += " bg-yellow-100 text-yellow-800 z-10";
      } else {
        cellClass += " hover:bg-slate-50";
      }
      return React.createElement("div", {
        key: dateStr,
        onClick: () => {
          if (!isRestDay) {
            setSelectedPublicDate(dateStr);
            setPublicDateEntryNonce(n => n + 1);
            setPublicDaySheetOpen(true);
          }
        },
        className: cellClass,
        style: cellStyle
      }, React.createElement("div", {
        className: `h-full w-full flex flex-col items-center ${isSelected ? 'justify-center' : 'justify-start pt-4'}`
      }, React.createElement("div", {
        className: "flex h-6 items-center justify-center gap-1 relative z-10"
      }, React.createElement("span", {
        className: `text-[10px] font-bold leading-none ${isMonthLabelCell ? '' : 'hidden'} ${isSelected ? 'text-white/70' : isPastDay || isRestDay ? 'text-slate-300' : ''}`,
        style: !isSelected && !isPastDay && !isRestDay ? {
          color: monthTone.text
        } : undefined
      }, dayInfo.monthLabel), React.createElement("span", {
        className: numClass
      }, day)), isRestDay ? React.createElement("div", {
        className: "text-slate-300 font-bold text-lg select-none mt-1"
      }, "\u2715") : isOutingDay && !isSelected ? React.createElement("div", {
        className: "text-[9px] font-bold text-amber-500 mt-1 scale-90 relative z-10"
      }, "\u5916\u51FA") : hasEvents && !isSelected && (areAllFull ? React.createElement("div", {
        className: "text-[9px] font-bold text-red-500 mt-1 scale-90 relative z-10"
      }, "\u984D\u6EFF") : (() => {
        const dObj = new Date(dayInfo.dateObj);
        dObj.setDate(dObj.getDate() + 1);
        const nextDateStr = `${dObj.getFullYear()}-${String(dObj.getMonth() + 1).padStart(2, '0')}-${String(dObj.getDate()).padStart(2, '0')}`;
        const nextDayItems = calendarOccupancy[nextDateStr] || [];
        const isBlueCont = dayItems.some(i => i.type === 'cont');
        const willBlueCont = nextDayItems.some(i => i.type === 'cont');
        const isPrep = dayItems.some(i => i.type === 'prep');
        const willPrepConnect = isPrep && nextDayItems.some(i => i.type === 'prep' || i.type === 'main');
        let dotClass = "h-1.5 mt-1 transition-all relative z-0 ";
        let colorClass = "bg-blue-500";
        if (isPrep) {
          colorClass = "bg-orange-400";
          if (willPrepConnect) {
            dotClass += "w-full mr-[-50%] rounded-l-full rounded-r-none ml-auto";
            dotClass = "h-1.5 mt-1 bg-orange-400 w-[60%] ml-[40%] rounded-l-full rounded-r-none";
            if (dayItems.length > 1 && dayItems[0].label?.includes('前置')) {
              dotClass = "h-1.5 mt-1 bg-orange-400 w-full rounded-none";
            }
          } else {
            dotClass += "w-1.5 rounded-full mx-auto";
          }
        } else {
          if (isBlueCont && willBlueCont) {
            dotClass += "w-full rounded-none mx-0";
          } else if (willBlueCont) {
            dotClass += "w-[60%] ml-[40%] rounded-l-full rounded-r-none";
          } else if (isBlueCont) {
            dotClass += "w-[60%] mr-[40%] rounded-r-full rounded-l-none";
          } else {
            dotClass += "w-1.5 rounded-full mx-auto";
          }
        }
        if (shouldHighlight) colorClass = "bg-blue-600 ring-1 ring-white";
        return React.createElement("div", {
          className: `${dotClass} ${colorClass}`
        });
      })())));
    }))), React.createElement("div", {
      className: "space-y-4 fade-in"
    }, React.createElement("h3", {
      className: "font-bold text-slate-800 text-lg flex items-center gap-2 border-l-4 border-blue-500 pl-3"
    }, selectedPublicDate, " \u6D3B\u52D5\u5217\u8868"), companyRestDates.includes(selectedPublicDate) ? React.createElement("div", {
      className: "text-center py-12 bg-red-50 rounded-3xl border border-red-100"
    }, React.createElement("div", {
      className: "text-4xl mb-2"
    }, "\uD83D\uDE34"), React.createElement("div", {
      className: "text-red-400 font-bold"
    }, "\u672C\u65E5\u5168\u516C\u53F8\u516C\u4F11"), React.createElement("div", {
      className: "text-red-300 text-sm mt-1"
    }, "\u6211\u5011\u4F11\u606F\u5145\u96FB\u4E2D\uFF0C\u8ACB\u6539\u671F\u518D\u4F86\u5594\uFF01")) : isSelectedOutingDay ? React.createElement("div", {
      className: "bg-amber-50 border border-amber-200 rounded-3xl p-6 text-center"
    }, selectedOutingPoster?.filename && React.createElement("img", {
      src: selectedOutingPoster.filename,
      alt: "outing-poster",
      className: "max-h-56 mx-auto mb-4 rounded-2xl border border-amber-200 bg-transparent object-contain"
    }), React.createElement("div", {
      className: "text-2xl mb-2"
    }, "\uD83D\uDCF7"), React.createElement("div", {
      className: "text-amber-700 font-bold text-xl"
    }, "\u51FA\u5916\u53D6\u6750\u4E2D"), React.createElement("div", {
      className: "text-amber-500 text-sm mt-1"
    }, "\u4ECA\u65E5\u66AB\u505C\u524D\u53F0\u6D3B\u52D5\u5C55\u793A\uFF0C\u611F\u8B1D\u7B49\u5F85\uFF01")) : selectedDayItems.length > 0 ? selectedDayItems.map(item => {
      const e = item.evt;
      const itemType = item.type;
      const itemLabel = item.label;
      const cfg = eventConfigs[e.key] || {};
      const status = getEventStatus(e.count, cfg.capacity, cfg, e.date, globalRules);
      const displayName = toSafeDisplayText(cfg.displayName, toSafeDisplayText(e.eventName, '未命名活動'));
      let cardClass = 'bg-white border-slate-100 shadow-sm hover:shadow-md border-l-4';
      const borderColor = status.colorObj && status.colorObj.border ? status.colorObj.border.replace('border-', 'border-l-') : 'border-l-blue-500';
      if (status.isFull) cardClass = 'bg-slate-50 border-slate-200 border-l-slate-400';else cardClass = `bg-white border-slate-100 shadow-sm hover:shadow-md border-l-4 ${borderColor.replace('border-l-100', 'border-l-500')}`;
      const statusBadgeClass = status.isFull ? "bg-slate-600 text-white" : `${status.colorObj?.bg || 'bg-blue-50'} ${status.colorObj?.text || 'text-blue-600'}`;
      const rawTags = cfg.tags || {};
      const tags = {
        levels: toSafeDisplayText(rawTags.levels, ''),
        types: toSafeDisplayText(rawTags.types, ''),
        locations: toSafeDisplayText(rawTags.locations, '')
      };
      const isPrivateGroupEvent = !!cfg.isPrivateGroupEvent || tags.levels === '包團' || displayName.includes('包團') || e.eventName === '包團';
      const privateGroupLabel = toSafeDisplayText(cfg.privateGroupLabel, '此為包團活動') || '此為包團活動';
      const carpoolDisplayMode = resolveCarpoolDisplayMode(cfg.carpoolDisplayMode, e.eventName);
      const carpoolCount = Array.isArray(e.customers) ? e.customers.filter(customer => customer && customer.transport === '共乘').length : 0;
      const remainingCarpoolSeats = Math.max(DEFAULT_CARPOOL_CAPACITY - carpoolCount, 0);
      const carpoolHint = carpoolDisplayMode === 'none' ? '本活動無共乘' : remainingCarpoolSeats > 0 ? `付費共乘剩餘 ${remainingCarpoolSeats} 位` : '付費共乘基本已滿，可洽詢粉專客服';
	      return (React.createElement("div", {
	          key: e.key,
	          className: `p-5 rounded-2xl border transition-all group relative ${cardClass}`
	        }, React.createElement("div", {
          className: "flex justify-between items-start mb-3"
        }, React.createElement("div", {
          className: "font-bold text-lg text-slate-800"
        }, itemType === 'prep' && React.createElement("span", {
          className: "inline-block bg-orange-100 text-orange-700 text-xs px-2 py-0.5 rounded mr-2 align-middle"
        }, "\u26A0\uFE0F \u524D\u7F6E\u6E96\u5099"), itemType === 'cont' && React.createElement("span", {
          className: "inline-block bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded mr-2 align-middle"
        }, itemLabel?.split(':')[0]), React.createElement("span", {
          className: "align-middle"
        }, displayName)), React.createElement("div", {
          className: "flex flex-col items-end gap-1"
        }, React.createElement("span", {
          className: `text-xs px-2 py-1 rounded-lg font-bold ${isPrivateGroupEvent ? 'bg-amber-50 text-amber-700 border border-amber-200' : statusBadgeClass}`
        }, isPrivateGroupEvent ? privateGroupLabel : toSafeDisplayText(status.label, '報名中')), !status.isEnded && React.createElement("div", {
          className: "flex flex-col items-end gap-1"
        }, React.createElement("span", {
          className: `whitespace-nowrap text-right text-[10px] font-bold leading-4 ${carpoolDisplayMode === 'none' ? 'text-slate-400' : remainingCarpoolSeats > 0 ? 'text-orange-500' : 'text-rose-500'}`
        }, carpoolHint)))), (tags.levels || tags.types || tags.locations) && React.createElement("div", {
          className: "flex gap-2 mb-3"
        }, tags.levels && React.createElement("span", {
          className: "text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-100"
        }, tags.levels), tags.types && React.createElement("span", {
          className: "text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded border border-emerald-100"
        }, tags.types), tags.locations && React.createElement("span", {
          className: "text-[10px] bg-purple-50 text-purple-700 px-2 py-0.5 rounded border border-purple-100"
        }, tags.locations)), React.createElement("div", {
          className: "space-y-2 text-sm text-slate-600"
        }, React.createElement("div", {
          className: "flex items-center gap-2"
        }, React.createElement(Icon, {
          name: "user",
          size: 16,
          className: "text-slate-400"
        }), " ", React.createElement("span", null, "\u8B1B\u5E2B\uFF1A", toSafeDisplayText(e.instructor, '未定'))), toSafeDisplayText(cfg.time, '') && React.createElement("div", {
          className: "flex items-center gap-2"
        }, React.createElement(Icon, {
          name: "clock",
          size: 16,
          className: "text-slate-400"
        }), " ", React.createElement("span", null, "\u6642\u9593\uFF1A", toSafeDisplayText(cfg.time, '')))), React.createElement("div", {
          className: "mt-4 pt-4 border-t border-slate-200/50 flex items-center min-h-[40px]"
        }, cfg.link && React.createElement("button", {
          disabled: status.isFull,
          onClick: evt => {
            evt.stopPropagation();
            if (!status.isFull) window.open(cfg.link, '_blank');
          },
          className: `text-sm font-bold px-4 py-2 rounded-lg shadow-md flex items-center gap-2 z-20 relative transition-all ${status.isFull ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200' : 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-lg hover:scale-105 cursor-pointer'}`
        }, status.isEnded ? '活動已結束' : status.isFull ? '名額已滿' : '前往報名', !status.isFull && React.createElement(Icon, {
          name: "arrow-right",
          size: 16
	        })), React.createElement(EventMascot, {
	          eventName: displayName,
	          db: db,
	          dbSource: dbSource,
	          config: mascotConfig
	        })))
      );
    }) : React.createElement("div", {
      className: "text-center py-12 bg-slate-50 rounded-3xl border border-dashed border-slate-200"
    }, React.createElement("div", {
      className: "text-4xl mb-2"
    }, "\uD83D\uDCC5"), React.createElement("div", {
      className: "text-slate-400 font-medium"
    }, hasActiveFilters ? '此篩選條件下無活動' : '本日無活動'), React.createElement("div", {
      className: "text-slate-300 text-sm mt-1"
    }, "\u8ACB\u9EDE\u9078\u5176\u4ED6\u6709\u85CD\u9EDE\u7684\u65E5\u671F"))))), publicDaySheetOpen && React.createElement("div", {
      className: "fixed inset-0 z-[90] sm:hidden",
      role: "dialog",
      "aria-modal": "true",
      onClick: () => setPublicDaySheetOpen(false)
    }, React.createElement("div", {
      className: "absolute inset-0 bg-slate-900/35 backdrop-blur-[1px]"
    }), React.createElement("div", {
      className: "absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto rounded-t-[2rem] border border-slate-100 bg-white p-4 shadow-[0_-18px_45px_rgba(15,23,42,0.18)]",
      onClick: e => e.stopPropagation()
    }, React.createElement("button", {
      type: "button",
      onClick: () => setPublicDaySheetOpen(false),
      className: "mx-auto mb-3 block h-1.5 w-12 rounded-full bg-slate-300",
      "aria-label": "\u6536\u8D77\u6D3B\u52D5\u5217\u8868"
    }), React.createElement("div", {
      className: "mb-4 flex items-start justify-between gap-3"
    }, React.createElement("div", null, React.createElement("div", {
      className: "text-xs font-bold text-slate-400"
    }, "\u5DF2\u9078\u65E5\u671F"), React.createElement("div", {
      className: "text-xl font-black text-slate-900"
    }, selectedPublicDate), React.createElement("div", {
      className: "mt-1 text-sm font-bold text-slate-400"
    }, selectedDayItems.length > 0 ? `${selectedDayItems.length} \u500B\u6D3B\u52D5` : companyRestDates.includes(selectedPublicDate) ? '\u516C\u4F11' : isSelectedOutingDay ? '\u5916\u51FA\u53D6\u6750' : '\u672C\u65E5\u7121\u6D3B\u52D5')), React.createElement("button", {
      type: "button",
      onClick: () => setPublicDaySheetOpen(false),
      className: "rounded-full bg-slate-100 p-2 text-slate-500 active:scale-95",
      "aria-label": "\u95DC\u9589"
    }, React.createElement(Icon, {
      name: "x",
      size: 18
    }))), React.createElement("div", {
      className: "space-y-3 pb-3"
    }, selectedPublicDaySheetContent), React.createElement("button", {
      type: "button",
      onClick: () => setPublicDaySheetOpen(false),
      className: "sticky bottom-0 mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white shadow-lg active:scale-[0.99]"
    }, "\u6536\u8D77\uFF0C\u7E7C\u7E8C\u770B\u5176\u4ED6\u65E5\u671F"))), showLoginModal && React.createElement(LoginModal, {
      onClose: () => setShowLoginModal(false),
      onLogin: handleVerifyLogin
    }));
  }
  return React.createElement("div", {
    className: "flex min-h-screen"
  }, mobileMenuOpen && React.createElement("div", {
    className: "fixed inset-0 z-50 bg-slate-800/50 backdrop-blur-sm md:hidden",
    onClick: () => setMobileMenuOpen(false)
  }, " ", React.createElement("div", {
    className: "absolute top-0 left-0 w-64 h-full bg-white shadow-xl p-4",
    onClick: e => e.stopPropagation()
  }, " ", React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, React.createElement(Logo, {
    className: "h-6 w-auto"
  }), React.createElement("button", {
    onClick: () => setMobileMenuOpen(false),
    className: "p-2 text-slate-500"
  }, React.createElement(Icon, {
    name: "x"
  }))), " ", React.createElement("nav", {
    className: "space-y-1"
  }, " ", React.createElement(NavItem, {
    id: "planning",
    icon: "layout-grid",
    label: "\u6D3B\u52D5\u6A21\u64EC",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "promises",
    icon: "message-square",
    label: "\u627F\u8AFE\u7246",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "projects",
    icon: "briefcase",
    label: "\u5C08\u6848\u9032\u5EA6",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "dashboard",
    icon: "trending-up",
    label: "\u71DF\u904B\u5100\u8868\u677F",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "stats",
    icon: "bar-chart-2",
    label: "\u6210\u6548\u5206\u6790",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "enrollment",
    icon: "pie-chart",
    label: "\u5831\u540D\u76E3\u63A7",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "crm",
    icon: "users",
    label: "\u5BA2\u6236 CRM",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
	  }), " ", React.createElement("div", {
    className: "border-t border-slate-100 my-2 pt-2"
  }, " ", React.createElement(NavItem, {
    id: "events",
    icon: "calendar",
    label: "\u6D3B\u52D5\u5834\u6B21\u8868",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement(NavItem, {
    id: "import",
    icon: "database",
    label: "\u8CC7\u6599\u5EAB\u7BA1\u7406",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    onClick: () => setMobileMenuOpen(false)
  }), " ", React.createElement("button", {
    onClick: () => {
      setViewMode('public');
      setMobileMenuOpen(false);
    },
    className: "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-slate-500 hover:bg-slate-50 hover:text-blue-600 transition-all text-left"
  }, React.createElement(Icon, {
    name: "eye",
    size: 20
  }), React.createElement("span", {
    className: "font-medium tracking-wide"
  }, "\u9810\u89BD\u524D\u53F0")), " "), " "), " "), " "), React.createElement("aside", {
    className: `${sidebarCollapsed ? 'w-24' : 'w-64'} bg-white border-r border-slate-200 flex-col p-4 hidden md:flex sticky top-0 h-screen transition-all duration-300 ease-out`
  }, " ", React.createElement("div", {
    className: `mb-8 mt-2 ${sidebarCollapsed ? 'flex flex-col items-center gap-3' : 'flex items-center justify-between px-2'}`
  }, React.createElement("div", {
    className: `flex items-center ${sidebarCollapsed ? 'justify-center w-full' : ''}`
  }, React.createElement(Logo, {
    className: `${sidebarCollapsed ? 'h-7' : 'h-8'} w-auto`
  })), React.createElement("button", {
    title: sidebarCollapsed ? '展開側欄' : '收合側欄',
    onClick: () => setSidebarCollapsed(prev => !prev),
    className: "p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-blue-600 transition-all"
  }, React.createElement(Icon, {
    name: sidebarCollapsed ? 'chevron-right' : 'chevron-left',
    size: 18
  }))), " ", React.createElement("nav", {
    className: "space-y-1 flex-1"
  }, " ", React.createElement(NavItem, {
    id: "planning",
    icon: "layout-grid",
    label: "\u6D3B\u52D5\u6A21\u64EC",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "promises",
    icon: "message-square",
    label: "\u627F\u8AFE\u7246",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "projects",
    icon: "briefcase",
    label: "\u5C08\u6848\u9032\u5EA6",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "dashboard",
    icon: "trending-up",
    label: "\u71DF\u904B\u5100\u8868\u677F",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "stats",
    icon: "bar-chart-2",
    label: "\u6210\u6548\u5206\u6790",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "enrollment",
    icon: "pie-chart",
    label: "\u5831\u540D\u76E3\u63A7",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "crm",
    icon: "users",
    label: "\u5BA2\u6236 CRM",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
	  }), " "), " ", React.createElement("div", {
    className: "pt-4 border-t border-slate-100 space-y-2"
  }, " ", React.createElement(NavItem, {
    id: "events",
    icon: "calendar",
    label: "\u6D3B\u52D5\u5834\u6B21\u8868",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement(NavItem, {
    id: "import",
    icon: "database",
    label: "\u8CC7\u6599\u5EAB\u7BA1\u7406",
    activeTab: activeTab,
    setActiveTab: setActiveTab,
    collapsed: sidebarCollapsed
  }), " ", React.createElement("button", {
    title: sidebarCollapsed ? '預覽前台' : '',
    onClick: () => setViewMode('public'),
    className: `w-full flex items-center py-3 rounded-xl text-slate-500 hover:bg-slate-50 hover:text-blue-600 transition-all ${sidebarCollapsed ? 'justify-center px-3' : 'gap-3 px-4'}`
  }, React.createElement(Icon, {
    name: "eye",
    size: 20
  }), !sidebarCollapsed && React.createElement("span", {
    className: "font-medium tracking-wide"
  }, "\u9810\u89BD\u524D\u53F0")), " "), " "), React.createElement("main", {
    className: "flex-1 p-4 md:p-10 overflow-y-auto bg-slate-50/50 relative h-screen"
  }, React.createElement("div", {
    className: "md:hidden mb-6 flex justify-between items-center sticky top-0 z-30 bg-slate-50/90 backdrop-blur-sm py-2"
  }, React.createElement(Logo, {
    className: "h-6 w-auto"
  }), React.createElement("button", {
    onClick: () => setMobileMenuOpen(true),
    className: "p-2 bg-white rounded-lg shadow-sm text-slate-600 border border-slate-200"
  }, React.createElement(Icon, {
    name: "menu"
  }))), activeTab === 'planning' && React.createElement(PlanningBoard, {
    monthLabel: currentMonthLabel,
    planning: currentMonthPlanningData,
    availableEventNames: Array.from(new Set([...allEventNames, ...currentMonthPlanningData.activityRows.map(row => row.name)])).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    saveStatus: planningSaveStatus,
    versionHistory: currentMonthPlanVersions,
    operatorName: planningOperatorName,
    onOperatorNameChange: setPlanningOperatorName,
    onRestoreVersion: handleRestoreCurrentMonthPlanVersion,
    onSave: handleSaveMonthlyPlans,
    onPrevMonth: prevMonth,
    onNextMonth: nextMonth,
    onAddActivity: handleAddCurrentMonthPlanActivity,
    onChangeActivityMetric: handleCurrentMonthPlanActivityMetricChange,
    onBulkApplyActivityMetric: handleBulkCurrentMonthPlanActivityMetricChange,
    onChangeProfitSplit: handleCurrentMonthPlanProfitSplitChange,
    onAssignPlacement: handleAssignCurrentMonthPlanPlacement,
    onRemovePlacement: handleRemoveCurrentMonthPlanPlacement,
    onClearPlacements: handleClearCurrentMonthPlanPlacements
  }), activeTab === 'promises' && React.createElement("div", {
    className: "max-w-6xl mx-auto fade-in pb-20"
  }, React.createElement("header", {
    className: "mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
  }, React.createElement("div", null, React.createElement("h2", {
    className: "text-2xl font-bold text-slate-800 mb-1"
  }, "\u5718\u968A\u627F\u8AFE\u7246"), React.createElement("p", {
    className: "text-slate-500 text-sm"
  }, "\u7D00\u9304\u90A3\u4E9B\u975E\u6B63\u5F0F\u4F46\u91CD\u8981\u7684\u7D04\u5B9A")), React.createElement("div", {
    className: "flex gap-3 w-full md:w-auto"
  }, React.createElement("div", {
    className: "relative flex-1 md:w-64"
  }, React.createElement(Icon, {
    name: "search",
    className: "absolute left-3 top-2.5 text-slate-400",
    size: 18
  }), React.createElement("input", {
    type: "text",
    placeholder: "\u641C\u5C0B\u627F\u8AFE...",
    className: "w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-purple-500 transition-all",
    value: promiseSearch,
    onChange: e => setPromiseSearch(e.target.value)
  })), React.createElement("button", {
    onClick: () => setShowAddPromise(true),
    className: "bg-purple-600 text-white px-4 py-2 rounded-xl flex items-center gap-2 shadow-md hover:bg-purple-700 whitespace-nowrap"
  }, React.createElement(Icon, {
    name: "plus",
    size: 18
  }), " ", React.createElement("span", {
    className: "hidden md:inline"
  }, "\u65B0\u589E")))), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
  }, promises.filter(p => !promiseSearch || p.content && p.content.toLowerCase().includes(promiseSearch.toLowerCase()) || p.who && p.who.toLowerCase().includes(promiseSearch.toLowerCase())).map(p => {
    const st = getPromiseStatus(p.date, p.time);
    const isDone = p.status === 'done';
    return React.createElement("div", {
      key: p.id,
      className: `bg-white p-5 rounded-2xl border shadow-sm relative transition-all ${isDone ? 'opacity-50 border-slate-100' : 'border-slate-200 hover:shadow-md'}`
    }, React.createElement("button", {
      onClick: () => handleDeletePromise(p.id),
      className: "absolute top-3 right-3 text-slate-300 hover:text-red-400 opacity-0 hover:opacity-100 transition"
    }, React.createElement(Icon, {
      name: "trash-2",
      size: 16
    })), React.createElement("div", {
      className: "flex items-center gap-2 mb-3"
    }, React.createElement("span", {
      className: `text-[10px] font-bold px-2 py-0.5 rounded-full border ${isDone ? 'text-slate-400 border-slate-200 bg-slate-50' : `${st.color} ${st.border} ${st.bg}`}`
    }, isDone ? '已完成' : st.label), React.createElement("span", {
      className: "text-xs text-slate-400 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "clock",
      size: 12
    }), " ", p.date, " ", p.time)), React.createElement("h4", {
      className: `font-bold text-lg mb-2 ${isDone ? 'text-slate-400 line-through' : 'text-slate-800'}`
    }, p.content), p.who && React.createElement("div", {
      className: "text-sm text-slate-500 mb-4 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "user",
      size: 14
    }), " ", p.who), React.createElement("button", {
      onClick: () => handleTogglePromise(p.id, p.status),
      className: `w-full py-2 rounded-xl border font-bold text-sm flex items-center justify-center gap-2 transition-all ${isDone ? 'bg-slate-50 text-slate-400 border-slate-200' : 'bg-white text-purple-600 border-purple-200 hover:bg-purple-50'}`
    }, isDone ? '重啟任務' : '標示完成'));
  }))), activeTab === 'events' && React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto pb-20 flex flex-col"
  }, React.createElement("header", {
    className: "flex justify-between items-center mb-6"
  }, React.createElement("div", null, React.createElement("h2", {
    className: "text-2xl font-bold"
  }, "\u6D3B\u52D5\u5834\u6B21"), React.createElement("div", {
    className: "text-[11px] text-slate-400 mt-1"
  }, "Build: ", APP_BUILD)), React.createElement("div", {
    className: "flex gap-3 flex-wrap justify-end"
  }, React.createElement("button", {
    onClick: handleOpenMonthlyPosterGenerator,
    disabled: posterGenerating,
    className: `px-3 py-1.5 text-xs font-bold rounded-lg flex items-center gap-2 shadow-md border ${posterGenerating ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-wait' : 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600'}`
  }, React.createElement(Icon, {
    name: "image",
    size: 14
  }), posterGenerating ? '生成中...' : '生成月曆海報（PNG + HTML）'), React.createElement("button", {
    onClick: () => setShowPosterNameSettings(true),
    className: "bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 text-xs font-bold rounded-lg flex items-center gap-2 shadow-md border border-slate-200"
  }, React.createElement(Icon, {
    name: "edit-3",
    size: 14
  }), " \u6D77\u5831\u540D\u7A31\u5C0D\u7167"), React.createElement("button", {
    onClick: handleExportCurrentCsvAsTxt,
    className: "bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 text-xs font-bold rounded-lg flex items-center gap-2 shadow-md border border-slate-200"
  }, React.createElement(Icon, {
    name: "file-text",
    size: 14
  }), " \u532F\u51FA TXT"), React.createElement("button", {
    onClick: () => setShowExportModal(true),
    className: "bg-slate-800 hover:bg-slate-900 text-white px-3 py-1.5 text-xs font-bold rounded-lg flex items-center gap-2 shadow-md"
  }, React.createElement(Icon, {
    name: "download",
    size: 14
  }), " \u532F\u51FA\u6708\u66C6\u8CC7\u6599"), React.createElement("button", {
    onClick: () => openCreateEventModal(),
    className: "bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-bold rounded-lg flex items-center gap-2 shadow-md"
  }, React.createElement(Icon, {
    name: "plus",
    size: 14
  }), " \u5FEB\u901F\u958B\u5718"), React.createElement("div", {
    className: "bg-white p-1 rounded-lg border flex"
  }, React.createElement("button", {
    onClick: () => setEventsViewMode('list'),
    className: `p-2 rounded-md ${eventsViewMode === 'list' ? 'bg-slate-100' : ''}`
  }, React.createElement(Icon, {
    name: "list",
    size: 18
  })), React.createElement("button", {
    onClick: () => setEventsViewMode('calendar'),
    className: `p-2 rounded-md ${eventsViewMode === 'calendar' ? 'bg-slate-100' : ''}`
  }, React.createElement(Icon, {
    name: "calendar",
    size: 18
  }))))), React.createElement("div", {
    className: "mb-6 rounded-2xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-sm text-slate-600 shadow-sm"
  }, "\u751F\u6210\u6708\u66C6\u6D77\u5831\u6642\uFF0C\u6703\u5148\u8B93\u4F60\u52FE\u9078\u9019\u6B21\u60F3\u51FA\u73FE\u5728\u5716\u7247\u4E0A\u7684\u6D3B\u52D5\uFF0C\u518D\u540C\u6642\u4E0B\u8F09\u4E00\u5F35 ", React.createElement("span", {
    className: "font-bold text-slate-800"
  }, "PNG \u5716\u7247"), "\uFF0C\u4EE5\u53CA\u4E00\u4EFD ", React.createElement("span", {
    className: "font-bold text-slate-800"
  }, "\u56FA\u5B9A\u7248\u578B\u7684 HTML \u6D77\u5831"), "\u3002"), React.createElement("div", {
    className: "mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
  }, React.createElement("div", {
    className: "flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-xs font-bold uppercase tracking-wide text-slate-500"
  }, "\u7248\u672C\u63A7\u5236"), React.createElement("div", {
    className: "text-sm text-slate-500 mt-1"
  }, "\u73FE\u5728\u6D3B\u52D5\u5834\u6B21\u8868\u4E5F\u6703\u7559\u4E0B\u7248\u672C\u3002\u9019\u88E1\u53EA\u986F\u793A\u8207 ", currentMonthLabel, " \u6709\u95DC\u7684\u8B8A\u66F4\uFF0C\u65B9\u4FBF\u56DE\u982D\u67E5\u8AB0\u52D5\u904E\u54EA\u500B\u6708\u4EFD\u3002")), React.createElement("div", {
    className: "flex flex-wrap items-center gap-3"
  }, React.createElement("div", {
    className: "flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
  }, React.createElement("span", {
    className: "text-[11px] font-bold text-slate-500 whitespace-nowrap"
  }, "\u64CD\u4F5C\u4EBA"), React.createElement("input", {
    type: "text",
    value: eventVersionOperatorName,
    onChange: e => setEventVersionOperatorName(e.target.value),
    placeholder: "\u4F8B\u5982 \u90ED\u739F\u5E0C",
    className: "w-28 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-300"
  })), React.createElement("div", {
    className: "text-[11px] text-slate-400"
  }, currentMonthLabel, " \u7248\u672C\u7D00\u9304"), React.createElement("button", {
    type: "button",
    onClick: () => setEventVersionsExpanded(prev => !prev),
    className: "inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
  }, React.createElement(Icon, {
    name: eventVersionsExpanded ? 'chevron-up' : 'chevron-down',
    size: 14
  }), eventVersionsExpanded ? '收起版本' : '展開版本'))), eventVersionStatus.status !== 'idle' && React.createElement("div", {
    className: `mt-4 rounded-xl border px-4 py-3 text-sm ${eventVersionStatus.status === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : eventVersionStatus.status === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-sky-50 border-sky-200 text-sky-700'}`
  }, React.createElement("div", {
    className: "font-bold mb-1"
  }, "\u6D3B\u52D5\u5834\u6B21\u7248\u672C\u72C0\u614B"), React.createElement("div", null, eventVersionStatus.message), eventVersionStatus.at && React.createElement("div", {
    className: "text-xs opacity-75 mt-1"
  }, "\u6642\u9593\uFF1A", eventVersionStatus.at)), !eventVersionsExpanded ? React.createElement("div", {
    className: "mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-400"
  }, "\u7248\u672C\u5217\u8868\u5DF2\u6536\u8D77\u3002\u5C55\u958B\u5F8C\u53EF\u67E5\u770B ", currentMonthLabel, " \u6700\u8FD1\u7684\u5EFA\u7ACB\u3001\u8ABF\u6574\u3001\u522A\u9664\u8207\u9084\u539F\u7D00\u9304\u3002") : eventScheduleVersions.length > 0 ? React.createElement("div", {
    className: "mt-4 space-y-2"
  }, eventScheduleVersions.map(version => React.createElement("div", {
    key: `event_version_${version.id}`,
    className: "rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3"
  }, React.createElement("div", {
    className: "flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", {
    className: "flex flex-wrap items-center gap-2 text-xs"
  }, React.createElement("span", {
    className: `rounded-full px-2 py-1 font-bold ${version.action === 'restore' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`
  }, version.action === 'restore' ? '還原' : version.action === 'delete' ? '刪除' : version.action === 'create' ? '建立' : '儲存'), React.createElement("span", {
    className: "font-bold text-slate-600"
  }, formatPlanningVersionTimestamp(version.savedAt)), React.createElement("span", {
    className: "text-slate-400"
  }, version.savedByName || DEFAULT_EVENT_VERSION_OPERATOR_NAME)), React.createElement("button", {
    type: "button",
    onClick: () => handleRestoreEventScheduleVersion(version),
    className: "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
  }, React.createElement(Icon, {
    name: "history",
    size: 14
  }), " \u9084\u539F\u9019\u7248")), React.createElement("div", {
    className: "mt-2 text-xs text-slate-500"
  }, version.summary || '這個版本沒有附帶摘要。'), Array.isArray(version.details) && version.details.length > 0 && React.createElement("div", {
    className: "mt-2 space-y-1 rounded-lg bg-white px-3 py-2"
  }, version.details.slice(0, 4).map((detail, idx) => React.createElement("div", {
    key: `event_version_detail_${version.id}_${idx}`,
    className: "text-[11px] text-slate-500"
  }, "\u2022 ", detail)), version.details.length > 4 && React.createElement("div", {
    className: "text-[11px] text-slate-400"
  }, "\u9084\u6709 ", version.details.length - 4, " \u9805\u7D30\u7BC0"))))) : React.createElement("div", {
    className: "mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-400"
  }, "\u9019\u500B\u6708\u4EFD\u9084\u6C92\u6709\u6D3B\u52D5\u5834\u6B21\u7248\u672C\u3002\u4E4B\u5F8C\u5728 ", currentMonthLabel, " \u5EFA\u7ACB\u3001\u8ABF\u6574\u6216\u522A\u9664\u6D3B\u52D5\u6642\uFF0C\u6703\u958B\u59CB\u81EA\u52D5\u7D2F\u7A4D\u3002")), eventDeleteStatus.status !== 'idle' && React.createElement("div", {
    className: `mb-4 rounded-xl border px-4 py-3 text-sm ${eventDeleteStatus.status === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : eventDeleteStatus.status === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' : eventDeleteStatus.status === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' : eventDeleteStatus.status === 'checking' ? 'bg-sky-50 border-sky-200 text-sky-700' : 'bg-slate-50 border-slate-200 text-slate-700'}`
  }, React.createElement("div", {
    className: "font-bold mb-1"
  }, "\u6D3B\u52D5\u522A\u9664\u72C0\u614B"), React.createElement("div", null, eventDeleteStatus.message), eventDeleteStatus.at && React.createElement("div", {
    className: "text-xs opacity-75 mt-1"
  }, "\u6642\u9593\uFF1A", eventDeleteStatus.at)), React.createElement(MonthlyKpiPanel, {
    monthLabel: currentMonthLabel,
    actuals: currentMonthKpiActuals,
    target: currentMonthKpiTarget,
    activityRows: currentMonthKpiRows,
    availableEventNames: allEventNames,
    onChangeTarget: handleCurrentMonthKpiFieldChange,
    onChangeActivityTarget: handleCurrentMonthActivityTargetChange,
    onAddActivityTarget: handleAddCurrentMonthActivityTarget,
    onSave: handleSaveMonthlyKpis,
    saveStatus: kpiSaveStatus,
    onPrevMonth: prevMonth,
    onNextMonth: nextMonth,
    onMatrixCellClick: handleOpenCreateEventFromMatrix
  }), eventsViewMode === 'list' && React.createElement("div", {
    className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden table-container"
  }, React.createElement("table", {
    className: "w-full text-left min-w-[600px]"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500 text-sm"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "px-6 py-4 whitespace-nowrap"
  }, "\u65E5\u671F"), React.createElement("th", {
    className: "px-6 py-4 whitespace-nowrap"
  }, "\u6D3B\u52D5"), React.createElement("th", {
    className: "px-6 py-4 whitespace-nowrap"
  }, "\u5831\u540D"), React.createElement("th", {
    className: "px-6 py-4 whitespace-nowrap"
  }, "\u64CD\u4F5C"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, Object.values(stats.events).map((e, i) => {
    const cfg = eventConfigs[e.key] || {};
    const cap = cfg.capacity || 12;
    const isFull = e.count >= cap;
    const carpool = e.customers ? e.customers.filter(c => c.transport === '共乘').length : 0;
    const totalPeople = Number.isFinite(Number(e.count)) ? Number(e.count) : Array.isArray(e.customers) ? e.customers.length : 0;
    const isCancelled = !!cfg.isCancelled;
    const safeDate = toSafeDisplayText(e.date, '');
    const safeEventName = toSafeDisplayText(e.eventName, '未命名活動');
    const safeInstructor = toSafeDisplayText(e.instructor, '未定');
    return React.createElement("tr", {
      key: i,
      className: "hover:bg-slate-50/80"
    }, React.createElement("td", {
      className: "px-6 py-4 text-slate-600 whitespace-nowrap"
    }, safeDate), React.createElement("td", {
      className: "px-6 py-4"
    }, React.createElement("div", {
      className: "font-bold text-slate-800 flex items-center gap-2"
    }, safeEventName, isCancelled && React.createElement("span", {
      className: "text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200"
    }, "\u6D41\u5718")), React.createElement("div", {
      className: "text-xs text-slate-400 mt-0.5"
    }, safeInstructor)), React.createElement("td", {
      className: "px-6 py-4"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: `font-bold ${isFull ? 'text-red-500' : 'text-slate-700'}`
    }, carpool), React.createElement("span", {
      className: "text-xs text-slate-400"
    }, " / ", totalPeople, " \u4EBA"), React.createElement("div", {
      className: "w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden"
    }, React.createElement("div", {
      className: `h-full ${isFull ? 'bg-red-500' : 'bg-green-500'}`,
      style: {
        width: `${Math.min(e.count / cap * 100, 100)}%`
      }
    }))), React.createElement("div", {
      className: "text-[10px] text-slate-400 mt-1 flex items-center gap-1"
    }, React.createElement(Icon, {
      name: "car",
      size: 10,
      className: "mr-1"
    }), "\u5171\u4E58 / \u7E3D\u4EBA\u6578\uFF08\u4E0A\u9650 ", cap, "\uFF09")), React.createElement("td", {
      className: "px-6 py-4"
    }, React.createElement("button", {
      onClick: () => setEditingEvent(e),
      className: "text-blue-600 hover:bg-blue-50 px-3 py-1.5 rounded flex items-center gap-1 text-sm whitespace-nowrap"
    }, React.createElement(Icon, {
      name: "settings",
      size: 14
    }), " \u7BA1\u7406")));
  })))), eventsViewMode === 'calendar' && React.createElement("div", {
    className: "bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-slate-200 table-container"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-6 sticky left-0"
  }, React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("button", {
    onClick: prevMonth,
    className: "p-2 hover:bg-slate-100 rounded-full"
  }, React.createElement(Icon, {
    name: "chevron-left"
  })), React.createElement("h3", {
    className: "text-xl font-bold text-slate-800 whitespace-nowrap"
  }, currentDate.getFullYear(), "\u5E74 ", currentDate.getMonth() + 1, "\u6708"), React.createElement("button", {
    onClick: nextMonth,
    className: "p-2 hover:bg-slate-100 rounded-full"
  }, React.createElement(Icon, {
    name: "chevron-right"
  })))), React.createElement("div", {
    className: "min-w-[600px]"
  }, React.createElement("div", {
    className: "grid grid-cols-7 mb-2 text-center text-sm font-bold text-slate-400"
  }, ['日', '一', '二', '三', '四', '五', '六'].map(d => React.createElement("div", {
    key: d
  }, d))), React.createElement("div", {
    className: "grid grid-cols-7 auto-rows-[160px] border-t border-l border-slate-200"
  }, calendarDays.map((day, i) => {
    const dateStr = day ? `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
    const dayItems = day ? calendarOccupancy[dateStr] || [] : [];
    const isCompanyRestDay = day ? companyRestDates.includes(dateStr) : false;
	    const isTodayCell = day ? dateStr === getLocalDateStr() : false;
	    const isInternalDay = day ? !!(internalDays[dateStr] && internalDays[dateStr].enabled) : false;
	    const internalLabel = day ? toSafeDisplayText(internalDays[dateStr]?.label, '').trim() : '';
	    const restDisplayItems = day ? getScheduleRestDisplayItems(instructorSchedule[dateStr]) : [];
	    return React.createElement("div", {
      key: i,
      onClick: () => {
        if (day && !isCompanyRestDay) {
          openCreateEventModal(dateStr);
        }
      },
      className: `border-b border-r border-slate-200 p-1 md:p-2 relative group ${day ? isCompanyRestDay ? 'bg-slate-50/70 cursor-not-allowed' : 'hover:bg-blue-50 cursor-pointer' : 'bg-slate-50/50'} ${isTodayCell ? 'ring-2 ring-amber-300 ring-inset bg-amber-50/80' : ''}`
    }, day && React.createElement(React.Fragment, null, React.createElement("div", {
      className: "flex justify-between items-start"
    }, React.createElement("div", {
      className: `text-sm font-medium mb-1 group-hover:text-blue-600 transition-colors ${isTodayCell ? 'text-amber-700 font-black' : ''}`
    }, day, isTodayCell && React.createElement("span", {
      className: "ml-1 inline-flex items-center rounded-full bg-amber-400/20 border border-amber-300 px-1.5 py-0.5 text-[9px] leading-none font-black text-amber-700 align-middle"
    }, "\u4ECA\u5929")), React.createElement("button", {
      onClick: e => {
        e.stopPropagation();
        setShowScheduleModal(true);
        setScheduleDate(dateStr);
      },
      className: "text-slate-300 hover:text-blue-600 p-1 rounded-full hover:bg-white shadow-sm transition-all"
    }, React.createElement(Icon, {
      name: "calendar-days",
      size: 14
    }))), companyRestDates.includes(dateStr) ? React.createElement("div", {
      className: "flex items-center justify-center h-[100px] text-slate-300 font-bold text-2xl select-none bg-slate-50/50 rounded-lg"
    }, "\u2715") : React.createElement("div", {
      className: "space-y-1 overflow-y-auto max-h-[120px] no-scrollbar"
    }, dayItems.map((item, idx) => {
      const {
        type,
	        evt,
	        cfg,
	        label,
	        displayTime,
	        timeSlot
	      } = item;
      const isMain = type === 'main';
      const isPrep = type === 'prep';
      const isCancelled = !!cfg.isCancelled;
      const safeEventName = toSafeDisplayText(evt?.eventName, '未命名活動');
      const safeInstructor = toSafeDisplayText(evt?.instructor, '?');
	      const safeLabel = toSafeDisplayText(label, '');
	      const safeDisplayTime = toSafeDisplayText(displayTime, '');
	      const safeTimeSlotLabel = getScheduleSlotLabel(timeSlot || inferScheduleTimeSlot(displayTime));
      const carpoolCount = Array.isArray(evt?.customers) ? evt.customers.filter(customer => customer && customer.transport === '共乘').length : 0;
      const totalPeople = Number.isFinite(Number(evt?.count)) ? Number(evt.count) : Array.isArray(evt?.customers) ? evt.customers.length : 0;
      let cardClass = 'mb-1 p-1 px-1.5 rounded-md border cursor-pointer transition-all group hover:shadow-md text-[10px] relative overflow-hidden ';
      let cardStyle = {};
      const baseColor = cfg.backendColor || '#3b82f6';
      if (isPrep) {
        cardClass += 'bg-amber-50 text-amber-700 border-amber-200 opacity-90';
        cardStyle = {
          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(251, 191, 36, 0.1) 5px, rgba(251, 191, 36, 0.1) 10px)'
        };
      } else if (type === 'cont') {
        cardClass += 'text-slate-600 border-slate-200';
        cardStyle = {
          backgroundColor: baseColor + '22',
          borderLeft: `3px solid ${baseColor}`
        };
      } else {
        const isFull = cfg.capacity > 0 && evt.count >= cfg.capacity;
        if (cfg.backendColor) {
          const bgColor = cfg.backendColor.startsWith('#') ? cfg.backendColor + '33' : cfg.backendColor;
          cardStyle = {
            backgroundColor: bgColor,
            borderColor: cfg.backendColor,
            borderWidth: '1.5px'
          };
          cardClass += 'border font-bold text-slate-800';
        } else {
          cardClass += 'bg-blue-50 border-blue-100 font-bold text-blue-800';
        }
        if (isFull) cardClass += ' contrast-95';
      }
      if (isMain && isCancelled) cardClass += ' ring-1 ring-rose-300';
      return React.createElement("div", {
        key: `${evt.key}_${type}_${idx}`,
        onClick: e => {
          e.stopPropagation();
          setEditingEvent(evt);
        },
        className: cardClass,
        style: cardStyle,
        title: `${safeEventName} @${safeInstructor || '未定'}`
      }, isMain && isCancelled && React.createElement("div", {
        className: "absolute bottom-0 right-0 bg-rose-600 text-white text-[8px] leading-none px-1 py-0.5 rounded-tl-md font-bold tracking-wide"
      }, "\u6D41\u5718"), isMain ? React.createElement("div", {
        className: "flex flex-col leading-none py-0.5"
      }, React.createElement("div", {
        className: "flex justify-between items-center opacity-70 text-[8px] mb-0.5 font-mono"
	      }, React.createElement("span", null, safeTimeSlotLabel, " ", safeDisplayTime), React.createElement("span", {
        className: "font-bold"
      }, carpoolCount, " / ", totalPeople, "\u4EBA")), React.createElement("div", {
        className: "truncate font-bold text-[10px] mb-0.5"
      }, safeEventName), React.createElement("div", {
        className: "truncate opacity-60 font-normal text-[9px]"
      }, "@", safeInstructor || '?')) : isPrep ? React.createElement("div", {
        className: "flex flex-col leading-none py-0.5"
      }, React.createElement("div", {
        className: "flex items-center gap-1 opacity-70 text-[8px] mb-0.5 font-mono"
	      }, React.createElement("span", null, safeTimeSlotLabel, " ", safeDisplayTime), React.createElement(Icon, {
        name: "alert-circle",
        size: 8
      }), React.createElement("span", null, "\u524D\u7F6E")), React.createElement("div", {
        className: "truncate text-[10px]"
      }, safeEventName, " ", React.createElement("span", {
        className: "opacity-60 text-[9px]"
      }, "@", safeInstructor))) : React.createElement("div", {
        className: "flex items-center gap-1"
      }, safeLabel));
	    })), restDisplayItems.length > 0 && !companyRestDates.includes(dateStr) && React.createElement("div", {
	      className: "text-[10px] text-red-400 flex flex-wrap gap-1 mt-1"
	    }, restDisplayItems.map(item => {
	      const safeName = toSafeDisplayText(item.name, '').trim();
	      const safeSlotLabel = item.slot === 'all' ? '' : toSafeDisplayText(item.label, '');
	      return safeName ? React.createElement("span", {
	        key: `${safeName}_${item.slot}`,
	        className: "bg-red-50 px-1 rounded"
	      }, safeName, safeSlotLabel, "\u4F11") : null;
	    })), outingDays[dateStr]?.enabled && !companyRestDates.includes(dateStr) && React.createElement("div", {
      className: "absolute bottom-1 right-1 max-w-[90%] text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 leading-tight shadow-sm pointer-events-none"
    }, React.createElement("span", {
      className: "font-bold"
    }, "\u5834\u52D8"), Array.isArray(outingDays[dateStr]?.people) && outingDays[dateStr].people.length > 0 && React.createElement("span", {
      className: "ml-1"
    }, ": ", outingDays[dateStr].people.map(person => toSafeDisplayText(person, '').trim()).filter(Boolean).join('、'))), isInternalDay && !companyRestDates.includes(dateStr) && React.createElement("div", {
      className: "absolute bottom-1 left-1 max-w-[80%] text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5 leading-tight shadow-sm pointer-events-none"
    }, "\u5167\u90E8", internalLabel ? `：${internalLabel}` : '')));
  }))))), activeTab === 'projects' && React.createElement(ProjectConsoleTab, {
    user: user,
    db: db,
    dbSource: dbSource,
    sourceProjects: projects
  }), activeTab === 'dashboard' && React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto space-y-8 pb-20"
  }, React.createElement("header", {
    className: "flex justify-between items-center"
  }, React.createElement("h2", {
    className: "text-2xl font-bold"
  }, "\u71DF\u904B\u5100\u8868\u677F"), React.createElement("button", {
    onClick: () => downloadCSV(csvInput, 'full_export.csv'),
    className: "text-sm bg-slate-800 text-white px-4 py-2 rounded-lg flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "download",
    size: 16
  }), " \u532F\u51FA\u7E3D\u8868 (Excel)")), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6"
  }, React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-blue-100 relative overflow-hidden"
  }, React.createElement("div", {
    className: "absolute -right-4 -top-4 text-blue-50 opacity-50"
  }, React.createElement(Icon, {
    name: "trending-up",
    size: 100
  })), React.createElement("div", {
    className: "relative"
  }, React.createElement("div", {
    className: "text-sm font-bold text-blue-600 mb-1 uppercase tracking-wider"
  }, "\u672C\u6708\u71DF\u6536"), React.createElement("div", {
    className: "text-4xl font-bold text-slate-800"
  }, "$", dashboardData.currentMonthRev.toLocaleString()))), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-indigo-100 relative overflow-hidden"
  }, React.createElement("div", {
    className: "absolute -right-4 -top-4 text-indigo-50 opacity-50"
  }, React.createElement(Icon, {
    name: "users",
    size: 100
  })), React.createElement("div", {
    className: "relative"
  }, React.createElement("div", {
    className: "text-sm font-bold text-indigo-600 mb-1 uppercase tracking-wider"
  }, "\u672C\u6708\u4EBA\u6B21"), React.createElement("div", {
    className: "text-4xl font-bold text-slate-800"
  }, dashboardData.currentMonthPax, " ", React.createElement("span", {
    className: "text-lg font-normal text-slate-400"
  }, "\u4EBA")))), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-emerald-100 relative overflow-hidden"
  }, React.createElement("div", {
    className: "absolute -right-4 -top-4 text-emerald-50 opacity-50"
  }, React.createElement(Icon, {
    name: "calendar-days",
    size: 100
  })), React.createElement("div", {
    className: "relative"
  }, React.createElement("div", {
    className: "text-sm font-bold text-emerald-600 mb-1 uppercase tracking-wider"
  }, "\u672C\u6708\u7E3D\u5718\u6578"), React.createElement("div", {
    className: "text-4xl font-bold text-slate-800"
  }, dashboardData.currentMonthGroups, " ", React.createElement("span", {
    className: "text-lg font-normal text-slate-400"
  }, "\u5718")))), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-100"
  }, React.createElement("div", {
    className: "text-sm font-medium text-slate-500 mb-4"
  }, "\u6B77\u53F2\u7E3D\u71DF\u6536"), React.createElement("div", {
    className: "text-2xl font-bold text-slate-700"
  }, "$", stats.totalRev.toLocaleString()))), React.createElement("div", null, React.createElement("h3", {
    className: "text-lg font-bold text-slate-700 mb-4"
  }, "\u6708\u5EA6\u71DF\u904B\u5831\u8868"), Object.entries(dashboardData.monthlyGroups).sort((a, b) => b[0].localeCompare(a[0])).map(([month, data]) => React.createElement(MonthlyReport, {
    key: month,
    month: month,
    data: data,
    events: stats.events,
    eventConfigs: eventConfigs
  })))), activeTab === 'stats' && React.createElement(ActivityPerformance, {
    parsedData: parsedData,
    eventConfigs: eventConfigs,
    productPerformanceSettings: performanceProductSettings,
    onSaveProductPerformanceSettings: handleSavePerformanceProductSettings
  }), activeTab === 'enrollment' && React.createElement(EnrollmentMonitor, {
    stats: stats,
    eventConfigs: eventConfigs,
    tagDefinitions: tagDefinitions
  }), activeTab === 'crm' && React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto pb-20"
  }, React.createElement("header", {
    className: "mb-6 flex flex-col md:flex-row justify-between items-center gap-4"
  }, React.createElement("div", null, React.createElement("h2", {
    className: "text-2xl font-bold text-slate-800"
  }, "\u5BA2\u6236\u50F9\u503C\u5206\u6790 (CRM)"), React.createElement("p", {
    className: "text-sm text-slate-500"
  }, "\u53EF\u5207\u63DB\u7E3D\u6D88\u8CBB\u3001\u6D88\u8CBB\u6B21\u6578\u3001\u5E73\u5747\u6BCF\u6708\u6D88\u8CBB\u7B49\u4E0D\u540C\u6392\u884C\u65B9\u5F0F")), React.createElement("div", {
    className: "flex bg-slate-100 p-1 rounded-xl"
  }, [{
    id: 'all',
    label: '全時段'
  }, {
    id: 'year',
    label: '近一年'
  }, {
    id: 'quarter',
    label: '近一季'
  }, {
    id: 'month',
    label: '近一月'
  }].map(t => React.createElement("button", {
    key: t.id,
    onClick: () => setLtvTimeframe(t.id),
    className: `px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${ltvTimeframe === t.id ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`
  }, t.label)))), React.createElement("div", {
    className: "grid grid-cols-3 gap-4 mb-6"
  }, React.createElement("div", {
    className: "bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl p-4 text-white shadow-lg shadow-blue-200"
  }, React.createElement("div", {
    className: "text-blue-100 text-xs font-bold mb-1"
  }, "\u5340\u9593\u5E73\u5747 LTV (\u4EBA\u5747\u8CA2\u737B)"), React.createElement("div", {
    className: "text-2xl font-bold"
  }, "$", ltvStats.avgLtv.toLocaleString())), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-2xl p-4 shadow-sm"
  }, React.createElement("div", {
    className: "text-slate-400 text-xs font-bold mb-1"
  }, "\u5340\u9593\u7E3D\u71DF\u6536"), React.createElement("div", {
    className: "text-2xl font-bold text-slate-700"
  }, "$", ltvStats.periodRevenue.toLocaleString())), React.createElement("div", {
    className: "bg-white border border-slate-200 rounded-2xl p-4 shadow-sm"
  }, React.createElement("div", {
    className: "text-slate-400 text-xs font-bold mb-1"
  }, "\u6D3B\u8E8D\u5BA2\u6236\u6578"), React.createElement("div", {
    className: "text-2xl font-bold text-slate-700"
  }, ltvStats.activeCustomerCount, " ", React.createElement("span", {
    className: "text-sm font-normal text-slate-400"
  }, "\u4EBA")))), React.createElement("div", {
    className: "grid grid-cols-1 lg:grid-cols-3 gap-8"
  }, React.createElement("div", {
    className: "lg:col-span-1 space-y-4"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl border border-slate-200 shadow-sm p-4"
  }, React.createElement("div", {
    className: "text-xs font-bold text-slate-400 mb-3"
  }, "\u6392\u884C\u65B9\u5F0F"), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, crmRankOptions.map(option => React.createElement("button", {
    key: option.id,
    onClick: () => setCrmRankMode(option.id),
    className: `px-3 py-1.5 rounded-full text-xs font-bold transition-all ${crmRankMode === option.id ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700'}`
  }, option.label)))), React.createElement("div", {
    className: "relative"
  }, React.createElement(Icon, {
    name: "search",
    className: "absolute left-3 top-3 text-slate-400",
    size: 20
  }), React.createElement("input", {
    type: "text",
    className: "w-full pl-10 pr-4 py-3 bg-white border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 shadow-sm",
    placeholder: "\u641C\u5C0B\u5BA2\u6236\u59D3\u540D...",
    value: crmSearchTerm,
    onChange: e => {
      setCrmSearchTerm(e.target.value);
      setShowCrmDropdown(true);
      setSelectedCustomer('');
    },
    onFocus: () => setShowCrmDropdown(true),
    onBlur: () => setTimeout(() => setShowCrmDropdown(false), 200)
  }), showCrmDropdown && crmSearchTerm && React.createElement("div", {
    className: "absolute z-10 w-full bg-white border border-slate-200 rounded-xl shadow-lg mt-1 max-h-60 overflow-y-auto"
  }, filteredCrmCustomers.length > 0 ? filteredCrmCustomers.map(c => React.createElement("div", {
    key: c,
    className: "p-3 hover:bg-blue-50 cursor-pointer text-slate-700 flex justify-between items-center gap-2",
    onClick: () => {
      setSelectedCustomer(c);
      setCrmSearchTerm(c);
      setShowCrmDropdown(false);
    }
  }, React.createElement("span", {
    className: "truncate"
  }, c), React.createElement("span", {
    className: "text-[11px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded font-mono whitespace-nowrap"
  }, activeCrmRankOption.formatValue(ltvStats.getRankValue(c, crmRankMode))))) : React.createElement("div", {
    className: "p-3 text-slate-400 text-sm"
  }, "\u7121\u76F8\u7B26\u5BA2\u6236"))), React.createElement("div", {
    className: "bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"
  }, React.createElement("div", {
    className: "p-4 border-b border-slate-100 bg-slate-50/50 font-bold text-slate-700 flex justify-between items-center"
  }, React.createElement("span", null, "\uD83C\uDFC6 ", activeCrmRankOption.title, " (", ltvTimeframe === 'all' ? '全時段' : '區間', ")")), React.createElement("div", {
    className: "max-h-[500px] overflow-y-auto"
  }, crmSortedCustomers.slice(0, 50).map((name, idx) => {
    const metric = ltvStats.customerMetrics[name] || {};
    return React.createElement("div", {
      key: name,
      onClick: () => {
        setSelectedCustomer(name);
        setCrmSearchTerm(name);
      },
      className: `p-3 flex items-center justify-between border-b border-slate-50 cursor-pointer hover:bg-blue-50 transition-colors ${selectedCustomer === name ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`
    }, React.createElement("div", {
      className: "flex items-center gap-3 min-w-0"
    }, React.createElement("div", {
      className: `w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${idx < 3 ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-500'}`
    }, idx + 1), React.createElement("span", {
      className: "text-sm font-medium text-slate-700 truncate"
    }, name)), React.createElement("div", {
      className: "text-right shrink-0 ml-3"
    }, React.createElement("div", {
      className: "text-sm font-bold text-blue-600"
    }, activeCrmRankOption.formatValue(ltvStats.getRankValue(name, crmRankMode))), React.createElement("div", {
      className: "text-[10px] text-slate-400"
    }, activeCrmRankOption.renderMeta(metric))));
  })))), React.createElement("div", {
    className: "lg:col-span-2"
  }, customerProfile ? React.createElement("div", {
    className: "animate-in fade-in slide-in-from-top-4"
  }, React.createElement("div", {
    className: "flex flex-col md:flex-row justify-between items-start gap-6 mb-8 pb-8 border-b border-slate-100"
  }, React.createElement("div", {
    className: "flex items-center gap-6"
  }, React.createElement("div", {
    className: "w-24 h-24 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-4xl font-bold text-white shadow-lg shrink-0"
  }, selectedCustomer[0]), React.createElement("div", null, React.createElement("div", {
    className: "text-3xl font-bold text-slate-800 mb-1"
  }, selectedCustomer), React.createElement("div", {
    className: "text-sm text-slate-500 flex items-center gap-2"
  }, React.createElement(Icon, {
    name: "credit-card",
    size: 14
  }), " LTV (\u7D42\u8EAB\u50F9\u503C): ", React.createElement("span", {
    className: "text-blue-600 font-bold"
  }, "$", customerProfile.totalSpend.toLocaleString())))), React.createElement("button", {
    onClick: () => setEditingRow(customerProfile.latestRecord),
    className: "text-slate-400 hover:text-blue-600 flex items-center gap-1 text-sm border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition whitespace-nowrap"
  }, React.createElement(Icon, {
    name: "edit-2",
    size: 14
  }), " \u7DE8\u8F2F\u8CC7\u6599/\u5099\u8A3B")), React.createElement("div", {
    className: "flex-1 bg-slate-50 p-4 rounded-xl border border-slate-100 grid grid-cols-2 gap-y-3 gap-x-6 text-sm mb-8"
  }, React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "Email"), toSafeDisplayText(customerProfile.email, '-')), React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u624B\u6A5F"), toSafeDisplayText(customerProfile.phone, '-')), React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u8EAB\u5206\u8B49"), toSafeDisplayText(customerProfile.idNo, '-')), React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u751F\u65E5"), toSafeDisplayText(customerProfile.birthday, '-')), React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u5E38\u7528\u4EA4\u901A"), toSafeDisplayText(customerProfile.transport, '-')), React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u4F86\u6E90\u7BA1\u9053"), toSafeDisplayText(customerProfile.source, '-')), React.createElement("div", null, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u793E\u7FA4\u66B1\u7A31"), toSafeDisplayText(customerProfile.socialName, '-')), React.createElement("div", {
    className: "col-span-2"
  }, React.createElement("span", {
    className: "block text-xs text-slate-400 font-bold uppercase"
  }, "\u5099\u8A3B"), toSafeDisplayText(customerProfile.notes, '-'))), React.createElement("h4", {
    className: "font-bold text-slate-700 mb-4"
  }, "\u6D88\u8CBB\u6B77\u53F2 (", customerProfile.history.length, ")"), React.createElement("div", {
    className: "space-y-2 table-container max-h-[400px] overflow-y-auto"
  }, customerProfile.history.map((h, i) => React.createElement("div", {
    key: i,
    className: "flex justify-between items-center p-4 border border-slate-100 rounded-xl hover:bg-slate-50 transition"
  }, React.createElement("div", null, React.createElement("div", {
    className: "font-bold text-slate-700"
  }, toSafeDisplayText(h.eventName, '未命名活動')), React.createElement("div", {
    className: "text-xs text-slate-400 mt-1"
  }, toSafeDisplayText(h.date, ''), " \u2022 ", toSafeDisplayText(h.instructor, '未定')), h.orderDate && React.createElement("div", {
    className: "text-xs text-blue-500 mt-0.5"
  }, "\uD83D\uDCC5 \u4E0B\u5B9A\u65BC: ", toSafeDisplayText(h.orderDate, ''))), React.createElement("div", {
    className: "font-mono font-bold text-slate-600"
  }, "$", h.price))))) : React.createElement("div", {
    className: "h-full flex flex-col items-center justify-center text-slate-400 bg-white rounded-2xl border border-dashed border-slate-200 min-h-[400px]"
  }, React.createElement("div", {
    className: "w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4"
  }, React.createElement(Icon, {
    name: "user-check",
    size: 32,
    className: "text-slate-300"
  })), React.createElement("p", {
    className: "font-bold"
  }, "\u8ACB\u5F9E\u5DE6\u5074\u6392\u884C\u699C\u9078\u64C7\u4E00\u4F4D\u5BA2\u6236"), React.createElement("p", {
    className: "text-sm mt-1"
	  }, "\u6216\u4F7F\u7528\u4E0A\u65B9\u641C\u5C0B\u6B04\u67E5\u627E"))))), activeTab === 'import' && React.createElement("div", {
    className: "fade-in max-w-6xl mx-auto space-y-8 pb-20"
  }, React.createElement("header", {
    className: "flex flex-col md:flex-row md:items-start justify-between gap-3"
  }, React.createElement("h2", {
    className: "text-2xl font-bold"
  }, "\u8CC7\u6599\u5EAB\u8207\u5831\u540D\u7BA1\u7406"), React.createElement("div", {
    className: "w-full md:w-auto flex flex-col items-start md:items-end gap-2"
  }, React.createElement("div", {
    className: "flex items-center gap-2 text-xs"
  }, React.createElement("div", {
    className: "text-slate-400 bg-slate-100 px-2 py-1 rounded"
  }, "\u4F86\u6E90: ", dbSource), React.createElement("div", {
    className: "text-slate-400 bg-slate-100 px-2 py-1 rounded"
	  }, "Build: ", APP_BUILD), React.createElement("select", {
    className: "text-xs p-1.5 border rounded",
    onChange: e => handleDbSourceChange(e.target.value),
    value: dbSource
  }, React.createElement("option", {
    value: "crm-system-v1"
  }, "v1 (\u60A8\u7684\u771F\u5BE6\u8CC7\u6599)"), React.createElement("option", {
    value: "default-app-id"
  }, "Default (\u820A\u7248\u6E2C\u8A66)"))), React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, React.createElement("button", {
    onClick: () => setShowGlobalRules(true),
    className: "bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 hover:bg-indigo-700 shadow-sm whitespace-nowrap"
  }, React.createElement(Icon, {
    name: "settings",
    size: 14
  }), " \u9810\u8A2D\u72C0\u614B\u898F\u5247"), React.createElement("button", {
    onClick: () => setShowTagSettings(true),
    className: "bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 hover:bg-emerald-700 shadow-sm whitespace-nowrap"
  }, React.createElement(Icon, {
    name: "tag",
    size: 14
  }), " \u6D3B\u52D5\u6A19\u7C64\u8A2D\u5B9A"), React.createElement("button", {
    onClick: () => setShowMascotSettings(true),
    className: "bg-pink-600 text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 hover:bg-pink-700 shadow-sm whitespace-nowrap"
  }, React.createElement(Icon, {
    name: "smile",
    size: 14
  }), " \u5409\u7965\u7269\u8A2D\u5B9A"), React.createElement("button", {
    onClick: () => setShowOutingPosterSettings(true),
    className: "bg-amber-600 text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 hover:bg-amber-700 shadow-sm whitespace-nowrap"
  }, React.createElement(Icon, {
    name: "image",
    size: 14
	  }), " \u5916\u51FA\u5834\u520A\u8A2D\u5B9A"), React.createElement("button", {
    onClick: handleFirebaseHealthCheck,
    disabled: isHealthChecking,
    className: `text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 shadow-sm whitespace-nowrap ${isHealthChecking ? 'bg-sky-400 cursor-not-allowed' : 'bg-sky-600 hover:bg-sky-700'}`
  }, React.createElement(Icon, {
    name: isHealthChecking ? "loader-2" : "activity",
    className: isHealthChecking ? "animate-spin" : "",
    size: 14
  }), " Firebase \u5065\u5EB7\u6AA2\u67E5")))), React.createElement("div", {
    className: `rounded-xl border px-4 py-3 text-sm ${firebaseHealth.status === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' : firebaseHealth.status === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' : firebaseHealth.status === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : firebaseHealth.status === 'checking' ? 'bg-sky-50 border-sky-200 text-sky-700' : 'bg-slate-50 border-slate-200 text-slate-600'}`
  }, React.createElement("div", {
    className: "font-bold mb-1"
  }, "Firebase \u5065\u5EB7\u6AA2\u67E5"), React.createElement("div", null, firebaseHealth.message), firebaseHealth.checkedAt && React.createElement("div", {
    className: "text-xs opacity-75 mt-1"
  }, "\u6AA2\u67E5\u6642\u9593\uFF1A", firebaseHealth.checkedAt)), React.createElement("details", {
    className: "group bg-white p-4 rounded-2xl shadow-sm border border-slate-200 transition-all open:ring-2 open:ring-blue-100"
  }, React.createElement("summary", {
    className: "flex items-center justify-between cursor-pointer list-none select-none"
  }, React.createElement("div", {
    className: "flex items-center gap-3"
  }, React.createElement("div", {
    className: "bg-blue-50 p-2 rounded-lg text-blue-600"
  }, React.createElement(Icon, {
    name: "database",
    size: 20
  })), React.createElement("div", {
    className: "flex flex-col"
  }, React.createElement("span", {
    className: "font-bold text-slate-700 text-sm"
  }, "\u539F\u59CB CSV \u8CC7\u6599\u5EAB"), React.createElement("span", {
    className: "text-xs text-slate-400 font-normal"
  }, "\u9032\u968E\u5168\u91CF\u7DE8\u8F2F\u6A21\u5F0F"))), React.createElement("div", {
    className: "flex items-center gap-2"
  }, React.createElement("span", {
    className: "text-[10px] bg-slate-100 text-slate-500 px-2 py-1 rounded-full group-open:hidden"
  }, "\u5C55\u958B"), React.createElement(Icon, {
    name: "chevron-down",
    size: 18,
    className: "text-slate-400 group-open:rotate-180 transition-transform duration-300"
  }))), React.createElement("div", {
    className: "mt-4 pt-4 border-t border-slate-100 animate-in fade-in slide-in-from-top-2"
  }, React.createElement("textarea", {
    className: "w-full h-80 p-3 font-mono text-xs bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none resize-none leading-relaxed tracking-wide",
    value: csvInput,
    onChange: e => setCsvInput(e.target.value),
    onFocus: () => isEditingRef.current = true,
    onBlur: () => isEditingRef.current = false,
    spellCheck: "false"
  }), React.createElement("div", {
    className: "mt-4 flex flex-col md:flex-row justify-between items-center gap-4"
  }, React.createElement("div", {
    className: "w-full md:w-auto flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200"
  }, React.createElement(Icon, {
    name: "lock",
    size: 14,
    className: "text-slate-400"
  }), React.createElement("span", {
    className: "text-xs font-bold text-slate-600 whitespace-nowrap"
  }, "\u5B89\u5168\u9396"), React.createElement("input", {
    type: "password",
    placeholder: "\u7BA1\u7406\u54E1\u5BC6\u78BC...",
    className: "px-2 py-1.5 border rounded text-xs w-full md:w-32 outline-none focus:border-blue-400 bg-white",
    value: newPasswordInput,
    onChange: e => setNewPasswordInput(e.target.value)
  }), React.createElement("button", {
    onClick: handleUpdatePassword,
    className: `text-xs text-white px-3 py-1.5 rounded transition-colors whitespace-nowrap ${passwordSaveStatus === 'success' ? 'bg-green-500' : 'bg-slate-600 hover:bg-slate-700'}`
  }, passwordSaveStatus === 'success' ? '已更新' : '更新')), React.createElement("div", {
    className: "flex items-center gap-2 w-full md:w-auto"
  }, React.createElement("button", {
    onClick: () => handleSaveCSV(csvInput),
    disabled: isSaving || csvSaveStatus === 'saving',
    className: `flex-1 md:flex-none text-white px-6 py-2.5 rounded-xl flex items-center justify-center gap-2 shadow-md transition-all ${csvSaveStatus === 'success' ? 'bg-green-600 hover:bg-green-700' : csvSaveStatus === 'error' ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-800 hover:bg-slate-900'}`
  }, csvSaveStatus === 'saving' ? React.createElement(Icon, {
    name: "loader-2",
    className: "animate-spin"
  }) : csvSaveStatus === 'success' ? React.createElement(Icon, {
    name: "check"
  }) : React.createElement(Icon, {
    name: "save"
  }), React.createElement("span", null, csvSaveStatus === 'saving' ? '儲存中...' : csvSaveStatus === 'success' ? '✅ 已成功儲存！' : '儲存變更')), csvSaveStatus === 'success' && React.createElement("span", {
    className: "text-xs text-slate-400 hidden md:inline"
  }, "Saved"))), React.createElement("div", {
    className: "mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
  }, React.createElement("div", {
    className: "flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", null, React.createElement("div", {
    className: "text-sm font-bold text-slate-700"
  }, "\u767B\u5165\u5BC6\u78BC\u5C0D\u61C9\u64CD\u4F5C\u4EBA"), React.createElement("div", {
    className: "text-xs text-slate-400 mt-1"
  }, "\u767B\u5165\u5F8C\u6703\u81EA\u52D5\u628A\u64CD\u4F5C\u4EBA\u5E36\u5165\u7248\u672C\u63A7\u5236\u3002\u820A\u7684\u5171\u7528\u5BC6\u78BC\u4ECD\u53EF\u4FDD\u7559\uFF0C\u4E0B\u9762\u9019\u88E1\u5247\u53EF\u4EE5\u70BA\u6BCF\u4F4D\u6210\u54E1\u8A2D\u5B9A\u81EA\u5DF1\u7684\u5BC6\u78BC\u3002")), React.createElement("div", {
    className: "text-xs text-slate-400"
  }, authAccountsSaveStatus === 'saving' && '儲存中...', authAccountsSaveStatus === 'success' && '已更新', authAccountsSaveStatus === 'idle' && `${authAccounts.length} 組對應`)), React.createElement("div", {
    className: "mt-3 space-y-2"
  }, authAccounts.length > 0 ? authAccounts.map(account => React.createElement("div", {
    key: account.id,
    className: "flex flex-col gap-2 rounded-lg border border-slate-200 bg-white px-3 py-3 md:flex-row md:items-center md:justify-between"
  }, React.createElement("div", {
    className: "flex flex-col"
  }, React.createElement("span", {
    className: "text-sm font-bold text-slate-700"
  }, toSafeDisplayText(account.name, DEFAULT_AUTH_ACCOUNT_NAME)), React.createElement("span", {
    className: "text-xs text-slate-400"
  }, "\u5BC6\u78BC\uFF1A", toSafeDisplayText(account.password, ''))), React.createElement("button", {
    onClick: () => handleDeleteAuthAccount(account.id),
    className: "inline-flex items-center justify-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50"
  }, React.createElement(Icon, {
    name: "trash-2",
    size: 13
  }), " \u522A\u9664"))) : React.createElement("div", {
    className: "rounded-lg border border-dashed border-slate-200 bg-white px-3 py-4 text-sm text-slate-400"
  }, "\u76EE\u524D\u53EA\u6709\u5171\u7528\u5BC6\u78BC\uFF0C\u9084\u6C92\u6709\u500B\u4EBA\u767B\u5165\u5C0D\u61C9\u3002")), React.createElement("div", {
    className: "mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]"
  }, React.createElement("input", {
    type: "text",
    placeholder: "\u64CD\u4F5C\u4EBA\u540D\u7A31\uFF0C\u4F8B\u5982 \u90ED\u739F\u5E0C",
    className: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400",
    value: newAuthAccount.name,
    onChange: e => setNewAuthAccount(prev => ({
      ...prev,
      name: e.target.value
    }))
  }), React.createElement("input", {
    type: "password",
    placeholder: "\u5C0D\u61C9\u767B\u5165\u5BC6\u78BC",
    className: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400",
    value: newAuthAccount.password,
    onChange: e => setNewAuthAccount(prev => ({
      ...prev,
      password: e.target.value
    })),
    onKeyDown: e => e.key === 'Enter' && handleAddAuthAccount()
  }), React.createElement("button", {
    onClick: handleAddAuthAccount,
    className: "rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
  }, "\u65B0\u589E\u5C0D\u61C9"))))), React.createElement("div", {
    className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden table-container"
  }, React.createElement("div", {
    className: "p-4 border-b border-slate-100 flex gap-4 sticky left-0"
  }, React.createElement("div", {
    className: "relative flex-1"
  }, React.createElement(Icon, {
    name: "search",
    className: "absolute left-3 top-2.5 text-slate-400",
    size: 18
  }), React.createElement("input", {
    type: "text",
    placeholder: "\u641C\u5C0B\u59D3\u540D\u3001\u6D3B\u52D5\u6216\u65E5\u671F...",
    className: "w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500",
    value: importSearch,
    onChange: e => setImportSearch(e.target.value)
  }))), React.createElement("div", {
    className: "max-h-[600px] overflow-y-auto"
  }, React.createElement("table", {
    className: "w-full text-left text-sm"
  }, React.createElement("thead", {
    className: "bg-slate-50 border-b border-slate-100 text-slate-500 sticky top-0"
  }, React.createElement("tr", null, React.createElement("th", {
    className: "p-2 md:p-4 whitespace-nowrap"
  }, "\u65E5\u671F"), React.createElement("th", {
    className: "p-2 md:p-4 whitespace-nowrap"
  }, "\u6D3B\u52D5"), React.createElement("th", {
    className: "p-2 md:p-4 whitespace-nowrap"
  }, "\u5BA2\u6236"), React.createElement("th", {
    className: "p-4 hidden md:table-cell text-right"
  }, "\u91D1\u984D"), React.createElement("th", {
    className: "p-2 md:p-4 text-right"
  }, "\u64CD\u4F5C"))), React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const filtered = parsedData.filter(r => !importSearch || JSON.stringify(r).toLowerCase().includes(importSearch.toLowerCase()));
    const sorted = filtered.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      if (isNaN(dateA)) return 1;
      if (isNaN(dateB)) return -1;
      const isAFuture = dateA >= today;
      const isBFuture = dateB >= today;
      if (isAFuture && !isBFuture) return -1;
      if (!isAFuture && isBFuture) return 1;
      if (isAFuture) return dateA - dateB;
      return dateB - dateA;
    });
    return sorted.map(row => React.createElement("tr", {
      key: row.id,
      className: "hover:bg-slate-50"
    }, React.createElement("td", {
      className: "p-2 md:p-4 text-slate-600 text-xs md:text-sm whitespace-nowrap"
    }, toSafeDisplayText(row.date, '')), React.createElement("td", {
      className: "p-2 md:p-4 font-medium text-slate-700 text-xs md:text-sm"
    }, toSafeDisplayText(row.eventName, '未命名活動')), React.createElement("td", {
      className: "p-2 md:p-4 text-xs md:text-sm truncate max-w-[80px] md:max-w-none"
    }, toSafeDisplayText(row.customerName, '')), React.createElement("td", {
      className: "p-4 font-mono hidden md:table-cell text-right"
    }, "$", row.price), React.createElement("td", {
      className: "p-2 md:p-4 text-right flex justify-end gap-1 md:gap-2"
    }, React.createElement("button", {
      onClick: () => setEditingRow(row),
      className: "p-2 text-blue-600 hover:bg-blue-50 rounded border border-transparent hover:border-blue-100"
    }, React.createElement(Icon, {
      name: "edit-2",
      size: 16
    })), React.createElement("button", {
      onClick: () => handleDeleteRow(row.id),
      className: "p-2 text-red-400 hover:bg-red-50 rounded hidden md:inline-block"
    }, React.createElement(Icon, {
      name: "trash-2",
      size: 16
    })))));
  })())))), React.createElement("section", {
    className: "mb-8"
  }, React.createElement("h2", {
    className: "text-2xl font-bold mb-4"
  }, "\uD83C\uDFA8 \u524D\u53F0\u4E3B\u984C\u8A2D\u5B9A"), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-4 gap-4 mb-4"
  }, React.createElement("button", {
    onClick: () => handleApplyThemePreset('sunny'),
    className: "bg-amber-500 text-white px-3 py-2 rounded-lg text-sm font-bold hover:bg-amber-600"
  }, "\u5957\u7528 \u6674\u7A7A\u7425\u73C0"), React.createElement("button", {
    onClick: () => handleApplyThemePreset('forest'),
    className: "bg-emerald-600 text-white px-3 py-2 rounded-lg text-sm font-bold hover:bg-emerald-700"
  }, "\u5957\u7528 \u68EE\u6797\u8584\u9727"), React.createElement("button", {
    onClick: () => handleApplyThemePreset('ocean'),
    className: "bg-sky-600 text-white px-3 py-2 rounded-lg text-sm font-bold hover:bg-sky-700"
  }, "\u5957\u7528 \u6D77\u6D0B\u6668\u5149"), React.createElement("button", {
    onClick: () => handleApplyThemePreset('newyear'),
    className: "bg-red-600 text-white px-3 py-2 rounded-lg text-sm font-bold hover:bg-red-700"
  }, "\u5957\u7528 \u65B0\u5E74\u559C\u6176"), React.createElement("button", {
    onClick: () => setPublicTheme(DEFAULT_PUBLIC_THEME),
    className: "bg-slate-700 text-white px-3 py-2 rounded-lg text-sm font-bold hover:bg-slate-800"
  }, "\u9084\u539F\u9810\u8A2D")), React.createElement("div", {
    className: "grid grid-cols-2 md:grid-cols-4 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u80CC\u666F\u4E3B\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.pageBg,
    onChange: e => setPublicTheme({
      ...publicTheme,
      pageBg: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u80CC\u666F\u8F14\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.pageBgAlt,
    onChange: e => setPublicTheme({
      ...publicTheme,
      pageBgAlt: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5361\u7247\u80CC\u666F"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.surfaceBg,
    onChange: e => setPublicTheme({
      ...publicTheme,
      surfaceBg: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5361\u7247\u908A\u6846"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.surfaceBorder,
    onChange: e => setPublicTheme({
      ...publicTheme,
      surfaceBorder: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u6A19\u984C\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.titleColor,
    onChange: e => setPublicTheme({
      ...publicTheme,
      titleColor: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5167\u6587\u5B57\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.textColor,
    onChange: e => setPublicTheme({
      ...publicTheme,
      textColor: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5F37\u8ABF\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    value: publicTheme.accentColor,
    onChange: e => setPublicTheme({
      ...publicTheme,
      accentColor: e.target.value
    })
  }))), React.createElement("div", {
    className: "mt-4 flex justify-end"
  }, React.createElement("button", {
    onClick: handleSavePublicTheme,
    className: "bg-indigo-600 text-white px-6 py-2 rounded-xl hover:bg-indigo-700 shadow-md font-bold"
  }, React.createElement(Icon, {
    name: "save",
    size: 18,
    className: "inline mr-2"
  }), "\u5132\u5B58\u524D\u53F0\u4E3B\u984C")))), React.createElement("section", {
    className: "mb-8"
  }, React.createElement("h2", {
    className: "text-2xl font-bold mb-4"
  }, "\uD83D\uDDBC\uFE0F \u6D3B\u52D5\u5834\u6B21\u8868\u5DE6\u53F3\u88DD\u98FE\u5716"), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4"
  }, React.createElement("p", {
    className: "text-xs text-slate-500"
  }, "\u53EF\u586B\u5716\u7247\u6A94\u540D\uFF08\u4F8B\u5982 `left-newyear.png`\uFF09\u6216\u5B8C\u6574\u7DB2\u5740\u3002\u7A7A\u767D\u5C31\u4E0D\u986F\u793A\u3002\u5716\u7247\u6703\u986F\u793A\u5728\u300C\u6D3B\u52D5\u5834\u6B21\u8868\u300D\u6A19\u984C\u5DE6\u53F3\u5169\u5074\uFF08\u684C\u9762 `xl` \u4EE5\u4E0A\uFF09\u3002"), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5DE6\u5074\u5716\u7247"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    placeholder: "\u4F8B\u5982: left.png \u6216 https://...",
    value: publicSideDecor.leftImage,
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      leftImage: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u53F3\u5074\u5716\u7247"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg text-sm",
    placeholder: "\u4F8B\u5982: right.png \u6216 https://...",
    value: publicSideDecor.rightImage,
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      rightImage: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5716\u7247\u5BEC\u5EA6(px)"), React.createElement("input", {
    type: "number",
    min: "60",
    max: "480",
    className: "w-full p-2 border rounded-lg text-sm",
    value: publicSideDecor.width,
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      width: Number(e.target.value) || 180
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u624B\u6A5F\u5716\u7247\u5BEC\u5EA6(px\uFF0C\u7559\u7A7A=\u540C\u684C\u6A5F)"), React.createElement("input", {
    type: "number",
    min: "40",
    max: "480",
    className: "w-full p-2 border rounded-lg text-sm",
    value: publicSideDecor.mobileWidth || '',
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      mobileWidth: e.target.value === '' ? 0 : Number(e.target.value)
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u4E0A\u4E0B\u8DDD\u96E2(px)"), React.createElement("input", {
    type: "number",
    min: "-300",
    max: "500",
    className: "w-full p-2 border rounded-lg text-sm",
    value: publicSideDecor.offsetY,
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      offsetY: Number(e.target.value) || 0
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5DE6\u53F3\u8DDD\u96E2(px)"), React.createElement("input", {
    type: "number",
    min: "0",
    max: "400",
    className: "w-full p-2 border rounded-lg text-sm",
    value: publicSideDecor.offsetX,
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      offsetX: Number(e.target.value) || 24
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u900F\u660E\u5EA6(0-1)"), React.createElement("input", {
    type: "number",
    min: "0",
    max: "1",
    step: "0.1",
    className: "w-full p-2 border rounded-lg text-sm",
    value: publicSideDecor.opacity,
    onChange: e => setPublicSideDecor({
      ...publicSideDecor,
      opacity: Number(e.target.value)
    })
  }))), React.createElement("div", {
    className: "flex justify-end gap-2"
  }, React.createElement("button", {
    onClick: () => setPublicSideDecor(DEFAULT_PUBLIC_SIDE_DECOR),
    className: "bg-slate-100 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-200 text-sm font-bold"
  }, "\u6E05\u7A7A"), React.createElement("button", {
    onClick: handleSavePublicSideDecor,
    className: "bg-indigo-600 text-white px-6 py-2 rounded-xl hover:bg-indigo-700 shadow-md font-bold"
  }, React.createElement(Icon, {
    name: "save",
    size: 18,
    className: "inline mr-2"
  }), "\u5132\u5B58\u6D3B\u52D5\u5834\u6B21\u8868\u5DE6\u53F3\u5716")))), React.createElement("section", {
    className: "mb-8"
  }, React.createElement("h2", {
    className: "text-2xl font-bold mb-4"
  }, "\uD83D\uDCE2 \u524D\u53F0\u516C\u544A\u8A2D\u5B9A"), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col gap-4"
  }, React.createElement("div", {
    className: "w-full"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8DD1\u99AC\u71C8\u5167\u5BB9"), React.createElement("input", {
    type: "text",
    className: "w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-blue-500",
    placeholder: "\u8F38\u5165\u8981\u986F\u793A\u5728\u9996\u9801\u4E0A\u65B9\u7684\u6700\u65B0\u6D88\u606F...",
    value: latestNews,
    onChange: e => setLatestNews(e.target.value)
  })), React.createElement("div", {
    className: "flex flex-col md:flex-row gap-4 items-end"
  }, React.createElement("div", {
    className: "flex-1"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8DD1\u99AC\u71C8\u5716\u793A (\u50CF\u7D20\u98A8)"), React.createElement("div", {
    className: "relative"
  }, React.createElement("input", {
    type: "text",
    list: "marquee-icon-history",
    className: "w-full p-3 border rounded-xl outline-none bg-white",
    placeholder: "\u8F38\u5165\u65B0\u6A94\u540D\uFF0C\u5132\u5B58\u5F8C\u6703\u81EA\u52D5\u52A0\u5165\u6E05\u55AE...",
    value: marqueeIcon,
    onChange: e => setMarqueeIcon(e.target.value)
  }), React.createElement("datalist", {
    id: "marquee-icon-history"
  }, React.createElement("option", {
    value: "eating.gif"
  }, "\uD83C\uDF54 \u8CAA\u5403\u677E\u9F20"), React.createElement("option", {
    value: "cleaning.gif"
  }, "\uD83E\uDDF9 \u6253\u6383\u677E\u9F20"), React.createElement("option", {
    value: "climbing.gif"
  }, "\uD83E\uDDD7 \u6500\u5CA9\u677E\u9F20"), React.createElement("option", {
    value: "sliding.gif"
  }, "\uD83C\uDFC4 \u6ED1\u884C\u677E\u9F20"), React.createElement("option", {
    value: "milking.gif"
  }, "\uD83E\uDD5B \u559D\u5976\u677E\u9F20"), marqueeIconHistory.map(icon => React.createElement("option", {
    key: icon,
    value: icon
  }, icon))))), React.createElement("div", {
    className: "flex-1"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u6EFE\u52D5\u901F\u5EA6 (", marqueeSpeed, "s)"), React.createElement("input", {
    type: "range",
    min: "5",
    max: "60",
    step: "1",
    className: "w-full h-10",
    value: marqueeSpeed,
    onChange: e => setMarqueeSpeed(Number(e.target.value))
  })), React.createElement("div", {
    className: "w-24"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u80CC\u666F\u984F\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    title: "\u9EDE\u64CA\u958B\u555F\u8ABF\u8272\u76E4\uFF0C\u53EF\u4F7F\u7528\u6EF4\u7BA1",
    value: marqueeBgColor,
    onChange: e => setMarqueeBgColor(e.target.value)
  })), React.createElement("div", {
    className: "w-24"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u6587\u5B57\u984F\u8272"), React.createElement("input", {
    type: "color",
    className: "w-full h-10 p-1 border rounded-xl cursor-pointer",
    title: "\u9EDE\u64CA\u958B\u555F\u8ABF\u8272\u76E4\uFF0C\u53EF\u4F7F\u7528\u6EF4\u7BA1",
    value: marqueeTextColor,
    onChange: e => setMarqueeTextColor(e.target.value)
  })), React.createElement("div", {
    className: "w-24"
  }, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5716\u6848\u5927\u5C0F"), React.createElement("input", {
    type: "number",
    className: "w-full h-10 p-2 border rounded-xl text-center font-bold",
    value: marqueeIconSize,
    onChange: e => setMarqueeIconSize(Number(e.target.value))
  })), React.createElement("button", {
    onClick: async () => {
      if (!user) return alert("請先登入");
      const newHistory = Array.from(new Set([...marqueeIconHistory, marqueeIcon])).filter(Boolean);
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        latestNews: latestNews,
        marqueeSpeed: marqueeSpeed,
        marqueeIcon: marqueeIcon,
        marqueeIconHistory: newHistory,
        marqueeBgColor: marqueeBgColor,
        marqueeTextColor: marqueeTextColor,
        marqueeIconSize: marqueeIconSize
      }, {
        merge: true
      });
      setMarqueeIconHistory(newHistory);
      alert("公告設定已更新並紀錄圖檔名稱！");
    },
    className: "bg-slate-800 text-white px-6 py-3 rounded-xl hover:bg-slate-700 shadow-md font-bold whitespace-nowrap w-full md:w-auto h-[50px]"
  }, React.createElement(Icon, {
    name: "save",
    size: 18,
    className: "inline mr-2"
  }), "\u5132\u5B58\u8A2D\u5B9A")))), React.createElement("section", null, React.createElement("h2", {
    className: "text-2xl font-bold mb-6"
  }, "\u65B0\u589E\u5831\u540D\u8CC7\u6599"), React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4"
  }, React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u65E5\u671F *"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg",
    value: newReg.date,
    onChange: e => setNewReg({
      ...newReg,
      date: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u6D3B\u52D5\u540D\u7A31 *"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    placeholder: "\u4F8B\u5982: \u767B\u5C71\u5718",
    value: newReg.eventName,
    onChange: e => setNewReg({
      ...newReg,
      eventName: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8B1B\u5E2B"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    placeholder: "\u8B1B\u5E2B\u59D3\u540D",
    value: newReg.instructor,
    onChange: e => setNewReg({
      ...newReg,
      instructor: e.target.value
    })
  }))), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5BA2\u6236\u59D3\u540D *"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    placeholder: "\u738B\u5C0F\u660E",
    value: newReg.customerName,
    onChange: e => setNewReg({
      ...newReg,
      customerName: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u91D1\u984D"), React.createElement("input", {
    type: "number",
    className: "w-full p-2 border rounded-lg",
    placeholder: "3000",
    value: newReg.price,
    onChange: e => setNewReg({
      ...newReg,
      price: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u4EA4\u901A\u65B9\u5F0F"), React.createElement("select", {
    className: "w-full p-2 border rounded-lg",
    value: newReg.transport,
    onChange: e => setNewReg({
      ...newReg,
      transport: e.target.value
    })
  }, React.createElement("option", {
    value: ""
  }, "\u672A\u5B9A"), React.createElement("option", {
    value: "\u5171\u4E58"
  }, "\u5171\u4E58"), React.createElement("option", {
    value: "\u81EA\u884C\u524D\u5F80"
  }, "\u81EA\u884C\u524D\u5F80")))), React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-3 gap-4"
  }, React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u8A02\u8CFC\u65E5"), React.createElement("input", {
    type: "date",
    className: "w-full p-2 border rounded-lg",
    value: newReg.orderDate,
    onChange: e => setNewReg({
      ...newReg,
      orderDate: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u5831\u540D\u7BA1\u9053"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    placeholder: "FB, IG...",
    value: newReg.source,
    onChange: e => setNewReg({
      ...newReg,
      source: e.target.value
    })
  })), React.createElement("div", null, React.createElement("label", {
    className: "block text-xs font-bold text-slate-500 mb-1"
  }, "\u624B\u6A5F"), React.createElement("input", {
    type: "text",
    className: "w-full p-2 border rounded-lg",
    placeholder: "09xx...",
    value: newReg.phone,
    onChange: e => setNewReg({
      ...newReg,
      phone: e.target.value
    })
  }))), React.createElement("div", {
    className: "flex justify-end pt-2"
  }, React.createElement("button", {
    onClick: handleAddManualReg,
    disabled: isSaving,
    className: `bg-blue-600 text-white px-6 py-2 rounded-lg flex items-center gap-2 transition-colors ${addRegStatus === 'success' ? 'bg-green-600 hover:bg-green-700' : 'hover:bg-blue-700'}`
  }, isSaving ? React.createElement(Icon, {
    name: "loader-2",
    className: "animate-spin"
  }) : addRegStatus === 'success' ? React.createElement(Icon, {
    name: "check"
  }) : React.createElement(Icon, {
    name: "plus"
  }), addRegStatus === 'success' ? '新增成功！' : '新增一筆報名')))), React.createElement(DataRescueTab, {
    currentAppId: dbSource,
    onSwitch: handleDbSourceChange
  }))), showDebug && React.createElement(DebugPanel, {
    onClose: () => setShowDebug(false)
  }), showCreateEvent && React.createElement("div", {
    className: "fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 fade-in"
  }, React.createElement("div", {
    className: "bg-white rounded-2xl w-full max-w-lg p-6 shadow-2xl m-auto"
  }, React.createElement(CreateEventModal, {
    initialDate: scheduleDate,
    initialInstructors: createEventPrefillInstructors,
    companyRestDates: companyRestDates,
    existingScheduleByDate: calendarOccupancy,
    templatesLoadState: templatesLoadState,
    onRetryTemplatesLoad: handleRetryTemplatesLoad,
    onClose: closeCreateEventModal,
    onSave: handleCreateEvent,
    customTemplates: customTemplates,
    onSaveTemplate: handleSaveTemplate,
    onDeleteTemplate: onDeleteTemplate,
    onReorderTemplates: handleReorderTemplates,
    availableInstructors: Object.keys(stats.instrs).sort(),
    instructorSchedule: instructorSchedule,
    tagDefinitions: tagDefinitions,
    onAddTag: handleAddTagDefinition
  }))), showAddPromise && React.createElement(AddPromiseModal, {
    onClose: () => setShowAddPromise(false),
    onSave: handleAddPromise
  }), showBulkImport && React.createElement(BulkImportModal, {
    onClose: () => setShowBulkImport(false),
    onImport: handleBulkImport,
    existingData: parsedData
  }), showScheduleModal && React.createElement(InstructorScheduleModal, {
    date: scheduleDate,
    availableInstructors: Object.keys(stats.instrs).sort(),
    restingList: instructorSchedule[scheduleDate] || [],
    onClose: () => setShowScheduleModal(false),
    onToggle: handleToggleInstructorRest,
    isCompanyRest: companyRestDates.includes(scheduleDate),
    onToggleCompanyRest: handleToggleCompanyRest,
    isInternalDay: !!(internalDays[scheduleDate] && internalDays[scheduleDate].enabled),
    internalLabel: internalDays[scheduleDate]?.label || '',
    onToggleInternalDay: handleToggleInternalDay,
    onSetInternalLabel: handleSetInternalLabel,
    isOutingDay: !!(outingDays[scheduleDate] && outingDays[scheduleDate].enabled),
    outingPosterFilename: outingDays[scheduleDate]?.posterFilename || '',
    outingPosterOptions: outingPosterConfig,
    outingPeople: outingDays[scheduleDate]?.people || [],
    onToggleOutingDay: handleToggleOutingDay,
    onSetOutingPoster: handleSetOutingPoster,
    onToggleOutingPerson: handleToggleOutingPerson
  }), editingEvent && React.createElement(EventManagerModal, {
    event: activeEditingEvent,
    config: eventConfigs[editingEvent.key],
    onClose: () => setEditingEvent(null),
    onSaveConfig: (cfg, newInstr, newInternalName) => handleSaveEventConfig(editingEvent.key, cfg, newInstr, newInternalName),
    onSaveTemplate: handleSaveTemplate,
    availableInstructors: Object.keys(stats.instrs).sort(),
    instructorSchedule: instructorSchedule,
    onCheckInToggle: handleCheckInToggle,
    onDeleteEvent: handleDeleteEvent,
    globalRules: globalRules,
    onEditCustomer: c => setEditingRow(c),
    tagDefinitions: tagDefinitions,
    onAddTag: handleAddTagDefinition,
    parsedData: parsedData,
    onAddDirectReg: handleAddDirectReg,
    customTemplates: customTemplates,
    adminPasswords: validAdminPasswords
  }), editingProject && React.createElement(ProjectDetailModal, {
    project: editingProject,
    onClose: () => setEditingProject(null),
    onUpdate: handleUpdateProject,
    onDelete: handleDeleteProject
  }), showGlobalRules && React.createElement(GlobalRulesModal, {
    currentRules: globalRules,
    onClose: () => setShowGlobalRules(false),
    onSave: async newRules => {
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        globalRules: normalizeStoredStatusRules(newRules || [])
      }, {
        merge: true
      });
      setShowGlobalRules(false);
    }
  }), showTagSettings && React.createElement(TagSettingsModal, {
    currentDefs: tagDefinitions,
    onClose: () => setShowTagSettings(false),
    onSave: async (newDefs, renameMap = {}) => {
      const normalizedDefs = normalizeTagDefinitionsForDisplay(newDefs);
      const nextConfigs = Object.fromEntries(Object.entries(eventConfigs || {}).map(([key, cfg]) => [key, applyTagRenamesToConfig(cfg, renameMap)]));
      const changedConfigEntries = Object.entries(nextConfigs).filter(([key, cfg]) => JSON.stringify((eventConfigs[key] || {}).tags || {}) !== JSON.stringify(cfg.tags || {}));
      const currentTemplates = Array.isArray(customTemplates) ? customTemplates : [];
      const nextTemplates = currentTemplates.map(tpl => applyTagRenamesToConfig(tpl, renameMap));
      const templatesChanged = JSON.stringify(currentTemplates.map(tpl => tpl.tags || {})) !== JSON.stringify(nextTemplates.map(tpl => tpl.tags || {}));
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        tagDefinitions: normalizedDefs
      }, {
        merge: true
      });
      if (changedConfigEntries.length > 0) {
        await Promise.all(changedConfigEntries.map(([key, cfg]) => setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'event_configs', key), cfg, {
          merge: true
        })));
        setEventConfigs(nextConfigs);
      }
      if (templatesChanged) {
        await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'templates'), {
          list: nextTemplates
        }, {
          merge: true
        });
        setCustomTemplates(nextTemplates);
      }
      setTagDefinitions(normalizedDefs);
      setShowTagSettings(false);
    }
  }), showMascotSettings && React.createElement(MascotSettingsModal, {
    currentList: mascotConfig,
    onClose: () => setShowMascotSettings(false),
    onSave: async newList => {
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        mascotConfig: newList
      }, {
        merge: true
      });
      setShowMascotSettings(false);
    }
  }), showOutingPosterSettings && React.createElement(OutingPosterSettingsModal, {
    currentList: outingPosterConfig,
    onClose: () => setShowOutingPosterSettings(false),
    onSave: async newList => {
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        outingPosterConfig: newList
      }, {
        merge: true
      });
      setShowOutingPosterSettings(false);
    }
  }), showPosterNameSettings && React.createElement(PosterNameOverrideSettingsModal, {
    currentList: posterNameOverrides,
    eventNames: allEventNames,
    onClose: () => setShowPosterNameSettings(false),
    onSave: async newList => {
      const normalizedList = normalizePosterNameOverrides(newList);
      await setDoc(doc(db, `artifacts/${dbSource}/public/data`, 'settings', 'main'), {
        posterNameOverrides: normalizedList
      }, {
        merge: true
      });
      setPosterNameOverrides(normalizedList);
      setShowPosterNameSettings(false);
    }
  }), showPosterActivitySelection && React.createElement(PosterActivitySelectionModal, {
    options: posterActivityOptions,
    selectedNames: posterSelectedNames,
    onToggle: handleTogglePosterSelectedName,
    onSelectAll: () => setPosterSelectedNames(posterActivityOptions.map(option => option.name)),
    onClearAll: () => setPosterSelectedNames([]),
    onClose: resetPosterActivitySelection,
    onConfirm: handleGenerateMonthlyPoster,
    generating: posterGenerating
  }), editingRow && React.createElement(EditRowModal, {
    rowData: editingRow,
    existingTransports: uniqueTransports,
    availableEvents: stats.events,
    onClose: () => setEditingRow(null),
    onSave: handleUpdateRow,
    onDelete: id => {
      handleDeleteRow(id);
      setEditingRow(null);
    }
  }), showExportModal && React.createElement(CalendarExportModal, {
    events: stats.events,
    eventConfigs: eventConfigs,
    instructorSchedule: instructorSchedule,
    companyRestDates: companyRestDates,
    outingDays: outingDays,
    availableInstructors: Object.keys(stats.instrs).sort(),
    posterNameOverrides: posterNameOverrides,
    onClose: () => setShowExportModal(false)
  }), showLoginModal && React.createElement(LoginModal, {
    onClose: () => setShowLoginModal(false),
    onLogin: handleVerifyLogin
  }));
};
try {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(MainApp, null));
} catch (error) {
  document.getElementById('root').innerHTML = '<div style="padding:20px;color:red"><h3>系統載入失敗</h3><p>請檢查 console 錯誤訊息。</p></div>';
  console.error("React Render Error:", error);
}
