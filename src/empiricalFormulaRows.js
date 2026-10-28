import { analyze, valenceBoundsOf } from "./MineralFormulaParser.jsx";
import { ELEMENTS, REE_ELEMENTS } from "./elements.js";
import { parseChemicalFormula, isFormulaFormatted } from "./odrChemistryFormat.js";

// A citation is either a free-text reference ending in "(YYYY) pages" (the
// common journal-citation shape) or a bare RRUFF sample ID. An RRUFF ID is
// "Rxxyyyy" — the two-digit xx is the sample's 20xx submission year (e.g.
// "R250095" was submitted in 2025), yyyy is just that year's running
// sequence number and carries no date information of its own.
const RRUFF_ID_PATTERN = /^R(\d{2})\d{4}$/i;

// Returns null when neither shape matches, since there's nothing to safely
// guess at.
export function citationYear(citation) {
  const rruffMatch = RRUFF_ID_PATTERN.exec(citation.trim());
  if (rruffMatch) return 2000 + Number(rruffMatch[1]);
  const yearMatch = /\((\d{4})\)/.exec(citation);
  return yearMatch ? Number(yearMatch[1]) : null;
}

// The "(YYYY)" shown next to a citation in the UI, or null to show nothing.
// Suppressed for a bare RRUFF ID — that year is only the sample's submission
// year (decoded from the ID itself, see citationYear above), not a
// publication date, so appending it reads as a real citation year when it
// isn't one. Also suppressed when the citation text already spells the year
// out (the common journal-citation shape), so it isn't shown twice.
function displayYear(citation, year) {
  if (year == null) return null;
  const trimmed = citation.trim();
  if (RRUFF_ID_PATTERN.test(trimmed)) return null;
  if (trimmed.includes(`(${year})`)) return null;
  return year;
}

// Two analyze() results count as the same formula if they break down into
// the same set of elements at the same weight percent, each agreeing to 3
// decimal places — the same rounding the summary table itself displays.
// Comparing the resolved composition instead of the raw formula text is
// what lets differently-written formulas for the same substance register as
// the same underlying chemistry.
export function sameComposition(resultA, resultB) {
  // An element can appear in several rows (e.g. Fe2+ and Fe3+), so compare
  // each element's total percent rather than row by row.
  const totals = (result) => {
    const map = new Map();
    for (const a of result.atoms) map.set(a.symbol, (map.get(a.symbol) ?? 0) + a.percent);
    return map;
  };
  const a = totals(resultA);
  const b = totals(resultB);
  if (a.size !== b.size) return false;
  return [...a].every(([symbol, pct]) => b.has(symbol) && pct.toFixed(3) === b.get(symbol).toFixed(3));
}

// Drops a citation row when an earlier-kept row already reports the same
// formula (by composition, see sameComposition) — regardless of unit cell,
// since two citations can refine the same substance to slightly different
// cell parameters and still be reporting the same underlying formula.
// Between duplicates, the older citation wins (citationYear); a row whose
// year can't be determined never displaces one that's already kept, since
// there's no basis to call it "older." A row with usable AMC label valences
// always wins.
export function dedupeCitationRows(rows) {
  const kept = [];
  const hasLabelValences = (row) => Boolean(row.amcValences?.usable);
  for (const row of rows) {
    const dupIndex = kept.findIndex((k) => sameComposition(k.result, row.result));
    if (dupIndex === -1) {
      kept.push(row);
      continue;
    }
    const existing = kept[dupIndex];
    if (hasLabelValences(existing) !== hasLabelValences(row)) {
      if (hasLabelValences(row)) kept[dupIndex] = row;
      continue;
    }
    if (row.year != null && (existing.year == null || row.year < existing.year)) {
      kept[dupIndex] = row;
    }
  }
  return kept;
}

