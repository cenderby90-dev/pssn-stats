import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — fetch all events with results ──
  if (req.method === 'GET') {
    try {
      const eventsRes = await sql`
        SELECT id, name, event_date, format, edition, total_players, total_teams,
               bcp_url, approved, created_at, sort_date
        FROM events
        WHERE approved = true
        ORDER BY sort_date DESC
      `;
      const events = eventsRes.rows;

      const resultsRes = await sql`
        SELECT id, event_id, player_name, faction, place, wins, losses, draws,
               subteam, shadow, dropped, created_at
        FROM event_results
        ORDER BY place ASC
      `;

      const resultsByEvent = {};
      for (const r of resultsRes.rows) {
        if (!resultsByEvent[r.event_id]) resultsByEvent[r.event_id] = [];
        resultsByEvent[r.event_id].push(r);
      }

      for (const ev of events) {
        ev.results = resultsByEvent[ev.id] || [];
      }

      return res.status(200).json({ events });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST — create event with results ──
  if (req.method === 'POST') {
    const { pin, event, results = [] } = req.body;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const evRes = await sql`
        INSERT INTO events (name, event_date, format, edition, total_players, total_teams, bcp_url, approved, sort_date)
        VALUES (
          ${event.name},
          ${event.event_date || ''},
          ${event.format || 'GT'},
          ${event.edition || 10},
          ${event.total_players || 0},
          ${event.total_teams || 0},
          ${event.bcp_url || ''},
          true,
          ${event.sort_date}
        )
        RETURNING id
      `;
      const eventId = evRes.rows[0].id;

      for (const r of results) {
        await sql`
          INSERT INTO event_results (event_id, player_name, faction, place, wins, losses, draws, subteam, shadow, dropped)
          VALUES (
            ${eventId},
            ${r.player_name},
            ${r.faction || ''},
            ${r.place || 0},
            ${r.wins || 0},
            ${r.losses || 0},
            ${r.draws || 0},
            ${r.subteam || null},
            ${r.shadow || false},
            ${r.dropped || false}
          )
        `;
      }

      return res.status(200).json({ success: true, eventId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH — update a single result row ──
  if (req.method === 'PATCH') {
    const { pin, resultId, updates } = req.body;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await sql`
        UPDATE event_results SET
          faction  = COALESCE(${updates.faction ?? null},  faction),
          wins     = COALESCE(${updates.wins    ?? null},  wins),
          losses   = COALESCE(${updates.losses  ?? null},  losses),
          draws    = COALESCE(${updates.draws   ?? null},  draws),
          place    = COALESCE(${updates.place   ?? null},  place),
          dropped  = COALESCE(${updates.dropped ?? null},  dropped),
          shadow   = COALESCE(${updates.shadow  ?? null},  shadow),
          subteam  = COALESCE(${updates.subteam ?? null},  subteam)
        WHERE id = ${resultId}
      `;
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE — remove an event and all its results ──
  if (req.method === 'DELETE') {
    const { pin, eventId } = req.body;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await sql`DELETE FROM event_results WHERE event_id = ${eventId}`;
      await sql`DELETE FROM events WHERE id = ${eventId}`;
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
