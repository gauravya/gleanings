// gleanings - API + scheduled emails (Cloudflare Worker)
//
// HTTP:
//   POST /signup          { email, name? }
//   POST /rsvp            { name, session, email? }   -> stores + sends a confirmation email
//   GET|POST /rsvp/manage?token=...                    -> change / cancel an rsvp
//   GET  /events          -> sessions with live "going" counts (cancelled excluded)
//   GET|POST /unsubscribe?token=...
//
// Cron: announcements (Events.Announce, not yet Announced) + day-before reminders
// to a session's non-cancelled RSVPs, tracked with Announced / Reminded checkboxes.
//
// Vars: AIRTABLE_BASE_ID, FROM, PUBLIC_API_BASE   Secrets: AIRTABLE_PAT, RESEND_API_KEY

const TABLE_SUBSCRIBERS = "Subscribers";
const TABLE_EVENTS = "Events";
const TABLE_RSVPS = "RSVPs";

const ALLOW_ORIGIN = "*";
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// tokens are crypto.randomUUID() values; validating the shape blocks formula injection
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
function shell(inner) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:Times New Roman,serif;text-align:center;padding:60px 16px;color:#1a1a1a">` +
    `<h1 style="font-size:24px;color:#000080">gleanings</h1>${inner}</body>`;
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
// look up a single record by its UUID token (token must be UUID-validated first)
async function findByToken(env, table, token) {
  const res = await at(env, `${encodeURIComponent(table)}?maxRecords=1&filterByFormula=${encodeURIComponent(`{Token}='${token}'`)}`);
  if (!res.ok) return { ok: false };
  const j = await res.json();
  return { ok: true, rec: j.records && j.records[0] };
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
function whenLine(f) {
  return (f.Date || "") + (f.Time ? ", " + f.Time : "") + (f.Pub ? ", " + f.Pub : "");
}
function announceMessages(env, ev, subs) {
  const f = ev.fields;
  const body =
    "many ahoys,\n\nwe have a new session up for gleanings.\n\n" +
    (f.Title || "") + "\n" + whenLine(f) + "\n" +
    (f.Reading ? "reading: " + f.Reading + "\n" : "") +
    (f.Blurb ? "\n" + f.Blurb + "\n" : "") + "\nhope to see you there.";
  return subs
    .filter((s) => !s.fields.Unsubscribed && s.fields.Email && s.fields.Token)
    .map((s) => {
      const unsub = `${env.PUBLIC_API_BASE}/unsubscribe?token=${encodeURIComponent(s.fields.Token)}`;
      return {
        from: env.FROM, to: [s.fields.Email], subject: "a new gleanings session",
        text: body + "\n\nto stop these emails: " + unsub,
        headers: { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      };
    });
}
function reminderMessages(env, ev, rsvps) {
  const f = ev.fields;
  const body =
    "ahoy,\n\na reminder that gleanings is tomorrow.\n\n" +
    (f.Title || "") + "\n" + (f.Pub || "") + (f.Time ? ", " + f.Time : "") + "\n" +
    (f.Reading ? "the reading: " + f.Reading + "\n" : "") + "\nsee you there.";
  const emails = [...new Set(
    rsvps.filter((r) => r.fields.Session === f.Date && r.fields.Email && !r.fields.Cancelled).map((r) => r.fields.Email)
  )];
  return emails.map((to) => ({ from: env.FROM, to: [to], subject: "gleanings is tomorrow", text: body }));
}
function rsvpConfirmMessage(env, ev, rsvp) {
  const f = ev ? ev.fields : {};
  const manage = `${env.PUBLIC_API_BASE}/rsvp/manage?token=${encodeURIComponent(rsvp.Token)}`;
  const when = (rsvp.Session || "") + (f.Time ? ", " + f.Time : "") + (f.Pub ? ", " + f.Pub : "");
  const body =
    "ahoy" + (rsvp.Name ? " " + rsvp.Name : "") + ",\n\n" +
    "you're down for gleanings:\n\n" +
    (f.Title || "the next session") + "\n" + when + "\n" +
    (f.Reading ? "reading: " + f.Reading + "\n" : "") +
    "\ncan't make it, or want to change your rsvp? " + manage + "\n\nsee you there.";
  return { from: env.FROM, to: [rsvp.Email], subject: "you're coming to gleanings", text: body };
}
async function sendRsvpConfirm(env, session, rsvp) {
  const evs = await listAll(env, TABLE_EVENTS, { maxRecords: "1", filterByFormula: `DATETIME_FORMAT({Date},'YYYY-MM-DD')='${session}'` });
  await resendSend(env, [rsvpConfirmMessage(env, evs[0], rsvp)]);
}
function isoDate(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    // ---- POST /signup ----
    if (request.method === "POST" && url.pathname === "/signup") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const email = (body.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ error: "invalid email" }, 400);
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
      const email = (body.email || "").trim().toLowerCase();
      if (!name || !DATE_RE.test(session)) return json({ error: "name and a valid session required" }, 400);
      const emailOk = EMAIL_RE.test(email);

      // dedup: same email + session -> re-confirm rather than duplicate
      if (emailOk) {
        const ex = await at(env, `${encodeURIComponent(TABLE_RSVPS)}?maxRecords=1&filterByFormula=${encodeURIComponent(`AND(LOWER({Email})='${email}',{Session}='${session}')`)}`);
        if (ex.ok) {
          const ej = await ex.json();
          const er = ej.records && ej.records[0];
          if (er) {
            const tok = UUID_RE.test(er.fields.Token || "") ? er.fields.Token : crypto.randomUUID();
            await patch(env, TABLE_RSVPS, er.id, { Cancelled: false, Name: name, Token: tok });
            ctx.waitUntil(sendRsvpConfirm(env, session, { Name: name, Email: email, Session: session, Token: tok }));
            return json({ ok: true, updated: true });
          }
        }
      }

      const token = crypto.randomUUID();
      const res = await create(env, TABLE_RSVPS, { Name: name, Email: email, Session: session, Token: token });
      if (!res.ok) return json({ error: "store failed" }, 502);
      if (emailOk) {
        ctx.waitUntil(sendRsvpConfirm(env, session, { Name: name, Email: email, Session: session, Token: token }));
      }
      return json({ ok: true });
    }

    // ---- GET|POST /rsvp/manage ----
    if (url.pathname === "/rsvp/manage" && (request.method === "GET" || request.method === "POST")) {
      const token = url.searchParams.get("token");
      if (!token || !UUID_RE.test(token)) return html(shell("<p>that link is not valid.</p>"), 400);
      const { ok, rec } = await findByToken(env, TABLE_RSVPS, token);
      if (!ok) return html(shell("<p>something went wrong. try again later.</p>"), 502);
      if (!rec) return html(shell("<p>we could not find that rsvp.</p>"));
      if (request.method === "POST") {
        const next = !rec.fields.Cancelled;
        await patch(env, TABLE_RSVPS, rec.id, { Cancelled: next });
        rec.fields.Cancelled = next;
      }
      const cancelled = !!rec.fields.Cancelled;
      const session = rec.fields.Session || "the next session"; // always a YYYY-MM-DD date
      const status = cancelled
        ? "<p>you are marked as <b>not coming</b>.</p>"
        : `<p>you are <b>coming</b> to gleanings on ${session}.</p>`;
      const btn = cancelled ? "actually, i can make it" : "i can no longer make it";
      const action = `${env.PUBLIC_API_BASE}/rsvp/manage?token=${encodeURIComponent(token)}`;
      return html(shell(status + `<form method="POST" action="${action}"><button type="submit" style="font:14px 'Times New Roman',serif;padding:4px 12px;margin-top:8px;cursor:pointer">${btn}</button></form>`));
    }

    // ---- GET /events ----
    if (request.method === "GET" && url.pathname === "/events") {
      const records = await listAll(env, TABLE_EVENTS, { "sort[0][field]": "Date", "sort[0][direction]": "asc" });
      const events = records.map((r) => r.fields).filter((f) => f.Date).map((f) => ({
        title: f.Title || "", date: f.Date || "", time: f.Time || "", pub: f.Pub || "", reading: f.Reading || "", blurb: f.Blurb || "", going: 0,
      }));
      const rsvps = await listAll(env, TABLE_RSVPS);
      const counts = {};
      rsvps.forEach((r) => { const s = r.fields.Session; if (s && !r.fields.Cancelled) counts[s] = (counts[s] || 0) + 1; });
      events.forEach((e) => { e.going = counts[e.date] || 0; });
      return json({ events });
    }

    // ---- GET|POST /unsubscribe ----
    if (url.pathname === "/unsubscribe" && (request.method === "GET" || request.method === "POST")) {
      const token = url.searchParams.get("token");
      if (!token || !UUID_RE.test(token)) return html(shell("<p>that link is not valid.</p>"), 400);
      const { ok, rec } = await findByToken(env, TABLE_SUBSCRIBERS, token);
      if (!ok) return html(shell("<p>something went wrong. try again later.</p>"), 502);
      if (!rec) return html(shell("<p>you are already unsubscribed.</p>"));
      const upd = await patch(env, TABLE_SUBSCRIBERS, rec.id, { Unsubscribed: true });
      if (!upd.ok) return html(shell("<p>something went wrong. try again later.</p>"), 502);
      return html(shell("<p>you have been unsubscribed. no more emails. ahoy.</p>"));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    const events = await listAll(env, TABLE_EVENTS);

    const toAnnounce = events.filter((e) => e.fields.Announce && !e.fields.Announced);
    if (toAnnounce.length) {
      const subs = await listAll(env, TABLE_SUBSCRIBERS);
      for (const ev of toAnnounce) {
        await resendSend(env, announceMessages(env, ev, subs));
        await patch(env, TABLE_EVENTS, ev.id, { Announced: true });
      }
    }

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
