import React, { useEffect, useMemo, useState } from "react";
import { COLORS, displayFormulaStr } from "./shared.jsx";
import { SummaryView, SummaryDetail, FormulaHeader } from "./SummaryView.jsx";
import { analyze, EXAMPLES } from "./MineralFormulaParser.jsx";
import { loadCitationsForMineral } from "./cellparamsLoader.js";
import { loadMineralForAmcsdRecord } from "./mineralDataSources.js";
import { buildIdealRows, buildEmpiricalRows, collapseMatchingRows } from "./empiricalFormulaRows.js";

// The first thing visitors see: the mineral's ideal formula (picked from the
// URL's "mineral"/"formula" params if present, otherwise EXAMPLES[0]) side
// by side with every published empirical formula for it — formerly a
// separate "Empirical Formulas" page (page 3), folded in here so there's one
// comparison table instead of a click-through to a second page. "Custom
// Formula" is the way into the full page-2 editor (name field, batch
// upload, etc.), carrying over the formula shown here.
// A query parameter, decoded by hand instead of with URLSearchParams: that
// turns every bare '+' into a space, and links don't always encode the name,
// so "?mineral=Ixiolite-(Fe2+)" came through as "Ixiolite-(Fe2 )". A '+'
// right after a digit is a valence sign and is kept (unless a "-" follows,
// as in "SO4+-+hydrotalcite"); any other bare '+' is still read as a space.
function getQueryParam(key) {
  for (const pair of window.location.search.slice(1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq) !== key) continue;
    const raw = pair.slice(eq + 1).replace(/(?<!\d)\+|\+(?=-)/g, " ");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export default function LandingPage({ onEdit }) {
  // Links are either ?mineral=…&formula=…&ID=… (ID is the cellparams key
  // for the citations) or ?UUID=… alone, an AMCSD record that gives both
  // formulas. The first wins when both are present.
  const [urlName, urlFormula, urlMineralId, lookupUuid] = useMemo(() => {
    const mineral = getQueryParam("mineral");
    const formula = getQueryParam("formula");
    const id = getQueryParam("ID");
    if (mineral && formula) return [mineral, formula, id, null];
    const uuid = getQueryParam("UUID");
    if (uuid) return [null, null, null, uuid];
    return [...EXAMPLES[0].split("\t"), null, null];
  }, []);

  // `undefined` = not resolved yet, as with `fetched` below.
  const [lookup, setLookup] = useState(undefined);
  const [lookupError, setLookupError] = useState(null);

  useEffect(() => {
    if (!lookupUuid) return;
    const controller = new AbortController();
    loadMineralForAmcsdRecord(lookupUuid, { signal: controller.signal })
      .then(setLookup)
      .catch((e) => {
        if (!controller.signal.aborted) setLookupError(e.message);
      });
    return () => controller.abort();
  }, [lookupUuid]);

  const name = lookupUuid ? lookup?.name ?? null : urlName;
  const formulaInput = lookupUuid ? lookup?.formulaStr ?? null : urlFormula;
  const mineralId = lookupUuid ? null : urlMineralId;
  const isLoadingMineral = Boolean(lookupUuid) && lookup === undefined && !lookupError;

  const error = useMemo(() => {
    if (formulaInput === null) return null;
    try {
      analyze(`${name}\t${formulaInput}`);
      return null;
    } catch (e) {
      return e.message;
    }
  }, [name, formulaInput]);

  const idealRows = useMemo(
    () => (error || formulaInput === null ? [] : buildIdealRows(name, formulaInput)),
    [error, name, formulaInput]
  );

  // `fetched`: `undefined` = not resolved yet; `null` = resolved, mineralId
  // has no cellparams records; an object = resolved with data. Both `null`
  // and "not yet fetched" used to share the same falsy state, so isLoading
  // could never tell "found nothing" apart from "still working" — a
  // mineralId with zero records spun on "Loading citation data…" forever.
  const [fetched, setFetched] = useState(undefined);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    if (!mineralId) return;
    let cancelled = false;
    setFetched(undefined);
    setFetchError(null);
    loadCitationsForMineral(mineralId)
      .then((r) => {
        if (!cancelled) setFetched(r);
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [mineralId]);

  // A ?UUID= link's only citation is its AMCSD record.
  const citations = useMemo(
    () => (lookupUuid ? (lookup?.citation ? [lookup.citation] : []) : fetched?.citations || []),
    [lookupUuid, lookup, fetched]
  );
  // Waits for the ?UUID= lookup, since the ideal formula guides how
  // citations are read.
  const empiricalRows = useMemo(
    () =>
      isLoadingMineral ? [] : buildEmpiricalRows(fetched?.mineralName ?? name, citations, idealRows, formulaInput ?? ""),
    [isLoadingMineral, fetched, citations, idealRows, formulaInput]
  );
  const isLoadingCitations = Boolean(mineralId) && fetched === undefined && !fetchError;

  // Ideal formula column(s) first, citation columns after. Never deduped
  // against each other here: the ideal formula should always hold columns
  // (1)/(2) regardless of whether some citation happens to report the same
  // composition — collapsing rows with matching weights (see below) is a
  // separate, user-controlled step.
  const rows = useMemo(() => [...idealRows, ...empiricalRows], [idealRows, empiricalRows]);

  // Unchecked by default: a citation frequently just re-reports the
  // mineral's own ideal formula (or another citation's), so hide the
  // resulting duplicate-weight columns unless asked to see them all — see
  // collapseMatchingRows, which keeps whichever column comes first (the
  // ideal one, when there's a match against it).
  const [showMatchingWeights, setShowMatchingWeights] = useState(false);
  const displayedRows = useMemo(
    () => (showMatchingWeights ? rows : collapseMatchingRows(rows)),
    [rows, showMatchingWeights]
  );

  const [openColumnIndex, setOpenColumnIndex] = useState(null);

  return (
    <div
      style={{
        minHeight: "100%",
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily: "'Inter', system-ui, sans-serif",
        padding: "32px 20px",
      }}
    >
      {/* Wider than the old 780 — the table now grows with the number of
          citation formulas (see SummaryView's tableWidth), so the page
          itself needs the room instead of forcing an early squeeze. */}
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ marginBottom: 22 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, paddingBottom: 8 }}>
            Formula Weights
          </h1>
        </div>

        {isLoadingMineral && (
          <div style={{ marginBottom: 18, fontSize: 14, color: COLORS.text }}>Loading mineral…</div>
        )}
        {lookupError && (
          <div
            style={{
              marginBottom: 18,
              padding: "12px 14px",
              borderRadius: 8,
              background: "#fbeee5",
              border: `1px solid ${COLORS.warn}`,
              color: COLORS.warn,
              fontSize: 13.5,
              fontFamily: COLORS.mono,
            }}
          >
            Couldn't load the mineral for AMCSD record {lookupUuid}: {lookupError}
          </div>
        )}

        {/* An ideal formula that fails to parse only means there's no ideal
            dataset to lead the table with (idealRows is already empty in
            that case, see above) — it shouldn't block whatever empirical
            rows did come in, so this notice sits above the table rather than
            replacing it. Hidden on a detail view. */}
        {error && openColumnIndex === null && (
          <div style={{ marginBottom: rows.length > 0 ? 18 : 0 }}>
            <FormulaHeader title={name} formulaStr={formulaInput} />
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                background: "#fbeee5",
                border: `1px solid ${COLORS.warn}`,
                color: COLORS.warn,
                fontSize: 13.5,
                fontFamily: COLORS.mono,
              }}
            >
              Couldn't compute an ideal formula dataset: {error}
            </div>
          </div>
        )}

        {openColumnIndex !== null ? (
          <SummaryDetail
            result={displayedRows[openColumnIndex].result}
            row={displayedRows[openColumnIndex]}
            onBack={() => setOpenColumnIndex(null)}
          />
        ) : rows.length > 0 ? (
          <>
            {rows.length > 1 && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 6,
                  marginBottom: 10,
                  fontSize: 12.5,
                  color: COLORS.textDim,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={showMatchingWeights}
                  onChange={(e) => {
                    setShowMatchingWeights(e.target.checked);
                    setOpenColumnIndex(null);
                  }}
                />
                Show formulas with matching weights
              </label>
            )}
            <SummaryView
              title={name ?? fetched?.mineralName}
              formulaStr={displayFormulaStr(displayedRows[0].result)}
              rows={displayedRows}
              onSelect={setOpenColumnIndex}
            />
            {isLoadingCitations && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: COLORS.textDim, textAlign: "center" }}>
                Loading citation data…
              </div>
            )}
            {fetchError && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: COLORS.warn, textAlign: "center" }}>
                Couldn't load citation data: {fetchError}
              </div>
            )}
          </>
        ) : (
          isLoadingCitations && (
            <div style={{ fontSize: 14, color: COLORS.text }}>Loading citation data…</div>
          )
        )}

        {formulaInput !== null && (
        <div style={{ marginTop: 28, display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button
            // From a detail view, start the custom formula off the formula
            // being viewed (e.g. a citation's empirical one), not the ideal
            // formula from the URL.
            onClick={() =>
              openColumnIndex !== null
                ? onEdit(name, displayFormulaStr(displayedRows[openColumnIndex].result), true)
                : onEdit(name, formulaInput, false)
            }
            style={{
              background: COLORS.accent,
              border: "none",
              color: "#ffffff",
              borderRadius: 8,
              padding: "10px 24px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Custom Formula
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
