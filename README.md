# Parts Sniper

A multi-project, AI-powered parts-hunting app. Each **project** is its own search
(e.g. "OEM seats for a McLaren 720S") that you refine with an editable config and
teach with 👍/👎 feedback. Searches run on-demand via a Vercel serverless function
that calls the Claude API with web search. Deployed on Vercel, backed by Postgres.

## Architecture

```
/public            static frontend (dashboard + project view), served at the site root
  index.html       projects dashboard + create-project
  project.html     one project: editable config, results, 👍/👎, cart, "Re-run"
  /assets          app.css, app.js (API client + per-project cart), logo.svg
/api               serverless functions (Node, ESM)
  _db.js           Postgres schema + shared utils + one-time seed of the 992 project
  _anthropic.js    Claude API: expand a goal → config, and run a web-search parts search
  _auth.js         access-control seam (open in v1; enforce here later)
  projects.js      GET list / POST create (AI drafts the config)
  project.js       GET one / PATCH config / DELETE
  run.js           POST: run the AI search (with per-project daily run cap)
  feedback.js      GET / POST 👍/👎 (one vote per listing, fed into the next run)
```

The **learning loop**: your 👍/👎 votes are stored per project and passed into every
run's prompt ("prefer similar to these / avoid these"), alongside your editable
queries and rules. It's feedback-conditioned prompting, not model retraining — results
compound as you vote.

## One-time setup on Vercel (only you can do these)

1. **Import the repo** into Vercel (Add New → Project → import `ADGT3/PartsHunter`).
2. **Add Postgres:** in the Vercel project → **Storage** → create a **Postgres** database
   and connect it to this project. This auto-sets `POSTGRES_URL` (and friends).
3. **Add environment variables** (Project → Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` — **required**. Your Anthropic API key (server-side only).
   - `ANTHROPIC_MODEL` — optional, defaults to `claude-sonnet-5`.
   - `RUN_CAP_PER_DAY` — optional, defaults to `20` (max AI runs per project per 24h — cost guard).
   - `SEARCH_MAX_USES` — optional, defaults to `6` (max web searches per run — speed/cost guard).
   - `APP_PASSWORD` — optional. Leave unset for now (v1 is open); set later to turn on the access gate.
4. **Redeploy.** On first load the app auto-creates the tables and seeds the
   **992 GT3 RS** project with its current listings.

## Notes / limits

- Serverless functions cap at 60s on Vercel Hobby. A run is bounded (`SEARCH_MAX_USES`)
  to fit; very deep sweeps may need a higher plan or the scheduled path.
- The web-search tool version is pinned in `_anthropic.js` (`web_search_20250305`) and the
  model in `ANTHROPIC_MODEL` — bump these if the API surface changes.
- Product images are hotlinked from source listings; some may not load if a listing is
  removed. Carts are stored per project in your browser.
- Not affiliated with Porsche AG or any manufacturer. Marques are used for identification only.
