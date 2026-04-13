import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — all active players
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT * FROM players WHERE active = true ORDER BY name ASC
      `;
      return res.status(200).json({ players: rows });
    }

    // POST — add a new player (admin only)
    if (req.method === 'POST') {
      const { pin, name, factions } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      if (!name) return res.status(400).json({ error: 'Name required' });
      await sql`
        INSERT INTO players (name, factions, active)
        VALUES (${name}, ${factions || []}, true)
        ON CONFLICT (name) DO UPDATE SET factions = ${factions || []}, active = true
      `;
      return res.status(200).json({ success: true });
    }

    // PATCH — update a player (rename, update factions, deactivate)
    if (req.method === 'PATCH') {
      const { pin, id, name, factions, active } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      if (name !== undefined) await sql`UPDATE players SET name = ${name} WHERE id = ${id}`;
      if (factions !== undefined) await sql`UPDATE players SET factions = ${factions} WHERE id = ${id}`;
      if (active !== undefined) await sql`UPDATE players SET active = ${active} WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
