import { BRAND } from '../brand.js';
import { calculatePay, summarizeMonth } from './calculations.js';
import { formatMonthKey, getMonthKeysForYear } from './date.js';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function exportMonthXlsx(month, displayName = 'Teacher') {
  const chart = await buildAnalyticsChartPng(monthAnalytics(month), `Teaching Activity - ${formatMonthKey(month.monthKey)}`);
  const bytes = buildMonthXlsxBytes(month, displayName, chart);
  downloadBytes(bytes, MIME_XLSX, `${BRAND.slug}-monthly-${month.monthKey}.xlsx`);
}

export async function exportYearXlsx(database, year, displayName = 'Teacher') {
  const analytics = yearAnalytics(database, year);
  const chart = await buildAnalyticsChartPng(analytics, `Annual Teaching Activity - ${year}`);
  const bytes = buildYearXlsxBytes(database, year, displayName, chart);
  downloadBytes(bytes, MIME_XLSX, `${BRAND.slug}-annual-${year}.xlsx`);
}

export function buildMonthXlsxBytes(month, displayName = 'Teacher', chartPngBytes = null) {
  const entries = Object.values(month.entries || {})
    .filter((entry) => Number(entry?.hours) > 0 || String(entry?.className || '').trim() || String(entry?.notes || '').trim())
    .sort((a, b) => Number(a.day) - Number(b.day));
  const summary = summarizeMonth(month);
  const detailStart = 4;
  const detailEnd = detailStart + Math.max(entries.length, 1) - 1;
  const totalRow = detailEnd + 2;

  const summaryRows = [
    row(1, [str('A1', BRAND.appName, 1)], 34),
    row(2, [str('A2', 'Monthly Teaching Pay Report', 2)], 24),
    row(4, [str('A4', 'Teacher', 3), str('B4', displayName, 4), str('D4', 'Reporting Period', 3), str('E4', formatMonthKey(month.monthKey), 4)]),
    row(5, [str('A5', 'Hourly Rate', 3), num('B5', month.hourlyRate, 8), str('D5', 'Teaching Days', 3), num('E5', summary.activeDays, 6)]),
    row(6, [str('A6', 'Total Hours', 3), num('B6', summary.totalHours, 7), str('D6', 'Total Earnings', 3), num('E6', summary.totalPay, 8)]),
    row(8, [str('A8', 'Use the Daily Details sheet for the full teaching record and editable formulas.', 11)]),
  ];

  const detailRows = [row(1, [str('A1', `${BRAND.appName} - ${formatMonthKey(month.monthKey)}`, 1)], 32), row(3, ['No.','Date','Class','Hours','Hourly Rate','Amount','Notes'].map((value, i) => str(`${col(i + 1)}3`, value, 5)), 28)];
  if (entries.length) {
    entries.forEach((entry, index) => {
      const r = detailStart + index;
      detailRows.push(row(r, [
        num(`A${r}`, index + 1, 6), str(`B${r}`, `${month.monthKey}-${String(entry.day).padStart(2, '0')}`, 6), str(`C${r}`, entry.className || '-', 12),
        num(`D${r}`, Number(entry.hours) || 0, 7), num(`E${r}`, month.hourlyRate, 8), formula(`F${r}`, `ROUND(D${r}*E${r},2)`, calculatePay(entry.hours, month.hourlyRate), 8), str(`G${r}`, entry.notes || '', 12),
      ], Math.max(24, 18 + 15 * Math.max(lineCount(entry.className), lineCount(entry.notes)))));
    });
  } else {
    detailRows.push(row(detailStart, [str(`A${detailStart}`, 'No teaching activity recorded for this period.', 11)], 28));
  }
  detailRows.push(row(totalRow, [str(`A${totalRow}`, 'MONTHLY TOTAL', 9), str(`B${totalRow}`, '', 9), str(`C${totalRow}`, '', 9), formula(`D${totalRow}`, `SUM(D${detailStart}:D${detailEnd})`, summary.totalHours, 13), str(`E${totalRow}`, '', 9), formula(`F${totalRow}`, `SUM(F${detailStart}:F${detailEnd})`, summary.totalPay, 10), str(`G${totalRow}`, '', 9)], 28));

  const analytics = monthAnalytics(month);
  const analyticsRows = [
    row(1, [str('A1', 'Monthly Analytics', 1)], 32),
    row(3, [str('A3', 'Date', 5), str('B3', 'Teaching Hours', 5), str('C3', 'Earnings', 5)], 26),
    ...analytics.labels.map((label, index) => row(4 + index, [str(`A${4 + index}`, label, 6), num(`B${4 + index}`, analytics.hours[index], 7), num(`C${4 + index}`, analytics.pay[index], 8)])),
  ];

  return buildWorkbook({
    title: `${BRAND.appName} - ${formatMonthKey(month.monthKey)}`,
    sheets: [
      sheetDef('Summary', summaryRows, { cols: [22, 24, 5, 22, 26, 14], merges: ['A1:F1','A2:F2','A8:F8'] }),
      sheetDef('Daily Details', detailRows, { cols: [8, 15, 36, 13, 16, 16, 42], merges: entries.length ? ['A1:G1', `A${totalRow}:C${totalRow}`] : ['A1:G1', `A${detailStart}:G${detailStart}`, `A${totalRow}:C${totalRow}`], freezeRows: 3 }),
      sheetDef('Analytics', analyticsRows, { cols: [18, 18, 18, 3, 16, 16, 16, 16, 16, 16, 16, 16, 16], drawing: chartPngBytes ? 1 : 0, freezeRows: 3 }),
    ],
    chartPngBytes,
  });
}

