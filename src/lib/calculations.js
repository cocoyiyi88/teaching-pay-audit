export function normalizeHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(24, Math.max(0, Math.round(number * 100) / 100));
}

export function calculatePay(hours, rate) {
  const numericHours = Number(hours);
  const safeHours = Number.isFinite(numericHours) ? Math.max(0, numericHours) : 0;
  const numericRate = Number(rate);
  const safeRate = Number.isFinite(numericRate) ? Math.max(0, numericRate) : 0;
  const cents = Math.round(safeHours * 100) * safeRate;
  return Math.round(cents + Number.EPSILON * cents) / 100;
}

export function summarizeMonth(month) {
  const entries = Object.values(month.entries || {});
  const workedEntries = entries.filter((entry) => normalizeHours(entry.hours) > 0);
  const totalHours = Math.round(entries.reduce((total, entry) => total + normalizeHours(entry.hours), 0) * 100) / 100;

  return {
    monthKey: month.monthKey,
    activeDays: workedEntries.length,
    totalHours,
    totalPay: entries.reduce((cents, entry) => cents + Math.round(calculatePay(normalizeHours(entry.hours), month.hourlyRate) * 100), 0) / 100,
    averageHours: workedEntries.length ? Math.round((totalHours / workedEntries.length) * 100) / 100 : 0,
  };
}

export function validateEntry(entry) {
  const hours = normalizeHours(entry.hours);
  if (hours > 0 && !String(entry.className || '').trim()) return 'Class name is required when teaching hours are entered.';
  if (String(entry.className || '').length > 500) return 'Class details must not exceed 500 characters.';
  if (String(entry.notes || '').length > 500) return 'Notes must not exceed 500 characters.';
  return '';
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

export function formatHours(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0);
}
