// gleanings - API + scheduled emails (Cloudflare Worker)
//
// HTTP:
//   POST /signup        { email, name? }
//   POST /rsvp          { name, session, email? }
//   GET  /events        -> sessions with live "going" counts
//   GET|POST /unsubscribe?token=...
//
// Cron (scheduled): sends announcements (Events.Announce checked, not yet
// Announced) and day-before reminders to RSVPs, tracked with the Announced /
// Reminded checkboxes so nothing sends twice.
//
// Vars (wrangler.toml): AIRTABLE_BASE_ID, FROM, PUBLIC_API_BASE
// Secrets:              AIRTABLE_PAT, RESEND_API_KEY

const TABLE_SUBSCRIBERS = "Subscribers";
const TABLE_EVENTS = "Events";
const TABLE_RSVPS = "RSVPs";

const ALLOW_ORIGIN = "*";

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors() } });
}
function html(markup, status = 200) {
  return new Response(markup, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...cors() } });
}

// --- Airtable ---
function at(env, path, opts = {}) {
  return fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}
async function listAll(env, table, params = {}) {
  const out = [];
  let offset = "";
  do {
    const p = new URLSearchParams(params);
    if (offset) p.set("offset", offset);
    const qs = p.toString();
    const res = await at(env, encodeURIComponent(table) + (qs ? "?" + qs : ""));
    if (!res.ok) break;
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return out;
}
function create(env, table, fields) {
  return at(env, encodeURIComponent(table), { method: "POST", body: JSON.stringify({ fields, typecast: true }) });
}
function patch(env, table, id, fields) {
  return at(env, `${encodeURIComponent(table)}/${id}`, { method: "PATCH", body: JSON.stringify({ fields }) });
}

// --- Resend ---
async function resendSend(env, messages) {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error("resend " + res.status + " " + (await res.text()));
  }
}

