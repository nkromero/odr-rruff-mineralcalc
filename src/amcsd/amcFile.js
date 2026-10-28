// The parts of odr-rruff-cifviewer/amc2cif.js that read an AMC file's cell line and atom
// table and expand it into the unit cell (parseAmcText, readAtomRow, amcSymmetryMatrices,
// unitCellOfDataset), with the function bodies unchanged; the CIF writing and the header
// (authors, journal, ...) parsing are left out. Fix bugs there first and copy them back here.
//
// AMC (.amc) is the plain-text AMCSD format: a short bibliographic header, a single
// "a b c alpha beta gamma spacegroup" line, then a fixed-width atom table (optionally
// followed by "END" and another dataset). A blank cell (e.g. full occupancy) is just
// spaces and can fall in the middle of a row, so rows are sliced by character position,
// anchored on the header row's column edges.
import SpaceGroupSymmetry from "./symmetry.js";
import SPACE_GROUP_GENERATORS from "./spaceGroupGenerators.js";
import UnitCell from "./unitCell.js";

function findAtomLabelExtent(line) {
  const m = line.match(/^\S+/);
  return m ? m[0].length : 0;
}

// [{text, start, end}, ...] for each whitespace-separated token, `end` exclusive.
function tokenizeWithOffsets(line) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

// One raw string per header column, the header's token end-offsets being each column's
// right edge. A blank cell comes back as ''.
function sliceAtomRow(line, headerTokens) {
  const cells = [];
  const labelEnd = findAtomLabelExtent(line);
  cells.push(line.slice(0, labelEnd).trim());
  for (let col = 1; col < headerTokens.length; col++) {
    const left = col === 1 ? labelEnd : headerTokens[col - 1].end;
    const right = headerTokens[col].end;
    cells.push(line.slice(left, right).trim());
  }
  return cells;
}

const AMC_NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(\/\d+)?$/;

// Two values written with no space between them (".00295.007955", ".0032-.0011"), split at
// a column edge.
function isRunTogether(token, edge) {
  const left = token.text.slice(0, edge - token.start), right = token.text.slice(edge - token.start);
  return (right.startsWith('-') || (right.startsWith('.') && left.includes('.')))
    && AMC_NUMBER_RE.test(left) && AMC_NUMBER_RE.test(right);
}

// One raw string per header column. A row where an edge cuts through a value (other than
// two values run together) has each value put in the first column whose edge it doesn't
// overrun by more than one character; any other row is sliced.
function readAtomRow(line, headerTokens) {
  const tokens = tokenizeWithOffsets(line);
  const edges = headerTokens.slice(1, -1).map(t => t.end);
  const cut = tokens.slice(1).some(t => edges.some(e => t.start < e && e < t.end && !isRunTogether(t, e)));
  if (!cut || tokens.length > headerTokens.length) return sliceAtomRow(line, headerTokens);
  const cells = [tokens[0].text, ...headerTokens.slice(1).map(() => '')];
  let col = 0;
  tokens.slice(1).forEach((t, i, rest) => {
    // Leave a column for each value still to come.
    const last = headerTokens.length - (rest.length - i);
    let best = col + 1;
    while (best < last && headerTokens[best].end < t.end - 1) best++;
    cells[best] = t.text;
    col = best;
  });
  return cells;
}

// Every symmetry operation of a dataset's space group as 4x4 matrices, identity first.
// Throws when they can't be built.
function amcSymmetryMatrices(cell, originShift) {
  const { groupSettings, settingFromCell, missingSettingMessage, groupOperators, parseOriginShift, shiftOrigin } = SpaceGroupSymmetry;
  const name = cell.spaceGroup;
  const label = cell.starred ? `*${name}` : name;
  const settings = groupSettings(SPACE_GROUP_GENERATORS, name);
  if (!settings.length) {
    throw new Error(cell.starred
      ? `${label}: its base space group ${name} is not in the space group list.`
      : `Space group ${name} is not in the space group list.`);
  }
  const p = cell.starred ? parseOriginShift(originShift) : null;
  if (cell.starred && !p) {
    throw new Error(`${label} has no origin shift p (three values on the line after the cell parameters).`);
  }
  const setting = settingFromCell(cell, settings);
  if (!settings.includes(setting)) throw new Error(missingSettingMessage(label, setting, settings));
  const ops = groupOperators(SPACE_GROUP_GENERATORS, name, setting);
  return p ? ops.map(M => shiftOrigin(M, p)) : ops;
}

// AMC coordinate text (".25", "-.125", "1/3", "1.5/36") as a number.
function amcNumber(value) {
  const m = String(value).match(/^(-?)(\d*\.?\d+)\/(\d+)$/);
  return m ? (m[1] ? -1 : 1) * Number(m[2]) / Number(m[3]) : parseFloat(value);
}

// Every atom in the unit cell of each dataset, as [{ cell, atoms }], atoms as
// UnitCell.expandAtoms gives them (each with its label and occupancy).
export function unitCellFromAmc(text) {
  const datasets = parseAmcText(text);
  if (datasets.length === 0) throw new Error('No atom data found.');
  return datasets.map(unitCellOfDataset);
}

