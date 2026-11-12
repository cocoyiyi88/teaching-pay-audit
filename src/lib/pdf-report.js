import { BRAND, BRAND_TITLE } from '../brand.js';
import { calculatePay, formatCurrency, formatHours, summarizeMonth } from './calculations.js';
import { formatMonthKey, getMonthKeysForYear } from './date.js';
import { PdfDocument, PDF_PAGE, downloadPdf, wrapText } from './pdf-core.js';
import { BRAND_MARK_JPEG } from './brand-art.js';

const REPORT_LOCALE = 'en-US';
const COLORS = Object.freeze({
  ink: [0.09, 0.13, 0.22],
  muted: [0.39, 0.44, 0.53],
  line: [0.84, 0.87, 0.92],
  soft: [0.965, 0.973, 0.99],
  primary: [0.20, 0.32, 0.82],
  primaryDark: [0.14, 0.23, 0.63],
  primarySoft: [0.93, 0.95, 1],
  accent: [0.43, 0.36, 0.91],
  success: [0.08, 0.50, 0.36],
  white: [1, 1, 1],
  alternate: [0.985, 0.989, 0.997],
});

const MONTHLY_COLUMNS = Object.freeze([
  { key: 'number', label: 'No.', width: 28, align: 'center' },
  { key: 'date', label: 'Date', width: 34, align: 'center' },
  { key: 'className', label: 'Class', width: 125, align: 'left' },
  { key: 'hours', label: 'Hours', width: 43, align: 'right' },
  { key: 'rate', label: 'Rate', width: 55, align: 'right' },
  { key: 'amount', label: 'Amount', width: 61, align: 'right' },
  { key: 'notes', label: 'Notes', width: 165, align: 'left' },
]);

const YEARLY_COLUMNS = Object.freeze([
  { key: 'number', label: 'No.', width: 34, align: 'center' },
  { key: 'month', label: 'Month', width: 175, align: 'left' },
  { key: 'days', label: 'Teaching Days', width: 105, align: 'right' },
  { key: 'hours', label: 'Total Hours', width: 100, align: 'right' },
  { key: 'average', label: 'Average / Day', width: 108, align: 'right' },
  { key: 'rate', label: 'Hourly Rate', width: 110, align: 'right' },
  { key: 'pay', label: 'Total Pay', width: 126, align: 'right' },
]);

export function exportMonthPdf(month, teacherName) {
  const bytes = buildMonthReportPdf(month, teacherName);
  downloadPdf(bytes, `${BRAND.slug}-monthly-${month.monthKey}.pdf`);
}

export function exportYearPdf(database, year, teacherName = 'Teacher') {
  const bytes = buildYearReportPdf(database, year, teacherName);
  downloadPdf(bytes, `${BRAND.slug}-annual-${year}.pdf`);
}

export function buildMonthReportPdf(month, teacherName, generatedAt = new Date()) {
  const model = createMonthReportModel(month, teacherName, generatedAt);
  const document = new PdfDocument({
    ...PDF_PAGE.A4_PORTRAIT,
    title: `Monthly Teaching Pay Report - ${model.periodLabel}`,
    author: BRAND.appName,
  });
  const brandMark = document.registerJpegImage('BrandMark', BRAND_MARK_JPEG);
  renderMonthReport(document, model, brandMark);
  return document.toUint8Array();
}

export function buildYearReportPdf(database, year, teacherName = 'Teacher', generatedAt = new Date()) {
  const model = createYearReportModel(database, year, teacherName, generatedAt);
  const document = new PdfDocument({
    ...PDF_PAGE.A4_LANDSCAPE,
    title: `Annual Teaching Pay Report - ${year}`,
    author: BRAND.appName,
  });
  const brandMark = document.registerJpegImage('BrandMark', BRAND_MARK_JPEG);
  renderYearReport(document, model, brandMark);
  return document.toUint8Array();
}

