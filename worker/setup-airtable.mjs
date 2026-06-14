// Creates the gleanings tables in your Airtable base.
// Reads the PAT from ~/.gleanings_pat (never printed, never an argument).
// No descriptions on any table or field, per preference.
//   run:  node setup-airtable.mjs

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const pat = readFileSync(join(homedir(), ".gleanings_pat"), "utf8").trim();
const H = { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" };

const api = async (path, opts = {}) => {
  const res = await fetch(`https://api.airtable.com/v0/meta${path}`, {
    ...opts,
    headers: { ...H, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
};

const who = await api("/whoami");
if (!who.ok) { console.error("token check failed:", who.status, who.body); process.exit(1); }
console.log("token ok, user:", who.body.id);

const bases = await api("/bases");
if (!bases.ok) { console.error("list bases failed:", bases.status, bases.body); process.exit(1); }
const all = bases.body.bases || [];
console.log("bases visible to token:", all.map((b) => `${b.name} (${b.id})`).join(", ") || "(none)");

const base = all.find((b) => b.name.toLowerCase() === "gleanings") || (all.length === 1 ? all[0] : null);
if (!base) { console.error('could not find a "gleanings" base. name one base "gleanings" or grant the token access to it.'); process.exit(1); }
console.log("using base:", base.name, base.id);

const schema = await api(`/bases/${base.id}/tables`);
if (!schema.ok) { console.error("read schema failed:", schema.status, schema.body); process.exit(1); }
const existing = new Set((schema.body.tables || []).map((t) => t.name));

const createTable = async (def, minimal) => {
  if (existing.has(def.name)) { console.log(`- ${def.name} already exists, skipping`); return; }
  let r = await api(`/bases/${base.id}/tables`, { method: "POST", body: JSON.stringify(def) });
  if (!r.ok && minimal) {
    console.error(`! ${def.name} full create failed (${r.status}): ${JSON.stringify(r.body)} - retrying minimal`);
    r = await api(`/bases/${base.id}/tables`, { method: "POST", body: JSON.stringify(minimal) });
  }
  if (r.ok) console.log(`+ created ${def.name}`);
  else console.error(`! failed ${def.name}: ${r.status} ${JSON.stringify(r.body)}`);
};

await createTable(
  {
    name: "Subscribers",
    fields: [
      { name: "Email", type: "singleLineText" },
      { name: "Name", type: "singleLineText" },
      { name: "Created", type: "createdTime", options: { result: { type: "dateTime", options: { dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "Europe/London" } } } },
    ],
  },
  { name: "Subscribers", fields: [{ name: "Email", type: "singleLineText" }, { name: "Name", type: "singleLineText" }] }
);

await createTable(
  {
    name: "Events",
    fields: [
      { name: "Title", type: "singleLineText" },
      { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
      { name: "Pub", type: "singleLineText" },
      { name: "Reading", type: "url" },
      { name: "Blurb", type: "multilineText" },
      { name: "Announce", type: "checkbox", options: { icon: "check", color: "greenBright" } },
    ],
  },
  { name: "Events", fields: [{ name: "Title", type: "singleLineText" }, { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } }, { name: "Pub", type: "singleLineText" }, { name: "Reading", type: "url" }, { name: "Blurb", type: "multilineText" }] }
);

await createTable({
  name: "RSVPs",
  fields: [
    { name: "Name", type: "singleLineText" },
    { name: "Email", type: "singleLineText" },
    { name: "Session", type: "singleLineText" },
  ],
});

// ensure extra fields exist (unsubscribe + send-tracking)
{
  const schema2 = await api(`/bases/${base.id}/tables`);
  const byName = {};
  (schema2.body.tables || []).forEach((t) => { byName[t.name] = t; });
  const ensure = async (tableName, def) => {
    const t = byName[tableName];
    if (!t) return;
    if (t.fields.some((f) => f.name === def.name)) { console.log(`- ${tableName}.${def.name} already exists`); return; }
    const r = await api(`/bases/${base.id}/tables/${t.id}/fields`, { method: "POST", body: JSON.stringify(def) });
    if (r.ok) console.log(`+ added ${tableName}.${def.name}`);
    else console.error(`! ${tableName}.${def.name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  };
  await ensure("Subscribers", { name: "Token", type: "singleLineText" });
  await ensure("Subscribers", { name: "Unsubscribed", type: "checkbox", options: { icon: "check", color: "redBright" } });
  await ensure("Events", { name: "Announced", type: "checkbox", options: { icon: "check", color: "greenBright" } });
  await ensure("Events", { name: "Reminded", type: "checkbox", options: { icon: "check", color: "blueBright" } });
  await ensure("RSVPs", { name: "Token", type: "singleLineText" });
  await ensure("RSVPs", { name: "Cancelled", type: "checkbox", options: { icon: "check", color: "redBright" } });
}

console.log("done.");