// One dataset's unit cell. Only what the chemistry needs is read: positions and occupancy.
function unitCellOfDataset(dataset) {
  const cell = Object.fromEntries(['a', 'b', 'c', 'alpha', 'beta', 'gamma'].map(k => [k, parseFloat(dataset.cell[k])]));
  const col = name => dataset.columns.indexOf(name);
  const [xIdx, yIdx, zIdx, occIdx] = ['fract_x', 'fract_y', 'fract_z', 'occupancy'].map(col);
  const atoms = dataset.rows.map(row => ({
    label: row.label,
    x: amcNumber(row.values[xIdx]),
    y: amcNumber(row.values[yIdx]),
    z: amcNumber(row.values[zIdx]),
    places: [xIdx, yIdx, zIdx].map(i => UnitCell.writtenPlaces(row.values[i])),
    // A blank occupancy is a full one.
    occ: occIdx !== -1 && row.values[occIdx] ? amcNumber(row.values[occIdx]) : 1,
  }));
  const ops = amcSymmetryMatrices(dataset.cell, dataset.originShift);
  return { cell, atoms: UnitCell.expandAtoms(cell, ops, atoms) };
}

const AMC_CELL_LINE_RE = /^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\S+)$/;

function isAmcCellLine(line) {
  return AMC_CELL_LINE_RE.test(line.trim());
}

// A "*" before the space group marks a structure given with a shifted origin, the shift
// itself on the next line.
function parseAmcCellLine(line) {
  const m = line.trim().match(AMC_CELL_LINE_RE);
  const [, a, b, c, alpha, beta, gamma, rawSpaceGroup] = m;
  const spaceGroup = rawSpaceGroup.replace(/^\*/, '');
  return { a, b, c, alpha, beta, gamma, spaceGroup, starred: rawSpaceGroup.startsWith('*') };
}

const AMC_ATOM_COLUMN_MAP = {
  x: 'fract_x', y: 'fract_y', z: 'fract_z',
  occ: 'occupancy', Uiso: 'Uiso', Biso: 'Biso',
  'U(1,1)': 'U11', 'U(2,2)': 'U22', 'U(3,3)': 'U33',
  'U(1,2)': 'U12', 'U(1,3)': 'U13', 'U(2,3)': 'U23',
  'B(1,1)': 'B11', 'B(2,2)': 'B22', 'B(3,3)': 'B33',
  'B(1,2)': 'B12', 'B(1,3)': 'B13', 'B(2,3)': 'B23',
};

// A tab is taken as reaching the next multiple of 8, as a text editor shows it.
function expandTabs(line) {
  return line.replace(/[^\t]*\t/g, run => {
    const before = run.slice(0, -1);
    return before + ' '.repeat(8 - (before.length % 8));
  });
}

// One dataset's atom table: the header row plus every following row up to a blank line,
// "END", the next cell-parameter line, or end of input.
function parseAmcAtomTable(lines, startIndex) {
  const headerLine = lines[startIndex] === undefined ? undefined : expandTabs(lines[startIndex]);
  if (headerLine === undefined) return { columns: [], rows: [], nextIndex: startIndex };
  const headerTokens = tokenizeWithOffsets(headerLine);
  const columns = headerTokens.slice(1).map(t => AMC_ATOM_COLUMN_MAP[t.text] || t.text);

  const rows = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = expandTabs(lines[i]);
    const trimmed = line.trim();
    if (trimmed === '' || /^END$/i.test(trimmed) || isAmcCellLine(line)) break;
    const cells = readAtomRow(line, headerTokens);
    rows.push({ label: cells[0], values: cells.slice(1) });
    i++;
  }
  // Skip every stray "END" or blank line between datasets.
  while (i < lines.length && (lines[i].trim() === '' || /^END$/i.test(lines[i].trim()))) i++;
  return { columns, rows, nextIndex: i };
}

function isAtomTableHeaderLine(line) {
  return /^atom\b/i.test(line.trim());
}

// Every dataset in an AMC file: [{ cell, columns, rows, originShift }].
function parseAmcText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstCellIndex = lines.findIndex(isAmcCellLine);
  if (firstCellIndex === -1) throw new Error('No cell-parameter line (a b c alpha beta gamma spacegroup) found.');

  const datasets = [];
  let i = firstCellIndex;
  while (i < lines.length && isAmcCellLine(lines[i])) {
    const cell = parseAmcCellLine(lines[i]);
    let tableStart = i + 1;
    // An origin-shift line (or other non-table line) can sit between the cell line and the
    // "atom x y z ..." header.
    let originShift;
    while (tableStart < lines.length && lines[tableStart].trim() !== '' && !isAtomTableHeaderLine(lines[tableStart]) && !isAmcCellLine(lines[tableStart])) {
      if (originShift === undefined) originShift = lines[tableStart].trim();
      tableStart++;
    }
    const table = parseAmcAtomTable(lines, tableStart);
    datasets.push({ cell, columns: table.columns, rows: table.rows, originShift });
    i = table.nextIndex;
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  return datasets;
}
