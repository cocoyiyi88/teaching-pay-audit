import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMonth } from '../src/lib/database.js';
import { buildMonthXlsxBytes } from '../src/lib/xlsx-export.js';
import { buildMonthReportPdf } from '../src/lib/pdf-report.js';

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl5sAAAAASUVORK5CYII=', 'base64'));

function latin1(bytes) { return new TextDecoder('latin1').decode(bytes); }

test('professional Excel export is a real XLSX ZIP with styled sheets and embedded analytics image', () => {
  const month = createMonth('2026-10', 10);
  month.entries[1] = { day: 1, className: 'English A1', hours: 4, notes: 'Morning class' };
  month.entries[2] = { day: 2, className: 'Math', hours: 2, notes: '' };
  const bytes = buildMonthXlsxBytes(month, 'Ipul', ONE_PIXEL_PNG);
  const text = latin1(bytes);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.match(text, /xl\/worksheets\/sheet1\.xml/);
  assert.match(text, /xl\/worksheets\/sheet3\.xml/);
  assert.match(text, /xl\/media\/chart1\.png/);
  assert.match(text, /MONTHLY TOTAL/);
  assert.match(text, /Daily Details/);
  assert.match(text, /Analytics/);
});

test('PDF report embeds the supplied brand mark as a transparent watermark resource', () => {
  const month = createMonth('2026-10', 10);
  month.entries[1] = { day: 1, className: 'English A1', hours: 4, notes: '' };
  const text = latin1(buildMonthReportPdf(month, 'Ipul', new Date('2026-10-07T00:56:00Z')));
  assert.match(text, /\/BrandMark/);
  assert.match(text, /\/Subtype \/Image/);
  assert.match(text, /\/ExtGState/);
  assert.match(text, /Monthly Teaching Pay Report/);
});

test('UI exposes CSV, Excel, PNG, and PDF exports without developer identity text', async () => {
  const app = await readFile(resolve(import.meta.dirname, '..', 'src/app.js'), 'utf8');
  assert.match(app, /export-month-xlsx/);
  assert.match(app, /export-month-png/);
  assert.match(app, /export-year-xlsx/);
  assert.match(app, /export-year-png/);
  assert.match(app, /brand-mark\.png/);
  assert.doesNotMatch(app, /Developed by/i);
});

test('XLSX sanitizes XML control chars, computes full sheet dimensions, and styles every total-row cell', () => {
  const month = createMonth('2026-10', 10);
  month.entries[1] = { day: 1, className: 'English\x0bA1', hours: 4, notes: 'Note\x1fEnd' };
  const bytes = buildMonthXlsxBytes(month, 'Ipul\x00', ONE_PIXEL_PNG);
  const text = latin1(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const xmlFiles = [];
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const dataLen = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const fileName = new TextDecoder('utf8').decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    if (fileName.endsWith('.xml') || fileName.endsWith('.rels')) {
      xmlFiles.push({ fileName, content: new TextDecoder('utf8').decode(bytes.subarray(dataStart, dataStart + dataLen)) });
    }
    pos = dataStart + dataLen;
  }

  assert.ok(xmlFiles.length >= 6);
  for (const { fileName, content } of xmlFiles) {
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content), false, `Illegal XML control char in ${fileName}`);
  }
  assert.match(text, /EnglishA1/);
  assert.match(text, /NoteEnd/);
  assert.match(text, /<dimension ref="A1:F8"\/>/);
  assert.match(text, /<dimension ref="A1:G6"\/>/);
  assert.match(text, /<c r="E6" t="inlineStr" s="9">/);
  assert.match(text, /<c r="G6" t="inlineStr" s="9">/);
});

test('annual PNG canvas highlights Total Pay instead of Hourly Rate', async () => {
  const { buildYearCanvas } = await import('../src/lib/report-image.js');
  const { createDatabase } = await import('../src/lib/database.js');
  const previousDocument = globalThis.document;
  const previousImage = globalThis.Image;
  const drawnTexts = [];

  const fakeCtx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    drawImage() {},
    measureText(value) { return { width: String(value).length * 8 }; },
    fillText(text) {
      drawnTexts.push({ text: String(text), font: this.font, color: this.fillStyle });
    },
  };

  try {
    globalThis.document = {
      createElement() { return { width: 0, height: 0, getContext: () => fakeCtx }; },
    };
    globalThis.Image = class {
      set src(_) { queueMicrotask(() => this.onerror?.(new Error('no image in test'))); }
    };

    const db = createDatabase();
    const jan = createMonth('2026-01', 15);
    jan.entries[1] = { day: 1, className: 'Math', hours: 2, notes: '' };
    db.months['2026-01'] = jan;

    await buildYearCanvas(db, 2026, 'Ipul');
    const janPay = drawnTexts.find((item) => item.text === '$30.00' && item.color === '#172033' && item.font.startsWith('700 15px'));
    const janRate = drawnTexts.find((item) => item.text === '$15.00' && item.font.startsWith('500 15px'));
    assert.ok(janPay);
    assert.ok(janRate);
  } finally {
    globalThis.document = previousDocument;
    globalThis.Image = previousImage;
  }
});
