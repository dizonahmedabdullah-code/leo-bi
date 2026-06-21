/* =====================================================================
   /api/ghl.js  —  GHL (Contacts) → Dashboard proxy  (Vercel function)
   ---------------------------------------------------------------------
   WHY CONTACTS, NOT OPPORTUNITIES
   In Leo's build, every reporting field (Package, Occupation, Payment,
   Visa, Enrolled Date, Package Value, Money Paid) lives at the CONTACT
   level. GHL's API also doesn't reliably return opportunity custom
   fields. So the dashboard reads from Contacts — the source of truth.

   THIS VERSION pulls ONLY enrolled customers (Contact Type = customer),
   which keeps the request small and fast on an 8,000+ contact account.
   That lights up the money core accurately: Revenue, Cash Collected,
   Packages, Occupation, Payment Type, Visa, Sales Cycle.

   Conversion / Funnel / Active Pipeline need the full LEADS set too —
   that's the next pass (handled separately to respect the time limit).

   ENV VARS (already set in Vercel): GHL_PIT, GHL_LOCATION_ID
===================================================================== */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const H = () => ({
  Authorization: `Bearer ${process.env.GHL_PIT}`,
  Version: '2021-07-28',
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

/* ---- Leo's REAL Contact-level custom field IDs ---- */
const CF = {
  occupation:   'yJ0uzdgON7RsoQyusUPz',
  package:      'eckVE6EuidBwXM8LhmVd',
  paymentType:  '3Rv02bGP9JeblbZffgU2',
  visa:         'bmNyZj5azN83VUGWQwS5',
  enrolledDate: 'zeMCO26qq8GjBUfpF2vt',
  packageValue: 'Sxxw4o4NU1GRwaK0D89R', // full package price  = booked revenue
  moneyPaid:    '2hiSUXz7RAQ7USdyb4Eb', // received so far      = cash collected
};

// Only used as a fallback if Package Value is empty on a record.
// Fill in real Gold/Diamond prices if you ever want that fallback to be exact.
const PRICE = { Silver: 1996.50, Gold: 0, Diamond: 0 };

/* ---- map GHL user IDs to readable names for the Closer chart ----
   These two IDs came back from your live data. Confirm which is which
   and edit the names below (left = user ID, right = display name). */
const USER_MAP = {
  'VAoypbyxYj8tVBFZm6pL': 'Dennis',   // <-- CONFIRM: Leo or Dennis?
  '0HG2fXecJOsjzonXIXfJ': 'Leo',      // <-- CONFIRM: Leo or Dennis?
};

const cfv = (c, id) => {
  const arr = c.customFields || c.customField || [];
  const h = arr.find(f => f.id === id);
  if (!h) return null;
  return h.value ?? h.fieldValue ?? h.field_value ?? null;
};
const toNum = v => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
};

async function searchCustomers(locationId) {
  const out = [];
  let searchAfter = null, guard = 0;
  while (guard < 80) {
    const body = {
      locationId,
      pageLimit: 100,
      // pull only enrolled customers — keeps it fast on a big contact base
      filters: [{ field: 'type', operator: 'eq', value: 'customer' }],
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST', headers: H(), body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`contacts/search ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    const batch = j.contacts || [];
    out.push(...batch);
    if (batch.length < 100) break;
    const last = batch[batch.length - 1];
    searchAfter = last && last.searchAfter ? last.searchAfter : null;
    if (!searchAfter) break;
    guard++;
  }
  return out;
}

function mapContact(c) {
  const pkg = cfv(c, CF.package) || 'Silver';
  const enrolledRaw = cfv(c, CF.enrolledDate);
  const enrolledAt = enrolledRaw ? new Date(enrolledRaw).getTime() : null;
  const created = c.dateAdded ? new Date(c.dateAdded).getTime() : null;
  const value = toNum(cfv(c, CF.packageValue)) ?? PRICE[pkg] ?? 0;
  const collected = toNum(cfv(c, CF.moneyPaid)) ?? value;
  const cycleDays = (enrolledAt && created) ? Math.round((enrolledAt - created) / 86400000) : null;
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Unknown',
    value,
    collected,
    status: 'won',            // this version pulls customers only
    stage: 'Enrolled',
    stageIdx: 4,
    package: pkg,
    occupation: cfv(c, CF.occupation) || 'Other',
    assignee: USER_MAP[c.assignedTo] || c.assignedTo || 'Unassigned',
    paymentType: cfv(c, CF.paymentType) || 'Full Payment',
    visa: cfv(c, CF.visa) || 'Other',
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

  try {
    const customers = await searchCustomers(process.env.GHL_LOCATION_ID);
    const rows = customers.map(mapContact).filter(r => !/^\(example\)/i.test(r.name));

    // small preview so visiting /api/ghl in the browser confirms the mapping
    const sample = rows.slice(0, 3).map(r => ({
      name: r.name, package: r.package, value: r.value,
      collected: r.collected, occupation: r.occupation, paymentType: r.paymentType,
    }));

    return res.status(200).json({
      rows,
      refs: [],
      count: rows.length,
      debug: { mode: 'customers-only', sample },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
