import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // GET -- admin sees all pending, public sees approved only
    if (req.method === 'GET') {
      const { pin } = req.query;
      const isAdmin = pin === ADMIN_PIN;
      const { rows } = isAdmin
        ? await sql`SELECT * FROM submissions ORDER BY submitted_at DESC`
        : await sql`SELECT * FROM submissions WHERE approved = true ORDER BY submitted_at DESC`;
      return res.status(200).json({ submissions: rows });
    }

    // POST -- player submits a result for admin approval
    if (req.method === 'POST') {
      const {
        player_name, event_name, event_format, faction,
        place, total_players, wins, losses, draws,
        subteam, shadow, dropped
      } = req.body;

      if (!player_name || !event_name || !event_format || !faction) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      await sql`
        INSERT INTO submissions (
          player_name, event_name, event_format, faction,
          place, total_players, wins, losses, draws,
          subteam, shadow, dropped
        )
        VALUES (
          ${player_name}, ${event_name}, ${event_format}, ${faction},
          ${place || 0}, ${total_players || 0},
          ${wins || 0}, ${losses || 0}, ${draws || 0},
          ${subteam || null}, ${shadow || false}, ${dropped || false}
        )
      `;
      return res.status(200).json({ success: true });
    }

    // PATCH -- admin approves or rejects a submission
    if (req.method === 'PATCH') {
      const { pin, id, approved } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      if (approved) {
        // Fetch the submission
        const { rows } = await sql`SELECT * FROM submissions WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ error: 'Submission not found' });
        const sub = rows[0];

        // Find or create the matching event
        const { rows: existing } = await sql`
          SELECT id, total_players FROM events
          WHERE LOWER(name) = LOWER(${sub.event_name})
          AND format = ${sub.event_format}
          LIMIT 1
        `;

        let eventId;
        if (existing.length) {
          eventId = existing[0].id;
          // Update total_players if the event was a stub (0 players) and we now have a value
          if (existing[0].total_players === 0 && sub.total_players > 0) {
            await sql`
              UPDATE events SET total_players = ${sub.total_players} WHERE id = ${eventId}
            `;
          }
        } else {
          // Create a stub event -- admin can fill in full details via Admin -> Events later
          // Use sort_date = 0 as a clear signal it needs updating (not 0 which breaks calendar)
          // Use a far-future sort_date so it doesn't corrupt calendar ordering
          const { rows: newEv } = await sql`
            INSERT INTO events (name, event_date, sort_date, format, edition, total_players, bcp_url, approved)
            VALUES (
              ${sub.event_name},
              'Date unknown',
              0,
              ${sub.event_format},
              10,
              ${sub.total_players || 0},
              '',
              true
            )
            RETURNING id
          `;
          eventId = newEv[0].id;
        }

        // Write the result into event_results
        // Preserves shadow and dropped flags from the original submission
        await sql`
          INSERT INTO event_results (
            event_id, player_name, faction, place,
            wins, losses, draws, subteam, shadow, dropped
          )
          VALUES (
            ${eventId}, ${sub.player_name}, ${sub.faction}, ${sub.place || 0},
            ${sub.wins || 0}, ${sub.losses || 0}, ${sub.draws || 0},
            ${sub.subteam || null}, ${sub.shadow || false}, ${sub.dropped || false}
          )
          ON CONFLICT DO NOTHING
        `;

        // Mark approved in submissions table
        await sql`UPDATE submissions SET approved = true WHERE id = ${id}`;

      } else {
        // Rejected -- remove from queue
        await sql`DELETE FROM submissions WHERE id = ${id}`;
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Submissions API error:', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
