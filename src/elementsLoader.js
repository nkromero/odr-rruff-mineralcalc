import { ELEMENTS } from "./elements.js";

// Loads the RRUFF FormulaCalcElements database over the bundled ELEMENTS
// table before the app renders. Any bad record rejects the whole set and
// the bundled table is kept. D and Bx stay bundled; REE follows Ce.

// The plugin's route, or devRecordProxy.js's under "npm run dev".
function elementsUrl() {
  return document.getElementById("mineral-parser-root")?.dataset.elementsUrl || "/odr_rruff/api/elements";
}

// "-2,6" -> [-2, 6]; the first is the default.
function parseValences(symbol, text) {
  const parts = String(text ?? "").split(",").map((s) => s.trim());
  if (!parts.every((p) => /^[+-]?\d+$/.test(p))) {
    throw new Error(`${symbol}: valence "${text}" isn't a comma-separated list of whole numbers`);
  }
  return parts.map(Number);
}

// { symbol: { weight, valences } }, or throws naming the bad record.
export function parseElementRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("no element records");
  const table = {};
  const atomicNumbers = new Set();
  for (const record of records) {
    const symbol = String(record?.Element ?? "").trim();
    if (!/^[A-Z][a-z]{0,2}$/.test(symbol)) throw new Error(`"${symbol}" isn't an element symbol`);
    if (table[symbol]) throw new Error(`${symbol}: listed twice`);

    const atomicNumber = String(record["Atomic Number"] ?? "").trim();
    if (!/^\d+$/.test(atomicNumber) || Number(atomicNumber) < 1) {
      throw new Error(`${symbol}: atomic number "${atomicNumber}" isn't a positive whole number`);
    }
    if (atomicNumbers.has(Number(atomicNumber))) throw new Error(`${symbol}: atomic number ${atomicNumber} is used twice`);
    atomicNumbers.add(Number(atomicNumber));

    const weightText = String(record["Atomic Weight"] ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(weightText) || Number(weightText) <= 0) {
      throw new Error(`${symbol}: atomic weight "${record["Atomic Weight"]}" isn't a positive number`);
    }

    table[symbol] = { weight: Number(weightText), valences: parseValences(symbol, record.Valence) };
  }
  return table;
}

let loadPromise = null;

// Resolves to the number of elements loaded. Runs once per page.
export function loadElementsFromDatabase() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const res = await fetch(elementsUrl());
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message || `Element data request failed: ${res.status} ${res.statusText}`);
      const table = parseElementRecords(json);
      Object.assign(ELEMENTS, table);
      if (table.Ce) ELEMENTS.REE = { ...table.Ce };
      return Object.keys(table).length;
    })();
  }
  return loadPromise;
}