export function buildYearXlsxBytes(database, year, displayName = 'Teacher', chartPngBytes = null) {
  const months = getMonthKeysForYear(year).map((monthKey) => {
    const month = database.months?.[monthKey];
    const summary = month ? summarizeMonth(month) : { activeDays: 0, totalHours: 0, averageHours: 0, totalPay: 0 };
    return { monthKey, month, summary };
  });
  const totals = months.reduce((a,m)=>({days:a.days+m.summary.activeDays,hours:a.hours+m.summary.totalHours,pay:a.pay+m.summary.totalPay}),{days:0,hours:0,pay:0});
  const summaryRows = [
    row(1,[str('A1', BRAND.appName,1)],34), row(2,[str('A2','Annual Teaching Pay Report',2)],24),
    row(4,[str('A4','Teacher',3),str('B4',displayName,4),str('D4','Reporting Year',3),str('E4',String(year),4)]),
    row(5,[str('A5','Teaching Days',3),num('B5',totals.days,7),str('D5','Total Hours',3),num('E5',totals.hours,7)]),
    row(6,[str('A6','Total Earnings',3),num('B6',totals.pay,8)]),
  ];
  const dataStart=4, dataEnd=15, totalRow=17;
  const monthlyRows=[row(1,[str('A1',`${BRAND.appName} - ${year}`,1)],32),row(3,['No.','Month','Teaching Days','Total Hours','Average / Day','Hourly Rate','Total Pay'].map((v,i)=>str(`${col(i+1)}3`,v,5)),28)];
  months.forEach((m,index)=>{const r=dataStart+index;monthlyRows.push(row(r,[num(`A${r}`,index+1,6),str(`B${r}`,formatMonthKey(m.monthKey),6),num(`C${r}`,m.summary.activeDays,7),num(`D${r}`,m.summary.totalHours,7),num(`E${r}`,m.summary.averageHours,7),num(`F${r}`,m.month?.hourlyRate??database.settings?.defaultHourlyRate??10,8),num(`G${r}`,m.summary.totalPay,8)]));});
  monthlyRows.push(row(totalRow,[str(`A${totalRow}`,`TOTAL ${year}`,9),str(`B${totalRow}`,'',9),formula(`C${totalRow}`,`SUM(C${dataStart}:C${dataEnd})`,totals.days,9),formula(`D${totalRow}`,`SUM(D${dataStart}:D${dataEnd})`,totals.hours,13),str(`E${totalRow}`,'',9),str(`F${totalRow}`,'',9),formula(`G${totalRow}`,`SUM(G${dataStart}:G${dataEnd})`,totals.pay,10)],28));
  const analytics=yearAnalytics(database,year);const analyticsRows=[row(1,[str('A1','Annual Analytics',1)],32),row(3,[str('A3','Month',5),str('B3','Teaching Hours',5),str('C3','Earnings',5)],26),...analytics.labels.map((label,index)=>row(4+index,[str(`A${4+index}`,label,6),num(`B${4+index}`,analytics.hours[index],7),num(`C${4+index}`,analytics.pay[index],8)]))];
  return buildWorkbook({title:`${BRAND.appName} - ${year}`,sheets:[sheetDef('Summary',summaryRows,{cols:[22,24,5,22,26,14],merges:['A1:F1','A2:F2']}),sheetDef('Monthly Breakdown',monthlyRows,{cols:[8,24,18,18,18,18,20],merges:['A1:G1', `A${totalRow}:B${totalRow}`],freezeRows:3}),sheetDef('Analytics',analyticsRows,{cols:[18,18,18,3,16,16,16,16,16,16,16,16,16],drawing:chartPngBytes?1:0,freezeRows:3})],chartPngBytes});
}