export function createMonthReportModel(month, teacherName, generatedAt = new Date()) {
  const summary = summarizeMonth(month);
  const entries = Object.values(month.entries || {})
    .filter(hasReportContent)
    .sort((left, right) => Number(left.day) - Number(right.day))
    .map((entry, index) => ({
      number: String(index + 1),
      date: String(entry.day),
      className: String(entry.className || '-'),
      hours: formatHours(entry.hours),
      rate: formatCurrency(month.hourlyRate),
      amount: formatCurrency(calculatePay(entry.hours, month.hourlyRate)),
      notes: String(entry.notes || '-'),
    }));

  return {
    type: 'monthly',
    teacherName: String(teacherName || 'Teacher'),
    periodLabel: formatMonthKey(month.monthKey),
    monthKey: month.monthKey,
    hourlyRate: month.hourlyRate,
    generatedLabel: formatGeneratedAt(generatedAt),
    entries,
    summary,
  };
}

export function createYearReportModel(database, year, teacherName = 'Teacher', generatedAt = new Date()) {
  const months = getMonthKeysForYear(year).map((monthKey, index) => {
    const month = database.months?.[monthKey];
    const summary = month ? summarizeMonth(month) : emptySummary(monthKey);
    return {
      number: String(index + 1),
      month: formatMonthKey(monthKey),
      days: String(summary.activeDays),
      hours: formatHours(summary.totalHours),
      average: formatHours(summary.averageHours),
      rate: formatCurrency(month?.hourlyRate ?? database.settings?.defaultHourlyRate ?? 10),
      pay: formatCurrency(summary.totalPay),
      summary,
    };
  });
  const totals = months.reduce((accumulator, item) => {
    accumulator.activeDays += item.summary.activeDays;
    accumulator.totalHours += item.summary.totalHours;
    accumulator.totalPay += item.summary.totalPay;
    if (item.summary.totalHours > 0) accumulator.activeMonths += 1;
    return accumulator;
  }, { activeDays: 0, totalHours: 0, totalPay: 0, activeMonths: 0 });
  totals.totalHours = round2(totals.totalHours);
  totals.totalPay = round2(totals.totalPay);
  const bestMonth = months.reduce((best, item) => item.summary.totalPay > best.summary.totalPay ? item : best, months[0]);

  return {
    type: 'annual',
    year,
    teacherName: String(teacherName || database.settings?.teacherName || 'Teacher'),
    generatedLabel: formatGeneratedAt(generatedAt),
    months,
    totals,
    bestMonth,
    averageMonthlyPay: totals.activeMonths ? round2(totals.totalPay / totals.activeMonths) : 0,
  };
}

