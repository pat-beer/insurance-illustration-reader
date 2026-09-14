/* ===================================================================
   Insurance Illustration Reader — parsing engine + UI
   =================================================================== */

/* ---------- Number / text helpers ---------- */
function cleanText(s){ return (s||'').replace(/\s+/g,' ').trim(); }
function toNumber(s){
  if (s === undefined || s === null) return NaN;
  const t = String(s).replace(/[\$,\s]/g,'').replace(/^\((.*)\)$/,'-$1');
  if (t === '' || t === '-' || /^N\.?A\.?$/i.test(t)) return NaN;
  const n = parseFloat(t);
  return isNaN(n) ? NaN : n;
}
function normHeader(s){ return cleanText(s).toLowerCase(); }

/* ---------- Build a normalized grid from a <table>, resolving rowspan/colspan ---------- */
function normalizeTable(tableEl){
  const trs = Array.from(tableEl.querySelectorAll('tr'));
  const grid = [];
  const tracker = {}; // colIndex -> {text, rowsLeft}
  trs.forEach((tr) => {
    const row = [];
    let colIdx = 0;
    const cellNodes = Array.from(tr.children);
    let ci = 0;
    let guard = 0;
    while (true){
      guard++;
      if (guard > 500) break;
      if (tracker[colIdx] && tracker[colIdx].rowsLeft > 0){
        row[colIdx] = tracker[colIdx].text;
        tracker[colIdx].rowsLeft--;
        if (tracker[colIdx].rowsLeft === 0) delete tracker[colIdx];
        colIdx++;
        continue;
      }
      if (ci >= cellNodes.length){
        const remaining = Object.keys(tracker).map(Number).filter(k => k >= colIdx);
        if (remaining.length === 0) break;
        colIdx++;
        continue;
      }
      const cell = cellNodes[ci++];
      const text = cleanText(cell.textContent);
      const colspan = parseInt(cell.getAttribute('colspan') || '1', 10) || 1;
      const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10) || 1;
      for (let k = 0; k < colspan; k++){
        row[colIdx] = text;
        if (rowspan > 1) tracker[colIdx] = { text, rowsLeft: rowspan - 1 };
        colIdx++;
      }
    }
    grid.push(row);
  });
  const maxCols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  grid.forEach(r => { for (let c = 0; c < maxCols; c++) if (r[c] === undefined) r[c] = ''; });
  return { grid, maxCols };
}

/* ---------- Split a normalized grid into header rows + data rows ---------- */
function splitHeaderData(grid){
  let headerEnd = 0;
  for (let i = 0; i < grid.length; i++){
    const first = cleanText(grid[i][0]);
    if (/^\d+$/.test(first) || /^at\s*age\s*\d+$/i.test(first)){
      headerEnd = i;
      break;
    }
    headerEnd = i + 1;
  }
  const headerRows = grid.slice(0, headerEnd);
  const dataRows = grid.slice(headerEnd).filter(r => {
    const first = cleanText(r[0]);
    return /^\d+$/.test(first) || /^at\s*age\s*\d+$/i.test(first);
  });
  return { headerRows, dataRows };
}

/* ---------- Build per-column header text (joined across header rows) ---------- */
function columnHeaders(headerRows, maxCols){
  const cols = [];
  for (let c = 0; c < maxCols; c++){
    const parts = [];
    headerRows.forEach(r => {
      const t = cleanText(r[c]);
      if (t && parts[parts.length - 1] !== t) parts.push(t);
    });
    cols.push(parts.join(' ').trim());
  }
  return cols;
}

/* ---------- Locate "guaranteed" zone-start columns (guaranteed, not non-guaranteed) ---------- */
function findGuaranteedCols(colHeaders){
  const out = [];
  colHeaders.forEach((h, idx) => {
    const lh = h.toLowerCase();
    if (h.length > 60) return; // skip long disclaimer sentences that happen to contain "guaranteed"
    if (lh.includes('guaranteed') && !lh.includes('non-guaranteed') && !lh.includes('non guaranteed')){
      out.push(idx);
    }
  });
  return out;
}

function findTotalCol(colHeaders, fromIdx, toIdx){
  for (let c = toIdx; c >= fromIdx; c--){
    const lh = (colHeaders[c] || '').toLowerCase();
    if (lh.includes('aggregated') && lh.includes('withdrawal')) continue;
    if (lh.includes('total')) return c;
  }
  return toIdx;
}

function findNonGuarCols(colHeaders, fromIdx, toIdx, excludeIdx){
  const out = [];
  for (let c = fromIdx; c <= toIdx; c++){
    if (c === excludeIdx) continue;
    const lh = (colHeaders[c] || '').toLowerCase();
    if (lh.includes('non-guaranteed') || lh.includes('non guaranteed') ||
        lh.includes('reversionary') || lh.includes('terminal')){
      out.push(c);
    }
  }
  return out;
}

function findPremiumCol(colHeaders, fromIdx, toIdx){
  for (let c = fromIdx; c <= toIdx; c++){
    const lh = (colHeaders[c] || '').toLowerCase();
    if (lh.includes('premiums paid') || (lh.includes('premium') && lh.includes('paid'))) return c;
  }
  return -1;
}

function findHeaderCol(colHeaders, pred){
  for (let i = 0; i < colHeaders.length; i++){
    if (pred(normHeader(colHeaders[i]), colHeaders[i], i)) return i;
  }
  return -1;
}

/* Mammoth often emits each Word column twice for these wide supplementary tables.
   Collapse consecutive identical headers (and their data cells) so downstream
   column matching sees the printed layout, not the duplicated grid. */
function collapseDuplicateHeaderColumns(colHeaders, dataRows){
  const idxs = [];
  for (let c = 0; c < colHeaders.length; c++){
    if (c > 0 && normHeader(colHeaders[c]) === normHeader(colHeaders[c - 1]) && colHeaders[c] !== '') continue;
    idxs.push(c);
  }
  if (idxs.length === colHeaders.length) return { colHeaders, dataRows };
  return {
    colHeaders: idxs.map(i => colHeaders[i]),
    dataRows: dataRows.map(r => idxs.map(i => r[i] !== undefined ? r[i] : ''))
  };
}

function isAfterCashWithdrawalHeader(fullHeaderLower){
  return /after\s*cash\s*withdrawal/i.test(fullHeaderLower);
}

