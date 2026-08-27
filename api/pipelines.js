const GHL_BASE = 'https://services.leadconnectorhq.com';
export default async function handler(req, res) {
  const headers = {
    Authorization: `Bearer ${process.env.GHL_PIT}`,
    Version: '2021-07-28',
    Accept: 'application/json',
  };
  try {
    const url = `${GHL_BASE}/opportunities/pipelines?locationId=${process.env.GHL_LOCATION_ID}`;
    const r = await fetch(url, { headers });
    const json = await r.json();
    const out = (json.pipelines || []).map(p => ({
      name: p.name,
      id: p.id,
      stages: (p.stages || []).map(s => s.name),
    }));
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(out, null, 2));
  } catch (e) {
    res.status(500).send(String(e));
  }
}
