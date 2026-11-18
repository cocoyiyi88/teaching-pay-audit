import { BRAND } from '../brand.js';
import { calculatePay, formatCurrency, formatHours, summarizeMonth } from './calculations.js';
import { formatMonthKey, getMonthKeysForYear } from './date.js';

const COLORS = Object.freeze({
  ink: '#172033', muted: '#667085', line: '#dfe4ee', soft: '#f7f9fd',
  primary: '#3451d1', primaryDark: '#263da8', primarySoft: '#eef1ff', white: '#ffffff', success: '#14804a',
});

export async function exportMonthPng(month, displayName = 'Teacher') {
  const canvas = await buildMonthCanvas(month, displayName);
  await downloadCanvas(canvas, `${BRAND.slug}-monthly-${month.monthKey}.png`);
}

export async function exportYearPng(database, year, displayName = 'Teacher') {
  const canvas = await buildYearCanvas(database, year, displayName);
  await downloadCanvas(canvas, `${BRAND.slug}-annual-${year}.png`);
}

export async function buildMonthCanvas(month, displayName = 'Teacher') {
  const entries = Object.values(month.entries || {})
    .filter((entry) => Number(entry?.hours) > 0 || String(entry?.className || '').trim() || String(entry?.notes || '').trim())
    .sort((a, b) => Number(a.day) - Number(b.day));
  const summary = summarizeMonth(month);
  const width = 1440;
  const margin = 80;
  const usable = width - margin * 2;
  const cols = [70, 86, 320, 115, 130, 150, 409];
  const rowLayouts = entries.map((entry) => {
    const classLines = wrapCanvasText(String(entry.className || '-'), cols[2] - 28, 20);
    const noteLines = wrapCanvasText(String(entry.notes || '-'), cols[6] - 28, 20);
    return { entry, classLines, noteLines, height: Math.max(62, 26 + Math.max(classLines.length, noteLines.length) * 25) };
  });
  const rowsHeight = rowLayouts.reduce((sum, item) => sum + item.height, 0) || 88;
  const extraRowsHeight = summary.overtimeHours > 0 ? 112 : 0;
  const height = Math.max(1680, 690 + rowsHeight + extraRowsHeight + 380);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  const brandImage = await loadBrandMark();

  let y = 68;
  drawTopRule(ctx, width);
  y = drawImageHeader(ctx, { x: margin, y, width: usable, title: 'Monthly Teaching Pay Report', period: formatMonthKey(month.monthKey), brandImage });
  y += 26;
  drawLabel(ctx, 'MONTHLY PAY RECORD', margin, y); y += 38;
  drawText(ctx, 'Daily Teaching Hours and Earnings', margin, y, { size: 35, weight: 800, color: COLORS.ink }); y += 34;
  drawText(ctx, 'Teaching activity and calculated earnings for the selected reporting period.', margin, y, { size: 17, color: COLORS.muted }); y += 38;

  const rateText = summary.overtimeEnabled
    ? `${formatCurrency(month.hourlyRate)}/hr (>${formatHours(summary.overtimeThresholdHours)}h: ${formatCurrency(summary.overtimeHourlyRate)})`
    : `${formatCurrency(month.hourlyRate)} / hour`;
  y = drawMetaCards(ctx, [
    ['Teacher', displayName], ['Reporting Period', formatMonthKey(month.monthKey)],
    ['Hourly Rate', rateText], ['Generated On', formatGeneratedAt(new Date())],
  ], margin, y, usable) + 34;

  drawLabel(ctx, 'TEACHING ACTIVITY DETAILS', margin, y); y += 30;
  drawText(ctx, 'Daily Hours and Earnings', margin, y, { size: 24, weight: 750 });
  drawText(ctx, `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`, width - margin, y, { size: 15, weight: 700, color: COLORS.primaryDark, align: 'right' });
  y += 28;

  const headers = ['No.', 'Date', 'Class', 'Hours', 'Rate', 'Amount', 'Notes'];
  drawTableHeader(ctx, headers, cols, margin, y, 54); y += 54;
  if (!entries.length) {
    ctx.fillStyle = '#fbfcff'; ctx.fillRect(margin, y, usable, 88);
    strokeRect(ctx, margin, y, usable, 88, COLORS.line);
    drawText(ctx, 'No teaching activity has been recorded for this period.', width / 2, y + 51, { size: 18, color: COLORS.muted, align: 'center' });
    y += 88;
  } else {
    rowLayouts.forEach((layout, index) => {
      const e = layout.entry;
      const values = [String(index + 1), String(e.day), layout.classLines, formatHours(e.hours), formatCurrency(month.hourlyRate), formatCurrency(calculatePay(e.hours, month.hourlyRate)), layout.noteLines];
      drawTableRow(ctx, values, cols, margin, y, layout.height, index % 2 === 1);
      y += layout.height;
    });
  }
  if (summary.overtimeHours > 0) {
    drawMonthlySummaryRow(ctx, {
      label: `BASE SUBTOTAL (${formatHours(summary.totalHours)} hrs × ${formatCurrency(month.hourlyRate)})`,
      hours: formatHours(summary.totalHours),
      rate: formatCurrency(month.hourlyRate),
      amount: formatCurrency(summary.basePay),
      notes: `${formatHours(summary.regularHours)}h base + ${formatHours(summary.overtimeHours)}h OT`,
      bg: '#f4f6fb',
      border: COLORS.line,
      color: COLORS.ink,
    }, cols, margin, y, 56);
    y += 56;
    drawMonthlySummaryRow(ctx, {
      label: `OVERTIME ADJUSTMENT (${formatHours(summary.overtimeHours)}h > ${formatHours(summary.overtimeThresholdHours)}h × ${formatSignedCurrency(summary.overtimeDeltaRate)})`,
      hours: `+${formatHours(summary.overtimeHours)}`,
      rate: formatSignedCurrency(summary.overtimeDeltaRate),
      amount: formatSignedCurrency(summary.overtimeBonus),
      notes: `Overtime rate ${formatCurrency(summary.overtimeHourlyRate)}/hr`,
      bg: '#ecfdf3',
      border: '#bce3cd',
      color: COLORS.success,
    }, cols, margin, y, 56);
    y += 56;
  }
  drawMonthlyTotalRow(ctx, summary, cols, margin, y, 62); y += 62;
  y += 60;
  drawSignatures(ctx, displayName, margin, y, usable); y += 170;
  drawWatermark(ctx, width, height, brandImage, 0.035);
  drawFooter(ctx, width, height, `Generated ${formatGeneratedAt(new Date())}`);
  return canvas;
}