function renderMonthReport(document, model, brandMark) {
  const margin = 42;
  const footerHeight = 31;
  const bottomLimit = footerHeight + 30;
  const pages = [];
  let page;
  let y;
  let rowIndex = 0;

  const addPage = (continuation = false) => {
    page = document.addPage();
    pages.push(page);
    y = drawReportHeader(page, {
      margin,
      reportType: 'Monthly Teaching Pay Report',
      periodLabel: model.periodLabel,
      continuation,
      brandMark,
    });

    if (!continuation) {
      y = drawMonthlyIntroduction(page, model, margin, y);
    } else {
      page.text('DAILY HOURS AND EARNINGS - CONTINUED', margin, y - 5, { size: 8, bold: true, color: COLORS.primaryDark });
      y -= 21;
    }
    y = drawTableHeader(page, MONTHLY_COLUMNS, margin, y);
  };

  addPage(false);

  if (!model.entries.length) {
    const rowHeight = 42;
    drawEmptyTableRow(page, margin, y, totalWidth(MONTHLY_COLUMNS), rowHeight, 'No teaching activity has been recorded for this period.');
    y -= rowHeight;
  } else {
    for (const entry of model.entries) {
      const layout = layoutMonthlyRow(entry);
      if (y - layout.height >= bottomLimit) {
        drawTableRow(page, MONTHLY_COLUMNS, entry, margin, y, layout.height, rowIndex % 2 === 1, layout.lines);
        y -= layout.height;
      } else {
        addPage(true);
        if (y - layout.height >= bottomLimit) {
          drawTableRow(page, MONTHLY_COLUMNS, entry, margin, y, layout.height, rowIndex % 2 === 1, layout.lines);
          y -= layout.height;
        } else {
          // Row is taller than an entire page; split its wrapped lines cleanly across pages.
          const totalLines = Math.max(layout.lines.className.length, layout.lines.notes.length);
          let cursor = 0;
          while (cursor < totalLines) {
            if (y - 32 < bottomLimit) addPage(true);
            const maxLinesHere = Math.max(1, Math.floor((y - bottomLimit - 12) / layout.lineHeight));
            const nextCursor = Math.min(totalLines, cursor + maxLinesHere);
            const isFirstSlice = cursor === 0;
            const sliceLines = {
              number: isFirstSlice ? layout.lines.number : [''],
              date: isFirstSlice ? layout.lines.date : [''],
              className: layout.lines.className.slice(cursor, nextCursor),
              hours: isFirstSlice ? layout.lines.hours : [''],
              rate: isFirstSlice ? layout.lines.rate : [''],
              amount: isFirstSlice ? layout.lines.amount : [''],
              notes: layout.lines.notes.slice(cursor, nextCursor),
            };
            const sliceCount = Math.max(1, sliceLines.className.length, sliceLines.notes.length);
            const sliceHeight = Math.max(27, 12 + sliceCount * layout.lineHeight);
            drawTableRow(page, MONTHLY_COLUMNS, entry, margin, y, sliceHeight, rowIndex % 2 === 1, sliceLines);
            y -= sliceHeight;
            cursor = nextCursor;
            if (cursor < totalLines) addPage(true);
          }
        }
      }
      rowIndex += 1;
    }
  }

  const totalHeight = 31;
  const signatureHeight = 104;
  if (y - totalHeight - signatureHeight < bottomLimit) addPage(true);
  drawMonthlyTotal(page, model, margin, y, totalHeight);
  y -= totalHeight;
  drawSignatureSection(page, model.teacherName, margin, y - 29);

  pages.forEach((reportPage) => drawWatermark(reportPage, brandMark, { scale: 0.47, opacity: 0.035 }));

  addPageFooters(pages, {
    leftText: BRAND_TITLE,
    rightText: `Generated ${model.generatedLabel}`,
    margin,
  });
}

function renderYearReport(document, model, brandMark) {
  const margin = 42;
  const page = document.addPage();
  let y = drawReportHeader(page, {
    margin,
    reportType: 'Annual Teaching Pay Report',
    periodLabel: String(model.year),
    continuation: false,
    brandMark,
  });

  y = drawAnnualIntroduction(page, model, margin, y);
  y = drawTableHeader(page, YEARLY_COLUMNS, margin, y, 20);

  model.months.forEach((month, index) => {
    const height = 17.5;
    drawTableRow(page, YEARLY_COLUMNS, month, margin, y, height, index % 2 === 1, null, month.summary.totalHours === 0);
    y -= height;
  });

  const totalRow = {
    number: '',
    month: `TOTAL ${model.year}`,
    days: String(model.totals.activeDays),
    hours: formatHours(model.totals.totalHours),
    average: '',
    rate: '',
    pay: formatCurrency(model.totals.totalPay),
  };
  drawTableRow(page, YEARLY_COLUMNS, totalRow, margin, y, 22, false, null, false, true);
  y -= 22;

  drawAnnualInsights(page, model, margin, y - 8);
  drawWatermark(page, brandMark, { scale: 0.42, opacity: 0.035 });
  addPageFooters([page], {
    leftText: BRAND_TITLE,
    rightText: `Generated ${model.generatedLabel}`,
    margin,
  });
}

function drawWatermark(page, brandMark, { scale = 0.47, opacity = 0.065 } = {}) {
  if (!brandMark) return;
  const size = Math.min(page.width, page.height) * scale;
  const x = (page.width - size) / 2;
  const y = (page.height - size) / 2 - 6;
  page.drawImage(brandMark, x, y, size, size, { opacity });
}

