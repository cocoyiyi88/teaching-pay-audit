import test from 'node:test';
import assert from 'node:assert/strict';
import { FirebaseRestClient } from '../src/lib/firebase-rest.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('email/password sign-in stores a session and reads data by UID', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
    if (String(url).includes('accounts:signInWithPassword')) {
      return jsonResponse(200, {
        localId: 'user-123',
        email: 'owner@example.com',
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresIn: '3600',
      });
    }
    if (String(url).includes('/salaryAudit/database')) {
      return jsonResponse(404, { error: { status: 'NOT_FOUND', message: 'Not found' } });
    }
    return jsonResponse(200, { name: 'ok' });
  };

  try {
    const client = new FirebaseRestClient({ apiKey: 'test-key', projectId: 'test-project' });
    const session = await client.signIn('OWNER@EXAMPLE.COM', 'secret12');
    const database = await client.fetchDatabase();

    assert.equal(session.uid, 'user-123');
    assert.equal(session.email, 'owner@example.com');
    assert.equal(client.authenticated, true);
    assert.equal(client.user.email, 'owner@example.com');
    assert.equal(database.version, 2);
    assert.match(calls[0].url, /accounts:signInWithPassword/);
    assert.match(calls[1].url, /\/documents\/users\/user-123\/salaryAudit\/database$/);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('month changes and metadata are committed atomically to the account documents', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('accounts:signInWithPassword')) {
      return jsonResponse(200, {
        localId: 'user-456',
        email: 'owner@example.com',
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresIn: '3600',
      });
    }
    if (String(url).endsWith('/documents:commit')) {
      return jsonResponse(200, { commitTime: '2026-08-02T15:00:00.000Z', writeResults: [] });
    }
    return jsonResponse(200, { name: 'ok' });
  };

  try {
    const { createDatabase, createMonth } = await import('../src/lib/database.js');
    const client = new FirebaseRestClient({ apiKey: 'test-key', projectId: 'test-project' });
    await client.signIn('owner@example.com', 'secret12');
    const database = createDatabase();
    database.months['2026-08'] = createMonth('2026-08', 10);
    database.months['2026-08'].entries[1].className = 'English A1';
    database.months['2026-08'].entries[1].hours = 4;
    database.months['2026-08'].isPristine = false;
    database.months['2026-08'].updatedAt = '2026-08-02T15:00:00.000Z';

    database.months['2026-08'].rateUpdatedAt = '2026-08-02T15:00:00.000Z';

    const revision = await client.saveChanges(database, ['2026-08'], { keepalive: true });
    const commitCall = calls.find((call) => call.url.endsWith('/documents:commit'));
    assert.ok(commitCall);
    assert.equal(commitCall.options.keepalive, true);
    const body = JSON.parse(commitCall.options.body);
    assert.equal(body.writes.length, 2);
    const fields = body.writes[0].update.fields;
    assert.equal(fields.rateUpdatedAt, undefined);
    assert.equal(fields.entries.mapValue.fields['1'].mapValue.fields.rateUpdatedAt.stringValue,
      database.months['2026-08'].rateUpdatedAt);
    assert.match(body.writes[0].update.name, /users\/user-456\/salaryAuditMonths\/2026-08$/);
    assert.match(body.writes[1].update.name, /users\/user-456\/salaryAudit\/database$/);
    assert.equal(typeof revision, 'string');
    assert.equal(Number.isFinite(Date.parse(revision)), true);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('account creation and password reset use the correct Firebase endpoints', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body || '' });
    if (String(url).includes('accounts:signUp')) {
      return jsonResponse(200, {
        localId: 'new-user',
        email: 'new@example.com',
        idToken: 'new-token',
        refreshToken: 'new-refresh',
        expiresIn: '3600',
      });
    }
    if (String(url).includes('accounts:sendOobCode')) {
      return jsonResponse(200, { email: 'new@example.com' });
    }
    return jsonResponse(500, { error: { message: 'UNEXPECTED' } });
  };

  try {
    const client = new FirebaseRestClient({ apiKey: 'test-key', projectId: 'test-project' });
    await client.signUp('new@example.com', 'secret12');
    await client.sendPasswordReset('new@example.com');

    assert.match(calls[0].url, /accounts:signUp/);
    assert.match(calls[1].url, /accounts:sendOobCode/);
    assert.equal(JSON.parse(calls[1].body).requestType, 'PASSWORD_RESET');
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('sign out removes the stored session', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  globalThis.fetch = async () => jsonResponse(200, {
    localId: 'user-logout',
    email: 'owner@example.com',
    idToken: 'id-token',
    refreshToken: 'refresh-token',
    expiresIn: '3600',
  });

  try {
    const client = new FirebaseRestClient({ apiKey: 'test-key', projectId: 'test-project' });
    await client.signIn('owner@example.com', 'secret12');
    assert.equal(client.authenticated, true);
    client.signOut();
    assert.equal(client.authenticated, false);
    assert.equal(await client.restoreSession(), null);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('profile name is stored under the signed-in UID and loaded back for personalization', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('accounts:signUp')) {
      return jsonResponse(200, {
        localId: 'profile-user',
        email: 'ipul@example.com',
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresIn: '3600',
      });
    }
    if (String(url).endsWith('/documents:commit')) {
      return jsonResponse(200, { commitTime: '2026-10-06T15:00:00.000Z', writeResults: [] });
    }
    if (String(url).endsWith('/documents/users/profile-user/profile/account')) {
      return jsonResponse(200, {
        fields: {
          displayName: { stringValue: 'Ipul' },
          email: { stringValue: 'ipul@example.com' },
          createdAt: { stringValue: '2026-10-06T14:00:00.000Z' },
          updatedAt: { stringValue: '2026-10-06T15:00:00.000Z' },
        },
      });
    }
    return jsonResponse(500, { error: { message: 'UNEXPECTED' } });
  };

  try {
    const client = new FirebaseRestClient({ apiKey: 'test-key', projectId: 'test-project' });
    await client.signUp('ipul@example.com', 'secret12');
    const saved = await client.saveProfile({
      displayName: '  Ipul  ',
      email: 'ipul@example.com',
      createdAt: '2026-10-06T14:00:00.000Z',
      updatedAt: '2026-10-06T15:00:00.000Z',
    });
    const loaded = await client.fetchProfile();

    assert.equal(saved.displayName, 'Ipul');
    assert.equal(loaded.displayName, 'Ipul');
    assert.equal(loaded.email, 'ipul@example.com');
    const commitCall = calls.find((call) => call.url.endsWith('/documents:commit'));
    const body = JSON.parse(commitCall.options.body);
    assert.match(body.writes[0].update.name, /users\/profile-user\/profile\/account$/);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('change password reauthenticates with the current password and refreshes the session', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body || '' });
    if (String(url).includes('accounts:signInWithPassword')) {
      const body = JSON.parse(options.body || '{}');
      return jsonResponse(200, {
        localId: 'secure-user',
        email: body.email || 'owner@example.com',
        idToken: body.password === 'old-password' ? 'reauth-token' : 'initial-token',
        refreshToken: body.password === 'old-password' ? 'reauth-refresh' : 'initial-refresh',
        expiresIn: '3600',
      });
    }
    if (String(url).includes('accounts:update')) {
      const body = JSON.parse(options.body || '{}');
      assert.equal(body.idToken, 'reauth-token');
      assert.equal(body.password, 'new-password-123');
      return jsonResponse(200, {
        localId: 'secure-user',
        email: 'owner@example.com',
        idToken: 'updated-token',
        refreshToken: 'updated-refresh',
        expiresIn: '3600',
      });
    }
    return jsonResponse(500, { error: { message: 'UNEXPECTED' } });
  };

  try {
    const client = new FirebaseRestClient({ apiKey: 'test-key', projectId: 'test-project' });
    await client.signIn('owner@example.com', 'initial-password');
    const updated = await client.changePassword('old-password', 'new-password-123');

    assert.equal(updated.uid, 'secure-user');
    assert.equal(updated.idToken, 'updated-token');
    assert.equal(client.authenticated, true);
    assert.equal(calls.filter((call) => call.url.includes('accounts:signInWithPassword')).length, 2);
    assert.equal(calls.filter((call) => call.url.includes('accounts:update')).length, 1);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('cloud writes retry a version conflict and send the session only to Firebase', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  const writes = [];
  let reads = 0;
  const stamp = '2026-08-02T15:00:00.000Z';
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'identitytoolkit.googleapis.com') {
      return jsonResponse(200, { localId: 'user-123', idToken: 'id-token', refreshToken: 'refresh-token', expiresIn: '3600' });
    }
    assert.equal(target.hostname, 'firestore.googleapis.com');
    if (target.pathname.endsWith('documents:commit')) {
      writes.push(JSON.parse(options.body).writes);
      return writes.length === 1
        ? jsonResponse(409, { error: { status: 'ABORTED' } })
        : jsonResponse(200, { commitTime: stamp });
    }
    reads += 1;
    return reads === 1 ? jsonResponse(404, {}) : jsonResponse(200, { updateTime: stamp, fields: {} });
  };
  try {
    const client = new FirebaseRestClient({ apiKey: 'k', projectId: 'test-project' });
    await client.signIn('o@example.com', 'secret12');
    await client.saveChanges({ version: 2, settings: {}, months: {} }, []);
    assert.deepEqual(writes[0][0].currentDocument, { exists: false });
    assert.deepEqual(writes[1][0].currentDocument, { updateTime: stamp });
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('a refresh that finishes after logout cannot restore a session', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  globalThis.localStorage.setItem('audit-gaji-firebase-user-session-v3', JSON.stringify({
    uid: 'user-123', email: 'owner@example.com', idToken: 'old', refreshToken: 'refresh', expiresAt: 0,
  }));
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  try {
    const client = new FirebaseRestClient({ apiKey: 'k', projectId: 'test-project' });
    const refreshing = client.connect();
    client.signOut();
    finish(jsonResponse(200, { user_id: 'user-123', id_token: 'new', expires_in: '3600' }));
    await assert.rejects(refreshing, /session changed/);
    assert.equal(client.session, null);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('restoreSession keeps session when offline or refresh hits transient network failure, and deduplicates concurrent refreshes', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.localStorage = new MemoryStorage();
  let refreshCalls = 0;

  globalThis.localStorage.setItem('audit-gaji-firebase-user-session-v3', JSON.stringify({
    uid: 'offline-user',
    email: 'offline@example.com',
    idToken: 'expired-token',
    refreshToken: 'valid-refresh',
    expiresAt: Date.now() - 60_000,
  }));

  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
    const client = new FirebaseRestClient({ apiKey: 'k', projectId: 'test-project' });
    const offlineSession = await client.restoreSession();
    assert.equal(offlineSession?.uid, 'offline-user');
    assert.equal(client.authenticated, true);

    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    globalThis.fetch = async (url) => {
      if (String(url).includes('securetoken.googleapis.com')) {
        refreshCalls += 1;
        throw new Error('network down');
      }
      return jsonResponse(500, {});
    };
    const transientSession = await client.restoreSession();
    assert.equal(transientSession?.uid, 'offline-user');
    assert.equal(client.authenticated, true);

    refreshCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('securetoken.googleapis.com')) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse(200, {
          user_id: 'offline-user',
          id_token: 'fresh-token',
          refresh_token: 'fresh-refresh',
          expires_in: '3600',
        });
      }
      if (String(url).includes('/salaryAudit/database')) {
        return jsonResponse(404, { error: { status: 'NOT_FOUND' } });
      }
      return jsonResponse(200, {});
    };
    await Promise.all([client.fetchRevision(), client.fetchRevision(), client.fetchRevision()]);
    assert.equal(refreshCalls, 1);

    globalThis.localStorage.setItem('audit-gaji-firebase-user-session-v3', JSON.stringify({
      uid: 'offline-user',
      email: 'offline@example.com',
      idToken: 'expired-token',
      refreshToken: 'revoked-refresh',
      expiresAt: Date.now() - 60_000,
    }));
    globalThis.fetch = async () => jsonResponse(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
    const revoked = await client.restoreSession();
    assert.equal(revoked, null);
    assert.equal(client.authenticated, false);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});
