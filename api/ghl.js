/* =====================================================================
   /api/ghl.js  —  GHL → Dashboard proxy  (Vercel serverless function)
   ---------------------------------------------------------------------
   WHY THIS FILE EXISTS
   The Private Integration Token (PIT) must NEVER be sent to the browser.
   This function runs server-side on Vercel, holds the token in an
   environment variable, calls GHL v2, and returns a clean flat table.

   THE 401 "Invalid JWT" FIX
   GHL v2 rejects any request missing the Version header. All three
   headers below are mandatory together:
     Authorization: Bearer <PIT>
     Version: 2021-07-28
     Accept: application/json

   ENVIRONMENT VARIABLES (set in Vercel → Project → Settings → Env Vars)
     GHL_PIT          = your Private Integration Token
     GHL_LOCATION_ID  = the sub-account location ID
   (Then redeploy. Never commit these into the repo.)

   CUSTOM FIELD MAPPING
   Occupation / Package / Payment Type / Visa / Enrolled Date live as
   custom fields on the opportunity or contact. Their IDs are unique to
   Leo's build. Paste the real IDs into CF below — get them once via:
     GET https://services.leadconnectorhq.com/locations/{locationId}/customFields
===================================================================== */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const HEADERS = () => ({
  Authorization: `Bearer ${process.env.GHL_PIT}`,
  Version: '2021-07-28',
  Accept: 'application/json',
});

// ---- paste the real custom-field IDs from Leo's GHL location here ----
const CF = {
  occupation:  'REPLACE_occupation_field_id',
  package:     'REPLACE_package_field_id',
  paymentType: 'REPLACE_paymentType_field_id',
  visa:        'REPLACE_visa_subclass_field_id',
  enrolledDate:'REPLACE_enrolled_date_field_id',
  collected:   'REPLACE_amount_collected_field_id', // optional
};

// pull a custom field value out of an opportunity's customFields array
function cf(opp, id) {
  if (!opp.customFields) return null;
  const hit = opp.customFields.find(f => f.id === id);
  return hit ? (hit.fieldValue ?? hit.value ?? null) : null;
}

// simple in-memory cache to respect the 100-req / 10s burst limit
let CACHE = { at: 0, payload: null };
const TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAllOpportunities(locationId) {
  const out = [];
  let page = 1;
  // GHL caps search pages; loop defensively until empty or a sane ceiling
  while (page <= 50) {
    const url = `${GHL_BASE}/opportunities/search?location_id=${locationId}&limit=100&page=${page}`;
    const res = await fetch(url, { headers: HEADERS() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GHL ${res.status} on page ${page}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const batch = json.opportunities || [];
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

function mapRow(o) {
  const created = o.createdAt ? new Date(o.createdAt).getTime() : null;
  const enrolledRaw = cf(o, CF.enrolledDate);
  const enrolledAt = enrolledRaw ? new Date(enrolledRaw).getTime() : null;
  const value = Number(o.monetaryValue) || 0;
  const collected = Number(cf(o, CF.collected)) || (o.status === 'won' ? value : 0);
  const cycleDays = (enrolledAt && created) ? Math.round((enrolledAt - created) / 86400000) : null;

  // GHL status: open | won | lost | abandoned  →  collapse to our three
  const status = o.status === 'won' ? 'won' : o.status === 'lost' || o.status === 'abandoned' ? 'lost' : 'open';

  return {
    id: o.id,
    name: o.name || o.contact?.name || 'Unknown',
    value,
    collected,
    status,
    stage: o.pipelineStageName || o.stage || 'New Lead',
    stageIdx: 0, // resolved client-side if you pass a stage order; otherwise derive from pipelineStageName
    package: cf(o, CF.package) || 'Silver',
    occupation: cf(o, CF.occupation) || 'Other',
    assignee: o.assignedToName || o.assignedTo || 'Unassigned',
    paymentType: cf(o, CF.paymentType) || 'Full Payment',
    visa: cf(o, CF.visa) || 'Other',
    createdAt: created,
    enrolledAt,
    cycleDays,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!process.env.GHL_PIT || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'Missing GHL_PIT or GHL_LOCATION_ID env vars' });
  }

  // serve cache if fresh
  if (CACHE.payload && Date.now() - CACHE.at < TTL) {
    return res.status(200).json({ ...CACHE.payload, cached: true });
  }

  try {
    const opps = await fetchAllOpportunities(process.env.GHL_LOCATION_ID);
    const rows = opps.map(mapRow);

    // referral rows: opportunities that carry a referrer custom field would
    // be filtered here. Left as an empty array until the referral CF id is
    // mapped — wire it the same way as the CF block above.
    const refs = [];

    const payload = { rows, refs, count: rows.length, generatedAt: new Date().toISOString() };
    CACHE = { at: Date.now(), payload };
    return res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