function drawReportHeader(page, { margin, reportType, periodLabel, continuation, brandMark }) {
  const top = page.height - 22;
  page.fillRect(0, page.height - 7, page.width, 7, COLORS.primary);

  const markSize = 34;
  const markY = top - markSize - 10;
  page.fillRect(margin, markY, markSize, markSize, COLORS.soft);
  page.strokeRect(margin, markY, markSize, markSize, { color: COLORS.line, lineWidth: 0.7 });
  if (brandMark) page.drawImage(brandMark, margin + 3, markY + 3, markSize - 6, markSize - 6, { opacity: 1 });
  else page.text('M', margin + markSize / 2, markY + 10, { size: 18, bold: true, color: COLORS.primaryDark, align: 'center' });

  const leftX = margin + markSize + 13;
  const rightX = page.width - margin;
  const availableLeft = Math.max(220, page.width * 0.56);
  page.text(BRAND.appName.toUpperCase(), leftX, markY + 25, { size: 7.2, bold: true, color: COLORS.primary });
  page.text(reportType, leftX, markY + 10.5, { size: 14.2, bold: true, color: COLORS.ink, maxWidth: availableLeft });
  page.text('Teaching hours and earnings record', leftX, markY - 1, { size: 7.2, color: COLORS.muted, maxWidth: availableLeft });

  page.text('REPORTING PERIOD', rightX, markY + 24, { size: 6.5, bold: true, color: COLORS.muted, align: 'right' });
  page.text(periodLabel, rightX, markY + 8.5, { size: 13.5, bold: true, color: COLORS.primaryDark, align: 'right', maxWidth: page.width * 0.30 });
  if (continuation) page.text('CONTINUED', rightX, markY - 2, { size: 6.5, bold: true, color: COLORS.accent, align: 'right' });

  const dividerY = markY - 16;
  page.line(margin, dividerY, page.width - margin, dividerY, { color: COLORS.line, lineWidth: 0.8 });
  return dividerY - 20;
}

function drawMonthlyIntroduction(page, model, margin, y) {
  page.text('MONTHLY PAY RECORD', margin, y, { size: 7.2, bold: true, color: COLORS.primary });
  page.text('Daily Teaching Hours and Earnings', margin, y - 21, { size: 18, bold: true, color: COLORS.ink, maxWidth: page.width - margin * 2 });
  page.text('Teaching activity and calculated earnings for the selected reporting period.', margin, y - 38, { size: 8, color: COLORS.muted, maxWidth: page.width - margin * 2 });

  const cardsTop = y - 55;
  drawMetaGrid(page, [
    ['Teacher', model.teacherName],
    ['Reporting Period', model.periodLabel],
    ['Hourly Rate', `${formatCurrency(model.hourlyRate)} / hour`],
    ['Generated On', model.generatedLabel],
  ], margin, cardsTop, page.width - margin * 2);

  const sectionY = cardsTop - 84;
  page.text('TEACHING ACTIVITY DETAILS', margin, sectionY, { size: 7.2, bold: true, color: COLORS.primary });
  page.text('Daily Hours and Earnings', margin, sectionY - 16, { size: 12, bold: true, color: COLORS.ink });
  page.text(`${model.entries.length} ${model.entries.length === 1 ? 'entry' : 'entries'}`, page.width - margin, sectionY - 14, { size: 7.2, bold: true, color: COLORS.primaryDark, align: 'right' });
  return sectionY - 27;
}

function drawMetaGrid(page, items, x, topY, totalWidthValue) {
  const gapX = 9;
  const gapY = 8;
  const cardWidth = (totalWidthValue - gapX) / 2;
  const cardHeight = 32;
  items.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const cardX = x + column * (cardWidth + gapX);
    const cardTop = topY - row * (cardHeight + gapY);
    const cardY = cardTop - cardHeight;
    page.fillRect(cardX, cardY, cardWidth, cardHeight, COLORS.soft);
    page.strokeRect(cardX, cardY, cardWidth, cardHeight, { color: COLORS.line, lineWidth: 0.65 });
    page.text(label.toUpperCase(), cardX + 9, cardY + 20.5, { size: 5.9, bold: true, color: COLORS.muted, maxWidth: cardWidth - 18 });
    const valueLines = wrapText(value, cardWidth - 18, 7.8, true, 1);
    page.text(valueLines[0] || '-', cardX + 9, cardY + 8.5, { size: 7.8, bold: true, color: COLORS.ink, maxWidth: cardWidth - 18 });
  });
}

