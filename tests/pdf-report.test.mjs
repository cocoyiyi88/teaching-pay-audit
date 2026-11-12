import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createMonth } from '../src/lib/database.js';
import {
  buildMonthReportPdf,
  buildYearReportPdf,
  createMonthReportModel,
  createYearReportModel,
} from '../src/lib/pdf-report.js';

function decodePdf(bytes) {
  return new TextDecoder('latin1').decode(bytes);
}

function pageCount(pdfText) {
  return (pdfText.match(/\/Type \/Page\b/g) || []).length;
}

test('monthly report produces a directly downloadable PDF document with accurate data', () => {
  const month = createMonth('2026-08', 10);
  month.entries[1] = {
    day: 1,
    className: '17K3 CS 1\n2015 CLC2 CS 1\n3A6 CS 3',
    hours: 4,
    notes: 'Morning & evening classes',
  };
  month.entries[2] = { day: 2, className: 'Math', hours: 2.5, notes: '' };

  const bytes = buildMonthReportPdf(month, 'Ipul', new Date('2026-08-03T06:16:00Z'));
  const pdf = decodePdf(bytes);

  assert.equal(bytes.slice(0, 8).every((value, index) => value === new TextEncoder().encode('%PDF-1.4')[index]), true);
  assert.match(pdf, /Monthly Teaching Pay Report - August 2026/);
  assert.match(pdf, /Ipul/);
  assert.match(pdf, /17K3 CS 1/);
  assert.match(pdf, /2015 CLC2 CS 1/);
  assert.match(pdf, /\$65\.00/);
  assert.match(pdf, /MONTHLY TOTAL/);
  assert.doesNotMatch(pdf, /Professional PDF Preview|Save as PDF|about:blank/);
  assert.ok(pageCount(pdf) >= 1);
});

test('monthly report model preserves manual line breaks and excludes empty days', () => {
  const month = createMonth('2026-08', 10);
  month.entries[1] = { day: 1, className: 'Class A\nClass B', hours: 4, notes: 'Line 1\nLine 2' };
  const model = createMonthReportModel(month, 'Ipul', new Date('2026-08-03T06:16:00Z'));

  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0].className, 'Class A\nClass B');
  assert.equal(model.entries[0].notes, 'Line 1\nLine 2');
  assert.equal(model.summary.totalHours, 4);
  assert.equal(model.summary.totalPay, 40);
});

test('very long monthly content creates a valid multi-page PDF with repeated page structure', () => {
  const month = createMonth('2026-08', 10);
  for (let day = 1; day <= 25; day += 1) {
    month.entries[day] = {
      day,
      className: `Class ${day}\nAdvanced teaching session with extended lesson description and assessment review`,
      hours: 4,
      notes: 'Detailed notes for attendance, learning objectives, progress, and follow-up activities.',
    };
  }

  const pdf = decodePdf(buildMonthReportPdf(month, 'Ipul', new Date('2026-08-03T06:16:00Z')));
  assert.ok(pageCount(pdf) > 1);
  assert.match(pdf, /Page 1 of/);
  assert.match(pdf, /CONTINUED/);
  assert.match(pdf, /\$1,000\.00/);
});

test('annual report produces one professional landscape PDF with 12 months and correct totals', () => {
  const database = createDatabase();
  database.settings.teacherName = 'Ipul';
  const january = createMonth('2026-01', 10);
  january.entries[1] = { day: 1, className: 'Class A', hours: 4, notes: '' };
  const february = createMonth('2026-02', 12);
  february.entries[3] = { day: 3, className: 'Class B', hours: 2, notes: '' };
  database.months[january.monthKey] = january;
  database.months[february.monthKey] = february;

  const model = createYearReportModel(database, 2026, 'Ipul', new Date('2026-08-03T06:16:00Z'));
  const pdf = decodePdf(buildYearReportPdf(database, 2026, 'Ipul', new Date('2026-08-03T06:16:00Z')));

  assert.equal(model.months.length, 12);
  assert.equal(model.totals.totalPay, 64);
  assert.match(pdf, /Annual Teaching Pay Report - 2026/);
  assert.match(pdf, /January 2026/);
  assert.match(pdf, /December 2026/);
  assert.match(pdf, /TOTAL 2026/);
  assert.match(pdf, /\$64\.00/);
  assert.equal(pageCount(pdf), 1);
  assert.doesNotMatch(pdf, /Unique Class|Professional PDF Preview|Save as PDF/i);
});

test('giant single row spanning more than one page splits cleanly without negative Y coordinates', () => {
  const month = createMonth('2026-08', 10);
  month.entries[1] = {
    day: 1,
    className: Array.from({ length: 80 }, (_, index) => `Session ${index + 1}`).join('\n'),
    hours: 4,
    notes: 'Multi-page entry',
  };

  const pdf = decodePdf(buildMonthReportPdf(month, 'Ipul', new Date('2026-08-03T06:16:00Z')));
  const negativeY = pdf.match(/-\d+(\.\d+)?\s+Tm/g) || [];
  assert.equal(negativeY.length, 0);
  assert.ok(pageCount(pdf) >= 2);
});
