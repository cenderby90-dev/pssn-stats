import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;
const TEAM_PIN = '1719';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — fetch all archived seasons
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT * FROM awards_archive ORDER BY created_at DESC
      `;
      return res.status(200).json({ archive: rows });
    }

    // POST — save a new archive entry (admin only)
    if (req.method === 'POST') {
      const { pin, label, awards } = req.body;
      if (pin !== ADMIN_PIN) {
        return res.status(401).json({ error: 'Unauthorised' });
      }
      if (!label || !awards) {
        return res.status(400).json({ error: 'Missing label or awards' });
      }
      await sql`
        INSERT INTO awards_archive (label, awards)
        VALUES (${label}, ${JSON.stringify(awards)})
      `;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
