import { createDatabase, mergeDatabases, sanitizeDatabase } from './database.js';

const SESSION_KEY = 'audit-gaji-firebase-user-session-v3';
const LEGACY_SESSION_KEY = 'audit-gaji-firebase-anonymous-session-v2';
const MAX_MONTHS = 600;
const MAX_MONTH_WRITES_PER_COMMIT = 40;
const SUPERAPP_SIGNAL_URL = 'https://zen.charisna-superapp.workers.dev/connector/signal';
const SUPERAPP_KEY_PREFIX = 'mysalary-superapp-key:';
const SUPERAPP_KEY = /^ms1_[A-Za-z0-9_-]{43}$/;
const EPOCH = '1970-01-01T00:00:00.000Z';
const FATAL_REFRESH_ERRORS = new Set([
  'INVALID_REFRESH_TOKEN',
  'TOKEN_EXPIRED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
  'USER_TOKEN_EXPIRED',
]);

export class FirebaseRestClient {
  #refreshPromise = null;
  #sessionGeneration = 0;
  #signalTimer;

  constructor(config) {
    this.apiKey = String(config?.apiKey || '').trim();
    this.projectId = String(config?.projectId || '').trim();
  }

  get configured() {
    return Boolean(this.apiKey && this.projectId);
  }

  get session() {
    try {
      return normalizeSession(JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'));
    } catch {
      return null;
    }
  }

  get authenticated() {
    return Boolean(this.configured && this.session?.uid && this.session?.refreshToken);
  }

  get connected() {
    return this.authenticated;
  }

  get user() {
    const session = this.session;
    return session ? { uid: session.uid, email: session.email || '' } : null;
  }

  async restoreSession() {
    if (!this.configured) return null;
    const session = this.session;
    if (!session) return null;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return session;
    try {
      return await this.#validSession();
    } catch (error) {
      const current = this.session;
      return error?.fatal || current?.uid !== session.uid ? null : current;
    }
  }

  async signIn(email, password) {
    this.#assertConfigured();
    const credentials = validateCredentials(email, password);
    const data = await this.#authRequest('accounts:signInWithPassword', {
      email: credentials.email,
      password: credentials.password,
      returnSecureToken: true,
    });
    return this.#storeSession(createSession(data, credentials.email));
  }

  async signUp(email, password) {
    this.#assertConfigured();
    const credentials = validateCredentials(email, password);
    const data = await this.#authRequest('accounts:signUp', {
      email: credentials.email,
      password: credentials.password,
      returnSecureToken: true,
    });
    return this.#storeSession(createSession(data, credentials.email));
  }

  async sendPasswordReset(email) {
    this.#assertConfigured();
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) throw new Error('Enter a valid email address.');
    await this.#authRequest('accounts:sendOobCode', {
      requestType: 'PASSWORD_RESET',
      email: normalizedEmail,
    });
    return normalizedEmail;
  }

  async changePassword(currentPassword, newPassword) {
    this.#assertConfigured();
    const session = await this.#validSession();
    const email = normalizeEmail(session.email || '');
    const current = String(currentPassword || '');
    const next = String(newPassword || '');

    if (!email) throw new Error('Your signed-in account does not have a valid email address.');
    if (!current) throw new Error('Enter your current password.');
    if (next.length < 8) throw new Error('Use at least 8 characters for your new password.');
    if (current === next) throw new Error('Choose a new password that is different from your current password.');

    const verified = await this.#authRequest('accounts:signInWithPassword', {
      email,
      password: current,
      returnSecureToken: true,
    });
    const verifiedSession = createSession(verified, email);

    const updated = await this.#authRequest('accounts:update', {
      idToken: verifiedSession.idToken,
      password: next,
      returnSecureToken: true,
    });

    const updatedSession = normalizeSession({
      uid: updated.localId || verifiedSession.uid,
      email: updated.email || verifiedSession.email,
      idToken: updated.idToken || verifiedSession.idToken,
      refreshToken: updated.refreshToken || verifiedSession.refreshToken,
      expiresAt: Date.now() + Number(updated.expiresIn || 3600) * 1000,
    });
    if (!updatedSession) throw new Error('The password was updated, but the session could not be refreshed. Sign in again.');
    return this.#storeSession(updatedSession);
  }

  async fetchProfile() {
    const session = await this.connect();
    const root = this.#userRoot(session.uid);
    const document = await this.#firestore(`${root}/profile/account`, { allowNotFound: true });
    if (!document) return null;
    const decoded = decodeMap(document.fields || {});
    return normalizeProfile(decoded, session.email || '');
  }

  async saveProfile(profile) {
    const session = await this.connect();
    const normalized = normalizeProfile(profile, session.email || '');
    if (!normalized) throw new Error('Your profile information is incomplete.');
    const root = this.#userRoot(session.uid);
    await this.#commit([
      createUpdateWrite(this.#documentName(`${root}/profile/account`), normalized),
    ]);
    return normalized;
  }

  signOut() {
    clearTimeout(this.#signalTimer);
    this.#sessionGeneration += 1;
    this.#refreshPromise = null;
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_SESSION_KEY);
    } catch {
      // The sign-in page remains available even if the browser cannot clear site storage.
    }
  }

  async connect() {
    this.#assertConfigured();
    return this.#validSession();
  }

  async fetchDatabase() {
    return (await this.fetchSnapshot()).database;
  }

  async fetchSnapshot() {
    const session = await this.connect();
    const database = createDatabase();
    database.settings.updatedAt = EPOCH;
    const root = this.#userRoot(session.uid);
    const metadata = await this.#firestore(`${root}/salaryAudit/database`, { allowNotFound: true });
    if (!metadata) return { database: sanitizeDatabase(database), revision: EPOCH };

    const decoded = decodeMap(metadata.fields || {});
    if (decoded.settings && typeof decoded.settings === 'object') database.settings = decoded.settings;
    const monthKeys = Array.isArray(decoded.monthKeys)
      ? decoded.monthKeys.filter(isMonthKey).slice(0, MAX_MONTHS)
      : [];

    const documents = await mapWithConcurrency(monthKeys, 6, async (monthKey) => {
      const document = await this.#firestore(`${root}/salaryAuditMonths/${monthKey}`, { allowNotFound: true });
      return document ? [monthKey, decodeMap(document.fields || {})] : null;
    });

    for (const item of documents) {
      if (item) database.months[item[0]] = item[1];
    }

    return {
      database: sanitizeDatabase(database),
      revision: validRevision(decoded.updatedAt),
    };
  }

  async fetchRevision() {
    const session = await this.connect();
    const root = this.#userRoot(session.uid);
    const metadata = await this.#firestore(`${root}/salaryAudit/database`, { allowNotFound: true });
    if (!metadata) return EPOCH;
    return validRevision(decodeMap(metadata.fields || {}).updatedAt);
  }

  async saveChanges(database, changedMonthKeys = [], options = {}) {
    const session = await this.connect();
    const safeDatabase = sanitizeDatabase(database);
    const changedKeys = [...new Set(changedMonthKeys.filter(isMonthKey))]
      .filter((monthKey) => Boolean(safeDatabase.months[monthKey]));
    const chunks = chunk(changedKeys, MAX_MONTH_WRITES_PER_COMMIT);
    if (!chunks.length) chunks.push([]);

    const root = this.#userRoot(session.uid);
    const metadataPath = root + '/salaryAudit/database';
    let revision = EPOCH;
    for (const monthKeys of chunks) {
      for (let attempt = 0; ; attempt += 1) {
        const metadata = await this.#firestore(metadataPath, { allowNotFound: true, uid: session.uid });
        const remoteMetadata = decodeMap(metadata?.fields || {});
        const remoteMonths = await mapWithConcurrency(monthKeys, 6, (key) => (
          this.#firestore(root + '/salaryAuditMonths/' + key, { allowNotFound: true, uid: session.uid })
        ));
        const remote = {
          settings: remoteMetadata.settings,
          months: Object.fromEntries(monthKeys.flatMap((key, index) => (
            remoteMonths[index]?.fields ? [[key, decodeMap(remoteMonths[index].fields)]] : []
          ))),
        };
        const merged = mergeDatabases(safeDatabase, remote);
        const priorKeys = Array.isArray(remoteMetadata.monthKeys) ? remoteMetadata.monthKeys.filter(isMonthKey) : [];
        const index = [...new Set([...priorKeys, ...monthKeys])].sort().slice(-MAX_MONTHS);
        revision = new Date(Math.max(Date.now(), Date.parse(validRevision(remoteMetadata.updatedAt)) + 1)).toISOString();
        const writes = monthKeys.map((key, position) => versionedWrite(
          this.#documentName(root + '/salaryAuditMonths/' + key), encodeMonthForCloud(merged.months[key]), remoteMonths[position],
        ));
        writes.push(versionedWrite(this.#documentName(metadataPath), {
          settings: merged.settings, monthKeys: index, updatedAt: revision,
        }, metadata));

        try {
          await this.#commit(writes, { keepalive: options.keepalive, uid: session.uid });
          break;
        } catch (error) {
          const conflict = ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code);
          if (!conflict || attempt >= 2 || options.keepalive) throw error;
        }
      }
    }
    this.#notifySuperApp(session.uid, options.keepalive);
    return revision;
  }

  async syncAll(database, options = {}) {
    const monthKeys = Object.keys(database?.months || {}).filter(isMonthKey);
    return this.saveChanges(database, monthKeys, options);
  }

  #readSuperAppKey(uid) {
    if (!uid) return '';
    try {
      const key = localStorage.getItem(SUPERAPP_KEY_PREFIX + uid);
      return SUPERAPP_KEY.test(key || '') ? key : '';
    } catch { return ''; }
  }

  get hasSuperAppKey() {
    return Boolean(this.#readSuperAppKey(this.session?.uid));
  }

  setSuperAppKey(value) {
    const uid = this.session?.uid;
    if (!uid) throw new Error('Sign in to manage the SuperApp connection.');
    const key = String(value || '').trim();
    if (key && !SUPERAPP_KEY.test(key)) throw new Error('Paste a valid sync key from CHARISNA SuperApp.');
    clearTimeout(this.#signalTimer);
    if (key) {
      localStorage.setItem(SUPERAPP_KEY_PREFIX + uid, key);
      return this.#notifySuperApp(uid);
    }
    localStorage.removeItem(SUPERAPP_KEY_PREFIX + uid);
    return null;
  }

  #notifySuperApp(uid, keepalive = false, attempt = 0) {
    clearTimeout(this.#signalTimer);
    if (this.session?.uid !== uid) return Promise.resolve({ ok: false, status: 0 });
    const signalKey = this.#readSuperAppKey(uid);
    if (!signalKey) return Promise.resolve({ ok: false, status: 0 });
    return (async () => {
      let retry = false;
      let delay = 10_000;
      let status = 0;
      let ok = false;
      try {
        const response = await fetch(SUPERAPP_SIGNAL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signalKey }),
          keepalive: Boolean(keepalive),
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
        ok = response.ok;
        retry = response.status === 429 || response.status >= 500;
        if (response.status === 429) delay = 15_000;
      } catch { retry = true; }
      if (retry && !keepalive && attempt < 2 && this.session?.uid === uid
        && this.#readSuperAppKey(uid) === signalKey) {
        clearTimeout(this.#signalTimer);
        this.#signalTimer = setTimeout(() => { void this.#notifySuperApp(uid, false, attempt + 1); }, delay);
      }
      return { ok, status };
    })();
  }

  #assertConfigured() {
    if (!this.configured) throw new Error('Firebase configuration is not available.');
  }

  #userRoot(uid) {
    return `users/${uid}`;
  }

  async #authRequest(endpoint, body) {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Firebase-Locale': 'en',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(authMessage(data?.error?.message));
    return data;
  }

  #storeSession(session) {
    this.#sessionGeneration += 1;
    this.#refreshPromise = null;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.removeItem(LEGACY_SESSION_KEY);
    } catch {
      throw new Error('The browser blocked session storage. Allow site storage and try again.');
    }
    return session;
  }

  async #validSession() {
    const session = this.session;
    if (!session) throw new Error('Sign in to access your pay records.');
    if (session.expiresAt - Date.now() > 5 * 60 * 1000) return session;

    if (this.#refreshPromise) return this.#refreshPromise;

    const generation = this.#sessionGeneration;
    const request = (async () => {
      const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      const current = this.session;
      if (generation !== this.#sessionGeneration || current?.uid !== session.uid
        || current.idToken !== session.idToken || current.refreshToken !== session.refreshToken) {
        throw new Error('Your session changed. Please try again.');
      }
      if (!response.ok) {
        const rawCode = String(data?.error?.message || 'TOKEN_REFRESH_FAILED').split(' : ')[0];
        const fatal = FATAL_REFRESH_ERRORS.has(rawCode);
        if (fatal) this.signOut();
        const err = new Error(authMessage(rawCode));
        err.fatal = fatal;
        throw err;
      }

      const refreshed = {
        ...session,
        uid: data.user_id || session.uid,
        idToken: data.id_token,
        refreshToken: data.refresh_token || session.refreshToken,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      };
      return this.#storeSession(refreshed);
    })().finally(() => {
      if (this.#refreshPromise === request) this.#refreshPromise = null;
    });

    this.#refreshPromise = request;
    return request;
  }

  #documentName(path) {
    return `projects/${this.projectId}/databases/(default)/documents/${path}`;
  }

  async #commit(writes, options = {}) {
    const session = await this.#validSession();
    if (options.uid && session.uid !== options.uid) throw new Error('Your session changed. Please try again.');
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents:commit`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
      keepalive: Boolean(options.keepalive),
    });
    const data = await response.json();
    if (!response.ok) throw firebaseError(data, response.status);
    return data;
  }

  async #firestore(path, options = {}) {
    const session = await this.#validSession();
    if (options.uid && session.uid !== options.uid) throw new Error('Your session changed. Please try again.');
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents/${path}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${session.idToken}`,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      keepalive: Boolean(options.keepalive),
    });
    if (response.status === 404 && options.allowNotFound) return null;
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw firebaseError(data, response.status);
    return data;
  }
}

