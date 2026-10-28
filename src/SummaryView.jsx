import React, { memo, useMemo } from "react";
import { COLORS, renderFormula, renderMineralName, backButtonStyle } from "./shared.jsx";
import DetailedView from "./DetailedView.jsx";
import { formatDetailText, downloadTxt } from "./reportText.js";

const downloadButtonStyle = {
  background: COLORS.panelAlt,
  border: `1px solid ${COLORS.border}`,
  color: COLORS.text,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12.5,
  cursor: "pointer",
};

// Builds the same plain-text report a batch "Print Report" row gets, but for
// this one mineral — one section per row (two, "(1)"/"(2)", for a range
// formula) — and triggers the download. Each row's `result` only carries a
// `name` when it came straight from analyze() (the non-range case); a
// range's per-column result doesn't, so it's filled in from `title` here.
function downloadMineralReport(title, rows) {
  const content = rows
    .map((r) => formatDetailText({ ...r.result, name: r.result.name || title }))
    .join("\n\n" + "=".repeat(60) + "\n\n");
  const safeName = (title || "mineral").replace(/[^\w.-]+/g, "_");
  downloadTxt(content, `${safeName}_FormulaWeight.txt`);
}

function summaryThStyle(align) {
  return {
    textAlign: align,
    padding: "6px 2px",
    color: COLORS.textDim,
    fontWeight: 600,
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    borderBottom: `1px solid ${COLORS.border}`,
    whiteSpace: "nowrap",
  };
}

const summaryTdStyle = {
  padding: "4px 6px",
  textAlign: "center",
  fontFamily: COLORS.mono,
  borderBottom: `1px solid ${COLORS.border}`,
  whiteSpace: "nowrap",
  // A wide row (many citation columns) caps the table at 1400px and lets
  // columns get squeezed well under 108px each — nowrap alone then lets
  // long content (e.g. "452.779 g/mol") spill past its own cell into the
  // next one instead of wrapping. Clipping it here is the safety net;
  // Formula mass's own cells are also shortened below so this rarely
  // triggers in practice.
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const summaryHeaderBtnStyle = {
  background: "transparent",
  border: "none",
  color: COLORS.accent,
  fontWeight: 700,
  fontSize: 12.5,
  fontFamily: COLORS.mono,
  cursor: "pointer",
  padding: 0,
  margin: 0,
  lineHeight: "normal",
};

const summaryKeyBtnStyle = {
  background: COLORS.panelAlt,
  border: `1px solid ${COLORS.border}`,
  color: COLORS.accent,
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11.5,
  fontFamily: COLORS.mono,
  cursor: "pointer",
};

// The mineral name + formatted formula shown above a summary table — also
// used on its own (e.g. Page 1's error state) so a formula that failed to
// parse still displays what was typed instead of disappearing along with
// the table.
export const FormulaHeader = memo(function FormulaHeader({ title, formulaStr, onBack }) {
  if (!title && !formulaStr && !onBack) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: onBack ? "space-between" : "center",
        gap: 12,
        marginBottom: 14,
      }}
    >
      <div style={onBack ? { flex: "1 1 auto", minWidth: 0 } : { textAlign: "center", maxWidth: 780 }}>
        {title && (
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 2 }}>
            {renderMineralName(title)}
            {formulaStr && ", "}
            {formulaStr && renderFormula(formulaStr)}
          </div>
        )}
      </div>
      {onBack && (
        <button onClick={onBack} style={{ ...backButtonStyle, flexShrink: 0 }}>
          ← Back to list
        </button>
      )}
    </div>
  );
});

// Hover text for the "H from ideal formula" note, e.g. "Added H8.14: the
// ideal formula's H4, scaled by Si (Si2 in the ideal formula, Si4.07 here)".
function hydrogenAddedTitle({ count, idealH, element, elementIdealCount, elementEmpiricalCount }) {
  const n = (x) => +x.toFixed(3);
  if (!element) return `Added H${count}: the ideal formula's H count, unscaled (no shared element to scale by)`;
  return (
    `Added H${count}: the ideal formula's H${idealH}, scaled by ${element} ` +
    `(${element}${n(elementIdealCount)} in the ideal formula, ${element}${n(elementEmpiricalCount)} here)`
  );
}

