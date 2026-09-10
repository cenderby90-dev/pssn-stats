// league.js v3 - fixed bracket uses DB rows for QFs and SF byes
import { sql } from '@vercel/postgres';

const ADMIN_PIN = process.env.ADMIN_PIN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {

      const seasonRes = await sql`SELECT * FROM league_seasons WHERE active = true LIMIT 1`;
      const season = seasonRes.rows[0] || null;
      if (!season) return res.status(200).json({ season: null, pods: [], players: [], games: [], pending: [], playoffs: [], pendingPlayoffs: [], allPlayers: [], archive: [] });

      const podsRes = await sql`SELECT * FROM league_pods WHERE season_id = ${season.id} ORDER BY pod_number ASC`;
      const pods = podsRes.rows;

      const playersRes = await sql`
        SELECT lpp.id, lpp.pod_id, lpp.player_name, lpo.pod_number
        FROM league_pod_players lpp
        JOIN league_pods lpo ON lpp.pod_id = lpo.id
        ORDER BY lpo.pod_number ASC
      `;
      const players = playersRes.rows;

      const gamesRes = await sql`SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = true ORDER BY created_at ASC`;
      const games = gamesRes.rows;

      const pendingRes = await sql`SELECT * FROM league_games WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC`;
      const pending = pendingRes.rows;

      const playoffsRes = await sql`SELECT * FROM league_playoff_matches WHERE season_id = ${season.id} AND approved = true ORDER BY created_at ASC`;
      const playoffs = playoffsRes.rows;

      const pendingPlayoffsRes = await sql`SELECT * FROM league_playoff_matches WHERE season_id = ${season.id} AND approved = false ORDER BY created_at DESC`;
      const pendingPlayoffs = pendingPlayoffsRes.rows;

      const allPlayersRes = await sql`SELECT id, name, active FROM players ORDER BY name ASC`;
      const allPlayers = allPlayersRes.rows;

      const archiveRes = await sql`SELECT * FROM league_seasons WHERE active = false ORDER BY id DESC`;
      const archive = archiveRes.rows;

      const allPlayoffRows = [...playoffs, ...pendingPlayoffs];

      const seedings = calcSeedings(pods, players, games);
      const bracket = calcBracket(seedings, playoffs, allPlayoffRows);

      return res.status(200).json({
        season, pods, players, games, pending,
        playoffs, pendingPlayoffs,
        seedings, bracket,
        archive,
        allPlayers,
      });
    }

    if (req.method === 'POST') {
      const { pin, type } = req.body;
      const TEAM_PIN = process.env.TEAM_PIN || '1719';
      const memberTypes = ['playoff', 'submit_playoff'];
      const isAdminAction = !memberTypes.includes(type);
      if (isAdminAction && pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });
      if (!isAdminAction && pin !== TEAM_PIN && pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

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

      if (type === 'submit_game') {
        const { seasonId, podId, player1, player2, bp1, bp2 } = req.body;
        await sql`
          INSERT INTO league_games (season_id, pod_id, player1, player2, bp1, bp2, approved)
          VALUES (${seasonId}, ${podId}, ${player1}, ${player2}, ${bp1}, ${bp2}, false)
        `;
        return res.status(200).json({ success: true });
      }

      if (type === 'playoff' || type === 'submit_playoff') {
        const season_id = req.body.season_id || req.body.seasonId;
        const round = req.body.round;
        const match_number = req.body.match_number || req.body.matchNum;
        const player1 = req.body.player1;
        const player2 = req.body.player2;
        const bp1 = req.body.bp1;
        const bp2 = req.body.bp2;
        const winner = req.body.winner || (bp1 > bp2 ? player1 : player2);
        const isAdmin = pin === ADMIN_PIN;
        await sql`
          INSERT INTO league_playoff_matches (season_id, round, match_number, player1, player2, bp1, bp2, approved)
          VALUES (${season_id}, ${round}, ${match_number}, ${player1}, ${player2}, ${bp1}, ${bp2}, ${isAdmin})
        `;
        return res.status(200).json({ success: true, approved: isAdmin });
      }

      if (type === 'add_to_pod') {
        const { podId, playerName } = req.body;
        await sql`
          INSERT INTO league_pod_players (pod_id, player_name)
          VALUES (${podId}, ${playerName})
          ON CONFLICT DO NOTHING
        `;
        return res.status(200).json({ success: true });
      }

      if (type === 'remove_from_pod') {
        const { playerId } = req.body;
        await sql`DELETE FROM league_pod_players WHERE id = ${playerId}`;
        return res.status(200).json({ success: true });
      }

      if (type === 'new_season') {
        const { name, pods: podDefs } = req.body;
        await sql`UPDATE league_seasons SET active = false WHERE active = true`;
        const newSeason = await sql`
          INSERT INTO league_seasons (name, active) VALUES (${name}, true) RETURNING id
        `;
        const seasonId = newSeason.rows[0].id;
        for (const pod of podDefs) {
          const podRes = await sql`
            INSERT INTO league_pods (season_id, pod_number, name)
            VALUES (${seasonId}, ${pod.number}, ${pod.name}) RETURNING id
          `;
          const podId = podRes.rows[0].id;
          for (const playerName of pod.players) {
            await sql`
              INSERT INTO league_pod_players (pod_id, player_name)
              VALUES (${podId}, ${playerName})
            `;
          }
        }
        return res.status(200).json({ success: true, seasonId });
      }

      return res.status(400).json({ error: 'Unknown type' });
    }

    if (req.method === 'PATCH') {
      const { pin, gameId, playoffId, playerId, active, bp1, bp2 } = req.body;
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorised' });

      if (gameId !== undefined) {
        if (bp1 !== undefined && bp2 !== undefined) {
          await sql`UPDATE league_games SET bp1 = ${bp1}, bp2 = ${bp2}, approved = true WHERE id = ${gameId}`;
        } else {
          await sql`UPDATE league_games SET approved = ${active !== false} WHERE id = ${gameId}`;
        }
        return res.status(200).json({ success: true });
      }

      if (playoffId !== undefined) {
        await sql`UPDATE league_playoff_matches SET approved = ${active !== false} WHERE id = ${playoffId}`;
        return res.status(200).json({ success: true });
      }

      if (playerId !== undefined && active !== undefined) {
        await sql`UPDATE players SET active = ${active} WHERE id = ${playerId}`;
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'gameId, playoffId, or playerId required' });
    }

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