function drawAnnualIntroduction(page, model, margin, y) {
  page.text('OFFICIAL ANNUAL RECORD', margin, y, { size: 7.2, bold: true, color: COLORS.primary });
  page.text('Annual Teaching Hours and Earnings', margin, y - 20, { size: 17.5, bold: true, color: COLORS.ink });
  page.text('Month-by-month teaching activity and total earnings.', margin, y - 34, { size: 8, color: COLORS.muted });

  const cardsTop = y - 43;
  const bestMonth = model.bestMonth.summary.totalPay > 0
    ? `${model.bestMonth.month} - ${formatCurrency(model.bestMonth.summary.totalPay)}`
    : 'No recorded activity';
  drawMetaCards(page, [
    ['Teacher', model.teacherName],
    ['Reporting Year', String(model.year)],
    ['Highest-Earning Month', bestMonth],
    ['Generated On', model.generatedLabel],
  ], margin, cardsTop, page.width - margin * 2, { cardHeight: 34, labelY: 22, valueY: 9, valueSize: 7.8 });

  const sectionY = cardsTop - 42;
  page.text('MONTHLY OVERVIEW', margin, sectionY, { size: 7.2, bold: true, color: COLORS.primary });
  page.text('Teaching Hours and Earnings by Month', margin, sectionY - 15, { size: 11.5, bold: true, color: COLORS.ink });
  page.text('12 months', page.width - margin, sectionY - 12, { size: 7.2, bold: true, color: COLORS.primaryDark, align: 'right' });
  return sectionY - 24;
}

function drawMetaCards(page, items, x, topY, totalCardWidth, options = {}) {
  const gap = options.gap ?? 8;
  const cardWidth = (totalCardWidth - gap * (items.length - 1)) / items.length;
  const cardHeight = options.cardHeight ?? 45;
  const labelY = options.labelY ?? 30;
  const valueY = options.valueY ?? 16;
  const valueSize = options.valueSize ?? 8.2;
  items.forEach(([label, value], index) => {
    const cardX = x + index * (cardWidth + gap);
    const cardY = topY - cardHeight;
    page.fillRect(cardX, cardY, cardWidth, cardHeight, COLORS.soft);
    page.strokeRect(cardX, cardY, cardWidth, cardHeight, { color: COLORS.line, lineWidth: 0.7 });
    page.text(label.toUpperCase(), cardX + 9, cardY + labelY, { size: 6.1, bold: true, color: COLORS.muted, maxWidth: cardWidth - 18 });
    const valueLines = wrapText(value, cardWidth - 18, valueSize, true, 2);
    valueLines.forEach((line, lineIndex) => page.text(line, cardX + 9, cardY + valueY - lineIndex * (valueSize + 1.2), { size: valueSize, bold: true, color: COLORS.ink, maxWidth: cardWidth - 18 }));
  });
}

function drawTableHeader(page, columns, x, topY, height = 25) {
  const width = totalWidth(columns);
  page.fillRect(x, topY - height, width, height, COLORS.primarySoft);
  page.strokeRect(x, topY - height, width, height, { color: [0.77, 0.82, 1], lineWidth: 0.8 });
  let cursorX = x;
  columns.forEach((column, index) => {
    if (index) page.line(cursorX, topY - height, cursorX, topY, { color: [0.82, 0.86, 0.97], lineWidth: 0.5 });
    drawCellLabel(page, column.label, cursorX, topY, column.width, height, { align: column.align, size: 7, bold: true, color: COLORS.primaryDark, padding: 6 });
    cursorX += column.width;
  });
  return topY - height;
}

function drawTableRow(page, columns, row, x, topY, height, alternate, preparedLines = null, inactive = false, total = false) {
  const width = totalWidth(columns);
  const bottomY = topY - height;
  const background = total ? COLORS.ink : alternate ? COLORS.alternate : COLORS.white;
  page.fillRect(x, bottomY, width, height, background);
  page.strokeRect(x, bottomY, width, height, { color: total ? COLORS.ink : COLORS.line, lineWidth: 0.55 });

  let cursorX = x;
  columns.forEach((column, index) => {
    if (index) page.line(cursorX, bottomY, cursorX, topY, { color: total ? [0.30, 0.35, 0.45] : COLORS.line, lineWidth: 0.45 });
    const value = row[column.key] ?? '';
    const lines = preparedLines?.[column.key] || [String(value)];
    drawTableCell(page, lines, cursorX, topY, column.width, height, {
      align: column.align,
      bold: total || ['date', 'amount', 'month', 'pay'].includes(column.key),
      color: total ? COLORS.white : inactive ? [0.60, 0.64, 0.70] : column.key === 'notes' ? [0.28, 0.33, 0.40] : COLORS.ink,
      size: total ? 8.2 : 7.8,
      padding: 6,
    });
    cursorX += column.width;
  });
}