export async function buildYearCanvas(database, year, displayName = 'Teacher') {
  const width = 1800, height = 1480, margin = 90, usable = width - margin * 2;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  const brandImage = await loadBrandMark();
  let y = 72;
  drawTopRule(ctx, width);
  y = drawImageHeader(ctx, { x: margin, y, width: usable, title: 'Annual Teaching Pay Report', period: String(year), brandImage });
  y += 28;
  drawLabel(ctx, 'ANNUAL PAY RECORD', margin, y); y += 38;
  drawText(ctx, 'Annual Teaching Hours and Earnings', margin, y, { size: 34, weight: 800 }); y += 34;
  drawText(ctx, 'Month-by-month teaching activity and total earnings.', margin, y, { size: 17, color: COLORS.muted }); y += 38;

  const months = getMonthKeysForYear(year).map((monthKey) => {
    const month = database.months?.[monthKey];
    const summary = month ? summarizeMonth(month) : { activeDays: 0, totalHours: 0, averageHours: 0, totalPay: 0 };
    return { monthKey, month, summary };
  });
  const totals = months.reduce((a, m) => ({ days: a.days + m.summary.activeDays, hours: a.hours + m.summary.totalHours, pay: a.pay + m.summary.totalPay }), { days: 0, hours: 0, pay: 0 });
  y = drawMetaCards(ctx, [['Teacher', displayName], ['Reporting Year', String(year)], ['Total Hours', formatHours(totals.hours)], ['Total Earnings', formatCurrency(totals.pay)]], margin, y, usable) + 36;
  const cols = [90, 350, 220, 220, 250, 260, 330];
  drawTableHeader(ctx, ['No.', 'Month', 'Teaching Days', 'Total Hours', 'Average / Day', 'Hourly Rate', 'Total Pay'], cols, margin, y, 54); y += 54;
  months.forEach((item, index) => {
    drawTableRow(ctx, [String(index + 1), formatMonthKey(item.monthKey), String(item.summary.activeDays), formatHours(item.summary.totalHours), formatHours(item.summary.averageHours), formatCurrency(item.month?.hourlyRate ?? database.settings?.defaultHourlyRate ?? 10), formatCurrency(item.summary.totalPay)], cols, margin, y, 49, index % 2 === 1, { boldCols: [1, 6], mutedCols: [] });
    y += 49;
  });
  drawTotalRow(ctx, ['', `TOTAL ${year}`, String(totals.days), formatHours(totals.hours), '', '', formatCurrency(totals.pay)], cols, margin, y, 60);
  drawWatermark(ctx, width, height, brandImage, 0.035);
  drawFooter(ctx, width, height, `Generated ${formatGeneratedAt(new Date())}`);
  return canvas;
}