function calcSeedings(pods, players, games) {
  const standings = {};
  for (const pod of pods) {
    const podPlayers = players.filter(p => p.pod_id === pod.id).map(p => p.player_name);
    const podGames = games.filter(g => g.pod_id === pod.id);
    standings[pod.id] = calcPodStandings(podPlayers, podGames, pod.name);
  }

  // The 12 knockout qualifiers: top 2 from each pod (already correctly ordered by the
  // points-based pod-advancement rule, including its own tiebreak).
  const qualifiers = [];
  for (const pod of pods) {
    const podStandings = standings[pod.id] || [];
    podStandings.slice(0, 2).forEach((p, i) => {
      qualifiers.push({ ...p, podFinish: i === 0 ? 'winner' : 'runner-up' });
    });
  }

  // Byes: top 4 of all 12, by wins then battle points -- per the rules pack, not restricted
  // to pod winners. Ties at the 4th/5th cut are flagged rather than auto-resolved, since the
  // rules call for a random decision (a physical roll) at that point.
  const ranked = [...qualifiers].sort((a, b) => b.wins - a.wins || b.bp - a.bp);
  const byeCutTied = ranked.length > 4 && ranked[3].wins === ranked[4].wins && ranked[3].bp === ranked[4].bp;

  const byeWinners = ranked.slice(0, 4);
  const qfField = ranked.slice(4);

  return { byeWinners, qfField, allQualifiers: ranked, byeCutTied };
}

function calcPodStandings(playerNames, games, podName) {
  const stats = {};
  for (const name of playerNames) {
    stats[name] = { name, pts: 0, wins: 0, draws: 0, losses: 0, bp: 0, played: 0, pod: podName, tieResolvedBy: null };
  }
  for (const g of games) {
    if (!stats[g.player1]) stats[g.player1] = { name: g.player1, pts: 0, wins: 0, draws: 0, losses: 0, bp: 0, played: 0, pod: podName, tieResolvedBy: null };
    if (!stats[g.player2]) stats[g.player2] = { name: g.player2, pts: 0, wins: 0, draws: 0, losses: 0, bp: 0, played: 0, pod: podName, tieResolvedBy: null };
    const s1 = stats[g.player1];
    const s2 = stats[g.player2];
    s1.played++; s2.played++;
    s1.bp += g.bp1; s2.bp += g.bp2;
    if (g.bp1 > g.bp2) { s1.pts += 2; s1.wins++; s2.losses++; }
    else if (g.bp2 > g.bp1) { s2.pts += 2; s2.wins++; s1.losses++; }
    else { s1.pts += 1; s2.pts += 1; s1.draws++; s2.draws++; }
  }

  // Head-to-head: returns -1 if a ranks above b, 1 if b ranks above a, 0 if drawn/unplayed
  const h2h = (a, b) => {
    const g = games.find(g => (g.player1 === a && g.player2 === b) || (g.player1 === b && g.player2 === a));
    if (!g) return 0;
    const aBp = g.player1 === a ? g.bp1 : g.bp2;
    const bBp = g.player1 === a ? g.bp2 : g.bp1;
    return aBp > bBp ? -1 : aBp < bBp ? 1 : 0;
  };

  // Group by points, then apply the pod-stage tiebreak rule within each group:
  // exactly 2 tied -> head-to-head decides; 3+ tied (or a drawn head-to-head) -> most
  // battle points; still tied after that -> left tied and flagged, since the rules call
  // for a physical d3 roll at that point, not something to auto-resolve.
  const byPts = {};
  Object.values(stats).forEach(p => { (byPts[p.pts] = byPts[p.pts] || []).push(p); });

  const sorted = [];
  Object.keys(byPts).map(Number).sort((a, b) => b - a).forEach(pts => {
    const group = byPts[pts];
    if (group.length === 1) { sorted.push(group[0]); return; }

    if (group.length === 2) {
      const [a, b] = group;
      const r = h2h(a.name, b.name);
      if (r !== 0) {
        a.tieResolvedBy = 'head-to-head'; b.tieResolvedBy = 'head-to-head';
        sorted.push(...(r < 0 ? [a, b] : [b, a]));
        return;
      }
      // Drawn or unplayed head-to-head -> fall through to battle points below.
    }

    // 3+ tied on points, or a 2-way tie with a drawn head-to-head: most battle points.
    const byBp = [...group].sort((x, y) => y.bp - x.bp);
    for (let i = 0; i < byBp.length - 1; i++) {
      if (byBp[i].bp === byBp[i + 1].bp) {
        byBp[i].tieResolvedBy = 'unresolved';
        byBp[i + 1].tieResolvedBy = 'unresolved';
      } else if (!byBp[i].tieResolvedBy) {
        byBp[i].tieResolvedBy = 'battle-points';
      }
    }
    if (byBp.length && !byBp[byBp.length - 1].tieResolvedBy) byBp[byBp.length - 1].tieResolvedBy = 'battle-points';
    sorted.push(...byBp);
  });

  return sorted;
}

