import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;
const TEAM_PIN = '1719';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // GET — fetch active season with pods, players and games
    if (req.method === 'GET') {
      const { rows: seasons } = await sql`
        SELECT * FROM league_seasons WHERE active = true ORDER BY id DESC LIMIT 1
      `;
      if (!seasons.length) return res.status(200).json({ season: null });
      const season = seasons[0];

      const { rows: pods } = await sql`
        SELECT * FROM league_pods WHERE season_id = ${season.id} ORDER BY pod_number
      `;
      const { rows: players } = await sql`
        SELECT lpp.*, lp.pod_number FROM league_pod_players lpp
        JOIN league_pods lp ON lpp.pod_id = lp.id
        WHERE lp.season_id = ${season.id}
      `;
      const { rows: games } = await sql`
        SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = true ORDER BY created_at
      `;
      const { rows: pending } = await sql`
        SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC
      `;
      const { rows: archive } = await sql`
        SELECT id, label, created_at FROM league_archive ORDER BY created_at DESC
      `;

      return res.status(200).json({ season, pods, players, games, pending, archive });
    }

    // POST — submit a game result
    if (req.method === 'POST') {
      const { pin, pod_id, player1, player2, bp1, bp2 } = req.body;
      if (!pin || pin !== TEAM_PIN && pin !== ADMIN_PIN) {
        return res.status(401).json({ error: 'Unauthorised' });
      }
      if (!pod_id || !player1 || !player2 || bp1 === undefined || bp2 === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // get season_id from pod
      const { rows: pods } = await sql`SELECT season_id FROM league_pods WHERE id = ${pod_id}`;
      if (!pods.length) return res.status(400).json({ error: 'Pod not found' });
      const season_id = pods[0].season_id;

      // admin goes live immediately, team goes to approval queue
      const approved = pin === ADMIN_PIN;

      await sql`
        INSERT INTO league_games (season_id, pod_id, player1, player2, bp1, bp2, approved)
        VALUES (${season_id}, ${pod_id}, ${player1}, ${player2}, ${bp1}, ${bp2}, ${approved})
      `;
      return res.status(200).json({ success: true, approved });
    }

    // PATCH — approve or reject a pending game (admin only)
    if (req.method === 'PATCH') {
      const { pin, gameId, approved } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      if (approved) {
        await sql`UPDATE league_games SET approved = true WHERE id = ${gameId}`;
      } else {
        await sql`DELETE FROM league_games WHERE id = ${gameId}`;
      }
      return res.status(200).json({ success: true });
    }

    // PUT — create a new season with pods and players (admin only)
    if (req.method === 'PUT') {
      const { pin, name, pods } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      // deactivate current season
      await sql`UPDATE league_seasons SET active = false`;

      // create new season
      const { rows } = await sql`
        INSERT INTO league_seasons (name, active) VALUES (${name}, true) RETURNING id
      `;
      const seasonId = rows[0].id;

      // create pods and players
      for (const pod of pods) {
        const { rows: podRows } = await sql`
          INSERT INTO league_pods (season_id, pod_number, name)
          VALUES (${seasonId}, ${pod.number}, ${pod.name}) RETURNING id
        `;
        const podId = podRows[0].id;
        for (const player of pod.players) {
          await sql`
            INSERT INTO league_pod_players (pod_id, player_name)
            VALUES (${podId}, ${player})
          `;
        }
      }
      return res.status(200).json({ success: true, seasonId });
    }

    // DELETE — archive current season and reset (admin only)
    if (req.method === 'DELETE') {
      const { pin, label, snapshot } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      // save archive snapshot
      await sql`
        INSERT INTO league_archive (label, data)
        VALUES (${label}, ${JSON.stringify(snapshot)})
      `;

      // deactivate season
      await sql`UPDATE league_seasons SET active = false`;

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
