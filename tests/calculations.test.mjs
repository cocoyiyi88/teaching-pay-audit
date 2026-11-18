import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePay, summarizeMonth, validateEntry } from '../src/lib/calculations.js';
import { createMonth } from '../src/lib/database.js';

test('calculates daily pay from teaching hours and hourly rate', () => {
  assert.equal(calculatePay(4, 10), 40);
  assert.equal(calculatePay(2.5, 10), 25);
});

test('creates a monthly summary without the removed unique-class metric', () => {
  const month = createMonth('2026-08', 10);
  month.entries[1] = { day: 1, className: 'English A1', hours: 4, notes: '' };
  month.entries[2] = { day: 2, className: 'English A1, English B1', hours: 2.5, notes: '' };
  const summary = summarizeMonth(month);
  assert.equal(summary.activeDays, 2);
  assert.equal(summary.totalHours, 6.5);
  assert.equal(summary.totalPay, 65);
  assert.equal('classCount' in summary, false);
});

test('requires a class name when teaching hours are entered', () => {
  assert.match(validateEntry({ className: '', hours: 4, notes: '' }), /required/i);
  assert.equal(validateEntry({ className: 'English A1', hours: 4, notes: '' }), '');
});

test('creates 29 daily entries for February in a leap year', () => {
  const month = createMonth('2028-02', 10);
  assert.equal(Object.keys(month.entries).length, 29);
});

test('does not cap the monthly pay total at 24 hours', () => {
  const month = createMonth('2026-08', 10);
  month.entries[1].className = 'Class A';
  month.entries[1].hours = 20;
  month.entries[2].className = 'Class B';
  month.entries[2].hours = 20;
  const summary = summarizeMonth(month);
  assert.equal(summary.totalHours, 40);
  assert.equal(summary.totalPay, 400);
});

test('supports multiline class details up to 500 characters', () => {
  const multiline = '17K3 CS 1\n2015 CLC2 CS 1\n3A6 CS 3';
  assert.equal(validateEntry({ className: multiline, hours: 4, notes: '' }), '');
  assert.match(validateEntry({ className: 'A'.repeat(501), hours: 4, notes: '' }), /500 characters/i);
});

test('monthly earnings equal the sum of displayed daily amounts', () => {
  const month = { hourlyRate: 15.50, entries: { 1: { hours: 0.25 }, 2: { hours: 0.25 } } };
  assert.equal(calculatePay(0.25, month.hourlyRate), 3.88);
  assert.equal(summarizeMonth(month).totalPay, 7.76);
});