function drawEmptyTableRow(page, x, topY, width, height, message) {
  const bottomY = topY - height;
  page.fillRect(x, bottomY, width, height, COLORS.alternate);
  page.strokeRect(x, bottomY, width, height, { color: COLORS.line, lineWidth: 0.6 });
  page.text(message, x + width / 2, bottomY + height / 2 - 3, { size: 8.5, color: COLORS.muted, align: 'center' });
}

function drawMonthlyTotal(page, model, x, topY, height) {
  const cells = [
    { width: MONTHLY_COLUMNS[0].width + MONTHLY_COLUMNS[1].width + MONTHLY_COLUMNS[2].width, value: 'MONTHLY TOTAL', align: 'left' },
    { width: MONTHLY_COLUMNS[3].width, value: formatHours(model.summary.totalHours), align: 'right' },
    { width: MONTHLY_COLUMNS[4].width, value: '', align: 'right' },
    { width: MONTHLY_COLUMNS[5].width, value: formatCurrency(model.summary.totalPay), align: 'right' },
    { width: MONTHLY_COLUMNS[6].width, value: '', align: 'left' },
  ];
  const width = cells.reduce((total, cell) => total + cell.width, 0);
  const bottomY = topY - height;
  page.fillRect(x, bottomY, width, height, COLORS.ink);
  let cursorX = x;
  cells.forEach((cell, index) => {
    if (index) page.line(cursorX, bottomY, cursorX, topY, { color: [0.30, 0.35, 0.45], lineWidth: 0.45 });
    drawCellLabel(page, cell.value, cursorX, topY, cell.width, height, { align: cell.align, size: 8.2, bold: true, color: COLORS.white, padding: 7 });
    cursorX += cell.width;
  });
}

function drawSignatureSection(page, teacherName, margin, topY) {
  const availableWidth = page.width - margin * 2;
  const gap = 62;
  const boxWidth = (availableWidth - gap) / 2;
  const lineY = topY - 49;

  page.text('Prepared by', margin + boxWidth / 2, topY, { size: 8, color: COLORS.muted, align: 'center' });
  page.line(margin + 12, lineY, margin + boxWidth - 12, lineY, { color: [0.55, 0.59, 0.66], lineWidth: 0.7 });
  page.text(teacherName || 'Teacher', margin + boxWidth / 2, lineY - 14, { size: 9, bold: true, color: COLORS.ink, align: 'center', maxWidth: boxWidth - 24 });
  page.text('Teacher', margin + boxWidth / 2, lineY - 26, { size: 7.5, color: COLORS.muted, align: 'center' });

  const secondX = margin + boxWidth + gap;
  page.text('Reviewed by', secondX + boxWidth / 2, topY, { size: 8, color: COLORS.muted, align: 'center' });
  page.line(secondX + 12, lineY, secondX + boxWidth - 12, lineY, { color: [0.55, 0.59, 0.66], lineWidth: 0.7 });
  page.text('Reviewer', secondX + boxWidth / 2, lineY - 14, { size: 9, bold: true, color: COLORS.ink, align: 'center' });
}

