import { ELEMENTS } from "./elements.js";
import UnitCell from "./amcsd/unitCell.js";
import { unitCellFromAmc } from "./amcsd/amcFile.js";

// Valences from AMC atom labels ("U4+1", "Fe2+M1", "Fe3+"), which the
// record's Chemistry field drops. The atom table is expanded into the unit
// cell (amcsd/), summed per element and valence, and checked against the
// Chemistry field; on a mismatch the labels aren't used.

// Label valences elements.js doesn't list (Mn4+, S4+), kept out of it so the
// parser's guesses don't change.
const EXTRA_LABEL_VALENCES = { Mn: [4], S: [4] };

// Positive valences only ("-" in a label is a split-site separator). Matches
// "U4+1", "FeT3+" and "Fe++2"; skips ambiguous ones like "Fe12+".
// Returns { element, valence }, { element, rejected } when the element can't
// take that valence, or null.
export function labelValence(label) {
  if (/^Wat/i.test(label) || /^O-?H/.test(label)) return null;
  const element = UnitCell.elementOf(label);
  if (!element) return null;
  const rest = label.slice(element.length);
  const digit = rest.match(/^(\d)\+/) || rest.match(/^[A-Z]{1,2}(\d)\+$/);
  const plusRun = rest.match(/^(\++)\d*$/);
  const valence = digit ? Number(digit[1]) : plusRun ? plusRun[1].length : null;
  if (!valence) return null;
  const allowed = [...(ELEMENTS[element]?.valences || []), ...(EXTRA_LABEL_VALENCES[element] || [])];
  return allowed.includes(valence) ? { element, valence } : { element, rejected: valence };
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

const round3 = (n) => Number(n.toFixed(3));

// A Chemistry field like "(Fe6.1 Mg.9) Si8 O23.5" as a Map of element ->
// amount, brackets multiplied out.
export function parseChemistryField(str) {
  const stack = [new Map()];
  const add = (map, el, n) => map.set(el, (map.get(el) || 0) + n);
  const re = /([A-Z][a-z]?)(\d*\.?\d+)?|([([{])|([)\]}])(\d*\.?\d+)?/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1]) add(stack[stack.length - 1], m[1], m[2] ? parseFloat(m[2]) : 1);
    else if (m[3]) stack.push(new Map());
    else if (m[4] && stack.length > 1) {
      const group = stack.pop();
      const mult = m[5] ? parseFloat(m[5]) : 1;
      for (const [el, n] of group) add(stack[stack.length - 1], el, n * mult);
    }
  }
  while (stack.length > 1) {
    const group = stack.pop();
    for (const [el, n] of group) add(stack[stack.length - 1], el, n);
  }
  return stack[0];
}

// Median ratio of the Chemistry field's amounts to ours, since ODR doesn't
// always use the same Z (Pb3O4 vs Pb6O8).
function formulaUnitScale(ours, chemistry) {
  const ratios = [...chemistry]
    .filter(([el]) => (ours.get(el) || 0) > 0.001)
    .map(([el, n]) => n / ours.get(el))
    .sort((a, b) => a - b);
  return ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
}

// Within rounding: 0.01 plus 0.5% of the amount.
const totalsAgree = (scaledOurs, chemistry) => Math.abs(scaledOurs - chemistry) <= 0.01 + 0.005 * Math.abs(chemistry);

const formulaTerm = (element, valence, amount) =>
  `${element}${valence ? `^${valence}+^` : ""}${amount === 1 ? "" : `_${amount}_`}`;

// The Chemistry field's amounts, with each labelled element split by valence
// in the proportions the atom table gives (Fe6.1 -> Fe2+ and Fe3+). Only
// labelled elements are checked against the field.
// Returns { formulaStr, labelled, rejected, partial (elements only partly
// labelled), mismatches, scale, usable, datasetCount, Z }.
// Throws when the AMC text can't be expanded.
export function amcValenceChemistry(amcText, chemistryStr) {
  const datasets = unitCellFromAmc(amcText);
  const { atoms } = datasets[0];
  const amounts = new Map(); // "Fe" / "Fe3+" -> { element, valence, count }
  const orders = new Map();
  const labelled = new Map();
  const rejected = new Map();
  const labelledElements = new Set();
  const unlabelledElements = new Set();
  for (const atom of atoms) {
    orders.set(atom.site, (orders.get(atom.site) || 0) + 1);
    const parts = UnitCell.atomsOf(atom.label);
    if (!parts.length) continue;
    const read = labelValence(atom.label);
    if (read?.valence) {
      labelled.set(atom.label, { label: atom.label, element: read.element, valence: read.valence });
      labelledElements.add(read.element);
    } else if (read?.rejected) {
      rejected.set(atom.label, { label: atom.label, element: read.element, valence: read.rejected });
    }
    const occ = Number.isFinite(atom.occ) ? atom.occ : 1;
    for (const [element, n] of parts) {
      const valence = read?.valence && element === read.element ? read.valence : null;
      if (!valence) unlabelledElements.add(element);
      const key = valence ? `${element}${valence}+` : element;
      const entry = amounts.get(key) || { element, valence, count: 0 };
      entry.count += n * occ;
      amounts.set(key, entry);
    }
  }
  const Z = [...orders.values()].reduce(gcd, 0) || 1;

  // Each element's parts (bare before 2+ before 3+), and its total.
  const parts = new Map();
  for (const e of amounts.values()) {
    if (!parts.has(e.element)) parts.set(e.element, []);
    parts.get(e.element).push({ valence: e.valence, amount: e.count / Z });
  }
  for (const list of parts.values()) list.sort((a, b) => (a.valence || 0) - (b.valence || 0));
  const totals = new Map([...parts].map(([el, list]) => [el, list.reduce((s, p) => s + p.amount, 0)]));

  // `total` split by valence for labelled elements.
  const termsOf = (element, total) => {
    const list = labelledElements.has(element) ? parts.get(element) : [{ valence: null, amount: 1 }];
    const sum = list.reduce((s, p) => s + p.amount, 0);
    return list
      .map((p) => ({ valence: p.valence, amount: round3(sum ? (total * p.amount) / sum : total) }))
      .filter((p) => p.amount !== 0)
      .map((p) => formulaTerm(element, p.valence, p.amount))
      .join("");
  };

  let formulaStr, scale = 1;
  const mismatches = [];
  if (chemistryStr) {
    const chemistry = parseChemistryField(chemistryStr);
    scale = formulaUnitScale(totals, chemistry);
    for (const el of labelledElements) {
      const ours = (totals.get(el) || 0) * scale;
      if (!totalsAgree(ours, chemistry.get(el) || 0)) mismatches.push({ element: el, ours: round3(ours), chemistry: round3(chemistry.get(el) || 0) });
    }
    formulaStr = [...chemistry].map(([el, n]) => termsOf(el, n)).join("");
  } else {
    formulaStr = [...totals].map(([el, n]) => termsOf(el, n)).join("");
  }

  return {
    formulaStr,
    labelled: [...labelled.values()],
    rejected: [...rejected.values()],
    partial: [...labelledElements].filter((el) => unlabelledElements.has(el)),
    mismatches,
    scale: round3(scale),
    usable: labelled.size > 0 && mismatches.length === 0,
    datasetCount: datasets.length,
    Z,
  };
}
