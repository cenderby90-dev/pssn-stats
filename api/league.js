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
        WHERE lpo.season_id = ${season.id}
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

      // Archived seasons -- previously this only selected the bare league_seasons row
      // (no `data`/`label` columns exist, and the client expected both), so the Archive
      // tab always rendered blank. Build each archived season's real pod standings and
      // playoff results from the actual tables instead.
      const archiveSeasonsRes = await sql`SELECT * FROM league_seasons WHERE active = false ORDER BY id DESC`;
      const archive = [];
      for (const archSeason of archiveSeasonsRes.rows) {
        const archPodsRes = await sql`SELECT * FROM league_pods WHERE season_id = ${archSeason.id} ORDER BY pod_number ASC`;
        const archPlayersRes = await sql`
          SELECT lpp.pod_id, lpp.player_name
          FROM league_pod_players lpp
          JOIN league_pods lpo ON lpp.pod_id = lpo.id
          WHERE lpo.season_id = ${archSeason.id}
        `;
        const archGamesRes = await sql`SELECT * FROM league_games WHERE season_id = ${archSeason.id} AND approved = true`;
        const archPlayoffsRes = await sql`SELECT * FROM league_playoff_matches WHERE season_id = ${archSeason.id} AND approved = true ORDER BY created_at ASC`;

        const podsData = archPodsRes.rows.map(pod => {
          const podPlayerNames = archPlayersRes.rows.filter(p => p.pod_id === pod.id).map(p => p.player_name);
          const podGames = archGamesRes.rows.filter(g => g.pod_id === pod.id);
          return { pod: pod.name, standings: calcPodStandings(podPlayerNames, podGames, pod.name) };
        });

        archive.push({
          id: archSeason.id,
          name: archSeason.name,
          created_at: archSeason.created_at,
          data: { pods: podsData, playoffs: archPlayoffsRes.rows },
        });
      }

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

  // Winners and runners-up, one of each per pod (already correctly ordered by the
  // points-based pod-advancement rule, including its own tiebreak).
  const winners = [];
  const runnersUp = [];
  for (const pod of pods) {
    const podStandings = standings[pod.id] || [];
    if (podStandings[0]) winners.push({ ...podStandings[0], podFinish: 'winner' });
    if (podStandings[1]) runnersUp.push({ ...podStandings[1], podFinish: 'runner-up' });
  }

  // Bye count is dynamic, not fixed at 4: with N pods there are 2N knockout qualifiers,
  // and byes = 16 - 2N is the number that keeps the Semi Final stage (which feeds the
  // existing Finals/Grand Final shape) landing on a clean 8 participants. This is exactly
  // how "4 byes" was derived for the original 6-pod design (16 - 12 = 4); for 7 pods it
  // gives 2 (16 - 14 = 2), etc. Only valid for 6-8 pods, where this stays >= 0 and <= 2
  // per bracket half -- outside that range the whole bracket shape would need rethinking,
  // not just the bye count.
  const numPods = pods.length;
  const totalByes = Math.max(0, Math.min(winners.length, 16 - 2 * numPods));

  // Byes: top pod WINNERS ONLY, ranked by wins then battle points. Runners-up are never
  // ranked against winners for seeding -- each runner-up instead goes opposite their own
  // pod's winner on the bracket (handled client-side, where the projected QF draw lives).
  const rankedWinners = [...winners].sort((a, b) => b.wins - a.wins || b.bp - a.bp);
  const byeCutTied = totalByes > 0 && totalByes < rankedWinners.length &&
    rankedWinners[totalByes - 1].wins === rankedWinners[totalByes].wins &&
    rankedWinners[totalByes - 1].bp === rankedWinners[totalByes].bp;

  const byeWinners = rankedWinners.slice(0, totalByes);
  const qfWinners = rankedWinners.slice(totalByes); // winners without a bye, entering at QF

  return { byeWinners, qfWinners, runnersUp, byeCutTied, numPods, totalByes };
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
  const numPods = seedings?.numPods || 6;
  const totalByes = seedings?.totalByes ?? Math.max(0, 16 - 2 * numPods);
  // Per bracket half (SF1+SF2 feed F1; SF3+SF4 feed F2): each half always holds exactly
  // 4 participants at the Semi Final stage (byes + QF winners), split evenly between halves.
  const halfByes = Math.min(2, Math.floor(totalByes / 2));
  const qfPerHalf = Math.max(0, numPods - 4);
  const totalQF = qfPerHalf * 2;

  const SF_BYES = (seedings?.byeWinners || []).map(p => p ? { name: p.name } : null);
  while (SF_BYES.length < totalByes) SF_BYES.push(null);

  const getRow = (round, num) => allPlayoffRows.find(p => p.round === round && p.match_number === num) || null;

  // Attaches winner/bp1/bp2 to a bracket entry when that match has an approved result --
  // previously this was never set for any round, so completed matches never displayed as such.
  const attachResult = (entry, round, num) => {
    const g = approvedPlayoffs.find(p => p.round === round && p.match_number === num);
    if (g) {
      entry.winner = g.bp1 > g.bp2 ? g.player1 : g.bp2 > g.bp1 ? g.player2 : null;
      entry.bp1 = g.bp1; entry.bp2 = g.bp2;
    }
    return entry;
  };
  const winnerOf = (round, num) => {
    const g = approvedPlayoffs.find(p => p.round === round && p.match_number === num);
    if (!g) return null;
    return g.bp1 > g.bp2 ? g.player1 : g.bp2 > g.bp1 ? g.player2 : null;
  };

  const bracket = {};

  // Quarter Finals -- however many this pod count needs
  for (let i = 1; i <= totalQF; i++) {
    const row = getRow('QF', i);
    bracket[`QF${i}`] = attachResult(
      { p1: row ? { name: row.player1 } : null, p2: row ? { name: row.player2 } : null },
      'QF', i
    );
  }

  // Semi Finals: for each half, the first `halfByes` SF slots pair a bye with the next
  // unused QF winner in that half; any remaining SF slots pair two QF winners together.
  const buildHalfSF = (qfNumsInHalf, byesInHalf, sfKeys) => {
    let qfPointer = 0;
    sfKeys.forEach((sfKey, idx) => {
      let p1, p2;
      if (idx < byesInHalf.length) {
        const qfNum = qfNumsInHalf[qfPointer++];
        const w = qfNum ? winnerOf('QF', qfNum) : null;
        p1 = byesInHalf[idx];
        p2 = w ? { name: w } : null;
      } else {
        const qfA = qfNumsInHalf[qfPointer++], qfB = qfNumsInHalf[qfPointer++];
        const wA = qfA ? winnerOf('QF', qfA) : null, wB = qfB ? winnerOf('QF', qfB) : null;
        p1 = wA ? { name: wA } : null;
        p2 = wB ? { name: wB } : null;
      }
      const sfNum = parseInt(sfKey.replace('SF', ''), 10);
      bracket[sfKey] = attachResult({ p1, p2 }, 'SF', sfNum);
    });
  };
  const halfAQF = []; const halfBQF = [];
  for (let i = 1; i <= totalQF; i++) (i <= qfPerHalf ? halfAQF : halfBQF).push(i);
  buildHalfSF(halfAQF, SF_BYES.slice(0, halfByes), ['SF1', 'SF2']);
  buildHalfSF(halfBQF, SF_BYES.slice(halfByes, halfByes * 2), ['SF3', 'SF4']);

  // Finals and Grand Final -- unchanged shape, now with results attached too
  const sf1W = winnerOf('SF', 1), sf2W = winnerOf('SF', 2), sf3W = winnerOf('SF', 3), sf4W = winnerOf('SF', 4);
  bracket.F1 = attachResult({ p1: sf1W ? { name: sf1W } : null, p2: sf2W ? { name: sf2W } : null }, 'F', 1);
  bracket.F2 = attachResult({ p1: sf3W ? { name: sf3W } : null, p2: sf4W ? { name: sf4W } : null }, 'F', 2);

  const f1W = winnerOf('F', 1), f2W = winnerOf('F', 2);
  bracket.GF = attachResult({ p1: f1W ? { name: f1W } : null, p2: f2W ? { name: f2W } : null }, 'GF', 1);

  bracket._meta = { totalQF, halfByes, qfPerHalf, totalByes };
  return bracket;
}
