import { sql } from '@vercel/postgres';

const ADMIN_PIN = '1719';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — fetch submissions (approved only unless admin PIN provided)
    if (req.method === 'GET') {
      const { pin } = req.query;
      const isAdmin = pin === ADMIN_PIN;
      const { rows } = isAdmin
        ? await sql`SELECT * FROM submissions ORDER BY submitted_at DESC`
        : await sql`SELECT * FROM submissions WHERE approved = true ORDER BY submitted_at DESC`;
      return res.status(200).json({ submissions: rows });
    }

    // POST — submit a new result
    if (req.method === 'POST') {
      const { player_name, event_name, event_format, faction, place, total_players, wins, losses, draws, subteam } = req.body;
      if (!player_name || !event_name || !event_format || !faction) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      await sql`
        INSERT INTO submissions (player_name, event_name, event_format, faction, place, total_players, wins, losses, draws, subteam)
        VALUES (${player_name}, ${event_name}, ${event_format}, ${faction}, ${place}, ${total_players}, ${wins || 0}, ${losses || 0}, ${draws || 0}, ${subteam || null})
      `;
      return res.status(200).json({ success: true });
    }

    // PATCH — approve or reject a submission (admin only)
    if (req.method === 'PATCH') {
      const { pin, id, approved } = req.body;
      if (pin !== ADMIN_PIN) {
        return res.status(401).json({ error: 'Unauthorised' });
      }
      await sql`
        UPDATE submissions SET approved = ${approved} WHERE id = ${id}
      `;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
