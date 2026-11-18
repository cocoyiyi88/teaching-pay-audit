import { getDaysInMonth } from './date.js';
import { normalizeHours } from './calculations.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

function timestamp() {
  return new Date().toISOString();
}

export function createEntry(day) {
  return { day, className: '', hours: 0, notes: '' };
}

export function createMonth(monthKey, hourlyRate = 10) {
  const entries = {};
  for (let day = 1; day <= getDaysInMonth(monthKey); day += 1) entries[day] = createEntry(day);
  return {
    monthKey,
    hourlyRate: Math.max(0, Number(hourlyRate) || 0),
    entries,
    isPristine: true,
    updatedAt: EPOCH,
  };
}

export function createDatabase() {
  return {
    version: 2,
    settings: {
      teacherName: '',
      profileNameUpdatedAt: EPOCH,
      defaultHourlyRate: 10,
      isPristine: true,
      updatedAt: EPOCH,
    },
    months: {},
  };
}

export function ensureMonth(database, monthKey) {
  if (database.months[monthKey]) return database;
  return {
    ...database,
    months: {
      ...database.months,
      [monthKey]: createMonth(monthKey, database.settings.defaultHourlyRate),
    },
  };
}

export function sanitizeDatabase(candidate) {
  const fallback = createDatabase();
  if (!candidate || typeof candidate !== 'object') return fallback;

  const rawSettings = candidate.settings && typeof candidate.settings === 'object' ? candidate.settings : {};
  const defaultRate = Number(rawSettings.defaultHourlyRate);
  const teacherName = typeof rawSettings.teacherName === 'string' ? rawSettings.teacherName.slice(0, 100) : '';
  const profileNameUpdatedAt = validTimestamp(rawSettings.profileNameUpdatedAt, EPOCH);
  const safeDefaultRate = Number.isFinite(defaultRate) ? Math.max(0, defaultRate) : 10;
  const database = {
    version: 2,
    settings: {
      teacherName,
      profileNameUpdatedAt,
      defaultHourlyRate: safeDefaultRate,
      isPristine: typeof rawSettings.isPristine === 'boolean'
        ? rawSettings.isPristine
        : teacherName === '' && safeDefaultRate === 10,
      updatedAt: validTimestamp(rawSettings.updatedAt, EPOCH),
    },
    months: {},
  };

  const rawMonths = candidate.months && typeof candidate.months === 'object' ? candidate.months : {};
  for (const [monthKey, rawMonth] of Object.entries(rawMonths)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) || !rawMonth || typeof rawMonth !== 'object') continue;
    const rate = Number(rawMonth.hourlyRate);
    const safeRate = Number.isFinite(rate) ? Math.max(0, rate) : database.settings.defaultHourlyRate;
    const month = createMonth(monthKey, safeRate);
    month.updatedAt = validTimestamp(rawMonth.updatedAt, EPOCH);
    if (typeof rawMonth.rateUpdatedAt === 'string') {
      month.rateUpdatedAt = validTimestamp(rawMonth.rateUpdatedAt, EPOCH);
    }
    const rawEntries = rawMonth.entries && typeof rawMonth.entries === 'object' ? rawMonth.entries : {};
    for (let day = 1; day <= getDaysInMonth(monthKey); day += 1) {
      const source = rawEntries[day];
      if (!source || typeof source !== 'object') continue;
      month.entries[day] = {
        day,
        className: typeof source.className === 'string' ? source.className.slice(0, 500) : '',
        hours: normalizeHours(source.hours),
        notes: typeof source.notes === 'string' ? source.notes.slice(0, 500) : '',
        ...(typeof source.updatedAt === 'string' ? { updatedAt: validTimestamp(source.updatedAt, EPOCH) } : {}),
      };
    }
    month.isPristine = typeof rawMonth.isPristine === 'boolean'
      ? rawMonth.isPristine
      : !monthHasContent(month) && month.hourlyRate === database.settings.defaultHourlyRate;
    database.months[monthKey] = month;
  }
  return database;
}

export function mergeDatabases(local, remote) {
  const safeLocal = sanitizeDatabase(local);
  const safeRemote = sanitizeDatabase(remote);
  const settings = pickNewestMeaningful(safeLocal.settings, safeRemote.settings);
  const months = {};
  const keys = new Set([...Object.keys(safeLocal.months), ...Object.keys(safeRemote.months)]);
  for (const key of keys) {
    const left = safeLocal.months[key];
    const right = safeRemote.months[key];
    if (!left) months[key] = right;
    else if (!right) months[key] = left;
    else months[key] = mergeMonths(left, right);
  }
  return sanitizeDatabase({ version: 2, settings, months });
}

function mergeMonths(left, right) {
  const newest = pickNewestMeaningful(left, right);
  if (left.isPristine || right.isPristine) return newest;

  const leftRateTime = left.rateUpdatedAt ?? left.updatedAt;
  const rightRateTime = right.rateUpdatedAt ?? right.updatedAt;
  const rateWinner = compareTime(rightRateTime, leftRateTime) > 0 ? right : left;
  const entries = {};
  for (const [day, entry] of Object.entries(left.entries)) {
    const incoming = right.entries[day];
    const localTime = entry.updatedAt ?? left.updatedAt;
    const remoteTime = incoming.updatedAt ?? right.updatedAt;
    entries[day] = compareTime(remoteTime, localTime) > 0
      ? { ...incoming, updatedAt: remoteTime }
      : { ...entry, updatedAt: localTime };
  }
  return {
    ...newest,
    entries,
    hourlyRate: rateWinner.hourlyRate,
    rateUpdatedAt: rateWinner.rateUpdatedAt ?? rateWinner.updatedAt,
  };
}

export function markMonthEdited(month, { day, rate = false } = {}) {
  const previous = month.updatedAt;
  const next = new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
  for (const entry of Object.values(month.entries)) {
    if (entry.day === day || (!day && !rate)) entry.updatedAt = next;
    else entry.updatedAt ??= previous;
  }
  month.rateUpdatedAt = rate ? next : month.rateUpdatedAt ?? previous;
  month.isPristine = false;
  month.updatedAt = next;
  return month;
}

export function markSettingsEdited(settings) {
  settings.isPristine = false;
  settings.updatedAt = timestamp();
  return settings;
}

function pickNewestMeaningful(left, right) {
  if (left.isPristine !== right.isPristine) return left.isPristine ? right : left;
  return compareTime(right.updatedAt, left.updatedAt) > 0 ? right : left;
}

function monthHasContent(month) {
  return Object.values(month.entries || {}).some((entry) => (
    Number(entry.hours) > 0
    || String(entry.className || '').trim() !== ''
    || String(entry.notes || '').trim() !== ''
  ));
}

function validTimestamp(value, fallback = EPOCH) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function compareTime(a, b) {
  return Date.parse(a) - Date.parse(b);
}
