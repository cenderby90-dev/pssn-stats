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
    if (req.method === 'GET') {
      const { rows } = await sql`SELECT * FROM player_profiles`;
      return res.status(200).json({ players: rows });
    }
    if (req.method === 'POST') {
      const { pin, player_name, bio, photo_url } = req.body;
      if (pin !== ADMIN_PIN) {
        return res.status(401).json({ error: 'Unauthorised' });
      }
      await sql`
        INSERT INTO player_profiles (player_name, bio, photo_url)
        VALUES (${player_name}, ${bio || null}, ${photo_url || null})
        ON CONFLICT (player_name)
        DO UPDATE SET bio = ${bio || null}, photo_url = ${photo_url || null}, updated_at = NOW()
      `;
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
