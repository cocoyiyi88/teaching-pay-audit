import { BRAND, BRAND_TITLE } from '../brand.js';
import { calculatePay, summarizeMonth } from './calculations.js';
import { formatMonthKey, getMonthKeysForYear } from './date.js';

function download(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function csvCell(value) {
  const raw = String(value ?? '');
  const text = typeof value === 'string' && (/^[\t\r\n]/.test(raw) || /^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(raw))
    ? "'" + raw
    : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

function hasReportContent(entry) {
  return Number(entry?.hours) > 0 || String(entry?.className || '').trim() || String(entry?.notes || '').trim();
}

function generatedAt() {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

export function exportMonthCsv(month, displayName = 'Teacher') {
  const entries = Object.values(month.entries || {}).filter(hasReportContent).sort((a, b) => Number(a.day) - Number(b.day));
  const rows = [
    [BRAND_TITLE, 'Monthly Teaching Pay Report'],
    ['Prepared for', displayName],
    ['Reporting period', formatMonthKey(month.monthKey)],
    ['Hourly rate (USD)', month.hourlyRate],
    ['Generated on', generatedAt()],
    [],
    ['No.', 'Date', 'Class', 'Hours', 'Hourly Rate (USD)', 'Amount (USD)', 'Notes'],
    ...entries.map((entry, index) => [
      index + 1,
      `${month.monthKey}-${String(entry.day).padStart(2, '0')}`,
      entry.className,
      entry.hours,
      month.hourlyRate,
      calculatePay(entry.hours, month.hourlyRate),
      entry.notes,
    ]),
  ];
  const summary = summarizeMonth(month);
  rows.push([]);
  rows.push(['MONTHLY TOTAL', '', '', summary.totalHours, '', summary.totalPay, `${summary.activeDays} teaching days`]);
  download(csv(rows), 'text/csv;charset=utf-8', `${BRAND.slug}-monthly-${month.monthKey}.csv`);
}

export function exportYearCsv(database, year, displayName = 'Teacher') {
  const rows = [
    [BRAND_TITLE, 'Annual Teaching Pay Report'],
    ['Prepared for', displayName],
    ['Reporting year', year],
    ['Generated on', generatedAt()],
    [],
    ['No.', 'Month', 'Teaching Days', 'Total Hours', 'Average Hours/Day', 'Hourly Rate (USD)', 'Total Pay (USD)'],
  ];
  let totalDays = 0;
  let totalHours = 0;
  let totalPay = 0;
  getMonthKeysForYear(year).forEach((monthKey, index) => {
    const month = database.months[monthKey];
    const summary = month ? summarizeMonth(month) : { activeDays: 0, totalHours: 0, averageHours: 0, totalPay: 0 };
    totalDays += summary.activeDays;
    totalHours += summary.totalHours;
    totalPay += summary.totalPay;
    rows.push([
      index + 1,
      formatMonthKey(monthKey),
      summary.activeDays,
      summary.totalHours,
      summary.averageHours,
      month?.hourlyRate ?? database.settings.defaultHourlyRate,
      summary.totalPay,
    ]);
  });
  rows.push([]);
  rows.push([`TOTAL ${year}`, '', totalDays, Math.round(totalHours * 100) / 100, '', '', Math.round(totalPay * 100) / 100]);
  download(csv(rows), 'text/csv;charset=utf-8', `${BRAND.slug}-annual-${year}.csv`);
}

export function exportBackup(database, profile = {}) {
  download(
    JSON.stringify({
      application: BRAND_TITLE,
      exportedAt: new Date().toISOString(),
      profile: { displayName: String(profile.displayName || ''), email: String(profile.email || '') },
      data: database,
    }, null, 2),
    'application/json',
    `${BRAND.slug}-backup-${new Date().toISOString().slice(0, 10)}.json`,
  );
}

export async function readBackup(file) {
  const parsed = JSON.parse(await file.text());
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}
