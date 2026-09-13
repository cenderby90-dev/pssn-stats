import { sql } from '@vercel/postgres';
import { checkPin } from './_pinAuth.js';

const ADMIN_PIN = process.env.ADMIN_PIN;

// See api/submissions.js for why this exists -- applied here too since the result-editor's
// faction field is now free text, and it's cheap insurance even though this endpoint is
// PIN-gated.
const stripTags = (s) => typeof s === 'string' ? s.replace(/[<>]/g, '').slice(0, 200) : s;

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
               bcp_url, approved, created_at, sort_date, end_sort_date
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
    const auth = await checkPin(req, pin, [ADMIN_PIN]);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const evRes = await sql`
        INSERT INTO events (name, event_date, format, edition, total_players, total_teams, bcp_url, approved, sort_date, end_sort_date)
        VALUES (
          ${stripTags(event.name)},
          ${stripTags(event.event_date) || ''},
          ${event.format || 'GT'},
          ${event.edition || 11},
          ${event.total_players || 0},
          ${event.total_teams || 0},
          ${stripTags(event.bcp_url) || ''},
          true,
          ${event.sort_date},
          ${event.end_sort_date || event.sort_date}
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
            ${stripTags(r.faction) || ''},
            ${r.place || 0},
            ${r.wins || 0},
            ${r.losses || 0},
            ${r.draws || 0},
            ${stripTags(r.subteam) || null},
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

  // ── PATCH — update a result row or event metadata ──
  if (req.method === 'PATCH') {
    const { pin, resultId, eventId, updates } = req.body;
    const auth = await checkPin(req, pin, [ADMIN_PIN]);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    // Patch a result row
    if (resultId) {
      try {
        await sql`
          UPDATE event_results SET
            player_name = COALESCE(${updates.player_name ?? null}, player_name),
            faction   = COALESCE(${stripTags(updates.faction) ?? null}, faction),
            wins      = COALESCE(${updates.wins      ?? null}, wins),
            losses    = COALESCE(${updates.losses    ?? null}, losses),
            draws     = COALESCE(${updates.draws     ?? null}, draws),
            place     = COALESCE(${updates.place     ?? null}, place),
            dropped   = COALESCE(${updates.dropped   ?? null}, dropped),
            shadow    = COALESCE(${updates.shadow    ?? null}, shadow),
            subteam   = COALESCE(${stripTags(updates.subteam) ?? null}, subteam)
          WHERE id = ${resultId}
        `;
        return res.status(200).json({ success: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Patch event metadata (name, date, format etc)
    if (eventId) {
      try {
        await sql`
          UPDATE events SET
            name         = COALESCE(${stripTags(updates.name) ?? null}, name),
            event_date   = COALESCE(${stripTags(updates.event_date) ?? null}, event_date),
            format       = COALESCE(${updates.format       ?? null}, format),
            sort_date    = COALESCE(${updates.sort_date    ?? null}, sort_date),
            end_sort_date = COALESCE(${updates.end_sort_date ?? null}, end_sort_date),
            total_players = COALESCE(${updates.total_players ?? null}, total_players),
            total_teams  = COALESCE(${updates.total_teams  ?? null}, total_teams),
            bcp_url      = COALESCE(${stripTags(updates.bcp_url) ?? null}, bcp_url),
            edition      = COALESCE(${updates.edition      ?? null}, edition)
          WHERE id = ${eventId}
        `;
        return res.status(200).json({ success: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'resultId or eventId required' });
  }

  // ── DELETE — remove a single result, or an event and all its results ──
  if (req.method === 'DELETE') {
    const { pin, eventId, resultId } = req.body;
    const auth = await checkPin(req, pin, [ADMIN_PIN]);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      if (resultId) {
        await sql`DELETE FROM event_results WHERE id = ${resultId}`;
        return res.status(200).json({ success: true });
      }
      if (eventId) {
        await sql`DELETE FROM event_results WHERE event_id = ${eventId}`;
        await sql`DELETE FROM events WHERE id = ${eventId}`;
        return res.status(200).json({ success: true });
      }
      return res.status(400).json({ error: 'resultId or eventId required' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