function drawAnnualInsights(page, model, margin, topY) {
  page.text('ANNUAL ANALYSIS', margin, topY, { size: 6.8, bold: true, color: COLORS.primary });
  page.text('Key Insights', margin, topY - 14, { size: 10.5, bold: true, color: COLORS.ink });

  const gap = 10;
  const totalWidthValue = page.width - margin * 2;
  const cardWidth = (totalWidthValue - gap * 2) / 3;
  const cardHeight = 39;
  const cardTop = topY - 17;
  const bestMonthText = model.bestMonth.summary.totalPay > 0 ? model.bestMonth.month : '-';
  const bestMonthDetail = model.bestMonth.summary.totalPay > 0
    ? `${formatHours(model.bestMonth.summary.totalHours)} hours - ${formatCurrency(model.bestMonth.summary.totalPay)}`
    : 'No teaching activity recorded.';
  const cards = [
    ['Highest-Earning Month', bestMonthText, bestMonthDetail],
    ['Average Monthly Pay', formatCurrency(model.averageMonthlyPay), 'Based on active teaching months.'],
    ['Active Months', `${model.totals.activeMonths} of 12`, 'Months with recorded teaching hours.'],
  ];

  cards.forEach(([label, value, detail], index) => {
    const x = margin + index * (cardWidth + gap);
    const y = cardTop - cardHeight;
    page.fillRect(x, y, cardWidth, cardHeight, COLORS.soft);
    page.strokeRect(x, y, cardWidth, cardHeight, { color: COLORS.line, lineWidth: 0.7 });
    page.text(label.toUpperCase(), x + 9, y + 27, { size: 5.6, bold: true, color: COLORS.muted });
    page.text(value, x + 9, y + 16, { size: 8.5, bold: true, color: COLORS.ink, maxWidth: cardWidth - 18 });
    page.text(detail, x + 9, y + 6, { size: 5.9, color: COLORS.muted, maxWidth: cardWidth - 18 });
  });
}

function addPageFooters(pages, { leftText, rightText, margin }) {
  pages.forEach((page, index) => {
    const lineY = 14;
    page.line(margin, lineY + 10, page.width - margin, lineY + 10, { color: COLORS.line, lineWidth: 0.6 });
    page.text(leftText, margin, lineY, { size: 6.8, color: COLORS.muted });
    page.text(`${rightText}  |  Page ${index + 1} of ${pages.length}`, page.width - margin, lineY, { size: 6.8, color: COLORS.muted, align: 'right' });
  });
}

function layoutMonthlyRow(row) {
  const lineHeight = 7.8 * 1.25;
  const available = Object.fromEntries(MONTHLY_COLUMNS.map((column) => [column.key, Math.max(10, column.width - 12)]));
  const lines = {
    number: [row.number],
    date: [row.date],
    className: wrapText(row.className, available.className, 7.8, false),
    hours: [row.hours],
    rate: [row.rate],
    amount: [row.amount],
    notes: wrapText(row.notes, available.notes, 7.8, false),
  };
  const lineCount = Math.max(...Object.values(lines).map((item) => item.length));
  return { lines, lineHeight, height: Math.max(27, 12 + lineCount * lineHeight) };
}

function drawTableCell(page, lines, x, topY, width, height, { align, bold, color, size, padding }) {
  const lineHeight = size * 1.25;
  const contentHeight = lines.length * lineHeight;
  const startBaseline = topY - Math.max(padding + size, (height - contentHeight) / 2 + size);
  lines.forEach((line, index) => {
    const baseline = startBaseline - index * lineHeight;
    const anchorX = align === 'right' ? x + width - padding : align === 'center' ? x + width / 2 : x + padding;
    page.text(line, anchorX, baseline, { size, bold, color, align, maxWidth: width - padding * 2 });
  });
}

function drawCellLabel(page, value, x, topY, width, height, { align, size, bold, color, padding }) {
  const anchorX = align === 'right' ? x + width - padding : align === 'center' ? x + width / 2 : x + padding;
  const baseline = topY - (height + size) / 2 + 2;
  page.text(value, anchorX, baseline, { size, bold, color, align, maxWidth: width - padding * 2 });
}

function totalWidth(columns) {
  return columns.reduce((total, column) => total + column.width, 0);
}

function hasReportContent(entry) {
  return Number(entry?.hours) > 0 || String(entry?.className || '').trim() || String(entry?.notes || '').trim();
}

function emptySummary(monthKey) {
  return { monthKey, activeDays: 0, totalHours: 0, averageHours: 0, totalPay: 0 };
}

function formatGeneratedAt(date) {
  return new Intl.DateTimeFormat(REPORT_LOCALE, {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
