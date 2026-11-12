import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfDocument, PDF_PAGE, downloadPdf, measureText, wrapText } from '../src/lib/pdf-core.js';

test('PDF core wraps long words and respects manual line breaks', () => {
  const lines = wrapText('First line\nAveryveryveryverylongwordthatmustwrap', 55, 9);
  assert.equal(lines[0], 'First line');
  assert.ok(lines.length > 2);
  assert.ok(lines.every((line) => measureText(line, 9) <= 55.1));
});

test('PDF core generates a structurally complete PDF with fonts and xref table', () => {
  const document = new PdfDocument({ ...PDF_PAGE.A4_PORTRAIT, title: 'Test PDF' });
  const page = document.addPage();
  page.text('Hello Ipul', 40, 760, { size: 12, bold: true });
  const bytes = document.toUint8Array();
  const pdf = new TextDecoder('latin1').decode(bytes);

  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /\/BaseFont \/Helvetica/);
  assert.match(pdf, /\/BaseFont \/Helvetica-Bold/);
  assert.match(pdf, /xref/);
  assert.match(pdf, /startxref/);
  assert.match(pdf, /Hello Ipul/);
});

test('PDF download uses a real browser download link without a preview popup or print dialog', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let clicked = false;
  let appended = false;
  let removed = false;
  let revoked = false;
  const anchor = {
    style: {},
    click() { clicked = true; },
    remove() { removed = true; },
  };

  try {
    globalThis.document = {
      createElement(tagName) {
        assert.equal(tagName, 'a');
        return anchor;
      },
      body: {
        appendChild(node) {
          assert.equal(node, anchor);
          appended = true;
        },
      },
    };
    globalThis.window = { setTimeout(callback) { callback(); } };
    URL.createObjectURL = () => 'blob:ayesha-salary-test';
    URL.revokeObjectURL = (value) => {
      assert.equal(value, 'blob:ayesha-salary-test');
      revoked = true;
    };

    downloadPdf(new Uint8Array([37, 80, 68, 70]), 'monthly-report.pdf');

    assert.equal(anchor.download, 'monthly-report.pdf');
    assert.equal(anchor.href, 'blob:ayesha-salary-test');
    assert.equal(appended, true);
    assert.equal(clicked, true);
    assert.equal(removed, true);
    assert.equal(revoked, true);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test('PDF core accounts for bold text width and adds ellipsis when maxLines truncates multi-line input', () => {
  assert.ok(measureText('MMMMM', 10, true) > measureText('MMMMM', 10, false));
  const lines = wrapText('Line 1\nLine 2', 200, 10, false, 1);
  assert.deepEqual(lines, ['Line 1...']);
});
