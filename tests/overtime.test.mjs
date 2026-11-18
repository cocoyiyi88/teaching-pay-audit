import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMonth } from '../src/lib/calculations.js';
import { createDatabase, createMonth, ensureMonth, markMonthEdited, mergeDatabases, sanitizeDatabase } from '../src/lib/database.js';
import { FirebaseRestClient } from '../src/lib/firebase-rest.js';
import { buildMonthReportPdf } from '../src/lib/pdf-report.js';
import { buildMonthXlsxBytes } from '../src/lib/xlsx-export.js';

function latin1(bytes) {
  return new TextDecoder('latin1').decode(bytes);
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

function makeOvertimeMonth(totalHours = 115, { enabled = true, threshold = 100, overtimeRate = 12, baseRate = 10 } = {}) {
  const month = createMonth('2026-11', baseRate, {
    overtimeEnabled: enabled,
    overtimeThresholdHours: threshold,
    overtimeHourlyRate: overtimeRate,
  });
  let remaining = totalHours;
  for (let day = 1; day <= 30 && remaining > 0; day += 1) {
    const hours = Math.min(5, remaining);
    month.entries[day] = { day, className: `Class ${day}`, hours, notes: '' };
    remaining = Math.round((remaining - hours) * 100) / 100;
  }
  return month;
}

test('Option A monthly overtime pays excess hours above threshold at the overtime rate', () => {
  const over = summarizeMonth(makeOvertimeMonth(115));
  assert.equal(over.totalHours, 115);
  assert.equal(over.regularHours, 100);
  assert.equal(over.overtimeHours, 15);
  assert.equal(over.basePay, 1150);
  assert.equal(over.overtimeDeltaRate, 2);
  assert.equal(over.overtimeBonus, 30);
  assert.equal(over.totalPay, 1180);

  const exact = summarizeMonth(makeOvertimeMonth(100));
  assert.equal(exact.overtimeHours, 0);
  assert.equal(exact.overtimeBonus, 0);
  assert.equal(exact.totalPay, 1000);

  const disabled = summarizeMonth(makeOvertimeMonth(115, { enabled: false }));
  assert.equal(disabled.overtimeHours, 0);
  assert.equal(disabled.overtimeBonus, 0);
  assert.equal(disabled.totalPay, 1150);
});

test('database inherits overtime defaults for new months and merges cloud overtime metadata cleanly', () => {
  const db = createDatabase();
  db.settings.overtimeEnabled = true;
  db.settings.overtimeThresholdHours = 100;
  db.settings.overtimeHourlyRate = 12;
  const withMonth = ensureMonth(db, '2026-11');
  assert.equal(withMonth.months['2026-11'].overtimeEnabled, true);
  assert.equal(withMonth.months['2026-11'].overtimeThresholdHours, 100);
  assert.equal(withMonth.months['2026-11'].overtimeHourlyRate, 12);

  // Cloud-encoded month stores overtime metadata inside entries[1] for Firestore rules compatibility.
  const cloudCandidate = {
    months: {
      '2026-11': {
        monthKey: '2026-11',
        hourlyRate: 10,
        isPristine: false,
        updatedAt: '2026-11-18T12:00:00.000Z',
        entries: {
          1: {
            day: 1,
            className: 'Morning',
            hours: 4,
            notes: '',
            overtimeEnabled: true,
            overtimeThresholdHours: 100,
            overtimeHourlyRate: 12,
            overtimeUpdatedAt: '2026-11-18T12:00:00.000Z',
          },
        },
      },
    },
  };
  const sanitized = sanitizeDatabase(cloudCandidate);
  assert.equal(sanitized.months['2026-11'].overtimeEnabled, true);
  assert.equal(sanitized.months['2026-11'].overtimeHourlyRate, 12);

  // Concurrent local day edit + remote overtime update merge without dropping either change.
  const local = sanitizeDatabase(cloudCandidate);
  local.months['2026-11'].overtimeEnabled = false;
  local.months['2026-11'].overtimeUpdatedAt = '2026-11-18T11:00:00.000Z';
  local.months['2026-11'].entries[2] = { day: 2, className: 'Evening', hours: 3, notes: '', updatedAt: '2026-11-18T13:00:00.000Z' };
  const merged = mergeDatabases(local, sanitized);
  assert.equal(merged.months['2026-11'].overtimeEnabled, true);
  assert.equal(merged.months['2026-11'].entries[2].hours, 3);
});

test('cloud commit keeps month top-level keys compatible with live Firestore rules by encoding overtime inside entries[1]', async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = new MemoryStorage();
  let committedBody = null;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('accounts:signInWithPassword')) {
      return jsonResponse(200, { localId: 'uid-ot', idToken: 'id-token', refreshToken: 'ref-token', expiresIn: '3600' });
    }
    if (target.endsWith('/documents:commit')) {
      committedBody = JSON.parse(options.body);
      return jsonResponse(200, {});
    }
    return jsonResponse(404, {});
  };
  try {
    const client = new FirebaseRestClient({ apiKey: 'key', projectId: 'test-project' });
    await client.signIn('teacher@example.com', 'password123');
    const db = createDatabase();
    const month = makeOvertimeMonth(115);
    markMonthEdited(month, { overtime: true });
    db.months['2026-11'] = month;

    await client.saveChanges(db, ['2026-11']);
    const monthWrite = committedBody.writes.find((w) => w.update.name.endsWith('/salaryAuditMonths/2026-11'));
    assert.deepEqual(
      Object.keys(monthWrite.update.fields).sort(),
      ['entries', 'hourlyRate', 'isPristine', 'monthKey', 'updatedAt'],
    );
    const dayOneFields = monthWrite.update.fields.entries.mapValue.fields['1'].mapValue.fields;
    assert.equal(dayOneFields.overtimeEnabled.booleanValue, true);
    assert.equal(Number(dayOneFields.overtimeThresholdHours.integerValue), 100);
    assert.equal(Number(dayOneFields.overtimeHourlyRate.integerValue), 12);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test('PDF and XLSX reports include Option A Base Subtotal, Overtime Adjustment, and live Excel formulas', () => {
  const month = makeOvertimeMonth(115);
  const pdfText = latin1(buildMonthReportPdf(month, 'Ipul', new Date('2026-11-18T12:00:00Z')));
  assert.match(pdfText, /BASE SUBTOTAL/);
  assert.match(pdfText, /OVERTIME ADJUSTMENT/);
  assert.match(pdfText, /\$1,150\.00/);
  assert.match(pdfText, /\+\$30\.00/);
  assert.match(pdfText, /\$1,180\.00/);

  const xlsxText = latin1(buildMonthXlsxBytes(month, 'Ipul', null));
  assert.match(xlsxText, /BASE SUBTOTAL/);
  assert.match(xlsxText, /OVERTIME ADJUSTMENT/);
  assert.match(xlsxText, /MAX\(0,D28-100\)/);
  assert.match(xlsxText, /ROUND\(D29\*E29,2\)/);
  assert.match(xlsxText, /<v>1180<\/v>/);
});