function drawImageHeader(ctx, { x, y, width, title, period, brandImage }) {
  ctx.fillStyle = COLORS.soft; roundRect(ctx, x, y, 56, 56, 10); ctx.fill();
  strokeRect(ctx, x, y, 56, 56, COLORS.line);
  if (brandImage) ctx.drawImage(brandImage, x + 6, y + 6, 44, 44);
  else drawText(ctx, 'M', x + 28, y + 39, { size: 30, weight: 800, color: COLORS.primaryDark, align: 'center' });
  drawText(ctx, BRAND.appName.toUpperCase(), x + 76, y + 18, { size: 13, weight: 800, color: COLORS.primary });
  drawText(ctx, title, x + 76, y + 43, { size: 27, weight: 800, color: COLORS.ink });
  drawText(ctx, 'REPORTING PERIOD', x + width, y + 16, { size: 12, weight: 800, color: COLORS.muted, align: 'right' });
  drawText(ctx, period, x + width, y + 44, { size: 27, weight: 800, color: COLORS.primaryDark, align: 'right' });
  ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y + 82); ctx.lineTo(x + width, y + 82); ctx.stroke();
  return y + 112;
}

function drawMetaCards(ctx, items, x, y, width) {
  const gap = 18, cardW = (width - gap) / 2, cardH = 74;
  items.forEach(([label, value], index) => {
    const col = index % 2, row = Math.floor(index / 2); const cx = x + col * (cardW + gap), cy = y + row * (cardH + 14);
    ctx.fillStyle = COLORS.soft; roundRect(ctx, cx, cy, cardW, cardH, 10); ctx.fill(); strokeRect(ctx, cx, cy, cardW, cardH, COLORS.line);
    drawText(ctx, label.toUpperCase(), cx + 18, cy + 26, { size: 12, weight: 800, color: COLORS.muted });
    drawText(ctx, String(value), cx + 18, cy + 52, { size: 18, weight: 750, color: COLORS.ink, maxWidth: cardW - 36 });
  });
  return y + cardH * 2 + 14;
}

function drawTableHeader(ctx, headers, cols, x, y, h) {
  ctx.fillStyle = COLORS.primarySoft; ctx.fillRect(x, y, cols.reduce((a,b)=>a+b,0), h); strokeRect(ctx, x, y, cols.reduce((a,b)=>a+b,0), h, '#cbd5ff');
  let cx = x; headers.forEach((header, i) => { drawText(ctx, header, cx + 14, y + 33, { size: 13, weight: 800, color: COLORS.primaryDark, maxWidth: cols[i]-28 }); cx += cols[i]; if (i < cols.length-1) drawVLine(ctx, cx, y, y+h, '#d5dcf4'); });
}

function drawTableRow(ctx, values, cols, x, y, h, alternate, { boldCols = [1, 5], mutedCols = [6] } = {}) {
  ctx.fillStyle = alternate ? '#fbfcff' : '#fff'; ctx.fillRect(x, y, cols.reduce((a,b)=>a+b,0), h); strokeRect(ctx, x, y, cols.reduce((a,b)=>a+b,0), h, COLORS.line);
  let cx=x; values.forEach((value,i)=>{ const lines=Array.isArray(value)?value:[String(value ?? '')]; const baseline = y + 24; lines.slice(0, Math.floor((h-16)/24)).forEach((line, li)=>drawText(ctx,line,cx+14,baseline+li*24,{size:15,weight:boldCols.includes(i)?700:500,color:mutedCols.includes(i)?'#4b5565':COLORS.ink,maxWidth:cols[i]-28})); cx += cols[i]; if(i<cols.length-1) drawVLine(ctx,cx,y,y+h,COLORS.line); });
}