// The specific rare earth a citation's generic "RE"/"REE" most likely
// stands for: the mineral name's own suffix first (e.g. "Britholite-(Ce)"),
// otherwise the first REE element written in the ideal formula (e.g. the Ce
// in Burbankite's '(Sr,Ba,Ce)'). Null if neither names one. 'Ln' is itself
// a generic placeholder, so it never counts as a specific element.
function idealReeElement(name, idealFormulaStr) {
  const isSpecificRee = (el) => REE_ELEMENTS.has(el) && el !== "Ln";
  const suffix = /-\(([A-Z][a-z]?)\)\s*$/.exec(name || "");
  if (suffix && isSpecificRee(suffix[1])) return suffix[1];
  for (const [symbol] of (idealFormulaStr || "").matchAll(/[A-Z][a-z]*/g)) {
    if (isSpecificRee(symbol)) return symbol;
  }
  return null;
}

// Replaces a citation's generic "RE"/"REE"/"TR" ("TR" is the abbreviation
// Russian-literature formulas use) with reeElement (see idealReeElement),
// keeping any valence/count written after it. With no element to
// substitute, "RE"/"TR" are still normalized to the parser's generic "REE".
// The ',REE' site-sharing form (e.g. '(Y,REE)') is left as ',REE' — the
// parser already resolves that to the named element on its left — and a
// ',RE'/',TR' is normalized to it.
// Returns the rewritten formula plus { from, to } when a real element was
// substituted in, so the UI can say so.
const GENERIC_REE_RE = /(?<![A-Za-z])(,?)(REE|RE|TR)(?![A-Za-z])/g;
function substituteRee(formulaStr, reeElement) {
  let from = null;
  const out = formulaStr.replace(GENERIC_REE_RE, (match, comma, token) => {
    if (comma) return ",REE";
    from = from || token;
    return reeElement || "REE";
  });
  return { formulaStr: out, reeSubstitution: from && reeElement ? { from, to: reeElement } : null };
}

// Every recognized element symbol written in a formula string, in order.
// 'Bx' (vacancy) isn't a real element, so it never counts.
function elementSymbols(formulaStr) {
  return [...(formulaStr || "").matchAll(/REE(?![a-z])|[A-Z][a-z]*/g)]
    .map(([symbol]) => symbol)
    .filter((symbol) => ELEMENTS[symbol] && symbol !== "Bx");
}

// The elements every empirical formula for this mineral should contain,
// per its ideal formula: everything written outside a comma-shared site,
// plus only the first (dominant) occupant of each site — e.g. for
// '(Na,Ca)_3_(Sr,Ba,Ce)_3_(CO_3_)_5_' that's Na, Sr, C and O, since Ca, Ba
// and Ce are each optional alternatives on a site. Innermost sites are
// collapsed first, so a site nested inside another bracket still only
// contributes its own first occupant; a comma outside any bracket keeps
// just the text before it, same idea.
const INNER_COMMA_SITE_RE = /[([{]([^()[\]{}]*,[^()[\]{}]*)[)\]}]/g;
function requiredElementsOf(idealFormulaStr) {
  let str = idealFormulaStr || "";
  let prev;
  do {
    prev = str;
    str = str.replace(INNER_COMMA_SITE_RE, (_, inner) => `(${inner.split(",")[0]})`);
  } while (str !== prev);
  str = str.replace(/,[^()[\]{}]*/g, "");
  return [...new Set(elementSymbols(str))];
}

// The required elements (see requiredElementsOf) that a citation's formula
// never mentions. A generic REE/Ln on either side stands for "some rare
// earth", so it's satisfied by (or satisfies) any specific one.
function missingElements(requiredElements, empiricalFormulaStr) {
  const present = new Set(elementSymbols(empiricalFormulaStr));
  const hasAnyRee = [...present].some((s) => REE_ELEMENTS.has(s) || s === "REE");
  return requiredElements.filter((el) => {
    if (present.has(el)) return false;
    const isRee = REE_ELEMENTS.has(el) || el === "REE";
    return !(isRee && hasAnyRee && (el === "REE" || el === "Ln" || present.has("REE") || present.has("Ln")));
  });
}