class FirebaseRequestError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'FirebaseRequestError';
    this.code = code;
    this.status = status;
  }
}

function firebaseError(data, status) {
  const code = data?.error?.status || '';
  const rawMessage = data?.error?.message || `Firebase request failed (${status}).`;
  const message = code === 'PERMISSION_DENIED'
    ? 'Firestore access was denied. Confirm that the signed-in-user Security Rules have been published.'
    : rawMessage;
  return new FirebaseRequestError(code, message, status);
}

function createSession(data, fallbackEmail = '') {
  return normalizeSession({
    uid: data.localId,
    email: data.email || fallbackEmail,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  });
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  const uid = String(value.uid || '').trim();
  const idToken = String(value.idToken || '').trim();
  const refreshToken = String(value.refreshToken || '').trim();
  const expiresAt = Number(value.expiresAt || 0);
  if (!uid || !idToken || !refreshToken || !Number.isFinite(expiresAt)) return null;
  return {
    uid,
    email: normalizeEmail(value.email || ''),
    idToken,
    refreshToken,
    expiresAt,
  };
}

function validateCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '');
  if (!isValidEmail(normalizedEmail)) throw new Error('Enter a valid email address.');
  if (normalizedPassword.length < 6) throw new Error('The password must contain at least 6 characters.');
  if (normalizedPassword.length > 4096) throw new Error('The password is too long.');
  return { email: normalizedEmail, password: normalizedPassword };
}

