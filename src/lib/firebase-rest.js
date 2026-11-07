import { createDatabase, sanitizeDatabase } from './database.js';

const SESSION_KEY = 'audit-gaji-firebase-user-session-v3';
const LEGACY_SESSION_KEY = 'audit-gaji-firebase-anonymous-session-v2';
const MAX_MONTHS = 600;
const MAX_MONTH_WRITES_PER_COMMIT = 400;
const EPOCH = '1970-01-01T00:00:00.000Z';
// SuperApp dashboard trigger. Sends only the Firebase ID token; SuperApp re-reads Firestore itself.
const SUPERAPP_SIGNAL_URL = 'https://charisna-superapp.charisna-superapp.workers.dev/connector/signal';

export class FirebaseRestClient {
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
    try {
      return await this.#validSession();
    } catch {
      this.signOut();
      return null;
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
    const allMonthKeys = Object.keys(safeDatabase.months).filter(isMonthKey).sort().slice(-MAX_MONTHS);
    const changedKeys = [...new Set(changedMonthKeys.filter(isMonthKey))]
      .filter((monthKey) => Boolean(safeDatabase.months[monthKey]));
    const revision = new Date().toISOString();
    const chunks = chunk(changedKeys, MAX_MONTH_WRITES_PER_COMMIT);
    if (chunks.length === 0) chunks.push([]);

    const root = this.#userRoot(session.uid);
    for (let index = 0; index < chunks.length; index += 1) {
      const monthKeys = chunks[index];
      const isFinalChunk = index === chunks.length - 1;
      const writes = monthKeys.map((monthKey) => createUpdateWrite(
        this.#documentName(`${root}/salaryAuditMonths/${monthKey}`),
        safeDatabase.months[monthKey],
      ));

      if (isFinalChunk) {
        writes.push(createUpdateWrite(
          this.#documentName(`${root}/salaryAudit/database`),
          {
            settings: safeDatabase.settings,
            monthKeys: allMonthKeys,
            updatedAt: revision,
          },
        ));
      }

      await this.#commit(writes, { keepalive: Boolean(options.keepalive && isFinalChunk) });
    }
    // Only reached after every Firestore commit succeeded.
    this.#notifySuperApp(session, options);
    return revision;
  }

  async saveSettings(settings, monthKeys = [], options = {}) {
    const session = await this.connect();
    const revision = new Date().toISOString();
    const safeMonthKeys = [...new Set(monthKeys.filter(isMonthKey))].sort().slice(-MAX_MONTHS);
    const root = this.#userRoot(session.uid);
    await this.#commit([
      createUpdateWrite(this.#documentName(`${root}/salaryAudit/database`), {
        settings,
        monthKeys: safeMonthKeys,
        updatedAt: revision,
      }),
    ], options);
    this.#notifySuperApp(session, options);
    return revision;
  }

  async saveMonth(month, options = {}) {
    const session = await this.connect();
    if (!month || !isMonthKey(month.monthKey)) throw new Error('The cloud month data is invalid.');
    const root = this.#userRoot(session.uid);
    await this.#commit([
      createUpdateWrite(this.#documentName(`${root}/salaryAuditMonths/${month.monthKey}`), month),
    ], options);
    this.#notifySuperApp(session, options);
  }

  async syncAll(database, options = {}) {
    const monthKeys = Object.keys(database?.months || {}).filter(isMonthKey);
    return this.saveChanges(database, monthKeys, options);
  }

  // Best-effort, fire-and-forget. Never throws and never delays or fails the save; SuperApp Cron is the fallback.
  // pagehide/keepalive delivery is not guaranteed.
  #notifySuperApp(session, options = {}) {
    try {
      if (typeof fetch !== 'function' || !session?.idToken) return;
      fetch(SUPERAPP_SIGNAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: session.idToken }),
        keepalive: Boolean(options.keepalive),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }).catch(() => {});
    } catch {
      // Signal failure must never affect saving.
    }
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

    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
    });
    const data = await response.json();
    if (!response.ok) {
      this.signOut();
      throw new Error(authMessage(data?.error?.message || 'TOKEN_REFRESH_FAILED'));
    }

    const refreshed = {
      ...session,
      uid: data.user_id || session.uid,
      idToken: data.id_token,
      refreshToken: data.refresh_token || session.refreshToken,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
    return this.#storeSession(refreshed);
  }

  #documentName(path) {
    return `projects/${this.projectId}/databases/(default)/documents/${path}`;
  }

  async #commit(writes, options = {}) {
    const session = await this.#validSession();
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
