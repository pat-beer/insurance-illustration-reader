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
    year1Payment: /total initial annual premium and insurance levy/i,
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
  return null;
}

/* ---------- Main parser: given mammoth HTML string, extract SV/DB series ---------- */
function parseIllustrationHtml(html, rawText){
  const parser = new DOMParser();
  const doc = parser.parseFromString('<div>' + html + '</div>', 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));

  // candidate groups keyed by signature -> {kind, rows:[], colHeaders, meta...}
  const svCandidates = {};
  const dbCandidates = {};
  const flatCandidates = {}; // for UL: {sig: {av:[], sv:[], db:[]}}

  tables.forEach(tableEl => {
    const { grid, maxCols } = normalizeTable(tableEl);
    if (maxCols < 3 || grid.length < 2) return;
    const { headerRows, dataRows } = splitHeaderData(grid);
    if (dataRows.length === 0 || headerRows.length === 0) return;
    const colHeaders = columnHeaders(headerRows, maxCols);
    const fullHeaderLower = colHeaders.join(' ').toLowerCase();
    if (fullHeaderLower.includes('withdrawal')) return; // skip supplementary "under withdrawal arrangement" tables — different scenario, not the base plan

    const yearCol = 0;
    let ageColIdx = null;
    colHeaders.forEach((h, idx) => {
      if (idx !== yearCol && /\bage\b/i.test(h) && !/at\s*age/i.test(h)) { if (ageColIdx === null) ageColIdx = idx; }
    });
    const premiumColIdx = findPremiumCol(colHeaders, 0, maxCols - 1);

    const guarCols = findGuaranteedCols(colHeaders);

    if (guarCols.length >= 2){
      // Combined table: zone1 = SV (before 2nd guaranteed marker), zone2 = DB (from 2nd marker to end)
      const zone1End = guarCols[1] - 1;
      const zone2End = maxCols - 1;
      const svRows = extractParZone(dataRows, colHeaders, guarCols[0], zone1End, yearCol, ageColIdx, premiumColIdx);
      const dbRows = extractParZone(dataRows, colHeaders, guarCols[1], zone2End, yearCol, ageColIdx, premiumColIdx);
      const sig1 = headerSignature(colHeaders, [0, zone1End]);
      const sig2 = headerSignature(colHeaders, [guarCols[1], zone2End]);
      if (!svCandidates[sig1]) svCandidates[sig1] = [];
      svCandidates[sig1].push(...svRows);
      if (!dbCandidates[sig2]) dbCandidates[sig2] = [];
      dbCandidates[sig2].push(...dbRows);
    } else if (guarCols.length === 1){
      const zoneEnd = maxCols - 1;
      const rows = extractParZone(dataRows, colHeaders, guarCols[0], zoneEnd, yearCol, ageColIdx, premiumColIdx);
      const sig = headerSignature(colHeaders, [0, zoneEnd]);
      const isDb = fullHeaderLower.includes('death benefit');
      const isSv = fullHeaderLower.includes('surrender value');
      if (isDb && !isSv){
        if (!dbCandidates[sig]) dbCandidates[sig] = [];
        dbCandidates[sig].push(...rows);
      } else {
        if (!svCandidates[sig]) svCandidates[sig] = [];
        svCandidates[sig].push(...rows);
      }
    } else {
      // Possibly a flat UL-style table: Account Value / Surrender Value / Death Benefit as single columns
      let avCol = -1, svCol = -1, dbCol = -1;
      colHeaders.forEach((h, idx) => {
        const lh = h.toLowerCase();
        if (avCol === -1 && lh.includes('account value')) avCol = idx;
        if (svCol === -1 && lh.includes('surrender value')) svCol = idx;
        if (dbCol === -1 && lh.includes('death benefit')) dbCol = idx;
      });
      if (svCol !== -1 || dbCol !== -1 || avCol !== -1){
        const sig = headerSignature(colHeaders, [0, maxCols - 1]);
        if (!flatCandidates[sig]) flatCandidates[sig] = { av: [], sv: [], db: [] };
        if (avCol !== -1) flatCandidates[sig].av.push(...extractFlatSeries(dataRows, avCol, yearCol, ageColIdx, premiumColIdx));
        if (svCol !== -1) flatCandidates[sig].sv.push(...extractFlatSeries(dataRows, svCol, yearCol, ageColIdx, premiumColIdx));
        if (dbCol !== -1) flatCandidates[sig].db.push(...extractFlatSeries(dataRows, dbCol, yearCol, ageColIdx, premiumColIdx));
      }
    }
  });

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

  const svRowsRaw = pickBest(svCandidates);
  const dbRowsRaw = pickBest(dbCandidates);
  const flatBest = pickBestFlat(flatCandidates);

  const meta = extractMetadata(rawText, doc);
  const prepayment = extractPrepaymentInfo(doc, rawText);

  const result = { type: null, meta, sv: null, db: null, prepayment };

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
    const allRows = [].concat(flatBest.av, flatBest.sv, flatBest.db);
    // build a unified year axis from whichever series has the most points
    const source = flatBest.sv.length >= flatBest.av.length && flatBest.sv.length >= flatBest.db.length ? flatBest.sv
                  : flatBest.av.length >= flatBest.db.length ? flatBest.av : flatBest.db;
    const merged = mergeRows(source.map(r=>Object.assign({}, r)), ['value']);
    const years = merged.map(r=>r.year);
    function lookup(rows, year){
      const hit = rows.find(r => r.year === year || (r.year===null && false));
      return hit ? hit.value : null;
    }
    // Build maps by year for av/sv/db independently (in case they came from same rows, which they do — same yearCol)
    function toMap(rows){
      const m = new Map();
      rows.forEach(r => { if (r.year !== null && !m.has(r.year)) m.set(r.year, r.value); });
      return m;
    }
    function premMap(rows){
      const m = new Map();
      rows.forEach(r => { if (r.year !== null && r.premium !== null && r.premium !== undefined && !m.has(r.year)) m.set(r.year, r.premium); });
      return m;
    }
    const avMap = toMap(flatBest.av), svMap = toMap(flatBest.sv), dbMap = toMap(flatBest.db);
    const pMap = premMap(flatBest.sv.length ? flatBest.sv : (flatBest.av.length ? flatBest.av : flatBest.db));
    result.sv = {
      years, ages: merged.map(r=>r.age),
      accountValue: years.map(y => avMap.has(y) ? avMap.get(y) : null),
      surrenderValue: years.map(y => svMap.has(y) ? svMap.get(y) : null),
      premium: years.map(y => pMap.has(y) ? pMap.get(y) : null)
    };
    result.db = {
      years, ages: merged.map(r=>r.age),
      deathBenefit: years.map(y => dbMap.has(y) ? dbMap.get(y) : null),
      premium: years.map(y => pMap.has(y) ? pMap.get(y) : null)
    };
  }

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
function computeXirrSeries(years, totalValues, premiums){
  const sched = inferPremiumSchedule(years, premiums);
  if (!sched) return years.map(() => null);
  const { P, term } = sched;
  return years.map((y, i) => {
    const v = totalValues[i];
    if (v === null || v === undefined || isNaN(v) || y === null || y <= 0) return null;
    const npay = Math.min(y, term);
    const cashflows = [];
    for (let t = 0; t < npay; t++) cashflows.push({ t, cf: -P });
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
  hidden: new Set(), fontScale: 1, viewMode: 'compare', xirrProduct: 'p1', xAxisRange: 40,
  products: { p1: null, p2: null } // each: {label, type, sv, db} once parsed
};

const PALETTE = {
  p1: { guaranteed:'#8a5a00', nonGuaranteed:'#e8b96a', total:'#b8860b',
        dbGuaranteed:'#7a2e2e', dbNonGuaranteed:'#e59a86', dbTotal:'#a8412e',
        accountValue:'#8a5a00', surrenderValue:'#c8962c', deathBenefit:'#a8412e' },
  p2: { guaranteed:'#0b3d91', nonGuaranteed:'#9fc1e8', total:'#3d78c9',
        dbGuaranteed:'#1b3a5c', dbNonGuaranteed:'#9ecbef', dbTotal:'#2f6fae',
        accountValue:'#0b3d91', surrenderValue:'#3d78c9', deathBenefit:'#7fb3e0' }
};

let chart = null;
let datasetConfigs = [];

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
      if (!ds.isPremiumRef) return;
      const meta = c.getDatasetMeta(i);
      if (!meta.visible) return;
      let pt = null, val = null;
      for (let j = ds.data.length - 1; j >= 0; j--){
        if (ds.data[j] !== null && ds.data[j] !== undefined && meta.data[j]){ pt = meta.data[j]; val = ds.data[j]; break; }
      }
      if (!pt) return;
      const below = /_premium_prepay$/.test(ds.id);
      entries.push({
        x: Math.min(pt.x, chartArea.right - 4),
        y: below ? pt.y + 8 : pt.y - 8,
        below,
        color: ds.borderColor,
        text: `${ds.label}: ${formatMoney(val)}`
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
    if (!cfg || cfg.product !== pk || cfg.metric !== metric || cfg.type !== 'line' || cfg.isPremiumRef) return;
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
    const metaNormal = c.getDatasetMeta(0);
    const metaPrepay = c.data.datasets.length > 1 ? c.getDatasetMeta(1) : null;
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
function xirrColorSpan(pct, text){
  if (pct === null || pct === undefined || isNaN(pct)) return text;
  const color = pct >= 0 ? 'var(--ok)' : 'var(--err)';
  return `<span style="color:${color};">${text}</span>`;
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

/* Custom HTML tooltip for the compare-view chart — lets us color XIRR figures red/green and
   every value figure light-blue, which a canvas-rendered Chart.js tooltip can't do per-substring. */
function renderCompareTooltip(context, years, ages){
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
  const y = years[idx], a = ages[idx];

  let html = `<div class="tt-title">Year ${y}${a!==null&&a!==undefined?' · อายุ '+a:''}</div>`;
  tooltip.dataPoints.forEach(dp => {
    const ds = dp.dataset;
    if (ds.isPremiumRef) return;
    const color = resolveTooltipColor(ds, idx, chart);
    const swatchCls = ds.type === 'line' ? 'tt-swatch tt-line' : 'tt-swatch';
    html += `<div class="tt-row"><span class="${swatchCls}" style="background:${color}"></span>${ds.label}: <span class="tt-value">${formatMoney(dp.raw)}</span></div>`;
  });

  if (state.metric === 'sv'){
    const multi = !!(state.products.p1 && state.products.p2);
    const footerLines = [];
    Object.keys(xirrLookupCompare).forEach(pk => {
      if (state.product !== 'all' && state.product !== pk) return;
      const entry = xirrLookupCompare[pk];
      const xv = entry.xirr[idx];
      const xp = entry.xirrPrepay ? entry.xirrPrepay[idx] : null;
      const prefix = multi ? `[${pk.toUpperCase()}] ` : '';
      let line = `${prefix}XIRR (ปกติ): ${xirrColorSpan(xv, xv===null||xv===undefined?'—':(xv*100).toFixed(2)+'%')}`;
      if (entry.xirrPrepay) line += ` | Prepayment: ${xirrColorSpan(xp, xp===null||xp===undefined?'—':(xp*100).toFixed(2)+'%')}`;
      footerLines.push(line);
    });
    if (footerLines.length) html += `<div class="tt-footer">${footerLines.join('<br>')}</div>`;
  }

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
    const text = (v === null || v === undefined) ? 'ไม่มีข้อมูล' : xirrColorSpan(v/100, (v).toFixed(2) + '% p.a.');
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
    const p = state.products[pk];
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

function buildDatasetConfigs(){
  datasetConfigs = [];
  const years = buildYearAgeLabels();
  if (years.length === 0) return years;

  // derive age labels: prefer whichever product has ages defined
  let ages = years.map(() => null);
  ['p1','p2'].forEach(pk => {
    const p = state.products[pk];
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
    const p = state.products[pk];
    if (!p) return;
    const pal = PALETTE[pk];

    if (p.type === 'par'){
      if (p.sv){
        const g = alignToYears(years, p.sv.years, p.sv.ages, p.sv.guaranteed);
        const ng = alignToYears(years, p.sv.years, p.sv.ages, p.sv.nonGuaranteed);
        const t = alignToYears(years, p.sv.years, p.sv.ages, p.sv.total);
        const stackId = pk + 'SV';
        datasetConfigs.push({ id: pk+'_sv_g', metric:'sv', product:pk, type:'bar', stack:stackId,
          label: seriesLabel(pk, 'Surrender Value: Guaranteed'), rawData:g.map(v=>v||0), backgroundColor:scriptableBarColor(pal.guaranteed), order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_sv_ng', metric:'sv', product:pk, type:'bar', stack:stackId,
          label: seriesLabel(pk, 'Surrender Value: Non-Guaranteed'), rawData:ng.map(v=>v||0), backgroundColor:scriptableBarColor(pal.nonGuaranteed), order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_sv_t', metric:'sv', product:pk, type:'line', stack: pk+'_sv_t',
          label: seriesLabel(pk, 'Total Surrender Value'), rawData:t.map(v=>v||0), borderColor:pal.total, backgroundColor:pal.total,
          borderWidth:2.5, pointRadius:3, tension:.15, order:1, fill:false });
      }
      if (p.db){
        const b = alignToYears(years, p.db.years, p.db.ages, p.db.guaranteed);   // (B) DB Guaranteed
        const cd = alignToYears(years, p.db.years, p.db.ages, p.db.nonGuaranteed); // (C+D) DB Non-Guaranteed
        const t = alignToYears(years, p.db.years, p.db.ages, p.db.total);         // Net = higher of (B) or (E)
        // (A) Guaranteed Cash Value is the SV-side guaranteed figure and is part of (E)=(A+C+D) —
        // pulled from the product's own SV series (same color as the SV chart's Guaranteed bar)
        // so the two comparison groups — (B) alone vs (A)+(C+D)=(E) — render as separate, adjacent
        // bar clusters rather than one misleading combined stack.
        const a = (p.sv && p.sv.guaranteed) ? alignToYears(years, p.sv.years, p.sv.ages, p.sv.guaranteed) : years.map(()=>0);
        const stackB = pk + 'DB_B';
        const stackE = pk + 'DB_E';
        datasetConfigs.push({ id: pk+'_db_b', metric:'db', product:pk, type:'bar', stack:stackB,
          label: seriesLabel(pk, 'Death Benefit: Guaranteed (B)'), rawData:b.map(v=>v||0), backgroundColor:scriptableBarColor(pal.dbGuaranteed), order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_db_a', metric:'db', product:pk, type:'bar', stack:stackE,
          label: seriesLabel(pk, 'Guaranteed Cash Value (A)'), rawData:a.map(v=>v||0), backgroundColor:scriptableBarColor(pal.guaranteed), order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_db_cd', metric:'db', product:pk, type:'bar', stack:stackE,
          label: seriesLabel(pk, 'Death Benefit: Non-Guaranteed (C+D)'), rawData:cd.map(v=>v||0), backgroundColor:scriptableBarColor(pal.dbNonGuaranteed), order:3, minBarLength:2, borderColor:'#fff', borderWidth:1 });
        datasetConfigs.push({ id: pk+'_db_t', metric:'db', product:pk, type:'line', stack: pk+'_db_t',
          label: seriesLabel(pk, 'Net Death Benefit'), rawData:t.map(v=>v||0), borderColor:pal.dbTotal, backgroundColor:pal.dbTotal,
          borderWidth:2.5, pointRadius:3, tension:.15, order:1, fill:false, borderDash:[6,3] });
      }
    } else if (p.type === 'flat'){
      if (p.sv){
        if (p.sv.accountValue && p.sv.accountValue.some(v=>v!==null)){
          const av = alignToYears(years, p.sv.years, p.sv.ages, p.sv.accountValue);
          datasetConfigs.push({ id: pk+'_sv_av', metric:'sv', product:pk, type:'line', stack: pk+'_sv_av',
            label: seriesLabel(pk, 'Account Value'), rawData: av.map(v=>v||0), borderColor:pal.accountValue, backgroundColor:pal.accountValue,
            borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
        }
        if (p.sv.surrenderValue && p.sv.surrenderValue.some(v=>v!==null)){
          const sv = alignToYears(years, p.sv.years, p.sv.ages, p.sv.surrenderValue);
          datasetConfigs.push({ id: pk+'_sv_sv', metric:'sv', product:pk, type:'line', stack: pk+'_sv_sv',
            label: seriesLabel(pk, 'Total Surrender Value'), rawData: sv.map(v=>v||0), borderColor:pal.surrenderValue, backgroundColor:pal.surrenderValue,
            borderWidth:2.5, pointRadius:3, tension:.15, order:0, fill:false });
        }
      }
      if (p.db && p.db.deathBenefit && p.db.deathBenefit.some(v=>v!==null)){
        const db = alignToYears(years, p.db.years, p.db.ages, p.db.deathBenefit);
        datasetConfigs.push({ id: pk+'_db_db', metric:'db', product:pk, type:'line', stack: pk+'_db_db',
          label: seriesLabel(pk, 'Death Benefit'), rawData: db.map(v=>v||0), borderColor:pal.deathBenefit, backgroundColor:pal.deathBenefit,
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
          label: seriesLabel(pk, 'Total Premium Paid'), rawData: premAligned.map(v=>v||0),
          borderColor:'#6b7688', backgroundColor:'#6b7688',
          borderWidth:2.3, pointRadius:0, tension:0, order:2, fill:false, borderDash:[4,3] });
      });
      if (p.prepayment && p.prepayment.lumpSum){
        const lumpArr = years.map(() => p.prepayment.lumpSum);
        ['sv','db'].forEach(m => {
          datasetConfigs.push({ id: pk+'_'+m+'_premium_prepay', metric:m, product:pk, type:'line', stack: pk+'_'+m+'_premium_prepay', isPremiumRef:true,
            label: seriesLabel(pk, 'Total Premium Paid (Prepayment)'), rawData: lumpArr,
            borderColor:'#8e44ad', backgroundColor:'#8e44ad',
            borderWidth:2.3, pointRadius:0, tension:0, order:2, fill:false, borderDash:[8,3] });
        });
      }
    }
  });

  return { years, ages };
}

function ensureChart(years, ages){
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
  const ctx = document.getElementById('cmp').getContext('2d');
  chart = new Chart(ctx, {
    data: { labels, datasets: chartDatasets },
    options: {
      responsive:true, maintainAspectRatio:false,
      layout:{ padding:{top:4} },
      interaction:{ mode:'index', intersect:false },
      scales:{
        x:{ stacked:true, grid:{display:false}, ticks:{ font:{size:12.5,family:"'Inter','Kanit',sans-serif"}, autoSkip:true, maxTicksLimit:20, maxRotation:0, minRotation:0 } },
        y:{ stacked:true, beginAtZero:true, ticks:{ maxTicksLimit:7, font:{size:12.5,family:"'Inter','Kanit',sans-serif"},
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
        if (chart._hoveredIdx !== idx){
          chart._hoveredIdx = idx;
          chart.update('none');
        }
      }
    },
    plugins: [premiumLabelPlugin, breakevenMarkerPlugin]
  });
  chart._hoveredIdx = null;
  chart._years = years;
  const canvasEl = document.getElementById('cmp');
  if (!canvasEl._hoverLeaveWired){
    canvasEl.addEventListener('mouseleave', () => {
      if (chart && chart._hoveredIdx !== null){ chart._hoveredIdx = null; chart.update('none'); }
    });
    canvasEl._hoverLeaveWired = true;
  }
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
    const swatch = document.createElement('span');
    swatch.className = 'swatch' + (cfg.type === 'line' ? ' line' : '');
    swatch.style.background = cfg.type === 'line' ? cfg.borderColor : cfg.backgroundColor;
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = cfg.label;
    item.appendChild(swatch); item.appendChild(lbl);
    item.addEventListener('click', () => {
      if (state.hidden.has(cfg.id)) state.hidden.delete(cfg.id); else state.hidden.add(cfg.id);
      render();
    });
    listEl.appendChild(item);
  });
}

function render(){
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
  document.getElementById('chartHolder').style.display = hasAny ? 'block' : 'none';
  document.getElementById('chartHint').style.display = hasAny ? 'block' : 'none';
  if (!hasAny){ document.getElementById('compareLegendNote').style.display = 'none'; buildLegend(); return; }

  const { years, ages } = buildDatasetConfigs();
  if (!years || years.length === 0){
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('chartHolder').style.display = 'none';
    document.getElementById('chartHint').style.display = 'none';
    document.getElementById('compareLegendNote').style.display = 'none';
    buildLegend();
    return;
  }
  xirrLookupCompare = computeXirrLookupForYears(years);

  try {
    ensureChart(years, ages);

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
    chart.options.scales.y.max = maxBarStack > 0 ? maxBarStack / 0.8 : undefined;

    const fs = state.fontScale;
    chart.options.scales.x.ticks.font.size = 12.5 * fs;
    chart.options.scales.y.ticks.font.size = 12.5 * fs;
    chart.options.plugins.tooltip.titleFont.size = 20 * fs;
    chart.options.plugins.tooltip.bodyFont.size = 19 * fs;
    chart.options.plugins.tooltip.footerFont.size = 17 * fs;

    chart.update();
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
  document.getElementById('chartHint').textContent = `แกน X = Policy Year (และอายุผู้เอาประกัน)  |  แกน Y = ${metricTh} (${ccyLabel()})${dbNote}`;
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
    totals = s.surrenderValue || s.accountValue; guaranteedArr = null; nonGuarArr = null;
  }
  const premiums = s.premium || years.map(() => null);
  const hasPremium = premiums.some(p => p !== null && p !== undefined);
  const hasTotals = totals && totals.some(v => v !== null && v !== undefined);
  if (!hasPremium || !hasTotals) return null;
  return { years, ages: s.ages, totals, guaranteedArr, nonGuarArr, premiums };
}

/* For the compare-view tooltip: precompute XIRR (normal + prepayment, when available) per
   product, aligned to the shared chart X-axis `years`, so the tooltip footer can look up the
   value at the hovered index without recomputing on every hover. */
let xirrLookupCompare = {};
function computeXirrLookupForYears(years){
  const out = {};
  ['p1','p2'].forEach(pk => {
    const p = state.products[pk];
    if (!p) return;
    const data = getSvSeriesForXirr(p);
    if (!data) return;
    const xirrArr = computeXirrSeries(data.years, data.totals, data.premiums);
    const xirrAligned = alignToYears(years, data.years, data.ages, xirrArr);
    const breakevenYear = findBreakevenYear(data.years, xirrArr);
    const gBreak = data.guaranteedArr ? findGuaranteedBreakeven(data.years, data.guaranteedArr, data.premiums) : null;
    let xirrPrepayAligned = null, breakevenYearPrepay = null, gBreakPrepay = null;
    if (p.prepayment && p.prepayment.lumpSum){
      const prepayPremiums = data.years.map(() => p.prepayment.lumpSum);
      const xirrPrepayArr = computeXirrSeries(data.years, data.totals, prepayPremiums);
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

  const product = state.products[state.xirrProduct];
  const data = getSvSeriesForXirr(product);

  if (!data){
    document.getElementById('xirrEmptyState').style.display = 'flex';
    document.getElementById('xirrChartHolder').style.display = 'none';
    document.getElementById('xirrCards').innerHTML = '';
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

  const { years, ages, totals, guaranteedArr, nonGuarArr, premiums } = data;
  const xirrArr = computeXirrSeries(years, totals, premiums);
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
    xirrArrPrepay = computeXirrSeries(years, totals, prepayPremiums);
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

  const cardsEl = document.getElementById('xirrCards');
  cardsEl.innerHTML = '';
  addCard(cardsEl, 'premium', 'เบี้ยสะสมทั้งหมด',
    totalPremium !== null ? formatMoney(totalPremium * mult) : '—',
    sched ? `ชำระเบี้ย ${sched.term} ปี ปีละ ${formatMoney(sched.P * mult)}` : '');
  addCard(cardsEl, 'breakeven', 'จุดคุ้มทุน (Cash Breakeven)',
    breakevenYearInterp !== null ? ('ปีที่ ' + breakevenYearInterp.toFixed(1)) : 'ยังไม่ถึง',
    breakevenYear !== null ? `≈ XIRR 0% (คำนวณ interpolation, ปีเต็มถัดไปคือปีที่ ${breakevenYear})` : '');
  if (guaranteedArr){
    addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven',
      gBreakInterp ? ('ปีที่ ' + gBreakInterp.year.toFixed(1)) : 'ยังไม่ถึง',
      gBreakInterp ? `GCV ≈ ${formatMoney(gBreakInterp.guaranteedValue * mult)} (interpolation, ปีเต็มถัดไปคือปีที่ ${gBreak.year})` : 'GCV ยังไม่แซงเบี้ยสะสม');
  } else {
    addCard(cardsEl, 'gbreakeven', 'Guaranteed Breakeven', 'ไม่มีข้อมูล', 'สินค้านี้ไม่แยก Guaranteed/Non-Guaranteed');
  }
  addCard(cardsEl, '', `ผลตอบแทนระยะยาว${longYear!==null?' (ปีที่ '+longYear+')':''}`,
    longXirr !== null ? xirrColorSpan(longXirr, (longXirr*100).toFixed(2) + '% p.a.') : '—',
    longSv!==null&&longSv!==undefined ? `SV = ${formatMoney(longSv*mult)}` : '');
  addCard(cardsEl, '', `ถือยาวยิ่งดี (ปีที่ ${lastYear}${lastAge!==null&&lastAge!==undefined?', อายุ '+lastAge:''})`,
    lastXirr !== null ? xirrColorSpan(lastXirr, (lastXirr*100).toFixed(2) + '% p.a.') : '—',
    totals[lastIdx]!==null&&totals[lastIdx]!==undefined ? `SV = ${formatMoney(totals[lastIdx]*mult)}` : '');

  document.getElementById('xirrLegendNote').style.display = 'flex';

  // ---- Summary cards (prepayment) ----
  const normalLabelEl = document.getElementById('xirrNormalLabel');
  const prepayLabelEl = document.getElementById('xirrPrepayLabel');
  const cardsPrepayEl = document.getElementById('xirrCardsPrepay');
  if (xirrArrPrepay){
    normalLabelEl.style.display = 'flex';
    prepayLabelEl.style.display = 'flex';
    cardsPrepayEl.style.display = 'grid';
    cardsPrepayEl.innerHTML = '';
    const lastXirrP = xirrArrPrepay[lastIdx];
    const longXirrP = longIdx >= 0 ? xirrArrPrepay[longIdx] : null;
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
    if (breakevenYearPrepay !== null && breakevenYearPrepay > rangeLimit) outOfView.push(`Cash Breakeven (Prepayment, ปีที่ ${breakevenYearPrepay})`);
    if (gBreakPrepay !== null && gBreakPrepay.year > rangeLimit) outOfView.push(`Guaranteed Breakeven (Prepayment, ปีที่ ${gBreakPrepay.year})`);
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
    const datasets = [{
      label: xirrArrPrepay ? 'แบบจ่ายทีละปี (ปกติ)' : 'XIRR (% p.a.)',
      data: xirrPct,
      borderColor: '#0b3d91', backgroundColor: '#0b3d91',
      borderWidth: 2.5, pointRadius: 3, tension: .15, fill: false, spanGaps: true
    }];
    if (vXirrPrepay){
      datasets.push({
        label: 'แบบ Prepayment',
        data: vXirrPrepay.map(v => v === null ? null : v * 100),
        borderColor: '#1f7a4d', backgroundColor: '#1f7a4d',
        borderWidth: 2.5, pointRadius: 3, tension: .15, fill: false, spanGaps: true, borderDash: [6,3]
      });
    }
    // ~20% headroom above the highest point so the mid-positioned tooltip / top markers have room
    const allVals = xirrPct.concat(vXirrPrepay ? vXirrPrepay.map(v=>v===null?null:v*100) : []).filter(v => v !== null && v !== undefined);
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
          legend:{ display: !!vXirrPrepay, position:'top', labels:{ boxWidth:16, font:{size:11.5*fs,family:"'Kanit','Inter',sans-serif"} } },
          tooltip:{
            enabled:false,
            external: (context) => renderXirrTooltip(context, vYears, vAges)
          }
        }
      },
      plugins: [crosshairPlugin, xirrBreakevenPlugin]
    });
    xirrChart._years = vYears;
    xirrChart._breakevenInfo = { breakevenYear, gBreakYear: gBreak ? gBreak.year : null, breakevenYearPrepay, gBreakYearPrepay: gBreakPrepay ? gBreakPrepay.year : null };
  } catch (chartErr){
    console.error('XIRR chart render error:', chartErr);
  }

  // ---- Table ----
  const tableEl = document.getElementById('xirrTable');
  const isPar = product.type === 'par';
  let headHtml = '<thead><tr><th>ปี</th><th>อายุ</th><th>เบี้ยสะสม</th>';
  if (isPar) headHtml += '<th>Guaranteed</th><th>Non-Guar.</th>';
  headHtml += `<th>${isPar ? 'Total SV' : 'Surrender Value'}</th><th>XIRR (ปกติ)</th>`;
  if (xirrArrPrepay) headHtml += '<th>XIRR (Prepayment)</th>';
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
    if (isPar){
      bodyHtml += `<td${rowClass}>${g!==null&&g!==undefined?formatMoneyTable(g*mult):'—'}</td>`;
      bodyHtml += `<td${rowClass}>${ng!==null&&ng!==undefined?formatMoneyTable(ng*mult):'—'}</td>`;
    }
    bodyHtml += `<td${rowClass}>${tot!==null&&tot!==undefined?formatMoneyTable(tot*mult):'—'}</td>`;
    bodyHtml += `<td${rowClass} class="${xirrCls}">${xv===null?'—':(xv*100).toFixed(2)+'%'}</td>`;
    if (xirrArrPrepay){
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
  let subTxt = `${product.label} · Cash Breakeven ปีที่ ${breakevenYear !== null ? breakevenYear : '—'}` +
    (gBreak ? ` · Guaranteed Breakeven ปีที่ ${gBreak.year}` : '');
  if (xirrArrPrepay){
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
      finalizeProductLabel(slot, null);
      render();
      return;
    }

    const cleanPlanName = (parsed.meta.planName && parsed.meta.planName.length <= 90) ? parsed.meta.planName : null;
    const rawLabel = cleanPlanName || file.name.replace(/\.docx$/i,'');
    const label = shortenProductName(rawLabel) || rawLabel;
    state.products['p' + slot] = { label, type: parsed.type, sv: parsed.sv, db: parsed.db, prepayment: parsed.prepayment };

    cardEl.className = 'upload-card-compact slot' + slot + ' ok';
    nameEl.textContent = `สินค้าที่ ${slot}: ${label} ✓`;
    const bits = [file.name];
    if (parsed.meta.insuredName) bits.push('ผู้เอาประกัน: ' + parsed.meta.insuredName);
    bits.push('ประเภท: ' + (parsed.type === 'par' ? 'Guaranteed/Non-Guaranteed (PAR)' : 'Account/Surrender/Death Benefit (UL)'));
    const nPts = (parsed.sv ? parsed.sv.years.length : 0) || (parsed.db ? parsed.db.years.length : 0);
    bits.push('จุดข้อมูล: ' + nPts + ' ปี');
    nameEl.title = bits.join(' · ');

    finalizeProductLabel(slot, label);
    state.hidden.clear();
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
wireSeg('metricSeg', 'data-metric', (val) => { state.metric = val; state.hidden.clear(); render(); });
wireSeg('productSeg', 'data-product', (val) => { state.product = val; state.hidden.clear(); render(); });
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

render();
