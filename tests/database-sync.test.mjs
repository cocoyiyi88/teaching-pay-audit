import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMonth, markMonthEdited, mergeDatabases } from '../src/lib/database.js';

test('cloud month data wins over a newly created empty local month', () => {
  const local = createDatabase();
  local.months['2026-08'] = createMonth('2026-08', 10);

  const remote = createDatabase();
  remote.months['2026-08'] = createMonth('2026-08', 10);
  remote.months['2026-08'].entries[1].className = 'English A1';
  remote.months['2026-08'].entries[1].hours = 4;
  remote.months['2026-08'].isPristine = false;
  remote.months['2026-08'].updatedAt = '2026-08-01T10:00:00.000Z';

  const merged = mergeDatabases(local, remote);
  assert.equal(merged.months['2026-08'].entries[1].className, 'English A1');
  assert.equal(merged.months['2026-08'].entries[1].hours, 4);
});

test('an intentionally cleared month wins when it is newer', () => {
  const local = createDatabase();
  local.months['2026-08'] = createMonth('2026-08', 10);
  local.months['2026-08'].isPristine = false;
  local.months['2026-08'].updatedAt = '2026-08-02T10:00:00.000Z';

  const remote = createDatabase();
  remote.months['2026-08'] = createMonth('2026-08', 10);
  remote.months['2026-08'].entries[1].className = 'English A1';
  remote.months['2026-08'].entries[1].hours = 4;
  remote.months['2026-08'].isPristine = false;
  remote.months['2026-08'].updatedAt = '2026-08-01T10:00:00.000Z';

  const merged = mergeDatabases(local, remote);
  assert.equal(merged.months['2026-08'].entries[1].className, '');
  assert.equal(merged.months['2026-08'].entries[1].hours, 0);
});

test('cloud settings are not overwritten by default settings from a new device', () => {
  const local = createDatabase();
  const remote = createDatabase();
  remote.settings.teacherName = 'Ipul';
  remote.settings.defaultHourlyRate = 12;
  remote.settings.isPristine = false;
  remote.settings.updatedAt = '2026-08-01T10:00:00.000Z';

  const merged = mergeDatabases(local, remote);
  assert.equal(merged.settings.teacherName, 'Ipul');
  assert.equal(merged.settings.defaultHourlyRate, 12);
});

test('concurrent edits on different days survive, including an explicit clear', () => {
  const key = '2026-08';
  const baseline = createDatabase();
  baseline.months[key] = createMonth(key, 10);
  baseline.months[key].entries[1].className = 'Old entry';
  markMonthEdited(baseline.months[key], { day: 1 });
  const local = structuredClone(baseline);
  const remote = structuredClone(baseline);
  local.months[key].entries[1].className = '';
  markMonthEdited(local.months[key], { day: 1 });
  remote.months[key].entries[2].className = 'New entry';
  markMonthEdited(remote.months[key], { day: 2 });
  for (const merged of [mergeDatabases(local, remote), mergeDatabases(remote, local)]) {
    assert.equal(merged.months[key].entries[1].className, '');
    assert.equal(merged.months[key].entries[2].className, 'New entry');
  }
});
