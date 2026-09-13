import { sql } from '@vercel/postgres';
import { checkPin } from './_pinAuth.js';

const ADMIN_PIN = process.env.ADMIN_PIN;
const TEAM_PIN = '1719';
const stripTags = (s) => typeof s === 'string' ? s.replace(/[<>]/g, '').slice(0, 200) : s;

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
      const auth = await checkPin(req, pin, [ADMIN_PIN]);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      if (!label || !awards) {
        return res.status(400).json({ error: 'Missing label or awards' });
      }
      await sql`
        INSERT INTO awards_archive (label, awards)
        VALUES (${stripTags(label)}, ${JSON.stringify(awards)})
      `;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
