import { sql } from '@vercel/postgres';
import { checkPin } from './_pinAuth.js';

const ADMIN_PIN = process.env.ADMIN_PIN;

// Strips characters needed to form an HTML tag. This endpoint requires no PIN at all --
// it's the only fully public, unauthenticated write path on the site -- so any free-text
// field here (event_name, subteam) must never be stored capable of injecting markup.
// Stripped rather than entity-encoded so it stays simple plain text everywhere it's later
// rendered, without needing to touch every render site across the codebase.
const stripTags = (s) => typeof s === 'string' ? s.replace(/[<>]/g, '').slice(0, 200) : s;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // GET -- admin sees all pending, public sees approved only. A pin is optional here
    // (plain public reads pass none at all) -- only rate-limit actual guesses, and fall
    // back to the public view on a wrong one rather than erroring the whole request.
    if (req.method === 'GET') {
      const { pin } = req.query;
      let isAdmin = false;
      if (pin) {
        const auth = await checkPin(req, pin, [ADMIN_PIN]);
        if (auth.ok) isAdmin = true;
        else if (auth.status === 429) return res.status(429).json({ error: auth.error });
      }
      const { rows } = isAdmin
        ? await sql`SELECT * FROM submissions ORDER BY submitted_at DESC`
        : await sql`SELECT * FROM submissions WHERE approved = true ORDER BY submitted_at DESC`;
      return res.status(200).json({ submissions: rows });
    }

    // POST -- player submits a result for admin approval
    if (req.method === 'POST') {
      const {
        player_name, event_format, faction,
        place, total_players, wins, losses, draws,
        shadow, dropped, edition, sort_date
      } = req.body;
      const event_name = stripTags(req.body.event_name);
      const subteam = stripTags(req.body.subteam);

      if (!player_name || !event_name || !event_format || !faction) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      await sql`
        INSERT INTO submissions (
          player_name, event_name, event_format, faction,
          place, total_players, wins, losses, draws,
          subteam, shadow, dropped, edition, sort_date
        )
        VALUES (
          ${player_name}, ${event_name}, ${event_format}, ${faction},
          ${place || 0}, ${total_players || 0},
          ${wins || 0}, ${losses || 0}, ${draws || 0},
          ${subteam || null}, ${shadow || false}, ${dropped || false},
          ${edition || null}, ${sort_date || null}
        )
      `;
      return res.status(200).json({ success: true });
    }

    // PATCH -- admin approves or rejects a submission
    if (req.method === 'PATCH') {
      const { pin, id, approved } = req.body;
      const auth = await checkPin(req, pin, [ADMIN_PIN]);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

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
          // Falls back to the currently-active edition and today's date if the client
          // didn't supply one (e.g. an older cached page) -- previously this was hardcoded
          // to edition 10 / sort_date 0, which silently hid the event from the default view.
          const fallbackSortDate = parseInt(new Date().toISOString().slice(0,10).replace(/-/g,''), 10);
          const { rows: newEv } = await sql`
            INSERT INTO events (name, event_date, sort_date, format, edition, total_players, bcp_url, approved)
            VALUES (
              ${sub.event_name},
              'Date unknown',
              ${sub.sort_date || fallbackSortDate},
              ${sub.event_format},
              ${sub.edition || 11},
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
