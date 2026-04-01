import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;
const TEAM_PIN = '1719';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — fetch all approved events with their results
    if (req.method === 'GET') {
      const { rows: events } = await sql`
        SELECT * FROM events ORDER BY sort_date DESC
      `;
      const { rows: results } = await sql`
        SELECT * FROM event_results ORDER BY placing ASC
      `;
      // attach results to events
      const eventsWithResults = events.map(ev => ({
        ...ev,
        results: results.filter(r => r.event_id === ev.id)
      }));
      return res.status(200).json({ events: eventsWithResults });
    }

    // POST — create a new event with results (admin only)
    if (req.method === 'POST') {
      const { pin, event, results } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      if (!event || !event.name) return res.status(400).json({ error: 'Missing event data' });

      const { rows } = await sql`
        INSERT INTO events (name, event_date, sort_date, format, edition, total_players, total_teams, bcp_url, approved)
        VALUES (
          ${event.name},
          ${event.event_date},
          ${event.sort_date},
          ${event.format},
          ${event.edition || 10},
          ${event.total_players || 0},
          ${event.total_teams || 0},
          ${event.bcp_url || ''},
          true
        )
        RETURNING id
      `;
      const eventId = rows[0].id;

      // insert results
      if (results && results.length) {
        for (const r of results) {
          await sql`
            INSERT INTO event_results (event_id, player_name, faction, placing, wins, losses, draws, subteam, shadow, dropped)
            VALUES (
              ${eventId},
              ${r.player_name},
              ${r.faction},
              ${r.placing || 0},
              ${r.wins || 0},
              ${r.losses || 0},
              ${r.draws || 0},
              ${r.subteam || null},
              ${r.shadow || false},
              ${r.dropped || false}
            )
          `;
        }
      }
      return res.status(200).json({ success: true, eventId });
    }

    // DELETE — remove an event and all its results (admin only)
    if (req.method === 'DELETE') {
      const { pin, eventId } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      await sql`DELETE FROM events WHERE id = ${eventId}`;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
