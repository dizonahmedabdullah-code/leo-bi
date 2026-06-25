/* =====================================================================
   /api/ghl.js  —  GHL (Leads pipeline opportunities) → Dashboard proxy
   ---------------------------------------------------------------------
   ARCHITECTURE (single pipeline)
   The funnel, conversion and active pipeline now read from the
   "Leo Le Education Leads" pipeline opportunities — using each
   opportunity's NATIVE fields, which the GHL API returns reliably:
     • Stage   -> funnel position
     • Status  -> won / open / lost  (conversion + active pipeline)
     • Value   -> revenue (monetaryValue)

   The dimensional fields (Occupation, Package, Payment, Visa) live at
   the CONTACT level, so for WON deals we join to the matching customer
   contact to enrich those breakdowns. The won set is small, so this
   stays well inside Vercel's 10s function limit.

   ENV VARS (already set in Vercel): GHL_PIT, GHL_LOCATION_ID
===================================================================== */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Leo Le Education Leads';

const H = () => ({
  Authorization: `Bearer ${process.env.GHL_PIT}`,
  Version: '2021-07-28',
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

/* ---- Leo's REAL Contact-level custom field IDs (for won-deal join) ---- */
const CF = {
  occupation:   'yJ0uzdgON7RsoQyusUPz',
  package:      'eckVE6EuidBwXM8LhmVd',
  paymentType:  '3Rv02bGP9JeblbZffgU2',
  visa:         'bmNyZj5azN83VUGWQwS5',
  enrolledDate: 'zeMCO26qq8GjBUfpF2vt',
  packageValue: 'Sxxw4o4NU1GRwaK0D89R',
  moneyPaid:    '2hiSUXz7RAQ7USdyb4Eb',
};

/* ---- map GHL user IDs to readable names for the Closer chart ---- */
const USER_MAP = {
  'VAoypbyxYj8tVBFZm6pL': 'Dennis',
  '0HG2fXecJOsjzonXIXfJ': 'Leo',
};

/* ---- stage name -> funnel index (matches front-end STAGES) ----
   Cancelled is a parking stage; its cards carry Status = lost, so the
   conversion / revenue / active KPIs exclude them automatically. */
const STAGE_IDX = {
  'New Lead': 0,
  'Engaged': 1,
  'Consultation Booked': 2,
  'Purchased': 3,
  'Cancelled': 3,
};

const mapStatus = s => {
  const v = String(s || '').toLowerCase();
  if (v === 'won') return 'won';
  if (v === 'lost' || v === 'abandoned') return 'lost';
  return 'open';
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
const ts = v => (v ? new Date(v).getTime() : null);

/* ---- 1) find the Leads pipeline + its stage id->name map ---- */
async function getLeadsPipeline(loc) {
  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${loc}`, { headers: H() });
  if (!res.ok) throw new Error(`pipelines ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const pipe = (j.pipelines || []).find(p => p.name === PIPELINE_NAME);
  if (!pipe) throw new Error(`Pipeline "${PIPELINE_NAME}" not found`);
  const stageMap = {};
  (pipe.stages || []).forEach(s => { stageMap[s.id] = s.name; });
  return { id: pipe.id, stageMap };
}

/* ---- 2) pull every opportunity in the Leads pipeline (cursor paged) ---- */
async function getOpps(loc, pipelineId) {
  const out = [];
  let startAfter = null, startAfterId = null, guard = 0;
  while (guard < 30) {
    let url = `${GHL_BASE}/opportunities/search?location_id=${loc}&pipeline_id=${pipelineId}&limit=100`;
    if (startAfterId) url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    const res = await fetch(url, { headers: H() });
    if (!res.ok) throw new Error(`opportunities/search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const batch = j.opportunities || [];
    out.push(...batch);
    const meta = j.meta || {};
    if (batch.length < 100 || !meta.startAfterId) break;
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
    guard++;
  }
  return out;
}

/* ---- 3) pull enrolled customers once, keyed by contactId (for won join) ---- */
async function getCustomerMap(loc) {
  const map = {};
  let searchAfter = null, guard = 0;
  while (guard < 80) {
    const body = {
      locationId: loc,
      pageLimit: 100,
      filters: [{ field: 'type', operator: 'eq', value: 'customer' }],
    };
    if (searchAfter) body.searchAfter = searchAfter;
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST', headers: H(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`contacts/search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const batch = j.contacts || [];
    batch.forEach(c => { map[c.id] = c; });
    if (batch.length < 100) break;
    const last = batch[batch.length - 1];
    searchAfter = last && last.searchAfter ? last.searchAfter : null;
    if (!searchAfter) break;
    guard++;
  }
  return map;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!process.env.GHL_PIT || !process.env.GHL_LOCATION_ID) {
    return res.status(500).json({ error: 'Missing GHL_PIT or GHL_LOCATION_ID env vars' });
  }
  const loc = process.env.GHL_LOCATION_ID;

  try {
    const { id: pipelineId, stageMap } = await getLeadsPipeline(loc);
    const [opps, custMap] = await Promise.all([getOpps(loc, pipelineId), getCustomerMap(loc)]);

    const rows = opps.map(o => {
      const stageName = stageMap[o.pipelineStageId] || 'New Lead';
      const stageIdx = STAGE_IDX[stageName] ?? 0;
      const status = mapStatus(o.status);
      const contactId = o.contactId || (o.contact && o.contact.id) || null;
      const created = ts(o.createdAt);
      const value = toNum(o.monetaryValue) ?? 0;

      const row = {
        id: o.id,
        name: o.name || 'Unknown',
        value,
        collected: status === 'won' ? value : 0,
        status,
        stage: stageName,
        stageIdx,
        package: null,
        occupation: null,
        assignee: USER_MAP[o.assignedTo] || o.assignedTo || 'Unassigned',
        paymentType: null,
        visa: null,
        createdAt: created,
        enrolledAt: null,
        cycleDays: null,
      };

      // enrich WON deals with contact-level dimensions
      if (status === 'won' && contactId && custMap[contactId]) {
        const c = custMap[contactId];
        const pkg = cfv(c, CF.package) || 'Silver';
        const enrolledAt = ts(cfv(c, CF.enrolledDate));
        const collected = toNum(cfv(c, CF.moneyPaid)) ?? value;
        row.package = pkg;
        row.occupation = cfv(c, CF.occupation) || 'Other';
        row.paymentType = cfv(c, CF.paymentType) || 'Full Payment';
        row.visa = cfv(c, CF.visa) || 'Other';
        row.collected = collected;
        row.enrolledAt = enrolledAt;
        row.cycleDays = (enrolledAt && created) ? Math.round((enrolledAt - created) / 86400000) : null;
      }
      return row;
    }).filter(r => !/^\(example\)/i.test(r.name));

    const won = rows.filter(r => r.status === 'won');
    const debug = {
      mode: 'leads-pipeline',
      totalOpps: rows.length,
      byStatus: {
        won: won.length,
        open: rows.filter(r => r.status === 'open').length,
        lost: rows.filter(r => r.status === 'lost').length,
      },
      revenueWon: won.reduce((s, r) => s + r.value, 0),
      sampleWon: won.slice(0, 5).map(r => ({ name: r.name, value: r.value, occupation: r.occupation, package: r.package })),
    };

    return res.status(200).json({
      rows,
      refs: [],
      count: rows.length,
      debug,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
