export function normalizeHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(24, Math.max(0, Math.round(number * 100) / 100));
}

export function normalizeOvertimeConfig(source = {}) {
  const enabled = Boolean(source?.overtimeEnabled);
  const rawThreshold = Number(source?.overtimeThresholdHours);
  const thresholdHours = Number.isFinite(rawThreshold)
    ? Math.min(744, Math.max(0, Math.round(rawThreshold * 100) / 100))
    : 100;
  const rawRate = Number(source?.overtimeHourlyRate);
  const overtimeRate = Number.isFinite(rawRate)
    ? Math.max(0, Math.round(rawRate * 100) / 100)
    : 12;
  return { enabled, thresholdHours, overtimeRate };
}

export function calculatePay(hours, rate) {
  const numericHours = Number(hours);
  const safeHours = Number.isFinite(numericHours) ? Math.max(0, numericHours) : 0;
  const numericRate = Number(rate);
  const safeRate = Number.isFinite(numericRate) ? Math.max(0, numericRate) : 0;
  const cents = Math.round(safeHours * 100) * safeRate;
  return Math.round(cents + Number.EPSILON * cents) / 100;
}

export function calculateOvertimeAdjustment(overtimeHours, baseRate, overtimeRate) {
  const numericHours = Number(overtimeHours);
  const safeHours = Number.isFinite(numericHours) ? Math.max(0, numericHours) : 0;
  const safeBase = Number.isFinite(Number(baseRate)) ? Math.max(0, Number(baseRate)) : 0;
  const safeOvertime = Number.isFinite(Number(overtimeRate)) ? Math.max(0, Number(overtimeRate)) : 0;
  const cents = Math.round(safeHours * 100) * (safeOvertime - safeBase);
  return Math.round(cents + Number.EPSILON * cents) / 100;
}

export function summarizeMonth(month) {
  const entries = Object.values(month.entries || {});
  const workedEntries = entries.filter((entry) => normalizeHours(entry.hours) > 0);
  const totalHoursHundredths = entries.reduce((total, entry) => total + Math.round(normalizeHours(entry.hours) * 100), 0);
  const totalHours = totalHoursHundredths / 100;
  const basePayCents = entries.reduce((cents, entry) => cents + Math.round(calculatePay(normalizeHours(entry.hours), month.hourlyRate) * 100), 0);
  const basePay = basePayCents / 100;

  const overtime = normalizeOvertimeConfig(month);
  const thresholdHundredths = Math.round(overtime.thresholdHours * 100);
  const overtimeHoursHundredths = overtime.enabled && totalHoursHundredths > thresholdHundredths
    ? totalHoursHundredths - thresholdHundredths
    : 0;
  const overtimeHours = overtimeHoursHundredths / 100;
  const regularHours = (totalHoursHundredths - overtimeHoursHundredths) / 100;
  const baseRate = Number.isFinite(Number(month.hourlyRate)) ? Math.max(0, Number(month.hourlyRate)) : 0;
  const overtimeDeltaRate = overtime.enabled ? Math.round((overtime.overtimeRate - baseRate) * 100) / 100 : 0;
  const overtimeBonus = overtimeHoursHundredths > 0
    ? calculateOvertimeAdjustment(overtimeHours, baseRate, overtime.overtimeRate)
    : 0;
  const totalPay = Math.max(0, basePayCents + Math.round(overtimeBonus * 100)) / 100;

  return {
    monthKey: month.monthKey,
    activeDays: workedEntries.length,
    totalHours,
    regularHours,
    overtimeEnabled: overtime.enabled,
    overtimeThresholdHours: overtime.thresholdHours,
    overtimeHourlyRate: overtime.overtimeRate,
    overtimeDeltaRate,
    overtimeHours,
    basePay,
    overtimeBonus,
    totalPay,
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
