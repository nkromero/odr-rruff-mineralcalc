import fs from "node:fs";
import path from "node:path";

// Dev-only stand-in for the plugin's record and elements routes, using the
// API login in .env. The login and token stay server-side.
const TOKEN_URL = "https://www.rruff.net/odr_rruff/api/v4/token";
const RECORD_URL = "https://www.rruff.net/odr_rruff/api/v4/dataset/record/";

// Re-read on each login so .env edits apply without a restart.
function readEnv(root) {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

// Cached until a minute before the JWT expires (30 minutes if it has no expiry).
let cachedToken = "";
let cachedTokenExpiry = 0;

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp) return payload.exp * 1000 - 60 * 1000;
  } catch {}
  return Date.now() + 30 * 60 * 1000;
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function getToken(root) {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const { username, password } = readEnv(root);
  if (!username || !password) {
    throw httpError("No username / password in .env - copy .env.example to .env and fill it in.", 500);
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw httpError(`Login failed: ${res.status} ${res.statusText} - check the credentials in .env`, 502);

  let token;
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const data = await res.json();
    token = data.token || data.access_token || data.jwt;
  } else {
    token = (await res.text()).trim();
  }
  if (!token) throw httpError("Login response did not include a token", 502);

  cachedToken = token;
  cachedTokenExpiry = tokenExpiry(token);
  return token;
}

async function fetchRecord(root, uuid) {
  const token = await getToken(root);
  const res = await fetch(RECORD_URL + encodeURIComponent(uuid), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    // Log in afresh next time.
    cachedToken = "";
    throw httpError(`Request failed: ${res.status} - the API rejected the token.`, res.status);
  }
  if (!res.ok) throw httpError(`Request failed: ${res.status} ${res.statusText}`, res.status === 404 ? 404 : 502);
  const text = (await res.text()).trim();
  try {
    JSON.parse(text);
  } catch {
    throw httpError("The API returned a record that is not valid JSON.", 502);
  }
  return text;
}

// Every element record's fields, fetched 8 at a time and cached.
const ELEMENTS_LIST_URL = "https://www.rruff.net/odr_rruff/api/v4/search/database/7064266bc2cd52543b43b679de22/records";
let cachedElements = null;

async function fetchElements(root) {
  if (cachedElements) return cachedElements;
  const headers = { Authorization: `Bearer ${await getToken(root)}` };
  const listRes = await fetch(ELEMENTS_LIST_URL, { headers });
  if (listRes.status === 401 || listRes.status === 403) cachedToken = "";
  if (!listRes.ok) throw httpError(`Element list request failed: ${listRes.status} ${listRes.statusText}`, 502);
  const uuids = ((await listRes.json()).records || []).map((r) => r.unique_id).filter(Boolean);
  if (uuids.length === 0) throw httpError("The element database listed no records.", 502);

  const elements = [];
  let next = 0;
  async function worker() {
    while (next < uuids.length) {
      const uuid = uuids[next++];
      const res = await fetch(RECORD_URL + encodeURIComponent(uuid), { headers });
      if (!res.ok) throw httpError(`Element record ${uuid} could not be fetched: ${res.status}`, 502);
      const { fields = [] } = await res.json();
      elements.push(Object.fromEntries(fields.map((f) => [f.field_name, f.value ?? null])));
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  cachedElements = JSON.stringify(elements);
  return cachedElements;
}

export default function devRecordProxy() {
  let root = process.cwd();
  return {
    name: "dev-record-proxy",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use("/odr_rruff/api/elements", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        try {
          res.statusCode = 200;
          res.end(await fetchElements(root));
        } catch (e) {
          res.statusCode = e.status || 502;
          res.end(JSON.stringify({ message: e.message }));
        }
      });
      server.middlewares.use("/odr_rruff/api/record/", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const uuid = decodeURIComponent((req.url || "").replace(/^\/|[?#].*$/g, ""));
        try {
          // Same pattern as the plugin's REST route.
          if (!/^[0-9a-fA-F]{1,64}$/.test(uuid)) throw httpError("Not a record UUID.", 400);
          res.statusCode = 200;
          res.end(await fetchRecord(root, uuid));
        } catch (e) {
          // `message`, like a WordPress REST error.
          res.statusCode = e.status || 502;
          res.end(JSON.stringify({ message: e.message }));
        }
      });
    },
  };
}
