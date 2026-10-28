import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devRecordProxy from "./devRecordProxy.js";

// The WordPress plugin (wordpress-plugin/odr-rruff-mineralcalc/) enqueues
// whatever it finds at dist/assets/index-*.js|css relative to its own
// plugin directory (see odr-rruff-mineralcalc.php) — building straight into
// that folder means "npm run build" produces exactly what the plugin loads,
// no manual copy step. `base: "./"` keeps every asset URL relative, since
// the plugin can end up installed under any path on any WordPress site.
export default defineConfig({
  // Dev only; the plugin has its own PHP proxy.
  plugins: [react(), devRecordProxy()],
  base: "./",
  build: {
    outDir: "wordpress-plugin/odr-rruff-mineralcalc/dist",
    emptyOutDir: true,
    // public/ only holds RRUFF's IMA list and cellparams data for local dev
    // (see metrics.html) — ~45 MB the plugin must not ship; on the live site
    // it's loaded from rruff.net's own copy.
    copyPublicDir: false,
  },
});
