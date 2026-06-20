/* =====================================================================
   /api/fields.js  —  Custom Field ID finder  (visit in your browser)
   ---------------------------------------------------------------------
   PURPOSE
   After you've deployed and set GHL_PIT + GHL_LOCATION_ID, just open
       https://YOUR-SITE.vercel.app/api/fields
   in your browser. It prints every custom field with:
       • its NAME      (what you see in GHL)
       • its ID        (what you paste into api/ghl.js)
       • its OBJECT    (Contact or Opportunity — the level it lives at)

   The OBJECT column is the important one: a field built at Contact level
   will NOT show up on Opportunity-based reports. If Occupation reads
   "Contact" here, that's the architecture flag to fix before going live.

   This file is a convenience. Once you've copied the IDs you can delete
   it from the repo if you want — it's not needed by the dashboard.
===================================================================== */

const GHL_BASE = 'https://services.leadconnectorhq.com';

export default async function handler(req, res) {
  if (!process.env.GHL_PIT || !process.env.GHL_LOCATION_ID) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send('<h2 style="font-family:sans-serif">Missing GHL_PIT or GHL_LOCATION_ID environment variables. Set them in Vercel → Settings → Environment Variables, then redeploy.</h2>');
  }

  const headers = {
    Authorization: `Bearer ${process.env.GHL_PIT}`,
    Version: '2021-07-28',
    Accept: 'application/json',
  };

  try {
    const url = `${GHL_BASE}/locations/${process.env.GHL_LOCATION_ID}/customFields`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`GHL ${r.status}: ${body.slice(0, 400)}`);
    }
    const json = await r.json();
    const fields = json.customFields || [];

    const rows = fields.map(f => {
      const model = f.model || f.objectType || 'unknown'; // 'contact' | 'opportunity'
      const isOpp = String(model).toLowerCase().includes('opportunit');
      const color = isOpp ? '#00A862' : '#C77700';
      return `<tr>
        <td style="font-weight:600">${f.name || ''}</td>
        <td><code style="background:#eef;padding:2px 6px;border-radius:4px">${f.id || ''}</code></td>
        <td style="color:${color};font-weight:700;text-transform:capitalize">${model}</td>
        <td style="color:#666">${f.dataType || f.fieldType || ''}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>GHL Custom Fields</title>
      <style>
        body{ font-family:-apple-system,sans-serif; max-width:900px; margin:40px auto; padding:0 20px; color:#1a1a2e; }
        h1{ font-size:22px; } p{ color:#555; line-height:1.5; }
        table{ width:100%; border-collapse:collapse; margin-top:20px; font-size:14px; }
        th{ text-align:left; padding:10px; border-bottom:2px solid #ddd; font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:#888; }
        td{ padding:10px; border-bottom:1px solid #eee; }
        tr:hover td{ background:#fafaff; }
        .legend{ background:#fff8e6; border:1px solid #ffe1a6; padding:12px 16px; border-radius:8px; margin-top:16px; font-size:13px; }
      </style></head><body>
      <h1>GHL Custom Fields — ${fields.length} found</h1>
      <p>Copy the <b>ID</b> of each field you need into the <code>CF</code> block in <code>api/ghl.js</code>.</p>
      <div class="legend"><b>Object column:</b> fields marked <b style="color:#00A862">opportunity</b> work on the sales reports. Anything you need for reporting that shows <b style="color:#C77700">contact</b> must be added at the Opportunity level first.</div>
      <table>
        <thead><tr><th>Field Name</th><th>ID (copy this)</th><th>Object Level</th><th>Type</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </body></html>`;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(502).send(`<h2 style="font-family:sans-serif;color:#c00">Error: ${err.message}</h2><p style="font-family:sans-serif">If this is a 401, the token is wrong or was rotated. If 403, the Private Integration is missing the custom-fields read scope.</p>`);
  }
}