function headerCompact(t){
  return normHeader(t).replace(/[^a-z0-9+()#]/g, '');
}
function headerHas(t, snippet){
  return headerCompact(t).includes(String(snippet).replace(/[^a-z0-9+()#]/g, ''));
}

/* Dedicated extractor for "… AFTER CASH WITHDRAWAL" SV/DB tables.
   Does not reuse extractParZone: those tables have extra withdrawal / notional /
   (A)+(E) columns, and the DB table has two "Guaranteed" markers that would
   otherwise be misread as a combined SV+DB layout. */
function extractWithdrawalZone(dataRows, colHeaders, kind, yearCol, ageColIdx, premiumColIdx){
  const cashWdCol = findHeaderCol(colHeaders, (t, _raw) => headerHas(t, 'cashwithdrawalamount') && !headerHas(t, 'cumulative'));
  const cumWdCol = findHeaderCol(colHeaders, (t, _raw) =>
    headerHas(t, 'cumulative') && headerHas(t, 'withdrawal') && !headerHas(t, 'surrender') && !t.includes('+')
  );
  const notionalCol = findHeaderCol(colHeaders, t => headerHas(t, 'notional'));

  let guaranteedCol = -1, gcvCol = -1, totalCol = -1;
  if (kind === 'db'){
    gcvCol = findHeaderCol(colHeaders, t =>
      headerHas(t, 'guaranteed') && headerHas(t, 'cashvalue') &&
      !headerHas(t, 'nonguaranteed')
    );
    guaranteedCol = findHeaderCol(colHeaders, t =>
      (headerHas(t, 'guaranteed#') || (headerHas(t, 'guaranteed') && t.includes('(b)'))) &&
      !headerHas(t, 'nonguaranteed') && !headerHas(t, 'cashvalue')
    );
    if (guaranteedCol < 0){
      guaranteedCol = findHeaderCol(colHeaders, t =>
        headerHas(t, 'guaranteed') && !headerHas(t, 'nonguaranteed') &&
        !headerHas(t, 'cashvalue') && t.length <= 80
      );
    }
    totalCol = findHeaderCol(colHeaders, t => /higherof|higher of/.test(headerCompact(t) + ' ' + t));
  } else {
    guaranteedCol = findHeaderCol(colHeaders, t =>
      headerHas(t, 'guaranteed') && !headerHas(t, 'nonguaranteed') && t.length <= 80
    );
    totalCol = findHeaderCol(colHeaders, t =>
      headerHas(t, 'total') &&
      (headerHas(t, 'b+c+d') || (headerHas(t, '(e)') && headerHas(t, 'total'))) &&
      !headerHas(t, 'higher') && !headerHas(t, 'cumulative')
    );
  }

  if (guaranteedCol < 0 && kind === 'sv' && colHeaders.length >= 5) guaranteedCol = 4;
  if (kind === 'db'){
    if (gcvCol < 0 && colHeaders.length >= 5) gcvCol = 4;
    if (guaranteedCol < 0 && colHeaders.length >= 6) guaranteedCol = 5;
  }
  const cashCol = cashWdCol >= 0 ? cashWdCol : (colHeaders.length >= 3 ? 2 : -1);
  const cumCol = cumWdCol >= 0 ? cumWdCol : (colHeaders.length >= 4 ? 3 : -1);

  const zoneEnd = colHeaders.length - 1;
  const ngStart = Math.max(0, guaranteedCol >= 0 ? guaranteedCol + 1 : (gcvCol >= 0 ? gcvCol + 1 : 0));
  const ngCols = guaranteedCol >= 0 || totalCol >= 0
    ? findNonGuarCols(colHeaders, ngStart, totalCol >= 0 ? totalCol : zoneEnd, totalCol)
    : [];

  const rows = [];
  dataRows.forEach(r => {
    const label = cleanText(r[yearCol]);
    let year = null, age = null;
    const ageMatch = label.match(/^at\s*age\s*(\d+)/i);
    if (ageMatch){ age = parseInt(ageMatch[1], 10); }
    else if (/^\d+$/.test(label)){ year = parseInt(label, 10); }
    else return;

    if (ageColIdx !== null && ageColIdx !== undefined){
      const ageTxt = cleanText(r[ageColIdx]);
      const am = ageTxt.match(/(\d+)/);
      if (am) age = parseInt(am[1], 10);
    }

    const guaranteed = guaranteedCol >= 0 ? toNumber(r[guaranteedCol]) : NaN;
    let ng = 0;
    ngCols.forEach(c => { const v = toNumber(r[c]); if (!isNaN(v)) ng += v; });
    const total = totalCol >= 0 ? toNumber(r[totalCol]) : NaN;
    if (isNaN(guaranteed) && isNaN(total)) return;

    let premium = null;
    if (premiumColIdx !== null && premiumColIdx !== undefined && premiumColIdx >= 0){
      const p = toNumber(r[premiumColIdx]);
      if (!isNaN(p)) premium = p;
    }

    const cashWithdrawal = cashCol >= 0 ? toNumber(r[cashCol]) : 0;
    const cumulativeWithdrawal = cumCol >= 0 ? toNumber(r[cumCol]) : 0;
    const notionalAfterWithdrawal = notionalCol >= 0 ? toNumber(r[notionalCol]) : NaN;
    const guaranteedCashValue = gcvCol >= 0 ? toNumber(r[gcvCol]) : NaN;

    rows.push({
      year, age,
      guaranteed: isNaN(guaranteed) ? 0 : guaranteed,
      nonGuaranteed: ng,
      total: isNaN(total) ? (isNaN(guaranteed) ? 0 : guaranteed) : total,
      premium,
      cashWithdrawal: isNaN(cashWithdrawal) ? 0 : cashWithdrawal,
      cumulativeWithdrawal: isNaN(cumulativeWithdrawal) ? 0 : cumulativeWithdrawal,
      notionalAfterWithdrawal: isNaN(notionalAfterWithdrawal) ? null : notionalAfterWithdrawal,
      guaranteedCashValue: isNaN(guaranteedCashValue) ? null : guaranteedCashValue
    });
  });
  return rows;
}

function parRowsToSeries(merged, extraKeys){
  const s = {
    years: merged.map(r => r.year),
    ages: merged.map(r => r.age),
    guaranteed: merged.map(r => r.guaranteed),
    nonGuaranteed: merged.map(r => r.nonGuaranteed),
    total: merged.map(r => r.total),
    premium: merged.map(r => r.premium !== undefined ? r.premium : null)
  };
  (extraKeys || []).forEach(k => { s[k] = merged.map(r => r[k] !== undefined && r[k] !== null ? r[k] : null); });
  return s;
}

function overlayPremiumByYear(target, source){
  if (!target || !source || !source.years || !source.premium) return;
  const map = new Map();
  source.years.forEach((y, i) => {
    const p = source.premium[i];
    if (y !== null && y !== undefined && p !== null && p !== undefined && !map.has(y)) map.set(y, p);
  });
  if (map.size === 0) return;
  target.premium = forwardFillNulls(target.years.map(y => map.has(y) ? map.get(y) : null));
}

/* ---------- Extract a PAR-style zone (guaranteed + non-guaranteed(s) + total) ---------- */
function extractParZone(dataRows, colHeaders, guaranteedCol, zoneEnd, yearCol, ageColIdx, premiumColIdx){
  const totalCol = findTotalCol(colHeaders, guaranteedCol, zoneEnd);
  const ngCols = findNonGuarCols(colHeaders, guaranteedCol + 1, zoneEnd, totalCol);

  const rows = [];
  dataRows.forEach(r => {
    const label = cleanText(r[yearCol]);
    let year = null, age = null;
    const ageMatch = label.match(/^at\s*age\s*(\d+)/i);
    if (ageMatch){ age = parseInt(ageMatch[1], 10); }
    else if (/^\d+$/.test(label)){ year = parseInt(label, 10); }
    else return;

    if (ageColIdx !== null && ageColIdx !== undefined){
      const ageTxt = cleanText(r[ageColIdx]);
      const am = ageTxt.match(/(\d+)/);
      if (am) age = parseInt(am[1], 10);
    }

    const guaranteed = toNumber(r[guaranteedCol]);
    let ng = 0;
    ngCols.forEach(c => { const v = toNumber(r[c]); if (!isNaN(v)) ng += v; });
    const total = toNumber(r[totalCol]);
    if (isNaN(guaranteed) && isNaN(total)) return;
    let premium = null;
    if (premiumColIdx !== null && premiumColIdx !== undefined && premiumColIdx >= 0){
      const p = toNumber(r[premiumColIdx]);
      if (!isNaN(p)) premium = p;
    }

    rows.push({ year, age, guaranteed: isNaN(guaranteed) ? 0 : guaranteed, nonGuaranteed: ng, total: isNaN(total) ? guaranteed : total, premium });
  });
  return rows;
}

/* ---------- Extract a flat (UL/IUL) zone: single-value columns like Account/Surrender/Death Benefit ---------- */
function extractFlatSeries(dataRows, colIdx, yearCol, ageColIdx, premiumColIdx){
  const rows = [];
  dataRows.forEach(r => {
    const label = cleanText(r[yearCol]);
    let year = null, age = null;
    const ageMatch = label.match(/^at\s*age\s*(\d+)/i);
    if (ageMatch){ age = parseInt(ageMatch[1], 10); }
    else if (/^\d+$/.test(label)){ year = parseInt(label, 10); }
    else return;

    if (ageColIdx !== null && ageColIdx !== undefined){
      const ageTxt = cleanText(r[ageColIdx]);
      const am = ageTxt.match(/(\d+)/);
      if (am) age = parseInt(am[1], 10);
    }
    const v = toNumber(r[colIdx]);
    if (isNaN(v)) return;
    let premium = null;
    if (premiumColIdx !== null && premiumColIdx !== undefined && premiumColIdx >= 0){
      const p = toNumber(r[premiumColIdx]);
      if (!isNaN(p)) premium = p;
    }
    rows.push({ year, age, value: v, premium });
  });
  return rows;
}

/* ---------- Merge Year-rows + At-age-rows into one sorted series with age offset resolution ---------- */
function resolveAgeOffset(rowsWithYear, rowsWithAge, compareKeys){
  for (const ar of rowsWithAge){
    for (const yr of rowsWithYear){
      let match = true;
      for (const k of compareKeys){
        const a = ar[k], b = yr[k];
        if (a === undefined || b === undefined) continue;
        if (Math.abs((a || 0) - (b || 0)) > 0.5) { match = false; break; } // these are duplicate rows in the source doc — expect exact match
      }
      if (match) return ar.age - yr.year;
    }
  }
  return null;
}

function mergeRows(rows, valueKeys){
  const withYear = rows.filter(r => r.year !== null);
  const withAgeOnly = rows.filter(r => r.year === null && r.age !== null);
  const offset = resolveAgeOffset(withYear, withAgeOnly, valueKeys);

  const byYear = new Map();
  withYear.forEach(r => { if (!byYear.has(r.year)) byYear.set(r.year, r); });
  if (offset !== null){
    withAgeOnly.forEach(r => {
      const y = r.age - offset;
      if (!byYear.has(y)) byYear.set(y, Object.assign({}, r, { year: y }));
    });
  }
  const merged = Array.from(byYear.values()).sort((a, b) => a.year - b.year);
  merged.forEach(r => { if (r.age === null || r.age === undefined) r.age = (offset !== null ? r.year + offset : null); });
  return merged;
}

function seriesAgeOffset(series){
  if (!series || !series.years || !series.ages) return null;
  for (let i = 0; i < series.years.length; i++){
    const y = series.years[i], a = series.ages[i];
    if (y !== null && y !== undefined && a !== null && a !== undefined && !isNaN(y) && !isNaN(a)){
      return a - y;
    }
  }
  return null;
}
function seriesAgesAllMissing(series){
  if (!series || !series.years || !series.years.length) return false;
  if (!series.ages || !series.ages.length) return true;
  return series.ages.every(a => a === null || a === undefined);
}
/* Last-resort age fill: only when a series has years but no Age column, no
   "At age X" rows, and no sibling series on the same product yielded an offset.
   age = issueAge + year (age-nearest-birthday convention). Never invent an age
   if issueAge itself is missing. Never overwrite a series that already has ages. */
function fillMissingSeriesAges(result){
  const issueAge = result && result.meta ? result.meta.issueAge : null;
  const all = [result.sv, result.db, result.svWithdrawal, result.dbWithdrawal].filter(Boolean);
  all.forEach(series => {
    if (!seriesAgesAllMissing(series)) return;
    let offset = null;
    all.forEach(sib => {
      if (sib === series || offset !== null) return;
      offset = seriesAgeOffset(sib);
    });
    if (offset === null && issueAge !== null && issueAge !== undefined && !isNaN(issueAge)){
      offset = issueAge;
    }
    if (offset === null) return;
    series.ages = series.years.map((y, i) => {
      const existing = series.ages && series.ages[i];
      if (existing !== null && existing !== undefined) return existing;
      if (y === null || y === undefined) return null;
      return offset + y;
    });
  });
}

/* ---------- Header signature for continuation-table grouping ---------- */
function stripZoneWords(text){
  return text
    .replace(/surrender value/gi, '')
    .replace(/death benefit/gi, '')
    .replace(/pessimistic scenario/gi, '')
    .replace(/optimistic scenario/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function headerSignature(colHeaders, range){
  return colHeaders.slice(range[0], range[1] + 1).map(h => normHeader(stripZoneWords(h))).join('|');
}

/* ---------- Metadata (best-effort) ---------- */
function extractMetadata(rawText, docEl){
  const meta = {};
  let m;
  m = rawText.match(/Age (?:Nearest Birthday|Last Birthday)\s*:?\s*(\d+)/i);
  if (m) meta.issueAge = parseInt(m[1], 10);
  if (meta.issueAge == null){
    m = rawText.match(/Age\s*\S{0,6}\s*:\s*(\d{1,3})\s*Sex\b/i);
    if (m){
      const n = parseInt(m[1], 10);
      if (n >= 0 && n < 120) meta.issueAge = n;
    }
  }
  m = rawText.match(/Total Initial Annual Premium[^:]*:\s*\$?\s*([\d,\.]+)/i);
  if (m) meta.annualPremium = m[1];
  m = rawText.match(/Proposal Summary for\s+([^\n]+)/i);
  if (m) meta.planName = cleanText(m[1]).replace(/\(the.*$/i,'').trim();

  const tables = Array.from(docEl.querySelectorAll('table'));
  // Insured name: find a cell containing the label, then look same-row-next-cell or next-row-same-col
  for (const t of tables){
    const { grid, maxCols } = normalizeTable(t);
    let found = false;
    for (let r = 0; r < grid.length && !found; r++){
      for (let c = 0; c < maxCols; c++){
        if (/name of life insured/i.test(grid[r][c] || '')){
          const sameRowNext = cleanText(grid[r][c+1] || '');
          const nextRowSame = grid[r+1] ? cleanText(grid[r+1][c] || '') : '';
          const candidate = (sameRowNext && !/:$/.test(sameRowNext) && !/^(age|sex)\b/i.test(sameRowNext)) ? sameRowNext
                           : (nextRowSame && !/:$/.test(nextRowSame)) ? nextRowSame : '';
          if (candidate){ meta.insuredName = candidate; found = true; break; }
        }
      }
    }
    if (found) break;
  }
  if (!meta.planName){
    for (const t of tables){
      const { grid } = normalizeTable(t);
      const headerRowIdx = grid.findIndex(r => r.some(c => /benefit description/i.test(c)));
      if (headerRowIdx >= 0 && grid[headerRowIdx + 1]){
        const colIdx = grid[headerRowIdx].findIndex(c => /benefit description/i.test(c));
        let val = cleanText(grid[headerRowIdx + 1][colIdx]).replace(/^basic plan\s*/i, '');
        val = val.split(/\bprepared for\b/i)[0].trim();
        if (val.length > 80) val = val.slice(0, 80).trim();
        if (val) { meta.planName = val; break; }
      }
    }
  }
  return meta;
}

/* ---------- Premium Prepayment info (e.g. Chubb "Illustration of Premiums and Insurance
   Levy Prepayment"): find labeled key/value rows in a table and extract the numeric value.
   Only used to build the "Prepayment" XIRR scenario when a document offers it. ---------- */
function findLabeledValueInTables(docEl, labelPatterns){
  const tables = Array.from(docEl.querySelectorAll('table'));
  const out = {};
  for (const t of tables){
    const { grid, maxCols } = normalizeTable(t);
    for (let r = 0; r < grid.length; r++){
      const rowText = grid[r].join(' ');
      for (const key in labelPatterns){
        if (out[key] !== undefined) continue;
        if (labelPatterns[key].test(rowText)){
          // value = the LARGEST numeric-looking cell in this row — avoids accidentally
          // picking up a small footnote/reference number (e.g. a stray "(1)"/"(2)" marker
          // sitting in its own cell) instead of the actual dollar figure.
          let best = null;
          for (let c = 0; c < maxCols; c++){
            const cellText = cleanText(grid[r][c]);
            if (/^\$?\s*[\d,]+(\.\d+)?$/.test(cellText)){
              const v = toNumber(cellText);
              if (!isNaN(v) && (best === null || v > best)) best = v;
            }
          }
          if (best !== null) out[key] = best;
        }
      }
    }
  }
  return out;
}

function extractPrepaymentInfo(docEl, rawText){
  // Any real prepayment lump sum is at least this large — guards against accidentally
  // grabbing a stray footnote/reference number (like a bare "(2)") as the value.
  const MIN_PLAUSIBLE = 100;

  // Priority 1: "Adjusted Final Amount" — the final lump sum after any promotional rebate
  // (e.g. SunJoy's "Basic Rebate" deducted from the prepayment total). Never computed by us —
  // always read directly from what the document itself prints.
  const adjusted = findLabeledValueInTables(docEl, { val: /adjusted final amount/i });
  if (adjusted.val !== undefined && adjusted.val >= MIN_PLAUSIBLE) return { lumpSum: adjusted.val, source: 'adjusted' };
  let m = rawText.match(/Adjusted Final Amount[^:]*:?\s*\$?\s*([\d,]+\.?\d*)/i);
  if (m){
    const v = toNumber(m[1]);
    if (!isNaN(v) && v >= MIN_PLAUSIBLE) return { lumpSum: v, source: 'adjusted' };
  }

  // Priority 2: a single "Total Prepayment" figure that already covers every premium year
  // (SunJoy-style wording: "Total Prepayment# (1)+(2)") — used directly as the lump sum,
  // not added to anything else.
  const totalPrepay = findLabeledValueInTables(docEl, { val: /total prepayment\b/i });
  if (totalPrepay.val !== undefined && totalPrepay.val >= MIN_PLAUSIBLE) return { lumpSum: totalPrepay.val, source: 'totalPrepayment' };
  m = rawText.match(/Total Prepayment\b[^:]*:?\s*\$?\s*([\d,]+\.?\d*)/i);
  if (m){
    const v = toNumber(m[1]);
    if (!isNaN(v) && v >= MIN_PLAUSIBLE) return { lumpSum: v, source: 'totalPrepayment' };
  }

  // Priority 3 (fallback): Chubb-style wording — year 1 is paid normally, and a separate
  // deposit fund prepays only the remaining years, so the two must be added together.
  const found = findLabeledValueInTables(docEl, {
    year1Payment: /total initial annual premium(?:\s+and\s+insurance\s+levy)?\s+of\s+your\s+policy\b/i,
    prepaidAmount: /total prepaid amount/i
  });
  if (found.year1Payment !== undefined && found.prepaidAmount !== undefined &&
      found.year1Payment >= MIN_PLAUSIBLE && found.prepaidAmount >= MIN_PLAUSIBLE){
    return {
      year1Payment: found.year1Payment,
      prepaidAmount: found.prepaidAmount,
      lumpSum: found.year1Payment + found.prepaidAmount,
      source: 'chubb'
    };
  }

  // Zurich-style: "Prepaid premium (for 2nd–5th policy year)" plus
  // "Total amount to be paid" as the actual out-of-pocket prepayment total.
  function matchUsdAmount(text, pattern){
    const mm = (text || '').match(pattern);
    if (!mm) return null;
    const v = toNumber(mm[1]);
    return (!isNaN(v) && v >= MIN_PLAUSIBLE) ? v : null;
  }
  const zurichTotal = matchUsdAmount(rawText, /Total amount to be paid[^$]{0,60}USD\s*([\d,]+\.?\d*)/i) ||
    findLabeledValueInTables(docEl, { val: /total amount to be paid/i }).val;
  const zurichPrepaid = matchUsdAmount(rawText, /Prepaid premium\s*\([^)]{0,80}policy year[^)]*\)[^$]{0,60}USD\s*([\d,]+\.?\d*)/i);
  const zurichAnnual = matchUsdAmount(rawText, /Total initial annual premium[^$]{0,60}USD\s*([\d,]+\.?\d*)/i);
  if (zurichTotal !== null && zurichTotal !== undefined && zurichTotal >= MIN_PLAUSIBLE){
    return {
      lumpSum: zurichTotal,
      prepaidAmount: zurichPrepaid,
      year1Payment: zurichAnnual,
      source: 'zurich'
    };
  }
  return null;
}

/* ---------- Dual-basis UL (Guaranteed Basis vs Current Assumed Basis) ----------
   SunRise-style illustrations print two full annual tables with identical
   Account/Surrender/Death headers. They must stay separate series — grouping
   only by column-header signature would merge them. */
function detectBasisFromText(text){
  const t = (text || '').toLowerCase();
  if (!t) return null;
  if (/illustration\s+summary/.test(t) || (/basic\s+plan/.test(t) && /illustration/.test(t) && t.length < 200)) return 'summary';
  if (/pessimistic|optimistic/.test(t)) return 'sensitivity';
  if (/conservative\s+(basis|scenario)/.test(t)) return 'conservative';
  if (/current\s+assumed/.test(t)) return 'currentAssumed';
  if (/guaranteed\s+basis/.test(t)) return 'guaranteed';
  return null;
}
function isSensitivityHeader(text){
  return /pessimistic|optimistic/.test((text || '').toLowerCase());
}
function hasPrimaryBasisHeader(text){
  const t = (text || '').toLowerCase();
  return /conservative\s+(basis|scenario)/.test(t) || /current\s+assumed/.test(t) || /guaranteed\s+basis/.test(t);
}
function findInlineWithdrawalCol(colHeaders){
  const perYear = findHeaderCol(colHeaders, (t, raw) => {
    const lh = String(raw || t || '').toLowerCase();
    if (lh.includes('cumulative') || lh.includes('aggregated')) return false;
    return /withdrawal for that policy year/.test(lh) ||
      /amount of withdrawal/.test(lh) || headerHas(t, 'amountofwithdrawalmade') ||
      (headerHas(t, 'withdrawal') && headerHas(t, 'made'));
  });
  if (perYear >= 0) return perYear;
  return findHeaderCol(colHeaders, (t, raw) => {
    const lh = String(raw || t || '').toLowerCase();
    return /aggregated/.test(lh) && /withdrawal/.test(lh);
  });
}
function findAggregatedWithdrawalCol(colHeaders){
  return findHeaderCol(colHeaders, (t, raw) => {
    const lh = String(raw || t || '').toLowerCase();
    if (/aggregated/.test(lh) && /withdrawal/.test(lh)) return true;
    return headerHas(t, 'cumulative') && headerHas(t, 'withdrawal') &&
      !headerHas(t, 'surrender') && !t.includes('+');
  });
}
/* GCV^^ / GCV## is Chubb's withdrawal-table abbreviation of Guaranteed Cash Value.
   Only used after an inline withdrawal column has already been found — never as a
   global substitute for the word "guaranteed". */
function isGcvGuaranteedHeader(h){
  const lh = (h || '').toLowerCase();
  if (lh.includes('non-guaranteed') || lh.includes('non guaranteed')) return false;
  if (/sum\s+of\s+gcv/.test(lh) || /gcv\s*\+/.test(lh)) return false;
  return /\bgcv\b/.test(lh) || /gcv[\^#]+/.test(lh);
}
function findGuaranteedColsForInlineWithdrawal(colHeaders){
  const out = findGuaranteedCols(colHeaders);
  if (out.length) return out;
  (colHeaders || []).forEach((h, idx) => {
    if ((h || '').length > 60) return;
    if (isGcvGuaranteedHeader(h)) out.push(idx);
  });
  return out;
}
function attachInlineWithdrawalFields(rows, dataRows, colHeaders, inlineWdCol, yearCol){
  if (!rows || inlineWdCol < 0) return rows;
  const cumCol = findAggregatedWithdrawalCol(colHeaders);
  const notionalCol = findHeaderCol(colHeaders, (t, raw) => {
    const lh = String(raw || t || '').toLowerCase();
    return /notional/.test(lh) && !/withdrawal/.test(lh);
  });
  const byYear = new Map();
  (dataRows || []).forEach(r => {
    const label = cleanText(r[yearCol === undefined ? 0 : yearCol]);
    if (!/^\d+$/.test(label)) return;
    const year = parseInt(label, 10);
    const cash = toNumber(r[inlineWdCol]);
    const cum = cumCol >= 0 ? toNumber(r[cumCol]) : NaN;
    const notional = notionalCol >= 0 ? toNumber(r[notionalCol]) : NaN;
    byYear.set(year, {
      cashWithdrawal: isNaN(cash) ? 0 : cash,
      cumulativeWithdrawal: isNaN(cum) ? 0 : cum,
      notionalAfterWithdrawal: isNaN(notional) ? null : notional
    });
  });
  rows.forEach(row => {
    const extra = byYear.get(row.year);
    if (!extra) return;
    row.cashWithdrawal = extra.cashWithdrawal;
    row.cumulativeWithdrawal = extra.cumulativeWithdrawal;
    if (extra.notionalAfterWithdrawal !== null) row.notionalAfterWithdrawal = extra.notionalAfterWithdrawal;
    row.fromInlineWithdrawal = true;
  });
  return rows;
}
function findFlatMetricGroups(colHeaders){
  const avs = [], svs = [], dbs = [];
  (colHeaders || []).forEach((h, idx) => {
    const lh = (h || '').toLowerCase();
    if (lh.includes('account value')) avs.push(idx);
    if (lh.includes('surrender value')) svs.push(idx);
    if (lh.includes('death benefit')) dbs.push(idx);
  });
  const n = Math.max(avs.length, svs.length, dbs.length);
  const groups = [];
  for (let i = 0; i < n; i++){
    const av = avs[i] !== undefined ? avs[i] : -1;
    const sv = svs[i] !== undefined ? svs[i] : -1;
    const db = dbs[i] !== undefined ? dbs[i] : -1;
    const headerBits = [av, sv, db].filter(c => c >= 0).map(c => colHeaders[c]).join(' ');
    const basis = detectBasisFromText(headerBits);
    if (basis === 'sensitivity') continue;
    groups.push({ av, sv, db, basis: basis || 'single', headerBits });
  }
  return groups;
}
function nearestBasisMarker(tableEl){
  let el = tableEl ? tableEl.previousElementSibling : null;
  let hops = 0;
  while (el && hops < 16){
    hops++;
    const text = cleanText(el.textContent || '');
    if (el.tagName === 'TABLE'){
      const cells = el.querySelectorAll('td,th');
      if (cells.length > 12) break;
    }
    if (text && text.length < 600){
      const basis = detectBasisFromText(text);
      if (basis) return basis;
    }
    el = el.previousElementSibling;
  }
  return null;
}
function countFlatMetricCols(colHeaders){
  let av = 0, sv = 0, db = 0;
  (colHeaders || []).forEach(h => {
    const lh = (h || '').toLowerCase();
    if (lh.includes('account value')) av++;
    if (lh.includes('surrender value')) sv++;
    if (lh.includes('death benefit')) db++;
  });
  return { av, sv, db };
}
function countDistinctPolicyYears(dataRows, yearCol){
  const col = yearCol === undefined ? 0 : yearCol;
  const years = (dataRows || []).map(r => parseInt(cleanText(r[col]), 10)).filter(y => y > 0);
  return new Set(years).size;
}
function isSideBySideBasisSummary(colHeaders, dataRows, yearCol){
  const n = countFlatMetricCols(colHeaders);
  if (n.av < 2 || n.sv < 2) return false;
  return countDistinctPolicyYears(dataRows, yearCol) < 8;
}
/* Heading text like "N. Basic Plan – Illustration Summary" is insurer boilerplate
   on full annual tables as well as on sparse milestone blurbs. Only treat a table
   as a skippable summary when the table itself is short. */
function isHonoredSummaryTable(nearBasis, headerBasis, distinctYears){
  return (nearBasis === 'summary' || headerBasis === 'summary') && distinctYears < 8;
}
/* Prepaid-premium / projected-interest breakdowns sometimes contain the word
   "guaranteed" in a short column. They are not PAR SV/DB zones. */
function isPrepaidPremiumInfoTable(fullHeaderLower){
  const t = fullHeaderLower || '';
  if (!/prepaid\s*premium|projected\s+interest/.test(t)) return false;
  return !/surrender\s+value|death\s+benefit|\bgcv\b/.test(t);
}
function looksLikeParIllustrationTable(colHeaders, dataRows, yearCol, fullHeaderLower){
  if (isPrepaidPremiumInfoTable(fullHeaderLower)) return false;
  if (countDistinctPolicyYears(dataRows, yearCol) >= 8) return true;
  const metricCols = (colHeaders || []).filter(h => {
    const lh = (h || '').toLowerCase();
    return /surrender\s+value|death\s+benefit|guaranteed\s+cash|\bgcv\b|reversionary|terminal\s+bonus/.test(lh);
  }).length;
  return metricCols >= 3;
}
function extractAssumedCreditingRate(rawText){
  const t = rawText || '';
  const patterns = [
    /crediting\s+interest\s+rate\s+since[^%]{0,80}?(\d+(?:\.\d+)?)\s*%/i,
    /current\s+assumed(?:\s+basis)?[^%]{0,160}?crediting\s+interest\s+rate[^%]{0,80}?(\d+(?:\.\d+)?)\s*%/i,
    /assumed\s+crediting(?:\s+interest)?\s+rate[^%]{0,60}?(\d+(?:\.\d+)?)\s*%/i
  ];
  for (let i = 0; i < patterns.length; i++){
    const m = t.match(patterns[i]);
    if (m){
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > 0 && n < 50) return n;
    }
  }
  return null;
}
function rowsToYearMap(rows, valueKey){
  const m = new Map();
  (rows || []).forEach(r => {
    if (r.year !== null && r.year !== undefined && !m.has(r.year)) m.set(r.year, r[valueKey]);
  });
  return m;
}
function premiumYearMap(rows){
  const m = new Map();
  (rows || []).forEach(r => {
    if (r.year !== null && r.premium !== null && r.premium !== undefined && !m.has(r.year)) m.set(r.year, r.premium);
  });
  return m;
}
function buildFlatAxis(entries){
  const all = [];
  entries.forEach(entry => {
    if (!entry) return;
    ['av','sv','db'].forEach(k => { if (entry[k] && entry[k].length) all.push(...entry[k]); });
  });
  if (!all.length) return { years: [], ages: [] };
  const source = all;
  const merged = mergeRows(source.map(r => Object.assign({}, r)), ['value']);
  return { years: merged.map(r => r.year), ages: merged.map(r => r.age) };
}
function seriesFromMap(years, map){
  return years.map(y => map.has(y) ? map.get(y) : null);
}
function runningWithdrawalSum(years, wdMap){
  let run = 0;
  return years.map(y => {
    const v = wdMap.has(y) ? wdMap.get(y) : 0;
    if (v !== null && v !== undefined && !isNaN(v)) run += v;
    return run;
  });
}
function assembleFlatPair(lowEntry, assumedEntry, lowKind, withWithdrawal){
  const entries = [lowEntry, assumedEntry].filter(Boolean);
  const { years, ages } = buildFlatAxis(entries);
  const assumedSrc = assumedEntry || lowEntry;
  const avMap = rowsToYearMap(assumedSrc.av, 'value');
  const svMap = rowsToYearMap(assumedSrc.sv, 'value');
  const dbMap = rowsToYearMap(assumedSrc.db, 'value');
  const pSrc = assumedSrc.sv && assumedSrc.sv.length ? assumedSrc.sv
    : (assumedSrc.av && assumedSrc.av.length ? assumedSrc.av : assumedSrc.db);
  const pMap = premiumYearMap(pSrc);
  const sv = {
    years, ages,
    accountValue: seriesFromMap(years, avMap),
    surrenderValue: seriesFromMap(years, svMap),
    premium: seriesFromMap(years, pMap)
  };
  const db = {
    years, ages,
    deathBenefit: seriesFromMap(years, dbMap),
    premium: seriesFromMap(years, pMap)
  };
  if (lowEntry && assumedEntry && lowKind){
    const lAv = rowsToYearMap(lowEntry.av, 'value');
    const lSv = rowsToYearMap(lowEntry.sv, 'value');
    const lDb = rowsToYearMap(lowEntry.db, 'value');
    const aAv = rowsToYearMap(assumedEntry.av, 'value');
    const aSv = rowsToYearMap(assumedEntry.sv, 'value');
    const aDb = rowsToYearMap(assumedEntry.db, 'value');
    sv[lowKind] = { accountValue: seriesFromMap(years, lAv), surrenderValue: seriesFromMap(years, lSv) };
    sv.currentAssumed = { accountValue: seriesFromMap(years, aAv), surrenderValue: seriesFromMap(years, aSv) };
    db[lowKind] = { deathBenefit: seriesFromMap(years, lDb) };
    db.currentAssumed = { deathBenefit: seriesFromMap(years, aDb) };
  }
  if (withWithdrawal){
    const wdSrc = (assumedEntry && assumedEntry.wd && assumedEntry.wd.length) ? assumedEntry.wd
      : (lowEntry && lowEntry.wd) ? lowEntry.wd : [];
    const wdMap = rowsToYearMap(wdSrc, 'value');
    const cash = seriesFromMap(years, wdMap).map(v => (v === null ? 0 : v));
    sv.cashWithdrawal = cash;
    db.cashWithdrawal = cash.slice();
    sv.cumulativeWithdrawal = runningWithdrawalSum(years, wdMap);
    db.cumulativeWithdrawal = sv.cumulativeWithdrawal.slice();
  }
  return { sv, db };
}

function withdrawalAmountPositive(v){
  return v !== null && v !== undefined && !isNaN(v) && Number(v) > 0;
}
function numericDisagree(a, b){
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (isNaN(a) || isNaN(b)) return false;
  return Math.abs(Number(a) - Number(b)) > 0.5;
}
function noteZeroWdDisagreement(notes, msg){
  notes.push(msg);
  if (typeof console !== 'undefined' && console.warn) console.warn('zero-wd merge disagreement', msg);
}
/* Years on a withdrawal-scenario table whose inline withdrawal is 0 / blank / "-"
   are genuine No-Withdrawal observations. Merge those into the base series for
   years the sparse milestone table does not already print. On overlap, keep the
   milestone value if the two disagree. */
function zeroWithdrawalYearsFromFlatEntry(entry){
  const positive = new Set();
  (entry && entry.wd || []).forEach(r => {
    if (r.year != null && withdrawalAmountPositive(r.value)) positive.add(r.year);
  });
  const years = new Set();
  ['av', 'sv', 'db'].forEach(k => {
    ((entry && entry[k]) || []).forEach(r => {
      if (r.year != null && !positive.has(r.year)) years.add(r.year);
    });
  });
  return years;
}
function mergeFlatMetricRows(baseRows, wdRows, zeroYears, notes, label){
  if (!baseRows || !wdRows) return;
  const byYear = new Map();
  baseRows.forEach(r => { if (r.year != null && !byYear.has(r.year)) byYear.set(r.year, r); });
  wdRows.forEach(r => {
    if (r.year == null || !zeroYears.has(r.year)) return;
    const existing = byYear.get(r.year);
    if (!existing){
      baseRows.push({ year: r.year, age: r.age, value: r.value, premium: r.premium });
      byYear.set(r.year, r);
      return;
    }
    if (numericDisagree(existing.value, r.value)){
      noteZeroWdDisagreement(notes, label + ' Y' + r.year + ' base=' + existing.value + ' annual=' + r.value);
    }
  });
}
function enrichFlatBaseFromZeroWithdrawal(flatCandidates){
  const notes = [];
  const byBasis = {};
  Object.keys(flatCandidates || {}).forEach(k => {
    const e = flatCandidates[k];
    if (!e || e.basis === 'sensitivity' || e.basis === 'summary') return;
    if (!byBasis[e.basis]) byBasis[e.basis] = {};
    byBasis[e.basis][e.hasWithdrawal ? 'wd' : 'base'] = e;
  });
  Object.keys(byBasis).forEach(basis => {
    const pair = byBasis[basis];
    if (!pair.wd) return;
    if (!pair.base){
      pair.base = { av: [], sv: [], db: [], wd: [], basis, hasWithdrawal: false };
      flatCandidates[basis + '||base'] = pair.base;
    }
    const zeroYears = zeroWithdrawalYearsFromFlatEntry(pair.wd);
    ['av', 'sv', 'db'].forEach(k => {
      mergeFlatMetricRows(pair.base[k], pair.wd[k], zeroYears, notes, basis + ' ' + k);
    });
  });
  return notes;
}
function mergeZeroWdParIntoBase(baseRows, wdRows, notes, label){
  if (!wdRows || !wdRows.length) return baseRows;
  const out = (baseRows || []).slice();
  const byYear = new Map();
  out.forEach(r => { if (r.year != null && !byYear.has(r.year)) byYear.set(r.year, r); });
  wdRows.forEach(r => {
    if (!r.fromInlineWithdrawal) return;
    if (r.year == null || withdrawalAmountPositive(r.cashWithdrawal)) return;
    const existing = byYear.get(r.year);
    if (!existing){
      const copy = {
        year: r.year, age: r.age,
        guaranteed: r.guaranteed, nonGuaranteed: r.nonGuaranteed, total: r.total,
        premium: r.premium
      };
      out.push(copy);
      byYear.set(r.year, copy);
      return;
    }
    if (numericDisagree(existing.guaranteed, r.guaranteed) || numericDisagree(existing.total, r.total)){
      noteZeroWdDisagreement(notes, label + ' Y' + r.year +
        ' baseG=' + existing.guaranteed + ' annualG=' + r.guaranteed +
        ' baseT=' + existing.total + ' annualT=' + r.total);
    }
  });
  return out;
}

/* ---------- Main parser: given mammoth HTML string, extract SV/DB series ---------- */
function parseIllustrationHtml(html, rawText){
  const parser = new DOMParser();
  const doc = parser.parseFromString('<div>' + html + '</div>', 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));

  // candidate groups keyed by signature -> {kind, rows:[], colHeaders, meta...}
  const svCandidates = {};
  const dbCandidates = {};
  const svWithdrawalCandidates = {};
  const dbWithdrawalCandidates = {};
  const flatCandidates = {}; // for UL: {key: {av:[], sv:[], db:[], basis}}

  tables.forEach(tableEl => {
    const { grid, maxCols } = normalizeTable(tableEl);
    if (maxCols < 3 || grid.length < 2) return;
    const { headerRows, dataRows: dataRowsRaw } = splitHeaderData(grid);
    if (dataRowsRaw.length === 0 || headerRows.length === 0) return;
    let colHeaders = columnHeaders(headerRows, maxCols);
    let dataRows = dataRowsRaw;
    const fullHeaderLower = colHeaders.join(' ').toLowerCase();
    const nearBasis = nearestBasisMarker(tableEl);
    const yearCol = 0;
    const distinctYears = countDistinctPolicyYears(dataRows, yearCol);
    const headerBasis = detectBasisFromText(fullHeaderLower);
    if (isHonoredSummaryTable(nearBasis, headerBasis, distinctYears) || isSideBySideBasisSummary(colHeaders, dataRows, yearCol)) return;
    if (isSensitivityHeader(fullHeaderLower) && !hasPrimaryBasisHeader(fullHeaderLower)) return;
    function locateAgeCol(headers){
      let idx = null;
      headers.forEach((h, i) => {
        if (i !== yearCol && /\bage\b/i.test(h) && !/at\s*age/i.test(h)) { if (idx === null) idx = i; }
      });
      return idx;
    }

    // "… AFTER CASH WITHDRAWAL" is a parallel scenario on the same policy — parse
    // it separately. Tables that only mention withdrawal without an inline
    // per-year / aggregated column (cash-withdrawal-amount breakdowns) are skipped.
    if (isAfterCashWithdrawalHeader(fullHeaderLower)){
      const collapsed = collapseDuplicateHeaderColumns(colHeaders, dataRows);
      colHeaders = collapsed.colHeaders;
      dataRows = collapsed.dataRows;
      const ageColIdx = locateAgeCol(colHeaders);
      const premiumColIdx = findPremiumCol(colHeaders, 0, colHeaders.length - 1);
      const isDb = fullHeaderLower.includes('death benefit');
      const isSv = fullHeaderLower.includes('surrender value');
      const kind = (isDb && !isSv) ? 'db' : 'sv';
      const rows = extractWithdrawalZone(dataRows, colHeaders, kind, yearCol, ageColIdx, premiumColIdx);
      const sig = headerSignature(colHeaders, [0, colHeaders.length - 1]);
      const bucket = kind === 'db' ? dbWithdrawalCandidates : svWithdrawalCandidates;
      if (!bucket[sig]) bucket[sig] = [];
      bucket[sig].push(...rows);
      return;
    }
    const inlineWdCol = findInlineWithdrawalCol(colHeaders);
    if (fullHeaderLower.includes('withdrawal') && inlineWdCol < 0) return;

    const ageColIdx = locateAgeCol(colHeaders);
    const premiumColIdx = findPremiumCol(colHeaders, 0, maxCols - 1);

    const guarCols = inlineWdCol >= 0
      ? findGuaranteedColsForInlineWithdrawal(colHeaders)
      : findGuaranteedCols(colHeaders);
    const parEligible = guarCols.length >= 1 && looksLikeParIllustrationTable(colHeaders, dataRows, yearCol, fullHeaderLower);

    if (parEligible && guarCols.length >= 2){
      // Combined table: zone1 = SV (before 2nd guaranteed marker), zone2 = DB (from 2nd marker to end)
      const zone1End = guarCols[1] - 1;
      const zone2End = maxCols - 1;
      const svRows = extractParZone(dataRows, colHeaders, guarCols[0], zone1End, yearCol, ageColIdx, premiumColIdx);
      const dbRows = extractParZone(dataRows, colHeaders, guarCols[1], zone2End, yearCol, ageColIdx, premiumColIdx);
      if (inlineWdCol >= 0){
        attachInlineWithdrawalFields(svRows, dataRows, colHeaders, inlineWdCol, yearCol);
        attachInlineWithdrawalFields(dbRows, dataRows, colHeaders, inlineWdCol, yearCol);
      }
      const sig1 = headerSignature(colHeaders, [0, zone1End]);
      const sig2 = headerSignature(colHeaders, [guarCols[1], zone2End]);
      const svBucket = inlineWdCol >= 0 ? svWithdrawalCandidates : svCandidates;
      const dbBucket = inlineWdCol >= 0 ? dbWithdrawalCandidates : dbCandidates;
      if (!svBucket[sig1]) svBucket[sig1] = [];
      svBucket[sig1].push(...svRows);
      if (!dbBucket[sig2]) dbBucket[sig2] = [];
      dbBucket[sig2].push(...dbRows);
    } else if (parEligible && guarCols.length === 1){
      const zoneEnd = maxCols - 1;
      const rows = extractParZone(dataRows, colHeaders, guarCols[0], zoneEnd, yearCol, ageColIdx, premiumColIdx);
      if (inlineWdCol >= 0) attachInlineWithdrawalFields(rows, dataRows, colHeaders, inlineWdCol, yearCol);
      const sig = headerSignature(colHeaders, [0, zoneEnd]);
      const isDb = fullHeaderLower.includes('death benefit');
      const isSv = fullHeaderLower.includes('surrender value');
      const bucket = (isDb && !isSv)
        ? (inlineWdCol >= 0 ? dbWithdrawalCandidates : dbCandidates)
        : (inlineWdCol >= 0 ? svWithdrawalCandidates : svCandidates);
      if (!bucket[sig]) bucket[sig] = [];
      bucket[sig].push(...rows);
    } else {
      // Flat UL-style: Account / Surrender / Death Benefit. Side-by-side dual-basis
      // tables (Zurich) are split into one candidate per column group, using only
      // that group's header text for the basis tag — never the whole joined header.
      const groups = findFlatMetricGroups(colHeaders);
      const hasWd = inlineWdCol >= 0;
      groups.forEach(group => {
        let basis = group.basis;
        if (basis === 'single' && (nearBasis === 'guaranteed' || nearBasis === 'currentAssumed' || nearBasis === 'conservative')){
          basis = nearBasis;
        }
        if (basis === 'sensitivity' || basis === 'summary') return;
        if (group.av < 0 && group.sv < 0 && group.db < 0) return;
        const key = basis + '||' + (hasWd ? 'wd' : 'base');
        if (!flatCandidates[key]) flatCandidates[key] = { av: [], sv: [], db: [], wd: [], basis, hasWithdrawal: hasWd };
        if (group.av !== -1) flatCandidates[key].av.push(...extractFlatSeries(dataRows, group.av, yearCol, ageColIdx, premiumColIdx));
        if (group.sv !== -1) flatCandidates[key].sv.push(...extractFlatSeries(dataRows, group.sv, yearCol, ageColIdx, premiumColIdx));
        if (group.db !== -1) flatCandidates[key].db.push(...extractFlatSeries(dataRows, group.db, yearCol, ageColIdx, premiumColIdx));
        if (hasWd) flatCandidates[key].wd.push(...extractFlatSeries(dataRows, inlineWdCol, yearCol, ageColIdx, premiumColIdx));
      });
    }
  });

  const zeroWdNotes = enrichFlatBaseFromZeroWithdrawal(flatCandidates);

  function pickBest(candidates){
    let best = null, bestLen = 0;
    Object.values(candidates).forEach(rows => {
      const distinctYears = new Set(rows.filter(r => r.year !== null).map(r => r.year)).size +
                             new Set(rows.filter(r => r.year === null && r.age !== null).map(r => r.age)).size;
      if (distinctYears > bestLen){ bestLen = distinctYears; best = rows; }
    });
    return best;
  }
  function pickBestFlat(candidates){
    let best = null, bestScore = -1;
    Object.values(candidates).forEach(entry => {
      const score = entry.av.length + entry.sv.length + entry.db.length;
      if (score > bestScore){ bestScore = score; best = entry; }
    });
    return best;
  }
  function pickBestFlatByBasis(candidates, basis, wantWd){
    const subset = {};
    Object.keys(candidates).forEach(k => {
      const e = candidates[k];
      if (e.basis !== basis) return;
      if (!!e.hasWithdrawal !== !!wantWd) return;
      subset[k] = e;
    });
    return pickBestFlat(subset);
  }
  function pickPrimaryLow(wantWd){
    return pickBestFlatByBasis(flatCandidates, 'guaranteed', wantWd) ||
           pickBestFlatByBasis(flatCandidates, 'conservative', wantWd);
  }
  function entryHasValues(entry){
    return !!(entry && ((entry.sv && entry.sv.length) || (entry.av && entry.av.length)));
  }

  const svWdRowsRaw = pickBest(svWithdrawalCandidates);
  const dbWdRowsRaw = pickBest(dbWithdrawalCandidates);
  const svRowsRaw = mergeZeroWdParIntoBase(pickBest(svCandidates), svWdRowsRaw, zeroWdNotes, 'par-sv');
  const dbRowsRaw = mergeZeroWdParIntoBase(pickBest(dbCandidates), dbWdRowsRaw, zeroWdNotes, 'par-db');
  const flatLowBase = pickPrimaryLow(false);
  const flatAssumedBase = pickBestFlatByBasis(flatCandidates, 'currentAssumed', false);
  const flatLowWd = pickPrimaryLow(true);
  const flatAssumedWd = pickBestFlatByBasis(flatCandidates, 'currentAssumed', true);
  const flatSingle = pickBestFlatByBasis(flatCandidates, 'single', false) || pickBestFlatByBasis(flatCandidates, 'single', true);
  const dualLowKind = (flatLowBase && flatLowBase.basis) || (flatLowWd && flatLowWd.basis) || null;
  const isDualFlat = (entryHasValues(flatLowBase) && entryHasValues(flatAssumedBase)) ||
                     (entryHasValues(flatLowWd) && entryHasValues(flatAssumedWd));
  const flatBest = isDualFlat
    ? (flatAssumedBase || flatAssumedWd)
    : (flatSingle || flatAssumedBase || flatLowBase || flatAssumedWd || flatLowWd);

  const meta = extractMetadata(rawText, doc);
  const prepayment = extractPrepaymentInfo(doc, rawText);

  const result = { type: null, meta, sv: null, db: null, svWithdrawal: null, dbWithdrawal: null, prepayment, dualBasis: false, assumedCreditingRate: null, zeroWdMergeNotes: zeroWdNotes };

  const extraWdKeys = ['cashWithdrawal', 'cumulativeWithdrawal', 'notionalAfterWithdrawal'];
  const extraDbWdKeys = extraWdKeys.concat(['guaranteedCashValue']);

  function buildWithdrawalSeries(rowsRaw, extraKeys){
    if (!rowsRaw || !rowsRaw.length) return null;
    const merged = mergeRows(rowsRaw, ['guaranteed', 'nonGuaranteed', 'total', 'cashWithdrawal', 'cumulativeWithdrawal']);
    return parRowsToSeries(merged, extraKeys);
  }

  const hasParSv = svRowsRaw && svRowsRaw.length > 0;
  const hasParDb = dbRowsRaw && dbRowsRaw.length > 0;
  const hasFlat = flatBest && (flatBest.sv.length > 0 || flatBest.db.length > 0 || flatBest.av.length > 0);

  // Prefer whichever representation has more distinct data points
  const parScore = (hasParSv ? new Set(svRowsRaw.map(r=>r.year!==null?('y'+r.year):('a'+r.age))).size : 0) +
                    (hasParDb ? new Set(dbRowsRaw.map(r=>r.year!==null?('y'+r.year):('a'+r.age))).size : 0);
  const flatScore = hasFlat ? (flatBest.sv.length + flatBest.db.length + flatBest.av.length) : 0;

  if (hasParSv || hasParDb){
    result.type = 'par';
    if (hasParSv){
      const merged = mergeRows(svRowsRaw, ['guaranteed','nonGuaranteed','total']);
      result.sv = {
        years: merged.map(r=>r.year), ages: merged.map(r=>r.age),
        guaranteed: merged.map(r=>r.guaranteed), nonGuaranteed: merged.map(r=>r.nonGuaranteed),
        total: merged.map(r=>r.total), premium: merged.map(r=>r.premium!==undefined?r.premium:null)
      };
    }
    if (hasParDb){
      const merged = mergeRows(dbRowsRaw, ['guaranteed','nonGuaranteed','total']);
      result.db = {
        years: merged.map(r=>r.year), ages: merged.map(r=>r.age),
        guaranteed: merged.map(r=>r.guaranteed), nonGuaranteed: merged.map(r=>r.nonGuaranteed),
        total: merged.map(r=>r.total), premium: merged.map(r=>r.premium!==undefined?r.premium:null)
      };
    }
  } else if (hasFlat){
    result.type = 'flat';
    const baseLow = flatLowBase || (isDualFlat ? flatLowWd : null);
    const baseAssumed = flatAssumedBase || (isDualFlat ? flatAssumedWd : null);
    const assembled = isDualFlat
      ? assembleFlatPair(baseLow, baseAssumed, dualLowKind, false)
      : assembleFlatPair(null, flatBest, null, false);
    result.sv = assembled.sv;
    result.db = assembled.db;
    if (isDualFlat){
      result.dualBasis = true;
      result.dualKind = dualLowKind;
      result.assumedCreditingRate = extractAssumedCreditingRate(rawText);
    }
    if (entryHasValues(flatLowWd) && entryHasValues(flatAssumedWd)){
      const wdPair = assembleFlatPair(flatLowWd, flatAssumedWd, dualLowKind || flatLowWd.basis, true);
      result.svWithdrawal = wdPair.sv;
      result.dbWithdrawal = wdPair.db;
    }
  }

  if (!result.svWithdrawal) result.svWithdrawal = buildWithdrawalSeries(svWdRowsRaw, extraWdKeys);
  if (!result.dbWithdrawal) result.dbWithdrawal = buildWithdrawalSeries(dbWdRowsRaw, extraDbWdKeys);
  if (result.svWithdrawal) overlayPremiumByYear(result.svWithdrawal, result.sv);
  if (result.dbWithdrawal) overlayPremiumByYear(result.dbWithdrawal, result.sv || result.db);
  fillMissingSeriesAges(result);

  return result;
}

/* ===================================================================
   XIRR / Breakeven calculation
   =================================================================== */
/* Solve XIRR for a cash-flow schedule [{t, cf}], t in whole years from issue.
   NPV(r) = sum( cf_t / (1+r)^t ) is monotonically decreasing in r for this
   shape of cash flow (negative outflows early, one positive inflow at the end),
   so bisection over a wide bracket is robust. */
function xirrSolve(cashflows){
  function npv(r){
    return cashflows.reduce((s, cf) => s + cf.cf / Math.pow(1 + r, cf.t), 0);
  }
  let lo = -0.999, hi = 50;
  let fLo = npv(lo), fHi = npv(hi);
  if (isNaN(fLo) || isNaN(fHi)) return null;
  if (fLo * fHi > 0){
    // widen the bracket a bit; if still same sign, give up
    hi = 500;
    fHi = npv(hi);
    if (fLo * fHi > 0) return null;
  }
  for (let i = 0; i < 200; i++){
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if ((fLo < 0) === (fMid < 0)) { lo = mid; fLo = fMid; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}

/* Build the premium payment schedule from a cumulative "Total Premiums Paid" series.
   Infers level annual premium P from the first year's cumulative value, and the
   payment term from where the cumulative value plateaus. */
function inferPremiumSchedule(years, premiums){
  const pts = years.map((y, i) => ({ y, p: premiums[i] })).filter(x => x.p !== null && x.p !== undefined && !isNaN(x.p));
  if (pts.length === 0) return null;
  pts.sort((a, b) => a.y - b.y);
  const first = pts.find(x => x.y === 1) || pts[0];
  const P = first.p / Math.max(1, first.y); // handles rare case where year1 row is missing and first point is year>1 with a lump value
  if (!P || P <= 0) return null;
  const maxCum = Math.max(...pts.map(x => x.p));
  const term = Math.max(1, Math.round(maxCum / P));
  return { P, term };
}

/* Compute XIRR at each year of a merged SV series. Returns array aligned to `years`,
   with null where XIRR could not be computed. */
function computeXirrSeries(years, totalValues, premiums, withdrawals){
  const sched = inferPremiumSchedule(years, premiums);
  if (!sched) return years.map(() => null);
  const { P, term } = sched;
  return years.map((y, i) => {
    const v = totalValues[i];
    if (v === null || v === undefined || isNaN(v) || y === null || y <= 0) return null;
    const npay = Math.min(y, term);
    const cashflows = [];
    for (let t = 0; t < npay; t++) cashflows.push({ t, cf: -P });
    if (withdrawals){
      years.forEach((wy, wi) => {
        if (wy === null || wy === undefined || wy > y) return;
        const w = withdrawals[wi];
        if (w !== null && w !== undefined && !isNaN(w) && w > 0) cashflows.push({ t: wy, cf: w });
      });
    }
    cashflows.push({ t: y, cf: v });
    const r = xirrSolve(cashflows);
    return r === null ? null : r;
  });
}

function findBreakevenYear(years, xirrArr){
  for (let i = 0; i < years.length; i++){
    if (xirrArr[i] !== null && xirrArr[i] >= 0) return years[i];
  }
  return null;
}

/* Same as findBreakevenYear, but linearly interpolates a fractional policy year between
   the last negative data point and the first non-negative one — e.g. "5.8" instead of
   snapping to the whole year 6 — using where the straight line between the two XIRR values
   would cross exactly 0%. Returns null if there's no crossing (or nothing to interpolate). */
function findBreakevenYearInterpolated(years, xirrArr){
  for (let i = 0; i < years.length; i++){
    if (xirrArr[i] !== null && xirrArr[i] !== undefined && xirrArr[i] >= 0){
      if (i === 0) return years[0];
      const prev = xirrArr[i - 1];
      if (prev === null || prev === undefined) return years[i];
      const y1 = years[i - 1], v1 = prev, y2 = years[i], v2 = xirrArr[i];
      if (v2 === v1) return y2;
      const t = (0 - v1) / (v2 - v1);
      return y1 + t * (y2 - y1);
    }
  }
  return null;
}

/* Guaranteed Breakeven: first year the GUARANTEED cash value alone (no bonuses)
   reaches or exceeds cumulative premiums paid — i.e. XIRR of the guaranteed-only
   cash flow reaches 0%. Only meaningful for PAR-style products with a guaranteed
   column. Returns {year, index, guaranteedValue} or null. */
function findGuaranteedBreakeven(years, guaranteedArr, premiums){
  if (!guaranteedArr) return null;
  const sched = inferPremiumSchedule(years, premiums);
  if (!sched) return null;
  const { P, term } = sched;
  for (let i = 0; i < years.length; i++){
    const y = years[i];
    const g = guaranteedArr[i];
    if (y === null || g === null || g === undefined || isNaN(g)) continue;
    const cumPremium = P * Math.min(y, term);
    if (g >= cumPremium) return { year: y, index: i, guaranteedValue: g };
  }
  return null;
}

/* Same as findGuaranteedBreakeven, but linearly interpolates a fractional policy year —
   the point where (Guaranteed − cumulative premium) would cross exactly 0 between the
   last shortfall year and the first year it's covered. Returns {year, guaranteedValue}
   with `year` fractional, or null. */
function findGuaranteedBreakevenInterpolated(years, guaranteedArr, premiums){
  if (!guaranteedArr) return null;
  const sched = inferPremiumSchedule(years, premiums);
  if (!sched) return null;
  const { P, term } = sched;
  let prevY = null, prevDiff = null, prevG = null;
  for (let i = 0; i < years.length; i++){
    const y = years[i];
    const g = guaranteedArr[i];
    if (y === null || g === null || g === undefined || isNaN(g)) continue;
    const cumPremium = P * Math.min(y, term);
    const diff = g - cumPremium;
    if (diff >= 0){
      if (prevDiff === null) return { year: y, guaranteedValue: g };
      const t = (0 - prevDiff) / (diff - prevDiff);
      const yearInterp = prevY + t * (y - prevY);
      const gInterp = prevG + t * (g - prevG);
      return { year: yearInterp, guaranteedValue: gInterp };
    }
    prevY = y; prevDiff = diff; prevG = g;
  }
  return null;
}

/* Pick the data point nearest a target year (used for the "long-term" milestone card,
   e.g. year ~30), preferring an exact match. */
function nearestYearIndex(years, targetYear){
  let bestIdx = -1, bestDiff = Infinity;
  years.forEach((y, i) => {
    const diff = Math.abs(y - targetYear);
    if (diff < bestDiff){ bestDiff = diff; bestIdx = i; }
  });
  return bestIdx;
}

/* ===================================================================
   UI / App state
   =================================================================== */
const state = {
  metric: 'sv', product: 'all', currency: 'usd', rate: 32.50,
  hidden: new Set(), legendTouched: new Set(), fontScale: 1, viewMode: 'compare', xirrProduct: 'p1', xAxisRange: 40,
  scenario: { p1: 'base', p2: 'base' },
  showPrepay: true,
  products: { p1: null, p2: null } // each: {label, type, sv, db, svWithdrawal, dbWithdrawal} once parsed
};

function productHasWithdrawal(p){
  return !!(p && (p.svWithdrawal || p.dbWithdrawal));
}
function productHasPrepayment(p){
  return !!(p && p.prepayment && p.prepayment.lumpSum);
}
function showPrepayCompare(){
  return !!state.showPrepay;
}
function hasVisibleDualBasis(){
  return relevantProductKeys().some(pk => state.products[pk] && state.products[pk].dualBasis);
}
function visibleAssumedCreditingRate(){
  const keys = relevantProductKeys();
  for (let i = 0; i < keys.length; i++){
    const p = state.products[keys[i]];
    if (p && p.dualBasis && p.assumedCreditingRate != null) return p.assumedCreditingRate;
  }
  return null;
}
function dualBasisDisclaimer(longForm){
  const rate = visibleAssumedCreditingRate();
  const rateTxt = (rate != null) ? rate.toFixed(2) + '% ต่อปี' : 'ที่ระบุในเอกสาร';
  const kind = relevantProductKeys().map(pk => dualLowKindOf(state.products[pk])).find(Boolean);
  if (kind === 'conservative'){
    if (longForm){
      return 'เส้น Conservative คือมูลค่าเวนคืน/เงินคุ้มครองที่เอกสารแสดงภายใต้การเครดิต 0% (คิดค่าธรรมเนียมตามปัจจุบัน) ไม่ใช่ภาพ Pessimistic/Optimistic ส่วน Current Assumed ใช้สมมติฐานอัตราเครดิตของเอกสาร (' + rateTxt + ')';
    }
    return 'Conservative = เครดิต 0% · Current Assumed = สมมติฐาน ' + rateTxt;
  }
  if (longForm){
    return 'เส้น Guaranteed ของ Surrender Value / Death Benefit คือตัวการันตีแยก (เช่น CGR) ที่เอกสารพิมพ์ไว้ตรง ๆ ไม่ได้มาจากการเอา Account Value ที่ credit อัตราขั้นต่ำมาหักค่าใช้จ่าย ส่วน Current Assumed ใช้สมมติฐานอัตราเครดิตคงที่ (' + rateTxt + ') ที่บริษัทเลือกมาแสดง ซึ่งอาจต่างจากผลจริงของกรมธรรม์แบบ UL/IUL';
  }
  return 'Guaranteed = การันตี CGR (ไม่ใช่ AV ที่ credit 0%) · Current Assumed = สมมติฐาน ' + rateTxt;
}
function relevantProductKeys(){
  if (state.viewMode === 'xirr') return [state.xirrProduct];
  if (state.product === 'all') return ['p1','p2'].filter(pk => state.products[pk]);
  return [state.product];
}
function resolveProductView(pk){
  const p = state.products[pk];
  if (!p) return null;
  const useWd = (state.scenario[pk] === 'withdrawal') && productHasWithdrawal(p);
  return {
    label: p.label, type: p.type, prepayment: p.prepayment,
    sv: (useWd && p.svWithdrawal) ? p.svWithdrawal : p.sv,
    db: (useWd && p.dbWithdrawal) ? p.dbWithdrawal : p.db,
    svWithdrawal: p.svWithdrawal, dbWithdrawal: p.dbWithdrawal,
    scenario: useWd ? 'withdrawal' : 'base',
    dualBasis: !!p.dualBasis,
    dualKind: p.dualKind || dualLowKindOf(p),
    assumedCreditingRate: p.assumedCreditingRate
  };
}
function lookupSeriesValue(series, key, year){
  if (!series || !series.years || !series[key]) return null;
  const idx = series.years.indexOf(year);
  if (idx === -1) return null;
  const v = series[key][idx];
  return (v === undefined) ? null : v;
}

function productPremiumTotals(view){
  let annual = null;
  const data = getSvSeriesForXirr(view);
  if (data){
    const sched = inferPremiumSchedule(data.years, data.premiums);
    if (sched) annual = sched.P * sched.term;
  }
  const prepay = (view && view.prepayment && view.prepayment.lumpSum) ? view.prepayment.lumpSum : null;
  return { annual, prepay };
}

const NOTIONAL_SOFT_USD = 10000;
const NOTIONAL_HARD_USD = 8000;
const GHOST_LINE_COLOR = 'rgba(120,120,120,0.38)';

function findFirstBelow(years, valuesUsd, thresholdUsd){
  for (let i = 0; i < years.length; i++){
    const v = valuesUsd[i];
    if (v !== null && v !== undefined && !isNaN(v) && v < thresholdUsd){
      return { year: years[i], index: i, value: v };
    }
  }
  return null;
}
function getNotionalUsdAligned(view, years){
  if (!view || view.scenario !== 'withdrawal') return null;
  const nSrc = (view.db && view.db.notionalAfterWithdrawal) ? view.db
             : (view.sv && view.sv.notionalAfterWithdrawal) ? view.sv : null;
  if (!nSrc || !nSrc.notionalAfterWithdrawal) return null;
  return alignToYears(years, nSrc.years, nSrc.ages, nSrc.notionalAfterWithdrawal);
}
function collectNotionalAlerts(years){
  const alerts = [];
  ['p1','p2'].forEach(pk => {
    if (state.product !== 'all' && state.product !== pk) return;
    const view = resolveProductView(pk);
    const aligned = getNotionalUsdAligned(view, years);
    if (!aligned || !aligned.some(v => v !== null && v !== undefined)) return;
    alerts.push({
      pk,
      aligned,
      crossSoft: findFirstBelow(years, aligned, NOTIONAL_SOFT_USD),
      crossHard: findFirstBelow(years, aligned, NOTIONAL_HARD_USD)
    });
  });
  return alerts;
}

const PALETTE = {
  p1: { guaranteed:'#8a5a00', nonGuaranteed:'#e8b96a', total:'#b8860b',
        dbGuaranteed:'#7a2e2e', dbNonGuaranteed:'#e59a86', dbTotal:'#a8412e',
        accountValue:'#8a5a00', surrenderValue:'#c8962c', deathBenefit:'#a8412e' },
  p2: { guaranteed:'#0b3d91', nonGuaranteed:'#9fc1e8', total:'#3d78c9',
        dbGuaranteed:'#1b3a5c', dbNonGuaranteed:'#9ecbef', dbTotal:'#2f6fae',
        accountValue:'#0b3d91', surrenderValue:'#3d78c9', deathBenefit:'#7fb3e0' }
};
/* Dual-basis UL lines: split Guaranteed vs Current Assumed by hue (not dash).
   Dash is reserved for Prepayment vs annual pay. */
const DUAL_BASIS_LINE = {
  p1: { guaranteed:'#2c5f8a', conservative:'#2c5f8a', assumed:'#c8962c' },
  p2: { guaranteed:'#4a8bb5', conservative:'#4a8bb5', assumed:'#d4a24a' }
};
function dualLowKindOf(p){
  if (!p) return null;
  if (p.dualKind) return p.dualKind;
  if (p.sv && p.sv.conservative) return 'conservative';
  if (p.sv && p.sv.guaranteed && p.sv.guaranteed.surrenderValue) return 'guaranteed';
  return null;
}
function dualLowBucket(sv){
  if (!sv) return null;
  if (sv.conservative) return sv.conservative;
  if (sv.guaranteed && sv.guaranteed.surrenderValue && !Array.isArray(sv.guaranteed)) return sv.guaranteed;
  return null;
}

let chart = null;
let wdChart = null;
let datasetConfigs = [];

const SHARED_Y_AXIS_WIDTH = 86;
function pinSharedYAxis(scale){
  scale.width = SHARED_Y_AXIS_WIDTH;
}

/* Custom tooltip positioner: keep the tooltip pinned near the top of the chart area
   (above the data) instead of hovering right on top of the point, so it never
   obscures the bars/line being inspected. Horizontal position still follows the cursor. */
if (window.Chart && Chart.Tooltip && Chart.Tooltip.positioners){
  Chart.Tooltip.positioners.topArea = function(items, eventPosition){
    const chartArea = this.chart.chartArea;
    let x = eventPosition && eventPosition.x !== undefined ? eventPosition.x : (chartArea.left + chartArea.right) / 2;
    x = Math.max(chartArea.left + 10, Math.min(chartArea.right - 10, x));
    return { x, y: chartArea.top + 10 };
  };
  /* For the XIRR line chart: place the tooltip midway between the (topmost) active point
     and the X axis, rather than pinned to the very top — keeps it clear of the line itself. */
  Chart.Tooltip.positioners.midBelowLine = function(items, eventPosition){
    const chartArea = this.chart.chartArea;
    let minY = chartArea.bottom;
    items.forEach(it => { if (it.element && typeof it.element.y === 'number' && it.element.y < minY) minY = it.element.y; });
    const y = minY + (chartArea.bottom - minY) * 0.5;
    let x = eventPosition && eventPosition.x !== undefined ? eventPosition.x : (chartArea.left + chartArea.right) / 2;
    x = Math.max(chartArea.left + 75, Math.min(chartArea.right - 75, x));
    return { x, y };
  };
}

function hexToRgba(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
/* Scriptable bar color: full color for the hovered X-index (or when nothing is hovered),
   faded for every other bar — makes the hovered policy year stand out. */
function scriptableBarColor(hex){
  return (ctx) => {
    const hi = ctx.chart && ctx.chart._hoveredIdx;
    if (hi === null || hi === undefined || ctx.dataIndex === hi) return hex;
    return hexToRgba(hex, 0.25);
  };
}

/* Draws a small permanent label near the last visible point of each "premium paid"
   reference line (instead of relying on the tooltip), color-matched to its line. The
   normal-payment (gray) label sits above its line; the prepayment (purple) label sits
   below its own line, so the two never compete for the same space. */
const premiumLabelPlugin = {
  id: 'premiumLabelPlugin',
  afterDatasetsDraw(c){
    const { ctx, chartArea } = c;
    const entries = [];
    c.data.datasets.forEach((ds, i) => {
    if (!ds.isPremiumRef && !ds.isNotionalRef) return;
      const meta = c.getDatasetMeta(i);
      if (!meta.visible) return;
      let pt = null, val = null;
      for (let j = ds.data.length - 1; j >= 0; j--){
        if (ds.data[j] !== null && ds.data[j] !== undefined && meta.data[j]){ pt = meta.data[j]; val = ds.data[j]; break; }
      }
      if (!pt) return;
      const below = /_premium_prepay$/.test(ds.id) || ds.isNotionalRef;
      let text = `${ds.label}: ${formatMoney(val)}`;
      if (ds.isNotionalRef){
        const usd = ccyMultiplier() ? val / ccyMultiplier() : val;
        if (usd < NOTIONAL_HARD_USD) text += '  ⚠ ต่ำกว่า ' + formatMoney(NOTIONAL_HARD_USD * ccyMultiplier());
        else if (usd < NOTIONAL_SOFT_USD) text += '  ⓘ ต่ำกว่า ' + formatMoney(NOTIONAL_SOFT_USD * ccyMultiplier());
      }
      entries.push({
        x: Math.min(pt.x, chartArea.right - 4),
        y: below ? pt.y + 8 : pt.y - 8,
        below,
        color: ds.borderColor,
        text
      });
    });
    if (!entries.length) return;
    ctx.save();
    ctx.font = '400 16.5px Kanit, Inter, sans-serif';
    ctx.textAlign = 'right';
    entries.forEach(e => {
      ctx.fillStyle = e.color;
      ctx.textBaseline = e.below ? 'top' : 'bottom';
      const y = e.below ? Math.min(e.y, chartArea.bottom - 14) : Math.max(e.y, chartArea.top + 14);
      ctx.fillText(e.text, e.x, y);
    });
    ctx.restore();
  }
};

function renderDomNotionalWarns(containerId, markers){
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.chart-notional-warn').forEach(el => el.remove());
  markers.forEach(m => {
    const div = document.createElement('div');
    div.className = 'chart-notional-warn';
    div.style.left = m.x + 'px';
    div.style.top = m.y + 'px';
    div.innerHTML =
      `<div class="warn-mark"></div>` +
      `<div class="warn-label">${m.label}</div>`;
    container.appendChild(div);
  });
}

/* Amber warning band + crossing marker on the Death Benefit chart once Notional Amount
   After Cash Withdrawal falls below USD 8,000. Distinct from the red/green breakeven flags. */
const notionalAlertPlugin = {
  id: 'notionalAlertPlugin',
  beforeDatasetsDraw(c){
    const alerts = c._notionalAlerts;
    if (state.metric !== 'db' || !alerts || !alerts.length) return;
    const xScale = c.scales.x;
    const { ctx, chartArea } = c;
    ctx.save();
    alerts.forEach(a => {
      if (!a.crossHard) return;
      const x = xScale.getPixelForValue(a.crossHard.index);
      const left = Math.max(chartArea.left, x);
      ctx.fillStyle = 'rgba(232, 93, 4, 0.10)';
      ctx.fillRect(left, chartArea.top, Math.max(0, chartArea.right - left), chartArea.bottom - chartArea.top);
      ctx.strokeStyle = 'rgba(232, 93, 4, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(left, chartArea.top);
      ctx.lineTo(left, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.restore();
  },
  afterDatasetsDraw(c){
    const alerts = c._notionalAlerts;
    if (state.metric !== 'db' || !alerts || !alerts.length){
      renderDomNotionalWarns('chartHolder', []);
      return;
    }
    const markers = [];
    alerts.forEach(a => {
      if (!a.crossHard) return;
      const cfgIdx = datasetConfigs.findIndex(cfg => cfg.id === a.pk + '_db_notional');
      if (cfgIdx === -1) return;
      const meta = c.getDatasetMeta(cfgIdx);
      if (!meta.visible) return;
      const pt = meta.data[a.crossHard.index];
      if (!pt) return;
      const thresh = formatMoney(NOTIONAL_HARD_USD * ccyMultiplier());
      markers.push({
        x: pt.x, y: pt.y,
        label: `Notional < ${thresh} · ปีที่ ${a.crossHard.year}`
      });
    });
    renderDomNotionalWarns('chartHolder', markers);
  }
};

/* Draws a small flag (pole + triangular pennant) planted at a data point, used to mark
   breakeven years directly on the curve instead of a full-height line across the chart. */
/* Renders animated DOM flag markers into a chart container (a sibling of the <canvas>),
   positioned at the given canvas-space pixel coordinates. Replaces any flags rendered
   there previously. Bigger and more noticeable than a canvas-drawn icon, and lets CSS
   animate a subtle "waving" motion. */
function renderDomFlags(containerId, flags){
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.chart-flag').forEach(el => el.remove());
  flags.forEach(f => {
    const div = document.createElement('div');
    div.className = 'chart-flag';
    div.style.left = f.x + 'px';
    div.style.top = f.y + 'px';
    const poleH = 30 + (f.tier || 0) * 22;
    div.innerHTML =
      `<div class="flag-pole" style="height:${poleH}px;"></div>` +
      `<div class="flag-pennant" style="bottom:${poleH - 12}px; border-left-color:${f.color};"></div>`;
    container.appendChild(div);
  });
}

/* Finds the index (within chart.data.datasets) of the "main value" line for a product+metric
   — i.e. Total Surrender/Death Benefit, or Account/Surrender Value for flat-type products —
   so breakeven flags can be planted directly on that curve. */
function findMainLineIndex(c, pk, metric){
  const candidates = [];
  c.data.datasets.forEach((d, i) => {
    const cfg = datasetConfigs[i];
    if (!cfg || cfg.product !== pk || cfg.metric !== metric || cfg.type !== 'line' || cfg.isPremiumRef || cfg.isNotionalRef || cfg.isGhostRef) return;
    candidates.push(i);
  });
  if (!candidates.length) return -1;
  const preferred = candidates.find(i => /_(t|sv_sv|db_db)$/.test(datasetConfigs[i].id));
  return preferred !== undefined ? preferred : candidates[0];
}

/* Marks Cash Breakeven (red) and Guaranteed Breakeven (green) years on the compare-view
   chart, for every currently visible product, planting an animated flag right on the main
   value curve — so the "critical points" are visible on whichever metric (SV or DB) is
   being viewed, without a distracting full-height line. */
const breakevenMarkerPlugin = {
  id: 'breakevenMarkerPlugin',
  afterDatasetsDraw(c){
    const years = c._years;
    if (!years) { renderDomFlags('chartHolder', []); return; }
    const flags = [];
    Object.keys(xirrLookupCompare).forEach(pk => {
      if (state.product !== 'all' && state.product !== pk) return;
      const entry = xirrLookupCompare[pk];
      const lineIdx = findMainLineIndex(c, pk, state.metric);
      if (lineIdx === -1) return;
      const meta = c.getDatasetMeta(lineIdx);
      if (!meta.visible) return;
      if (entry.breakevenYear !== null && entry.breakevenYear !== undefined){
        const idx = years.indexOf(entry.breakevenYear);
        if (idx !== -1 && meta.data[idx]) flags.push({ x: meta.data[idx].x, y: meta.data[idx].y, color:'#c0392b', tier:0 });
      }
      if (entry.gBreakYear !== null && entry.gBreakYear !== undefined){
        const idx = years.indexOf(entry.gBreakYear);
        if (idx !== -1 && meta.data[idx]) flags.push({ x: meta.data[idx].x, y: meta.data[idx].y, color:'#1f7a4d', tier:1 });
      }
    });
    renderDomFlags('chartHolder', flags);
  }
};

/* Dashed vertical guide line from the hovered point down to the X axis, so the tooltip
   (which no longer sits directly on the point) still has a clear visual anchor. */
const crosshairPlugin = {
  id: 'crosshairPlugin',
  afterDraw(c){
    const active = c.tooltip && c.tooltip.getActiveElements ? c.tooltip.getActiveElements() : [];
    if (!active.length) return;
    const idx = active[0].index;
    const xScale = c.scales.x;
    const { ctx, chartArea } = c;
    const xPix = xScale.getPixelForValue(idx);
    ctx.save();
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(90,90,90,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xPix, chartArea.top);
    ctx.lineTo(xPix, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  }
};

/* Marks Cash/Guaranteed Breakeven for both payment modes on the XIRR chart itself, planting
   an animated flag directly on the relevant curve (normal-payment line or prepayment line)
   instead of a full-height vertical line. Red = Cash Breakeven, Green = Guaranteed Breakeven. */
const xirrBreakevenPlugin = {
  id: 'xirrBreakevenPlugin',
  afterDatasetsDraw(c){
    const years = c._years;
    const info = c._breakevenInfo;
    if (!years || !info) { renderDomFlags('xirrChartHolder', []); return; }
    const idxNormal = c.data.datasets.findIndex(d => d.isXirrNormal);
    const idxPrepay = c.data.datasets.findIndex(d => d.isXirrPrepay);
    const metaNormal = idxNormal >= 0 ? c.getDatasetMeta(idxNormal) : null;
    const metaPrepay = idxPrepay >= 0 ? c.getDatasetMeta(idxPrepay) : null;
    const flags = [];
    function plant(yearVal, meta, color, tier){
      if (yearVal === null || yearVal === undefined || !meta || !meta.visible) return;
      const idx = years.indexOf(yearVal);
      if (idx !== -1 && meta.data[idx]) flags.push({ x: meta.data[idx].x, y: meta.data[idx].y, color, tier });
    }
    plant(info.breakevenYear, metaNormal, '#c0392b', 0);
    plant(info.gBreakYear, metaNormal, '#1f7a4d', 1);
    plant(info.breakevenYearPrepay, metaPrepay, '#c0392b', 2);
    plant(info.gBreakYearPrepay, metaPrepay, '#1f7a4d', 3);
    renderDomFlags('xirrChartHolder', flags);
  }
};

function fmtNumber(v){ return Number(Math.round(v)).toLocaleString('en-US'); }
function ccyLabel(){ return state.currency === 'thb' ? 'บาท' : 'USD'; }
function ccyMultiplier(){ return state.currency === 'thb' ? state.rate : 1; }

/* Thai compact-unit number (แสน / ล้าน), always rounded UP to 2 decimals — never shown as
   "0.50 ล้าน" or "0.12 แสน" since those drop to the tier below instead. No currency word. */
function thaiCompactNumber(value){
  if (value === null || value === undefined || isNaN(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000000) return (Math.ceil((value/1000000) * 100) / 100).toFixed(2) + ' ล้าน';
  if (abs >= 100000) return (Math.ceil((value/100000) * 100) / 100).toFixed(2) + ' แสน';
  return fmtNumber(value);
}
/* Full currency display for tooltips/cards: "USD 40,500" or "2.56 แสน บาท". */
function formatMoney(value){
  if (value === null || value === undefined || isNaN(value)) return '—';
  if (state.currency === 'thb') return thaiCompactNumber(value) + ' บาท';
  return 'USD ' + fmtNumber(value);
}
function moneyHtml(value){
  return `<span class="amt">${formatMoney(value)}</span>`;
}
/* Tooltip-only: large digits, smaller unit/suffix (USD / ล้าน บาท / แสน บาท / บาท). */
function formatMoneyTooltip(value){
  if (value === null || value === undefined || isNaN(value)) return '—';
  if (state.currency === 'thb'){
    const abs = Math.abs(value);
    if (abs >= 1000000){
      const n = (Math.ceil((value / 1000000) * 100) / 100).toFixed(2);
      return `<span class="tt-num">${n}</span><span class="tt-unit"> ล้าน บาท</span>`;
    }
    if (abs >= 100000){
      const n = (Math.ceil((value / 100000) * 100) / 100).toFixed(2);
      return `<span class="tt-num">${n}</span><span class="tt-unit"> แสน บาท</span>`;
    }
    return `<span class="tt-num">${fmtNumber(value)}</span><span class="tt-unit"> บาท</span>`;
  }
  return `<span class="tt-unit">USD </span><span class="tt-num">${fmtNumber(value)}</span>`;
}
function formatPctTooltip(pct){
  if (pct === null || pct === undefined || isNaN(pct)) return '—';
  return `<span class="tt-num">${(pct * 100).toFixed(2)}</span><span class="tt-unit">%</span>`;
}
function formatPayoutTooltip(acc, premium){
  if (acc === null || acc === undefined || acc <= 0 || !premium) return '—';
  return `<span class="tt-num">${(acc / premium).toFixed(2)}</span><span class="tt-unit">x</span>`;
}
/* Compact variant for axis ticks — same tiers, no trailing currency word to save space. */
function formatMoneyAxis(value){
  if (state.currency === 'thb') return thaiCompactNumber(value);
  return 'USD ' + (value/1000).toLocaleString('en-US') + 'k';
}
/* Table-cell variant — no currency prefix at all (matches the table's existing plain-number style). */
function formatMoneyTable(value){
  if (value === null || value === undefined || isNaN(value)) return '—';
  if (state.currency === 'thb') return thaiCompactNumber(value);
  return fmtNumber(value);
}

/* Wraps a percentage string in a colored span — green for positive/zero XIRR, red for
   negative — used anywhere a raw XIRR % is shown as HTML (KPI cards). */
function xirrColorSpan(pct, text, opts){
  if (pct === null || pct === undefined || isNaN(pct)){
    const cls = opts && opts.cls ? ` class="${opts.cls}"` : '';
    return `<span${cls}>${text}</span>`;
  }
  const bright = opts && opts.bright;
  const color = pct >= 0
    ? (bright ? 'var(--ok-bright)' : 'var(--ok)')
    : (bright ? 'var(--err-bright)' : 'var(--err)');
  const cls = opts && opts.cls ? ` class="${opts.cls}"` : '';
  return `<span${cls} style="color:${color};">${text}</span>`;
}

/* Premium reference lines (Total Premium Paid, normal + prepayment) are now built as
   separate per-metric dataset copies (one tagged 'sv', one tagged 'db'), so the ordinary
   metric filter already shows the right one under each view — no special-case override needed. */
function datasetVisibleForMetric(cfg){
  return cfg.metric === state.metric;
}

/* Resolves a dataset's display color for the tooltip swatch — bar datasets use a scriptable
   backgroundColor function (for the hover-dim effect), so it's invoked with a minimal context
   carrying just the two properties it actually reads. */
function resolveTooltipColor(dataset, dataIndex, chartInstance){
  if (dataset.type === 'line') return dataset.borderColor;
  const bg = dataset.backgroundColor;
  if (typeof bg === 'function'){
    try { return bg({ chart: chartInstance, dataIndex }); } catch(e){ return '#888'; }
  }
  return bg;
}

function setCompareHover(idx){
  let changed = false;
  if (chart && chart._hoveredIdx !== idx){ chart._hoveredIdx = idx; changed = true; }
  if (wdChart && wdChart._hoveredIdx !== idx){ wdChart._hoveredIdx = idx; changed = true; }
  if (changed){
    if (chart) chart.update('none');
    if (wdChart) wdChart.update('none');
  }
}

function getCompareTooltipEl(){
  const stack = document.getElementById('chartStack');
  if (!stack) return null;
  let el = stack.querySelector(':scope > .custom-tooltip');
  if (!el){
    el = document.createElement('div');
    el.className = 'custom-tooltip';
    stack.appendChild(el);
  }
  return el;
}

function hideCompareTooltip(){
  const el = getCompareTooltipEl();
  if (el) el.style.opacity = 0;
}

function placeCompareTooltip(caretX, sourceChart){
  const el = getCompareTooltipEl();
  const stack = document.getElementById('chartStack');
  if (!el || !stack || !sourceChart) return;
  const card = document.getElementById('compareView') || stack;
  el.style.opacity = '1';
  const stackRect = stack.getBoundingClientRect();
  const canvasRect = sourceChart.canvas.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const pad = 8;
  const minLeft = Math.max(pad, cardRect.left - stackRect.left + pad, pad);
  const maxRight = Math.min(
    stackRect.width - pad,
    cardRect.right - stackRect.left - pad,
    window.innerWidth - stackRect.left - pad
  );
  const offsetX = canvasRect.left - stackRect.left;
  let left = offsetX + caretX - w / 2;
  if (left + w > maxRight) left = maxRight - w;
  if (left < minLeft) left = minLeft;
  let top = 6;
  const maxBottom = Math.min(
    window.innerHeight - stackRect.top - pad,
    cardRect.bottom - stackRect.top - pad
  );
  if (top + h > maxBottom) top = Math.max(pad, maxBottom - h);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function tooltipSeriesLabel(ds, cfg){
  const raw = ds.label || '';
  const m = raw.match(/^(\[[^\]]+\]\s*)?(.*)$/);
  const prefix = (m && m[1]) || '';
  const core = ((m && m[2]) || raw).trim();
  if (state.currency !== 'thb') return raw;
  if (ds.isGhostRef || /\(No Withdrawal\)/.test(core)){
    return prefix + 'มูลค่าเวนคืน สุทธิ (สะสม = ไม่ถอน) เมื่อสิ้นปี';
  }
  if (core === 'Total Surrender Value'){
    const view = cfg && cfg.product ? resolveProductView(cfg.product) : null;
    return prefix + (view && view.scenario === 'withdrawal'
      ? 'มูลค่าเวนคืน สุทธิ (ถอนใช้บางส่วน) เมื่อสิ้นปี'
      : 'มูลค่าเวนคืน สุทธิ เมื่อสิ้นปี');
  }
  if (core === 'Surrender Value: Guaranteed') return prefix + 'มูลค่าเวนคืน ส่วนการันตี เมื่อสิ้นปี';
  if (core === 'Surrender Value: Non-Guaranteed') return prefix + 'มูลค่าเวนคืน ส่วนลงทุน เมื่อสิ้นปี';
  if (core === 'Surrender Value (Guaranteed)') return prefix + 'มูลค่าเวนคืน (ฐานการันตี) เมื่อสิ้นปี';
  if (core === 'Surrender Value (Conservative — 0% crediting)') return prefix + 'มูลค่าเวนคืน (Conservative — เครดิต 0%) เมื่อสิ้นปี';
  if (core === 'Surrender Value (Current Assumed)') return prefix + 'มูลค่าเวนคืน (ฐานสมมติปัจจุบัน) เมื่อสิ้นปี';
  if (core === 'Death Benefit (Guaranteed)') return prefix + 'เงินคุ้มครองชีวิต (ฐานการันตี)';
  if (core === 'Death Benefit (Conservative — 0% crediting)') return prefix + 'เงินคุ้มครองชีวิต (Conservative — เครดิต 0%)';
  if (core === 'Death Benefit (Current Assumed)') return prefix + 'เงินคุ้มครองชีวิต (ฐานสมมติปัจจุบัน)';
  if (core === 'Account Value') return prefix + 'มูลค่าบัญชี';
  return raw;
}

function tooltipWdLabel(en, th){
  return state.currency === 'thb' ? th : en;
}

function tooltipXirrLabel(showPrepay){
  if (state.currency === 'thb'){
    return showPrepay
      ? 'อัตรามูลค่าเติบโต "ทบต้นตามเวลา" (จ่ายปกติ) / (จ่ายล่วงหน้า)'
      : 'อัตรามูลค่าเติบโต "ทบต้นตามเวลา" (จ่ายปกติ)';
  }
  return showPrepay ? 'XIRR (ปกติ) / XIRR (Prepayment)' : 'XIRR (ปกติ)';
}

function surrenderValueAtYear(view, y){
  const s = view && view.sv;
  if (!s) return null;
  if (view.type === 'par') return lookupSeriesValue(s, 'total', y);
  return lookupSeriesValue(s, 'surrenderValue', y) || lookupSeriesValue(s, 'accountValue', y);
}

function payoutRatioRow(prefix, label, ratioN, showPrepayPair, ratioP){
  if (showPrepayPair){
    return `<div class="tt-ratio-row"><span class="tt-lbl">${prefix}${label}</span><span class="tt-payout">${ratioN}</span><span class="tt-mode">ปกติ</span><span class="tt-payout">${ratioP}</span><span class="tt-mode">Prepay</span></div>`;
  }
  return `<div class="tt-ratio-row"><span class="tt-lbl">${prefix}${label}</span><span class="tt-payout">${ratioN}</span></div>`;
}

function buildCompareTooltipHtml(idx, years, ages){
  if (!chart || idx === null || idx === undefined || !years) return '';
  const y = years[idx], a = ages ? ages[idx] : null;
  let html = `<div class="tt-title">Year ${y}${a!==null&&a!==undefined?' · อายุ '+a:''}</div>`;
  chart.data.datasets.forEach((ds, i) => {
    if (!chart.isDatasetVisible(i)) return;
    if (ds.isPremiumRef || ds.isNotionalRef) return;
    const raw = ds.data[idx];
    if (raw === null || raw === undefined) return;
    const color = resolveTooltipColor(ds, idx, chart);
    const swatchCls = ds.type === 'line' ? 'tt-swatch tt-line' : 'tt-swatch';
    html += `<div class="tt-row"><span class="${swatchCls}" style="background:${color}"></span><span class="tt-lbl">${tooltipSeriesLabel(ds, datasetConfigs[i])}</span><span class="tt-value">${formatMoneyTooltip(raw)}</span></div>`;
  });

  if (state.metric === 'sv'){
    const multi = !!(state.products.p1 && state.products.p2);
    const xirrRows = [];
    Object.keys(xirrLookupCompare).forEach(pk => {
      if (state.product !== 'all' && state.product !== pk) return;
      const entry = xirrLookupCompare[pk];
      const xv = entry.xirr[idx];
      const xp = entry.xirrPrepay ? entry.xirrPrepay[idx] : null;
      const prefix = multi ? `[${pk.toUpperCase()}] ` : '';
      const xvHtml = xirrColorSpan(xv, formatPctTooltip(xv), { bright:true, cls:'tt-value' });
      const showXp = showPrepayCompare() && !!entry.xirrPrepay;
      if (showXp){
        const xpHtml = xirrColorSpan(xp, formatPctTooltip(xp), { bright:true, cls:'tt-value' });
        xirrRows.push(`<div class="tt-row"><span class="tt-lbl">${prefix}${tooltipXirrLabel(true)}</span><span class="tt-xirr-pair">${xvHtml}<span class="tt-mode">/</span>${xpHtml}</span></div>`);
      } else {
        xirrRows.push(`<div class="tt-row"><span class="tt-lbl">${prefix}${tooltipXirrLabel(false)}</span>${xvHtml}</div>`);
      }
    });
    if (xirrRows.length) html += `<div class="tt-footer">${xirrRows.join('')}</div>`;
  }

  const wdRows = [];
  const showPrefix = !!(state.products.p1 && state.products.p2);
  const wdMult = ccyMultiplier();
  ['p1','p2'].forEach(pk => {
    if (state.product !== 'all' && state.product !== pk) return;
    const rawP = state.products[pk];
    const view = resolveProductView(pk);
    if (!view) return;
    const hasWdData = productHasWithdrawal(rawP);
    const prefix = showPrefix ? `[${pk.toUpperCase()}] ` : '';
    const src = view.sv || view.db;
    let acc = 0;
    if (view.scenario === 'withdrawal' && src){
      const thisYear = lookupSeriesValue(src, 'cashWithdrawal', y);
      const cum = lookupSeriesValue(src, 'cumulativeWithdrawal', y);
      if (cum !== null && cum > 0) acc = cum;
      if (thisYear !== null){
        wdRows.push(`<div class="tt-row"><span class="tt-lbl">${prefix}เงินถอนปีนี้</span><span class="tt-value">${formatMoneyTooltip(thisYear * wdMult)}</span></div>`);
      }
      const accShown = acc > 0 ? formatMoneyTooltip(acc * wdMult) : '—';
      wdRows.push(`<div class="tt-row"><span class="tt-lbl">${prefix}${tooltipWdLabel('Acc. Withdrawal', 'มูลค่าเงินถอนสะสม')}</span><span class="tt-value">${accShown}</span></div>`);
    }
    if (hasWdData){
      const prem = productPremiumTotals(view);
      const showPair = showPrepayCompare() && !!prem.prepay;
      const ratioRows = [];
      if (acc > 0){
        ratioRows.push(payoutRatioRow(
          prefix,
          tooltipWdLabel('Payout Ratio (Withdrawal)', 'อัตราการจ่าย (เงินถอน) สะสม ต่อเงินเบี้ยรวม'),
          formatPayoutTooltip(acc, prem.annual),
          showPair,
          formatPayoutTooltip(acc, prem.prepay)
        ));
      }
      const svNow = surrenderValueAtYear(view, y);
      const rowBNum = (svNow !== null) ? (acc + svNow) : null;
      const rowBLabel = acc > 0
        ? tooltipWdLabel('Total Payout Ratio (Withdrawal)', 'อัตราการจ่าย (เงินถอน + เงินสะสม) สะสม ต่อเงินเบี้ยรวม')
        : tooltipWdLabel('Net Payout Ratio', 'อัตราการจ่าย เวนคืนทั้งหมด สุทธิ ต่อเงินเบี้ยรวม');
      ratioRows.push(payoutRatioRow(
        prefix, rowBLabel,
        formatPayoutTooltip(rowBNum, prem.annual),
        showPair,
        formatPayoutTooltip(rowBNum, prem.prepay)
      ));
      wdRows.push(`<div class="tt-ratio-grid${showPair ? ' tt-ratio-pair' : ''}">${ratioRows.join('')}</div>`);
    }
    if (view.scenario === 'withdrawal' && state.metric === 'db'){
      const notional = lookupSeriesValue(view.db, 'notionalAfterWithdrawal', y) || lookupSeriesValue(view.sv, 'notionalAfterWithdrawal', y);
      if (notional !== null){
        let extra = '';
        if (notional < NOTIONAL_HARD_USD) extra = ` <span class="tt-warn-hard">⚠ ต่ำกว่า ${formatMoneyTooltip(NOTIONAL_HARD_USD * wdMult)}</span>`;
        else if (notional < NOTIONAL_SOFT_USD) extra = ` <span class="tt-warn-soft">ⓘ ต่ำกว่า ${formatMoneyTooltip(NOTIONAL_SOFT_USD * wdMult)}</span>`;
        wdRows.push(`<div class="tt-row"><span class="tt-lbl">${prefix}Notional After Withdrawal</span><span class="tt-value">${formatMoneyTooltip(notional * wdMult)}</span>${extra}</div>`);
      }
    }
  });
  if (wdRows.length) html += `<div class="tt-footer">${wdRows.join('')}</div>`;
  return html;
}

function showCompareTooltipAt(idx, caretX, sourceChart, years, ages){
  if (idx === null || idx === undefined) return;
  setCompareHover(idx);
  const el = getCompareTooltipEl();
  if (!el) return;
  el.innerHTML = buildCompareTooltipHtml(idx, years, ages);
  placeCompareTooltip(caretX, sourceChart);
}

/* Custom HTML tooltip for the compare-view chart — pinned to the top of the combined
   chart stack so it never sits on bars, premium labels, or the withdrawal panel. */
function renderCompareTooltip(context, years, ages){
  const { chart: c, tooltip } = context;
  if (tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length) return;
  showCompareTooltipAt(tooltip.dataPoints[0].dataIndex, tooltip.caretX, c, years, ages);
}

/* Custom HTML tooltip for the XIRR line chart — same red/green coloring for the percentage
   figures themselves (this chart's whole content IS an XIRR value, so every line gets it). */
function renderXirrTooltip(context, years, ages){
  const { chart, tooltip } = context;
  let el = chart.canvas.parentNode.querySelector('.custom-tooltip');
  if (!el){
    el = document.createElement('div');
    el.className = 'custom-tooltip';
    chart.canvas.parentNode.appendChild(el);
  }
  if (tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length){
    el.style.opacity = 0;
    return;
  }
  const idx = tooltip.dataPoints[0].dataIndex;
  const y = years[idx], a = ages ? ages[idx] : null;

  let html = `<div class="tt-title">Year ${y}${a!==null&&a!==undefined?' · อายุ '+a:''}</div>`;
  tooltip.dataPoints.forEach(dp => {
    const ds = dp.dataset;
    const v = dp.raw;
    const text = (v === null || v === undefined) ? 'ไม่มีข้อมูล' : xirrColorSpan(v/100, (v).toFixed(2) + '% p.a.', { bright:true });
    html += `<div class="tt-row"><span class="tt-swatch tt-line" style="background:${ds.borderColor}"></span>${ds.label}: ${text}</div>`;
  });
  el.innerHTML = html;

  const chartArea = chart.chartArea;
  let minY = chartArea.bottom;
  tooltip.dataPoints.forEach(dp => { if (dp.element && dp.element.y < minY) minY = dp.element.y; });
  const posY = minY + (chartArea.bottom - minY) * 0.5;
  let posX = tooltip.caretX;
  posX = Math.max(chartArea.left + 80, Math.min(chartArea.right - 80, posX));

  el.style.left = posX + 'px';
  el.style.top = posY + 'px';
  el.style.opacity = 1;
}

function buildYearAgeLabels(){
  // union of all years across both products' sv+db series, sorted
  const yearSet = new Set();
  ['p1','p2'].forEach(pk => {
    const p = resolveProductView(pk);
    if (!p) return;
    ['sv','db'].forEach(mk => {
      const s = p[mk];
      if (s && s.years) s.years.forEach(y => { if (y !== null && y !== undefined) yearSet.add(y); });
    });
  });
  let years = Array.from(yearSet).sort((a,b) => a-b);
  if (isFinite(state.xAxisRange)) years = years.filter(y => y <= state.xAxisRange);
  return years;
}

function alignToYears(years, srcYears, srcAges, srcValues){
  const map = new Map();
  const ageMap = new Map();
  srcYears.forEach((y, i) => { if (y !== null && !map.has(y)) { map.set(y, srcValues[i]); ageMap.set(y, srcAges ? srcAges[i] : null); } });
  return years.map(y => map.has(y) ? map.get(y) : null);
}

function isChartGap(v){
  return v === null || v === undefined || (typeof v === 'number' && isNaN(v));
}
/* Cumulative quantities (premium paid): carry the last known value across unreported
   years. After the payment term ends the line stays flat, never drops to zero. */
function forwardFillNulls(arr){
  let last = null;
  return (arr || []).map(v => {
    if (!isChartGap(v)) { last = v; return v; }
    return last;
  });
}
/* Continuous values that the document only samples at milestone years (SV, AV, DB,
   notional, ghost refs). Linear-interpolate between known points; forward-fill any
   trailing tail after the last sample. Leading gaps stay null. */
function interpolateNulls(arr){
  const out = (arr || []).slice();
  let i = 0;
  while (i < out.length){
    if (!isChartGap(out[i])) { i++; continue; }
    let next = i;
    while (next < out.length && isChartGap(out[next])) next++;
    const prev = i - 1;
    if (prev < 0) { i = next; continue; }
    if (next >= out.length){
      for (let k = i; k < out.length; k++) out[k] = out[prev];
      break;
    }
    const v0 = Number(out[prev]), v1 = Number(out[next]);
    const span = next - prev;
    for (let k = prev + 1; k < next; k++){
      out[k] = v0 + (v1 - v0) * ((k - prev) / span);
    }
    i = next;
  }
  return out;
}
function interpolationFilledGaps(aligned){
  if (!aligned || !aligned.length) return false;
  const filled = interpolateNulls(aligned);
  for (let i = 0; i < aligned.length; i++){
    if (isChartGap(aligned[i]) && !isChartGap(filled[i])) return true;
  }
  return false;
}
const GHOST_INTERP_NOTE = 'เอกสารนี้ไม่ได้ระบุ Total Surrender Value (No Withdrawal) ครบทุกปีกรมธรรม์ — เส้นนี้เป็นการประมาณค่า (interpolation) ระหว่างปีที่มีข้อมูลจริงในเอกสารเท่านั้น ไม่ใช่ตัวเลขที่บริษัทประกันระบุไว้ตรงๆ';
function resetLegendVisibility(){
  state.hidden.clear();
  if (state.legendTouched) state.legendTouched.clear();
}
function applyInterpolatedGhostDefaultHidden(){
  (datasetConfigs || []).forEach(cfg => {
    if (cfg.isGhostRef && cfg.wasInterpolated && !(state.legendTouched && state.legendTouched.has(cfg.id))){
      state.hidden.add(cfg.id);
    }
  });
}

function buildDatasetConfigs(){
  datasetConfigs = [];
  const years = buildYearAgeLabels();
  if (years.length === 0) return years;

  // derive age labels: prefer whichever product has ages defined
  let ages = years.map(() => null);
  ['p1','p2'].forEach(pk => {
    const p = resolveProductView(pk);
    if (!p) return;
    ['sv','db'].forEach(mk => {
      const s = p[mk];
      if (!s || !s.years) return;
      years.forEach((y, i) => {
        if (ages[i] === null){
          const idx = s.years.indexOf(y);
          if (idx !== -1 && s.ages && s.ages[idx] !== null && s.ages[idx] !== undefined) ages[i] = s.ages[idx];
        }
      });
    });
  });

  // Show a short product prefix in series names only when two products are loaded at once
  // (so a single-product view keeps clean names like "Total Surrender Value").
  const showPrefix = !!(state.products.p1 && state.products.p2);
  function seriesLabel(pk, core){ return showPrefix ? `[${pk.toUpperCase()}] ${core}` : core; }

  ['p1','p2'].forEach(pk => {
    const p = resolveProductView(pk);
    if (!p) return;
    const pal = PALETTE[pk];

    if (p.type === 'par'){
      if (p.sv){
        const g = alignToYears(years, p.sv.years, p.sv.ages, p.sv.guaranteed);
        const ng = alignToYears(years, p.sv.years, p.sv.ages, p.sv.nonGuaranteed);
        const t = alignToYears(years, p.sv.years, p.sv.ages, p.sv.total);
        const stackId = pk + 'SV';
        datasetConfigs.push({ id: pk+'_sv_g', metric:'sv', product:pk, type:'bar', stack:stackId,
          label: seriesLabel(pk, 'Surrender Value: Guaranteed'), rawData:g.map(v=>v||0), backgroundColor:scriptableBarColor(pal.guaranteed), legendColor: pal.guaranteed, order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_sv_ng', metric:'sv', product:pk, type:'bar', stack:stackId,
          label: seriesLabel(pk, 'Surrender Value: Non-Guaranteed'), rawData:ng.map(v=>v||0), backgroundColor:scriptableBarColor(pal.nonGuaranteed), legendColor: pal.nonGuaranteed, order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_sv_t', metric:'sv', product:pk, type:'line', stack: pk+'_sv_t',
          label: seriesLabel(pk, 'Total Surrender Value'), rawData:interpolateNulls(t), borderColor:pal.total, backgroundColor:pal.total,
          borderWidth:2.5, pointRadius:3, tension:.15, order:1, fill:false });
        const rawPar = state.products[pk];
        if (p.scenario === 'withdrawal' && rawPar && rawPar.sv && rawPar.sv.total &&
            rawPar.sv.total.some(v => v !== null && v !== undefined)){
          const ghost = alignToYears(years, rawPar.sv.years, rawPar.sv.ages, rawPar.sv.total);
          datasetConfigs.push({ id: pk+'_sv_t_ghost', metric:'sv', product:pk, type:'line', stack: pk+'_sv_t_ghost', isGhostRef:true,
            wasInterpolated: interpolationFilledGaps(ghost),
            label: seriesLabel(pk, 'Total Surrender Value (No Withdrawal)'), rawData: interpolateNulls(ghost),
            borderColor: GHOST_LINE_COLOR, backgroundColor: GHOST_LINE_COLOR,
            borderWidth:1.6, pointRadius:0, tension:.15, order:5, fill:false });
        }
      }
      if (p.db){
        const b = alignToYears(years, p.db.years, p.db.ages, p.db.guaranteed);   // (B) DB Guaranteed
        const cd = alignToYears(years, p.db.years, p.db.ages, p.db.nonGuaranteed); // (C+D) DB Non-Guaranteed
        const t = alignToYears(years, p.db.years, p.db.ages, p.db.total);         // Net = higher of (B) or (E)
        // (A) Guaranteed Cash Value: prefer the DB table's own (A) column when present
        // (withdrawal scenario), otherwise the SV-side guaranteed figure.
        const aSeries = (p.db.guaranteedCashValue && p.db.guaranteedCashValue.some(v => v !== null && v !== undefined))
          ? { years: p.db.years, ages: p.db.ages, values: p.db.guaranteedCashValue }
          : (p.sv && p.sv.guaranteed) ? { years: p.sv.years, ages: p.sv.ages, values: p.sv.guaranteed } : null;
        const a = aSeries ? alignToYears(years, aSeries.years, aSeries.ages, aSeries.values) : years.map(()=>0);
        const stackB = pk + 'DB_B';
        const stackE = pk + 'DB_E';
        datasetConfigs.push({ id: pk+'_db_b', metric:'db', product:pk, type:'bar', stack:stackB,
          label: seriesLabel(pk, 'Death Benefit: Guaranteed (B)'), rawData:b.map(v=>v||0), backgroundColor:scriptableBarColor(pal.dbGuaranteed), legendColor: pal.dbGuaranteed, order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_db_a', metric:'db', product:pk, type:'bar', stack:stackE,
          label: seriesLabel(pk, 'Guaranteed Cash Value (A)'), rawData:a.map(v=>v||0), backgroundColor:scriptableBarColor(pal.guaranteed), legendColor: pal.guaranteed, order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_db_cd', metric:'db', product:pk, type:'bar', stack:stackE,
          label: seriesLabel(pk, 'Death Benefit: Non-Guaranteed (C+D)'), rawData:cd.map(v=>v||0), backgroundColor:scriptableBarColor(pal.dbNonGuaranteed), legendColor: pal.dbNonGuaranteed, order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_db_t', metric:'db', product:pk, type:'line', stack: pk+'_db_t',
          label: seriesLabel(pk, 'Net Death Benefit'), rawData:interpolateNulls(t), borderColor:pal.dbTotal, backgroundColor:pal.dbTotal,
          borderWidth:2.5, pointRadius:3, tension:.15, order:1, fill:false, legendColor: pal.dbTotal });
      }
    } else if (p.type === 'flat'){
      const lowSv = dualLowBucket(p.sv);
      if (p.dualBasis && lowSv && p.sv.currentAssumed){
        const lowKind = dualLowKindOf(p) || 'guaranteed';
        const gSv = alignToYears(years, p.sv.years, p.sv.ages, lowSv.surrenderValue);
        const aSv = alignToYears(years, p.sv.years, p.sv.ages, p.sv.currentAssumed.surrenderValue);
        const dualPal = DUAL_BASIS_LINE[pk] || DUAL_BASIS_LINE.p1;
        const lowColor = dualPal[lowKind] || dualPal.guaranteed;
        const lowSvLabel = lowKind === 'conservative'
          ? 'Surrender Value (Conservative — 0% crediting)'
          : 'Surrender Value (Guaranteed)';
        datasetConfigs.push({ id: pk+'_sv_sv_g', metric:'sv', product:pk, type:'line', stack: pk+'_sv_sv_g',
          label: seriesLabel(pk, lowSvLabel), rawData: interpolateNulls(gSv),
          borderColor:lowColor, backgroundColor:lowColor, legendColor: lowColor,
          borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
        datasetConfigs.push({ id: pk+'_sv_sv_a', metric:'sv', product:pk, type:'line', stack: pk+'_sv_sv_a',
          label: seriesLabel(pk, 'Surrender Value (Current Assumed)'), rawData: interpolateNulls(aSv),
          borderColor:dualPal.assumed, backgroundColor:dualPal.assumed, legendColor: dualPal.assumed,
          borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
        const avSrc = p.sv.currentAssumed.accountValue || p.sv.accountValue;
        if (avSrc && avSrc.some(v => v !== null && v !== undefined)){
          const av = alignToYears(years, p.sv.years, p.sv.ages, avSrc);
          datasetConfigs.push({ id: pk+'_sv_av', metric:'sv', product:pk, type:'line', stack: pk+'_sv_av', isAvRef:true,
            label: seriesLabel(pk, 'Account Value'), rawData: interpolateNulls(av),
            borderColor:'#b8bec8', backgroundColor:'#b8bec8', legendColor:'#b8bec8',
            borderWidth:1.3, pointRadius:0, tension:.15, order:4, fill:false });
        }
      } else if (p.sv){
        if (p.sv.accountValue && p.sv.accountValue.some(v=>v!==null)){
          const av = alignToYears(years, p.sv.years, p.sv.ages, p.sv.accountValue);
          datasetConfigs.push({ id: pk+'_sv_av', metric:'sv', product:pk, type:'line', stack: pk+'_sv_av',
            label: seriesLabel(pk, 'Account Value'), rawData: interpolateNulls(av), borderColor:pal.accountValue, backgroundColor:pal.accountValue,
            borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
        }
        if (p.sv.surrenderValue && p.sv.surrenderValue.some(v=>v!==null)){
          const sv = alignToYears(years, p.sv.years, p.sv.ages, p.sv.surrenderValue);
          datasetConfigs.push({ id: pk+'_sv_sv', metric:'sv', product:pk, type:'line', stack: pk+'_sv_sv',
            label: seriesLabel(pk, 'Total Surrender Value'), rawData: interpolateNulls(sv), borderColor:pal.surrenderValue, backgroundColor:pal.surrenderValue,
            borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
          const rawFlat = state.products[pk];
          if (p.scenario === 'withdrawal' && rawFlat && rawFlat.sv && rawFlat.sv.surrenderValue &&
              rawFlat.sv.surrenderValue.some(v => v !== null && v !== undefined)){
            const ghost = alignToYears(years, rawFlat.sv.years, rawFlat.sv.ages, rawFlat.sv.surrenderValue);
            datasetConfigs.push({ id: pk+'_sv_sv_ghost', metric:'sv', product:pk, type:'line', stack: pk+'_sv_sv_ghost', isGhostRef:true,
              wasInterpolated: interpolationFilledGaps(ghost),
              label: seriesLabel(pk, 'Total Surrender Value (No Withdrawal)'), rawData: interpolateNulls(ghost),
              borderColor: GHOST_LINE_COLOR, backgroundColor: GHOST_LINE_COLOR,
              borderWidth:1.6, pointRadius:0, tension:.15, order:5, fill:false });
          }
        }
      }
      const lowDb = (p.db && p.db.conservative) ? p.db.conservative
        : (p.db && p.db.guaranteed && p.db.guaranteed.deathBenefit && !Array.isArray(p.db.guaranteed)) ? p.db.guaranteed : null;
      if (p.dualBasis && lowDb && p.db.currentAssumed){
        const lowKind = dualLowKindOf(p) || 'guaranteed';
        const gDb = alignToYears(years, p.db.years, p.db.ages, lowDb.deathBenefit);
        const aDb = alignToYears(years, p.db.years, p.db.ages, p.db.currentAssumed.deathBenefit);
        const dualPalDb = DUAL_BASIS_LINE[pk] || DUAL_BASIS_LINE.p1;
        const lowColor = dualPalDb[lowKind] || dualPalDb.guaranteed;
        const lowDbLabel = lowKind === 'conservative'
          ? 'Death Benefit (Conservative — 0% crediting)'
          : 'Death Benefit (Guaranteed)';
        datasetConfigs.push({ id: pk+'_db_db_g', metric:'db', product:pk, type:'line', stack: pk+'_db_db_g',
          label: seriesLabel(pk, lowDbLabel), rawData: interpolateNulls(gDb),
          borderColor:lowColor, backgroundColor:lowColor, legendColor: lowColor,
          borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
        datasetConfigs.push({ id: pk+'_db_db_a', metric:'db', product:pk, type:'line', stack: pk+'_db_db_a',
          label: seriesLabel(pk, 'Death Benefit (Current Assumed)'), rawData: interpolateNulls(aDb),
          borderColor:dualPalDb.assumed, backgroundColor:dualPalDb.assumed, legendColor: dualPalDb.assumed,
          borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
      } else if (p.db && p.db.deathBenefit && p.db.deathBenefit.some(v=>v!==null)){
        const db = alignToYears(years, p.db.years, p.db.ages, p.db.deathBenefit);
        datasetConfigs.push({ id: pk+'_db_db', metric:'db', product:pk, type:'line', stack: pk+'_db_db',
          label: seriesLabel(pk, 'Death Benefit'), rawData: interpolateNulls(db), borderColor:pal.deathBenefit, backgroundColor:pal.deathBenefit,
          borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
      }
    }

    // Reference lines: cumulative premium paid — shown under BOTH Surrender Value and Death
    // Benefit metrics (money paid in is a useful reference regardless of which benefit you're
    // viewing). Prepayment variant only added when the document actually offers that option.
    if (p.sv && p.sv.premium && p.sv.premium.some(v => v !== null && v !== undefined)){
      const premAligned = alignToYears(years, p.sv.years, p.sv.ages, p.sv.premium);
      ['sv','db'].forEach(m => {
        datasetConfigs.push({ id: pk+'_'+m+'_premium', metric:m, product:pk, type:'line', stack: pk+'_'+m+'_premium', isPremiumRef:true,
          label: seriesLabel(pk, 'Total Premium Paid'), rawData: forwardFillNulls(premAligned),
          borderColor:'#6b7688', backgroundColor:'#6b7688', legendColor:'#6b7688',
          borderWidth:2.3, pointRadius:0, tension:0, order:2, fill:false });
      });
      if (p.prepayment && p.prepayment.lumpSum){
        const lumpArr = years.map(() => p.prepayment.lumpSum);
        ['sv','db'].forEach(m => {
          datasetConfigs.push({ id: pk+'_'+m+'_premium_prepay', metric:m, product:pk, type:'line', stack: pk+'_'+m+'_premium_prepay', isPremiumRef:true,
            label: seriesLabel(pk, 'Total Premium Paid (Prepayment)'), rawData: lumpArr,
            borderColor:'#8e44ad', backgroundColor:'#8e44ad', legendColor:'#8e44ad',
            borderWidth:2.3, pointRadius:0, tension:0, order:2, fill:false, borderDash:[8,3] });
        });
      }
    }

    // Notional Amount After Cash Withdrawal — thin reference line on Death Benefit
    // under the withdrawal scenario, showing how withdrawals erode the face amount.
    if (p.scenario === 'withdrawal'){
      const nSrc = (p.db && p.db.notionalAfterWithdrawal) ? p.db
                 : (p.sv && p.sv.notionalAfterWithdrawal) ? p.sv : null;
      if (nSrc && nSrc.notionalAfterWithdrawal.some(v => v !== null && v !== undefined)){
        const notionalAligned = alignToYears(years, nSrc.years, nSrc.ages, nSrc.notionalAfterWithdrawal);
        datasetConfigs.push({ id: pk+'_db_notional', metric:'db', product:pk, type:'line', stack: pk+'_db_notional', isNotionalRef:true,
          label: seriesLabel(pk, 'Notional Amount After Cash Withdrawal'), rawData: interpolateNulls(notionalAligned),
          borderColor:'#2a9d8f', backgroundColor:'#2a9d8f', legendColor:'#2a9d8f',
          borderWidth:2.3, pointRadius:0, tension:0, order:2, fill:false });
      }
    }
  });

  return { years, ages };
}

function ensureChart(years, ages, hideXTicks){
  const labels = years.map((y,i) => {
    if (ages[i] !== null && ages[i] !== undefined && ages[i] % 5 === 0) return [`Y${y}`, `อายุ ${ages[i]}`];
    return [`Y${y}`];
  });
  const chartDatasets = datasetConfigs.map(cfg => {
    const d = Object.assign({}, cfg, { data: cfg.rawData.slice() });
    delete d.rawData; delete d.metric; delete d.product;
    return d;
  });

  if (chart) { chart.destroy(); chart = null; }
  const staleTooltip = document.querySelector('#chartHolder .custom-tooltip');
  if (staleTooltip) staleTooltip.style.opacity = 0;
  hideCompareTooltip();
  const ctx = document.getElementById('cmp').getContext('2d');
  chart = new Chart(ctx, {
    data: { labels, datasets: chartDatasets },
    options: {
      responsive:true, maintainAspectRatio:false,
      layout:{ padding:{top:4, right:8, bottom: hideXTicks ? 0 : 2} },
      interaction:{ mode:'index', intersect:false },
      scales:{
        x:{ stacked:true, offset:true, grid:{display:false},
            ticks:{ display:!hideXTicks, font:{size:12.5,family:"'Inter','Kanit',sans-serif"}, autoSkip:true, maxTicksLimit:20, maxRotation:0, minRotation:0 } },
        y:{ stacked:true, beginAtZero:true, afterFit: pinSharedYAxis,
            ticks:{ maxTicksLimit:7, font:{size:12.5,family:"'Inter','Kanit',sans-serif"},
              callback:(v)=> formatMoneyAxis(v) }, grid:{color:'#eee'} }
      },
      plugins:{
        legend:{ display:false },
        tooltip:{
          enabled:false,
          external: (context) => renderCompareTooltip(context, years, ages)
        }
      },
      onHover: (evt, elements) => {
        const idx = (elements && elements.length) ? elements[0].index : null;
        if (idx !== null) setCompareHover(idx);
      }
    },
    plugins: [premiumLabelPlugin, breakevenMarkerPlugin, notionalAlertPlugin]
  });
  chart._hoveredIdx = null;
  chart._years = years;
  wireCompareHoverSync();
}

const WD_BAR_COLORS = { p1: '#5c6b7a', p2: '#9a7b4f' };

function collectWithdrawalPanelSeries(years){
  const series = [];
  const multi = !!(state.products.p1 && state.products.p2);
  ['p1','p2'].forEach(pk => {
    if (state.product !== 'all' && state.product !== pk) return;
    const view = resolveProductView(pk);
    if (!view || view.scenario !== 'withdrawal') return;
    const src = view.sv || view.db;
    if (!src || !src.cashWithdrawal) return;
    const hasWd = src.cashWithdrawal.some(v => v !== null && v !== undefined && v > 0);
    if (!hasWd) return;
    series.push({
      pk,
      label: multi ? `[${pk.toUpperCase()}] ถอนรายปี` : 'เงินถอนรายปี',
      color: WD_BAR_COLORS[pk] || WD_BAR_COLORS.p1,
      raw: years.map(y => {
        const v = lookupSeriesValue(src, 'cashWithdrawal', y);
        return (v === null || v === undefined || isNaN(v)) ? 0 : v;
      })
    });
  });
  return series;
}

function hideWdPanel(){
  const el = document.getElementById('wdPanelHolder');
  if (el) el.style.display = 'none';
  if (wdChart){ wdChart.destroy(); wdChart = null; }
}

function wireCompareHoverSync(){
  const stack = document.getElementById('chartStack');
  if (!stack || stack._hoverWired) return;
  stack.addEventListener('mouseleave', () => {
    setCompareHover(null);
    hideCompareTooltip();
  });
  stack._hoverWired = true;
}

function renderWdPanelTooltip(context, years, ages){
  const { chart: c, tooltip } = context;
  if (tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length) return;
  showCompareTooltipAt(tooltip.dataPoints[0].dataIndex, tooltip.caretX, c, years, ages);
}

function ensureWdPanel(years, ages, series){
  const holder = document.getElementById('wdPanelHolder');
  if (!series.length){
    hideWdPanel();
    return;
  }
  holder.style.display = 'block';
  const labels = years.map((y,i) => {
    if (ages[i] !== null && ages[i] !== undefined && ages[i] % 5 === 0) return [`Y${y}`, `อายุ ${ages[i]}`];
    return [`Y${y}`];
  });
  const mult = ccyMultiplier();
  const fs = state.fontScale;
  const datasets = series.map(s => ({
    type: 'bar',
    label: s.label,
    data: s.raw.map(v => v * mult),
    backgroundColor: scriptableBarColor(s.color),
    borderWidth: 0,
    barPercentage: 0.72,
    categoryPercentage: series.length > 1 ? 0.72 : 0.55
  }));
  if (wdChart){ wdChart.destroy(); wdChart = null; }
  const stale = holder.querySelector('.custom-tooltip');
  if (stale) stale.style.opacity = 0;
  const ctx = document.getElementById('wdPanel').getContext('2d');
  wdChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive:true, maintainAspectRatio:false,
      layout:{ padding:{top:2, right:8, bottom:2} },
      interaction:{ mode:'index', intersect:false },
      scales:{
        x:{ offset:true, grid:{display:false},
            ticks:{ font:{size:12.5*fs,family:"'Inter','Kanit',sans-serif"}, autoSkip:true, maxTicksLimit:20, maxRotation:0, minRotation:0 } },
        y:{ beginAtZero:true, afterFit: pinSharedYAxis,
            ticks:{ maxTicksLimit:3, font:{size:11.5*fs,family:"'Inter','Kanit',sans-serif"},
              callback:(v)=> formatMoneyAxis(v) }, grid:{color:'#f0f0f0'} }
      },
      plugins:{
        legend:{ display: datasets.length > 1, position:'top', labels:{ boxWidth:10, font:{size:10.5*fs,family:"'Kanit','Inter',sans-serif"} } },
        tooltip:{ enabled:false, external: (context) => renderWdPanelTooltip(context, years, ages) }
      },
      onHover: (evt, elements) => {
        const idx = (elements && elements.length) ? elements[0].index : null;
        if (idx !== null) setCompareHover(idx);
      }
    }
  });
  wdChart._hoveredIdx = null;
}

function buildLegend(){
  const listEl = document.getElementById('legendList');
  listEl.innerHTML = '';
  const relevant = datasetConfigs.filter(cfg => datasetVisibleForMetric(cfg) && (state.product === 'all' || cfg.product === (state.product)));
  if (relevant.length === 0){
    listEl.innerHTML = '<div class="legend-empty">ไม่มีเส้นกราฟสำหรับตัวเลือกนี้</div>';
    return;
  }
  relevant.forEach(cfg => {
    const isOff = state.hidden.has(cfg.id);
    const item = document.createElement('div');
    item.className = 'legend-item' + (isOff ? ' off' : '');
    item.setAttribute('data-series', cfg.id);
    const swatch = document.createElement('span');
    swatch.className = 'swatch' + (cfg.type === 'line' ? ' line' : '');
    swatch.style.background = cfg.type === 'line' ? cfg.borderColor : (cfg.legendColor || cfg.backgroundColor);
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = cfg.label;
    item.appendChild(swatch); item.appendChild(lbl);
    if (cfg.isGhostRef && cfg.wasInterpolated && !isOff){
      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'info-btn legend-interp-btn';
      infoBtn.setAttribute('aria-label', 'คำอธิบายเส้นประมาณค่า');
      infoBtn.setAttribute('aria-expanded', 'false');
      const pop = document.createElement('span');
      pop.className = 'info-pop';
      pop.textContent = GHOST_INTERP_NOTE;
      infoBtn.appendChild(document.createTextNode('ⓘ'));
      infoBtn.appendChild(pop);
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = infoBtn.classList.contains('is-open');
        document.querySelectorAll('.info-btn.is-open').forEach(other => {
          other.classList.remove('is-open');
          other.setAttribute('aria-expanded', 'false');
        });
        if (!wasOpen){
          infoBtn.classList.add('is-open');
          infoBtn.setAttribute('aria-expanded', 'true');
        }
      });
      item.appendChild(infoBtn);
    }
    item.addEventListener('click', () => {
      if (state.legendTouched) state.legendTouched.add(cfg.id);
      if (state.hidden.has(cfg.id)) state.hidden.delete(cfg.id); else state.hidden.add(cfg.id);
      render();
    });
    listEl.appendChild(item);
  });
}

function updatePrepayToggleUI(){
  const group = document.getElementById('prepayGroup');
  if (!group) return;
  const keys = relevantProductKeys();
  const hasPrepay = keys.some(pk => productHasPrepayment(state.products[pk]));
  group.style.display = hasPrepay ? 'flex' : 'none';
  const seg = document.getElementById('prepaySeg');
  if (seg){
    seg.querySelectorAll('.seg-btn').forEach(b => {
      const on = b.getAttribute('data-prepay') === 'on';
      b.classList.toggle('active', on === !!state.showPrepay);
    });
  }
}

function updateScenarioToggleUI(){
  const group = document.getElementById('scenarioGroup');
  if (!group) return;
  const keys = relevantProductKeys();
  const wdKeys = keys.filter(pk => productHasWithdrawal(state.products[pk]));
  group.style.display = wdKeys.length ? 'flex' : 'none';
  const scenarios = new Set(wdKeys.map(pk => state.scenario[pk] || 'base'));
  const seg = document.getElementById('scenarioSeg');
  if (seg){
    seg.querySelectorAll('.seg-btn').forEach(b => {
      const v = b.getAttribute('data-scenario');
      b.classList.toggle('active', scenarios.size === 1 && scenarios.has(v));
    });
  }
  const hint = document.getElementById('scenarioHint');
  if (!hint) return;
  const p1 = state.products.p1, p2 = state.products.p2;
  if (p1 && p2){
    const h1 = productHasWithdrawal(p1), h2 = productHasWithdrawal(p2);
    const effective1 = h1 ? (state.scenario.p1 || 'base') : 'base';
    const effective2 = h2 ? (state.scenario.p2 || 'base') : 'base';
    const differAvail = h1 !== h2;
    const differSel = effective1 !== effective2;
    if (differAvail || differSel){
      hint.style.display = 'block';
      hint.textContent = differAvail
        ? 'มีเพียงบางสินค้าที่มีตาราง Withdrawal — เปรียบเทียบได้ แต่แนะนำให้เลือกสถานการณ์เดียวกันเมื่อทำได้'
        : 'สินค้าทั้งสองใช้สถานการณ์ต่างกัน — เลือกสถานการณ์เดียวกันจะเปรียบเทียบได้ตรงกว่า';
    } else {
      hint.style.display = 'none';
    }
  } else {
    hint.style.display = 'none';
  }
}

function render(){
  updateScenarioToggleUI();
  updatePrepayToggleUI();
  const compareEl = document.getElementById('compareView');
  const xirrEl = document.getElementById('xirrView');
  const legendPanel = document.getElementById('legendPanel');
  const xirrTablePanel = document.getElementById('xirrTablePanel');
  const compareControls = document.getElementById('compareControls');
  const productFilterGroup = document.getElementById('productFilterGroup');
  const xirrProductGroup = document.getElementById('xirrProductGroup');

  if (state.viewMode === 'xirr'){
    compareEl.style.display = 'none';
    xirrEl.style.display = 'flex';
    legendPanel.style.display = 'none';
    xirrTablePanel.style.display = 'flex';
    compareControls.style.display = 'none';
    productFilterGroup.style.display = 'none';
    xirrProductGroup.style.display = 'flex';
    renderXirrView();
    return;
  }
  compareEl.style.display = 'flex';
  xirrEl.style.display = 'none';
  legendPanel.style.display = 'flex';
  xirrTablePanel.style.display = 'none';
  compareControls.style.display = 'flex';
  productFilterGroup.style.display = 'flex';
  xirrProductGroup.style.display = 'none';
  renderCompareView();
}

function renderCompareView(){
  const hasAny = state.products.p1 || state.products.p2;
  document.getElementById('emptyState').style.display = hasAny ? 'none' : 'flex';
  document.getElementById('chartStack').style.display = hasAny ? 'flex' : 'none';
  document.getElementById('chartHintRow').style.display = hasAny ? 'flex' : 'none';
  if (!hasAny){
    document.getElementById('compareLegendNote').style.display = 'none';
    hideWdPanel();
    buildLegend();
    return;
  }

  const { years, ages } = buildDatasetConfigs();
  applyInterpolatedGhostDefaultHidden();
  if (!years || years.length === 0){
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('chartStack').style.display = 'none';
    document.getElementById('chartHintRow').style.display = 'none';
    document.getElementById('compareLegendNote').style.display = 'none';
    hideWdPanel();
    buildLegend();
    return;
  }
  xirrLookupCompare = computeXirrLookupForYears(years);
  const wdSeries = collectWithdrawalPanelSeries(years);

  try {
    ensureChart(years, ages, wdSeries.length > 0);
    ensureWdPanel(years, ages, wdSeries);

    const mult = ccyMultiplier();
    chart.data.datasets.forEach((d, i) => {
      const cfg = datasetConfigs[i];
      d.data = cfg.rawData.map(v => v * mult);
      const visible = datasetVisibleForMetric(cfg) && (state.product === 'all' || cfg.product === state.product) && !state.hidden.has(cfg.id);
      chart.setDatasetVisibility(i, visible);
    });
    chart.options.scales.y.ticks.callback = (v) => formatMoneyAxis(v);

    // Give ~20% headroom above the tallest bar stack so the top-pinned tooltip
    // (and breakeven marker labels) never overlaps the tallest bars.
    const stackSums = {};
    chart.data.datasets.forEach((d, i) => {
      const cfg = datasetConfigs[i];
      if (cfg.type !== 'bar' || !chart.isDatasetVisible(i)) return;
      if (!stackSums[cfg.stack]) stackSums[cfg.stack] = new Array(d.data.length).fill(0);
      d.data.forEach((v, idx) => { stackSums[cfg.stack][idx] += (v || 0); });
    });
    let maxBarStack = 0;
    Object.values(stackSums).forEach(arr => arr.forEach(v => { if (v > maxBarStack) maxBarStack = v; }));
    let maxLine = 0;
    chart.data.datasets.forEach((d, i) => {
      const cfg = datasetConfigs[i];
      if (cfg.type !== 'line' || !chart.isDatasetVisible(i)) return;
      d.data.forEach(v => { if (v > maxLine) maxLine = v; });
    });
    const maxVal = Math.max(maxBarStack, maxLine);
    chart.options.scales.y.max = maxVal > 0 ? maxVal / 0.8 : undefined;

    const fs = state.fontScale;
    chart.options.scales.x.ticks.font.size = 12.5 * fs;
    chart.options.scales.y.ticks.font.size = 12.5 * fs;
    chart.options.plugins.tooltip.titleFont.size = 20 * fs;
    chart.options.plugins.tooltip.bodyFont.size = 19 * fs;
    chart.options.plugins.tooltip.footerFont.size = 17 * fs;

    chart._notionalAlerts = (state.metric === 'db') ? collectNotionalAlerts(years) : [];
    chart.update();
    if (wdChart) wdChart.update();
  } catch (chartErr){
    console.error('Compare chart render error:', chartErr);
  }
  buildLegend();

  const hasBreakevenMarkers = Object.keys(xirrLookupCompare).some(pk => {
    if (state.product !== 'all' && state.product !== pk) return false;
    const e = xirrLookupCompare[pk];
    return (e.breakevenYear !== null && years.indexOf(e.breakevenYear) !== -1) ||
           (e.gBreakYear !== null && years.indexOf(e.gBreakYear) !== -1);
  });
  document.getElementById('compareLegendNote').style.display = hasBreakevenMarkers ? 'flex' : 'none';

  const metricTh = state.metric === 'sv' ? 'Surrender Value / Account Value' : 'Death Benefit';
  const dbNote = state.metric === 'db' ? '  |  ⓘ แท่งซ้าย = (B) Guaranteed | แท่งขวา = (A)+(C+D)=(E)  |  เส้น Net Death Benefit = ค่าที่สูงกว่าระหว่าง (B) หรือ (E)' : '';
  let hint = `แกน X = Policy Year (และอายุผู้เอาประกัน)  |  แกน Y = ${metricTh} (${ccyLabel()})${dbNote}`;
  if (wdSeries.length) hint += '  |  แท่งล่าง = เงินถอนรายปี';
  if (state.metric === 'db'){
    const alerts = collectNotionalAlerts(years);
    const hard = alerts.filter(a => a.crossHard);
    const soft = alerts.filter(a => a.crossSoft && !a.crossHard);
    if (hard.length){
      const bits = hard.map(a => `ปีที่ ${a.crossHard.year}`);
      hint += `  |  ⚠ Notional Amount ต่ำกว่า ${formatMoney(NOTIONAL_HARD_USD * ccyMultiplier())} ตั้งแต่${bits.join(', ')}`;
    } else if (soft.length){
      const bits = soft.map(a => `ปีที่ ${a.crossSoft.year}`);
      hint += `  |  ⓘ Notional Amount ต่ำกว่า ${formatMoney(NOTIONAL_SOFT_USD * ccyMultiplier())} ตั้งแต่${bits.join(', ')}`;
    }
  }
  if (hasVisibleDualBasis()) hint += '  |  ⓘ ' + dualBasisDisclaimer(false);
  document.getElementById('chartHint').textContent = hint;
  const purposePop = document.getElementById('chartPurposePop');
  if (purposePop){
    let purpose = state.metric === 'db'
      ? 'เปรียบเทียบเงินคุ้มครองกรณีเสียชีวิต ตามปีกรมธรรม์ พร้อมเบี้ยที่จ่ายไปและทุนประกันหลังถอนเป็นเส้นอ้างอิง'
      : 'เปรียบเทียบมูลค่าเวนคืน/มูลค่าบัญชี ตามปีกรมธรรม์ พร้อมเบี้ยที่จ่ายไปเป็นเส้นอ้างอิง';
    if (hasVisibleDualBasis()) purpose += ' — ' + dualBasisDisclaimer(true);
    purposePop.textContent = purpose;
  }
}

/* ---------- XIRR + Breakeven view ---------- */
let xirrChart = null;

function getSvSeriesForXirr(product){
  if (!product || !product.sv) return null;
  const s = product.sv;
  const years = s.years;
  let totals, guaranteedArr, nonGuarArr;
  if (product.type === 'par'){
    totals = s.total; guaranteedArr = s.guaranteed; nonGuarArr = s.nonGuaranteed;
  } else {
    totals = s.surrenderValue || s.accountValue;
    const lowForXirr = dualLowBucket(s);
    guaranteedArr = (product.dualBasis && lowForXirr && lowForXirr.surrenderValue) ? lowForXirr.surrenderValue : null;
    nonGuarArr = null;
  }
  const premiums = s.premium || years.map(() => null);
  const hasPremium = premiums.some(p => p !== null && p !== undefined);
  const hasTotals = totals && totals.some(v => v !== null && v !== undefined);
  if (!hasPremium || !hasTotals) return null;
  const cashWithdrawal = s.cashWithdrawal || null;
  const cumulativeWithdrawal = s.cumulativeWithdrawal || null;
  return { years, ages: s.ages, totals, guaranteedArr, nonGuarArr, premiums, cashWithdrawal, cumulativeWithdrawal };
}

/* For the compare-view tooltip: precompute XIRR (normal + prepayment, when available) per
   product, aligned to the shared chart X-axis `years`, so the tooltip footer can look up the
   value at the hovered index without recomputing on every hover. */
let xirrLookupCompare = {};
function computeXirrLookupForYears(years){
  const out = {};
  ['p1','p2'].forEach(pk => {
    const p = resolveProductView(pk);
    if (!p) return;
    const data = getSvSeriesForXirr(p);
    if (!data) return;
    const xirrArr = computeXirrSeries(data.years, data.totals, data.premiums, data.cashWithdrawal);
    const xirrAligned = alignToYears(years, data.years, data.ages, xirrArr);
    const breakevenYear = findBreakevenYear(data.years, xirrArr);
    const gBreak = data.guaranteedArr ? findGuaranteedBreakeven(data.years, data.guaranteedArr, data.premiums) : null;
    let xirrPrepayAligned = null, breakevenYearPrepay = null, gBreakPrepay = null;
    if (p.prepayment && p.prepayment.lumpSum){
      const prepayPremiums = data.years.map(() => p.prepayment.lumpSum);
      const xirrPrepayArr = computeXirrSeries(data.years, data.totals, prepayPremiums, data.cashWithdrawal);
      xirrPrepayAligned = alignToYears(years, data.years, data.ages, xirrPrepayArr);
      breakevenYearPrepay = findBreakevenYear(data.years, xirrPrepayArr);
      gBreakPrepay = data.guaranteedArr ? findGuaranteedBreakeven(data.years, data.guaranteedArr, prepayPremiums) : null;
    }
    out[pk] = {
      label: p.label, xirr: xirrAligned, xirrPrepay: xirrPrepayAligned,
      breakevenYear, gBreakYear: gBreak ? gBreak.year : null,
      breakevenYearPrepay, gBreakYearPrepay: gBreakPrepay ? gBreakPrepay.year : null
    };
  });
  return out;
}

function renderXirrView(){
  const seg = document.getElementById('xirrProductSeg');
  const p1ok = !!state.products.p1, p2ok = !!state.products.p2;
  seg.querySelectorAll('[data-xirrproduct]').forEach(btn => {
    const key = btn.getAttribute('data-xirrproduct');
    const ok = key === 'p1' ? p1ok : p2ok;
    btn.style.display = ok ? '' : 'none';
  });
  if (!p1ok && !p2ok){
    document.getElementById('xirrEmptyState').style.display = 'flex';
    document.getElementById('xirrChartHolder').style.display = 'none';
    document.getElementById('xirrCards').innerHTML = '';
    document.getElementById('xirrCards').classList.remove('compact-row');
    document.getElementById('xirrCards').style.gridTemplateColumns = '';
    document.getElementById('xirrTable').innerHTML = '';
    document.getElementById('xirrLegendNote').style.display = 'none';
    document.getElementById('xirrNormalLabel').style.display = 'none';
    document.getElementById('xirrPrepayLabel').style.display = 'none';
    document.getElementById('xirrCardsPrepay').style.display = 'none';
    document.getElementById('xirrCardsPrepay').innerHTML = '';
    return;
  }
  if (state.xirrProduct === 'p1' && !p1ok) state.xirrProduct = 'p2';
  if (state.xirrProduct === 'p2' && !p2ok) state.xirrProduct = 'p1';
  seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-xirrproduct') === state.xirrProduct));

  const product = resolveProductView(state.xirrProduct);
  const data = getSvSeriesForXirr(product);

  if (!data){
    document.getElementById('xirrEmptyState').style.display = 'flex';
    document.getElementById('xirrChartHolder').style.display = 'none';
    document.getElementById('xirrCards').innerHTML = '';
    document.getElementById('xirrCards').classList.remove('compact-row');
    document.getElementById('xirrCards').style.gridTemplateColumns = '';
    document.getElementById('xirrTable').innerHTML = '';
    document.getElementById('xirrLegendNote').style.display = 'none';
    document.getElementById('xirrNormalLabel').style.display = 'none';
    document.getElementById('xirrPrepayLabel').style.display = 'none';
    document.getElementById('xirrCardsPrepay').style.display = 'none';
    document.getElementById('xirrCardsPrepay').innerHTML = '';
    document.getElementById('xirrTableSub').textContent = 'ไม่พบข้อมูลเบี้ยประกัน (Total Premiums Paid) หรือ Surrender Value ที่เพียงพอสำหรับคำนวณ';
    return;
  }
  document.getElementById('xirrEmptyState').style.display = 'none';
  document.getElementById('xirrChartHolder').style.display = 'block';

  const { years, ages, totals, guaranteedArr, nonGuarArr, premiums, cashWithdrawal, cumulativeWithdrawal } = data;
  const xirrArr = computeXirrSeries(years, totals, premiums, cashWithdrawal);
  const breakevenYear = findBreakevenYear(years, xirrArr);
  const breakevenYearInterp = findBreakevenYearInterpolated(years, xirrArr);
  const gBreak = guaranteedArr ? findGuaranteedBreakeven(years, guaranteedArr, premiums) : null;
  const gBreakInterp = guaranteedArr ? findGuaranteedBreakevenInterpolated(years, guaranteedArr, premiums) : null;
  const mult = ccyMultiplier();

  // ---- Prepayment scenario (only when the document offers it, e.g. Chubb "Illustration of
  // Premiums and Insurance Levy Prepayment"). Reuses the same XIRR engine: prepayment is
  // modelled as a single lump-sum outflow at t=0 by feeding a flat "cumulative premium" series. ----
  const prepay = product.prepayment;
  let xirrArrPrepay = null, breakevenYearPrepay = null, breakevenYearPrepayInterp = null, gBreakPrepay = null, gBreakPrepayInterp = null;
  if (prepay && prepay.lumpSum){
    const prepayPremiums = years.map(() => prepay.lumpSum);
    xirrArrPrepay = computeXirrSeries(years, totals, prepayPremiums, cashWithdrawal);
    breakevenYearPrepay = findBreakevenYear(years, xirrArrPrepay);
    breakevenYearPrepayInterp = findBreakevenYearInterpolated(years, xirrArrPrepay);
    gBreakPrepay = guaranteedArr ? findGuaranteedBreakeven(years, guaranteedArr, prepayPremiums) : null;
    gBreakPrepayInterp = guaranteedArr ? findGuaranteedBreakevenInterpolated(years, guaranteedArr, prepayPremiums) : null;
  }

  // ---- Summary cards (normal annual payment) ----
  const sched = inferPremiumSchedule(years, premiums);
  const totalPremium = sched ? sched.P * sched.term : null;
  const lastIdx = xirrArr.length - 1;
  const lastXirr = xirrArr[lastIdx];
  const lastYear = years[lastIdx];
  const lastAge = ages ? ages[lastIdx] : null;

  const longIdx = nearestYearIndex(years, 30);
  const longXirr = longIdx >= 0 ? xirrArr[longIdx] : null;
  const longYear = longIdx >= 0 ? years[longIdx] : null;
  const longSv = longIdx >= 0 ? totals[longIdx] : null;

  function addCard(container, cls, label, value, sub){
    const c = document.createElement('div');
    c.className = 'xirr-card ' + cls;
    c.innerHTML = `<div class="lbl">${label}</div><div class="val">${value}</div>` + (sub ? `<div class="sub">${sub}</div>` : '');
    container.appendChild(c);
  }
  function addPairCard(container, cls, label, lineA, lineB, sub){
    const c = document.createElement('div');
    c.className = 'xirr-card ' + cls;
    c.innerHTML = `<div class="lbl">${label}</div>` +
      `<div class="val-pair"><div><span class="mode">ปกติ</span> <span class="figure">${lineA}</span></div>` +
      `<div><span class="mode prepay">Prepay</span> <span class="figure">${lineB}</span></div></div>` +
      (sub ? `<div class="sub">${sub}</div>` : '');
    container.appendChild(c);
  }

  const cardsEl = document.getElementById('xirrCards');
  cardsEl.innerHTML = '';
  const hasPrepayData = !!(xirrArrPrepay);
  const showPrepay = hasPrepayData && showPrepayCompare();
  const compactKpi = hasPrepayData;
  cardsEl.classList.toggle('compact-row', compactKpi);

  const lastXirrP = xirrArrPrepay ? xirrArrPrepay[lastIdx] : null;
  const longXirrP = xirrArrPrepay && longIdx >= 0 ? xirrArrPrepay[longIdx] : null;

  function withdrawalCardSub(){
    if (!cashWithdrawal) return '';
    const startIdx = cashWithdrawal.findIndex(w => w !== null && w !== undefined && w > 0);
    if (startIdx < 0) return '';
    const startY = years[startIdx];
    const startA = ages ? ages[startIdx] : null;
    const amt = cashWithdrawal[startIdx];
    const later = cashWithdrawal.filter((w, i) => i >= startIdx && w !== null && w !== undefined && w > 0);
    const level = later.length > 0 && later.every(w => Math.abs(w - amt) < 0.51);
    return `เริ่มปีที่ ${startY}${startA !== null && startA !== undefined ? ' (อายุ ' + startA + ')' : ''}` +
           (level ? ` ปีละ ${moneyHtml(amt * mult)}` : ' (ยอดถอนไม่คงที่ตามตาราง)');
  }
  function lastCumulativeWithdrawal(){
    if (!cumulativeWithdrawal) return null;
    for (let i = cumulativeWithdrawal.length - 1; i >= 0; i--){
      const v = cumulativeWithdrawal[i];
      if (v !== null && v !== undefined && !isNaN(v)) return v;
    }
    return null;
  }

  if (compactKpi){
    if (showPrepay){
      addPairCard(cardsEl, 'premium', 'เบี้ย / เงินจ่ายจริง',
        totalPremium !== null ? formatMoney(totalPremium * mult) : '—',
        formatMoney(prepay.lumpSum * mult),
        sched ? `ชำระเบี้ย ${sched.term} ปี ปีละ ${moneyHtml(sched.P * mult)}` : '');
    } else {
      addCard(cardsEl, 'premium', 'เบี้ยสะสมทั้งหมด',
        totalPremium !== null ? formatMoney(totalPremium * mult) : '—',
        sched ? `ชำระเบี้ย ${sched.term} ปี ปีละ ${moneyHtml(sched.P * mult)}` : '');
    }
    if (product.scenario === 'withdrawal'){
      const lastCum = lastCumulativeWithdrawal();
      addCard(cardsEl, 'withdrawal', 'เงินถอนสะสมทั้งหมด',
        lastCum !== null ? formatMoney(lastCum * mult) : '—', withdrawalCardSub());
    }
    if (showPrepay){
      addPairCard(cardsEl, 'breakeven', 'จุดคุ้มทุน (Cash Breakeven)',
        breakevenYearInterp !== null ? ('ปีที่ ' + breakevenYearInterp.toFixed(1)) : 'ยังไม่ถึง',
        breakevenYearPrepayInterp !== null ? ('ปีที่ ' + breakevenYearPrepayInterp.toFixed(1)) : 'ยังไม่ถึง',
        '');
      if (guaranteedArr){
        addPairCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven',
          gBreakInterp ? ('ปีที่ ' + gBreakInterp.year.toFixed(1)) : 'ยังไม่ถึง',
          gBreakPrepayInterp ? ('ปีที่ ' + gBreakPrepayInterp.year.toFixed(1)) : 'ยังไม่ถึง',
          '');
      } else {
        addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven', 'ไม่มีข้อมูล', 'สินค้านี้ไม่แยก Guaranteed/Non-Guaranteed');
      }
      addPairCard(cardsEl, '', `ผลตอบแทนระยะยาว${longYear!==null?' (ปีที่ '+longYear+')':''}`,
        longXirr !== null ? xirrColorSpan(longXirr, (longXirr*100).toFixed(2) + '%') : '—',
        longXirrP !== null ? xirrColorSpan(longXirrP, (longXirrP*100).toFixed(2) + '%') : '—',
        longSv!==null&&longSv!==undefined ? `SV = ${moneyHtml(longSv*mult)}` : '');
    } else {
      addCard(cardsEl, 'breakeven', 'จุดคุ้มทุน (Cash Breakeven)',
        breakevenYearInterp !== null ? ('ปีที่ ' + breakevenYearInterp.toFixed(1)) : 'ยังไม่ถึง',
        breakevenYear !== null ? `≈ XIRR 0% (คำนวณ interpolation, ปีเต็มถัดไปคือปีที่ ${breakevenYear})` : '');
      if (guaranteedArr){
        addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven',
          gBreakInterp ? ('ปีที่ ' + gBreakInterp.year.toFixed(1)) : 'ยังไม่ถึง',
          gBreakInterp ? `GCV ≈ ${moneyHtml(gBreakInterp.guaranteedValue * mult)} (interpolation, ปีเต็มถัดไปคือปีที่ ${gBreak.year})` : 'GCV ยังไม่แซงเบี้ยสะสม');
      } else {
        addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven', 'ไม่มีข้อมูล', 'สินค้านี้ไม่แยก Guaranteed/Non-Guaranteed');
      }
      addCard(cardsEl, '', `ผลตอบแทนระยะยาว${longYear!==null?' (ปีที่ '+longYear+')':''}`,
        longXirr !== null ? xirrColorSpan(longXirr, (longXirr*100).toFixed(2) + '% p.a.') : '—',
        longSv!==null&&longSv!==undefined ? `SV = ${moneyHtml(longSv*mult)}` : '');
    }
  } else {
    addCard(cardsEl, 'premium', 'เบี้ยสะสมทั้งหมด',
      totalPremium !== null ? formatMoney(totalPremium * mult) : '—',
      sched ? `ชำระเบี้ย ${sched.term} ปี ปีละ ${moneyHtml(sched.P * mult)}` : '');
    if (cumulativeWithdrawal){
      const lastCum = lastCumulativeWithdrawal();
      addCard(cardsEl, 'withdrawal', 'เงินถอนสะสมทั้งหมด',
        lastCum !== null ? formatMoney(lastCum * mult) : '—', withdrawalCardSub());
    }
    addCard(cardsEl, 'breakeven', 'จุดคุ้มทุน (Cash Breakeven)',
      breakevenYearInterp !== null ? ('ปีที่ ' + breakevenYearInterp.toFixed(1)) : 'ยังไม่ถึง',
      breakevenYear !== null ? `≈ XIRR 0% (คำนวณ interpolation, ปีเต็มถัดไปคือปีที่ ${breakevenYear})` : '');
    if (guaranteedArr){
      addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven',
        gBreakInterp ? ('ปีที่ ' + gBreakInterp.year.toFixed(1)) : 'ยังไม่ถึง',
        gBreakInterp ? `GCV ≈ ${moneyHtml(gBreakInterp.guaranteedValue * mult)} (interpolation, ปีเต็มถัดไปคือปีที่ ${gBreak.year})` : 'GCV ยังไม่แซงเบี้ยสะสม');
    } else {
      addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven', 'ไม่มีข้อมูล', 'สินค้านี้ไม่แยก Guaranteed/Non-Guaranteed');
    }
    addCard(cardsEl, '', `ผลตอบแทนระยะยาว${longYear!==null?' (ปีที่ '+longYear+')':''}`,
      longXirr !== null ? xirrColorSpan(longXirr, (longXirr*100).toFixed(2) + '% p.a.') : '—',
      longSv!==null&&longSv!==undefined ? `SV = ${moneyHtml(longSv*mult)}` : '');
    addCard(cardsEl, '', `ถือยาวยิ่งดี (ปีที่ ${lastYear}${lastAge!==null&&lastAge!==undefined?', อายุ '+lastAge:''})`,
      lastXirr !== null ? xirrColorSpan(lastXirr, (lastXirr*100).toFixed(2) + '% p.a.') : '—',
      totals[lastIdx]!==null&&totals[lastIdx]!==undefined ? `SV = ${moneyHtml(totals[lastIdx]*mult)}` : '');
  }

  if (compactKpi){
    const n = cardsEl.children.length;
    cardsEl.style.gridTemplateColumns = n ? `repeat(${n}, 1fr)` : '';
  } else {
    cardsEl.style.gridTemplateColumns = '';
  }

  document.getElementById('xirrLegendNote').style.display = 'flex';
  const prepayNoteEl = document.getElementById('xirrPrepayLegendNote');
  if (prepayNoteEl) prepayNoteEl.style.display = showPrepay ? '' : 'none';

  // ---- Summary cards (prepayment) — separate row only when NOT in compact withdrawal+prepay mode ----
  const normalLabelEl = document.getElementById('xirrNormalLabel');
  const prepayLabelEl = document.getElementById('xirrPrepayLabel');
  const cardsPrepayEl = document.getElementById('xirrCardsPrepay');
  if (xirrArrPrepay && !compactKpi){
    normalLabelEl.style.display = 'flex';
    prepayLabelEl.style.display = 'flex';
    cardsPrepayEl.style.display = 'grid';
    cardsPrepayEl.innerHTML = '';
    addCard(cardsPrepayEl, 'premium', 'เงินจ่ายจริงครั้งเดียว',
      formatMoney(prepay.lumpSum * mult),
      prepay.source === 'chubb'
        ? `ปีแรก ${formatMoney(prepay.year1Payment*mult)} + จ่ายล่วงหน้า ${formatMoney(prepay.prepaidAmount*mult)}`
        : (prepay.source === 'adjusted' ? 'หลังหักส่วนลด/Rebate ตามเอกสาร' : 'ยอดจ่ายล่วงหน้าครอบคลุมทุกปีตามเอกสาร'));
    addCard(cardsPrepayEl, 'breakeven', 'จุดคุ้มทุน (Cash Breakeven)',
      breakevenYearPrepayInterp !== null ? ('ปีที่ ' + breakevenYearPrepayInterp.toFixed(1)) : 'ยังไม่ถึง',
      breakevenYearPrepay !== null ? `≈ XIRR 0% (interpolation, ปีเต็มถัดไปคือปีที่ ${breakevenYearPrepay})` : '');
    if (guaranteedArr){
      addCard(cardsPrepayEl, 'gbreakeven', 'Guaranteed Breakeven',
        gBreakPrepayInterp ? ('ปีที่ ' + gBreakPrepayInterp.year.toFixed(1)) : 'ยังไม่ถึง',
        gBreakPrepayInterp ? `GCV ≈ ${formatMoney(gBreakPrepayInterp.guaranteedValue * mult)} (interpolation, ปีเต็มถัดไปคือปีที่ ${gBreakPrepay.year})` : 'GCV ยังไม่แซงเงินจ่ายจริง');
    } else {
      addCard(cardsPrepayEl, 'gbreakeven', 'Guaranteed Breakeven', 'ไม่มีข้อมูล', 'สินค้านี้ไม่แยก Guaranteed/Non-Guaranteed');
    }
    addCard(cardsPrepayEl, '', `ผลตอบแทนระยะยาว${longYear!==null?' (ปีที่ '+longYear+')':''}`,
      longXirrP !== null ? xirrColorSpan(longXirrP, (longXirrP*100).toFixed(2) + '% p.a.') : '—',
      longSv!==null&&longSv!==undefined ? `SV = ${formatMoney(longSv*mult)}` : '');
    addCard(cardsPrepayEl, '', `ถือยาวยิ่งดี (ปีที่ ${lastYear}${lastAge!==null&&lastAge!==undefined?', อายุ '+lastAge:''})`,
      lastXirrP !== null ? xirrColorSpan(lastXirrP, (lastXirrP*100).toFixed(2) + '% p.a.') : '—',
      totals[lastIdx]!==null&&totals[lastIdx]!==undefined ? `SV = ${formatMoney(totals[lastIdx]*mult)}` : '');
  } else {
    normalLabelEl.style.display = 'none';
    prepayLabelEl.style.display = 'none';
    cardsPrepayEl.style.display = 'none';
    cardsPrepayEl.innerHTML = '';
  }

  // ---- Chart (respects the X-axis range setting; KPI cards above always use full data) ----
  const rangeLimit = state.xAxisRange;
  const visIdx = years.map((y,i) => i).filter(i => !isFinite(rangeLimit) || years[i] <= rangeLimit);
  const vYears = visIdx.map(i => years[i]);
  const vAges = visIdx.map(i => ages ? ages[i] : null);
  const vXirr = visIdx.map(i => xirrArr[i]);
  const vXirrPrepay = xirrArrPrepay ? visIdx.map(i => xirrArrPrepay[i]) : null;

  const hintEl = document.getElementById('xirrChartHint');
  let hintTxt = 'แกน X = สิ้นปีกรมธรรม์  |  แกน Y = XIRR (% p.a.)';
  const outOfView = [];
  if (isFinite(rangeLimit)){
    if (breakevenYear !== null && breakevenYear > rangeLimit) outOfView.push(`Cash Breakeven (ปกติ, ปีที่ ${breakevenYear})`);
    if (gBreak !== null && gBreak.year > rangeLimit) outOfView.push(`Guaranteed Breakeven (ปกติ, ปีที่ ${gBreak.year})`);
    if (showPrepay && breakevenYearPrepay !== null && breakevenYearPrepay > rangeLimit) outOfView.push(`Cash Breakeven (Prepayment, ปีที่ ${breakevenYearPrepay})`);
    if (showPrepay && gBreakPrepay !== null && gBreakPrepay.year > rangeLimit) outOfView.push(`Guaranteed Breakeven (Prepayment, ปีที่ ${gBreakPrepay.year})`);
  }
  if (outOfView.length){
    hintTxt += `  —  ⚠ ${outOfView.join(', ')} อยู่นอกช่วงที่แสดง กด "ทั้งหมด" เพื่อดู`;
  }
  hintEl.textContent = hintTxt;

  try {
    const labels = vYears.map((y,i) => {
      if (vAges[i]!==null && vAges[i]!==undefined && vAges[i] % 5 === 0) return [`Y${y}`, `อายุ ${vAges[i]}`];
      return [`Y${y}`];
    });
    const xirrPct = vXirr.map(v => v === null ? null : v * 100);

    if (xirrChart) { xirrChart.destroy(); xirrChart = null; }
    const staleXirrTooltip = document.querySelector('#xirrChartHolder .custom-tooltip');
    if (staleXirrTooltip) staleXirrTooltip.style.opacity = 0;
    const ctx = document.getElementById('xirrCanvas').getContext('2d');
    const fs = state.fontScale;
    const datasets = [];
    let vXirrGhost = null;
    if (product.scenario === 'withdrawal'){
      const raw = state.products[state.xirrProduct];
      if (raw){
        const baseData = getSvSeriesForXirr({
          label: raw.label, type: raw.type, sv: raw.sv, db: raw.db, prepayment: raw.prepayment, scenario: 'base'
        });
        if (baseData){
          const baseXirr = computeXirrSeries(baseData.years, baseData.totals, baseData.premiums, null);
          vXirrGhost = visIdx.map(i => {
            const y = years[i];
            const bi = baseData.years.indexOf(y);
            return bi === -1 ? null : baseXirr[bi];
          });
          datasets.push({
            label: 'XIRR (No Withdrawal)',
            data: vXirrGhost.map(v => v === null ? null : v * 100),
            borderColor: GHOST_LINE_COLOR, backgroundColor: GHOST_LINE_COLOR,
            borderWidth: 1.6, pointRadius: 0, tension: .15, fill: false, spanGaps: true, isGhostRef: true
          });
        }
      }
    }
    datasets.push({
      label: (showPrepay && xirrArrPrepay) ? 'แบบจ่ายทีละปี (ปกติ)' : 'XIRR (% p.a.)',
      data: xirrPct,
      borderColor: '#0b3d91', backgroundColor: '#0b3d91',
      borderWidth: 2.5, pointRadius: 3, tension: .15, fill: false, spanGaps: true, isXirrNormal: true
    });
    if (showPrepay && vXirrPrepay){
      datasets.push({
        label: 'แบบ Prepayment',
        data: vXirrPrepay.map(v => v === null ? null : v * 100),
        borderColor: '#1f7a4d', backgroundColor: '#1f7a4d',
        borderWidth: 2.5, pointRadius: 3, tension: .15, fill: false, spanGaps: true, borderDash: [6,3], isXirrPrepay: true
      });
    }
    const ghostPct = vXirrGhost ? vXirrGhost.map(v => v === null ? null : v * 100) : [];
    const allVals = xirrPct.concat(showPrepay && vXirrPrepay ? vXirrPrepay.map(v=>v===null?null:v*100) : []).concat(ghostPct).filter(v => v !== null && v !== undefined);
    const dataMax = allVals.length ? Math.max(...allVals) : null;
    const dataMin = allVals.length ? Math.min(...allVals) : null;
    let yMax;
    if (dataMax !== null){
      const span = Math.max(dataMax - Math.min(dataMin, 0), 1);
      yMax = dataMax + span * 0.25;
    }
    xirrChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive:true, maintainAspectRatio:false,
        layout:{ padding:{top:4} },
        interaction:{ mode:'index', intersect:false },
        scales:{
          x:{ grid:{display:false}, ticks:{ font:{size:12.5*fs,family:"'Inter','Kanit',sans-serif"}, autoSkip:true, maxTicksLimit:20, maxRotation:0, minRotation:0 } },
          y:{ max: yMax, ticks:{ font:{size:12.5*fs,family:"'Inter','Kanit',sans-serif"}, callback:(v)=> v.toFixed(1)+'%' }, grid:{color:'#eee'} }
        },
        plugins:{
          legend:{ display: datasets.length > 1, position:'top', labels:{ boxWidth:16, font:{size:11.5*fs,family:"'Kanit','Inter',sans-serif"} } },
          tooltip:{
            enabled:false,
            external: (context) => renderXirrTooltip(context, vYears, vAges)
          }
        }
      },
      plugins: [crosshairPlugin, xirrBreakevenPlugin]
    });
    xirrChart._years = vYears;
    xirrChart._breakevenInfo = {
      breakevenYear, gBreakYear: gBreak ? gBreak.year : null,
      breakevenYearPrepay: showPrepay ? breakevenYearPrepay : null,
      gBreakYearPrepay: showPrepay && gBreakPrepay ? gBreakPrepay.year : null
    };
  } catch (chartErr){
    console.error('XIRR chart render error:', chartErr);
  }

  // ---- Table ----
  const tableEl = document.getElementById('xirrTable');
  const isPar = product.type === 'par';
  let headHtml = '<thead><tr><th>ปี</th><th>อายุ</th><th>เบี้ยสะสม</th>';
  const hasWdCols = !!(cashWithdrawal || cumulativeWithdrawal);
  if (hasWdCols) headHtml += '<th>ถอนปีนี้</th><th>ถอนสะสม</th>';
  if (isPar) headHtml += '<th>Guaranteed</th><th>Non-Guar.</th>';
  headHtml += `<th>${isPar ? 'Total SV' : 'Surrender Value'}</th><th>XIRR (ปกติ)</th>`;
  if (showPrepay) headHtml += '<th>XIRR (Prepayment)</th>';
  headHtml += '</tr></thead>';
  let bodyHtml = '<tbody>';
  years.forEach((y, i) => {
    const isBreakeven = breakevenYear !== null && y === breakevenYear;
    const isGBreakeven = gBreak !== null && y === gBreak.year;
    let rowClass = '';
    if (isBreakeven && isGBreakeven) rowClass = ' class="breakeven-row gbreakeven-row"';
    else if (isBreakeven) rowClass = ' class="breakeven-row"';
    else if (isGBreakeven) rowClass = ' class="gbreakeven-row"';
    const age = ages ? ages[i] : null;
    const prem = premiums[i];
    const g = guaranteedArr ? guaranteedArr[i] : null;
    const ng = nonGuarArr ? nonGuarArr[i] : null;
    const tot = totals[i];
    const xv = xirrArr[i];
    const xirrCls = xv === null ? '' : (xv >= 0 ? 'pos' : 'neg');
    bodyHtml += `<tr>`;
    bodyHtml += `<td${rowClass}>Y${y}</td>`;
    bodyHtml += `<td${rowClass}>${age!==null&&age!==undefined?age:'—'}</td>`;
    bodyHtml += `<td${rowClass}>${prem!==null&&prem!==undefined?formatMoneyTable(prem*mult):'—'}</td>`;
    if (hasWdCols){
      const w = cashWithdrawal ? cashWithdrawal[i] : null;
      const cw = cumulativeWithdrawal ? cumulativeWithdrawal[i] : null;
      bodyHtml += `<td${rowClass}>${w!==null&&w!==undefined?formatMoneyTable(w*mult):'—'}</td>`;
      bodyHtml += `<td${rowClass}>${cw!==null&&cw!==undefined?formatMoneyTable(cw*mult):'—'}</td>`;
    }
    if (isPar){
      bodyHtml += `<td${rowClass}>${g!==null&&g!==undefined?formatMoneyTable(g*mult):'—'}</td>`;
      bodyHtml += `<td${rowClass}>${ng!==null&&ng!==undefined?formatMoneyTable(ng*mult):'—'}</td>`;
    }
    bodyHtml += `<td${rowClass}>${tot!==null&&tot!==undefined?formatMoneyTable(tot*mult):'—'}</td>`;
    bodyHtml += `<td${rowClass} class="${xirrCls}">${xv===null?'—':(xv*100).toFixed(2)+'%'}</td>`;
    if (showPrepay){
      const xvP = xirrArrPrepay[i];
      const isBreakevenP = breakevenYearPrepay !== null && y === breakevenYearPrepay;
      const isGBreakevenP = gBreakPrepay !== null && y === gBreakPrepay.year;
      const xirrClsP = (xvP === null ? '' : (xvP >= 0 ? 'pos' : 'neg')) + (isBreakevenP ? ' prepay-cash-mark' : '') + (isGBreakevenP ? ' prepay-g-mark' : '');
      bodyHtml += `<td class="${xirrClsP}">${xvP===null?'—':(xvP*100).toFixed(2)+'%'}</td>`;
    }
    bodyHtml += `</tr>`;
  });
  bodyHtml += '</tbody>';
  tableEl.innerHTML = headHtml + bodyHtml;
  let subTxt = `${product.label}${product.scenario === 'withdrawal' ? ' · Withdrawal' : ''}` +
    ` · Cash Breakeven ปีที่ ${breakevenYear !== null ? breakevenYear : '—'}` +
    (gBreak ? ` · Guaranteed Breakeven ปีที่ ${gBreak.year}` : '');
  if (showPrepay){
    subTxt += ` | Prepayment: Cash Breakeven ปีที่ ${breakevenYearPrepay !== null ? breakevenYearPrepay : '—'}` +
      (gBreakPrepay ? ` · Guaranteed Breakeven ปีที่ ${gBreakPrepay.year}` : '');
  }
  document.getElementById('xirrTableSub').textContent = subTxt;
}

/* ---------- File handling ---------- */
async function handleFile(slot, file){
  const nameEl = document.getElementById('fileName' + slot);
  const cardEl = document.querySelector('.upload-card-compact.slot' + slot);
  nameEl.textContent = `สินค้าที่ ${slot}: กำลังอ่าน "${file.name}"...`;
  nameEl.title = file.name;
  cardEl.className = 'upload-card-compact slot' + slot + ' busy';

  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const html = result.value;
    const rawText = html.replace(/<[^>]+>/g, ' ');
    const parsed = parseIllustrationHtml(html, rawText);

    if (!parsed.type){
      cardEl.className = 'upload-card-compact slot' + slot + ' err';
      nameEl.textContent = `สินค้าที่ ${slot}: ไม่พบตาราง SV/DB ในเอกสารนี้`;
      nameEl.title = file.name + ' — ลองตรวจสอบว่าเอกสารมีตาราง Summary Illustration แบบมาตรฐาน';
      state.products['p' + slot] = null;
      state.scenario['p' + slot] = 'base';
      finalizeProductLabel(slot, null);
      render();
      return;
    }

    const cleanPlanName = (parsed.meta.planName && parsed.meta.planName.length <= 90) ? parsed.meta.planName : null;
    const rawLabel = cleanPlanName || file.name.replace(/\.docx$/i,'');
    const label = shortenProductName(rawLabel) || rawLabel;
    state.products['p' + slot] = {
      label, type: parsed.type, sv: parsed.sv, db: parsed.db, prepayment: parsed.prepayment,
      svWithdrawal: parsed.svWithdrawal || null, dbWithdrawal: parsed.dbWithdrawal || null,
      dualBasis: !!parsed.dualBasis,
      dualKind: parsed.dualKind || null,
      assumedCreditingRate: parsed.assumedCreditingRate || null
    };
    state.scenario['p' + slot] = 'base';

    cardEl.className = 'upload-card-compact slot' + slot + ' ok';
    nameEl.textContent = `สินค้าที่ ${slot}: ${label} ✓`;
    const bits = [file.name];
    if (parsed.meta.insuredName) bits.push('ผู้เอาประกัน: ' + parsed.meta.insuredName);
    bits.push('ประเภท: ' + (parsed.type === 'par' ? 'Guaranteed/Non-Guaranteed (PAR)' : 'Account/Surrender/Death Benefit (UL)'));
    const nPts = (parsed.sv ? parsed.sv.years.length : 0) || (parsed.db ? parsed.db.years.length : 0);
    bits.push('จุดข้อมูล: ' + nPts + ' ปี');
    if (parsed.dualBasis) bits.push(parsed.dualKind === 'conservative'
      ? '2 ฐาน: Conservative / Current Assumed'
      : '2 ฐาน: Guaranteed / Current Assumed');
    if (parsed.svWithdrawal || parsed.dbWithdrawal) bits.push('มีตาราง Withdrawal');
    nameEl.title = bits.join(' · ');

    finalizeProductLabel(slot, label);
    resetLegendVisibility();
    try {
      render();
    } catch (renderErr){
      console.error('Chart render error:', renderErr);
      nameEl.title += ' · (เกิดปัญหาขณะวาดกราฟ ลองรีเฟรชหน้า)';
    }
  } catch (err){
    cardEl.className = 'upload-card-compact slot' + slot + ' err';
    nameEl.textContent = `สินค้าที่ ${slot}: อ่านไฟล์ไม่สำเร็จ`;
    nameEl.title = 'เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : 'unknown error');
    state.products['p' + slot] = null;
    state.scenario['p' + slot] = 'base';
    finalizeProductLabel(slot, null);
    try { render(); } catch (e2){ console.error('Chart render error:', e2); }
  }
}

/* Distills a full plan name or filename down to a short, recognizable product label
   (e.g. "SunJoy Global", "SunRise UL II", "Chubb MyLegacy V Harvest") for compact display
   in the sidebar, instead of the full original filename or long printed plan title. */
function shortenProductName(rawName){
  if (!rawName) return null;
  const text = rawName.replace(/[_]+/g, ' ');
  const patterns = [
    { re: /sun\s*joy[\s\-]*global/i, out: 'SunJoy Global' },
    { re: /sun\s*rise[\s\-]*(?:ul)?[\s\-]*(ii|ll|2)?/i, out: (m) => 'SunRise UL' + (m[1] ? ' ' + m[1].toUpperCase().replace(/LL/,'II') : '') },
    { re: /chubb.*?my\s*legacy.*?\b(harvest|blossom)\b/i, out: (m) => 'Chubb MyLegacy V ' + (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) },
    { re: /my\s*legacy.*?\b(harvest|blossom)\b/i, out: (m) => 'Chubb MyLegacy V ' + (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) },
    { re: /axa.*?fortune\s*xtra/i, out: 'AXA FortuneXtra' },
    { re: /generali.*?lion\s*achiever(?:\s*elite)?/i, out: 'Generali LionAchiever Elite' },
    { re: /aia.*?(?:singapore|sg)/i, out: 'AIA Singapore' },
    { re: /fwd[\s\-]*[\w]*/i, out: (m) => m[0].trim() }
  ];
  for (const p of patterns){
    const m = text.match(p.re);
    if (m) return typeof p.out === 'function' ? p.out(m) : p.out;
  }
  const cleaned = text.replace(/\.docx$/i, '').replace(/\s{2,}/g, ' ').trim();
  return cleaned.length > 26 ? cleaned.slice(0, 24) + '…' : cleaned;
}

function finalizeProductLabel(slot, label){
  const shortLabel = label ? (label.length > 22 ? label.slice(0,20)+'…' : label) : ('สินค้าที่ ' + slot);
  const btn = document.querySelector('#productSeg [data-product="p' + slot + '"]');
  btn.textContent = shortLabel;
  const xirrBtn = document.querySelector('#xirrProductSeg [data-xirrproduct="p' + slot + '"]');
  if (xirrBtn) xirrBtn.textContent = shortLabel;
}

/* ---------- Wiring ---------- */
document.getElementById('pickBtn1').addEventListener('click', () => document.getElementById('fileInput1').click());
document.getElementById('pickBtn2').addEventListener('click', () => document.getElementById('fileInput2').click());
document.getElementById('fileInput1').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(1, e.target.files[0]); });
document.getElementById('fileInput2').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(2, e.target.files[0]); });

function wireSeg(segId, attr, onChange){
  const seg = document.getElementById(segId);
  seg.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.getAttribute(attr));
    });
  });
}
wireSeg('viewModeSeg', 'data-view', (val) => { state.viewMode = val; render(); });
wireSeg('metricSeg', 'data-metric', (val) => { state.metric = val; resetLegendVisibility(); render(); });
wireSeg('scenarioSeg', 'data-scenario', (val) => {
  relevantProductKeys().forEach(pk => {
    if (productHasWithdrawal(state.products[pk])) state.scenario[pk] = val;
  });
  resetLegendVisibility();
  render();
});
wireSeg('prepaySeg', 'data-prepay', (val) => { state.showPrepay = (val === 'on'); render(); });
wireSeg('productSeg', 'data-product', (val) => { state.product = val; resetLegendVisibility(); render(); });
wireSeg('xirrProductSeg', 'data-xirrproduct', (val) => { state.xirrProduct = val; render(); });
wireSeg('rangeSeg', 'data-range', (val) => { state.xAxisRange = (val === 'all') ? Infinity : parseInt(val, 10); render(); });
wireSeg('currencySeg', 'data-ccy', (val) => {
  state.currency = val;
  document.getElementById('fxInputWrap').style.display = (val === 'thb') ? 'flex' : 'none';
  render();
});
document.getElementById('fxRate').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0){ state.rate = v; render(); }
});

const fontSeg = document.getElementById('fontSeg');
fontSeg.querySelectorAll('.fs-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    fontSeg.querySelectorAll('.fs-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const v = parseFloat(btn.getAttribute('data-fs'));
    state.fontScale = v;
    document.documentElement.style.setProperty('--fs-mult', v);
    render();
  });
});

(function wireGlossary(){
  const overlay = document.getElementById('glossaryOverlay');
  const openBtn = document.getElementById('glossaryBtn');
  const closeBtn = document.getElementById('glossaryClose');
  const modal = overlay && overlay.querySelector('.glossary-modal');
  if (!overlay || !openBtn || !closeBtn) return;

  function openGlossary(){
    overlay.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    closeBtn.focus();
  }
  function closeGlossary(){
    if (overlay.hidden) return;
    overlay.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
    openBtn.focus();
  }

  openBtn.addEventListener('click', openGlossary);
  closeBtn.addEventListener('click', closeGlossary);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGlossary(); });
  if (modal) modal.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape'){
      if (!overlay.hidden){ e.preventDefault(); closeGlossary(); return; }
      document.querySelectorAll('.info-btn.is-open').forEach(btn => {
        btn.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      });
    }
  });
})();

(function wireInfoTips(){
  document.querySelectorAll('.info-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = btn.classList.contains('is-open');
      document.querySelectorAll('.info-btn.is-open').forEach(other => {
        other.classList.remove('is-open');
        other.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen){
        btn.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.info-btn.is-open').forEach(btn => {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    });
  });
})();

render();
