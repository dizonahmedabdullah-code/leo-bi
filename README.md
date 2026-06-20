# Leo Le Education — BI Command Center

A single-page sales dashboard with Excel-style slicers, cross-filtering, and live GoHighLevel data.

## Files
- `index.html` — the dashboard (runs on demo data out of the box)
- `api/ghl.js` — serverless proxy that holds the GHL token and feeds the dashboard live data
- `README.md` — this file

---

## Deploy in 3 steps (Vercel — recommended, because it runs the backend function)

**1. Push these files to a GitHub repo, then import the repo at vercel.com → New Project.**
Vercel auto-serves `index.html` at the root and `api/ghl.js` at `/api/ghl`. No build config needed.

**2. Add two Environment Variables** (Vercel → Project → Settings → Environment Variables):
   - `GHL_PIT` = your Private Integration Token
   - `GHL_LOCATION_ID` = the sub-account Location ID
   Then **Redeploy** so the variables take effect.

**3. Flip the dashboard to live:** in `index.html`, change `const USE_LIVE = false;` to `true`, and paste the real custom-field IDs into the `CF` block in `api/ghl.js`. Push the change.

That's it. The badge in the top-right flips from amber **Demo Data** to green **Live · GHL**.

---

## Getting the Private Integration Token
GHL sub-account → **Settings → Private Integrations → Create New Integration**.
Give it read scopes: `opportunities.readonly`, `contacts.readonly`, `calendars.readonly`, `locations/customFields.readonly`.
Copy the token (shown once) into `GHL_PIT`.

## Getting the custom-field IDs
Run once (or use the GHL API playground):
```
GET https://services.leadconnectorhq.com/locations/{LOCATION_ID}/customFields
Headers: Authorization: Bearer <PIT> | Version: 2021-07-28 | Accept: application/json
```
Match each field name (Occupation, Package, Payment Type, Visa Subclass, Enrolled Date) to its `id` and paste into `CF` in `api/ghl.js`.

---

## Netlify alternative
Netlify works too, but functions live in `netlify/functions/ghl.js` and export `exports.handler` instead of a default export. Same logic, slightly different wrapper. Vercel is the cleaner path here since the existing custom build is already Vercel-based.

---

## Why the dashboard never calls GHL directly
The token grants full read access to the CRM. In a static file it would be visible in browser source, and GHL blocks cross-origin browser calls anyway. The serverless function is the only safe place for the token — the browser only ever talks to `/api/ghl`.