// Hover text for the AMC label valences note (see amcChemistry.js).
function amcValencesTitle({ usable, labelled, rejected, partial, mismatches, scale }) {
  const lines = [];
  if (usable) {
    lines.push(`Valences read from the AMC file's atom labels: ${labelled.map((l) => `${l.label} (${l.valence}+)`).join(", ")}`);
  } else {
    lines.push(
      "Valence labels found in the AMC file, but the element totals don't match the record's Chemistry field, " +
        `so the Chemistry formula is used as is: ${mismatches.map((m) => `${m.element} ${m.ours} from the atom table vs ${m.chemistry}`).join(", ")}`
    );
  }
  if (partial.length) lines.push(`Some ${partial.join(", ")} sites have no valence label; that part is still guessed.`);
  if (rejected.length) lines.push(`Ignored (not a valence of that element): ${rejected.map((l) => l.label).join(", ")}`);
  if (scale !== 1) lines.push(`The atom table's formula unit is scaled by ${scale} to match the Chemistry field.`);
  return lines.join("\n");
}

// Shows the union of elements across a set of formulas as rows, with one
// percent-of-mass column per formula (labeled (1), (2), ...). A formula
// missing an element that another has just gets a blank cell rather than a
// zero. `title`/`formulaStr` (the mineral name and its original, unresolved
// formula — the one with the range dash still in it) are shown once above
// the table; the key below only lists each column's own resolved formula.
// Used both as the simplified 2-column summary for a single mineral picked
// from the batch list, and reusable for a small explicit group.
export const SummaryView = memo(function SummaryView({ title, formulaStr, rows, onSelect, onBack }) {
  const elements = useMemo(() => {
    const seen = new Set();
    const order = [];
    for (const r of rows) {
      for (const a of r.result.atoms) {
        if (!seen.has(a.symbol)) {
          seen.add(a.symbol);
          order.push(a.symbol);
        }
      }
    }
    return order;
  }, [rows]);

  // Native metals (e.g. Cu, Au) aren't ionic — a "net charge" is meaningless
  // for them, so it's hidden and only atomic weight percents are shown. See
  // isMetallicFormula in MineralFormulaParser.jsx.
  const isMetallic = rows.every((r) => r.result.isMetallic);

  if (rows.length === 0) {
    return (
      <div style={{ marginTop: 14, padding: 16, color: COLORS.textDim, fontSize: 13 }}>
        No parseable formulas to summarize.
      </div>
    );
  }

  // The table was originally sized for the 2-column range case (a fixed
  // 360px). With page 3 comparing many citation formulas at once, that same
  // fixed width squeezed every column down to nothing — so it scales with
  // the actual column count instead, one comfortably-sized column (~108px)
  // per formula plus room for the element symbols. No upper cap: since
  // every row in a <table> column shares that column's width, capping the
  // total width once there are many formulas (e.g. Almandine's 15) squeezes
  // every column below its own intended 108px — including Net charge and
  // Formula mass, whose values run longer than a typical percentage and
  // were overflowing/getting ellipsis-clipped as a result. The wrapping div
  // below already scrolls horizontally, so a wide table from many formulas
  // is a scroll, not a squeeze.
  const tableWidth = Math.max(360, 108 + rows.length * 108);

  // The bordered box below is sized to tableWidth via maxWidth, but its
  // 1px-each-side border eats into that budget under box-sizing:border-box
  // — which the WordPress plugin's reset.css forces (!important) on every
  // element inside #mineral-parser-root, shrinking the box's actual content
  // area to tableWidth - 2px. The table inside doesn't know that and asks
  // for the full, un-reduced tableWidth via minWidth, overflowing its
  // container by exactly 2px and forcing an unwanted horizontal scrollbar
  // — even for a single-column table. Never showed up in local dev, since
  // bare Vite doesn't load that reset stylesheet (box-sizing defaults to
  // content-box there, where a border doesn't consume the width budget, so
  // there's nothing to compensate for). Subtracting it here is safe under
  // either box-sizing model: on border-box it exactly closes the 2px gap,
  // and on content-box it just leaves 2 harmless spare pixels.
  const BORDER_WIDTH = 2;

  return (
    <div style={{ marginTop: 14 }}>
      <FormulaHeader title={title} formulaStr={formulaStr} onBack={onBack} />
      <div
        style={{
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          overflow: "hidden",
          maxWidth: tableWidth,
          margin: "0 auto",
        }}
      >
        <div style={{ maxHeight: 420, overflow: "auto", transform: "translateZ(0)" }}>
          {/* minWidth keeps every column at its intended ~108px on a
              screen too narrow for tableWidth — the wrapper above still
              shrinks to fit, so the table overflows *within* this div's
              own overflow:auto and scrolls horizontally instead of
              compressing (and overlapping) its columns. */}
          <table
            style={{
              width: "100%",
              minWidth: tableWidth - BORDER_WIDTH,
              borderCollapse: "collapse",
              tableLayout: "fixed",
              fontSize: 13.5,
            }}
          >
            <colgroup>
              <col style={{ width: `${100 / (rows.length + 1)}%` }} />
              {rows.map((_, idx) => (
                <col key={idx} style={{ width: `${100 / (rows.length + 1)}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {/* The corner cell is sticky on both axes (it's the header
                    for the sticky-left column below), so it needs the
                    highest z-index — otherwise the other header cells,
                    sliding underneath it as the table scrolls horizontally,
                    would paint on top instead. */}
                <th
                  style={{
                    ...summaryThStyle("center"),
                    background: COLORS.panelAlt,
                    position: "sticky",
                    top: 0,
                    left: 0,
                    zIndex: 3,
                    borderRight: `1px solid ${COLORS.border}`,
                  }}
                >
                  Element
                </th>
                {rows.map((r, idx) => (
                  <th
                    key={idx}
                    style={{ ...summaryThStyle("center"), background: COLORS.panelAlt, position: "sticky", top: 0, zIndex: 2 }}
                  >
                    <div>% of mass</div>
                    <button
                      onClick={() => onSelect(idx)}
                      style={summaryHeaderBtnStyle}
                      title={r.formulaStr}
                    >
                      ({idx + 1})
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {elements.map((symbol, i) => (
                <tr
                  key={symbol}
                  style={{ background: i % 2 ? "transparent" : "rgba(0,0,0,0.025)" }}
                >
                  {/* Sticky so the element symbol stays in view once the
                      table scrolls horizontally — needs its own opaque
                      background (the striping above is set on the <tr> and
                      would otherwise show scrolled-past columns bleeding
                      through underneath this cell). */}
                  <td
                    style={{
                      ...summaryTdStyle,
                      fontWeight: 600,
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                      background: i % 2 ? COLORS.bg : "#fafafa",
                      borderRight: `1px solid ${COLORS.border}`,
                    }}
                  >
                    {symbol}
                  </td>
                  {rows.map((r, idx) => {
                    // An element can appear in several rows (e.g. Fe2+ and Fe3+
                    // in magnetite), so sum all of them rather than taking the first.
                    const matches = r.result.atoms.filter((a) => a.symbol === symbol);
                    const atom = matches.length > 0;
                    const percent = matches.reduce((sum, a) => sum + a.percent, 0);
                    return (
                      <td key={idx} style={{ ...summaryTdStyle, color: atom ? COLORS.accent : COLORS.textDim, fontWeight: 700 }}>
                        {atom ? percent.toFixed(3) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              {!isMetallic && (
                <tr>
                  <td
                    style={{
                      ...summaryTdStyle,
                      fontWeight: 700,
                      borderTop: `2.5px solid ${COLORS.textDim}`,
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                      background: COLORS.bg,
                      borderRight: `1px solid ${COLORS.border}`,
                    }}
                  >
                    Net charge
                  </td>
                  {rows.map((r, idx) => (
                    <td
                      key={idx}
                      style={{
                        ...summaryTdStyle,
                        fontWeight: 700,
                        borderTop: `2.5px solid ${COLORS.textDim}`,
                        color: Math.abs(r.result.netCharge) > 0.001 ? COLORS.warn : undefined,
                      }}
                    >
                      {r.result.netCharge.toFixed(3)}
                    </td>
                  ))}
                </tr>
              )}
              <tr>
                <td
                  style={{
                    ...summaryTdStyle,
                    fontWeight: 700,
                    borderTop: isMetallic ? `2.5px solid ${COLORS.textDim}` : "none",
                    borderBottom: "none",
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                    background: COLORS.bg,
                    borderRight: `1px solid ${COLORS.border}`,
                    // Overrides summaryTdStyle's nowrap/ellipsis — those exist
                    // to stop long numeric values from spilling into the next
                    // column, but this label is the widest thing in its own
                    // (often squeezed, see tableWidth above) column and was
                    // getting clipped to "Formula mas…" instead. Letting it
                    // wrap to "Formula mass" / "(g/mol)" keeps it readable;
                    // the row just grows to fit since the data cells beside
                    // it are short numbers.
                    whiteSpace: "normal",
                    overflow: "visible",
                    textOverflow: "clip",
                    lineHeight: 1.25,
                  }}
                >
                  Formula mass (g/mol)
                </td>
                {rows.map((r, idx) => (
                  <td
                    key={idx}
                    style={{
                      ...summaryTdStyle,
                      fontWeight: 700,
                      borderTop: isMetallic ? `2.5px solid ${COLORS.textDim}` : "none",
                      borderBottom: "none",
                    }}
                  >
                    {r.result.totalMass.toFixed(3)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* width: fit-content (capped at 100% so it can't push the page wider)
          instead of maxWidth: tableWidth — that cap matched the table's
          often-narrow column-driven width, forcing a long citation line
          (formula + journal ref + year) to wrap to two lines even though
          the page has plenty of room beside it. Sizing to its own widest
          line keeps every citation on one line while margin: auto still
          centers the block the same way the table above it is centered.
          maxHeight/overflowY caps this list the same way the table itself is
          capped above — with many citations this list could otherwise grow
          tall enough to push "Print Report"/"Custom Formula" far down the
          page instead of staying put right below the table. */}
      <div style={{ marginTop: 10, fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.9, width: "fit-content", maxWidth: "100%", maxHeight: 200, margin: "10px auto 0", overflowX: "auto", overflowY: "auto" }}>
        {rows.map((r, idx) => (
          <div key={idx} style={{ whiteSpace: "nowrap" }}>
            <button onClick={() => onSelect(idx)} style={summaryKeyBtnStyle}>
              ({idx + 1})
            </button>{" "}
            <span style={{ fontFamily: COLORS.mono }}>{renderFormula(r.formulaStr)}</span>
            {/* isIdealRow marks the row(s) built from the mineral's own
                ideal formula (as opposed to a citation's empirical formula)
                — see empiricalFormulaRows.js's buildIdealRows, used by
                LandingPage.jsx and MineralFormulaParser.jsx's own
                topSummaryRows. Always labeled, so it reads as "formula —
                Ideal IMA Formula" (or "— Modified Ideal Formula" when a
                comma-shared site collapsed it — see isModifiedIdeal). A
                non-ideal (citation) row only ever gets the "Modified" label,
                and only when it applies. */}
            {r.isIdealRow ? (
              <span>
                {" — "}
                {r.result.isModifiedIdeal ? "Modified Ideal Formula" : "Ideal IMA Formula"}
              </span>
            ) : (
              r.result.isModifiedIdeal && (
                <span style={{ color: COLORS.warn, fontWeight: 600 }}>, Modified Ideal Formula</span>
              )
            )}
            {/* A citation's generic RE/REE swapped for the specific rare
                earth its ideal formula names — see substituteRee in
                empiricalFormulaRows.js. */}
            {r.reeSubstitution && (
              <span style={{ color: COLORS.warn, fontWeight: 600 }}>
                , {r.reeSubstitution.from} → {r.reeSubstitution.to}
              </span>
            )}
            {/* Hydrogen the citation left out, filled in from the ideal
                formula's H count scaled on a shared element — see
                hydrogenScale in empiricalFormulaRows.js. The hover text
                spells out the numbers. */}
            {r.hydrogenAdded != null && (
              <span
                style={{ color: COLORS.warn, fontWeight: 600 }}
                title={hydrogenAddedTitle(r.hydrogenAdded)}
              >
                , H from ideal formula
              </span>
            )}
            {/* Whether the AMC label valences were used. */}
            {r.amcValences && (
              <span style={{ color: COLORS.warn, fontWeight: 600 }} title={amcValencesTitle(r.amcValences)}>
                {r.amcValences.usable ? ", valences from AMC labels" : ", AMC label valences not used"}
              </span>
            )}
            {/* Elements the ideal formula requires that this citation never
                mentions — see missingElements in empiricalFormulaRows.js. */}
            {r.missingElements?.length > 0 && (
              <span style={{ color: COLORS.warn, fontWeight: 600 }}>
                , missing {r.missingElements.join(", ")}
              </span>
            )}
            {/* Only citation-comparison rows carry these — an ideal-formula
                row (see isIdealRow above) has neither, so this is a no-op
                for it. displayYear is already null for a bare RRUFF ID (that
                year is just the sample's submission year, not a publication
                date) and for text that already spells the year out — see
                displayYear in empiricalFormulaRows.js. */}
            {r.citation && (
              <span>
                {" — "}
                {r.citation}
                {r.displayYear != null && ` (${r.displayYear})`}
              </span>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, textAlign: "right" }}>
        <button onClick={() => downloadMineralReport(title, rows)} style={downloadButtonStyle}>
          Print Report (.txt)
        </button>
      </div>
    </div>
  );
});

// Detailed breakdown for a single formula picked out of the summary table,
// with a back button scoped to this block (not the page) so the summary
// comparison is a click away.
// `row` is the summary row that was clicked, when there is one — its
// citation (and year) are shown under the formula so the detail view still
// says which reference the numbers came from.
export const SummaryDetail = memo(function SummaryDetail({ result, row, onBack }) {
  const citation = row?.citation
    ? `${row.citation}${row.displayYear != null ? ` (${row.displayYear})` : ""}`
    : null;
  return (
    <div style={{ marginTop: 14 }}>
      <DetailedView result={result} citation={citation} onBack={onBack} />
    </div>
  );
});
