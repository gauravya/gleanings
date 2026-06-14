# gleanings - setup runbook

Stack: a static site (Cloudflare Pages) + Airtable (your base, already built) +
a Cloudflare Worker (holds the Airtable token) + Resend (sends the emails).
No login, no Eventbrite.

## Already done (by Claude, via the saved PAT)
- Airtable base "Gleanings" (appc57EzaW0CzWfi6) with three tables:
  - **Subscribers**: Email, Name, Token, Unsubscribed
  - **Events**: Title, Date, Pub, Reading, Blurb, Announce
  - **RSVPs**: Name, Email, Session
- Worker code (`worker/worker.js`): `/signup`, `/rsvp`, `/events` (with live "going" counts), `/unsubscribe`.
- The page: sessions list, rsvp button, email signup. One config value to set: `window.GLEANINGS_API` in `index.html`.
- Email scripts: `worker/airtable-automation.js` (announce) and `worker/airtable-reminder.js` (reminder), both with unsubscribe handling.

## What needs you

### A. Cloudflare (the deploy)
1. A Cloudflare account (free) if you do not have one.
2. In a terminal: `npx wrangler login` (opens the browser once).
3. Tell Claude you are logged in. Claude then runs:
   - `cat ~/.gleanings_pat | wrangler secret put AIRTABLE_PAT` (from the worker/ dir)
   - `wrangler deploy`  ->  gives a URL like `https://gleanings-api.<you>.workers.dev`
   - `wrangler pages deploy .` for the site
4. Claude pastes the Worker URL into `index.html` (`window.GLEANINGS_API`) and into the two email scripts (`API_BASE`).
5. For the real domain: add `gleanings.xyz` to Cloudflare and switch its nameservers at your registrar to the ones Cloudflare gives you. Then attach `gleanings.xyz` to the Pages project and `api.gleanings.xyz` to the Worker.

After step 4, signups and RSVPs work and land in Airtable. No emails yet.

### B. Resend (the emails)
1. A Resend account (free).
2. Add `gleanings.xyz` as a sending domain. Resend gives you DNS records; add them in Cloudflare DNS, then verify.
3. Create an API key.
4. The key does not go to Claude or the Worker. It goes into the two Airtable automations, which only you can create (the Airtable API cannot make automations):
   - **Announce**: Events table, trigger "when a record matches conditions" (Announce is checked), action "run a script" = paste `worker/airtable-automation.js`, input variable `eventId` = the trigger record's Record ID. Paste the Resend key and set `API_BASE` to the Worker URL.
   - **Reminder**: trigger "at a scheduled time" daily, action "run a script" = paste `worker/airtable-reminder.js`. Paste the Resend key.

## Day to day
- Add an Events row, tick Announce -> subscribers get the email.
- People sign up or RSVP on the site -> rows appear in Airtable.
- The day before a session -> people who RSVP'd get a reminder.
