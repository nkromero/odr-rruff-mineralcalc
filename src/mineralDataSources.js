import * as XLSX from "xlsx";
import { amcValenceChemistry } from "./amcChemistry.js";

// ---------------------------------------------------------------------------
// Data-source layer: anything that can produce a list of
// { name, formulaStr } rows for the parser to consume. Today only the Excel
// loader is wired up in the UI, but loadMineralsFromApi is ready to point at
// a real database endpoint the moment one exists — swap MINERAL_DATA_SOURCE
// below (or wire up a picker in the UI) without touching the parser itself.
// ---------------------------------------------------------------------------

// The source spreadsheet was assembled from HTML tables in places, so some
// cells carry literal HTML escaping/markup instead of the plain characters
// they represent — e.g. '&lt;' instead of '<', or '<i>n</i>' instead of
// plain 'n'. Decoded once here so every downstream consumer sees plain
// text: this matters beyond just display, since the Type 2 algebraic-bound
// parser (see findVariableBounds in MineralFormulaParser.jsx) needs a
// literal '<' to recognize a bound clause like '(x<0.5)'.
function decodeMarkup(s) {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<\/?i>/gi, "");
}

// Trims/filters raw {name, formulaStr}-ish rows into the canonical shape
// every data source (file, API, hand-typed) is expected to converge on.
export function normalizeMineralRows(rawRows) {
  return (rawRows || [])
    .filter((r) => r && r.name && r.formulaStr)
    .map((r) => ({
      name: decodeMarkup(String(r.name)).trim(),
      formulaStr: decodeMarkup(String(r.formulaStr)).trim(),
    }));
}

// Reads the "Mineral names and valence formula.xlsx" layout: header row,
// then Name in column A, formula in column B. Works for .csv too, but a
// .csv/.txt file has to be routed differently: handed raw bytes (type
// "array"), XLSX.read sniffs it as plain text and decodes it against a
// legacy single-byte codepage rather than UTF-8, so any non-ASCII character
// (e.g. the 'Á' in 'Ángelaite') comes out as mojibake — its multi-byte UTF-8
// encoding gets read back as two separate wrong characters. Decoding the
// bytes as UTF-8 text ourselves first, then handing XLSX.read the resulting
// string (type "string"), sidesteps that guess entirely. A real .xlsx is a
// binary zip archive, not text, so it still has to go through as raw bytes.
export async function loadMineralsFromFile(file) {
  const isPlainText = /\.(csv|txt)$/i.test(file.name);
  const wb = isPlainText
    ? XLSX.read(await file.text(), { type: "string" })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const parsed = rows.slice(1).map((r) => ({ name: r[0], formulaStr: r[1] }));
  return normalizeMineralRows(parsed);
}

// Writes {name, formulaStr} rows back out in the exact layout
// loadMineralsFromFile reads — header row, then Name/Formula columns — so a
// chosen subset (e.g. just the rows that failed to parse) can be corrected
// and re-uploaded through "Upload .xlsx / .csv" to check them again.
export function exportMineralsToXlsx(rows, filename) {
  const aoa = [["Name", "Formula"], ...rows.map((r) => [r.name, r.formulaStr])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
}

// Fetches the mineral list from a REST/database API instead of a file.
// Accepts common response shapes out of the box (a bare array, or an
// envelope like { data: [...] } / { minerals: [...] } / { rows: [...] }),
// and a `mapRow` override for whatever field names the real backend uses,
// e.g. mapRow: (r) => ({ name: r.mineral_name, formulaStr: r.valence_formula }).
export async function loadMineralsFromApi(
  endpoint,
  { headers = {}, mapRow, signal } = {}
) {
  const res = await fetch(endpoint, { headers, signal });
  if (!res.ok) {
    throw new Error(`API request to ${endpoint} failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const rawRows = Array.isArray(json) ? json : json.data ?? json.minerals ?? json.rows ?? [];
  const rows = rawRows.map(
    mapRow ||
      ((r) => ({
        name: r.name ?? r.mineral ?? r.mineral_name,
        formulaStr: r.formula ?? r.formulaStr ?? r.valence_formula,
      }))
  );
  return normalizeMineralRows(rows);
}

// The plugin's record proxy, or devRecordProxy.js's under "npm run dev".
// Read on use so Node scripts without `document` can import this module.
function recordProxyUrl() {
  return document.getElementById("mineral-parser-root")?.dataset.recordUrl || "/odr_rruff/api/record/";
}

// One ODR record: { fields: [{ field_name, value }], records: [children] }.
export async function loadOdrRecord(uuid, { signal } = {}) {
  const res = await fetch(recordProxyUrl() + encodeURIComponent(uuid), { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // WordPress REST errors carry their reason in `message`.
    throw new Error(json?.message || `Record request failed: ${res.status} ${res.statusText}`);
  }
  if (!json) throw new Error("The record response was not valid JSON");
  return json;
}

// A field's value, or undefined when missing or empty.
export function getRecordField(record, fieldName) {
  const field = record?.fields?.find?.((f) => f.field_name === fieldName);
  if (!field || field.value === undefined || field.value === null || field.value === "") return undefined;
  return String(field.value);
}

// Valences from the AMC atom labels, or { error } if the AMC text can't be read.
function amcValencesOf(record) {
  const amcText = getRecordField(record, "AMC File Contents");
  if (!amcText) return { error: "The record has no AMC File Contents" };
  try {
    return amcValenceChemistry(amcText, getRecordField(record, "Chemistry"));
  } catch (e) {
    return { error: e.message };
  }
}

// The record as a citation column: its Chemistry (split by label valences
// when usable), cell and journal line.
function amcsdCitationOf(record) {
  const chemistry = getRecordField(record, "Chemistry");
  if (!chemistry) return null;
  const amcValences = amcValencesOf(record);
  const cellField = (name) => parseFloat(getRecordField(record, name));
  const amcLines = (getRecordField(record, "AMC File Contents") || "").split(/\r?\n/);
  return {
    formula: amcValences.usable ? amcValences.formulaStr : chemistry,
    cell: {
      a: cellField("a"),
      b: cellField("b"),
      c: cellField("c"),
      alpha: cellField("alpha"),
      beta: cellField("beta"),
      gamma: cellField("gamma"),
    },
    // AMC line 3 is the journal.
    citation: (amcLines[2] || getRecordField(record, "Authors") || "").trim(),
    amcValences: amcValences.labelled?.length ? amcValences : null,
  };
}

// A ?UUID= link: the record's IMA mineral child gives the name and ideal
// formula; the record itself is the citation.
export async function loadMineralForAmcsdRecord(uuid, options) {
  const record = await loadOdrRecord(uuid, options);
  const mineral = (record.records || []).find((child) => getRecordField(child, "Valence Formula"));
  if (!mineral) throw new Error("The AMCSD record has no linked IMA mineral with a valence formula");
  const citation = amcsdCitationOf(record);
  if (!citation) throw new Error("The AMCSD record has no Chemistry field");
  return {
    name: getRecordField(mineral, "Mineral Name") || getRecordField(record, "Mineral"),
    formulaStr: getRecordField(mineral, "Valence Formula"),
    citation,
  };
}

// Registry so the UI can offer a source picker without importing every
// loader individually. Add new entries here as new sources come online.
export const MINERAL_DATA_SOURCES = {
  xlsx: { id: "xlsx", label: "Excel / CSV file", load: loadMineralsFromFile },
  api: { id: "api", label: "Database API", load: loadMineralsFromApi },
};
