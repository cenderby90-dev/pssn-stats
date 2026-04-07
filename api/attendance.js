import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { rows } = await sql`SELECT * FROM attendance`;
      return res.status(200).json({ attendance: rows });
    }

    if (req.method === 'POST') {
      const { player_name, event_sort_date, status } = req.body;
      if (!player_name || event_sort_date === undefined || event_sort_date === null || !status) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      // Cast event_sort_date to integer explicitly
      const sortDateInt = parseInt(event_sort_date, 10);
      if (isNaN(sortDateInt)) {
        return res.status(400).json({ error: 'event_sort_date must be a number' });
      }
      await sql`
        INSERT INTO attendance (player_name, event_sort_date, status)
        VALUES (${player_name}, ${sortDateInt}, ${status})
        ON CONFLICT (player_name, event_sort_date)
        DO UPDATE SET status = ${status}, updated_at = NOW()
      `;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { player_name, event_sort_date } = req.body;
      const sortDateInt = parseInt(event_sort_date, 10);
      await sql`
        DELETE FROM attendance
        WHERE player_name = ${player_name}
        AND event_sort_date = ${sortDateInt}
      `;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