function announceMessages(env, ev, subs) {
  const f = ev.fields;
  const body =
    "many ahoys,\n\nwe have a new session up for gleanings.\n\n" +
    (f.Title || "") + "\n" +
    (f.Date || "") + (f.Pub ? ", " + f.Pub : "") + "\n" +
    (f.Reading ? "reading: " + f.Reading + "\n" : "") +
    (f.Blurb ? "\n" + f.Blurb + "\n" : "") +
    "\nhope to see you there.";
  return subs
    .filter((s) => !s.fields.Unsubscribed && s.fields.Email)
    .map((s) => {
      const unsub = `${env.PUBLIC_API_BASE}/unsubscribe?token=${encodeURIComponent(s.fields.Token || "")}`;
      return {
        from: env.FROM,
        to: [s.fields.Email],
        subject: "a new gleanings session",
        text: body + "\n\nto stop these emails: " + unsub,
        headers: { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      };
    });
}
function reminderMessages(env, ev, rsvps) {
  const f = ev.fields;
  const body =
    "ahoy,\n\na reminder that gleanings is tomorrow.\n\n" +
    (f.Title || "") + "\n" + (f.Pub || "") + "\n" +
    (f.Reading ? "the reading: " + f.Reading + "\n" : "") +
    "\nsee you there.";
  const emails = [...new Set(
    rsvps.filter((r) => r.fields.Session === f.Date && r.fields.Email).map((r) => r.fields.Email)
  )];
  return emails.map((to) => ({ from: env.FROM, to: [to], subject: "gleanings is tomorrow", text: body }));
}
function isoDate(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    // ---- POST /signup ----
    if (request.method === "POST" && url.pathname === "/signup") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const email = (body.email || "").trim().toLowerCase();
      if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) return json({ error: "invalid email" }, 400);
      const dupe = await at(env, `${encodeURIComponent(TABLE_SUBSCRIBERS)}?maxRecords=1&filterByFormula=${encodeURIComponent(`LOWER({Email})='${email}'`)}`);
      if (dupe.ok) {
        const dj = await dupe.json();
        if (dj.records && dj.records.length) return json({ ok: true, already: true });
      }
      const res = await create(env, TABLE_SUBSCRIBERS, { Email: email, Name: (body.name || "").trim(), Token: crypto.randomUUID() });
      if (!res.ok) return json({ error: "store failed" }, 502);
      return json({ ok: true });
    }

    // ---- POST /rsvp ----
    if (request.method === "POST" && url.pathname === "/rsvp") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const name = (body.name || "").trim();
      const session = (body.session || "").trim();
      if (!name || !session) return json({ error: "name and session required" }, 400);
      const res = await create(env, TABLE_RSVPS, { Name: name, Email: (body.email || "").trim(), Session: session });
      if (!res.ok) return json({ error: "store failed" }, 502);
      return json({ ok: true });
    }

    // ---- GET /events ----
    if (request.method === "GET" && url.pathname === "/events") {
      const records = await listAll(env, TABLE_EVENTS, { "sort[0][field]": "Date", "sort[0][direction]": "asc" });
      const events = records.map((r) => r.fields).filter((f) => f.Date).map((f) => ({
        title: f.Title || "", date: f.Date || "", pub: f.Pub || "", reading: f.Reading || "", blurb: f.Blurb || "", going: 0,
      }));
      const rsvps = await listAll(env, TABLE_RSVPS);
      const counts = {};
      rsvps.forEach((r) => { const s = r.fields.Session; if (s) counts[s] = (counts[s] || 0) + 1; });
      events.forEach((e) => { e.going = counts[e.date] || 0; });
      return json({ events });
    }

    // ---- /unsubscribe ----
    if (url.pathname === "/unsubscribe" && (request.method === "GET" || request.method === "POST")) {
      const token = url.searchParams.get("token");
      const page = (msg) =>
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font-family:Times New Roman,serif;text-align:center;padding:60px 16px;color:#1a1a1a">` +
        `<h1 style="font-size:24px;color:#000080">gleanings</h1><p>${msg}</p></body>`;
      if (!token) return html(page("that link is missing its token."), 400);
      const found = await at(env, `${encodeURIComponent(TABLE_SUBSCRIBERS)}?maxRecords=1&filterByFormula=${encodeURIComponent(`{Token}='${token}'`)}`);
      if (!found.ok) return html(page("something went wrong. try again later."), 502);
      const fj = await found.json();
      const rec = fj.records && fj.records[0];
      if (!rec) return html(page("you are already unsubscribed."));
      const upd = await patch(env, TABLE_SUBSCRIBERS, rec.id, { Unsubscribed: true });
      if (!upd.ok) return html(page("something went wrong. try again later."), 502);
      return html(page("you have been unsubscribed. no more emails. ahoy."));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    const events = await listAll(env, TABLE_EVENTS);

    // announcements: Announce ticked, not yet Announced
    const toAnnounce = events.filter((e) => e.fields.Announce && !e.fields.Announced);
    if (toAnnounce.length) {
      const subs = await listAll(env, TABLE_SUBSCRIBERS);
      for (const ev of toAnnounce) {
        await resendSend(env, announceMessages(env, ev, subs));
        await patch(env, TABLE_EVENTS, ev.id, { Announced: true });
      }
    }

    // reminders: once a day near 09:00 UTC, for sessions happening tomorrow
    const now = new Date();
    if (now.getUTCHours() === 9) {
      const tomorrow = isoDate(new Date(now.getTime() + 86400000));
      const toRemind = events.filter((e) => e.fields.Date === tomorrow && !e.fields.Reminded);
      if (toRemind.length) {
        const rsvps = await listAll(env, TABLE_RSVPS);
        for (const ev of toRemind) {
          await resendSend(env, reminderMessages(env, ev, rsvps));
          await patch(env, TABLE_EVENTS, ev.id, { Reminded: true });
        }
      }
    }
  },
};
