import { BRAND } from '../brand.js';

const POINTS_PER_MM = 72 / 25.4;
const A4 = Object.freeze({ width: 210 * POINTS_PER_MM, height: 297 * POINTS_PER_MM });

export const PDF_PAGE = Object.freeze({
  A4_PORTRAIT: A4,
  A4_LANDSCAPE: Object.freeze({ width: A4.height, height: A4.width }),
});

const STANDARD_FONT_WIDTHS = Object.freeze({
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
});

const COLORS = Object.freeze({ black: [0, 0, 0], white: [1, 1, 1] });

export class PdfDocument {
  constructor({ width, height, title = 'Document', author = BRAND.appName }) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.author = author;
    this.pages = [];
    this.images = new Map();
  }

  addPage() {
    const page = new PdfPage(this.width, this.height);
    this.pages.push(page);
    return page;
  }

  registerJpegImage(name, { base64, width, height }) {
    const resourceName = sanitizeResourceName(name || `Image${this.images.size + 1}`);
    if (!this.images.has(resourceName)) {
      this.images.set(resourceName, {
        width: Number(width) || 1,
        height: Number(height) || 1,
        bytes: decodeBase64(base64),
      });
    }
    return resourceName;
  }

  toUint8Array() {
    if (!this.pages.length) this.addPage();

    const objects = [];
    const catalogId = 1;
    const pagesId = 2;
    const regularFontId = 3;
    const boldFontId = 4;
    let nextObjectId = 5;

    const imageIds = new Map();
    for (const imageName of this.images.keys()) imageIds.set(imageName, nextObjectId++);

    const opacityValues = [...new Set(this.pages.flatMap((page) => [...page.usedOpacities]))]
      .sort((a, b) => a - b);
    const opacityIds = new Map(opacityValues.map((value) => [value, nextObjectId++]));

    const pageObjectIds = [];
    const contentObjectIds = [];
    for (let index = 0; index < this.pages.length; index += 1) {
      pageObjectIds.push(nextObjectId++);
      contentObjectIds.push(nextObjectId++);
    }
    const infoId = nextObjectId++;

    objects[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${this.pages.length} >>`;
    objects[regularFontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[boldFontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    for (const [imageName, image] of this.images.entries()) {
      const binary = binaryStringFromBytes(image.bytes);
      objects[imageIds.get(imageName)] = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Interpolate true /Length ${image.bytes.length} >>\nstream\n${binary}\nendstream`;
    }

    for (const [opacity, objectId] of opacityIds.entries()) {
      objects[objectId] = `<< /Type /ExtGState /ca ${formatNumber(opacity)} /CA ${formatNumber(opacity)} >>`;
    }

    this.pages.forEach((page, index) => {
      const stream = page.commands.join('\n');
      objects[contentObjectIds[index]] = `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`;

      const imageResources = [...page.usedImages]
        .filter((name) => imageIds.has(name))
        .map((name) => `/${name} ${imageIds.get(name)} 0 R`)
        .join(' ');
      const opacityResources = [...page.usedOpacities]
        .filter((value) => opacityIds.has(value))
        .map((value) => `/${opacityResourceName(value)} ${opacityIds.get(value)} 0 R`)
        .join(' ');
      const xObjectPart = imageResources ? ` /XObject << ${imageResources} >>` : '';
      const extGStatePart = opacityResources ? ` /ExtGState << ${opacityResources} >>` : '';
      objects[pageObjectIds[index]] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${formatNumber(this.width)} ${formatNumber(this.height)}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >>${xObjectPart}${extGStatePart} >> /Contents ${contentObjectIds[index]} 0 R >>`;
    });

    const now = new Date();
    objects[infoId] = `<< /Title (${escapePdfString(this.title)}) /Author (${escapePdfString(this.author)}) /Creator (${escapePdfString(BRAND.appName)}) /Producer (${escapePdfString(`${BRAND.appName} PDF Engine`)}) /CreationDate (D:${formatPdfDate(now)}) >>`;

    let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [0];
    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = byteLength(output);
      output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }

    const xrefOffset = byteLength(output);
    output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    output += `trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return encodeBinaryString(output);
  }
}

export class PdfPage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.commands = [];
    this.usedImages = new Set();
    this.usedOpacities = new Set();
  }

  fillRect(x, y, width, height, color) {
    this.commands.push(`${rgb(color)} rg ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(width)} ${formatNumber(height)} re f`);
  }

  strokeRect(x, y, width, height, { color = COLORS.black, lineWidth = 1 } = {}) {
    this.commands.push(`${rgb(color)} RG ${formatNumber(lineWidth)} w ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(width)} ${formatNumber(height)} re S`);
  }

  line(x1, y1, x2, y2, { color = COLORS.black, lineWidth = 1 } = {}) {
    this.commands.push(`${rgb(color)} RG ${formatNumber(lineWidth)} w ${formatNumber(x1)} ${formatNumber(y1)} m ${formatNumber(x2)} ${formatNumber(y2)} l S`);
  }

  drawImage(imageName, x, y, width, height, { opacity = 1 } = {}) {
    const resourceName = sanitizeResourceName(imageName);
    const alpha = Math.max(0.01, Math.min(1, Number(opacity) || 1));
    this.usedImages.add(resourceName);
    this.usedOpacities.add(alpha);
    this.commands.push(`q /${opacityResourceName(alpha)} gs ${formatNumber(width)} 0 0 ${formatNumber(height)} ${formatNumber(x)} ${formatNumber(y)} cm /${resourceName} Do Q`);
  }

  text(text, x, y, { size = 10, bold = false, color = COLORS.black, align = 'left', maxWidth } = {}) {
    const safeText = normalizePdfText(text);
    const width = measureText(safeText, size, bold);
    let drawX = x;
    if (align === 'right') drawX = x - width;
    else if (align === 'center') drawX = x - width / 2;
    if (Number.isFinite(maxWidth) && width > maxWidth) {
      const clipped = ellipsize(safeText, maxWidth, size, bold);
      return this.text(clipped, x, y, { size, bold, color, align });
    }
    this.commands.push(`BT /${bold ? 'F2' : 'F1'} ${formatNumber(size)} Tf ${rgb(color)} rg 1 0 0 1 ${formatNumber(drawX)} ${formatNumber(y)} Tm (${escapePdfString(safeText)}) Tj ET`);
    return width;
  }

  wrappedText(text, x, topY, maxWidth, { size = 10, bold = false, color = COLORS.black, lineHeight = size * 1.3, maxLines = Infinity, align = 'left' } = {}) {
    const lines = wrapText(text, maxWidth, size, bold, maxLines);
    lines.forEach((line, index) => {
      const anchor = align === 'right' ? x + maxWidth : align === 'center' ? x + maxWidth / 2 : x;
      this.text(line, anchor, topY - size - index * lineHeight, { size, bold, color, align });
    });
    return { lines, height: lines.length * lineHeight };
  }
}