function calcBracket(seedings, approvedPlayoffs, allPlayoffRows) {
  // SF byes go to the top 4 seeds (pod winners, ranked by points then battle points),
  // calculated fresh from this season's actual standings via calcSeedings().
  const SF_BYES = (seedings?.byeWinners || []).slice(0, 4).map(p => p ? { name: p.name } : null);
  while (SF_BYES.length < 4) SF_BYES.push(null);

  // Helper: get approved result for a round/match
  const getResult = (round, num) => {
    const g = approvedPlayoffs.find(p => p.round === round && p.match_number === num);
    if (!g) return null;
    return g.bp1 > g.bp2 ? g.player1 : g.bp2 > g.bp1 ? g.player2 : null;
  };

  // Helper: get DB row (approved or pending)
  const getRow = (round, num) =>
    allPlayoffRows.find(p => p.round === round && p.match_number === num) || null;

  // QF matchups from DB rows
  const qf1Row = getRow('QF', 1);
  const qf2Row = getRow('QF', 2);
  const qf3Row = getRow('QF', 3);
  const qf4Row = getRow('QF', 4);

  const qf1p1 = qf1Row ? { name: qf1Row.player1 } : null;
  const qf1p2 = qf1Row ? { name: qf1Row.player2 } : null;
  const qf2p1 = qf2Row ? { name: qf2Row.player1 } : null;
  const qf2p2 = qf2Row ? { name: qf2Row.player2 } : null;
  const qf3p1 = qf3Row ? { name: qf3Row.player1 } : null;
  const qf3p2 = qf3Row ? { name: qf3Row.player2 } : null;
  const qf4p1 = qf4Row ? { name: qf4Row.player1 } : null;
  const qf4p2 = qf4Row ? { name: qf4Row.player2 } : null;

  const qf1Winner = getResult('QF', 1);
  const qf2Winner = getResult('QF', 2);
  const qf3Winner = getResult('QF', 3);
  const qf4Winner = getResult('QF', 4);

  const bracket = {
    QF1: { p1: qf1p1, p2: qf1p2 },
    QF2: { p1: qf2p1, p2: qf2p2 },
    QF3: { p1: qf3p1, p2: qf3p2 },
    QF4: { p1: qf4p1, p2: qf4p2 },
    // SF byes are fixed from the actual bracket — not auto-seeded
    SF1: { p1: SF_BYES[0], p2: qf1Winner ? { name: qf1Winner } : null },
    SF2: { p1: SF_BYES[1], p2: qf2Winner ? { name: qf2Winner } : null },
    SF3: { p1: SF_BYES[2], p2: qf3Winner ? { name: qf3Winner } : null },
    SF4: { p1: SF_BYES[3], p2: qf4Winner ? { name: qf4Winner } : null },
    F1:  { p1: null, p2: null },
    F2:  { p1: null, p2: null },
    GF:  { p1: null, p2: null },
  };

  const sf1Winner = getResult('SF', 1);
  const sf2Winner = getResult('SF', 2);
  const sf3Winner = getResult('SF', 3);
  const sf4Winner = getResult('SF', 4);
  bracket.F1.p1 = sf1Winner ? { name: sf1Winner } : null;
  bracket.F1.p2 = sf2Winner ? { name: sf2Winner } : null;
  bracket.F2.p1 = sf3Winner ? { name: sf3Winner } : null;
  bracket.F2.p2 = sf4Winner ? { name: sf4Winner } : null;

  const f1Winner = getResult('F', 1);
  const f2Winner = getResult('F', 2);
  bracket.GF.p1 = f1Winner ? { name: f1Winner } : null;
  bracket.GF.p2 = f2Winner ? { name: f2Winner } : null;

  return bracket;
}