function drawTotalRow(ctx, values, cols, x, y, h) {
  const width=cols.reduce((a,b)=>a+b,0); ctx.fillStyle=COLORS.ink; ctx.fillRect(x,y,width,h); let cx=x;
  values.forEach((v,i)=>{ drawText(ctx,String(v??''),cx+14,y+37,{size:15,weight:800,color:'#fff',maxWidth:cols[i]-28}); cx+=cols[i]; if(i<cols.length-1) drawVLine(ctx,cx,y,y+h,'#465168'); });
}

function formatSignedCurrency(value) {
  const numeric = Number(value) || 0;
  if (numeric > 0) return `+${formatCurrency(numeric)}`;
  if (numeric < 0) return `-${formatCurrency(Math.abs(numeric))}`;
  return formatCurrency(0);
}

function drawMonthlySummaryRow(ctx, row, cols, x, y, h) {
  const width = cols.reduce((a, b) => a + b, 0);
  ctx.fillStyle = row.bg; ctx.fillRect(x, y, width, h);
  strokeRect(ctx, x, y, width, h, row.border);
  const mergedWidth = cols[0] + cols[1] + cols[2];
  drawText(ctx, row.label, x + 16, y + 35, { size: 14, weight: 750, color: row.color, maxWidth: mergedWidth - 32 });
  let cx = x + mergedWidth;
  drawVLine(ctx, cx, y, y + h, row.border);
  drawText(ctx, row.hours, cx + cols[3] - 16, y + 35, { size: 14, weight: 750, color: row.color, align: 'right', maxWidth: cols[3] - 28 });
  cx += cols[3]; drawVLine(ctx, cx, y, y + h, row.border);
  drawText(ctx, row.rate, cx + cols[4] - 16, y + 35, { size: 14, weight: 600, color: row.color, align: 'right', maxWidth: cols[4] - 28 });
  cx += cols[4]; drawVLine(ctx, cx, y, y + h, row.border);
  drawText(ctx, row.amount, cx + cols[5] - 16, y + 35, { size: 15, weight: 800, color: row.color, align: 'right', maxWidth: cols[5] - 28 });
  cx += cols[5]; drawVLine(ctx, cx, y, y + h, row.border);
  drawText(ctx, row.notes, cx + 16, y + 35, { size: 13, weight: 600, color: row.color, maxWidth: cols[6] - 28 });
}

function drawMonthlyTotalRow(ctx, summary, cols, x, y, h) {
  const width = cols.reduce((a,b)=>a+b,0);
  ctx.fillStyle = COLORS.ink; ctx.fillRect(x, y, width, h);
  const mergedWidth = cols[0] + cols[1] + cols[2];
  drawText(ctx, 'MONTHLY TOTAL', x + 16, y + 38, { size: 16, weight: 800, color: '#fff', maxWidth: mergedWidth - 32 });
  let cx = x + mergedWidth;
  drawVLine(ctx, cx, y, y + h, '#465168');
  drawText(ctx, formatHours(summary.totalHours), cx + cols[3] - 16, y + 38, { size: 16, weight: 800, color: '#fff', align: 'right', maxWidth: cols[3] - 28 });
  cx += cols[3]; drawVLine(ctx, cx, y, y + h, '#465168');
  cx += cols[4]; drawVLine(ctx, cx, y, y + h, '#465168');
  drawText(ctx, formatCurrency(summary.totalPay), cx + cols[5] - 16, y + 38, { size: 16, weight: 800, color: '#fff', align: 'right', maxWidth: cols[5] - 28 });
  cx += cols[5]; drawVLine(ctx, cx, y, y + h, '#465168');
}