export function mm(value) { return value * POINTS_PER_MM; }

export function measureText(text, size = 10, bold = false) {
  const safeText = normalizePdfText(text);
  const units = [...safeText].reduce((total, character) => {
    const base = STANDARD_FONT_WIDTHS[character] ?? 556;
    const scale = bold && !/[\d .,:-]/.test(character) ? 1.07 : 1;
    return total + base * scale;
  }, 0);
  return (units / 1000) * size;
}

export function wrapText(value, maxWidth, size = 10, bold = false, maxLines = Infinity) {
  const text = normalizePdfText(value).replace(/\r\n?/g, '\n');
  const paragraphs = text.split('\n');
  const lines = [];
  for (let pIndex = 0; pIndex < paragraphs.length; pIndex += 1) {
    const paragraph = paragraphs[pIndex];
    const hasMoreParagraphs = pIndex < paragraphs.length - 1;
    if (!paragraph) {
      lines.push('');
      if (lines.length >= maxLines) {
        return hasMoreParagraphs
          ? truncateLastLine(lines, maxWidth, size, bold, true)
          : lines.slice(0, maxLines);
      }
      continue;
    }
    const words = paragraph.trim().split(/\s+/);
    let line = '';
    for (let wIndex = 0; wIndex < words.length; wIndex += 1) {
      const word = words[wIndex];
      const hasMoreAfterWord = hasMoreParagraphs || wIndex < words.length - 1;
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
      if (line) {
        lines.push(line);
        if (lines.length >= maxLines) return truncateLastLine(lines, maxWidth, size, bold, true);
        line = '';
      }
      if (measureText(word, size, bold) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (let cIndex = 0; cIndex < word.length; cIndex += 1) {
        const character = word[cIndex];
        const candidateChunk = chunk + character;
        if (measureText(candidateChunk, size, bold) <= maxWidth) chunk = candidateChunk;
        else {
          if (chunk) lines.push(chunk);
          if (lines.length >= maxLines) return truncateLastLine(lines, maxWidth, size, bold, hasMoreAfterWord || cIndex < word.length);
          chunk = character;
        }
      }
      line = chunk;
    }
    if (line || !lines.length) lines.push(line);
    if (lines.length >= maxLines) {
      return truncateLastLine(lines.slice(0, maxLines), maxWidth, size, bold, hasMoreParagraphs);
    }
  }
  return lines.length ? lines : [''];
}

export function downloadPdf(bytes, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') throw new Error('PDF download is only available in a browser.');
  const safeName = String(filename || `${BRAND.slug}-report.pdf`).endsWith('.pdf') ? String(filename) : `${filename}.pdf`;
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function truncateLastLine(lines, maxWidth, size, bold, forceEllipsis = false) {
  if (!lines.length) return [''];
  const result = [...lines];
  const last = result[result.length - 1];
  result[result.length - 1] = forceEllipsis
    ? forceEllipsize(last, maxWidth, size, bold)
    : ellipsize(last, maxWidth, size, bold);
  return result;
}

function forceEllipsize(text, maxWidth, size, bold) {
  const ellipsis = '...';
  let result = String(text || '').replace(/\s+$/, '');
  while (result && measureText(`${result}${ellipsis}`, size, bold) > maxWidth) result = result.slice(0, -1);
  return `${result}${ellipsis}`;
}

function ellipsize(text, maxWidth, size, bold) {
  const ellipsis = '...';
  if (measureText(text, size, bold) <= maxWidth) return text;
  let result = text;
  while (result && measureText(`${result}${ellipsis}`, size, bold) > maxWidth) result = result.slice(0, -1);
  return `${result}${ellipsis}`;
}

function normalizePdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\t/g, ' ')
    .replace(/[^\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

function escapePdfString(value) {
  return normalizePdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ');
}

function rgb(color) {
  const [red, green, blue] = color || COLORS.black;
  return `${formatNumber(red)} ${formatNumber(green)} ${formatNumber(blue)}`;
}

function formatNumber(value) { return Number(Number(value).toFixed(3)).toString(); }
function byteLength(value) { return value.length; }

function encodeBinaryString(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function binaryStringFromBytes(bytes) {
  let result = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) result += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return result;
}

function decodeBase64(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  throw new Error('Base64 decoding is unavailable.');
}

function sanitizeResourceName(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9]/g, '');
  return cleaned || 'Image';
}

function opacityResourceName(value) {
  return `GS${String(Math.round(Number(value) * 1000)).padStart(3, '0')}`;
}

function formatPdfDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