function normalizeProfile(value, fallbackEmail = '') {
  if (!value || typeof value !== 'object') return null;
  const displayName = normalizeDisplayName(value.displayName);
  const email = normalizeEmail(value.email || fallbackEmail);
  const createdAt = validRevision(value.createdAt);
  const updatedAt = validRevision(value.updatedAt);
  if (!displayName || !isValidEmail(email)) return null;
  return { displayName, email, createdAt, updatedAt };
}

export function normalizeDisplayName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function encodeMonthForCloud(month) {
  const {
    rateUpdatedAt,
    overtimeEnabled,
    overtimeThresholdHours,
    overtimeHourlyRate,
    overtimeUpdatedAt,
    ...fields
  } = month;
  const meta = {};
  if (rateUpdatedAt !== undefined) meta.rateUpdatedAt = rateUpdatedAt;
  if (overtimeEnabled || overtimeUpdatedAt !== undefined) {
    meta.overtimeEnabled = Boolean(overtimeEnabled);
    meta.overtimeThresholdHours = Number(overtimeThresholdHours ?? 100);
    meta.overtimeHourlyRate = Number(overtimeHourlyRate ?? 12);
  }
  if (overtimeUpdatedAt !== undefined) meta.overtimeUpdatedAt = overtimeUpdatedAt;
  if (!Object.keys(meta).length) return fields;
  // The existing Firestore rules permit extra metadata inside the entries map.
  fields.entries = {
    ...fields.entries,
    1: { ...fields.entries[1], ...meta },
  };
  return fields;
}