// Total H atoms per formula unit in the ideal formula, rounded to 3 decimal
// places — or null when there's no single number to use: the ideal formula
// didn't parse, has no H, or is a range formula whose two end-members
// disagree on H (so neither one is "the" ideal count). Also null for two
// shapes that parse but don't state a real H count: a bare element list
// like 'K Na Ca Si O F H' (what RRUFF has in place of a formula for some
// minerals), and an unknown multiplier like the 'n' in '·nH_2_O', which the
// parser skips over as if it were 1.
const ELEMENT_LIST_RE = /^\s*[A-Z][a-z]?(\^?\d*[+-]\^?)?(\s+[A-Z][a-z]?(\^?\d*[+-]\^?)?)+\s*$/;
export const UNKNOWN_MULTIPLIER_RE = /(^|[^A-Za-z])[nxy](?=[A-Z([{])/;
function idealHydrogenCount(idealRows, idealFormulaStr) {
  if (ELEMENT_LIST_RE.test(idealFormulaStr || "") || UNKNOWN_MULTIPLIER_RE.test(idealFormulaStr || "")) return null;
  const counts = idealRows.map((r) =>
    r.result.atoms.filter((a) => a.symbol === "H").reduce((s, a) => s + a.count, 0)
  );
  if (!counts.length || counts.some((c) => Math.abs(c - counts[0]) > 1e-9)) return null;
  const rounded = Math.round(counts[0] * 1000) / 1000;
  return rounded > 0 ? rounded : null;
}

function totalsBySymbol(atoms) {
  const totals = {};
  for (const a of atoms) totals[a.symbol] = (totals[a.symbol] || 0) + a.count;
  return totals;
}

// How much to scale the ideal formula's H count by for one citation, since
// a citation isn't always written per the same formula unit as the ideal
// (e.g. Caryopilite's ideal has Si_2_ but a citation reports Si_4.07_).
// The scale comes from one element both formulas share, other than H and O
// — O is left out because a citation missing its H usually also leaves out
// the O of that OH/H2O. Of those shared elements, the one picked is the one
// whose citation/ideal ratio is closest to the ratio across all of them
// together, which favors an element that isn't being substituted on its
// site (Caryopilite's Mn is partly replaced by Mg, so Si wins). Returns
// null if the two formulas share no such element.
function hydrogenScale(idealAtoms, empiricalAtoms) {
  const ideal = totalsBySymbol(idealAtoms);
  const empirical = totalsBySymbol(empiricalAtoms);
  const shared = Object.keys(ideal).filter((s) => s !== "H" && s !== "O" && ideal[s] > 0 && empirical[s] > 0);
  if (!shared.length) return null;
  const sum = (totals) =>
    Object.entries(totals).reduce((s, [symbol, count]) => (symbol === "H" || symbol === "O" ? s : s + count), 0);
  const overall = sum(empirical) / sum(ideal);
  const element = shared.reduce((best, s) =>
    Math.abs(empirical[s] / ideal[s] - overall) < Math.abs(empirical[best] / ideal[best] - overall) ? s : best
  );
  return { element, idealCount: ideal[element], empiricalCount: empirical[element] };
}

// One row per citation's raw formula, converted (if it isn't already in
// this app's ^valence^/_count_ syntax) and analyzed exactly like a formula
// typed into the Custom Formula box. A citation whose formula fails to
// parse is dropped rather than breaking the whole comparison table — see
// mineralDataSources.js's row-level error handling for the same pattern at
// batch scale. Duplicate citations (same resolved formula — see
// dedupeCitationRows) are then collapsed down to the oldest one.
//
// idealRows (buildIdealRows' output) bound each element's valence to the
// range the ideal formula gives it, so e.g. a bare "Fe" in a citation is
// only resolved to a valence the mineral's ideal formula actually uses (see
// valenceBoundsOf).
// idealFormulaStr is the ideal formula as written, used for the RE/REE/TR
// substitution (see substituteRee) — taken raw rather than from idealRows so
// it still works when the ideal formula itself doesn't parse.
export function buildEmpiricalRows(name, citations, idealRows = [], idealFormulaStr = "") {
  const valenceBounds = valenceBoundsOf(idealRows.map((r) => r.result));
  const reeElement = idealReeElement(name, idealFormulaStr);
  const requiredElements = requiredElementsOf(idealFormulaStr);
  const idealH = idealHydrogenCount(idealRows, idealFormulaStr);
  const rows = [];
  for (const { formula, cell, citation, amcValences } of citations) {
    const converted = isFormulaFormatted(formula) ? formula : parseChemicalFormula(formula);
    const reeResult = substituteRee(converted, reeElement);
    const { reeSubstitution } = reeResult;
    let { formulaStr } = reeResult;
    try {
      let result = analyze(`${name}\t${formulaStr}`, { valenceBounds });
      // A citation that leaves hydrogen out entirely (usually because the
      // analysis didn't measure water/OH) gets the ideal formula's H count,
      // scaled to the citation's own formula unit (see hydrogenScale),
      // appended — so its weight percents aren't skewed by the missing mass.
      // With no shared element to scale by, the ideal count goes in as is
      // (hydrogenAdded.element is then null).
      let hydrogenAdded = null;
      if (result && idealH && missingElements(requiredElements, formulaStr).includes("H")) {
        const empiricalAtoms = result.isRange ? result.columns[0].atoms : result.atoms;
        const scale = hydrogenScale(idealRows[0].result.atoms, empiricalAtoms);
        const count = scale
          ? Math.round(((idealH * scale.empiricalCount) / scale.idealCount) * 1000) / 1000
          : idealH;
        hydrogenAdded = {
          count,
          idealH,
          element: scale ? scale.element : null,
          elementIdealCount: scale ? scale.idealCount : null,
          elementEmpiricalCount: scale ? scale.empiricalCount : null,
        };
        formulaStr = `${formulaStr}H_${count}_`;
        result = analyze(`${name}\t${formulaStr}`, { valenceBounds });
      }
      const year = citationYear(citation);
      const shared = {
        cell,
        citation,
        year,
        displayYear: displayYear(citation, year),
        reeSubstitution,
        hydrogenAdded,
        missingElements: missingElements(requiredElements, formulaStr),
        // Only set on a ?UUID= link's AMCSD citation.
        amcValences: amcValences || null,
      };
      // A range citation (e.g. a comma-shared site like
      // '(Mn,Fe,Sr,Ba,Mg,Zr)') splits into its two end-member columns, the
      // same way buildIdealRows does — the range result itself has no
      // top-level atoms for the table or sameComposition to read.
      if (result && !result.isRange) rows.push({ formulaStr, result, ...shared });
      if (result && result.isRange) {
        for (const col of result.columns) {
          rows.push({ formulaStr: col.formulaStr, result: { ...col, isModifiedIdeal: result.isModifiedIdeal }, ...shared });
        }
      }
    } catch (e) {
      // Skip a citation that doesn't parse — the rest of the table still
      // renders.
    }
  }
  return dedupeCitationRows(rows);
}

// Collapses the full ideal+empirical row list down to one column per unique
// composition (by sameComposition), keeping whichever row comes first —
// ideal rows lead the array (see buildIdealRows/LandingPage.jsx), so an
// empirical formula that matches the ideal one collapses onto the ideal
// column rather than the other way around. Used to power the "Show matching
// weights" checkbox: unchecked (the default) hides the redundant columns
// this produces so often, since a citation frequently just re-reports the
// mineral's own ideal formula.
export function collapseMatchingRows(rows) {
  const kept = [];
  for (const row of rows) {
    if (!kept.some((k) => sameComposition(k.result, row.result))) kept.push(row);
  }
  return kept;
}

// The mineral's own ideal formula, as 1-2 "(1)"/"(2)" columns (a plain
// formula is one column, a Type 1 range formula splits into its two
// end-members) — meant to lead the comparison table ahead of the citation
// columns buildEmpiricalRows produces. Empty if there's no ideal formula to
// show, or if it fails to parse — a bad ideal formula shouldn't block the
// citation comparison next to it.
export function buildIdealRows(name, formulaStr) {
  if (!name || !formulaStr) return [];
  let result;
  try {
    result = analyze(`${name}\t${formulaStr}`);
  } catch (e) {
    return [];
  }
  if (!result) return [];
  if (!result.isRange) return [{ formulaStr: result.formulaStr, result, isIdealRow: true }];
  return [
    { formulaStr: result.columns[0].formulaStr, result: { ...result.columns[0], isModifiedIdeal: result.isModifiedIdeal }, isIdealRow: true },
    { formulaStr: result.columns[1].formulaStr, result: { ...result.columns[1], isModifiedIdeal: result.isModifiedIdeal }, isIdealRow: true },
  ];
}
