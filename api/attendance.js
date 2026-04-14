import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;
const TEAM_PIN  = process.env.TEAM_PIN;   // add TEAM_PIN=1719 to Vercel env vars

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — read all attendance data (public read is fine for a private group site)
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT player_name, event_sort_date, status, updated_at
        FROM attendance
        ORDER BY event_sort_date ASC
      `;
      // Return as key-value map: { "PlayerName_20260411": "yes", ... }
      const data = {};
      rows.forEach(r => {
        const key = `${r.player_name}_${r.event_sort_date}`;
        data[key] = r.status;
      });
      return res.status(200).json(data);
    }

    // POST — write attendance, corrections, team data
    // Requires either team PIN or admin PIN
    if (req.method === 'POST') {
      const { player_name, event_sort_date, status, pin } = req.body;

      // PIN check — accept team PIN or admin PIN
      // Metadata keys (corrections, pending events, team data, CoS optins) require valid PIN
      // Regular attendance (player_SORTDATE keys) also require valid PIN
      const validPin = (TEAM_PIN && pin === TEAM_PIN) || (ADMIN_PIN && pin === ADMIN_PIN);

      // For metadata keys, always require a valid PIN
      const isMetaKey = typeof player_name === 'string' && (
        player_name.startsWith('_corr_') ||
        player_name.startsWith('_pending_event_') ||
        player_name.startsWith('_teams_') ||
        player_name.startsWith('_team_registry_') ||
        player_name === player_name.match(/^[A-Za-z0-9 '-]+$/) ? null : player_name
      );

      // Simple rule: all writes require a valid PIN
      if (!validPin) {
        return res.status(401).json({ error: 'Unauthorised — valid PIN required to write attendance data' });
      }

      if (!player_name || event_sort_date === undefined || !status) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      await sql`
        INSERT INTO attendance (player_name, event_sort_date, status, updated_at)
        VALUES (${player_name}, ${event_sort_date}, ${status}, NOW())
        ON CONFLICT (player_name, event_sort_date)
        DO UPDATE SET status = ${status}, updated_at = NOW()
      `;
      return res.status(200).json({ success: true });
    }

    // DELETE — remove attendance record
    if (req.method === 'DELETE') {
      const { player_name, event_sort_date, pin } = req.body;

      const validPin = (TEAM_PIN && pin === TEAM_PIN) || (ADMIN_PIN && pin === ADMIN_PIN);
      if (!validPin) {
        return res.status(401).json({ error: 'Unauthorised — valid PIN required' });
      }

      await sql`
        DELETE FROM attendance
        WHERE player_name = ${player_name} AND event_sort_date = ${event_sort_date}
      `;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