function buildWorkbook({ title, sheets, chartPngBytes }) {
  const files = [];
  const hasDrawing = Boolean(chartPngBytes);
  files.push(textFile('[Content_Types].xml', contentTypesXml(sheets.length, hasDrawing)));
  files.push(textFile('_rels/.rels', rootRelsXml()));
  files.push(textFile('docProps/core.xml', corePropsXml(title)));
  files.push(textFile('docProps/app.xml', appPropsXml(sheets.map((s)=>s.name))));
  files.push(textFile('xl/workbook.xml', workbookXml(sheets)));
  files.push(textFile('xl/_rels/workbook.xml.rels', workbookRelsXml(sheets.length)));
  files.push(textFile('xl/styles.xml', stylesXml()));
  sheets.forEach((sheet,index)=>files.push(textFile(`xl/worksheets/sheet${index+1}.xml`, worksheetXml(sheet, index+1))));
  if (hasDrawing) {
    const drawingSheetIndex = sheets.findIndex((sheet)=>sheet.drawing)+1;
    files.push(textFile(`xl/worksheets/_rels/sheet${drawingSheetIndex}.xml.rels`, sheetDrawingRelsXml()));
    files.push(textFile('xl/drawings/drawing1.xml', drawingXml()));
    files.push(textFile('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml()));
    files.push({ name: 'xl/media/chart1.png', data: toUint8Array(chartPngBytes) });
  }
  return zipStore(files);
}

function sheetDef(name, rows, options={}) { return { name, rows, cols: options.cols || [], merges: options.merges || [], freezeRows: options.freezeRows || 0, drawing: options.drawing || 0 }; }
function row(index,cells,height){return {index,cells,height};}
function str(ref,value,style=0){return {ref,type:'s',value:String(value??''),style};}
function num(ref,value,style=0){return {ref,type:'n',value:Number(value)||0,style};}
function formula(ref,expression,cached,style=0){return {ref,type:'f',formula:expression,value:Number(cached)||0,style};}

function worksheetXml(sheet, sheetIndex) {
  const dimensionRef = computeSheetDimension(sheet);
  const sheetViews = sheet.freezeRows ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows+1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const cols = sheet.cols.length ? `<cols>${sheet.cols.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
  const rows = sheet.rows.map((r)=>`<row r="${r.index}"${r.height?` ht="${r.height}" customHeight="1"`:''}>${r.cells.map(cellXml).join('')}</row>`).join('');
  const merges = sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref)=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : '';
  const drawing = sheet.drawing ? '<drawing r:id="rId1"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimensionRef}"/>${sheetViews}<sheetFormatPr defaultRowHeight="20"/>${cols}<sheetData>${rows}</sheetData>${merges}${drawing}</worksheet>`;
}

function computeSheetDimension(sheet) {
  let maxCol = 1;
  let maxRow = 1;
  const parseRef = (ref) => {
    const match = /^([A-Z]+)(\d+)$/.exec(String(ref || ''));
    if (!match) return;
    let colNum = 0;
    for (const ch of match[1]) colNum = colNum * 26 + (ch.charCodeAt(0) - 64);
    maxCol = Math.max(maxCol, colNum);
    maxRow = Math.max(maxRow, Number(match[2]) || 1);
  };
  for (const r of sheet.rows) {
    maxRow = Math.max(maxRow, Number(r.index) || 1);
    for (const c of r.cells) parseRef(c.ref);
  }
  for (const m of sheet.merges || []) {
    for (const part of String(m).split(':')) parseRef(part);
  }
  return `A1:${col(maxCol)}${maxRow}`;
}

function cellXml(cell) {
  const s = cell.style ? ` s="${cell.style}"` : '';
  if (cell.type === 'n') return `<c r="${cell.ref}"${s}><v>${finite(cell.value)}</v></c>`;
  if (cell.type === 'f') return `<c r="${cell.ref}"${s}><f>${xml(cell.formula)}</f><v>${finite(cell.value)}</v></c>`;
  return `<c r="${cell.ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`;
}

function stylesXml(){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="$#,##0.00;[Red]-$#,##0.00"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Aptos"/><color rgb="FF182033"/></font><font><b/><sz val="20"/><name val="Aptos Display"/><color rgb="FF182033"/></font><font><b/><sz val="12"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="10"/><name val="Aptos"/><color rgb="FF3451D1"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3451D1"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1FF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7F9FD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFDDE3EE"/></left><right style="thin"><color rgb="FFDDE3EE"/></right><top style="thin"><color rgb="FFDDE3EE"/></top><bottom style="thin"><color rgb="FFDDE3EE"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="14"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="165" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;}
function workbookXml(sheets){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s,i)=>`<sheet name="${xmlAttr(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;}
function workbookRelsXml(count){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({length:count},(_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${count+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;}
function rootRelsXml(){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;}
function contentTypesXml(sheetCount,hasDrawing){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${hasDrawing?'<Default Extension="png" ContentType="image/png"/>':''}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${Array.from({length:sheetCount},(_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${hasDrawing?'<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>':''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;}
function corePropsXml(title){const now=new Date().toISOString();return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(BRAND.appName)}</dc:creator><cp:lastModifiedBy>${xml(BRAND.appName)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;}
function appPropsXml(names){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${xml(BRAND.appName)}</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${names.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">${names.map((n)=>`<vt:lpstr>${xml(n)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`;}
function sheetDrawingRelsXml(){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;}
function drawingRelsXml(){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart1.png"/></Relationships>`;}
function drawingXml(){return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Teaching Pay Analytics"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;}

async function buildAnalyticsChartPng(data,title){if(typeof document==='undefined')return null;const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=620;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#182033';ctx.font='700 34px Arial';ctx.fillText(title,70,64);const left=90,right=90,top=115,bottom=90,w=canvas.width-left-right,h=canvas.height-top-bottom;ctx.strokeStyle='#dfe3ed';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(left,top);ctx.lineTo(left,top+h);ctx.lineTo(left+w,top+h);ctx.stroke();const maxHours=Math.max(1,...data.hours),maxPay=Math.max(1,...data.pay);const gap=w/Math.max(1,data.labels.length);data.labels.forEach((label,i)=>{const cx=left+gap*i+gap/2;const bh=(data.hours[i]/maxHours)*(h-35);ctx.fillStyle='rgba(52,81,209,.78)';ctx.fillRect(cx-gap*.28,top+h-bh,gap*.56,bh);ctx.fillStyle='#667085';ctx.font='500 17px Arial';ctx.textAlign='center';ctx.fillText(label,cx,top+h+34);});ctx.strokeStyle='#704fd8';ctx.lineWidth=5;ctx.beginPath();data.pay.forEach((value,i)=>{const cx=left+gap*i+gap/2,cy=top+h-(value/maxPay)*(h-35);if(i===0)ctx.moveTo(cx,cy);else ctx.lineTo(cx,cy);});ctx.stroke();ctx.fillStyle='#3451d1';ctx.fillRect(left,canvas.height-44,28,16);ctx.fillStyle='#182033';ctx.font='600 17px Arial';ctx.textAlign='left';ctx.fillText('Teaching hours',left+38,canvas.height-30);ctx.strokeStyle='#704fd8';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(left+225,canvas.height-36);ctx.lineTo(left+255,canvas.height-36);ctx.stroke();ctx.fillText('Earnings',left+266,canvas.height-30);const url=canvas.toDataURL('image/png');return dataUrlBytes(url);}
function monthAnalytics(month){const entries=Object.values(month.entries||{}).filter((e)=>Number(e?.hours)>0).sort((a,b)=>Number(a.day)-Number(b.day));return {labels:entries.map((e)=>String(e.day)),hours:entries.map((e)=>Number(e.hours)||0),pay:entries.map((e)=>calculatePay(e.hours,month.hourlyRate))};}
function yearAnalytics(database,year){const months=getMonthKeysForYear(year);return {labels:months.map((m)=>formatMonthKey(m).split(' ')[0].slice(0,3)),hours:months.map((m)=>summarizeMonth(database.months?.[m]||{monthKey:m,entries:{},hourlyRate:database.settings?.defaultHourlyRate??10}).totalHours),pay:months.map((m)=>summarizeMonth(database.months?.[m]||{monthKey:m,entries:{},hourlyRate:database.settings?.defaultHourlyRate??10}).totalPay)};}
function dataUrlBytes(url){const binary=atob(url.split(',')[1]);const out=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);return out;}
function lineCount(v){return Math.max(1,String(v||'').split(/\r?\n/).length)}
function col(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}
function xml(v){return String(v??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function xmlAttr(v){return xml(v).replace(/"/g,'&quot;')}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:0}
function textFile(name,text){return {name,data:new TextEncoder().encode(text)}}
function toUint8Array(v){return v instanceof Uint8Array?v:new Uint8Array(v||[])}
function downloadBytes(bytes,type,filename){const blob=new Blob([bytes],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}

function zipStore(files){const encoder=new TextEncoder();const locals=[];const centrals=[];let offset=0;const now=new Date();const dosTime=((now.getHours()&31)<<11)|((now.getMinutes()&63)<<5)|((Math.floor(now.getSeconds()/2))&31);const dosDate=(((now.getFullYear()-1980)&127)<<9)|(((now.getMonth()+1)&15)<<5)|(now.getDate()&31);for(const file of files){const name=encoder.encode(file.name);const data=toUint8Array(file.data);const crc=crc32(data);const local=new Uint8Array(30+name.length);const dv=new DataView(local.buffer);dv.setUint32(0,0x04034b50,true);dv.setUint16(4,20,true);dv.setUint16(6,0,true);dv.setUint16(8,0,true);dv.setUint16(10,dosTime,true);dv.setUint16(12,dosDate,true);dv.setUint32(14,crc,true);dv.setUint32(18,data.length,true);dv.setUint32(22,data.length,true);dv.setUint16(26,name.length,true);dv.setUint16(28,0,true);local.set(name,30);locals.push(local,data);const central=new Uint8Array(46+name.length);const cv=new DataView(central.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0,true);cv.setUint16(10,0,true);cv.setUint16(12,dosTime,true);cv.setUint16(14,dosDate,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint16(30,0,true);cv.setUint16(32,0,true);cv.setUint16(34,0,true);cv.setUint16(36,0,true);cv.setUint32(38,0,true);cv.setUint32(42,offset,true);central.set(name,46);centrals.push(central);offset+=local.length+data.length;}const centralSize=centrals.reduce((s,b)=>s+b.length,0);const end=new Uint8Array(22);const ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(4,0,true);ev.setUint16(6,0,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);ev.setUint16(20,0,true);const total=offset+centralSize+end.length;const out=new Uint8Array(total);let pos=0;for(const b of locals){out.set(b,pos);pos+=b.length}for(const b of centrals){out.set(b,pos);pos+=b.length}out.set(end,pos);return out;}
const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}return table;})();
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
