import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import MetricsPage from "./MetricsPage.jsx";
import { loadElementsFromDatabase } from "./elementsLoader.js";

// The WordPress plugin's two shortcodes share this one bundle and root div:
// [odr-rruff-mineralcalc] is the calculator, [odr-rruff-mineralcalc-metrics]
// adds data-view="metrics" to show the metrics page instead.
const root = document.getElementById("mineral-parser-root");

// Waits for the element database (or the bundled fallback) before rendering.
function ElementsGate({ children }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadElementsFromDatabase()
      .catch((e) => console.warn(`ODR RRUFF Mineral Calculator: using the bundled element table - ${e.message}`))
      .finally(() => setReady(true));
  }, []);
  if (!ready) {
    return <div style={{ padding: "32px 20px", fontSize: 14, fontFamily: "'Inter', system-ui, sans-serif" }}>Loading element data…</div>;
  }
  return children;
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ElementsGate>{root.dataset.view === "metrics" ? <MetricsPage /> : <App />}</ElementsGate>
  </React.StrictMode>
);
