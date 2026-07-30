# Geosurv client request tracker

A free, public, no-login, read-only viewer that lets a Geosurv client watch their own
survey requests move through the pipeline. Clients open it from a link in the automated
status emails they already receive.

Live: `https://geosurv-pty-ltd.github.io/requests/?c=<company token>`

Source of truth is the monday board **SPW Service Requests Register** (`5029989258`). A
GitHub Actions cron reads the board every 15 minutes, builds one client-safe JSON payload
per company, and deploys the whole site to GitHub Pages.

Everything here is on free tiers with no billable component: public repo (unlimited free
Actions minutes), GitHub Pages, no serverless functions, no database.

---

## How the privacy boundary actually works

Each company gets an unguessable 32 hex character token. Its payload is published at
`data/<token>.json` and the viewer fetches only that one file.

**Nothing data-related is ever committed.** The workflow writes `dist/` at run time and
`actions/deploy-pages` publishes it directly. This matters: this repo is public, and a
committed `data/` directory would be listed by GitHub's file browser, handing every
company's token to anyone who found the repo. Because the payloads exist only in the
deployed Pages output, and Pages does not generate directory indexes, `/data/` returns 404
and a payload is reachable only by knowing the exact token.

For the same reason the token to company map is **not** in this repo. It lives in the
`COMPANY_TOKENS` secret.

### What a payload may contain

Whitelisted at write time in `scripts/transform.mjs`, by explicit construction:

`request_id` · `title` · `status` · `station` · `required_by` · `scheduled_date` ·
`delivered_date` · `deliverable_link` · `closed`

### What must never appear, and what stops it

The Email column (`emailacynbpqm`), the Description (`long_textw1anfgaa`, which holds
internal notes and other people's email addresses), Assigned surveyor
(`multiple_person_mm5bcmx0`), Requested by, Service type, Priority, Location and
Supporting files.

Three independent guards:

1. `scripts/build.mjs` requests **only** the whitelisted column ids from the monday API, so
   the excluded columns are never fetched in the first place.
2. `assertClean()` throws, failing the workflow before anything is published, if a payload
   contains a forbidden column id, an email address, or a key outside the whitelist.
3. `node --test` runs in CI ahead of the build, with tests that feed the excluded columns
   in deliberately and assert they do not survive.

An email address typed by a client into a request *title* is redacted to `[removed]` rather
than throwing, so one stray address cannot take the tracker offline.

---

## Setup

### 1. The two secrets

**`MONDAY_API_TOKEN`** — profile picture → **Developers** → Developer Center →
**API token** → **Show** → copy, then add it under
*Settings → Secrets and variables → Actions*.

Note: monday personal API tokens cannot be restricted to read only. They mirror the
account holder's own permissions. The token is used only inside the workflow, is never
committed, never reaches the browser, and cannot be read by a pull request from a fork
because this workflow has no `pull_request` trigger.

**`COMPANY_TOKENS`** — the token to company map, as one line of JSON. The value on the
left is the URL token, the value on the right must match the **Company** column label
(`color_mm5rb4n0`) on the board exactly.

```json
{"0123456789abcdef0123456789abcdef":"Gamuda"}
```

The token above is a placeholder. Real tokens appear only in the secret and in the link
sent to the client, never in this repository.

### 2. Pages

*Settings → Pages → Source: GitHub Actions*. Already set.

---

## Adding a company

One line. Edit the `COMPANY_TOKENS` secret and add a pair:

```json
{"<existing token>":"Gamuda","<new 32 hex token>":"John Holland"}
```

Generate the token with:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Then run the workflow (Actions → Refresh client viewer → Run workflow) and send that
company `https://geosurv-pty-ltd.github.io/requests/?c=<their token>`. The company label
must already exist on the board's Company column. A company with no rows yet gets an empty
tracker rather than a broken link.

To revoke a company's link, remove its pair from the secret and rerun. The old file
disappears on the next deploy.

---

## Layout

```
.github/workflows/refresh.yml   cron */15, workflow_dispatch, push to main
scripts/transform.mjs           the whitelist and the sort. Pure, no I/O
scripts/transform.test.mjs      proves the whitelist holds
scripts/build.mjs               reads monday, writes dist/
site/                           the viewer. One HTML file, no dependencies
```

`dist/` is generated and git-ignored. Never commit it.

## Known operational notes

- **The cron had not fired on its own as at the first handover.** The job is proven by manual
  dispatch and by push, but GitHub had not triggered it on the schedule after ~2.5 hours and
  ~10 slots, with the workflow reporting `state=active` and nothing misconfigured. GitHub is
  slow to start scheduling brand-new workflows. Check the Actions tab for a run whose event is
  `schedule`. If it never schedules, lengthen the interval (hourly is honoured far more
  reliably) and change the viewer header to match rather than keep promising 15 minutes.
  A refresh can always be forced: Actions → Refresh client viewer → Run workflow.
- The cron sits at 7/22/37/52 past rather than `*/15` on purpose. GitHub documents that runs
  scheduled on high-load minutes are delayed or dropped, and the quarter-hour marks are the
  busiest on the shared queue.
- GitHub disables scheduled workflows after 60 days with no repository activity, and
  emails the admin a one-click re-enable link. Any commit resets the clock.
- Scheduled runs can start late when GitHub is busy, so the viewer displays the real
  snapshot time next to the "Updated every 15 minutes" note rather than implying freshness
  it cannot guarantee.
- The "Request a change" button opens the public **Request a change** WorkForm with the
  Request ID pre-filled through the `rid` URL parameter. The form URL is a constant near
  the top of the script in `site/index.html`.