function versionedWrite(name, fields, previous) {
  const write = createUpdateWrite(name, fields);
  write.currentDocument = previous?.updateTime ? { updateTime: previous.updateTime } : { exists: false };
  return write;
}

function createUpdateWrite(documentName, object) {
  return {
    update: {
      name: documentName,
      fields: encodeMap(object),
    },
  };
}

function encodeMap(object) {
  const fields = {};
  for (const [key, value] of Object.entries(object || {})) fields[key] = encodeValue(value);
  return fields;
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeMap(value) } };
  return { stringValue: String(value) };
}

function decodeMap(fields) {
  const object = {};
  for (const [key, value] of Object.entries(fields || {})) object[key] = decodeValue(value);
  return object;
}

function decodeValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return decodeMap(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  return null;
}

function authMessage(code) {
  const normalized = String(code || '').split(' : ')[0];
  const messages = {
    EMAIL_EXISTS: 'This email is already registered. Use Sign In instead.',
    EMAIL_NOT_FOUND: 'This email is not registered.',
    INVALID_EMAIL: 'The email format is invalid.',
    INVALID_PASSWORD: 'The password is incorrect.',
    INVALID_LOGIN_CREDENTIALS: 'The email address or password is incorrect.',
    MISSING_PASSWORD: 'A password is required.',
    WEAK_PASSWORD: 'The password is too weak. Use at least 8 characters.',
    USER_DISABLED: 'This account is disabled in Firebase Authentication.',
    OPERATION_NOT_ALLOWED: 'Email/Password sign-in is not enabled in Firebase Authentication.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a moment and try again.',
    QUOTA_EXCEEDED: 'The Firebase quota has been reached temporarily.',
    TOKEN_EXPIRED: 'Your session has expired. Sign in again.',
    INVALID_REFRESH_TOKEN: 'Your session has expired. Sign in again.',
    USER_NOT_FOUND: 'This account is no longer available. Sign in again.',
    TOKEN_REFRESH_FAILED: 'Your session could not be refreshed. Sign in again.',
  };
  return messages[normalized] || normalized || 'Firebase authentication failed.';
}

function validRevision(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : EPOCH;
}

function isMonthKey(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
