import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;
const TEAM_PIN = '1719';

function calcSeedings(pods, players, games) {
  const podResults = pods.map(pod => {
    const podPlayers = players.filter(p => p.pod_id === pod.id).map(p => p.player_name);
    const podGames = games.filter(g => g.pod_id === pod.id);
    const standings = {};
    podPlayers.forEach(n => { standings[n] = { name: n, pts: 0, bp: 0, played: 0 }; });
    podGames.forEach(g => {
      if (!standings[g.player1]) standings[g.player1] = { name: g.player1, pts: 0, bp: 0, played: 0 };
      if (!standings[g.player2]) standings[g.player2] = { name: g.player2, pts: 0, bp: 0, played: 0 };
      standings[g.player1].bp += g.bp1; standings[g.player2].bp += g.bp2;
      standings[g.player1].played++; standings[g.player2].played++;
      if (g.bp1 > g.bp2) standings[g.player1].pts += 2;
      else if (g.bp2 > g.bp1) standings[g.player2].pts += 2;
      else { standings[g.player1].pts++; standings[g.player2].pts++; }
    });
    const sorted = Object.values(standings).sort((a, b) => b.pts - a.pts || b.bp - a.bp);
    return { pod: pod.name, podId: pod.id, winner: sorted[0], runnerUp: sorted[1] };
  });
  const winners = podResults.map(p => ({ ...p.winner, pod: p.pod })).sort((a, b) => b.bp - a.bp);
  const runnersUp = podResults.map(p => ({ ...p.runnerUp, pod: p.pod })).sort((a, b) => b.bp - a.bp);
  return {
    byeWinners: winners.slice(0, 4),
    qfWinners: winners.slice(4, 6),
    runnersUp,
    bracket: {
      QF1: { p1: runnersUp[0], p2: runnersUp[5] },
      QF2: { p1: runnersUp[1], p2: runnersUp[4] },
      QF3: { p1: runnersUp[2], p2: runnersUp[3] },
      QF4: { p1: winners[4], p2: winners[5] },
      SF1: { p1: winners[0], p2: null },
      SF2: { p1: winners[1], p2: null },
      SF3: { p1: winners[2], p2: null },
      SF4: { p1: winners[3], p2: null },
      F1: { p1: null, p2: null },
      F2: { p1: null, p2: null },
      GF: { p1: null, p2: null },
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // ── GET ──
    if (req.method === 'GET') {
      const { rows: seasons } = await sql`SELECT * FROM league_seasons WHERE active = true ORDER BY id DESC LIMIT 1`;
      if (!seasons.length) return res.status(200).json({ season: null });
      const season = seasons[0];

      const [{ rows: pods }, { rows: players }, { rows: games }, { rows: pending },
             { rows: playoffs }, { rows: pendingPlayoffs }, { rows: archive },
             { rows: allPlayers }] = await Promise.all([
        sql`SELECT * FROM league_pods WHERE season_id = ${season.id} ORDER BY pod_number`,
        sql`SELECT lpp.*, lp.pod_number FROM league_pod_players lpp JOIN league_pods lp ON lpp.pod_id = lp.id WHERE lp.season_id = ${season.id}`,
        sql`SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = true ORDER BY created_at`,
        sql`SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC`,
        sql`SELECT * FROM league_playoff_matches WHERE season_id = ${season.id} AND approved = true ORDER BY round, match_number`,
        sql`SELECT * FROM league_playoff_matches WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC`,
        sql`SELECT id, label, data, created_at FROM league_archive ORDER BY created_at DESC`,
        sql`SELECT * FROM league_players ORDER BY name`,
      ]);

      const seedings = calcSeedings(pods, players, games);

      // Overlay playoff results
      const bracket = seedings.bracket;
      playoffs.forEach(m => {
        const key = `${m.round}${m.match_number}`;
        if (bracket[key]) { bracket[key].bp1 = m.bp1; bracket[key].bp2 = m.bp2; bracket[key].winner = m.winner; }
        const winner = m.winner;
        if (m.round === 'QF') { const sfKey = `SF${m.match_number}`; if (bracket[sfKey]) bracket[sfKey].p2 = { name: winner }; }
        if (m.round === 'SF') {
          const fKey = m.match_number <= 2 ? 'F1' : 'F2';
          const slot = m.match_number % 2 === 1 ? 'p1' : 'p2';
          if (bracket[fKey]) bracket[fKey][slot] = { name: winner };
        }
        if (m.round === 'F') { const slot = m.match_number === 1 ? 'p1' : 'p2'; if (bracket['GF']) bracket['GF'][slot] = { name: winner }; }
      });

      return res.status(200).json({ season, pods, players, games, pending, playoffs, pendingPlayoffs, seedings, bracket, archive, allPlayers });
    }

// Regular league game
const { pod_id, player1, player2, bp1, bp2 } = req.body;
if (!pod_id || !player1 || !player2 || bp1 === undefined || bp2 === undefined)
  return res.status(400).json({ error: 'Missing required fields' });

// BP validation — must be 0-100
if (bp1 < 0 || bp1 > 100 || bp2 < 0 || bp2 > 100)
  return res.status(400).json({ error: 'Battle Points must be between 0 and 100' });

const { rows: pods } = await sql`SELECT season_id FROM league_pods WHERE id = ${pod_id}`;
if (!pods.length) return res.status(400).json({ error: 'Pod not found' });

// Pod membership check — both players must be in this pod
const { rows: members } = await sql`
  SELECT player_name FROM league_pod_players WHERE pod_id = ${pod_id}`;
const memberNames = members.map(m => m.player_name);
if (!memberNames.includes(player1))
  return res.status(400).json({ error: `${player1} is not in this pod` });
if (!memberNames.includes(player2))
  return res.status(400).json({ error: `${player2} is not in this pod` });

// Duplicate check
const { rows: dupes } = await sql`
  SELECT id FROM league_games 
  WHERE pod_id = ${pod_id} AND approved = true
  AND (
    (player1 = ${player1} AND player2 = ${player2}) OR
    (player1 = ${player2} AND player2 = ${player1})
  )`;
if (dupes.length) return res.status(400).json({ 
  error: `${player1} vs ${player2} has already been played in this pod` 
});

await sql`INSERT INTO league_games (season_id, pod_id, player1, player2, bp1, bp2, approved)
  VALUES (${pods[0].season_id}, ${pod_id}, ${player1}, ${player2}, ${bp1}, ${bp2}, ${approved})`;
return res.status(200).json({ success: true, approved });

    // ── PATCH — approve/reject, or deactivate player ──
    if (req.method === 'PATCH') {
      const { pin, gameId, playoffId, playerId, active, approved } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      if (playerId !== undefined) {
        await sql`UPDATE league_players SET active = ${active} WHERE id = ${playerId}`;
        return res.status(200).json({ success: true });
      }
      if (playoffId) {
        if (approved) await sql`UPDATE league_playoff_matches SET approved = true WHERE id = ${playoffId}`;
        else await sql`DELETE FROM league_playoff_matches WHERE id = ${playoffId}`;
      } else {
        if (approved) await sql`UPDATE league_games SET approved = true WHERE id = ${gameId}`;
        else await sql`DELETE FROM league_games WHERE id = ${gameId}`;
      }
      return res.status(200).json({ success: true });
    }

    // ── PUT — create new season ──
    if (req.method === 'PUT') {
      const { pin, name, pods } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      await sql`UPDATE league_seasons SET active = false`;
      const { rows } = await sql`INSERT INTO league_seasons (name, active) VALUES (${name}, true) RETURNING id`;
      const seasonId = rows[0].id;
      for (const pod of pods) {
        const { rows: podRows } = await sql`INSERT INTO league_pods (season_id, pod_number, name) VALUES (${seasonId}, ${pod.number}, ${pod.name}) RETURNING id`;
        for (const player of pod.players) {
          await sql`INSERT INTO league_pod_players (pod_id, player_name) VALUES (${podRows[0].id}, ${player})`;
        }
      }
      return res.status(200).json({ success: true, seasonId });
    }

  // ── DELETE — archive season ──
if (req.method === 'DELETE') {
  const { pin, label, snapshot } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

  // Fetch playoff results to include in archive
  const { rows: playoffResults } = await sql`
    SELECT * FROM league_playoff_matches 
    WHERE season_id = ${snapshot.season?.id} AND approved = true 
    ORDER BY round, match_number`;

  const fullSnapshot = {
    ...snapshot,
    playoffs: playoffResults
  };

  await sql`INSERT INTO league_archive (label, data) VALUES (${label}, ${JSON.stringify(fullSnapshot)})`;
  await sql`UPDATE league_seasons SET active = false`;
  return res.status(200).json({ success: true });
}