function drawSignatures(ctx, name, x, y, width) {
  const boxW=(width-120)/2; drawText(ctx,'Prepared by',x+boxW/2,y,{size:14,color:COLORS.muted,align:'center'}); drawText(ctx,'Reviewed by',x+boxW+120+boxW/2,y,{size:14,color:COLORS.muted,align:'center'});
  const ly=y+82; ctx.strokeStyle='#8992a3'; ctx.lineWidth=1.4; ctx.beginPath(); ctx.moveTo(x+28,ly); ctx.lineTo(x+boxW-28,ly); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x+boxW+148,ly); ctx.lineTo(x+width-28,ly); ctx.stroke();
  drawText(ctx,name||'Teacher',x+boxW/2,ly+30,{size:17,weight:750,align:'center'}); drawText(ctx,'Teacher',x+boxW/2,ly+54,{size:13,color:COLORS.muted,align:'center'}); drawText(ctx,'Reviewer',x+boxW+120+boxW/2,ly+30,{size:17,weight:750,align:'center'});
}

function drawWatermark(ctx, width, height, image, opacity = 0.07) {
  if (!image) return;
  const size = Math.min(width, height) * 0.52;
  const x = (width - size) / 2;
  const y = (height - size) / 2 - Math.min(35, height * 0.025);
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.drawImage(image, x, y, size, size);
  ctx.restore();
}

async function loadBrandMark() {
  try { return await loadImage('/brand-mark.png'); } catch { return null; }
}

function drawFooter(ctx, width, height, rightText) {
  const y=height-58; ctx.strokeStyle=COLORS.line; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(80,y-18); ctx.lineTo(width-80,y-18); ctx.stroke();
  drawText(ctx, BRAND.appName, 80, y+8, { size: 13, color: COLORS.muted }); drawText(ctx, rightText, width-80, y+8, { size: 13, color: COLORS.muted, align:'right' });
}

function drawTopRule(ctx,width){ctx.fillStyle=COLORS.primary;ctx.fillRect(0,0,width,12)}
function drawLabel(ctx,text,x,y){drawText(ctx,text,x,y,{size:13,weight:800,color:COLORS.primary})}
function drawText(ctx,text,x,y,{size=16,weight=500,color=COLORS.ink,align='left',maxWidth}={}){ctx.save();ctx.font=`${weight} ${size}px Inter, Arial, sans-serif`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='alphabetic';const raw=String(text??'');let t=raw;if(maxWidth&&ctx.measureText(raw).width>maxWidth){const ellipsis='...';while(t.length>0&&ctx.measureText(t.replace(/\s+$/,'')+ellipsis).width>maxWidth)t=t.slice(0,-1);t=t.replace(/\s+$/,'')+ellipsis;}ctx.fillText(t,x,y);ctx.restore()}
function strokeRect(ctx,x,y,w,h,color){ctx.strokeStyle=color;ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w-1,h-1)}
function drawVLine(ctx,x,y1,y2,color){ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x+.5,y1);ctx.lineTo(x+.5,y2);ctx.stroke()}
function roundRect(ctx,x,y,w,h,r){if(ctx.roundRect){ctx.beginPath();ctx.roundRect(x,y,w,h,r);return;}ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function wrapCanvasText(text,maxWidth,fontSize){const fake=document.createElement('canvas').getContext('2d');fake.font=`500 ${fontSize}px Inter, Arial, sans-serif`;const out=[];for(const paragraph of String(text??'').replace(/\r\n?/g,'\n').split('\n')){if(!paragraph){out.push('');continue;}let line='';for(const word of paragraph.trim().split(/\s+/)){const candidate=line?`${line} ${word}`:word;if(fake.measureText(candidate).width<=maxWidth){line=candidate;continue;}if(line){out.push(line);line='';}if(fake.measureText(word).width<=maxWidth){line=word;continue;}let chunk='';for(const ch of word){const next=chunk+ch;if(fake.measureText(next).width<=maxWidth){chunk=next;}else{if(chunk)out.push(chunk);chunk=ch;}}line=chunk;}if(line)out.push(line);}return out.length?out:['-'];}
function loadImage(src){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src;});}
function downloadCanvas(canvas,filename){return new Promise((resolve,reject)=>canvas.toBlob((blob)=>{if(!blob){reject(new Error('PNG export failed.'));return;}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);resolve();},'image/png',1));}
function formatGeneratedAt(date){return new Intl.DateTimeFormat('en-US',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}
