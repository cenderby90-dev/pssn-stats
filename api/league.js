import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET — fetch full league state ──
    if (req.method === 'GET') {

      // Active season
      const seasonRes = await sql`SELECT * FROM league_seasons WHERE active = true LIMIT 1`;
      const season = seasonRes.rows[0] || null;
      if (!season) return res.status(200).json({ season: null, pods: [], players: [], games: [], pending: [], playoffs: [], pendingPlayoffs: [], allPlayers: [], archive: [] });

      // Pods
      const podsRes = await sql`SELECT * FROM league_pods WHERE season_id = ${season.id} ORDER BY pod_number ASC`;
      const pods = podsRes.rows;

      // Pod assignments (player_name as text — unchanged for Season 1 history)
      const playersRes = await sql`SELECT * FROM league_players ORDER BY pod_number ASC`;
      const players = playersRes.rows;

      // All approved games
      const gamesRes = await sql`SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = true ORDER BY created_at ASC`;
      const games = gamesRes.rows;

      // Pending games (submitted, not yet approved)
      const pendingRes = await sql`SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC`;
      const pending = pendingRes.rows;

      // Playoffs
      const playoffsRes = await sql`SELECT * FROM league_playoffs WHERE season_id = ${season.id} AND approved = true ORDER BY created_at ASC`;
      const playoffs = playoffsRes.rows;

      const pendingPlayoffsRes = await sql`SELECT * FROM league_playoffs WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC`;
      const pendingPlayoffs = pendingPlayoffsRes.rows;

      // ── allPlayers: sourced from MASTER players table ──
      // This is the single source of truth — shared with /api/players
      // Replaces the old league-specific players table for new seasons
      const allPlayersRes = await sql`SELECT id, name, active FROM players ORDER BY name ASC`;
      const allPlayers = allPlayersRes.rows;

      // Archive (past seasons)
      const archiveRes = await sql`SELECT * FROM league_seasons WHERE active = false ORDER BY id DESC`;
      const archive = archiveRes.rows;

      // Seedings / bracket (calculated server-side for consistency)
      const seedings = calcSeedings(pods, players, games);
      const bracket = calcBracket(seedings, playoffs);

      return res.status(200).json({
        season, pods, players, games, pending,
        playoffs, pendingPlayoffs,
        seedings, bracket,
        archive,
        allPlayers,  // now from master players table
      });
    }

    // ── POST — create game, add player to pod, new season ──
    if (req.method === 'POST') {
      const { pin, type } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      // Add player — now writes to MASTER players table
      if (type === 'add_player') {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        await sql`
          INSERT INTO players (name, factions, active)
          VALUES (${name}, ARRAY[]::text[], true)
          ON CONFLICT (name) DO UPDATE SET active = true
        `;
        return res.status(200).json({ success: true });
      }

      // Submit a game result
      if (type === 'submit_game') {
        const { seasonId, podId, player1, player2, bp1, bp2 } = req.body;
        await sql`
          INSERT INTO league_games (season_id, pod_id, player1, player2, bp1, bp2, approved)
          VALUES (${seasonId}, ${podId}, ${player1}, ${player2}, ${bp1}, ${bp2}, false)
        `;
        return res.status(200).json({ success: true });
      }

      // Submit a playoff result
      if (type === 'submit_playoff') {
        const { seasonId, round, matchNum, player1, player2, bp1, bp2 } = req.body;
        await sql`
          INSERT INTO league_playoffs (season_id, round, match_num, player1, player2, bp1, bp2, approved)
          VALUES (${seasonId}, ${round}, ${matchNum}, ${player1}, ${player2}, ${bp1}, ${bp2}, false)
        `;
        return res.status(200).json({ success: true });
      }

      // Add player to pod assignment
      if (type === 'add_to_pod') {
        const { podId, playerName, podNumber } = req.body;
        await sql`
          INSERT INTO league_players (pod_id, player_name, pod_number)
          VALUES (${podId}, ${playerName}, ${podNumber})
          ON CONFLICT DO NOTHING
        `;
        return res.status(200).json({ success: true });
      }

      // Remove player from pod
      if (type === 'remove_from_pod') {
        const { playerId } = req.body;
        await sql`DELETE FROM league_players WHERE id = ${playerId}`;
        return res.status(200).json({ success: true });
      }

      // Create new season with pods and player assignments
      if (type === 'new_season') {
        const { name, pods: podDefs } = req.body;
        // Deactivate current season
        await sql`UPDATE league_seasons SET active = false WHERE active = true`;
        // Create new season
        const newSeason = await sql`
          INSERT INTO league_seasons (name, active) VALUES (${name}, true) RETURNING id
        `;
        const seasonId = newSeason.rows[0].id;
        // Create pods and assign players
        for (const pod of podDefs) {
          const podRes = await sql`
            INSERT INTO league_pods (season_id, pod_number, name)
            VALUES (${seasonId}, ${pod.number}, ${pod.name}) RETURNING id
          `;
          const podId = podRes.rows[0].id;
          for (const playerName of pod.players) {
            await sql`
              INSERT INTO league_players (pod_id, player_name, pod_number)
              VALUES (${podId}, ${playerName}, ${pod.number})
            `;
          }
        }
        return res.status(200).json({ success: true, seasonId });
      }

      return res.status(400).json({ error: 'Unknown type' });
    }

    // ── PATCH — approve game/playoff, toggle player active, update game ──
    if (req.method === 'PATCH') {
      const { pin, gameId, playoffId, playerId, active, bp1, bp2 } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      // Approve/reject a league game
      if (gameId !== undefined) {
        if (bp1 !== undefined && bp2 !== undefined) {
          // Update scores and approve
          await sql`UPDATE league_games SET bp1 = ${bp1}, bp2 = ${bp2}, approved = true WHERE id = ${gameId}`;
        } else {
          await sql`UPDATE league_games SET approved = ${active !== false} WHERE id = ${gameId}`;
        }
        return res.status(200).json({ success: true });
      }

      // Approve/reject a playoff game
      if (playoffId !== undefined) {
        await sql`UPDATE league_playoffs SET approved = ${active !== false} WHERE id = ${playoffId}`;
        return res.status(200).json({ success: true });
      }

      // Toggle player active — now targets MASTER players table
      if (playerId !== undefined && active !== undefined) {
        await sql`UPDATE players SET active = ${active} WHERE id = ${playerId}`;
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'gameId, playoffId, or playerId required' });
    }

    // ── DELETE — remove a game ──
    if (req.method === 'DELETE') {
      const { pin, gameId } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      await sql`DELETE FROM league_games WHERE id = ${gameId}`;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('League API error:', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}

// ── Seedings calculation ──
function calcSeedings(pods, players, games) {
  const standings = {};
  for (const pod of pods) {
    const podPlayers = players.filter(p => p.pod_id === pod.id).map(p => p.player_name);
    const podGames = games.filter(g => g.pod_id === pod.id);
    const podStandings = calcPodStandings(podPlayers, podGames, pod.name);
    standings[pod.id] = podStandings;
  }

  // Seeding logic: top player per pod gets bye, runners-up go to QF
  const allStandings = Object.values(standings).flat();
  const byeWinners = [];
  const runnersUp = [];
  const qfWinners = [];

  for (const pod of pods) {
    const podStandings = standings[pod.id] || [];
    if (podStandings.length === 0) continue;
    const sorted = [...podStandings].sort((a, b) => b.pts - a.pts || b.bp - a.bp);
    if (sorted[0]) byeWinners.push({ ...sorted[0], pod: pod.name });
    if (sorted[1]) runnersUp.push({ ...sorted[1], pod: pod.name });
  }

  // Sort bye winners and runners up
  byeWinners.sort((a, b) => b.pts - a.pts || b.bp - a.bp);
  runnersUp.sort((a, b) => b.pts - a.pts || b.bp - a.bp);

  // Top 2 bye winners get SF byes; next 2 get QF byes
  const sfByes = byeWinners.slice(0, 4);
  const qfByes = byeWinners.slice(4);
  const qfField = [...qfByes, ...runnersUp].sort((a, b) => b.pts - a.pts || b.bp - a.bp);
  // QF winners are the top 2 of that field (would be seeded into bracket)
  const qfWinnersSeeded = qfField.slice(0, 2);

  return { byeWinners: sfByes, qfWinners: qfWinnersSeeded, runnersUp: runnersUp.slice(0, 6) };
}

function calcPodStandings(playerNames, games, podName) {
  const stats = {};
  for (const name of playerNames) {
    stats[name] = { name, pts: 0, bp: 0, played: 0, pod: podName };
  }
  for (const g of games) {
    if (!stats[g.player1]) stats[g.player1] = { name: g.player1, pts: 0, bp: 0, played: 0, pod: podName };
    if (!stats[g.player2]) stats[g.player2] = { name: g.player2, pts: 0, bp: 0, played: 0, pod: podName };
    const s1 = stats[g.player1];
    const s2 = stats[g.player2];
    s1.played++; s2.played++;
    s1.bp += g.bp1; s2.bp += g.bp2;
    if (g.bp1 > g.bp2) { s1.pts += 2; }
    else if (g.bp2 > g.bp1) { s2.pts += 2; }
    else { s1.pts += 1; s2.pts += 1; }
  }
  return Object.values(stats).sort((a, b) => b.pts - a.pts || b.bp - a.bp);
}

function calcBracket(seedings, playoffs) {
  const { byeWinners, qfWinners, runnersUp } = seedings;
  const getResult = (round, num) => {
    const g = playoffs.find(p => p.round === round && p.match_num === num);
    if (!g) return null;
    return g.bp1 > g.bp2 ? g.player1 : g.player1 === g.player2 ? null : g.player2;
  };

  const qf1Winner = getResult('QF', 1);
  const qf2Winner = getResult('QF', 2);
  const qf3Winner = getResult('QF', 3);
  const qf4Winner = getResult('QF', 4);

  const bracket = {
    QF1: { p1: runnersUp[0] || null, p2: runnersUp[5] || null },
    QF2: { p1: runnersUp[1] || null, p2: runnersUp[4] || null },
    QF3: { p1: runnersUp[2] || null, p2: runnersUp[3] || null },
    QF4: { p1: qfWinners[0] || null, p2: qfWinners[1] || null },
    SF1: { p1: byeWinners[0] || null, p2: qf1Winner ? { name: qf1Winner } : null },
    SF2: { p1: byeWinners[1] || null, p2: qf2Winner ? { name: qf2Winner } : null },
    SF3: { p1: byeWinners[2] || null, p2: qf3Winner ? { name: qf3Winner } : null },
    SF4: { p1: byeWinners[3] || null, p2: qf4Winner ? { name: qf4Winner } : null },
    F1:  { p1: null, p2: null },
    F2:  { p1: null, p2: null },
    GF:  { p1: null, p2: null },
  };

  // Propagate SF results
  const sf1Winner = getResult('SF', 1);
  const sf2Winner = getResult('SF', 2);
  const sf3Winner = getResult('SF', 3);
  const sf4Winner = getResult('SF', 4);
  bracket.F1.p1 = sf1Winner ? { name: sf1Winner } : null;
  bracket.F1.p2 = sf2Winner ? { name: sf2Winner } : null;
  bracket.F2.p1 = sf3Winner ? { name: sf3Winner } : null;
  bracket.F2.p2 = sf4Winner ? { name: sf4Winner } : null;

  // Propagate final results
  const f1Winner = getResult('F', 1);
  const f2Winner = getResult('F', 2);
  bracket.GF.p1 = f1Winner ? { name: f1Winner } : null;
  bracket.GF.p2 = f2Winner ? { name: f2Winner } : null;

  return bracket;
}
